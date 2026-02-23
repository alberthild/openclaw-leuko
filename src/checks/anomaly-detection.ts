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

/**
 * Get total size of a directory in MB.
 */
function getDirSizeMb(dirPath: string): number | null {
  try {
    if (!existsSync(dirPath)) return null;
    let totalBytes = 0;
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      try {
        const fullPath = join(dirPath, entry.name);
        if (entry.isFile()) {
          totalBytes += statSync(fullPath).size;
        }
        // Don't recurse deep to keep it fast
      } catch {
        // Skip inaccessible files
      }
    }
    return Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
  } catch {
    return null;
  }
}

/**
 * Check for consecutive same-direction metric trends.
 */
function detectTrends(
  history: LeukoHistory | null,
  metricName: string,
): { consecutive: number; direction: "growing" | "shrinking" | "stable" } {
  if (!history || history.snapshots.length < 3) {
    return { consecutive: 0, direction: "stable" };
  }

  const values = history.snapshots
    .filter((s) => typeof s.metrics[metricName] === "number")
    .map((s) => s.metrics[metricName]!);

  if (values.length < 3) return { consecutive: 0, direction: "stable" };

  let consecutiveUp = 0;
  let consecutiveDown = 0;

  for (let i = values.length - 1; i > 0; i--) {
    const prev = values[i - 1]!;
    const curr = values[i]!;
    if (curr > prev) {
      consecutiveUp++;
      consecutiveDown = 0;
    } else if (curr < prev) {
      consecutiveDown++;
      consecutiveUp = 0;
    } else {
      break;
    }
  }

  if (consecutiveDown >= 3) return { consecutive: consecutiveDown, direction: "shrinking" };
  if (consecutiveUp >= 3) return { consecutive: consecutiveUp, direction: "growing" };
  return { consecutive: 0, direction: "stable" };
}

function severityFromAnomaly(entry: AnomalyEntry): Severity {
  return entry.severity;
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

  // Check directory sizes
  for (const dir of config.monitoredDirs) {
    const resolvedPath = dir.path.replace(/^~/, process.env["HOME"] ?? "/tmp");
    const currentMb = getDirSizeMb(resolvedPath);
    if (currentMb !== null) {
      baselines[`${dir.label}_dir_mb`] = currentMb;

      // Compare to historical baseline if available
      if (history && history.snapshots.length > 0) {
        // Get baseline from ~7 days ago
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const baselineSnapshot = history.snapshots.find((s) => {
          const ts = new Date(s.timestamp).getTime();
          return !isNaN(ts) && ts < weekAgo;
        });

        if (baselineSnapshot) {
          const baselineMb = baselineSnapshot.metrics[`${dir.label}_dir_mb`];
          if (typeof baselineMb === "number" && baselineMb > 0) {
            const ratio = currentMb / baselineMb;
            if (ratio > 5) {
              anomalies.push({
                metric: `${dir.label}_dir_mb`,
                current: currentMb,
                baseline: baselineMb,
                deviation: `${ratio.toFixed(1)}x growth in 7 days`,
                severity: "critical",
              });
            } else if (ratio > 2) {
              anomalies.push({
                metric: `${dir.label}_dir_mb`,
                current: currentMb,
                baseline: baselineMb,
                deviation: `${ratio.toFixed(1)}x growth in 7 days`,
                severity: "warn",
              });
            }
          }
        }
      }
    }
  }

  // Check metric trends
  const trackedMetrics = ["fact_count", "goal_count", "thread_count"];
  for (const metric of trackedMetrics) {
    const trend = detectTrends(history, metric);
    if (trend.direction === "shrinking" && trend.consecutive >= 5) {
      anomalies.push({
        metric,
        current: trend.consecutive,
        baseline: 0,
        deviation: `${trend.consecutive} consecutive decreases — possible data loss`,
        severity: "critical",
      });
    } else if (trend.direction === "shrinking" && trend.consecutive >= 3) {
      anomalies.push({
        metric,
        current: trend.consecutive,
        baseline: 0,
        deviation: `${trend.consecutive} consecutive decreases`,
        severity: "warn",
      });
    }
  }

  // Determine overall severity
  let severity: Severity = "ok";
  for (const a of anomalies) {
    const s = severityFromAnomaly(a);
    if (s === "critical") {
      severity = "critical";
      break;
    }
    if (s === "warn") severity = "warn";
  }

  const detail =
    anomalies.length === 0
      ? "All metrics within normal range"
      : `${anomalies.length} anomaly(s) detected`;

  return {
    check_name: CHECK_NAME,
    severity,
    detail,
    anomalies,
    baselines,
    timestamp,
    duration_ms: Date.now() - startMs,
  };
}
