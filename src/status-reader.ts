import { readFileSync, existsSync } from "node:fs";
import type {
  LeukoStatus,
  PluginLogger,
  Severity,
  DaemonCheck,
  CognitiveCheckResult,
  CognitiveMeta,
  SitrepCollectorResult,
  LeukoHistory,
  HistorySnapshot,
} from "./types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSeverity(v: unknown): Severity {
  if (v === "ok" || v === "warn" || v === "critical") return v;
  return "ok";
}

function parseDaemonCheck(raw: unknown): DaemonCheck | null {
  if (!isRecord(raw)) return null;
  return {
    check_name: typeof raw["check_name"] === "string" ? raw["check_name"] : "",
    severity: parseSeverity(raw["severity"]),
    detail: typeof raw["detail"] === "string" ? raw["detail"] : "",
    auto_healed: typeof raw["auto_healed"] === "boolean" ? raw["auto_healed"] : false,
    timestamp: typeof raw["timestamp"] === "string" ? raw["timestamp"] : "",
    heal_action: typeof raw["heal_action"] === "string" ? raw["heal_action"] : null,
    heal_key: typeof raw["heal_key"] === "string" ? raw["heal_key"] : null,
  };
}

function parseCognitiveCheck(raw: unknown): CognitiveCheckResult | null {
  if (!isRecord(raw)) return null;
  return {
    check_name: typeof raw["check_name"] === "string" ? raw["check_name"] : "",
    severity: parseSeverity(raw["severity"]),
    detail: typeof raw["detail"] === "string" ? raw["detail"] : "",
    findings: Array.isArray(raw["findings"]) ? (raw["findings"] as CognitiveCheckResult["findings"]) : undefined,
    correlations: Array.isArray(raw["correlations"]) ? (raw["correlations"] as CognitiveCheckResult["correlations"]) : undefined,
    anomalies: Array.isArray(raw["anomalies"]) ? (raw["anomalies"] as CognitiveCheckResult["anomalies"]) : undefined,
    baselines: isRecord(raw["baselines"]) ? (raw["baselines"] as Record<string, number>) : undefined,
    recommendations: Array.isArray(raw["recommendations"]) ? (raw["recommendations"] as CognitiveCheckResult["recommendations"]) : undefined,
    escalation_needed: typeof raw["escalation_needed"] === "boolean" ? raw["escalation_needed"] : undefined,
    consecutive_critical_count: typeof raw["consecutive_critical_count"] === "number" ? raw["consecutive_critical_count"] : undefined,
    first_critical_at: typeof raw["first_critical_at"] === "string" ? raw["first_critical_at"] : undefined,
    timestamp: typeof raw["timestamp"] === "string" ? raw["timestamp"] : new Date().toISOString(),
    model_used: typeof raw["model_used"] === "string" ? raw["model_used"] : undefined,
    tokens_used: typeof raw["tokens_used"] === "number" ? raw["tokens_used"] : undefined,
    duration_ms: typeof raw["duration_ms"] === "number" ? raw["duration_ms"] : 0,
  };
}

function parseCognitiveMeta(raw: unknown): CognitiveMeta | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    last_run: typeof raw["last_run"] === "string" ? raw["last_run"] : "",
    total_duration_ms: typeof raw["total_duration_ms"] === "number" ? raw["total_duration_ms"] : 0,
    total_tokens: typeof raw["total_tokens"] === "number" ? raw["total_tokens"] : 0,
    total_cost_usd: typeof raw["total_cost_usd"] === "number" ? raw["total_cost_usd"] : 0,
    model: typeof raw["model"] === "string" ? raw["model"] : "",
    checks_completed: typeof raw["checks_completed"] === "number" ? raw["checks_completed"] : 0,
    checks_failed: typeof raw["checks_failed"] === "number" ? raw["checks_failed"] : 0,
    plugin_version: typeof raw["plugin_version"] === "string" ? raw["plugin_version"] : "",
  };
}

