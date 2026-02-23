import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type {
  LeukoConfig,
  LlmConfig,
  ChecksConfig,
  AdoptedCollectorsConfig,
  HealthInjectionConfig,
  PluginLogger,
  CustomCollectorEntry,
} from "./types.js";
import { isRecord } from "./check-utils.js";

// ============================================================
// Defaults
// ============================================================

const home = process.env["HOME"] ?? "/tmp";

export const DEFAULTS: LeukoConfig = {
  enabled: true,
  statusPath: join(home, "clawd/memory/leuko-status.json"),
  historyPath: join(home, "clawd/memory/leuko-history.json"),
  intervalMinutes: 120,
  runTimeoutSec: 120,
  llm: {
    primary: {
      provider: "ollama",
      model: "qwen3:14b",
      baseUrl: "http://localhost:11434",
      timeoutSec: 30,
    },
    fallback: {
      provider: "litellm",
      model: "gemini/gemini-2.0-flash-lite",
      baseUrl: "http://localhost:4000",
      timeoutSec: 30,
      maxCostUsd: 0.05,
    },
  },
  checks: {
    goal_quality: {
      enabled: true,
      inputPath: join(home, ".cortex/pending-goals.json"),
      usesLlm: true,
    },
    thread_health: {
      enabled: true,
      inputPath: join(home, "clawd/memory/reboot/threads.json"),
      usesLlm: true,
      staleDays: 5,
    },
    pipeline_correlation: {
      enabled: true,
      usesLlm: false,
      natsStream: "memory-events",
      correlationWindowHours: 2,
      businessHours: { start: 8, end: 22, tz: "Europe/Berlin" },
    },
    anomaly_detection: {
      enabled: true,
      usesLlm: false,
      monitoredDirs: [
        { path: join(home, "clawd/memory/"), label: "memory" },
        { path: join(home, ".membrane/"), label: "membrane" },
        { path: join(home, ".lancedb/"), label: "lancedb" },
      ],
    },
    bootstrap_integrity: {
      enabled: true,
      inputPath: join(home, "clawd/BOOTSTRAP.md"),
      usesLlm: true,
    },
    recommendations: {
      enabled: true,
      usesLlm: true,
      maxRecommendations: 5,
    },
  },
  adoptedCollectors: {
    errors: {
      enabled: false,
      patternsPath: "",
      recentHours: 24,
    },
    custom: [],
  },
  healthInjection: {
    enabled: true,
    onlyOnIssues: true,
    maxLength: 200,
  },
};

