import { statSync, existsSync } from "node:fs";
import type {
  CognitiveCheckResult,
  CorrelationEntry,
  PipelineCorrelationCheckConfig,
  LeukoStatus,
  PluginLogger,
  Severity,
} from "../types.js";
import { worstSeverity } from "../check-utils.js";

const CHECK_NAME = "cognitive:pipeline_correlation";

/**
 * NATS message count is supplied by the caller when available.
 * We intentionally avoid spawning the `nats` CLI inside the plugin runtime.
 */
function getNatsEventCount(_stream: string, logger: PluginLogger, injected?: number | null): number | null {
  if (typeof injected === "number") return injected;
  logger.debug("[leuko] NATS message count unavailable (no subprocess fallback)");
  return null;
}

function fileAgeHours(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    return (Date.now() - statSync(path).mtimeMs) / (60 * 60 * 1000);
  } catch {
    return null;
  }
}

function isBusinessHours(bh: PipelineCorrelationCheckConfig["businessHours"]): boolean {
  const hour = new Date().getUTCHours() + 1;
  return hour >= bh.start && hour < bh.end;
}

interface CronStatus { allOk: boolean; staleOutputs: number }

function getCronStatus(daemonChecks: LeukoStatus["daemon_checks"]): CronStatus {
  let allOk = true;
  let staleOutputs = 0;
  for (const check of daemonChecks) {
    if (check.check_name.startsWith("cron_health:") && check.severity !== "ok") allOk = false;
    if (check.check_name.startsWith("output_freshness:") && check.severity !== "ok") staleOutputs++;
  }
  return { allOk, staleOutputs };
}

export interface PipelineCorrelationDeps {
  threadsPath: string;
  daemonChecks: LeukoStatus["daemon_checks"];
  natsTotalMessages?: number | null;
}

interface PipelineSignals {
  natsTotal: number | null;
  threadsAgeH: number | null;
  cronStatus: CronStatus;
  inBusinessHours: boolean;
}

function gatherSignals(
  config: PipelineCorrelationCheckConfig,
  deps: PipelineCorrelationDeps,
  logger: PluginLogger,
): PipelineSignals {
  return {
    natsTotal: getNatsEventCount(config.natsStream, logger, deps.natsTotalMessages),
    threadsAgeH: fileAgeHours(deps.threadsPath),
    cronStatus: getCronStatus(deps.daemonChecks),
    inBusinessHours: isBusinessHours(config.businessHours),
  };
}

function buildCorrelations(
  signals: PipelineSignals,
  windowHours: number,
): CorrelationEntry[] {
  const correlations: CorrelationEntry[] = [];
  addNatsThreadCorrelation(signals, windowHours, correlations);
  addPipelineDisconnectCorrelation(signals, correlations);
  addEventSourceSilentCorrelation(signals, correlations);
  return correlations;
}

function addNatsThreadCorrelation(s: PipelineSignals, windowH: number, out: CorrelationEntry[]): void {
  if (s.natsTotal === null || s.natsTotal <= 0 || s.threadsAgeH === null) return;
  if (s.threadsAgeH > 4) {
    out.push({ input: "nats_total_messages", input_value: s.natsTotal, output: "threads_age_hours", output_value: Math.round(s.threadsAgeH * 10) / 10, diagnosis: "consumer_disconnected" });
  } else if (s.threadsAgeH > windowH) {
    out.push({ input: "nats_total_messages", input_value: s.natsTotal, output: "threads_age_hours", output_value: Math.round(s.threadsAgeH * 10) / 10, diagnosis: "consumer_slow" });
  }
}

function addPipelineDisconnectCorrelation(s: PipelineSignals, out: CorrelationEntry[]): void {
  if (s.cronStatus.allOk && s.cronStatus.staleOutputs >= 2) {
    out.push({ input: "crons_all_ok", input_value: 1, output: "stale_outputs", output_value: s.cronStatus.staleOutputs, diagnosis: "pipeline_disconnected" });
  }
}

function addEventSourceSilentCorrelation(s: PipelineSignals, out: CorrelationEntry[]): void {
  if (s.natsTotal !== null && s.natsTotal === 0 && s.inBusinessHours) {
    out.push({ input: "nats_events", input_value: 0, output: "business_hours", output_value: 1, diagnosis: "event_source_silent" });
  }
}

function computeCorrelationSeverity(correlations: CorrelationEntry[]): Severity {
  let severity: Severity = "ok";
  for (const c of correlations) {
    if (c.diagnosis === "consumer_disconnected" && c.output_value > 4) {
      severity = worstSeverity(severity, "critical");
    } else if (c.diagnosis === "consumer_disconnected") {
      severity = worstSeverity(severity, "warn");
    } else if (c.diagnosis === "pipeline_disconnected" || c.diagnosis === "event_source_silent") {
      severity = worstSeverity(severity, "warn");
    }
  }
  return severity;
}

export function runPipelineCorrelationCheck(
  config: PipelineCorrelationCheckConfig,
  deps: PipelineCorrelationDeps,
  logger: PluginLogger,
): CognitiveCheckResult {
  const startMs = Date.now();
  const timestamp = new Date().toISOString();

  const signals = gatherSignals(config, deps, logger);
  const correlations = buildCorrelations(signals, config.correlationWindowHours);
  const severity = computeCorrelationSeverity(correlations);
  const detail = correlations.length === 0
    ? "All pipeline correlations normal"
    : `${correlations.length} correlation issue(s) detected`;

  return { check_name: CHECK_NAME, severity, detail, correlations, timestamp, duration_ms: Date.now() - startMs };
}