function parseSitrepCollector(raw: unknown): SitrepCollectorResult | null {
  if (!isRecord(raw)) return null;
  return {
    collector_name: typeof raw["collector_name"] === "string" ? raw["collector_name"] : "",
    status: parseSeverity(raw["status"]),
    items: Array.isArray(raw["items"]) ? (raw["items"] as ReadonlyArray<Record<string, unknown>>) : [],
    summary: typeof raw["summary"] === "string" ? raw["summary"] : "",
    duration_ms: typeof raw["duration_ms"] === "number" ? raw["duration_ms"] : 0,
    timestamp: typeof raw["timestamp"] === "string" ? raw["timestamp"] : "",
  };
}

export function readStatusFile(path: string, logger?: PluginLogger): LeukoStatus | null {
  try {
    if (!existsSync(path)) {
      logger?.debug(`[leuko] Status file not found: ${path}`);
      return null;
    }
    const content = readFileSync(path, "utf-8");
    const raw: unknown = JSON.parse(content);
    if (!isRecord(raw)) {
      logger?.warn(`[leuko] Status file is not an object: ${path}`);
      return null;
    }
    return {
      last_check: typeof raw["last_check"] === "string" ? raw["last_check"] : "",
      overall_severity: parseSeverity(raw["overall_severity"]),
      daemon_checks: Array.isArray(raw["daemon_checks"])
        ? (raw["daemon_checks"] as unknown[])
            .map(parseDaemonCheck)
            .filter((c): c is DaemonCheck => c !== null)
        : [],
      auto_heal_history: Array.isArray(raw["auto_heal_history"])
        ? raw["auto_heal_history"]
        : undefined,
      cognitive_checks: Array.isArray(raw["cognitive_checks"])
        ? (raw["cognitive_checks"] as unknown[])
            .map(parseCognitiveCheck)
            .filter((c): c is CognitiveCheckResult => c !== null)
        : undefined,
      cognitive_meta: parseCognitiveMeta(raw["cognitive_meta"]),
      sitrep_collectors: Array.isArray(raw["sitrep_collectors"])
        ? (raw["sitrep_collectors"] as unknown[])
            .map(parseSitrepCollector)
            .filter((c): c is SitrepCollectorResult => c !== null)
        : undefined,
    };
  } catch (e) {
    logger?.warn(
      `[leuko] Failed to read status file: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

export function readHistoryFile(path: string, logger?: PluginLogger): LeukoHistory | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf-8");
    const raw: unknown = JSON.parse(content);
    if (!isRecord(raw)) return null;
    const snapshots = Array.isArray(raw["snapshots"])
      ? (raw["snapshots"] as unknown[])
          .filter(isRecord)
          .map((s): HistorySnapshot => ({
            timestamp: typeof s["timestamp"] === "string" ? s["timestamp"] : "",
            metrics: isRecord(s["metrics"])
              ? Object.fromEntries(
                  Object.entries(s["metrics"]).filter(
                    (kv): kv is [string, number] => typeof kv[1] === "number",
                  ),
                )
              : {},
          }))
      : [];
    return { snapshots };
  } catch (e) {
    logger?.debug(
      `[leuko] Failed to read history file: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

export function readJsonInput<T>(
  path: string,
  logger?: PluginLogger,
): T | null {
  try {
    if (!existsSync(path)) {
      logger?.debug(`[leuko] Input file not found: ${path}`);
      return null;
    }
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as T;
  } catch (e) {
    logger?.warn(
      `[leuko] Failed to read input: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

export function readTextInput(path: string, maxChars: number = 4000, logger?: PluginLogger): string | null {
  try {
    if (!existsSync(path)) {
      logger?.debug(`[leuko] Input file not found: ${path}`);
      return null;
    }
    const content = readFileSync(path, "utf-8");
    return content.substring(0, maxChars);
  } catch (e) {
    logger?.warn(
      `[leuko] Failed to read text input: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
