import type {
  CognitiveCheckResult,
  Recommendation,
  RecommendationsCheckConfig,
  LlmClient,
  LeukoStatus,
  LeukoHistory,
  PluginLogger,
} from "../types.js";
import { parseSeverityString } from "../check-utils.js";
import { runLlmCheck } from "../check-runner.js";
import type { MergeOpts } from "../check-runner.js";

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

function buildFindingsSummary(
  currentResults: CognitiveCheckResult[],
  status: LeukoStatus | null,
): string {
  const sections: string[] = ["=== Current Cognitive Check Results ==="];

  for (const result of currentResults) {
    sections.push(`${result.check_name}: ${result.severity} — ${result.detail}`);
    appendFindings(result, sections);
    appendCorrelations(result, sections);
    appendAnomalies(result, sections);
  }

  appendDaemonIssues(status, sections);
  return sections.join("\n").substring(0, 4000);
}

function appendFindings(result: CognitiveCheckResult, out: string[]): void {
  if (!result.findings || result.findings.length === 0) return;
  for (const f of result.findings.slice(0, 5)) {
    out.push(`  - ${f.issue}: ${f.detail}`);
  }
}

function appendCorrelations(result: CognitiveCheckResult, out: string[]): void {
  if (!result.correlations || result.correlations.length === 0) return;
  for (const c of result.correlations.slice(0, 5)) {
    out.push(`  - ${c.diagnosis}: ${c.input}=${c.input_value} → ${c.output}=${c.output_value}`);
  }
}

function appendAnomalies(result: CognitiveCheckResult, out: string[]): void {
  if (!result.anomalies || result.anomalies.length === 0) return;
  for (const a of result.anomalies.slice(0, 5)) {
    out.push(`  - ${a.metric}: ${a.deviation}`);
  }
}

function appendDaemonIssues(status: LeukoStatus | null, out: string[]): void {
  if (!status) return;
  const issues = status.daemon_checks.filter((c) => c.severity !== "ok");
  if (issues.length === 0) return;
  out.push("\n=== Current Daemon Issues ===");
  for (const issue of issues) {
    out.push(`${issue.check_name}: ${issue.severity} — ${issue.detail}`);
  }
}

function parseRecommendations(
  parsed: LlmRecommendationsResponse,
  max: number,
): Recommendation[] {
  if (!Array.isArray(parsed.recommendations)) return [];
  return parsed.recommendations.slice(0, max).map((r) => ({
    type: typeof r.type === "string" ? r.type : "maintenance",
    target: typeof r.target === "string" ? r.target : "unknown",
    reason: typeof r.reason === "string" ? r.reason : "",
    priority: (r.priority === "low" || r.priority === "medium" || r.priority === "high")
      ? r.priority
      : "low" as const,
  }));
}

interface RecsInput { summary: string; maxRecs: number }

export async function runRecommendationsCheck(
  config: RecommendationsCheckConfig,
  llm: LlmClient,
  currentResults: CognitiveCheckResult[],
  status: LeukoStatus | null,
  _history: LeukoHistory | null,
  logger: PluginLogger,
): Promise<CognitiveCheckResult> {
  return runLlmCheck<RecsInput, LlmRecommendationsResponse>({
    name: CHECK_NAME,
    systemPrompt: SYSTEM_PROMPT,
    llm,
    logger,

    readInput() {
      const summary = buildFindingsSummary(currentResults, status);
      return { ok: true, input: { summary, maxRecs: config.maxRecommendations } };
    },

    preFilter() {
      return { severity: "ok", findingCount: 0, data: {} };
    },

    buildPrompt(input) {
      return [
        `Current date: ${new Date().toISOString().split("T")[0]}`,
        `Maximum recommendations: ${input.maxRecs}`,
        "",
        input.summary,
      ].join("\n");
    },

    buildFailOpen({ message, llmModel, llmTokens, timestamp, startMs }) {
      return {
        check_name: CHECK_NAME,
        severity: "ok",
        detail: `${message} — no recommendations`,
        recommendations: [],
        timestamp,
        model_used: llmModel,
        tokens_used: llmTokens,
        duration_ms: Date.now() - startMs,
      };
    },

    mergeResults(opts: MergeOpts<LlmRecommendationsResponse>) {
      const recs = parseRecommendations(opts.parsed, config.maxRecommendations);
      return {
        check_name: CHECK_NAME,
        severity: parseSeverityString(opts.parsed.severity),
        detail: typeof opts.parsed.detail === "string"
          ? opts.parsed.detail
          : `${recs.length} recommendations generated`,
        recommendations: recs,
        timestamp: opts.timestamp,
        model_used: opts.llmModel,
        tokens_used: opts.llmTokens,
        duration_ms: Date.now() - opts.startMs,
      };
    },
  });
}
