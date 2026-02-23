/**
 * @vainplex/openclaw-leuko — Cognitive immune system plugin for OpenClaw
 *
 * Provides:
 * - 6 cognitive health checks (4 LLM-based, 2 deterministic)
 * - `leuko_status` tool for agent health queries
 * - `before_agent_start` hook for health context injection
 * - `/leuko` command for interactive health queries
 * - Adopted Sitrep collectors (errors, custom)
 */

import type { PluginApi, LeukoStatus, Severity, CognitiveCheckResult, CognitiveMeta } from "./types.js";
import { loadConfig } from "./config.js";
import { registerLeukoTool } from "./tool.js";
import { readStatusFile, readHistoryFile } from "./status-reader.js";
import { writeCognitiveResults } from "./status-writer.js";
import { createLlmClient } from "./llm-client.js";
import { runGoalQualityCheck } from "./checks/goal-quality.js";
import { runThreadHealthCheck } from "./checks/thread-health.js";
import { runPipelineCorrelationCheck } from "./checks/pipeline-correlation.js";
import { runAnomalyDetectionCheck } from "./checks/anomaly-detection.js";
import { runBootstrapIntegrityCheck } from "./checks/bootstrap-integrity.js";
import { runRecommendationsCheck } from "./checks/recommendations.js";

const PLUGIN_VERSION = "0.1.0";

function computeOverallSeverity(checks: CognitiveCheckResult[]): Severity {
  if (checks.some((c) => c.severity === "critical")) return "critical";
  if (checks.some((c) => c.severity === "warn")) return "warn";
  return "ok";
}

function buildHealthSummary(status: LeukoStatus, maxLength: number): string {
  const issues: string[] = [];

  for (const c of status.daemon_checks) {
    if (c.severity !== "ok") {
      issues.push(`${c.check_name.replace("output_freshness:", "").replace("daemon:", "")} (${c.severity})`);
    }
  }
  for (const c of status.cognitive_checks ?? []) {
    if (c.severity !== "ok") {
      issues.push(`${c.check_name.replace("cognitive:", "")} (${c.severity})`);
    }
  }

  if (issues.length === 0) return "";

  const overall = computeOverallSeverity([
    ...status.daemon_checks.map((c) => ({ ...c, check_name: c.check_name, duration_ms: 0, timestamp: c.timestamp })),
    ...(status.cognitive_checks ?? []),
  ]);

  let summary = `${overall.toUpperCase()} — ${issues.length} issue(s): ${issues.join(", ")}`;
  if (summary.length > maxLength) {
    summary = summary.substring(0, maxLength - 3) + "...";
  }
  return summary;
}

/**
 * Run all enabled cognitive checks.
 */
