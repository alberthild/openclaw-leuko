import type {
  CognitiveCheckResult,
  CheckFinding,
  BootstrapIntegrityCheckConfig,
  LlmClient,
  LeukoStatus,
  PluginLogger,
  Severity,
} from "../types.js";
import { readTextInput } from "../status-reader.js";

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

function parseLlmResponse(raw: string): LlmBootstrapResponse | null {
  try {
    return JSON.parse(raw) as LlmBootstrapResponse;
  } catch {
    return null;
  }
}

function parseSeverityString(v: unknown): Severity {
  if (v === "ok" || v === "warn" || v === "critical") return v;
  return "ok";
}

/**
 * Build a system context summary from leuko-status for the LLM.
 */
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

export async function runBootstrapIntegrityCheck(
  config: BootstrapIntegrityCheckConfig,
  llm: LlmClient,
  status: LeukoStatus | null,
  logger: PluginLogger,
): Promise<CognitiveCheckResult> {
  const startMs = Date.now();
  const timestamp = new Date().toISOString();

  const bootstrapContent = readTextInput(config.inputPath, 4000, logger);
  if (bootstrapContent === null) {
    return {
      check_name: CHECK_NAME,
      severity: "warn",
      detail: "BOOTSTRAP.md not found — cannot verify integrity",
      timestamp,
      duration_ms: Date.now() - startMs,
    };
  }

  const systemContext = buildSystemContext(status);

  const userPrompt = [
    `Current date: ${new Date().toISOString().split("T")[0]}`,
    "",
    "=== System State ===",
    systemContext,
    "",
    "=== BOOTSTRAP.md Content ===",
    bootstrapContent,
  ].join("\n");

  const llmResult = await llm.generate(SYSTEM_PROMPT, userPrompt, 30000);

  if (llmResult.content === null) {
    return {
      check_name: CHECK_NAME,
      severity: "ok",
      detail: llmResult.error
        ? `LLM unavailable (${llmResult.error}) — check skipped`
        : "LLM timeout — check skipped",
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
      detail: "LLM response parsing failed — check skipped",
      timestamp,
      model_used: llmResult.model,
      tokens_used: llmResult.tokens,
      duration_ms: Date.now() - startMs,
    };
  }

  const findings: CheckFinding[] = Array.isArray(parsed.findings)
    ? parsed.findings.map((f) => ({
        issue: typeof f.issue === "string" ? f.issue : "unknown",
        line: typeof f.line === "string" ? f.line : undefined,
        detail: typeof f.detail === "string" ? f.detail : "",
        recommendation: typeof f.recommendation === "string" ? f.recommendation : undefined,
      }))
    : [];

  return {
    check_name: CHECK_NAME,
    severity: parseSeverityString(parsed.severity),
    detail: typeof parsed.detail === "string" ? parsed.detail : `${findings.length} findings`,
    findings,
    timestamp,
    model_used: llmResult.model,
    tokens_used: llmResult.tokens,
    duration_ms: Date.now() - startMs,
  };
}
