#!/usr/bin/env node
/**
 * Leuko L1 Daemon — Lightweight health monitor
 *
 * Produces leuko-status.json consumed by the L2 OpenClaw Plugin.
 * Portable: runs on any OpenClaw installation (no Python, no NATS required).
 *
 * Usage:
 *   npx @vainplex/openclaw-leuko daemon          # Run once
 *   npx @vainplex/openclaw-leuko daemon --watch   # Run every 15min
 *   npx @vainplex/openclaw-leuko daemon --config /path/to/config.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";

import type { DaemonCheck, StatusFile, DaemonConfig, FreshnessTarget, ServiceEndpoint } from "./types.js";
export type { DaemonCheck, StatusFile, DaemonConfig, FreshnessTarget, ServiceEndpoint };

// ============================================================
// Defaults
// ============================================================

const HOME = process.env["HOME"] ?? "/tmp";

function defaultConfig(): DaemonConfig {
  const candidates = [
    process.env["OPENCLAW_WORKSPACE"],
    join(HOME, "clawd"),
    join(HOME, "workspace"),
    HOME,
  ].filter(Boolean) as string[];

  const workspace = candidates.find(d =>
    existsSync(join(d!, ".openclaw")) || existsSync(join(d!, "AGENTS.md"))
  ) ?? HOME;

  return {
    statusPath: join(HOME, ".openclaw", "leuko-status.json"),
    workspace,
    watchIntervalMin: 15,
    checks: {
      file_freshness: { enabled: true, targets: [] },
      service_health: { enabled: true, endpoints: [] },
      disk_usage: { enabled: true, warnPercent: 85, critPercent: 95 },
      gateway_alive: { enabled: true },
      plugin_loading: { enabled: true },
    },
  };
}

// ============================================================
// Helpers
// ============================================================

function now(): string {
  return new Date().toISOString();
}

function check(name: string, severity: "ok" | "warn" | "critical", detail: string): DaemonCheck {
  return { check_name: name, severity, detail, auto_healed: false, timestamp: now(), heal_action: null, heal_key: null };
}

function hoursAgo(mtime: Date): number {
  return (Date.now() - mtime.getTime()) / (1000 * 60 * 60);
}

function computeSeverity(checks: DaemonCheck[]): "ok" | "warn" | "critical" {
  for (const c of checks) {
    if (c.severity === "critical") return "critical";
  }
  return checks.some(c => c.severity === "warn") ? "warn" : "ok";
}

// ============================================================
// Check Implementations
// ============================================================

function checkFileFreshness(targets: FreshnessTarget[]): DaemonCheck[] {
  const results: DaemonCheck[] = [];
  for (const t of targets) {
    const resolved = t.path.replace(/^~/, HOME);
    if (!existsSync(resolved)) {
      results.push(check(`freshness:${t.name}`, "warn", `${t.name} not found at ${resolved}`));
      continue;
    }
    const age = hoursAgo(statSync(resolved).mtime);
    if (age > t.critHours) {
      results.push(check(`freshness:${t.name}`, "critical", `${t.name} modified ${age.toFixed(1)}h ago (crit: ${t.critHours}h)`));
    } else if (age > t.warnHours) {
      results.push(check(`freshness:${t.name}`, "warn", `${t.name} modified ${age.toFixed(1)}h ago (warn: ${t.warnHours}h)`));
    } else {
      results.push(check(`freshness:${t.name}`, "ok", `${t.name} modified ${age.toFixed(1)}h ago`));
    }
  }
  return results;
}

function checkGatewayAlive(): DaemonCheck {
  const myPid = String(process.pid);
  const myPpid = String(process.ppid);
  for (const pattern of ["openclaw-gateway", "openclaw"]) {
    try {
      const output = execFileSync("pgrep", ["-f", pattern], {
        timeout: 5000, encoding: "utf-8",
      }).trim();
      // Filter out own PID and parent PID to avoid self-match
      const pids = output.split("\n").filter(p => p !== myPid && p !== myPpid);
      if (pids.length > 0) {
        return check("gateway_alive", "ok", `Gateway process found (PID: ${pids[0]})`);
      }
    } catch { /* pgrep exits non-zero when no match */ }
  }
  return check("gateway_alive", "critical", "No OpenClaw gateway process found");
}

