import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginApi, PluginLogger, ToolDefinition, PluginCommand } from "../src/types.js";

// We need to mock the file-reading modules before importing the plugin
vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue("{}"),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  statSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  mkdirSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn().mockImplementation(() => { throw new Error("no nats"); }),
}));

function mockLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function createMockApi(pluginConfig?: Record<string, unknown>): PluginApi & {
  tools: ToolDefinition[];
  commands: PluginCommand[];
  hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
} {
  const tools: ToolDefinition[] = [];
  const commands: PluginCommand[] = [];
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();

  return {
    pluginConfig,
    logger: mockLogger(),
    tools,
    commands,
    hooks,
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    registerCommand(command: PluginCommand) {
      commands.push(command);
    },
    on(hookName: string, handler: (...args: unknown[]) => unknown) {
      if (!hooks.has(hookName)) hooks.set(hookName, []);
      hooks.get(hookName)!.push(handler);
    },
  };
}

describe("Plugin Registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers tool, command, and hook with default config", async () => {
    // Dynamic import to get the mocked version
    const { default: plugin } = await import("../src/index.js");

    const api = createMockApi();
    plugin.register(api);

    expect(plugin.id).toBe("openclaw-leuko");
    expect(plugin.version).toBe("0.1.0");

    // Should register leuko_status tool
    expect(api.tools.length).toBe(1);
    expect(api.tools[0]?.name).toBe("leuko_status");

    // Should register /leuko command
    expect(api.commands.length).toBe(1);
    expect(api.commands[0]?.name).toBe("leuko");

    // Should register before_agent_start hook
    expect(api.hooks.has("before_agent_start")).toBe(true);
  });

  it("does not register when disabled", async () => {
    const { default: plugin } = await import("../src/index.js");

    const api = createMockApi({ enabled: false, statusPath: "/dummy" });
    plugin.register(api);

    expect(api.tools.length).toBe(0);
    expect(api.commands.length).toBe(0);
  });

  it("leuko_status tool returns valid response", async () => {
    const { default: plugin } = await import("../src/index.js");

    const api = createMockApi();
    plugin.register(api);

    const tool = api.tools[0]!;
    const result = await tool.execute("call-1", {});
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0]!.text);
    // Status file doesn't exist in mocked env, should return error
    expect(parsed.error || parsed.overall).toBeDefined();
  });

  it("/leuko command returns health summary", async () => {
    const { default: plugin } = await import("../src/index.js");

    const api = createMockApi();
    plugin.register(api);

    const command = api.commands[0]!;
    const result = await command.handler({});
    expect(result.text).toContain("Leuko");
  });

  it("/leuko config returns configuration info", async () => {
    const { default: plugin } = await import("../src/index.js");

    const api = createMockApi();
    plugin.register(api);

    const command = api.commands[0]!;
    const result = await command.handler({ _: "config" });
    expect(result.text).toContain("Config");
    expect(result.text).toContain("Model");
  });

  it("/leuko detail returns check details", async () => {
    const { default: plugin } = await import("../src/index.js");

    const api = createMockApi();
    plugin.register(api);

    const command = api.commands[0]!;
    const result = await command.handler({ _: "detail" });
    expect(result.text).toContain("cognitive check");
  });
});

describe("buildHealthSummary", () => {
  it("returns empty string when no issues", async () => {
    const { buildHealthSummary } = await import("../src/index.js");
    const status = {
      last_check: "",
      overall_severity: "ok" as const,
      daemon_checks: [
        { check_name: "test", severity: "ok" as const, detail: "OK", auto_healed: false, timestamp: "" },
      ],
      cognitive_checks: [
        { check_name: "cognitive:test", severity: "ok" as const, detail: "OK", timestamp: "", duration_ms: 0 },
      ],
    };
    expect(buildHealthSummary(status, 200)).toBe("");
  });

  it("includes issue names", async () => {
    const { buildHealthSummary } = await import("../src/index.js");
    const status = {
      last_check: "",
      overall_severity: "warn" as const,
      daemon_checks: [
        { check_name: "output_freshness:facts", severity: "warn" as const, detail: "Stale", auto_healed: false, timestamp: "" },
      ],
      cognitive_checks: [
        { check_name: "cognitive:goal_quality", severity: "warn" as const, detail: "Issues", timestamp: "", duration_ms: 0 },
      ],
    };
    const summary = buildHealthSummary(status, 500);
    expect(summary).toContain("facts");
    expect(summary).toContain("goal_quality");
    expect(summary).toContain("WARN");
  });

  it("truncates to maxLength", async () => {
    const { buildHealthSummary } = await import("../src/index.js");
    const status = {
      last_check: "",
      overall_severity: "warn" as const,
      daemon_checks: Array.from({ length: 20 }, (_, i) => ({
        check_name: `check_${i}_with_a_very_long_name_to_test_truncation`,
        severity: "warn" as const,
        detail: "",
        auto_healed: false,
        timestamp: "",
      })),
    };
    const summary = buildHealthSummary(status, 50);
    expect(summary.length).toBeLessThanOrEqual(50);
    expect(summary).toContain("...");
  });
});

describe("computeOverallSeverity", () => {
  it("returns critical if any check is critical", async () => {
    const { computeOverallSeverity } = await import("../src/index.js");
    const checks = [
      { check_name: "a", severity: "ok" as const, detail: "", timestamp: "", duration_ms: 0 },
      { check_name: "b", severity: "critical" as const, detail: "", timestamp: "", duration_ms: 0 },
    ];
    expect(computeOverallSeverity(checks)).toBe("critical");
  });

  it("returns warn if any check is warn", async () => {
    const { computeOverallSeverity } = await import("../src/index.js");
    const checks = [
      { check_name: "a", severity: "ok" as const, detail: "", timestamp: "", duration_ms: 0 },
      { check_name: "b", severity: "warn" as const, detail: "", timestamp: "", duration_ms: 0 },
    ];
    expect(computeOverallSeverity(checks)).toBe("warn");
  });

  it("returns ok when all ok", async () => {
    const { computeOverallSeverity } = await import("../src/index.js");
    const checks = [
      { check_name: "a", severity: "ok" as const, detail: "", timestamp: "", duration_ms: 0 },
    ];
    expect(computeOverallSeverity(checks)).toBe("ok");
  });
});
