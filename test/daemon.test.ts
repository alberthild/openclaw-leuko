import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import testable functions (module must NOT auto-execute)
import {
  runDaemon,
  loadDaemonConfig,
  writeStatus,
  defaultConfig,
  checkFileFreshness,
  checkPluginLoading,
  checkDiskUsage,
  checkServiceHealth,
  autoDiscoverFreshnessTargets,
  httpProbe,
  check,
  hoursAgo,
  main,
  type DaemonConfig,
  type FreshnessTarget,
  type ServiceEndpoint,
  type StatusFile,
} from "../src/daemon/index.js";

// ============================================================
// Helpers
// ============================================================

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "leuko-test-"));
}

function makeConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const tmp = makeTmpDir();
  const base = defaultConfig();
  return {
    ...base,
    statusPath: join(tmp, "leuko-status.json"),
    workspace: tmp,
    ...overrides,
    checks: { ...base.checks, ...overrides.checks },
  };
}

// ============================================================
// check() helper
// ============================================================

describe("check() helper", () => {
  it("creates a DaemonCheck with all fields", () => {
    const c = check("test_check", "warn", "something happened");
    expect(c.check_name).toBe("test_check");
    expect(c.severity).toBe("warn");
    expect(c.detail).toBe("something happened");
    expect(c.auto_healed).toBe(false);
    expect(c.heal_action).toBeNull();
    expect(c.heal_key).toBeNull();
    expect(c.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("supports all severity levels", () => {
    expect(check("a", "ok", "").severity).toBe("ok");
    expect(check("a", "warn", "").severity).toBe("warn");
    expect(check("a", "critical", "").severity).toBe("critical");
  });
});

// ============================================================
// hoursAgo()
// ============================================================

describe("hoursAgo()", () => {
  it("returns 0 for now", () => {
    expect(hoursAgo(new Date())).toBeLessThan(0.01);
  });

  it("returns ~1 for 1 hour ago", () => {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000);
    const h = hoursAgo(oneHourAgo);
    expect(h).toBeGreaterThan(0.99);
    expect(h).toBeLessThan(1.01);
  });
});

// ============================================================
// checkFileFreshness()
// ============================================================

describe("checkFileFreshness()", () => {
  it("returns ok for fresh files", () => {
    const tmp = makeTmpDir();
    const file = join(tmp, "test.md");
    writeFileSync(file, "hello");
    const targets: FreshnessTarget[] = [
      { name: "test", path: file, warnHours: 1, critHours: 4 },
    ];
    const results = checkFileFreshness(targets);
    expect(results).toHaveLength(1);
    expect(results[0]!.severity).toBe("ok");
    expect(results[0]!.check_name).toBe("freshness:test");
  });

  it("returns warn for missing files", () => {
    const targets: FreshnessTarget[] = [
      { name: "missing", path: "/tmp/nonexistent-leuko-test-file", warnHours: 1, critHours: 4 },
    ];
    const results = checkFileFreshness(targets);
    expect(results).toHaveLength(1);
    expect(results[0]!.severity).toBe("warn");
    expect(results[0]!.detail).toContain("not found");
  });

  it("handles tilde in path", () => {
    const targets: FreshnessTarget[] = [
      { name: "home", path: "~/nonexistent-leuko-path", warnHours: 1, critHours: 4 },
    ];
    const results = checkFileFreshness(targets);
    // Should try to resolve ~ and report not found (not crash)
    expect(results).toHaveLength(1);
    expect(results[0]!.severity).toBe("warn");
  });

  it("returns empty for empty targets", () => {
    expect(checkFileFreshness([])).toHaveLength(0);
  });
});

// ============================================================
// checkDiskUsage()
// ============================================================

describe("checkDiskUsage()", () => {
  it("returns a valid check", () => {
    const result = checkDiskUsage(85, 95);
    expect(result.check_name).toBe("disk_usage");
    expect(["ok", "warn", "critical"]).toContain(result.severity);
    expect(result.detail).toMatch(/Disk \d+%/);
  });

  it("uses configurable thresholds", () => {
    // With 0% threshold, everything is critical
    const result = checkDiskUsage(0, 0);
    expect(result.severity).toBe("critical");
  });
});

// ============================================================
// checkPluginLoading()
// ============================================================

describe("checkPluginLoading()", () => {
  it("returns a valid check result", () => {
    // Integration test: uses actual HOME (module-level const, not overridable)
    const result = checkPluginLoading();
    expect(result.check_name).toBe("plugin_loading");
    expect(["ok", "warn"]).toContain(result.severity);
  });

  it("detail mentions plugins count or missing config", () => {
    const result = checkPluginLoading();
    // Should either say "X plugins configured" or mention missing/error
    expect(result.detail).toMatch(/plugin|config/i);
  });
});

// ============================================================
// checkServiceHealth()
// ============================================================

describe("checkServiceHealth()", () => {
  it("returns empty for no endpoints", () => {
    expect(checkServiceHealth([])).toHaveLength(0);
  });

  it("rejects invalid host characters", () => {
    const endpoints: ServiceEndpoint[] = [
      { name: "evil", type: "tcp", host: "$(rm -rf /)", port: 80, timeoutMs: 1000 },
    ];
    const results = checkServiceHealth(endpoints);
    expect(results).toHaveLength(1);
    expect(results[0]!.severity).toBe("warn");
    expect(results[0]!.detail).toContain("Invalid host/port");
  });

  it("rejects invalid port numbers", () => {
    const results = checkServiceHealth([
      { name: "bad-port", type: "tcp", host: "localhost", port: 99999, timeoutMs: 1000 },
    ]);
    expect(results[0]!.severity).toBe("warn");
    expect(results[0]!.detail).toContain("Invalid host/port");
  });

  it("reports unreachable for non-listening port", () => {
    const results = checkServiceHealth([
      { name: "dead", type: "tcp", host: "127.0.0.1", port: 59999, timeoutMs: 1000 },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.severity).toBe("warn");
    expect(results[0]!.detail).toContain("unreachable");
  });

  it("validates http endpoints via curl", () => {
    const results = checkServiceHealth([
      { name: "bad-http", type: "http", url: "http://127.0.0.1:59998/nope", timeoutMs: 1000 },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.severity).toBe("warn");
  });
});

// ============================================================
// autoDiscoverFreshnessTargets()
// ============================================================

describe("autoDiscoverFreshnessTargets()", () => {
  it("discovers BOOTSTRAP.md if present", () => {
    const tmp = makeTmpDir();
    writeFileSync(join(tmp, "BOOTSTRAP.md"), "# test");
    const targets = autoDiscoverFreshnessTargets(tmp);
    expect(targets.length).toBeGreaterThanOrEqual(1);
    expect(targets.find(t => t.name === "boot-context")).toBeDefined();
  });

  it("returns empty for bare directory", () => {
    const targets = autoDiscoverFreshnessTargets(makeTmpDir());
    expect(targets).toHaveLength(0);
  });

  it("discovers threads/decisions if present", () => {
    const tmp = makeTmpDir();
    mkdirSync(join(tmp, "memory", "reboot"), { recursive: true });
    writeFileSync(join(tmp, "memory", "reboot", "threads.json"), "[]");
    writeFileSync(join(tmp, "memory", "reboot", "decisions.json"), "[]");
    const targets = autoDiscoverFreshnessTargets(tmp);
    expect(targets.find(t => t.name === "threads")).toBeDefined();
    expect(targets.find(t => t.name === "decisions")).toBeDefined();
  });
});

// ============================================================
// loadDaemonConfig()
// ============================================================

describe("loadDaemonConfig()", () => {
  it("returns defaults when no config file given", () => {
    const cfg = loadDaemonConfig();
    expect(cfg.watchIntervalMin).toBe(15);
    expect(cfg.checks.disk_usage.enabled).toBe(true);
    expect(cfg.checks.gateway_alive.enabled).toBe(true);
  });

  it("loads overrides from config file", () => {
    const tmp = makeTmpDir();
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify({
      watchIntervalMin: 5,
      statusPath: join(tmp, "custom-status.json"),
    }));
    const cfg = loadDaemonConfig(configPath);
    expect(cfg.watchIntervalMin).toBe(5);
    expect(cfg.statusPath).toContain("custom-status.json");
  });

  it("handles malformed config gracefully", () => {
    const tmp = makeTmpDir();
    const configPath = join(tmp, "bad.json");
    writeFileSync(configPath, "not json {{{");
    // Should not throw
    const cfg = loadDaemonConfig(configPath);
    expect(cfg.watchIntervalMin).toBe(15); // falls back to default
  });

  it("merges custom freshness targets", () => {
    const tmp = makeTmpDir();
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify({
      checks: {
        file_freshness: {
          targets: [{ name: "custom", path: "/tmp/x", warnHours: 2, critHours: 8 }],
        },
      },
    }));
    const cfg = loadDaemonConfig(configPath);
    expect(cfg.checks.file_freshness.targets).toHaveLength(1);
    expect(cfg.checks.file_freshness.targets[0]!.name).toBe("custom");
  });
});

// ============================================================
// writeStatus()
// ============================================================

describe("writeStatus()", () => {
  it("creates directories and writes valid JSON", () => {
    const tmp = makeTmpDir();
    const path = join(tmp, "sub", "deep", "status.json");
    const status: StatusFile = {
      last_check: new Date().toISOString(),
      overall_severity: "ok",
      daemon_checks: [],
      cognitive_checks: [],
      auto_heal_history: [],
    };
    writeStatus(status, path);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.overall_severity).toBe("ok");
  });
});

// ============================================================
// runDaemon() — integration
// ============================================================

describe("runDaemon()", () => {
  it("runs all enabled checks and produces valid status", () => {
    const cfg = makeConfig();
    const status = runDaemon(cfg);
    expect(status.last_check).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(["ok", "warn", "critical"]).toContain(status.overall_severity);
    expect(status.daemon_checks.length).toBeGreaterThanOrEqual(2); // at least gateway + disk
    expect(status.cognitive_checks).toHaveLength(0); // L1 doesn't do cognitive
  });

  it("overall severity escalates to critical if any check is critical", () => {
    const cfg = makeConfig();
    // Disk at 0/0 threshold will be critical
    cfg.checks.disk_usage.warnPercent = 0;
    cfg.checks.disk_usage.critPercent = 0;
    const status = runDaemon(cfg);
    expect(status.overall_severity).toBe("critical");
  });

  it("uses auto-discovered freshness targets", () => {
    const tmp = makeTmpDir();
    writeFileSync(join(tmp, "BOOTSTRAP.md"), "# test");
    const cfg = makeConfig({ workspace: tmp });
    const status = runDaemon(cfg);
    const freshnessChecks = status.daemon_checks.filter(c => c.check_name.startsWith("freshness:"));
    expect(freshnessChecks.length).toBeGreaterThanOrEqual(1);
  });

  it("skips disabled checks", () => {
    const cfg = makeConfig();
    cfg.checks.gateway_alive.enabled = false;
    cfg.checks.disk_usage.enabled = false;
    cfg.checks.plugin_loading.enabled = false;
    cfg.checks.file_freshness.enabled = false;
    cfg.checks.service_health.enabled = false;
    const status = runDaemon(cfg);
    expect(status.daemon_checks).toHaveLength(0);
    expect(status.overall_severity).toBe("ok");
  });
});

// ============================================================
// main() — CLI guard
// ============================================================

describe("main()", () => {
  it("runs without error and writes status file", () => {
    const tmp = makeTmpDir();
    const statusPath = join(tmp, "status.json");
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify({
      statusPath,
      workspace: tmp,
    }));
    // Capture console output
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      main(["--config", configPath]);
    } finally {
      console.log = origLog;
    }
    expect(existsSync(statusPath)).toBe(true);
    expect(logs.some(l => l.includes("[leuko-daemon]"))).toBe(true);
  });

  it("validates watch interval bounds", () => {
    const tmp = makeTmpDir();
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify({
      statusPath: join(tmp, "status.json"),
      workspace: tmp,
      watchIntervalMin: -5,
    }));
    const origLog = console.log;
    console.log = () => {};
    try {
      main(["--config", configPath]); // Should not throw
    } finally {
      console.log = origLog;
    }
  });
});

