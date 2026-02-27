import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runDaemon, loadDaemonConfig, writeStatus, defaultConfig,
  checkFileFreshness, checkPluginLoading, checkDiskUsage,
  checkServiceHealth, autoDiscoverFreshnessTargets,
  check, hoursAgo, computeSeverity, main,
  type DaemonConfig, type FreshnessTarget, type StatusFile,
} from "../src/daemon/index.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "leuko-test-"));
}

function makeConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const tmp = makeTmpDir();
  const base = defaultConfig();
  return { ...base, statusPath: join(tmp, "leuko-status.json"), workspace: tmp,
    ...overrides, checks: { ...base.checks, ...overrides.checks } };
}

// ── Helpers ─────────────────────────────────────────────────
describe("check()", () => {
  it("creates DaemonCheck with all fields", () => {
    const c = check("test", "warn", "msg");
    expect(c).toMatchObject({ check_name: "test", severity: "warn", detail: "msg",
      auto_healed: false, heal_action: null, heal_key: null });
    expect(c.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("hoursAgo()", () => {
  it("returns ~0 for now", () => expect(hoursAgo(new Date())).toBeLessThan(0.01));
  it("returns ~1 for 1h ago", () => {
    const h = hoursAgo(new Date(Date.now() - 3600_000));
    expect(h).toBeGreaterThan(0.99); expect(h).toBeLessThan(1.01);
  });
});

describe("computeSeverity()", () => {
  it("returns ok for empty", () => expect(computeSeverity([])).toBe("ok"));
  it("returns warn if any warn", () => {
    expect(computeSeverity([check("a", "ok", ""), check("b", "warn", "")])).toBe("warn");
  });
  it("returns critical if any critical", () => {
    expect(computeSeverity([check("a", "warn", ""), check("b", "critical", "")])).toBe("critical");
  });
});

// ── File Freshness ──────────────────────────────────────────
describe("checkFileFreshness()", () => {
  it("ok for fresh files", () => {
    const tmp = makeTmpDir(); const f = join(tmp, "t.md"); writeFileSync(f, "x");
    const r = checkFileFreshness([{ name: "t", path: f, warnHours: 1, critHours: 4 }]);
    expect(r).toHaveLength(1); expect(r[0]!.severity).toBe("ok");
  });
  it("warn for missing files", () => {
    const r = checkFileFreshness([{ name: "m", path: "/tmp/nope-leuko", warnHours: 1, critHours: 4 }]);
    expect(r[0]!.severity).toBe("warn"); expect(r[0]!.detail).toContain("not found");
  });
  it("tilde in path", () => {
    const r = checkFileFreshness([{ name: "h", path: "~/nope-leuko", warnHours: 1, critHours: 4 }]);
    expect(r[0]!.severity).toBe("warn");
  });
  it("empty targets → empty results", () => expect(checkFileFreshness([])).toHaveLength(0));
});

// ── Disk ────────────────────────────────────────────────────
describe("checkDiskUsage()", () => {
  it("returns valid check", () => {
    const r = checkDiskUsage(85, 95);
    expect(r.check_name).toBe("disk_usage"); expect(r.detail).toMatch(/Disk \d+%/);
  });
  it("0/0 thresholds → critical", () => expect(checkDiskUsage(0, 0).severity).toBe("critical"));
});

// ── Plugin Loading ──────────────────────────────────────────
describe("checkPluginLoading()", () => {
  it("returns valid result", () => {
    const r = checkPluginLoading();
    expect(r.check_name).toBe("plugin_loading"); expect(r.detail).toMatch(/plugin|config/i);
  });
});

// ── Service Health ──────────────────────────────────────────
describe("checkServiceHealth()", () => {
  it("empty endpoints → empty", () => expect(checkServiceHealth([])).toHaveLength(0));
  it("rejects shell metachar hosts", () => {
    const r = checkServiceHealth([{ name: "x", type: "tcp", host: "$(rm -rf /)", port: 80, timeoutMs: 500 }]);
    expect(r[0]!.detail).toContain("Invalid");
  });
  it("rejects non-integer port", () => {
    const r = checkServiceHealth([{ name: "x", type: "tcp", host: "localhost",
      port: "80;evil" as unknown as number, timeoutMs: 500 }]);
    expect(r[0]!.detail).toContain("Invalid");
  });
  it("rejects port out of range", () => {
    const r = checkServiceHealth([{ name: "x", type: "tcp", host: "localhost", port: 99999, timeoutMs: 500 }]);
    expect(r[0]!.detail).toContain("Invalid");
  });
  it("unreachable port → warn", () => {
    const r = checkServiceHealth([{ name: "d", type: "tcp", host: "127.0.0.1", port: 59999, timeoutMs: 500 }]);
    expect(r[0]!.severity).toBe("warn"); expect(r[0]!.detail).toContain("unreachable");
  });
  it("unreachable http → warn", () => {
    const r = checkServiceHealth([{ name: "h", type: "http", url: "http://127.0.0.1:59998", timeoutMs: 500 }]);
    expect(r[0]!.severity).toBe("warn");
  });
});

// ── Auto-discovery ──────────────────────────────────────────
describe("autoDiscoverFreshnessTargets()", () => {
  it("discovers BOOTSTRAP.md", () => {
    const tmp = makeTmpDir(); writeFileSync(join(tmp, "BOOTSTRAP.md"), "#");
    expect(autoDiscoverFreshnessTargets(tmp).find(t => t.name === "boot-context")).toBeDefined();
  });
  it("bare dir → empty", () => expect(autoDiscoverFreshnessTargets(makeTmpDir())).toHaveLength(0));
  it("discovers threads+decisions", () => {
    const tmp = makeTmpDir(); mkdirSync(join(tmp, "memory", "reboot"), { recursive: true });
    writeFileSync(join(tmp, "memory", "reboot", "threads.json"), "[]");
    writeFileSync(join(tmp, "memory", "reboot", "decisions.json"), "[]");
    const t = autoDiscoverFreshnessTargets(tmp);
    expect(t.find(x => x.name === "threads")).toBeDefined();
    expect(t.find(x => x.name === "decisions")).toBeDefined();
  });
});

// ── Config Loading ──────────────────────────────────────────
describe("loadDaemonConfig()", () => {
  it("defaults without config", () => {
    const c = loadDaemonConfig(); expect(c.watchIntervalMin).toBe(15);
  });
  it("loads overrides", () => {
    const tmp = makeTmpDir(); const p = join(tmp, "c.json");
    writeFileSync(p, JSON.stringify({ watchIntervalMin: 5, statusPath: join(tmp, "s.json") }));
    const c = loadDaemonConfig(p);
    expect(c.watchIntervalMin).toBe(5); expect(c.statusPath).toContain("s.json");
  });
  it("handles malformed JSON", () => {
    const tmp = makeTmpDir(); const p = join(tmp, "bad.json"); writeFileSync(p, "{{{");
    expect(loadDaemonConfig(p).watchIntervalMin).toBe(15);
  });
  it("type-checks config values", () => {
    const tmp = makeTmpDir(); const p = join(tmp, "c.json");
    writeFileSync(p, JSON.stringify({ watchIntervalMin: "not a number", statusPath: 42 }));
    const c = loadDaemonConfig(p);
    expect(c.watchIntervalMin).toBe(15); // rejected string
    expect(typeof c.statusPath).toBe("string"); // rejected number
  });
  it("merges freshness targets", () => {
    const tmp = makeTmpDir(); const p = join(tmp, "c.json");
    writeFileSync(p, JSON.stringify({ checks: { file_freshness: { targets: [
      { name: "x", path: "/tmp/x", warnHours: 2, critHours: 8 }
    ]}}}));
    expect(loadDaemonConfig(p).checks.file_freshness.targets).toHaveLength(1);
  });
});

// ── writeStatus() ───────────────────────────────────────────
describe("writeStatus()", () => {
  it("creates dirs and writes valid JSON", () => {
    const p = join(makeTmpDir(), "sub", "deep", "s.json");
    const s: StatusFile = { last_check: now(), overall_severity: "ok",
      daemon_checks: [], cognitive_checks: [], auto_heal_history: [] };
    writeStatus(s, p);
    expect(JSON.parse(readFileSync(p, "utf-8")).overall_severity).toBe("ok");
  });
});

// ── runDaemon() ─────────────────────────────────────────────
describe("runDaemon()", () => {
  it("produces valid status", () => {
    const s = runDaemon(makeConfig());
    expect(s.last_check).toMatch(/^\d{4}-/); expect(s.daemon_checks.length).toBeGreaterThanOrEqual(2);
  });
  it("escalates to critical", () => {
    const cfg = makeConfig();
    cfg.checks.disk_usage.warnPercent = 0; cfg.checks.disk_usage.critPercent = 0;
    expect(runDaemon(cfg).overall_severity).toBe("critical");
  });
  it("uses auto-discovered targets", () => {
    const tmp = makeTmpDir(); writeFileSync(join(tmp, "BOOTSTRAP.md"), "#");
    const s = runDaemon(makeConfig({ workspace: tmp }));
    expect(s.daemon_checks.some(c => c.check_name.startsWith("freshness:"))).toBe(true);
  });
  it("skips all disabled checks", () => {
    const cfg = makeConfig();
    Object.values(cfg.checks).forEach((v: Record<string, unknown>) => { v.enabled = false; });
    const s = runDaemon(cfg);
    expect(s.daemon_checks).toHaveLength(0); expect(s.overall_severity).toBe("ok");
  });
});

// ── main() CLI ──────────────────────────────────────────────
describe("main()", () => {
  it("writes status file", () => {
    const tmp = makeTmpDir(); const sp = join(tmp, "s.json"); const cp = join(tmp, "c.json");
    writeFileSync(cp, JSON.stringify({ statusPath: sp, workspace: tmp }));
    const logs: string[] = []; const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try { main(["--config", cp]); } finally { console.log = origLog; }
    expect(existsSync(sp)).toBe(true);
    expect(logs.some(l => l.includes("[leuko-daemon]"))).toBe(true);
  });
  it("clamps negative watch interval", () => {
    const tmp = makeTmpDir(); const cp = join(tmp, "c.json");
    writeFileSync(cp, JSON.stringify({ statusPath: join(tmp, "s.json"), workspace: tmp, watchIntervalMin: -5 }));
    const origLog = console.log; console.log = () => {};
    try { main(["--config", cp]); } finally { console.log = origLog; }
  });
});

function now() { return new Date().toISOString(); }