// ============================================================
// Helpers
// ============================================================

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  return fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function rec(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

// ============================================================
// Resolve Config
// ============================================================

function resolveLlmConfig(raw: Record<string, unknown>): LlmConfig {
  const p = rec(raw["primary"]);
  const f = rec(raw["fallback"]);
  return {
    primary: {
      provider: str(p["provider"], DEFAULTS.llm.primary.provider),
      model: str(p["model"], DEFAULTS.llm.primary.model),
      baseUrl: str(p["baseUrl"], DEFAULTS.llm.primary.baseUrl),
      timeoutSec: int(p["timeoutSec"], DEFAULTS.llm.primary.timeoutSec),
      apiKey: typeof p["apiKey"] === "string" ? p["apiKey"] : undefined,
    },
    fallback: {
      provider: str(f["provider"], DEFAULTS.llm.fallback.provider),
      model: str(f["model"], DEFAULTS.llm.fallback.model),
      baseUrl: str(f["baseUrl"], DEFAULTS.llm.fallback.baseUrl),
      timeoutSec: int(f["timeoutSec"], DEFAULTS.llm.fallback.timeoutSec),
      apiKey: typeof f["apiKey"] === "string" ? f["apiKey"] : undefined,
      maxCostUsd: typeof f["maxCostUsd"] === "number" ? f["maxCostUsd"] : DEFAULTS.llm.fallback.maxCostUsd,
    },
  };
}

function resolveMonitoredDirs(ad: Record<string, unknown>): ChecksConfig["anomaly_detection"]["monitoredDirs"] {
  if (!Array.isArray(ad["monitoredDirs"])) return [...DEFAULTS.checks.anomaly_detection.monitoredDirs];
  return (ad["monitoredDirs"] as unknown[]).filter(
    (d): d is { path: string; label: string } =>
      typeof d === "object" && d !== null &&
      typeof (d as Record<string, unknown>)["path"] === "string" &&
      typeof (d as Record<string, unknown>)["label"] === "string",
  );
}

function resolvePipelineCorrelation(pc: Record<string, unknown>): ChecksConfig["pipeline_correlation"] {
  const bh = rec(pc["businessHours"]);
  const def = DEFAULTS.checks.pipeline_correlation;
  return {
    enabled: bool(pc["enabled"], def.enabled),
    usesLlm: bool(pc["usesLlm"], def.usesLlm),
    natsStream: str(pc["natsStream"], def.natsStream),
    correlationWindowHours: int(pc["correlationWindowHours"], def.correlationWindowHours),
    businessHours: {
      start: int(bh["start"], def.businessHours.start),
      end: int(bh["end"], def.businessHours.end),
      tz: str(bh["tz"], def.businessHours.tz),
    },
  };
}

function resolveChecksConfig(raw: Record<string, unknown>): ChecksConfig {
  const gq = rec(raw["goal_quality"]);
  const th = rec(raw["thread_health"]);
  const ad = rec(raw["anomaly_detection"]);
  const bi = rec(raw["bootstrap_integrity"]);
  const rm = rec(raw["recommendations"]);

  return {
    goal_quality: {
      enabled: bool(gq["enabled"], DEFAULTS.checks.goal_quality.enabled),
      inputPath: str(gq["inputPath"], DEFAULTS.checks.goal_quality.inputPath),
      usesLlm: bool(gq["usesLlm"], DEFAULTS.checks.goal_quality.usesLlm),
    },
    thread_health: {
      enabled: bool(th["enabled"], DEFAULTS.checks.thread_health.enabled),
      inputPath: str(th["inputPath"], DEFAULTS.checks.thread_health.inputPath),
      usesLlm: bool(th["usesLlm"], DEFAULTS.checks.thread_health.usesLlm),
      staleDays: int(th["staleDays"], DEFAULTS.checks.thread_health.staleDays),
    },
    pipeline_correlation: resolvePipelineCorrelation(rec(raw["pipeline_correlation"])),
    anomaly_detection: {
      enabled: bool(ad["enabled"], DEFAULTS.checks.anomaly_detection.enabled),
      usesLlm: bool(ad["usesLlm"], DEFAULTS.checks.anomaly_detection.usesLlm),
      monitoredDirs: resolveMonitoredDirs(ad),
    },
    bootstrap_integrity: {
      enabled: bool(bi["enabled"], DEFAULTS.checks.bootstrap_integrity.enabled),
      inputPath: str(bi["inputPath"], DEFAULTS.checks.bootstrap_integrity.inputPath),
      usesLlm: bool(bi["usesLlm"], DEFAULTS.checks.bootstrap_integrity.usesLlm),
    },
    recommendations: {
      enabled: bool(rm["enabled"], DEFAULTS.checks.recommendations.enabled),
      usesLlm: bool(rm["usesLlm"], DEFAULTS.checks.recommendations.usesLlm),
      maxRecommendations: int(rm["maxRecommendations"], DEFAULTS.checks.recommendations.maxRecommendations),
    },
  };
}

function resolveCollectorsConfig(raw: Record<string, unknown>): AdoptedCollectorsConfig {
  const er = rec(raw["errors"]);
  const customRaw = Array.isArray(raw["custom"]) ? (raw["custom"] as unknown[]) : [];

  const custom: CustomCollectorEntry[] = customRaw
    .filter(
      (c): c is Record<string, unknown> =>
        typeof c === "object" && c !== null,
    )
    .map((c) => ({
      name: str(c["name"], "unnamed"),
      command: str(c["command"], ""),
      warnThreshold:
        typeof c["warnThreshold"] === "number" ? c["warnThreshold"] : undefined,
      criticalThreshold:
        typeof c["criticalThreshold"] === "number" ? c["criticalThreshold"] : undefined,
    }))
    .filter((c) => c.command.length > 0);

  return {
    errors: {
      enabled: bool(er["enabled"], DEFAULTS.adoptedCollectors.errors.enabled),
      patternsPath: str(er["patternsPath"], DEFAULTS.adoptedCollectors.errors.patternsPath),
      recentHours: int(er["recentHours"], DEFAULTS.adoptedCollectors.errors.recentHours),
    },
    custom,
  };
}

function resolveHealthInjection(raw: Record<string, unknown>): HealthInjectionConfig {
  return {
    enabled: bool(raw["enabled"], DEFAULTS.healthInjection.enabled),
    onlyOnIssues: bool(raw["onlyOnIssues"], DEFAULTS.healthInjection.onlyOnIssues),
    maxLength: int(raw["maxLength"], DEFAULTS.healthInjection.maxLength),
  };
}

export function resolveConfig(pluginConfig?: Record<string, unknown>): LeukoConfig {
  const raw = pluginConfig ?? {};
  return {
    enabled: bool(raw["enabled"], DEFAULTS.enabled),
    statusPath: str(raw["statusPath"], DEFAULTS.statusPath),
    historyPath: str(raw["historyPath"], DEFAULTS.historyPath),
    intervalMinutes: int(raw["intervalMinutes"], DEFAULTS.intervalMinutes),
    runTimeoutSec: int(raw["runTimeoutSec"], DEFAULTS.runTimeoutSec),
    llm: resolveLlmConfig(rec(raw["llm"])),
    checks: resolveChecksConfig(rec(raw["checks"])),
    adoptedCollectors: resolveCollectorsConfig(rec(raw["adoptedCollectors"])),
    healthInjection: resolveHealthInjection(rec(raw["healthInjection"])),
  };
}

// ============================================================
// External Config Loader (same pattern as cortex)
// ============================================================

const DEFAULT_CONFIG_DIR = join(
  home,
  ".openclaw",
  "plugins",
  "openclaw-leuko",
);
const DEFAULT_CONFIG_FILENAME = "config.json";

function isLegacyInlineConfig(raw: Record<string, unknown>): boolean {
  const inlineOnlyKeys = new Set(["enabled", "configPath"]);
  return Object.keys(raw).some((k) => !inlineOnlyKeys.has(k));
}

function readJsonFile(
  path: string,
  logger: PluginLogger,
): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf-8");
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) {
      logger.warn(`[leuko] Config file is not an object: ${path}`);
      return null;
    }
    return parsed;
  } catch (e) {
    logger.warn(
      `[leuko] Failed to read config file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

function applyInlineOverrides(
  fileConfig: Record<string, unknown>,
  inline: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof inline["enabled"] === "boolean") {
    return { ...fileConfig, enabled: inline["enabled"] };
  }
  return fileConfig;
}

function bootstrapConfig(
  path: string,
  logger: PluginLogger,
): Record<string, unknown> | null {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf-8");
    logger.info(`[leuko] Created default config at ${path}`);
    return readJsonFile(path, logger);
  } catch (e) {
    logger.warn(
      `[leuko] Failed to write default config: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

export interface ConfigLoadResult {
  readonly config: LeukoConfig;
  readonly source: "inline" | "file" | "defaults";
  readonly filePath?: string;
}

export function loadConfig(
  pluginConfig: Record<string, unknown> | undefined,
  logger: PluginLogger,
): ConfigLoadResult {
  const raw = pluginConfig ?? {};

  // Priority 1: Legacy inline config
  if (isLegacyInlineConfig(raw)) {
    logger.info("[leuko] Using inline config from openclaw.json");
    return { config: resolveConfig(raw), source: "inline" };
  }

  // Priority 2: External config file
  const configPath =
    typeof raw["configPath"] === "string"
      ? raw["configPath"]
      : join(DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILENAME);

  const fileConfig = readJsonFile(configPath, logger);
  if (fileConfig !== null) {
    const merged = applyInlineOverrides(fileConfig, raw);
    logger.info(`[leuko] Loaded config from ${configPath}`);
    return { config: resolveConfig(merged), source: "file", filePath: configPath };
  }

  // File missing → bootstrap
  if (!existsSync(configPath)) {
    const bootstrapped = bootstrapConfig(configPath, logger);
    if (bootstrapped !== null) {
      const merged = applyInlineOverrides(bootstrapped, raw);
      return { config: resolveConfig(merged), source: "file", filePath: configPath };
    }
  }

  // Priority 3: Graceful defaults
  logger.warn("[leuko] Falling back to default config");
  return { config: resolveConfig(undefined), source: "defaults" };
}
