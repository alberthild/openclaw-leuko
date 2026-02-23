import { statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  CognitiveCheckResult,
  AnomalyEntry,
  AnomalyDetectionCheckConfig,
  LeukoHistory,
  PluginLogger,
  Severity,
} from "../types.js";

const CHECK_NAME = "cognitive:anomaly_detection";

function getDirSizeMb(dirPath: string): number | null {
  try {
    if (!existsSync(dirPath)) return null;
    let totalBytes = 0;
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      try {
        if (entry.isFile()) totalBytes += statSync(join(dirPath, entry.name)).size;
      } catch { /* skip inaccessible */ }
    }
    return Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
  } catch {
    return null;
  }
}

interface TrendResult { consecutive: number; direction: "growing" | "shrinking" | "stable" }

function detectTrends(history: LeukoHistory | null, metricName: string): TrendResult {
  if (!history || history.snapshots.length < 3) return { consecutive: 0, direction: "stable" };
  const values = history.snapshots
    .filter((s) => typeof s.metrics[metricName] === "number")
    .map((s) => s.metrics[metricName]!);
  if (values.length < 3) return { consecutive: 0, direction: "stable" };
  return computeConsecutiveTrend(values);
}

function computeConsecutiveTrend(values: number[]): TrendResult {
  let up = 0;
  let down = 0;
  for (let i = values.length - 1; i > 0; i--) {
    const prev = values[i - 1]!;
    const curr = values[i]!;
    if (curr > prev) { up++; down = 0; }
    else if (curr < prev) { down++; up = 0; }
    else break;
  }
  if (down >= 3) return { consecutive: down, direction: "shrinking" };
  if (up >= 3) return { consecutive: up, direction: "growing" };
  return { consecutive: 0, direction: "stable" };
}

function checkDirSizes(
  config: AnomalyDetectionCheckConfig,
  history: LeukoHistory | null,
  baselines: Record<string, number>,
  anomalies: AnomalyEntry[],
): void {
  for (const dir of config.monitoredDirs) {
    const resolved = dir.path.replace(/^~/, process.env["HOME"] ?? "/tmp");
    const currentMb = getDirSizeMb(resolved);
    if (currentMb === null) continue;
    baselines[`${dir.label}_dir_mb`] = currentMb;
    checkGrowthAnomaly(dir.label, currentMb, history, anomalies);
  }
}

function checkGrowthAnomaly(
  label: string, currentMb: number,
  history: LeukoHistory | null, anomalies: AnomalyEntry[],
): void {
  if (!history || history.snapshots.length === 0) return;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const snap = history.snapshots.find((s) => {
    const ts = new Date(s.timestamp).getTime();
    return !isNaN(ts) && ts < weekAgo;
  });
  if (!snap) return;
  const baselineMb = snap.metrics[`${label}_dir_mb`];
  if (typeof baselineMb !== "number" || baselineMb <= 0) return;
  const ratio = currentMb / baselineMb;
  if (ratio > 5) {
    anomalies.push({ metric: `${label}_dir_mb`, current: currentMb, baseline: baselineMb, deviation: `${ratio.toFixed(1)}x growth in 7 days`, severity: "critical" });
  } else if (ratio > 2) {
    anomalies.push({ metric: `${label}_dir_mb`, current: currentMb, baseline: baselineMb, deviation: `${ratio.toFixed(1)}x growth in 7 days`, severity: "warn" });
  }
}

function checkMetricTrends(history: LeukoHistory | null, anomalies: AnomalyEntry[]): void {
  const tracked = ["fact_count", "goal_count", "thread_count"];
  for (const metric of tracked) {
    const trend = detectTrends(history, metric);
    if (trend.direction !== "shrinking" || trend.consecutive < 3) continue;
    const severity: Severity = trend.consecutive >= 5 ? "critical" : "warn";
    const deviation = trend.consecutive >= 5
      ? `${trend.consecutive} consecutive decreases — possible data loss`
      : `${trend.consecutive} consecutive decreases`;
    anomalies.push({ metric, current: trend.consecutive, baseline: 0, deviation, severity });
  }
}

function overallSeverity(anomalies: AnomalyEntry[]): Severity {
  if (anomalies.some((a) => a.severity === "critical")) return "critical";
  if (anomalies.some((a) => a.severity === "warn")) return "warn";
  return "ok";
}

export function runAnomalyDetectionCheck(
  config: AnomalyDetectionCheckConfig,
  history: LeukoHistory | null,
  logger: PluginLogger,
): CognitiveCheckResult {
  const startMs = Date.now();
  const timestamp = new Date().toISOString();
  const anomalies: AnomalyEntry[] = [];
  const baselines: Record<string, number> = {};

  checkDirSizes(config, history, baselines, anomalies);
  checkMetricTrends(history, anomalies);

  const detail = anomalies.length === 0
    ? "All metrics within normal range"
    : `${anomalies.length} anomaly(s) detected`;

  return {
    check_name: CHECK_NAME,
    severity: overallSeverity(anomalies),
    detail,
    anomalies,
    baselines,
    timestamp,
    duration_ms: Date.now() - startMs,
  };
}
