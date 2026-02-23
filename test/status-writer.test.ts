import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeCognitiveResults } from "../src/status-writer.js";
import type { WritePayload, PluginLogger } from "../src/types.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
}));

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedRenameSync = vi.mocked(renameSync);
const mockedExistsSync = vi.mocked(existsSync);

function mockLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makePayload(): WritePayload {
  return {
    cognitive_checks: [
      {
        check_name: "cognitive:goal_quality",
        severity: "ok",
        detail: "All good",
        timestamp: "2026-02-23T17:00:00Z",
        duration_ms: 100,
      },
    ],
    cognitive_meta: {
      last_run: "2026-02-23T17:00:00Z",
      total_duration_ms: 5000,
      total_tokens: 1000,
      total_cost_usd: 0,
      model: "ollama/qwen3:14b",
      checks_completed: 6,
      checks_failed: 0,
      plugin_version: "0.1.0",
    },
  };
}

describe("writeCognitiveResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves daemon_checks from existing file", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      last_check: "2026-02-23T16:45:00",
      overall_severity: "ok",
      daemon_checks: [
        { check_name: "service_health:nats", severity: "ok", detail: "OK" },
      ],
      auto_heal_history: [{ action: "restart" }],
    }));

    const result = writeCognitiveResults("/test/status.json", makePayload(), mockLogger());
    expect(result).toBe(true);

    const writtenContent = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(writtenContent) as Record<string, unknown>;
    expect(parsed["daemon_checks"]).toBeDefined();
    expect((parsed["daemon_checks"] as unknown[]).length).toBe(1);
    expect(parsed["auto_heal_history"]).toBeDefined();
    expect(parsed["cognitive_checks"]).toBeDefined();
    expect(parsed["cognitive_meta"]).toBeDefined();
  });

  it("uses atomic write (tmp file + rename)", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("{}");

    writeCognitiveResults("/test/status.json", makePayload(), mockLogger());

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      "/test/status.json.l2tmp",
      expect.any(String),
      "utf-8",
    );
    expect(mockedRenameSync).toHaveBeenCalledWith(
      "/test/status.json.l2tmp",
      "/test/status.json",
    );
  });

  it("handles missing existing file", () => {
    mockedExistsSync.mockImplementation((p) => {
      // File doesn't exist, but directory does
      if (String(p).endsWith("status.json")) return false;
      return true; // Directory exists
    });

    const result = writeCognitiveResults("/test/status.json", makePayload(), mockLogger());
    expect(result).toBe(true);

    const writtenContent = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(writtenContent) as Record<string, unknown>;
    expect(parsed["cognitive_checks"]).toBeDefined();
  });

  it("includes sitrep_collectors when provided", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("{}");

    const payload = makePayload();
    payload.sitrep_collectors = [
      {
        collector_name: "errors",
        status: "ok",
        items: [],
        summary: "0 errors",
        duration_ms: 10,
        timestamp: "2026-02-23T17:00:00Z",
      },
    ];

    writeCognitiveResults("/test/status.json", payload, mockLogger());

    const writtenContent = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(writtenContent) as Record<string, unknown>;
    expect(parsed["sitrep_collectors"]).toBeDefined();
  });

  it("returns false when directory doesn't exist", () => {
    mockedExistsSync.mockReturnValue(false);
    const logger = mockLogger();
    const result = writeCognitiveResults("/nonexistent/dir/status.json", makePayload(), logger);
    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns false on write error", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("{}");
    mockedWriteFileSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });
    const logger = mockLogger();
    const result = writeCognitiveResults("/test/status.json", makePayload(), logger);
    expect(result).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it("handles malformed existing JSON gracefully", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("not json {{{");

    const logger = mockLogger();
    writeCognitiveResults("/test/status.json", makePayload(), logger);

    // Should still write, just without preserving old fields
    expect(mockedWriteFileSync).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
