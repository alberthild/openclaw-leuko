import { execSync } from "node:child_process";
import { statSync, existsSync, readFileSync } from "node:fs";
import type {
  CognitiveCheckResult,
  CorrelationEntry,
  PipelineCorrelationCheckConfig,
  LeukoStatus,
  PluginLogger,
  Severity,
} from "../types.js";

const CHECK_NAME = "cognitive:pipeline_correlation";

/**
 * Try to get NATS stream message count via CLI.
 * Returns null if nats CLI not available or fails.
 */
function getNatsEventCount(
  stream: string,
  windowHours: number,
  logger: PluginLogger,
): number | null {
  try {
    const result = execSync(`nats stream info ${stream} --json 2>/dev/null`, {
      timeout: 5000,
      encoding: "utf-8",
    });
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const state = obj["state"] as Record<string, unknown> | undefined;
      if (state && typeof state["messages"] === "number") {
        // This is total messages, not windowed — best we can do without consumer
        return state["messages"];
      }
    }
    return null;
  } catch {
    logger.debug("[leuko] NATS CLI not available or stream not found");
    return null;
  }
}

/**
 * Get file modification age in hours.
 */
function fileAgeHours(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    return (Date.now() - stat.mtimeMs) / (60 * 60 * 1000);
  } catch {
    return null;
  }
}

/**
 * Check if current time is within business hours.
 */
function isBusinessHours(
  config: PipelineCorrelationCheckConfig["businessHours"],
): boolean {
  // Simple check using UTC offset for Europe/Berlin
  const now = new Date();
  // Use hour in local timezone approximation
  const hour = now.getUTCHours() + 1; // CET is UTC+1, CEST UTC+2 — approximate
  return hour >= config.start && hour < config.end;
}

function worstSeverity(...severities: Severity[]): Severity {
  if (severities.includes("critical")) return "critical";
  if (severities.includes("warn")) return "warn";
  return "ok";
}

/**
 * Extract cron health from daemon checks.
 */
function getCronStatus(
  daemonChecks: LeukoStatus["daemon_checks"],
): { allOk: boolean; staleOutputs: number } {
  let allOk = true;
  let staleOutputs = 0;

  for (const check of daemonChecks) {
    if (check.check_name.startsWith("cron_health:")) {
      if (check.severity !== "ok") allOk = false;
    }
    if (check.check_name.startsWith("output_freshness:")) {
      if (check.severity !== "ok") staleOutputs++;
    }
  }

  return { allOk, staleOutputs };
}

export interface PipelineCorrelationDeps {
  threadsPath: string;
  daemonChecks: LeukoStatus["daemon_checks"];
}

export function runPipelineCorrelationCheck(
  config: PipelineCorrelationCheckConfig,
  deps: PipelineCorrelationDeps,
  logger: PluginLogger,
): CognitiveCheckResult {
  const startMs = Date.now();
  const timestamp = new Date().toISOString();
  const correlations: CorrelationEntry[] = [];

  // Gather signals
  const natsTotal = getNatsEventCount(config.natsStream, config.correlationWindowHours, logger);
  const threadsAgeH = fileAgeHours(deps.threadsPath);
  const cronStatus = getCronStatus(deps.daemonChecks);
  const inBusinessHours = isBusinessHours(config.businessHours);

  // Correlation Rule 1: NATS events vs thread updates
  if (natsTotal !== null && natsTotal > 0 && threadsAgeH !== null) {
    if (threadsAgeH > 4) {
      correlations.push({
        input: "nats_total_messages",
        input_value: natsTotal,
        output: "threads_age_hours",
        output_value: Math.round(threadsAgeH * 10) / 10,
        diagnosis: "consumer_disconnected",
      });
    } else if (threadsAgeH > config.correlationWindowHours) {
      correlations.push({
        input: "nats_total_messages",
        input_value: natsTotal,
        output: "threads_age_hours",
        output_value: Math.round(threadsAgeH * 10) / 10,
        diagnosis: "consumer_slow",
      });
    }
  }

  // Correlation Rule 2: All crons OK but multiple outputs stale
  if (cronStatus.allOk && cronStatus.staleOutputs >= 2) {
    correlations.push({
      input: "crons_all_ok",
      input_value: 1,
      output: "stale_outputs",
      output_value: cronStatus.staleOutputs,
      diagnosis: "pipeline_disconnected",
    });
  }

  // Correlation Rule 3: NATS silent during business hours
  if (natsTotal !== null && natsTotal === 0 && inBusinessHours) {
    correlations.push({
      input: "nats_events",
      input_value: 0,
      output: "business_hours",
      output_value: 1,
      diagnosis: "event_source_silent",
    });
  }

  // Determine severity
  let severity: Severity = "ok";
  for (const c of correlations) {
    if (c.diagnosis === "consumer_disconnected" && (c.output_value > 4)) {
      severity = worstSeverity(severity, "critical");
    } else if (c.diagnosis === "consumer_disconnected") {
      severity = worstSeverity(severity, "warn");
    } else if (c.diagnosis === "pipeline_disconnected") {
      severity = worstSeverity(severity, "warn");
    } else if (c.diagnosis === "event_source_silent") {
      severity = worstSeverity(severity, "warn");
    }
  }

  const detail =
    correlations.length === 0
      ? "All pipeline correlations normal"
      : `${correlations.length} correlation issue(s) detected`;

  return {
    check_name: CHECK_NAME,
    severity,
    detail,
    correlations,
    timestamp,
    duration_ms: Date.now() - startMs,
  };
}
