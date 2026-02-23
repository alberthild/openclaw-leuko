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

import type { PluginApi, LeukoStatus, Severity, CognitiveCheckResult, CognitiveMeta, LeukoConfig, PluginLogger } from "./types.js";
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

function computeStatusSeverity(status: LeukoStatus): Severity {
  const allSeverities: Severity[] = [
    ...status.daemon_checks.map((c) => c.severity),
    ...(status.cognitive_checks ?? []).map((c) => c.severity),
  ];
  if (allSeverities.includes("critical")) return "critical";
  if (allSeverities.includes("warn")) return "warn";
  return "ok";
}

function buildHealthSummary(status: LeukoStatus, maxLength: number): string {
  const issues = collectIssueNames(status);
  if (issues.length === 0) return "";
  const overall = computeStatusSeverity(status);
  let summary = `${overall.toUpperCase()} — ${issues.length} issue(s): ${issues.join(", ")}`;
  if (summary.length > maxLength) summary = summary.substring(0, maxLength - 3) + "...";
  return summary;
}

function collectIssueNames(status: LeukoStatus): string[] {
  const issues: string[] = [];
  for (const c of status.daemon_checks) {
    if (c.severity !== "ok") issues.push(`${c.check_name.replace("output_freshness:", "").replace("daemon:", "")} (${c.severity})`);
  }
  for (const c of status.cognitive_checks ?? []) {
    if (c.severity !== "ok") issues.push(`${c.check_name.replace("cognitive:", "")} (${c.severity})`);
  }
  return issues;
}

interface CheckRunContext {
  results: CognitiveCheckResult[];
  totalTokens: number;
  checksFailed: number;
}

