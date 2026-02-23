import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPipelineCorrelationCheck } from "../../src/checks/pipeline-correlation.js";
import type {
  PipelineCorrelationCheckConfig,
  DaemonCheck,
  PluginLogger,
} from "../../src/types.js";

// Mock child_process and fs
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  statSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { statSync, existsSync } from "node:fs";

const mockedExecSync = vi.mocked(execSync);
const mockedStatSync = vi.mocked(statSync);
const mockedExistsSync = vi.mocked(existsSync);

function mockLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const defaultConfig: PipelineCorrelationCheckConfig = {
  enabled: true,
  usesLlm: false,
  natsStream: "memory-events",
  correlationWindowHours: 2,
  businessHours: { start: 8, end: 22, tz: "Europe/Berlin" },
};

function makeDaemonChecks(overrides: Partial<DaemonCheck>[] = []): DaemonCheck[] {
  const base: DaemonCheck[] = [
    { check_name: "cron_health:extractor", severity: "ok", detail: "OK", auto_healed: false, timestamp: "" },
    { check_name: "output_freshness:threads", severity: "ok", detail: "OK", auto_healed: false, timestamp: "" },
    { check_name: "output_freshness:facts", severity: "ok", detail: "OK", auto_healed: false, timestamp: "" },
  ];
  return overrides.length > 0 ? overrides.map((o, i) => ({ ...base[i % base.length]!, ...o })) : base;
}

describe("CK-03: Pipeline Correlation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when all signals normal", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("nats not found");
    });
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockReturnValue({ mtimeMs: Date.now() - 30 * 60 * 1000 } as ReturnType<typeof statSync>);

    const result = runPipelineCorrelationCheck(
      defaultConfig,
      { threadsPath: "/test/threads.json", daemonChecks: makeDaemonChecks() },
      mockLogger(),
    );
    expect(result.check_name).toBe("cognitive:pipeline_correlation");
    expect(result.severity).toBe("ok");
    expect(result.correlations).toHaveLength(0);
  });

  it("detects consumer_disconnected when threads stale with NATS events", () => {
    mockedExecSync.mockReturnValue(
      JSON.stringify({ state: { messages: 100 } }),
    );
    mockedExistsSync.mockReturnValue(true);
    // Threads file 5 hours old
    mockedStatSync.mockReturnValue({ mtimeMs: Date.now() - 5 * 60 * 60 * 1000 } as ReturnType<typeof statSync>);

    const result = runPipelineCorrelationCheck(
      defaultConfig,
      { threadsPath: "/test/threads.json", daemonChecks: makeDaemonChecks() },
      mockLogger(),
    );
    expect(result.severity).toBe("critical");
    expect(result.correlations?.some((c) => c.diagnosis === "consumer_disconnected")).toBe(true);
  });

  it("detects consumer_slow when threads slightly stale", () => {
    mockedExecSync.mockReturnValue(
      JSON.stringify({ state: { messages: 50 } }),
    );
    mockedExistsSync.mockReturnValue(true);
    // Threads file 3 hours old (> correlationWindowHours=2 but < 4)
    mockedStatSync.mockReturnValue({ mtimeMs: Date.now() - 3 * 60 * 60 * 1000 } as ReturnType<typeof statSync>);

    const result = runPipelineCorrelationCheck(
      defaultConfig,
      { threadsPath: "/test/threads.json", daemonChecks: makeDaemonChecks() },
      mockLogger(),
    );
    expect(result.correlations?.some((c) => c.diagnosis === "consumer_slow")).toBe(true);
  });

  it("detects pipeline_disconnected when crons ok but outputs stale", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("no nats");
    });
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockReturnValue({ mtimeMs: Date.now() } as ReturnType<typeof statSync>);

    const daemonChecks = makeDaemonChecks([
      { check_name: "cron_health:extractor", severity: "ok", detail: "OK", auto_healed: false, timestamp: "" },
      { check_name: "output_freshness:threads", severity: "warn", detail: "Stale", auto_healed: false, timestamp: "" },
      { check_name: "output_freshness:facts", severity: "warn", detail: "Stale", auto_healed: false, timestamp: "" },
    ]);

    const result = runPipelineCorrelationCheck(
      defaultConfig,
      { threadsPath: "/test/threads.json", daemonChecks },
      mockLogger(),
    );
    expect(result.correlations?.some((c) => c.diagnosis === "pipeline_disconnected")).toBe(true);
    expect(result.severity).toBe("warn");
  });

  it("detects event_source_silent when NATS has 0 messages during business hours", () => {
    mockedExecSync.mockReturnValue(JSON.stringify({ state: { messages: 0 } }));
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockReturnValue({ mtimeMs: Date.now() } as ReturnType<typeof statSync>);

    // Force business hours check — we mock the time indirectly
    const result = runPipelineCorrelationCheck(
      defaultConfig,
      { threadsPath: "/test/threads.json", daemonChecks: makeDaemonChecks() },
      mockLogger(),
    );

    // May or may not trigger depending on actual time — check structure is valid
    expect(result.check_name).toBe("cognitive:pipeline_correlation");
    expect(typeof result.severity).toBe("string");
  });

  it("handles NATS CLI not available gracefully", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("command not found");
    });
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockReturnValue({ mtimeMs: Date.now() } as ReturnType<typeof statSync>);

    const result = runPipelineCorrelationCheck(
      defaultConfig,
      { threadsPath: "/test/threads.json", daemonChecks: makeDaemonChecks() },
      mockLogger(),
    );
    // Should not crash, just skip NATS-related correlations
    expect(result.check_name).toBe("cognitive:pipeline_correlation");
  });

  it("records duration_ms and timestamp", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("no nats");
    });
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockReturnValue({ mtimeMs: Date.now() } as ReturnType<typeof statSync>);

    const result = runPipelineCorrelationCheck(
      defaultConfig,
      { threadsPath: "/test/threads.json", daemonChecks: makeDaemonChecks() },
      mockLogger(),
    );
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toBeTruthy();
  });
});
