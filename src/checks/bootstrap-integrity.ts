import type {
  CognitiveCheckResult,
  CheckFinding,
  BootstrapIntegrityCheckConfig,
  LlmClient,
  LeukoStatus,
  PluginLogger,
} from "../types.js";
import { readTextInput } from "../status-reader.js";
import { parseSeverityString } from "../check-utils.js";
import { runLlmCheck } from "../check-runner.js";
import type { MergeOpts } from "../check-runner.js";

const CHECK_NAME = "cognitive:bootstrap_integrity";

const SYSTEM_PROMPT = `You are a system health evaluator. Verify that the BOOTSTRAP.md file is factually current and complete.
Respond ONLY with valid JSON matching this schema:
{
  "severity": "ok" | "warn" | "critical",
  "detail": "single line summary",
  "findings": [
    {
      "issue": "stale_reference" | "missing_subsystem" | "factual_error" | "outdated_state",
      "line": "the problematic text from BOOTSTRAP.md",
      "detail": "explanation of what's wrong",
      "recommendation": "what to fix"
    }
  ]
}

Evaluation rules:
- Does it reference services/crons that no longer exist?
- Are file paths correct?
- Is "current state" aligned with actual system status?
- Are key subsystems mentioned (NATS, Membrane, Cortex, Leuko, Governance)?
- Content aligns with system state → "ok"
- Minor omissions or stale references → "warn"
- Major factual errors or missing critical subsystems → "critical"`;

interface LlmBootstrapResponse {
  severity?: string;
  detail?: string;
  findings?: Array<{
    issue?: string;
    line?: string;
    detail?: string;
    recommendation?: string;
  }>;
}

function buildSystemContext(status: LeukoStatus | null): string {
  if (!status) return "System status: unavailable";
  const daemonSummary = status.daemon_checks
    .filter((c) => c.severity !== "ok")
    .map((c) => `${c.check_name}: ${c.severity} — ${c.detail}`)
    .join("\n");
  return [
    `Last check: ${status.last_check}`,
    `Overall severity: ${status.overall_severity}`,
    `Daemon checks: ${status.daemon_checks.length} total`,
    daemonSummary ? `Issues:\n${daemonSummary}` : "All daemon checks OK",
  ].join("\n");
}

function parseFindings(parsed: LlmBootstrapResponse): CheckFinding[] {
  if (!Array.isArray(parsed.findings)) return [];
  return parsed.findings.map((f) => ({
    issue: typeof f.issue === "string" ? f.issue : "unknown",
    line: typeof f.line === "string" ? f.line : undefined,
    detail: typeof f.detail === "string" ? f.detail : "",
    recommendation: typeof f.recommendation === "string" ? f.recommendation : undefined,
  }));
}

interface BootstrapInput { content: string; systemContext: string }

export async function runBootstrapIntegrityCheck(
  config: BootstrapIntegrityCheckConfig,
  llm: LlmClient,
  status: LeukoStatus | null,
  logger: PluginLogger,
): Promise<CognitiveCheckResult> {
  return runLlmCheck<BootstrapInput, LlmBootstrapResponse>({
    name: CHECK_NAME,
    systemPrompt: SYSTEM_PROMPT,
    llm,
    logger,

    readInput(timestamp, startMs) {
      const content = readTextInput(config.inputPath, 4000, logger);
      if (content === null) {
        return { ok: false, skip: { check_name: CHECK_NAME, severity: "warn", detail: "BOOTSTRAP.md not found — cannot verify integrity", timestamp, duration_ms: Date.now() - startMs } };
      }
      return { ok: true, input: { content, systemContext: buildSystemContext(status) } };
    },

    preFilter() {
      return { severity: "ok", findingCount: 0, data: {} };
    },

    buildPrompt(input) {
      return [
        `Current date: ${new Date().toISOString().split("T")[0]}`,
        "",
        "=== System State ===",
        input.systemContext,
        "",
        "=== BOOTSTRAP.md Content ===",
        input.content,
      ].join("\n");
    },

    buildFailOpen({ message, llmModel, llmTokens, timestamp, startMs }) {
      return {
        check_name: CHECK_NAME,
        severity: "ok",
        detail: `${message} — check skipped`,
        timestamp,
        model_used: llmModel,
        tokens_used: llmTokens,
        duration_ms: Date.now() - startMs,
      };
    },

    mergeResults(opts: MergeOpts<LlmBootstrapResponse>) {
      const findings = parseFindings(opts.parsed);
      return {
        check_name: CHECK_NAME,
        severity: parseSeverityString(opts.parsed.severity),
        detail: typeof opts.parsed.detail === "string"
          ? opts.parsed.detail
          : `${findings.length} findings`,
        findings,
        timestamp: opts.timestamp,
        model_used: opts.llmModel,
        tokens_used: opts.llmTokens,
        duration_ms: Date.now() - opts.startMs,
      };
    },
  });
}
