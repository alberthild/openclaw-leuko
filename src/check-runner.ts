import type {
  CognitiveCheckResult,
  LlmClient,
  PluginLogger,
  Severity,
} from "./types.js";
import { parseLlmJson } from "./check-utils.js";

/**
 * Options for the generic LLM check runner.
 *
 * TInput: the shape read from disk (goals, threads, bootstrap text, etc.)
 * TResponse: the expected LLM JSON response shape
 */
export interface LlmCheckOpts<TInput, TResponse> {
  /** Check name (e.g. "cognitive:goal_quality") */
  name: string;
  /** LLM system prompt */
  systemPrompt: string;
  /** LLM client instance */
  llm: LlmClient;
  /** Logger */
  logger: PluginLogger;
  /** Read input data; return null to skip with a given result */
  readInput(timestamp: string, startMs: number): ReadInputResult<TInput>;
  /** Run deterministic pre-filter; returns pre-severity and partial data */
  preFilter(input: TInput): PreFilterResult;
  /** Build the LLM user prompt from input */
  buildPrompt(input: TInput): string;
  /** Build fail-open result when LLM fails */
  buildFailOpen(opts: FailOpenOpts): CognitiveCheckResult;
  /** Parse and merge LLM response + pre-filter into final result */
  mergeResults(opts: MergeOpts<TResponse>): CognitiveCheckResult;
}

export type ReadInputResult<T> =
  | { ok: true; input: T }
  | { ok: false; skip: CognitiveCheckResult };

export interface PreFilterResult {
  severity: Severity;
  findingCount: number;
  /** Arbitrary data passed through to mergeResults / buildFailOpen */
  data: Record<string, unknown>;
}

export interface FailOpenOpts {
  name: string;
  pre: PreFilterResult;
  message: string;
  llmModel: string;
  llmTokens: number;
  timestamp: string;
  startMs: number;
}

export interface MergeOpts<TResponse> {
  parsed: TResponse;
  pre: PreFilterResult;
  llmModel: string;
  llmTokens: number;
  timestamp: string;
  startMs: number;
}

/**
 * Generic runner for all LLM-based cognitive checks.
 *
 * Flow: readInput → preFilter → LLM call → parse → mergeResults
 * On LLM failure: fail-open via buildFailOpen.
 */
export async function runLlmCheck<TInput, TResponse>(
  opts: LlmCheckOpts<TInput, TResponse>,
): Promise<CognitiveCheckResult> {
  const startMs = Date.now();
  const timestamp = new Date().toISOString();

  const readResult = opts.readInput(timestamp, startMs);
  if (!readResult.ok) return readResult.skip;

  const pre = opts.preFilter(readResult.input);
  const userPrompt = opts.buildPrompt(readResult.input);
  const llmResult = await opts.llm.generate(opts.systemPrompt, userPrompt, 30000);

  if (llmResult.content === null) {
    const msg = llmResult.error
      ? `LLM unavailable (${llmResult.error})`
      : "LLM timeout";
    return opts.buildFailOpen({
      name: opts.name, pre, message: msg,
      llmModel: llmResult.model, llmTokens: 0, timestamp, startMs,
    });
  }

  const parsed = parseLlmJson<TResponse>(llmResult.content);
  if (!parsed) {
    return opts.buildFailOpen({
      name: opts.name, pre, message: "LLM response parsing failed",
      llmModel: llmResult.model, llmTokens: llmResult.tokens,
      timestamp, startMs,
    });
  }

  return opts.mergeResults({
    parsed, pre,
    llmModel: llmResult.model, llmTokens: llmResult.tokens,
    timestamp, startMs,
  });
}