async function runCheck(
  ctx: CheckRunContext,
  label: string,
  fn: () => CognitiveCheckResult | Promise<CognitiveCheckResult>,
  logger: PluginLogger,
): Promise<void> {
  try {
    const result = await fn();
    ctx.results.push(result);
    ctx.totalTokens += result.tokens_used ?? 0;
  } catch (e) {
    ctx.checksFailed++;
    logger.error(`[leuko] ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runAllChecks(
  config: LeukoConfig,
  logger: PluginLogger,
): Promise<{ results: CognitiveCheckResult[]; meta: CognitiveMeta }> {
  const runStart = Date.now();
  const ctx: CheckRunContext = { results: [], totalTokens: 0, checksFailed: 0 };

  const status = readStatusFile(config.statusPath, logger);
  const history = readHistoryFile(config.historyPath, logger);
  const llm = createLlmClient(config.llm.primary, config.llm.fallback, logger);

  if (config.checks.goal_quality.enabled)
    await runCheck(ctx, "CK-01", () => runGoalQualityCheck(config.checks.goal_quality, llm, logger), logger);
  if (config.checks.thread_health.enabled)
    await runCheck(ctx, "CK-02", () => runThreadHealthCheck(config.checks.thread_health, llm, logger), logger);
  if (config.checks.pipeline_correlation.enabled)
    await runCheck(ctx, "CK-03", () => runPipelineCorrelationCheck(config.checks.pipeline_correlation, { threadsPath: config.checks.thread_health.inputPath, daemonChecks: status?.daemon_checks ?? [] }, logger), logger);
  if (config.checks.anomaly_detection.enabled)
    await runCheck(ctx, "CK-04", () => runAnomalyDetectionCheck(config.checks.anomaly_detection, history, logger), logger);
  if (config.checks.bootstrap_integrity.enabled)
    await runCheck(ctx, "CK-05", () => runBootstrapIntegrityCheck(config.checks.bootstrap_integrity, llm, status, logger), logger);
  if (config.checks.recommendations.enabled)
    await runCheck(ctx, "CK-06", () => runRecommendationsCheck(config.checks.recommendations, llm, ctx.results, status, history, logger), logger);

  trackConsecutiveCriticals(ctx.results, status);

  return {
    results: ctx.results,
    meta: {
      last_run: new Date().toISOString(),
      total_duration_ms: Date.now() - runStart,
      total_tokens: ctx.totalTokens,
      total_cost_usd: 0,
      model: `${config.llm.primary.provider}/${config.llm.primary.model}`,
      checks_completed: ctx.results.length,
      checks_failed: ctx.checksFailed,
      plugin_version: PLUGIN_VERSION,
    },
  };
}

function trackConsecutiveCriticals(results: CognitiveCheckResult[], status: LeukoStatus | null): void {
  if (!status?.cognitive_checks) return;
  for (const result of results) {
    const prev = status.cognitive_checks.find((c) => c.check_name === result.check_name);
    if (result.severity === "critical") {
      result.consecutive_critical_count = (prev?.consecutive_critical_count ?? 0) + 1;
      result.first_critical_at = prev?.first_critical_at ?? result.timestamp;
      if (result.consecutive_critical_count >= 3) result.escalation_needed = true;
    } else {
      result.consecutive_critical_count = 0;
    }
  }
}

function handleRefresh(config: LeukoConfig, logger: PluginLogger): () => Promise<{ text: string }> {
  return async () => {
    const { results, meta } = await runAllChecks(config, logger);
    writeCognitiveResults(config.statusPath, { cognitive_checks: results, cognitive_meta: meta }, logger);
    const overall = computeOverallSeverity(results);
    return { text: `⚕️ Leuko L2 refresh complete: ${overall.toUpperCase()} — ${results.length} checks (${meta.total_duration_ms}ms, ${meta.total_tokens} tokens)` };
  };
}

function handleDetail(config: LeukoConfig, logger: PluginLogger): () => { text: string } {
  return () => {
    const status = readStatusFile(config.statusPath, logger);
    if (!status?.cognitive_checks) return { text: "⚕️ No cognitive check results available. Run `/leuko refresh` first." };
    const lines = status.cognitive_checks.map(
      (c) => `${c.severity === "ok" ? "✅" : c.severity === "warn" ? "⚠️" : "🔴"} ${c.check_name}: ${c.detail}`,
    );
    return { text: `⚕️ Leuko L2 Detail:\n${lines.join("\n")}` };
  };
}

function handleConfig(config: LeukoConfig): () => { text: string } {
  return () => ({
    text: `⚕️ Leuko Config:\n- Status: ${config.statusPath}\n- Interval: ${config.intervalMinutes}min\n- Model: ${config.llm.primary.provider}/${config.llm.primary.model}\n- Checks: ${Object.entries(config.checks).filter(([, v]) => v.enabled).map(([k]) => k).join(", ")}`,
  });
}

function handleDefault(config: LeukoConfig, logger: PluginLogger): () => { text: string } {
  return () => {
    const status = readStatusFile(config.statusPath, logger);
    if (!status) return { text: "⚕️ Leuko status file not available." };
    const summary = buildHealthSummary(status, config.healthInjection.maxLength);
    return { text: summary ? `⚕️ Leuko Health: ${summary}` : "⚕️ Leuko Health: All systems OK ✅" };
  };
}

const plugin = {
  id: "openclaw-leuko",
  name: "Leuko Health System",
  description: "Cognitive immune system — L2 semantic health checks, tool exposure, and Sitrep replacement",
  version: PLUGIN_VERSION,

  register(api: PluginApi): void {
    const { config, source, filePath } = loadConfig(api.pluginConfig, api.logger);
    api.logger.info(`[leuko] Config loaded (source=${source}${filePath ? `, path=${filePath}` : ""})`);
    if (!config.enabled) { api.logger.info("[leuko] Disabled via config"); return; }

    registerLeukoTool(api, config);

    api.registerCommand({
      name: "leuko",
      description: "Show system health summary from Leuko",
      handler: async (args?: Record<string, unknown>) => {
        const sub = typeof args?.["_"] === "string" ? args["_"] : "";
        if (sub === "refresh") return handleRefresh(config, api.logger)();
        if (sub === "detail") return handleDetail(config, api.logger)();
        if (sub === "config") return handleConfig(config)();
        return handleDefault(config, api.logger)();
      },
    });

    if (config.healthInjection.enabled) {
      api.on("before_agent_start", () => {
        const status = readStatusFile(config.statusPath, api.logger);
        if (!status) return undefined;
        const summary = buildHealthSummary(status, config.healthInjection.maxLength);
        if (!summary && config.healthInjection.onlyOnIssues) return undefined;
        return { prependContext: `⚕️ Leuko Health: ${summary || "All systems OK"}` };
      });
    }

    const enabledChecks = Object.values(config.checks).filter((c) => c.enabled).length;
    api.logger.info(`[leuko] Registered (${enabledChecks} checks enabled)`);
  },
};

export default plugin;
export { runAllChecks, buildHealthSummary, computeOverallSeverity };