// ============================================================
// Security: Shell injection prevention
// ============================================================

describe("shell injection prevention", () => {
  it("rejects hosts with shell metacharacters", () => {
    const results = checkServiceHealth([
      { name: "inject", type: "tcp", host: "127.0.0.1;cat /etc/passwd", port: 80, timeoutMs: 500 },
    ]);
    expect(results[0]!.severity).toBe("warn");
    expect(results[0]!.detail).toContain("Invalid");
  });

  it("rejects hosts with backtick injection", () => {
    const results = checkServiceHealth([
      { name: "backtick", type: "tcp", host: "`id`", port: 80, timeoutMs: 500 },
    ]);
    expect(results[0]!.severity).toBe("warn");
    expect(results[0]!.detail).toContain("Invalid");
  });

  it("rejects hosts with dollar injection", () => {
    const results = checkServiceHealth([
      { name: "dollar", type: "tcp", host: "$(whoami)", port: 80, timeoutMs: 500 },
    ]);
    expect(results[0]!.severity).toBe("warn");
    expect(results[0]!.detail).toContain("Invalid");
  });

  it("allows valid hostnames with dots and hyphens", () => {
    const results = checkServiceHealth([
      { name: "valid", type: "tcp", host: "my-server.example.com", port: 59998, timeoutMs: 500 },
    ]);
    // Should attempt connection (not reject as invalid)
    expect(results[0]!.detail).not.toContain("Invalid");
  });
});
