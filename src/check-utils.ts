import type { Severity } from "./types.js";

/**
 * Parse a string (typically from LLM response) into a valid Severity.
 * Returns "ok" for unrecognized values.
 */
export function parseSeverityString(v: unknown): Severity {
  if (v === "ok" || v === "warn" || v === "critical") return v;
  return "ok";
}

/**
 * Return the most severe of the given severities.
 * Order: ok < warn < critical.
 */
export function worstSeverity(...severities: Severity[]): Severity {
  if (severities.includes("critical")) return "critical";
  if (severities.includes("warn")) return "warn";
  return "ok";
}

/**
 * Type guard: is value a plain object (non-null, non-array)?
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse a JSON string (typically raw LLM output) into a typed object.
 * Returns null on parse failure.
 */
export function parseLlmJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