async function runAllChecks(
  config: ReturnType<typeof loadConfig>["config"],
  logger: PluginApi["logger"],
): Promise<{ results: CognitiveCheckResult[]; meta: CognitiveMeta }> {
  const runStart = Date.now();
  const results: CognitiveCheckResult[] = [];
  let totalTokens = 0;
  let checksFailed = 0;

  const status = readStatusFile(config.statusPath, logger);
  const history = readHistoryFile(config.historyPath, logger);
  const llm = createLlmClient(config.llm.primary, config.llm.fallback, logger);

  // CK-01: Goal Quality (LLM)
  if (config.checks.goal_quality.enabled) {
    try {
      const result = await runGoalQualityCheck(config.checks.goal_quality, llm, logger);
      results.push(result);
      totalTokens += result.tokens_used ?? 0;
    } catch (e) {
      checksFailed++;
      logger.error(`[leuko] CK-01 failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // CK-02: Thread Health (LLM)
  if (config.checks.thread_health.enabled) {
    try {
      const result = await runThreadHealthCheck(config.checks.thread_health, llm, logger);
      results.push(result);
      totalTokens += result.tokens_used ?? 0;
    } catch (e) {
      checksFailed++;
      logger.error(`[leuko] CK-02 failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // CK-03: Pipeline Correlation (deterministic)
  if (config.checks.pipeline_correlation.enabled) {
    try {
      const result = runPipelineCorrelationCheck(
        config.checks.pipeline_correlation,
        {
          threadsPath: config.checks.thread_health.inputPath,
          daemonChecks: status?.daemon_checks ?? [],
        },
        logger,
      );
      results.push(result);
    } catch (e) {
      checksFailed++;
      logger.error(`[leuko] CK-03 failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // CK-04: Anomaly Detection (deterministic)
  if (config.checks.anomaly_detection.enabled) {
    try {
      const result = runAnomalyDetectionCheck(
        config.checks.anomaly_detection,
        history,
        logger,
      );
      results.push(result);
    } catch (e) {
      checksFailed++;
      logger.error(`[leuko] CK-04 failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // CK-05: Bootstrap Integrity (LLM)
  if (config.checks.bootstrap_integrity.enabled) {
    try {
      const result = await runBootstrapIntegrityCheck(
        config.checks.bootstrap_integrity,
        llm,
        status,
        logger,
      );
      results.push(result);
      totalTokens += result.tokens_used ?? 0;
    } catch (e) {
      checksFailed++;
      logger.error(`[leuko] CK-05 failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // CK-06: Recommendations (LLM) — runs last, uses results from CK-01..CK-05
  if (config.checks.recommendations.enabled) {
    try {
      const result = await runRecommendationsCheck(
        config.checks.recommendations,
        llm,
        results,
        status,
        history,
        logger,
      );
      results.push(result);
      totalTokens += result.tokens_used ?? 0;
    } catch (e) {
      checksFailed++;
      logger.error(`[leuko] CK-06 failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Track consecutive critical counts
  if (status?.cognitive_checks) {
    for (const result of results) {
      const prev = status.cognitive_checks.find((c) => c.check_name === result.check_name);
      if (result.severity === "critical") {
        const prevCount = prev?.consecutive_critical_count ?? 0;
        result.consecutive_critical_count = prevCount + 1;
        result.first_critical_at = prev?.first_critical_at ?? result.timestamp;
        if (result.consecutive_critical_count >= 3) {
          result.escalation_needed = true;
        }
      } else {
        result.consecutive_critical_count = 0;
      }
    }
  }

  const meta: CognitiveMeta = {
    last_run: new Date().toISOString(),
    total_duration_ms: Date.now() - runStart,
    total_tokens: totalTokens,
    total_cost_usd: 0,
    model: `${config.llm.primary.provider}/${config.llm.primary.model}`,
    checks_completed: results.length,
    checks_failed: checksFailed,
    plugin_version: PLUGIN_VERSION,
  };

  return { results, meta };
}

const plugin = {
  id: "openclaw-leuko",
  name: "Leuko Health System",
  description:
    "Cognitive immune system — L2 semantic health checks, tool exposure, and Sitrep replacement",
  version: PLUGIN_VERSION,

  register(api: PluginApi): void {
    const { config, source, filePath } = loadConfig(api.pluginConfig, api.logger);
    api.logger.info(
      `[leuko] Config loaded (source=${source}${filePath ? `, path=${filePath}` : ""})`,
    );

    if (!config.enabled) {
      api.logger.info("[leuko] Disabled via config");
      return;
    }

    // Register leuko_status tool
    registerLeukoTool(api, config);

    // Register /leuko command
    api.registerCommand({
      name: "leuko",
      description: "Show system health summary from Leuko",
      handler: async (args?: Record<string, unknown>) => {
        const subcommand = typeof args?.["_"] === "string" ? args["_"] : "";

        if (subcommand === "refresh") {
          const { results, meta } = await runAllChecks(config, api.logger);
          writeCognitiveResults(config.statusPath, {
            cognitive_checks: results,
            cognitive_meta: meta,
          }, api.logger);
          const overall = computeOverallSeverity(results);
          return {
            text: `⚕️ Leuko L2 refresh complete: ${overall.toUpperCase()} — ${results.length} checks (${meta.total_duration_ms}ms, ${meta.total_tokens} tokens)`,
          };
        }

        if (subcommand === "detail") {
          const status = readStatusFile(config.statusPath, api.logger);
          if (!status?.cognitive_checks) {
            return { text: "⚕️ No cognitive check results available. Run `/leuko refresh` first." };
          }
          const lines = status.cognitive_checks.map(
            (c) => `${c.severity === "ok" ? "✅" : c.severity === "warn" ? "⚠️" : "🔴"} ${c.check_name}: ${c.detail}`,
          );
          return { text: `⚕️ Leuko L2 Detail:\n${lines.join("\n")}` };
        }

        if (subcommand === "config") {
          return {
            text: `⚕️ Leuko Config:\n- Status: ${config.statusPath}\n- Interval: ${config.intervalMinutes}min\n- Model: ${config.llm.primary.provider}/${config.llm.primary.model}\n- Checks: ${Object.entries(config.checks).filter(([, v]) => v.enabled).map(([k]) => k).join(", ")}`,
          };
        }

        // Default: summary
        const status = readStatusFile(config.statusPath, api.logger);
        if (!status) {
          return { text: "⚕️ Leuko status file not available." };
        }

        const summary = buildHealthSummary(status, config.healthInjection.maxLength);
        if (!summary) {
          return { text: "⚕️ Leuko Health: All systems OK ✅" };
        }
        return { text: `⚕️ Leuko Health: ${summary}` };
      },
    });

    // Register before_agent_start hook
    if (config.healthInjection.enabled) {
      api.on("before_agent_start", () => {
        const status = readStatusFile(config.statusPath, api.logger);
        if (!status) return undefined;

        const summary = buildHealthSummary(status, config.healthInjection.maxLength);
        if (!summary && config.healthInjection.onlyOnIssues) return undefined;

        return { prependContext: `⚕️ Leuko Health: ${summary || "All systems OK"}` };
      });
    }

    // Log enabled check count
    const enabledChecks = Object.values(config.checks).filter((c) => c.enabled).length;
    api.logger.info(`[leuko] Registered (${enabledChecks} checks enabled)`);
  },
};

export default plugin;

// Re-export for testing
export { runAllChecks, buildHealthSummary, computeOverallSeverity };
