import { describe, it, expect, vi, beforeEach } from "vitest";
import { runRecommendationsCheck } from "../../src/checks/recommendations.js";
import type {
  RecommendationsCheckConfig,
  LlmClient,
  LlmResponse,
  CognitiveCheckResult,
  LeukoStatus,
  LeukoHistory,
  PluginLogger,
} from "../../src/types.js";

function mockLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function mockLlm(response: Partial<LlmResponse> = {}): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        severity: "ok",
        detail: "2 recommendations generated",
        recommendations: [
          { type: "archive_thread", target: "t1", reason: "Stale 12d", priority: "low" },
          { type: "adjust_config", target: "cron:synthesis", reason: "Repeated failures", priority: "medium" },
        ],
      }),
      model: "test/model",
      tokens: 150,
      durationMs: 800,
      ...response,
    }),
  };
}

const defaultConfig: RecommendationsCheckConfig = {
  enabled: true,
  usesLlm: true,
  maxRecommendations: 5,
};

function makePriorResults(): CognitiveCheckResult[] {
  return [
    {
      check_name: "cognitive:goal_quality",
      severity: "warn",
      detail: "3/9 goals vague",
      findings: [{ issue: "vague_title", detail: "Vague goal" }],
      timestamp: new Date().toISOString(),
      duration_ms: 100,
    },
    {
      check_name: "cognitive:pipeline_correlation",
      severity: "ok",
      detail: "All normal",
      correlations: [],
      timestamp: new Date().toISOString(),
      duration_ms: 50,
    },
  ];
}

describe("CK-06: Recommendations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates recommendations from LLM", async () => {
    const result = await runRecommendationsCheck(
      defaultConfig, mockLlm(), makePriorResults(), null, null, mockLogger(),
    );
    expect(result.check_name).toBe("cognitive:recommendations");
    expect(result.recommendations).toHaveLength(2);
    expect(result.recommendations?.[0]?.type).toBe("archive_thread");
  });

  it("passes current results to LLM", async () => {
    const llm = mockLlm();
    const priorResults = makePriorResults();
    await runRecommendationsCheck(
      defaultConfig, llm, priorResults, null, null, mockLogger(),
    );
    const userPrompt = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(userPrompt).toContain("cognitive:goal_quality");
    expect(userPrompt).toContain("3/9 goals vague");
  });

  it("respects maxRecommendations", async () => {
    const llm = mockLlm({
      content: JSON.stringify({
        severity: "ok",
        detail: "Many recs",
        recommendations: Array.from({ length: 10 }, (_, i) => ({
          type: "maintenance",
          target: `item-${i}`,
          reason: "Reason",
          priority: "low",
        })),
      }),
    });
    const result = await runRecommendationsCheck(
      { ...defaultConfig, maxRecommendations: 3 },
      llm, makePriorResults(), null, null, mockLogger(),
    );
    expect(result.recommendations?.length).toBeLessThanOrEqual(3);
  });

  it("fails open when LLM unavailable", async () => {
    const llm = mockLlm({ content: null, error: "Connection refused" });
    const result = await runRecommendationsCheck(
      defaultConfig, llm, makePriorResults(), null, null, mockLogger(),
    );
    expect(result.severity).toBe("ok");
    expect(result.detail).toContain("LLM unavailable");
    expect(result.recommendations).toHaveLength(0);
  });

  it("fails open when LLM returns invalid JSON", async () => {
    const llm = mockLlm({ content: "broken json {{{" });
    const result = await runRecommendationsCheck(
      defaultConfig, llm, makePriorResults(), null, null, mockLogger(),
    );
    expect(result.severity).toBe("ok");
    expect(result.recommendations).toHaveLength(0);
  });

  it("validates priority values", async () => {
    const llm = mockLlm({
      content: JSON.stringify({
        severity: "ok",
        detail: "1 rec",
        recommendations: [
          { type: "investigate", target: "x", reason: "y", priority: "ultra-high" },
        ],
      }),
    });
    const result = await runRecommendationsCheck(
      defaultConfig, llm, [], null, null, mockLogger(),
    );
    // Invalid priority should fallback to "low"
    expect(result.recommendations?.[0]?.priority).toBe("low");
  });

  it("includes daemon issues in LLM context", async () => {
    const status: LeukoStatus = {
      last_check: "2026-02-23T17:00:00Z",
      overall_severity: "warn",
      daemon_checks: [
        { check_name: "output_freshness:facts", severity: "warn", detail: "Stale 48h", auto_healed: false, timestamp: "" },
      ],
    };
    const llm = mockLlm();
    await runRecommendationsCheck(
      defaultConfig, llm, [], status, null, mockLogger(),
    );
    const userPrompt = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(userPrompt).toContain("output_freshness:facts");
  });

  it("returns warn severity for medium/high priority recs", async () => {
    const llm = mockLlm({
      content: JSON.stringify({
        severity: "warn",
        detail: "Urgent recommendation",
        recommendations: [
          { type: "investigate", target: "pipeline", reason: "Broken 3 days", priority: "high" },
        ],
      }),
    });
    const result = await runRecommendationsCheck(
      defaultConfig, llm, [], null, null, mockLogger(),
    );
    expect(result.severity).toBe("warn");
  });

  it("records model and tokens", async () => {
    const result = await runRecommendationsCheck(
      defaultConfig, mockLlm({ tokens: 500 }), [], null, null, mockLogger(),
    );
    expect(result.model_used).toBe("test/model");
    expect(result.tokens_used).toBe(500);
  });
});
