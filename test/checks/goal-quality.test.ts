import { describe, it, expect, vi, beforeEach } from "vitest";
import { runGoalQualityCheck } from "../../src/checks/goal-quality.js";
import type {
  GoalQualityCheckConfig,
  LlmClient,
  LlmResponse,
  PluginLogger,
} from "../../src/types.js";

// Mock the status-reader module
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
      content: JSON.stringify({ severity: "ok", detail: "All good", findings: [] }),
      model: "test/model",
      tokens: 100,
      durationMs: 500,
      ...response,
    }),
  };
}

const defaultConfig: GoalQualityCheckConfig = {
  enabled: true,
  inputPath: "/test/goals.json",
  usesLlm: true,
};

describe("CK-01: Goal Quality Assessment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when goals file is not found", async () => {
    mockedReadJsonInput.mockReturnValue(null);
    const result = await runGoalQualityCheck(defaultConfig, mockLlm(), mockLogger());
    expect(result.check_name).toBe("cognitive:goal_quality");
    expect(result.severity).toBe("ok");
    expect(result.detail).toContain("not found");
  });

  it("returns ok when no goals exist", async () => {
    mockedReadJsonInput.mockReturnValue({ goals: [] });
    const result = await runGoalQualityCheck(defaultConfig, mockLlm(), mockLogger());
    expect(result.severity).toBe("ok");
    expect(result.detail).toContain("No pending goals");
  });

  it("calls LLM with goal data", async () => {
    const goals = [
      { id: "g1", title: "Fix auth bug", proposed_action: "Debug OAuth flow", status: "approved" },
    ];
    mockedReadJsonInput.mockReturnValue({ goals });
    const llm = mockLlm();
    await runGoalQualityCheck(defaultConfig, llm, mockLogger());
    expect(llm.generate).toHaveBeenCalledOnce();
  });

  it("returns LLM severity when available", async () => {
    mockedReadJsonInput.mockReturnValue({
      goals: [{ id: "g1", title: "Vague goal", status: "approved" }],
    });
    const llm = mockLlm({
      content: JSON.stringify({
        severity: "warn",
        detail: "1/1 goals are vague",
        findings: [{ item_id: "g1", issue: "vague_title", detail: "Too vague", recommendation: "Be specific" }],
      }),
    });
    const result = await runGoalQualityCheck(defaultConfig, llm, mockLogger());
    expect(result.severity).toBe("warn");
    expect(result.findings).toHaveLength(1);
  });

  it("pre-filters expired goals", async () => {
    const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    mockedReadJsonInput.mockReturnValue({
      goals: [{ id: "g1", title: "Old goal", expires: pastDate }],
    });
    const llm = mockLlm({
      content: JSON.stringify({ severity: "ok", detail: "Fine", findings: [] }),
    });
    const result = await runGoalQualityCheck(defaultConfig, llm, mockLogger());
    // Pre-filter should flag expired goal → at least warn
    expect(result.severity).toBe("warn");
    expect(result.findings?.some((f) => f.issue === "expired")).toBe(true);
  });

  it("pre-filters stale proposals (>48h)", async () => {
    const oldDate = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    mockedReadJsonInput.mockReturnValue({
      goals: [{ id: "g1", title: "Stale proposal", proposed_at: oldDate, status: "proposed" }],
    });
    const llm = mockLlm();
    const result = await runGoalQualityCheck(defaultConfig, llm, mockLogger());
    expect(result.findings?.some((f) => f.issue === "stale_proposal")).toBe(true);
  });

  it("fails open when LLM returns null", async () => {
    mockedReadJsonInput.mockReturnValue({
      goals: [{ id: "g1", title: "Some goal" }],
    });
    const llm = mockLlm({ content: null, error: "Connection refused" });
    const result = await runGoalQualityCheck(defaultConfig, llm, mockLogger());
    expect(result.detail).toContain("LLM unavailable");
    // Should not be critical — fail-open
    expect(result.severity).not.toBe("critical");
  });

  it("fails open when LLM returns invalid JSON", async () => {
    mockedReadJsonInput.mockReturnValue({
      goals: [{ id: "g1", title: "Some goal" }],
    });
    const llm = mockLlm({ content: "not json at all" });
    const result = await runGoalQualityCheck(defaultConfig, llm, mockLogger());
    expect(result.detail).toContain("parsing failed");
  });

  it("deduplicates pre-filter and LLM findings by item_id", async () => {
    const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    mockedReadJsonInput.mockReturnValue({
      goals: [{ id: "g1", title: "Expired goal", expires: pastDate }],
    });
    const llm = mockLlm({
      content: JSON.stringify({
        severity: "warn",
        detail: "Issues found",
        findings: [
          { item_id: "g1", issue: "expired", detail: "Expired", recommendation: "Remove" },
          { item_id: "g2", issue: "vague_title", detail: "Vague", recommendation: "Fix" },
        ],
      }),
    });
    const result = await runGoalQualityCheck(defaultConfig, llm, mockLogger());
    // g1 from pre-filter + g2 from LLM (g1 from LLM deduplicated)
    const ids = result.findings?.map((f) => f.item_id);
    expect(ids?.filter((id) => id === "g1")).toHaveLength(1);
    expect(ids).toContain("g2");
  });

  it("handles array-format goals", async () => {
    mockedReadJsonInput.mockReturnValue([
      { id: "g1", title: "Goal 1" },
      { id: "g2", title: "Goal 2" },
    ]);
    const llm = mockLlm();
    const result = await runGoalQualityCheck(defaultConfig, llm, mockLogger());
    expect(llm.generate).toHaveBeenCalledOnce();
  });

  it("records duration_ms", async () => {
    mockedReadJsonInput.mockReturnValue({ goals: [] });
    const result = await runGoalQualityCheck(defaultConfig, mockLlm(), mockLogger());
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toBeTruthy();
  });
});
