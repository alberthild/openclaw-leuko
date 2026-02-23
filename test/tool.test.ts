import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatToolResponse } from "../src/tool.js";
import type { LeukoStatus } from "../src/types.js";

function makeStatus(overrides: Partial<LeukoStatus> = {}): LeukoStatus {
  return {
    last_check: "2026-02-23T17:00:00",
    overall_severity: "warn",
    daemon_checks: [
      { check_name: "service_health:nats", severity: "ok", detail: "OK", auto_healed: false, timestamp: "" },
      { check_name: "output_freshness:facts", severity: "warn", detail: "Stale 48h", auto_healed: false, timestamp: "" },
    ],
    cognitive_checks: [
      {
        check_name: "cognitive:goal_quality",
        severity: "ok",
        detail: "All goals specific",
        timestamp: "2026-02-23T16:00:00Z",
        duration_ms: 500,
      },
      {
        check_name: "cognitive:thread_health",
        severity: "warn",
        detail: "2/6 threads stale",
        findings: [{ issue: "stale", detail: "Thread old", thread_id: "t1" }],
        timestamp: "2026-02-23T16:00:00Z",
        duration_ms: 600,
      },
      {
        check_name: "cognitive:recommendations",
        severity: "ok",
        detail: "2 recommendations",
        recommendations: [
          { type: "archive_thread", target: "t1", reason: "Stale 12d", priority: "low" },
        ],
        timestamp: "2026-02-23T16:00:00Z",
        duration_ms: 700,
      },
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
    ...overrides,
  };
}

describe("formatToolResponse", () => {
  it("returns error when status is null", () => {
    const result = formatToolResponse(null, {});
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBeTruthy();
  });

  it("returns summary by default", () => {
    const result = formatToolResponse(makeStatus(), {});
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.overall).toBe("warn");
    expect(parsed.daemon_summary.total).toBe(2);
    expect(parsed.cognitive_summary.total).toBe(3);
    expect(parsed.top_issues.length).toBeGreaterThan(0);
    expect(parsed.last_l2_run).toBeTruthy();
  });

  it("returns daemon section", () => {
    const result = formatToolResponse(makeStatus(), { section: "daemon" });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.daemon_checks).toBeDefined();
    expect(parsed.daemon_checks.length).toBe(2);
  });

  it("returns cognitive section", () => {
    const result = formatToolResponse(makeStatus(), { section: "cognitive" });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.cognitive_checks).toBeDefined();
    expect(parsed.cognitive_meta).toBeDefined();
  });

  it("returns recommendations section", () => {
    const result = formatToolResponse(makeStatus(), { section: "recommendations" });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.recommendations).toBeDefined();
    expect(parsed.recommendations.length).toBe(1);
  });

  it("returns all sections", () => {
    const result = formatToolResponse(makeStatus(), { section: "all" });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.overall).toBeDefined();
    expect(parsed.daemon_checks).toBeDefined();
    expect(parsed.cognitive_checks).toBeDefined();
  });

  it("filters by severity (warn+)", () => {
    const result = formatToolResponse(makeStatus(), {
      section: "daemon",
      severity_filter: "warn",
    });
    const parsed = JSON.parse(result.content[0]!.text);
    // Only warn and critical checks returned
    expect(parsed.daemon_checks.every((c: { severity: string }) => c.severity !== "ok")).toBe(true);
  });

  it("filters by severity (critical only)", () => {
    const status = makeStatus({
      daemon_checks: [
        { check_name: "a", severity: "ok", detail: "", auto_healed: false, timestamp: "" },
        { check_name: "b", severity: "warn", detail: "", auto_healed: false, timestamp: "" },
        { check_name: "c", severity: "critical", detail: "", auto_healed: false, timestamp: "" },
      ],
    });
    const result = formatToolResponse(status, {
      section: "daemon",
      severity_filter: "critical",
    });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.daemon_checks).toHaveLength(1);
    expect(parsed.daemon_checks[0].severity).toBe("critical");
  });

  it("sorts top issues by severity (critical first)", () => {
    const status = makeStatus({
      daemon_checks: [
        { check_name: "a", severity: "warn", detail: "Warn", auto_healed: false, timestamp: "" },
        { check_name: "b", severity: "critical", detail: "Critical", auto_healed: false, timestamp: "" },
      ],
    });
    const result = formatToolResponse(status, {});
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.top_issues[0].severity).toBe("critical");
  });

  it("limits top issues to 10", () => {
    const checks = Array.from({ length: 15 }, (_, i) => ({
      check_name: `check_${i}`,
      severity: "warn" as const,
      detail: `Issue ${i}`,
      auto_healed: false,
      timestamp: "",
    }));
    const result = formatToolResponse(makeStatus({ daemon_checks: checks }), {});
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.top_issues.length).toBeLessThanOrEqual(10);
  });
});
