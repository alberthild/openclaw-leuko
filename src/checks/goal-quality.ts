import type {
  CognitiveCheckResult,
  CheckFinding,
  GoalQualityCheckConfig,
  LlmClient,
  PendingGoal,
  PluginLogger,
  Severity,
} from "../types.js";
import { readJsonInput } from "../status-reader.js";

const CHECK_NAME = "cognitive:goal_quality";

const SYSTEM_PROMPT = `You are a system health evaluator. Analyze the pending goals and assess their quality.
Respond ONLY with valid JSON matching this schema:
{
  "severity": "ok" | "warn" | "critical",
  "detail": "single line summary",
  "findings": [
    {
      "item_id": "goal id",
      "issue": "vague_title" | "duplicate" | "expired" | "no_action" | "noise",
      "detail": "explanation",
      "recommendation": "what to do"
    }
  ]
}

Evaluation rules:
- Is each goal specific enough to act on? Vague goals like "Fix recurring general failures" are WARN
- Are there near-duplicates? Multiple similar "Fix recurring X failures" → WARN: consolidate
- Does proposed_action contain a real plan or just a placeholder?
- Are expired goals present? (expires < current date → WARN)
- If ALL goals are specific and actionable → severity "ok"
- If ≥1 vague/duplicate/expired goal → severity "warn"
- If ≥50% of goals are noise → severity "critical"`;

interface GoalsData {
  goals?: PendingGoal[];
  pending_goals?: PendingGoal[];
}

function isGoalsArray(v: unknown): v is PendingGoal[] {
  return Array.isArray(v);
}

function extractGoals(data: unknown): PendingGoal[] {
  if (Array.isArray(data)) return data as PendingGoal[];
  if (typeof data === "object" && data !== null) {
    const obj = data as GoalsData;
    if (isGoalsArray(obj.goals)) return obj.goals;
    if (isGoalsArray(obj.pending_goals)) return obj.pending_goals;
  }
  return [];
}

/**
 * Pre-filter: flag obvious issues without LLM (adopted from Sitrep goals collector).
 */
function preFilterGoals(goals: PendingGoal[]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const now = Date.now();

  for (const goal of goals) {
    // Expired goals
    if (goal.expires) {
      const expiryMs = new Date(goal.expires).getTime();
      if (!isNaN(expiryMs) && expiryMs < now) {
        findings.push({
          item_id: goal.id,
          issue: "expired",
          detail: `Goal "${goal.title}" expired on ${goal.expires}`,
          recommendation: "Remove or renew this goal",
        });
      }
    }

    // Goals proposed > 48h ago and not yet approved
    if (goal.proposed_at && goal.status === "proposed") {
      const proposedMs = new Date(goal.proposed_at).getTime();
      if (!isNaN(proposedMs) && now - proposedMs > 48 * 60 * 60 * 1000) {
        findings.push({
          item_id: goal.id,
          issue: "stale_proposal",
          detail: `Goal "${goal.title}" proposed ${Math.round((now - proposedMs) / 3600000)}h ago, still not approved`,
          recommendation: "Review and approve or reject this goal",
        });
      }
    }
  }

  return findings;
}

interface LlmGoalResponse {
  severity?: string;
  detail?: string;
  findings?: Array<{
    item_id?: string;
    issue?: string;
    detail?: string;
    recommendation?: string;
  }>;
}

function parseLlmResponse(raw: string): LlmGoalResponse | null {
  try {
    return JSON.parse(raw) as LlmGoalResponse;
  } catch {
    return null;
  }
}

export async function runGoalQualityCheck(
  config: GoalQualityCheckConfig,
  llm: LlmClient,
  logger: PluginLogger,
): Promise<CognitiveCheckResult> {
  const startMs = Date.now();
  const timestamp = new Date().toISOString();

  // Read goals file
  const rawData = readJsonInput<unknown>(config.inputPath, logger);
  if (rawData === null) {
    return {
      check_name: CHECK_NAME,
      severity: "ok",
      detail: "Goals file not found — check skipped",
      timestamp,
      duration_ms: Date.now() - startMs,
    };
  }

  const goals = extractGoals(rawData);
  if (goals.length === 0) {
    return {
      check_name: CHECK_NAME,
      severity: "ok",
      detail: "No pending goals found",
      timestamp,
      duration_ms: Date.now() - startMs,
    };
  }

  // Pre-filter
  const preFindings = preFilterGoals(goals);

  // LLM analysis
  const goalsText = JSON.stringify(goals, null, 2).substring(0, 4000);
  const userPrompt = `Current date: ${new Date().toISOString().split("T")[0]}\n\nPending goals (${goals.length} total):\n${goalsText}`;

  const llmResult = await llm.generate(SYSTEM_PROMPT, userPrompt, 30000);

  if (llmResult.content === null) {
    // Fail-open: use pre-filter results only
    const severity: Severity = preFindings.length > 0 ? "warn" : "ok";
    return {
      check_name: CHECK_NAME,
      severity,
      detail: llmResult.error
        ? `LLM unavailable (${llmResult.error}) — ${preFindings.length} pre-filter findings`
        : `LLM timeout — ${preFindings.length} pre-filter findings`,
      findings: preFindings,
      timestamp,
      model_used: llmResult.model,
      tokens_used: 0,
      duration_ms: Date.now() - startMs,
    };
  }

  const parsed = parseLlmResponse(llmResult.content);
  if (!parsed) {
    const severity: Severity = preFindings.length > 0 ? "warn" : "ok";
    return {
      check_name: CHECK_NAME,
      severity,
      detail: `LLM response parsing failed — ${preFindings.length} pre-filter findings`,
      findings: preFindings,
      timestamp,
      model_used: llmResult.model,
      tokens_used: llmResult.tokens,
      duration_ms: Date.now() - startMs,
    };
  }

  // Merge pre-filter + LLM findings
  const llmFindings: CheckFinding[] = Array.isArray(parsed.findings)
    ? parsed.findings.map((f) => ({
        item_id: typeof f.item_id === "string" ? f.item_id : undefined,
        issue: typeof f.issue === "string" ? f.issue : "unknown",
        detail: typeof f.detail === "string" ? f.detail : "",
        recommendation: typeof f.recommendation === "string" ? f.recommendation : undefined,
      }))
    : [];

  // Deduplicate by item_id
  const seenIds = new Set(preFindings.map((f) => f.item_id).filter(Boolean));
  const uniqueLlmFindings = llmFindings.filter((f) => !f.item_id || !seenIds.has(f.item_id));
  const allFindings = [...preFindings, ...uniqueLlmFindings];

  const llmSeverity = parseSeverityString(parsed.severity);
  const preSeverity: Severity = preFindings.length > 0 ? "warn" : "ok";
  const severity = worstSeverity(llmSeverity, preSeverity);

  return {
    check_name: CHECK_NAME,
    severity,
    detail: typeof parsed.detail === "string" ? parsed.detail : `${allFindings.length} findings`,
    findings: allFindings,
    timestamp,
    model_used: llmResult.model,
    tokens_used: llmResult.tokens,
    duration_ms: Date.now() - startMs,
  };
}

function parseSeverityString(v: unknown): Severity {
  if (v === "ok" || v === "warn" || v === "critical") return v;
  return "ok";
}

function worstSeverity(a: Severity, b: Severity): Severity {
  const order: Record<Severity, number> = { ok: 0, warn: 1, critical: 2 };
  return order[a] >= order[b] ? a : b;
}
