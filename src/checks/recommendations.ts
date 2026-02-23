import type {
  CognitiveCheckResult,
  Recommendation,
  RecommendationsCheckConfig,
  LlmClient,
  LeukoStatus,
  LeukoHistory,
  PluginLogger,
  Severity,
} from "../types.js";

const CHECK_NAME = "cognitive:recommendations";

const SYSTEM_PROMPT = `You are a system health advisor. Based on the current check results and system history, generate housekeeping recommendations.
Respond ONLY with valid JSON matching this schema:
{
  "severity": "ok" | "warn" | "critical",
  "detail": "N recommendations generated",
  "recommendations": [
    {
      "type": "archive_thread" | "cleanup_goals" | "adjust_config" | "investigate" | "maintenance",
      "target": "what to act on",
      "reason": "why this is recommended",
      "priority": "low" | "medium" | "high"
    }
  ]
}

Rules:
- Patterns in heal history (same check failing repeatedly → systemic issue)
- Stale threads/goals → archive candidates  
- Cron jobs with repeated warnings → config change suggestion
- L1 checks stuck on warn for > 48h → needs human investigation
- severity "ok" when there are only low-priority suggestions
- severity "warn" when there are medium/high priority recommendations
- Maximum recommendations: as specified`;

interface LlmRecommendationsResponse {
  severity?: string;
  detail?: string;
  recommendations?: Array<{
    type?: string;
    target?: string;
    reason?: string;
    priority?: string;
  }>;
}

function parseLlmResponse(raw: string): LlmRecommendationsResponse | null {
  try {
    return JSON.parse(raw) as LlmRecommendationsResponse;
  } catch {
    return null;
  }
}

function parseSeverityString(v: unknown): Severity {
  if (v === "ok" || v === "warn" || v === "critical") return v;
  return "ok";
}

/**
 * Build a summary of current run findings for the LLM.
 */
function buildFindingsSummary(
  currentResults: CognitiveCheckResult[],
  status: LeukoStatus | null,
  history: LeukoHistory | null,
): string {
  const sections: string[] = [];

  // Current cognitive check results
  sections.push("=== Current Cognitive Check Results ===");
  for (const result of currentResults) {
    sections.push(`${result.check_name}: ${result.severity} — ${result.detail}`);
    if (result.findings && result.findings.length > 0) {
      for (const f of result.findings.slice(0, 5)) {
        sections.push(`  - ${f.issue}: ${f.detail}`);
      }
    }
    if (result.correlations && result.correlations.length > 0) {
      for (const c of result.correlations.slice(0, 5)) {
        sections.push(`  - ${c.diagnosis}: ${c.input}=${c.input_value} → ${c.output}=${c.output_value}`);
      }
    }
    if (result.anomalies && result.anomalies.length > 0) {
      for (const a of result.anomalies.slice(0, 5)) {
        sections.push(`  - ${a.metric}: ${a.deviation}`);
      }
    }
  }

  // Daemon check issues
  if (status) {
    const issues = status.daemon_checks.filter((c) => c.severity !== "ok");
    if (issues.length > 0) {
      sections.push("\n=== Current Daemon Issues ===");
      for (const issue of issues) {
        sections.push(`${issue.check_name}: ${issue.severity} — ${issue.detail}`);
      }
    }
  }

  return sections.join("\n").substring(0, 4000);
}

export async function runRecommendationsCheck(
  config: RecommendationsCheckConfig,
  llm: LlmClient,
  currentResults: CognitiveCheckResult[],
  status: LeukoStatus | null,
  history: LeukoHistory | null,
  logger: PluginLogger,
): Promise<CognitiveCheckResult> {
  const startMs = Date.now();
  const timestamp = new Date().toISOString();

  const summary = buildFindingsSummary(currentResults, status, history);

  const userPrompt = [
    `Current date: ${new Date().toISOString().split("T")[0]}`,
    `Maximum recommendations: ${config.maxRecommendations}`,
    "",
    summary,
  ].join("\n");

  const llmResult = await llm.generate(SYSTEM_PROMPT, userPrompt, 30000);

  if (llmResult.content === null) {
    return {
      check_name: CHECK_NAME,
      severity: "ok",
      detail: llmResult.error
        ? `LLM unavailable (${llmResult.error}) — no recommendations`
        : "LLM timeout — no recommendations",
      recommendations: [],
      timestamp,
      model_used: llmResult.model,
      tokens_used: 0,
      duration_ms: Date.now() - startMs,
    };
  }

  const parsed = parseLlmResponse(llmResult.content);
  if (!parsed) {
    return {
      check_name: CHECK_NAME,
      severity: "ok",
      detail: "LLM response parsing failed — no recommendations",
      recommendations: [],
      timestamp,
      model_used: llmResult.model,
      tokens_used: llmResult.tokens,
      duration_ms: Date.now() - startMs,
    };
  }

  const recommendations: Recommendation[] = Array.isArray(parsed.recommendations)
    ? parsed.recommendations
        .slice(0, config.maxRecommendations)
        .map((r) => ({
          type: typeof r.type === "string" ? r.type : "maintenance",
          target: typeof r.target === "string" ? r.target : "unknown",
          reason: typeof r.reason === "string" ? r.reason : "",
          priority: (r.priority === "low" || r.priority === "medium" || r.priority === "high")
            ? r.priority
            : "low" as const,
        }))
    : [];

  return {
    check_name: CHECK_NAME,
    severity: parseSeverityString(parsed.severity),
    detail: typeof parsed.detail === "string"
      ? parsed.detail
      : `${recommendations.length} recommendations generated`,
    recommendations,
    timestamp,
    model_used: llmResult.model,
    tokens_used: llmResult.tokens,
    duration_ms: Date.now() - startMs,
  };
}
