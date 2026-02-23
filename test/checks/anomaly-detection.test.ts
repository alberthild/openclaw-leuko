import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAnomalyDetectionCheck } from "../../src/checks/anomaly-detection.js";
import type {
  AnomalyDetectionCheckConfig,
  LeukoHistory,
  PluginLogger,
} from "../../src/types.js";

vi.mock("node:fs", () => ({
  statSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import { statSync, existsSync, readdirSync } from "node:fs";

const mockedStatSync = vi.mocked(statSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);

function mockLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const defaultConfig: AnomalyDetectionCheckConfig = {
  enabled: true,
  usesLlm: false,
  monitoredDirs: [
    { path: "/test/memory", label: "memory" },
    { path: "/test/membrane", label: "membrane" },
  ],
};

function makeHistory(snapshots: Array<{ timestamp: string; metrics: Record<string, number> }>): LeukoHistory {
  return { snapshots };
}

describe("CK-04: Anomaly Detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok with no history and inaccessible dirs", () => {
    mockedExistsSync.mockReturnValue(false);
    const result = runAnomalyDetectionCheck(defaultConfig, null, mockLogger());
    expect(result.check_name).toBe("cognitive:anomaly_detection");
    expect(result.severity).toBe("ok");
    expect(result.detail).toBe("All metrics within normal range");
  });

  it("records directory sizes in baselines", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([
      { name: "file1.json", isFile: () => true, isDirectory: () => false } as ReturnType<typeof readdirSync>[number],
    ] as ReturnType<typeof readdirSync>);
    mockedStatSync.mockReturnValue({ size: 1024 * 1024 } as ReturnType<typeof statSync>);

    const result = runAnomalyDetectionCheck(defaultConfig, null, mockLogger());
    expect(result.baselines?.["memory_dir_mb"]).toBeGreaterThan(0);
  });

  it("detects 5x directory growth as critical", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([
      { name: "file1.json", isFile: () => true, isDirectory: () => false } as ReturnType<typeof readdirSync>[number],
    ] as ReturnType<typeof readdirSync>);
    // Current size: 500MB
    mockedStatSync.mockReturnValue({ size: 500 * 1024 * 1024 } as ReturnType<typeof statSync>);

    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const history = makeHistory([
      { timestamp: weekAgo, metrics: { memory_dir_mb: 50 } }, // Was 50MB, now 500MB = 10x
    ]);

    const result = runAnomalyDetectionCheck(defaultConfig, history, mockLogger());
    expect(result.severity).toBe("critical");
    expect(result.anomalies?.some((a) => a.metric === "memory_dir_mb")).toBe(true);
  });

  it("detects 2x directory growth as warn", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([
      { name: "file1.json", isFile: () => true, isDirectory: () => false } as ReturnType<typeof readdirSync>[number],
    ] as ReturnType<typeof readdirSync>);
    // Current: 150MB
    mockedStatSync.mockReturnValue({ size: 150 * 1024 * 1024 } as ReturnType<typeof statSync>);

    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const history = makeHistory([
      { timestamp: weekAgo, metrics: { memory_dir_mb: 50 } }, // 50 → 150 = 3x
    ]);

    const result = runAnomalyDetectionCheck(defaultConfig, history, mockLogger());
    expect(result.severity).toBe("warn");
  });

  it("detects consecutive shrinking trend (5+) as critical", () => {
    mockedExistsSync.mockReturnValue(false); // Skip dir checks

    const now = Date.now();
    const history = makeHistory(
      [100, 95, 90, 85, 80, 75].map((v, i) => ({
        timestamp: new Date(now - (6 - i) * 60 * 60 * 1000).toISOString(),
        metrics: { fact_count: v },
      })),
    );

    const result = runAnomalyDetectionCheck(defaultConfig, history, mockLogger());
    expect(result.severity).toBe("critical");
    expect(result.anomalies?.some((a) => a.metric === "fact_count" && a.deviation.includes("data loss"))).toBe(true);
  });

  it("detects consecutive shrinking trend (3-4) as warn", () => {
    mockedExistsSync.mockReturnValue(false);

    const now = Date.now();
    const history = makeHistory(
      [100, 95, 90, 85].map((v, i) => ({
        timestamp: new Date(now - (4 - i) * 60 * 60 * 1000).toISOString(),
        metrics: { goal_count: v },
      })),
    );

    const result = runAnomalyDetectionCheck(defaultConfig, history, mockLogger());
    expect(result.severity).toBe("warn");
  });

  it("returns ok for stable metric trends", () => {
    mockedExistsSync.mockReturnValue(false);

    const now = Date.now();
    const history = makeHistory(
      [100, 102, 101, 103, 100].map((v, i) => ({
        timestamp: new Date(now - (5 - i) * 60 * 60 * 1000).toISOString(),
        metrics: { fact_count: v },
      })),
    );

    const result = runAnomalyDetectionCheck(defaultConfig, history, mockLogger());
    expect(result.severity).toBe("ok");
  });

  it("handles empty history gracefully", () => {
    mockedExistsSync.mockReturnValue(false);
    const result = runAnomalyDetectionCheck(defaultConfig, makeHistory([]), mockLogger());
    expect(result.severity).toBe("ok");
  });

  it("records duration_ms", () => {
    mockedExistsSync.mockReturnValue(false);
    const result = runAnomalyDetectionCheck(defaultConfig, null, mockLogger());
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
