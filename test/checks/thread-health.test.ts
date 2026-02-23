import { describe, it, expect, vi, beforeEach } from "vitest";
import { runThreadHealthCheck } from "../../src/checks/thread-health.js";
import type {
  ThreadHealthCheckConfig,
  LlmClient,
  LlmResponse,
  PluginLogger,
} from "../../src/types.js";

vi.mock("../../src/status-reader.js", () => ({
  readJsonInput: vi.fn(),
}));

import { readJsonInput } from "../../src/status-reader.js";

const mockedReadJsonInput = vi.mocked(readJsonInput);

function mockLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function mockLlm(response: Partial<LlmResponse> = {}): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({ severity: "ok", detail: "All threads healthy", findings: [] }),
      model: "test/model",
      tokens: 100,
      durationMs: 500,
      ...response,
    }),
  };
}

const defaultConfig: ThreadHealthCheckConfig = {
  enabled: true,
  inputPath: "/test/threads.json",
  usesLlm: true,
  staleDays: 5,
};

describe("CK-02: Thread Health Assessment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when threads file not found", async () => {
    mockedReadJsonInput.mockReturnValue(null);
    const result = await runThreadHealthCheck(defaultConfig, mockLlm(), mockLogger());
    expect(result.check_name).toBe("cognitive:thread_health");
    expect(result.severity).toBe("ok");
    expect(result.detail).toContain("not found");
  });

  it("returns ok for empty threads", async () => {
    mockedReadJsonInput.mockReturnValue({ threads: [] });
    const result = await runThreadHealthCheck(defaultConfig, mockLlm(), mockLogger());
    expect(result.severity).toBe("ok");
  });

  it("pre-filters stale threads", async () => {
    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    mockedReadJsonInput.mockReturnValue({
      threads: [
        { id: "t1", title: "Stale thread", status: "open", last_activity: staleDate },
      ],
    });
    const llm = mockLlm();
    const result = await runThreadHealthCheck(defaultConfig, llm, mockLogger());
    expect(result.findings?.some((f) => f.issue === "stale")).toBe(true);
    expect(result.severity).toBe("warn");
  });

  it("does not flag closed threads as stale", async () => {
    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    mockedReadJsonInput.mockReturnValue({
      threads: [
        { id: "t1", title: "Closed thread", status: "closed", last_activity: staleDate },
      ],
    });
    const llm = mockLlm();
    const result = await runThreadHealthCheck(defaultConfig, llm, mockLogger());
    // Pre-filter should not flag closed threads
    const preFindings = result.findings?.filter((f) => f.issue === "stale") ?? [];
    expect(preFindings).toHaveLength(0);
  });

  it("does not flag fresh threads", async () => {
    const freshDate = new Date().toISOString();
    mockedReadJsonInput.mockReturnValue({
      threads: [
        { id: "t1", title: "Fresh thread", status: "open", last_activity: freshDate },
      ],
    });
    const llm = mockLlm();
    const result = await runThreadHealthCheck(defaultConfig, llm, mockLogger());
    const staleFindings = result.findings?.filter((f) => f.issue === "stale") ?? [];
    expect(staleFindings).toHaveLength(0);
  });

  it("calls LLM with thread data", async () => {
    mockedReadJsonInput.mockReturnValue({
      threads: [{ id: "t1", title: "Test", status: "open" }],
    });
    const llm = mockLlm();
    await runThreadHealthCheck(defaultConfig, llm, mockLogger());
    expect(llm.generate).toHaveBeenCalledOnce();
  });

  it("handles LLM failure gracefully", async () => {
    mockedReadJsonInput.mockReturnValue({
      threads: [{ id: "t1", title: "Test", status: "open" }],
    });
    const llm = mockLlm({ content: null, error: "Timeout" });
    const result = await runThreadHealthCheck(defaultConfig, llm, mockLogger());
    expect(result.detail).toContain("LLM unavailable");
  });

  it("handles LLM returning critical severity", async () => {
    mockedReadJsonInput.mockReturnValue({
      threads: [
        { id: "t1", title: "Thread A", status: "open" },
        { id: "t2", title: "Thread B", status: "open" },
      ],
    });
    const llm = mockLlm({
      content: JSON.stringify({
        severity: "critical",
        detail: "50% threads stale",
        findings: [
          { thread_id: "t1", issue: "stale", detail: "Very old" },
          { thread_id: "t2", issue: "duplicate", detail: "Same as T1" },
        ],
      }),
    });
    const result = await runThreadHealthCheck(defaultConfig, llm, mockLogger());
    expect(result.severity).toBe("critical");
  });

  it("deduplicates pre-filter and LLM findings", async () => {
    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    mockedReadJsonInput.mockReturnValue({
      threads: [
        { id: "t1", title: "Stale", status: "open", last_activity: staleDate },
      ],
    });
    const llm = mockLlm({
      content: JSON.stringify({
        severity: "warn",
        detail: "1 issue",
        findings: [
          { thread_id: "t1", issue: "stale", detail: "Old" },
          { thread_id: "t2", issue: "incomplete", detail: "No desc" },
        ],
      }),
    });
    const result = await runThreadHealthCheck(defaultConfig, llm, mockLogger());
    const t1Findings = result.findings?.filter((f) => f.thread_id === "t1") ?? [];
    expect(t1Findings).toHaveLength(1); // Deduplicated
  });

  it("records model and token usage", async () => {
    mockedReadJsonInput.mockReturnValue({
      threads: [{ id: "t1", title: "Test", status: "open" }],
    });
    const llm = mockLlm({ tokens: 250 });
    const result = await runThreadHealthCheck(defaultConfig, llm, mockLogger());
    expect(result.model_used).toBe("test/model");
    expect(result.tokens_used).toBe(250);
  });
});