function checkPluginLoading(): DaemonCheck {
  try {
    const configPath = join(HOME, ".openclaw", "openclaw.json");
    if (!existsSync(configPath)) {
      return check("plugin_loading", "warn", "No openclaw.json found");
    }
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const plugins = config?.plugins?.entries ?? {};
    const enabled = Object.entries(plugins).filter(
      ([, v]) => (v as Record<string, unknown>)?.enabled !== false,
    );
    return check("plugin_loading", "ok", `${enabled.length} plugins configured`);
  } catch (e) {
    return check("plugin_loading", "warn", `Failed to read config: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function checkDiskUsage(warnPct: number, critPct: number): DaemonCheck {
  try {
    const output = execFileSync("df", ["-h", "/"], { timeout: 5000, encoding: "utf-8" }).trim();
    const lines = output.split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    const match = lastLine.match(/(\d+)%/);
    if (match) {
      const pct = parseInt(match[1]!, 10);
      if (pct >= critPct) return check("disk_usage", "critical", `Disk ${pct}% full`);
      if (pct >= warnPct) return check("disk_usage", "warn", `Disk ${pct}% full`);
      return check("disk_usage", "ok", `Disk ${pct}% used`);
    }
    return check("disk_usage", "ok", "Could not parse disk usage");
  } catch {
    return check("disk_usage", "warn", "Failed to check disk");
  }
}

/** TCP probe using Node.js net — no shell, no subprocess. */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(timeoutMs);
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.on("error", () => { sock.destroy(); resolve(false); });
  });
}

/** Sync TCP probe — spins event loop briefly via execFileSync. */
function tcpProbeSync(host: string, port: number, timeoutMs: number): boolean {
  // Validate inputs to prevent injection — host already regex-checked by caller
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) return false;
  try {
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      // Static template — all values pre-validated above
      `import{createConnection}from"net";`
      + `const s=createConnection({host:${JSON.stringify(host)},port:${port}},`
      + `()=>{s.destroy();process.exit(0)});`
      + `s.setTimeout(${timeoutMs});`
      + `s.on("timeout",()=>{s.destroy();process.exit(1)});`
      + `s.on("error",()=>{s.destroy();process.exit(1)});`,
    ], { timeout: timeoutMs + 2000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** HTTP probe using execFileSync with curl (no shell interpolation). */
function httpProbe(url: string, timeoutMs: number): boolean {
  try {
    execFileSync("curl", ["-sf", "--max-time", String(Math.ceil(timeoutMs / 1000)), url], {
      timeout: timeoutMs + 2000, stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function checkServiceHealth(endpoints: ServiceEndpoint[]): DaemonCheck[] {
  const results: DaemonCheck[] = [];
  for (const ep of endpoints) {
    if (ep.type === "http" && ep.url) {
      const ok = httpProbe(ep.url, ep.timeoutMs);
      results.push(check(`service:${ep.name}`, ok ? "ok" : "warn",
        ok ? `${ep.name} reachable` : `${ep.name} unreachable at ${ep.url}`));
    } else if (ep.type === "tcp" && ep.host && ep.port) {
      if (!/^[\w.\-]+$/.test(ep.host) || !Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535) {
        results.push(check(`service:${ep.name}`, "warn", `Invalid host/port: ${ep.host}:${ep.port}`));
        continue;
      }
      const timeout = Number.isInteger(ep.timeoutMs) ? ep.timeoutMs : 3000;
      const ok = tcpProbeSync(ep.host, ep.port, timeout);
      results.push(check(`service:${ep.name}`, ok ? "ok" : "warn",
        ok ? `${ep.name} reachable at ${ep.host}:${ep.port}` : `${ep.name} unreachable at ${ep.host}:${ep.port}`));
    }
  }
  return results;
}

function autoDiscoverFreshnessTargets(workspace: string): FreshnessTarget[] {
  const candidates = [
    { rel: "BOOTSTRAP.md", name: "boot-context", warnHours: 4, critHours: 8 },
    { rel: "memory/reboot/threads.json", name: "threads", warnHours: 24, critHours: 48 },
    { rel: "memory/reboot/decisions.json", name: "decisions", warnHours: 24, critHours: 48 },
    { rel: "memory/reboot/goals.json", name: "goals", warnHours: 48, critHours: 96 },
  ];
  return candidates
    .filter(c => existsSync(join(workspace, c.rel)))
    .map(c => ({ ...c, path: join(workspace, c.rel) }));
}

// ============================================================
// Core
// ============================================================

function runDaemon(cfg: DaemonConfig): StatusFile {
  const checks: DaemonCheck[] = [];
  const ft = cfg.checks.file_freshness;
  const targets = ft.targets.length > 0 ? ft.targets : autoDiscoverFreshnessTargets(cfg.workspace);

  if (ft.enabled && targets.length > 0) checks.push(...checkFileFreshness(targets));
  if (cfg.checks.gateway_alive.enabled) checks.push(checkGatewayAlive());
  if (cfg.checks.plugin_loading.enabled) checks.push(checkPluginLoading());
  if (cfg.checks.disk_usage.enabled) {
    checks.push(checkDiskUsage(cfg.checks.disk_usage.warnPercent, cfg.checks.disk_usage.critPercent));
  }
  if (cfg.checks.service_health.enabled && cfg.checks.service_health.endpoints.length > 0) {
    checks.push(...checkServiceHealth(cfg.checks.service_health.endpoints));
  }

  return {
    last_check: now(),
    overall_severity: computeSeverity(checks),
    daemon_checks: checks,
    cognitive_checks: [],
    auto_heal_history: [],
  };
}

function loadDaemonConfig(configPath?: string): DaemonConfig {
  const cfg = defaultConfig();
  if (!configPath || !existsSync(configPath)) return cfg;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof raw.statusPath === "string") cfg.statusPath = raw.statusPath;
    if (typeof raw.workspace === "string") cfg.workspace = raw.workspace;
    if (typeof raw.watchIntervalMin === "number") cfg.watchIntervalMin = raw.watchIntervalMin;
    if (Array.isArray(raw.checks?.file_freshness?.targets)) {
      cfg.checks.file_freshness.targets = raw.checks.file_freshness.targets;
    }
    if (Array.isArray(raw.checks?.service_health?.endpoints)) {
      cfg.checks.service_health.endpoints = raw.checks.service_health.endpoints;
    }
  } catch {
    console.error(`[leuko-daemon] Failed to parse config at ${configPath}`);
  }
  return cfg;
}

function writeStatus(status: StatusFile, path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(status, null, 2) + "\n");
}

// ============================================================
// Exports (for testing)
// ============================================================

export {
  runDaemon, loadDaemonConfig, writeStatus, defaultConfig,
  checkFileFreshness, checkGatewayAlive, checkPluginLoading,
  checkDiskUsage, checkServiceHealth, autoDiscoverFreshnessTargets,
  httpProbe, tcpProbe, tcpProbeSync, check, hoursAgo, computeSeverity,
};

// ============================================================
// CLI
// ============================================================

export function main(argv: string[] = process.argv.slice(2)): void {
  const watchMode = argv.includes("--watch");
  const configIdx = argv.indexOf("--config");
  const configPath = configIdx >= 0 ? argv[configIdx + 1] : undefined;
  const cfg = loadDaemonConfig(configPath);

  cfg.watchIntervalMin = Math.max(1, Math.min(1440, cfg.watchIntervalMin));

  console.log(`[leuko-daemon] Workspace: ${cfg.workspace}`);
  console.log(`[leuko-daemon] Status output: ${cfg.statusPath}`);

  function tick() {
    const t0 = Date.now();
    const status = runDaemon(cfg);
    writeStatus(status, cfg.statusPath);
    const ms = Date.now() - t0;
    const w = status.daemon_checks.filter(c => c.severity === "warn").length;
    const cr = status.daemon_checks.filter(c => c.severity === "critical").length;
    console.log(`[leuko-daemon] ${status.overall_severity.toUpperCase()} — ${status.daemon_checks.length} checks (${w} warn, ${cr} crit) in ${ms}ms`);
  }

  tick();

  if (watchMode) {
    console.log(`[leuko-daemon] Watch mode: running every ${cfg.watchIntervalMin} minutes`);
    const timer = setInterval(tick, cfg.watchIntervalMin * 60 * 1000);
    timer.unref();
    process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
    process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });
  }
}

// Only run CLI when executed directly (not imported for tests)
if (process.argv[1] && /(?:daemon\/index\.[jt]s|leuko-daemon)$/.test(process.argv[1])) {
  main();
}
