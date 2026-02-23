import { describe, it, expect, vi, beforeEach } from "vitest";
import { readStatusFile, readHistoryFile, readJsonInput, readTextInput } from "../src/status-reader.js";
import type { PluginLogger } from "../src/types.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

import { readFileSync, existsSync } from "node:fs";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);

function mockLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("readStatusFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(readStatusFile("/test/missing.json")).toBeNull();
  });

  it("parses a valid status file", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      last_check: "2026-02-23T17:00:00",
      overall_severity: "warn",
      daemon_checks: [
        { check_name: "service_health:nats", severity: "ok", detail: "OK", auto_healed: false, timestamp: "2026-02-23T17:00:00" },
        { check_name: "output_freshness:facts", severity: "warn", detail: "Stale", auto_healed: false, timestamp: "2026-02-23T17:00:00" },
      ],
      cognitive_checks: [
        { check_name: "cognitive:goal_quality", severity: "ok", detail: "Fine", duration_ms: 100, timestamp: "2026-02-23T16:00:00" },
      ],
      cognitive_meta: {
        last_run: "2026-02-23T16:00:00Z",
        total_duration_ms: 5000,
        total_tokens: 1000,
        total_cost_usd: 0,
        model: "ollama/qwen3:14b",
        checks_completed: 6,
        checks_failed: 0,
        plugin_version: "0.1.0",
      },
    }));

    const result = readStatusFile("/test/status.json");
    expect(result).not.toBeNull();
    expect(result?.last_check).toBe("2026-02-23T17:00:00");
    expect(result?.overall_severity).toBe("warn");
    expect(result?.daemon_checks).toHaveLength(2);
    expect(result?.cognitive_checks).toHaveLength(1);
    expect(result?.cognitive_meta?.model).toBe("ollama/qwen3:14b");
  });

  it("handles malformed JSON", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("not json");
    const logger = mockLogger();
    expect(readStatusFile("/test/bad.json", logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("handles non-object JSON", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('"just a string"');
    const logger = mockLogger();
    expect(readStatusFile("/test/string.json", logger)).toBeNull();
  });

  it("parses severity values safely", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      last_check: "",
      overall_severity: "invalid",
      daemon_checks: [
        { check_name: "test", severity: "unknown_value", detail: "", auto_healed: false, timestamp: "" },
      ],
    }));
    const result = readStatusFile("/test/status.json");
    expect(result?.overall_severity).toBe("ok"); // Falls back to ok
    expect(result?.daemon_checks[0]?.severity).toBe("ok");
  });

  it("preserves auto_heal_history", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      last_check: "",
      overall_severity: "ok",
      daemon_checks: [],
      auto_heal_history: [{ action: "restart", timestamp: "2026-02-23T12:00:00" }],
    }));
    const result = readStatusFile("/test/status.json");
    expect(result?.auto_heal_history).toHaveLength(1);
  });
});

describe("readHistoryFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when file missing", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(readHistoryFile("/test/missing.json")).toBeNull();
  });

  it("parses history snapshots", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      snapshots: [
        { timestamp: "2026-02-23T12:00:00Z", metrics: { fact_count: 100, goal_count: 9 } },
        { timestamp: "2026-02-23T14:00:00Z", metrics: { fact_count: 102, goal_count: 9 } },
      ],
    }));
    const result = readHistoryFile("/test/history.json");
    expect(result?.snapshots).toHaveLength(2);
    expect(result?.snapshots[0]?.metrics["fact_count"]).toBe(100);
  });

  it("handles malformed history", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("[]");
    expect(readHistoryFile("/test/bad.json")).toBeNull();
  });
});

describe("readJsonInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when file missing", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(readJsonInput("/test/missing.json")).toBeNull();
  });

  it("parses JSON input", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ goals: [{ id: "g1" }] }));
    const result = readJsonInput<{ goals: Array<{ id: string }> }>("/test/goals.json");
    expect(result?.goals).toHaveLength(1);
  });
});

describe("readTextInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when file missing", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(readTextInput("/test/missing.md")).toBeNull();
  });

  it("returns text content", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("# Hello World\nSome content");
    expect(readTextInput("/test/file.md")).toBe("# Hello World\nSome content");
  });

  it("truncates to maxChars", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("A".repeat(10000));
    const result = readTextInput("/test/file.md", 100);
    expect(result?.length).toBe(100);
  });
});
