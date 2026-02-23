import type {
  CognitiveCheckResult,
  CheckFinding,
  GoalQualityCheckConfig,
  LlmClient,
  PendingGoal,
  PluginLogger,
} from "../types.js";
import { readJsonInput } from "../status-reader.js";
import { parseSeverityString, worstSeverity } from "../check-utils.js";
import { runLlmCheck } from "../check-runner.js";
import type { MergeOpts } from "../check-runner.js";

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

function extractGoals(data: unknown): PendingGoal[] {
  if (Array.isArray(data)) return data as PendingGoal[];
  if (typeof data === "object" && data !== null) {
    const obj = data as GoalsData;
    if (Array.isArray(obj.goals)) return obj.goals;
    if (Array.isArray(obj.pending_goals)) return obj.pending_goals;
  }
  return [];
}

function preFilterGoals(goals: PendingGoal[]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const now = Date.now();
  for (const goal of goals) {
    checkExpired(goal, now, findings);
    checkStaleProposal(goal, now, findings);
  }
  return findings;
}

function checkExpired(goal: PendingGoal, now: number, out: CheckFinding[]): void {
  if (!goal.expires) return;
  const expiryMs = new Date(goal.expires).getTime();
  if (!isNaN(expiryMs) && expiryMs < now) {
    out.push({
      item_id: goal.id,
      issue: "expired",
      detail: `Goal "${goal.title}" expired on ${goal.expires}`,
      recommendation: "Remove or renew this goal",
    });
  }
}

function checkStaleProposal(goal: PendingGoal, now: number, out: CheckFinding[]): void {
  if (!goal.proposed_at || goal.status !== "proposed") return;
  const proposedMs = new Date(goal.proposed_at).getTime();
  if (!isNaN(proposedMs) && now - proposedMs > 48 * 60 * 60 * 1000) {
    out.push({
      item_id: goal.id,
      issue: "stale_proposal",
      detail: `Goal "${goal.title}" proposed ${Math.round((now - proposedMs) / 3600000)}h ago, still not approved`,
      recommendation: "Review and approve or reject this goal",
    });
  }
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

function mergeLlmFindings(preFindings: CheckFinding[], parsed: LlmGoalResponse): CheckFinding[] {
  const llmFindings: CheckFinding[] = Array.isArray(parsed.findings)
    ? parsed.findings.map((f) => ({
        item_id: typeof f.item_id === "string" ? f.item_id : undefined,
        issue: typeof f.issue === "string" ? f.issue : "unknown",
        detail: typeof f.detail === "string" ? f.detail : "",
        recommendation: typeof f.recommendation === "string" ? f.recommendation : undefined,
      }))
    : [];
  const seenIds = new Set(preFindings.map((f) => f.item_id).filter(Boolean));
  const unique = llmFindings.filter((f) => !f.item_id || !seenIds.has(f.item_id));
  return [...preFindings, ...unique];
}

export async function runGoalQualityCheck(
  config: GoalQualityCheckConfig,
  llm: LlmClient,
  logger: PluginLogger,
): Promise<CognitiveCheckResult> {
  return runLlmCheck<PendingGoal[], LlmGoalResponse>({
    name: CHECK_NAME,
    systemPrompt: SYSTEM_PROMPT,
    llm,
    logger,

    readInput(timestamp, startMs) {
      const rawData = readJsonInput<unknown>(config.inputPath, logger);
      if (rawData === null) {
        return { ok: false, skip: { check_name: CHECK_NAME, severity: "ok", detail: "Goals file not found — check skipped", timestamp, duration_ms: Date.now() - startMs } };
      }
      const goals = extractGoals(rawData);
      if (goals.length === 0) {
        return { ok: false, skip: { check_name: CHECK_NAME, severity: "ok", detail: "No pending goals found", timestamp, duration_ms: Date.now() - startMs } };
      }
      return { ok: true, input: goals };
    },

    preFilter(goals) {
      const findings = preFilterGoals(goals);
      return { severity: findings.length > 0 ? "warn" : "ok", findingCount: findings.length, data: { findings } };
    },

    buildPrompt(goals) {
      const goalsText = JSON.stringify(goals, null, 2).substring(0, 4000);
      return `Current date: ${new Date().toISOString().split("T")[0]}\n\nPending goals (${goals.length} total):\n${goalsText}`;
    },

    buildFailOpen({ pre, message, llmModel, llmTokens, timestamp, startMs }) {
      const preFindings = pre.data["findings"] as CheckFinding[];
      return {
        check_name: CHECK_NAME,
        severity: pre.severity,
        detail: `${message} — ${pre.findingCount} pre-filter findings`,
        findings: preFindings,
        timestamp,
        model_used: llmModel,
        tokens_used: llmTokens,
        duration_ms: Date.now() - startMs,
      };
    },

    mergeResults(opts: MergeOpts<LlmGoalResponse>) {
      const preFindings = opts.pre.data["findings"] as CheckFinding[];
      const allFindings = mergeLlmFindings(preFindings, opts.parsed);
      const severity = worstSeverity(parseSeverityString(opts.parsed.severity), opts.pre.severity);
      return {
        check_name: CHECK_NAME,
        severity,
        detail: typeof opts.parsed.detail === "string" ? opts.parsed.detail : `${allFindings.length} findings`,
        findings: allFindings,
        timestamp: opts.timestamp,
        model_used: opts.llmModel,
        tokens_used: opts.llmTokens,
        duration_ms: Date.now() - opts.startMs,
      };
    },
  });
}
