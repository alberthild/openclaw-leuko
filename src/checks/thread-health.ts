import type {
  CognitiveCheckResult,
  CheckFinding,
  ThreadHealthCheckConfig,
  LlmClient,
  ThreadEntry,
  ThreadsFile,
  PluginLogger,
  Severity,
} from "../types.js";
import { readJsonInput } from "../status-reader.js";

const CHECK_NAME = "cognitive:thread_health";

const SYSTEM_PROMPT = `You are a system health evaluator. Analyze the conversation threads and assess their health.
Respond ONLY with valid JSON matching this schema:
{
  "severity": "ok" | "warn" | "critical",
  "detail": "single line summary",
  "findings": [
    {
      "thread_id": "thread id",
      "issue": "stale" | "duplicate" | "incomplete" | "accumulating",
      "detail": "explanation",
      "days_since_update": 0,
      "recommendation": "what to do"
    }
  ]
}

Evaluation rules:
- Open threads with no update for > staleDays → WARN: stale
- Threads with identical or near-identical titles → WARN: duplicate  
- Threads with empty or minimal description → WARN: incomplete
- Ratio of open to total (>80% open with >10 total) → WARN: accumulating
- ALL threads current and well-formed → severity "ok"
- ≥1 stale/duplicate/incomplete → severity "warn"
- ≥50% threads are stale or noise → severity "critical"`;

function extractThreads(data: unknown): ThreadEntry[] {
  if (typeof data !== "object" || data === null) return [];
  const obj = data as ThreadsFile;
  if (Array.isArray(obj.threads)) return obj.threads;
  if (Array.isArray(data)) return data as ThreadEntry[];
  return [];
}

/**
 * Pre-filter: detect stale threads by last_activity without LLM.
 */
function preFilterThreads(
  threads: ThreadEntry[],
  staleDays: number,
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const now = Date.now();
  const staleMs = staleDays * 24 * 60 * 60 * 1000;

  for (const thread of threads) {
    if (thread.status !== "open") continue;

    if (thread.last_activity) {
      const lastMs = new Date(thread.last_activity).getTime();
      if (!isNaN(lastMs) && now - lastMs > staleMs) {
        const daysSince = Math.round((now - lastMs) / (24 * 60 * 60 * 1000));
        findings.push({
          thread_id: thread.id,
          issue: "stale",
          detail: `Thread "${thread.title}" has no update for ${daysSince} days`,
          days_since_update: daysSince,
          recommendation: "Archive or update thread",
        });
      }
    }
  }

  return findings;
}

interface LlmThreadResponse {
  severity?: string;
  detail?: string;
  findings?: Array<{
    thread_id?: string;
    issue?: string;
    detail?: string;
    days_since_update?: number;
    recommendation?: string;
  }>;
}

function parseLlmResponse(raw: string): LlmThreadResponse | null {
  try {
    return JSON.parse(raw) as LlmThreadResponse;
  } catch {
    return null;
  }
}

function parseSeverityString(v: unknown): Severity {
  if (v === "ok" || v === "warn" || v === "critical") return v;
  return "ok";
}

function worstSeverity(a: Severity, b: Severity): Severity {
  const order: Record<Severity, number> = { ok: 0, warn: 1, critical: 2 };
  return order[a] >= order[b] ? a : b;
}

export async function runThreadHealthCheck(
  config: ThreadHealthCheckConfig,
  llm: LlmClient,
  logger: PluginLogger,
): Promise<CognitiveCheckResult> {
  const startMs = Date.now();
  const timestamp = new Date().toISOString();

  const rawData = readJsonInput<unknown>(config.inputPath, logger);
  if (rawData === null) {
    return {
      check_name: CHECK_NAME,
      severity: "ok",
      detail: "Threads file not found — check skipped",
      timestamp,
      duration_ms: Date.now() - startMs,
    };
  }

  const threads = extractThreads(rawData);
  if (threads.length === 0) {
    return {
      check_name: CHECK_NAME,
      severity: "ok",
      detail: "No threads found",
      timestamp,
      duration_ms: Date.now() - startMs,
    };
  }

  // Pre-filter
  const preFindings = preFilterThreads(threads, config.staleDays);

  // LLM analysis
  const threadsText = JSON.stringify(threads, null, 2).substring(0, 4000);
  const userPrompt = `Current date: ${new Date().toISOString().split("T")[0]}\nStale threshold: ${config.staleDays} days\n\nThreads (${threads.length} total):\n${threadsText}`;

  const llmResult = await llm.generate(SYSTEM_PROMPT, userPrompt, 30000);

  if (llmResult.content === null) {
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

  const llmFindings: CheckFinding[] = Array.isArray(parsed.findings)
    ? parsed.findings.map((f) => ({
        thread_id: typeof f.thread_id === "string" ? f.thread_id : undefined,
        issue: typeof f.issue === "string" ? f.issue : "unknown",
        detail: typeof f.detail === "string" ? f.detail : "",
        days_since_update: typeof f.days_since_update === "number" ? f.days_since_update : undefined,
        recommendation: typeof f.recommendation === "string" ? f.recommendation : undefined,
      }))
    : [];

  const seenIds = new Set(preFindings.map((f) => f.thread_id).filter(Boolean));
  const uniqueLlmFindings = llmFindings.filter(
    (f) => !f.thread_id || !seenIds.has(f.thread_id),
  );
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
