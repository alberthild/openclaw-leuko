import type {
  CognitiveCheckResult,
  CheckFinding,
  ThreadHealthCheckConfig,
  LlmClient,
  ThreadEntry,
  ThreadsFile,
  PluginLogger,
} from "../types.js";
import { readJsonInput } from "../status-reader.js";
import { parseSeverityString, worstSeverity } from "../check-utils.js";
import { runLlmCheck } from "../check-runner.js";
import type { MergeOpts } from "../check-runner.js";

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

function preFilterThreads(threads: ThreadEntry[], staleDays: number): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const now = Date.now();
  const staleMs = staleDays * 24 * 60 * 60 * 1000;

  for (const thread of threads) {
    if (thread.status !== "open" || !thread.last_activity) continue;
    const lastMs = new Date(thread.last_activity).getTime();
    if (isNaN(lastMs) || now - lastMs <= staleMs) continue;
    const daysSince = Math.round((now - lastMs) / (24 * 60 * 60 * 1000));
    findings.push({
      thread_id: thread.id,
      issue: "stale",
      detail: `Thread "${thread.title}" has no update for ${daysSince} days`,
      days_since_update: daysSince,
      recommendation: "Archive or update thread",
    });
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

function mergeLlmFindings(preFindings: CheckFinding[], parsed: LlmThreadResponse): CheckFinding[] {
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
  const unique = llmFindings.filter((f) => !f.thread_id || !seenIds.has(f.thread_id));
  return [...preFindings, ...unique];
}

interface ThreadInput { threads: ThreadEntry[]; staleDays: number }

export async function runThreadHealthCheck(
  config: ThreadHealthCheckConfig,
  llm: LlmClient,
  logger: PluginLogger,
): Promise<CognitiveCheckResult> {
  return runLlmCheck<ThreadInput, LlmThreadResponse>({
    name: CHECK_NAME,
    systemPrompt: SYSTEM_PROMPT,
    llm,
    logger,

    readInput(timestamp, startMs) {
      const rawData = readJsonInput<unknown>(config.inputPath, logger);
      if (rawData === null) {
        return { ok: false, skip: { check_name: CHECK_NAME, severity: "ok", detail: "Threads file not found — check skipped", timestamp, duration_ms: Date.now() - startMs } };
      }
      const threads = extractThreads(rawData);
      if (threads.length === 0) {
        return { ok: false, skip: { check_name: CHECK_NAME, severity: "ok", detail: "No threads found", timestamp, duration_ms: Date.now() - startMs } };
      }
      return { ok: true, input: { threads, staleDays: config.staleDays } };
    },

    preFilter(input) {
      const findings = preFilterThreads(input.threads, input.staleDays);
      return { severity: findings.length > 0 ? "warn" : "ok", findingCount: findings.length, data: { findings } };
    },

    buildPrompt(input) {
      const text = JSON.stringify(input.threads, null, 2).substring(0, 4000);
      return `Current date: ${new Date().toISOString().split("T")[0]}\nStale threshold: ${input.staleDays} days\n\nThreads (${input.threads.length} total):\n${text}`;
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

    mergeResults(opts: MergeOpts<LlmThreadResponse>) {
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
