import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveConfig, loadConfig, DEFAULTS } from "../src/config.js";
import type { PluginLogger } from "../src/types.js";

function mockLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("resolveConfig", () => {
  it("returns defaults when called with undefined", () => {
    const config = resolveConfig(undefined);
    expect(config.enabled).toBe(true);
    expect(config.intervalMinutes).toBe(120);
    expect(config.runTimeoutSec).toBe(120);
    expect(config.llm.primary.model).toBe("qwen3:14b");
    expect(config.checks.goal_quality.enabled).toBe(true);
    expect(config.checks.pipeline_correlation.usesLlm).toBe(false);
    expect(config.checks.anomaly_detection.usesLlm).toBe(false);
  });

  it("returns defaults when called with empty object", () => {
    const config = resolveConfig({});
    expect(config.enabled).toBe(true);
    expect(config.llm.primary.provider).toBe("ollama");
  });

  it("overrides top-level fields", () => {
    const config = resolveConfig({
      enabled: false,
      intervalMinutes: 60,
      runTimeoutSec: 30,
    });
    expect(config.enabled).toBe(false);
    expect(config.intervalMinutes).toBe(60);
    expect(config.runTimeoutSec).toBe(30);
  });

  it("overrides LLM config", () => {
    const config = resolveConfig({
      llm: {
        primary: { provider: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com", timeoutSec: 60 },
        fallback: { provider: "ollama", model: "llama3:8b", baseUrl: "http://localhost:11434", timeoutSec: 15 },
      },
    });
    expect(config.llm.primary.provider).toBe("openai");
    expect(config.llm.primary.model).toBe("gpt-4o");
    expect(config.llm.fallback.model).toBe("llama3:8b");
  });

  it("overrides individual check configs", () => {
    const config = resolveConfig({
      checks: {
        goal_quality: { enabled: false, inputPath: "/custom/path.json", usesLlm: false },
        thread_health: { staleDays: 10 },
      },
    });
    expect(config.checks.goal_quality.enabled).toBe(false);
    expect(config.checks.goal_quality.inputPath).toBe("/custom/path.json");
    expect(config.checks.thread_health.staleDays).toBe(10);
    // Unset checks get defaults
    expect(config.checks.pipeline_correlation.enabled).toBe(true);
  });

  it("handles monitored dirs override", () => {
    const config = resolveConfig({
      checks: {
        anomaly_detection: {
          monitoredDirs: [{ path: "/data", label: "data" }],
        },
      },
    });
    expect(config.checks.anomaly_detection.monitoredDirs).toHaveLength(1);
    expect(config.checks.anomaly_detection.monitoredDirs[0]?.path).toBe("/data");
  });

  it("handles invalid monitored dirs gracefully", () => {
    const config = resolveConfig({
      checks: {
        anomaly_detection: {
          monitoredDirs: [42, null, { path: "/ok", label: "ok" }, { bad: true }],
        },
      },
    });
    expect(config.checks.anomaly_detection.monitoredDirs).toHaveLength(1);
  });

  it("overrides adopted collectors config", () => {
    const config = resolveConfig({
      adoptedCollectors: {
        errors: { enabled: true, patternsPath: "/errors.json", recentHours: 48 },
        custom: [{ name: "disk", command: "df -h", warnThreshold: 80 }],
      },
    });
    expect(config.adoptedCollectors.errors.enabled).toBe(true);
    expect(config.adoptedCollectors.errors.recentHours).toBe(48);
    expect(config.adoptedCollectors.custom).toHaveLength(1);
    expect(config.adoptedCollectors.custom[0]?.name).toBe("disk");
  });

  it("filters out custom collectors without command", () => {
    const config = resolveConfig({
      adoptedCollectors: {
        custom: [
          { name: "valid", command: "echo ok" },
          { name: "empty", command: "" },
          { name: "nocmd" },
        ],
      },
    });
    expect(config.adoptedCollectors.custom).toHaveLength(1);
  });

  it("overrides health injection config", () => {
    const config = resolveConfig({
      healthInjection: { enabled: false, onlyOnIssues: false, maxLength: 500 },
    });
    expect(config.healthInjection.enabled).toBe(false);
    expect(config.healthInjection.maxLength).toBe(500);
  });

  it("handles non-numeric/boolean values gracefully", () => {
    const config = resolveConfig({
      enabled: "yes" as unknown,
      intervalMinutes: "two hours" as unknown,
    });
    expect(config.enabled).toBe(true); // fallback to default
    expect(config.intervalMinutes).toBe(120); // fallback to default
  });
});

describe("loadConfig", () => {
  it("returns defaults with inline-only keys", () => {
    const logger = mockLogger();
    const result = loadConfig({ enabled: true }, logger);
    expect(result.source).toBe("file"); // Will attempt file, may bootstrap or fallback
    expect(result.config.enabled).toBe(true);
  });

  it("detects legacy inline config", () => {
    const logger = mockLogger();
    const result = loadConfig(
      { enabled: true, intervalMinutes: 60, statusPath: "/custom" },
      logger,
    );
    expect(result.source).toBe("inline");
    expect(result.config.intervalMinutes).toBe(60);
  });

  it("returns defaults when pluginConfig is undefined", () => {
    const logger = mockLogger();
    const result = loadConfig(undefined, logger);
    expect(result.config.enabled).toBe(true);
  });
});
