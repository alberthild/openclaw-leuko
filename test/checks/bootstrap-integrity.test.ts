import { describe, it, expect, vi, beforeEach } from "vitest";
import { runBootstrapIntegrityCheck } from "../../src/checks/bootstrap-integrity.js";
import type {
  BootstrapIntegrityCheckConfig,
  LlmClient,
  LlmResponse,
  LeukoStatus,
  PluginLogger,
} from "../../src/types.js";

vi.mock("../../src/status-reader.js", () => ({
  readTextInput: vi.fn(),
}));

import { readTextInput } from "../../src/status-reader.js";

const mockedReadTextInput = vi.mocked(readTextInput);

function mockLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function mockLlm(response: Partial<LlmResponse> = {}): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({ severity: "ok", detail: "Bootstrap is current", findings: [] }),
      model: "test/model",
      tokens: 200,
      durationMs: 1000,
      ...response,
    }),
  };
}

function mockStatus(): LeukoStatus {
  return {
    last_check: "2026-02-23T17:00:00Z",
    overall_severity: "ok",
    daemon_checks: [
      { check_name: "service_health:nats", severity: "ok", detail: "OK", auto_healed: false, timestamp: "" },
    ],
  };
}

const defaultConfig: BootstrapIntegrityCheckConfig = {
  enabled: true,
  inputPath: "/test/BOOTSTRAP.md",
  usesLlm: true,
};

describe("CK-05: Bootstrap Integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns warn when BOOTSTRAP.md not found", async () => {
    mockedReadTextInput.mockReturnValue(null);
    const result = await runBootstrapIntegrityCheck(
      defaultConfig, mockLlm(), mockStatus(), mockLogger(),
    );
    expect(result.check_name).toBe("cognitive:bootstrap_integrity");
    expect(result.severity).toBe("warn");
    expect(result.detail).toContain("not found");
  });

  it("calls LLM with bootstrap content and system state", async () => {
    mockedReadTextInput.mockReturnValue("# Bootstrap\nSystem is healthy.");
    const llm = mockLlm();
    await runBootstrapIntegrityCheck(defaultConfig, llm, mockStatus(), mockLogger());
    expect(llm.generate).toHaveBeenCalledOnce();
    const userPrompt = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(userPrompt).toContain("BOOTSTRAP.md Content");
    expect(userPrompt).toContain("System State");
  });

  it("returns LLM severity and findings", async () => {
    mockedReadTextInput.mockReturnValue("# Bootstrap\nEntity extractor runs every 4h.");
    const llm = mockLlm({
      content: JSON.stringify({
        severity: "warn",
        detail: "Stale reference found",
        findings: [{
          issue: "stale_reference",
          line: "Entity extractor runs every 4h",
          detail: "Extractor cron no longer exists",
          recommendation: "Remove reference",
        }],
      }),
    });
    const result = await runBootstrapIntegrityCheck(
      defaultConfig, llm, mockStatus(), mockLogger(),
    );
    expect(result.severity).toBe("warn");
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]?.issue).toBe("stale_reference");
  });

  it("fails open when LLM unavailable", async () => {
    mockedReadTextInput.mockReturnValue("# Bootstrap content");
    const llm = mockLlm({ content: null, error: "Timeout" });
    const result = await runBootstrapIntegrityCheck(
      defaultConfig, llm, mockStatus(), mockLogger(),
    );
    expect(result.severity).toBe("ok"); // fail-open
    expect(result.detail).toContain("LLM unavailable");
  });

  it("fails open when LLM returns invalid JSON", async () => {
    mockedReadTextInput.mockReturnValue("# Bootstrap content");
    const llm = mockLlm({ content: "not json" });
    const result = await runBootstrapIntegrityCheck(
      defaultConfig, llm, mockStatus(), mockLogger(),
    );
    expect(result.severity).toBe("ok");
    expect(result.detail).toContain("parsing failed");
  });

  it("handles null status gracefully", async () => {
    mockedReadTextInput.mockReturnValue("# Bootstrap");
    const llm = mockLlm();
    const result = await runBootstrapIntegrityCheck(
      defaultConfig, llm, null, mockLogger(),
    );
    expect(result.check_name).toBe("cognitive:bootstrap_integrity");
  });

  it("returns critical for major issues", async () => {
    mockedReadTextInput.mockReturnValue("# Old Bootstrap");
    const llm = mockLlm({
      content: JSON.stringify({
        severity: "critical",
        detail: "Missing critical subsystems",
        findings: [
          { issue: "missing_subsystem", detail: "NATS not mentioned" },
          { issue: "missing_subsystem", detail: "Leuko not mentioned" },
        ],
      }),
    });
    const result = await runBootstrapIntegrityCheck(
      defaultConfig, llm, mockStatus(), mockLogger(),
    );
    expect(result.severity).toBe("critical");
  });

  it("records model and tokens", async () => {
    mockedReadTextInput.mockReturnValue("# Bootstrap");
    const llm = mockLlm({ tokens: 300 });
    const result = await runBootstrapIntegrityCheck(
      defaultConfig, llm, mockStatus(), mockLogger(),
    );
    expect(result.model_used).toBe("test/model");
    expect(result.tokens_used).toBe(300);
  });
});
