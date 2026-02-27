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

// ============================================================
// Types
// ============================================================

interface DaemonCheck {
  check_name: string;
  severity: "ok" | "warn" | "critical";
  detail: string;
  auto_healed: boolean;
  timestamp: string;
  heal_action: string | null;
  heal_key: string | null;
}

interface StatusFile {
  last_check: string;
  overall_severity: "ok" | "warn" | "critical";
  daemon_checks: DaemonCheck[];
  cognitive_checks: never[];
  auto_heal_history: never[];
}

interface DaemonConfig {
  statusPath: string;
  workspace: string;
  watchIntervalMin: number;
  checks: {
    file_freshness: { enabled: boolean; targets: FreshnessTarget[] };
    service_health: { enabled: boolean; endpoints: ServiceEndpoint[] };
    disk_usage: { enabled: boolean; warnPercent: number; critPercent: number };
    gateway_alive: { enabled: boolean };
    plugin_loading: { enabled: boolean };
  };
}

interface FreshnessTarget {
  name: string;
  path: string;
  warnHours: number;
  critHours: number;
}

interface ServiceEndpoint {
  name: string;
  type: "http" | "tcp";
  url?: string;
  host?: string;
  port?: number;
  timeoutMs: number;
}

// ============================================================
// Defaults
// ============================================================

const HOME = process.env["HOME"] ?? "/tmp";

function defaultConfig(): DaemonConfig {
  // Auto-detect workspace: look for .openclaw dir
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
      file_freshness: {
        enabled: true,
        targets: [
          // Auto-discovered based on common OpenClaw files
        ],
      },
      service_health: {
        enabled: true,
        endpoints: [],
      },
      disk_usage: {
        enabled: true,
        warnPercent: 85,
        critPercent: 95,
      },
      gateway_alive: {
        enabled: true,
      },
      plugin_loading: {
        enabled: true,
      },
    },
  };
}

// ============================================================
// Check Implementations
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
  // Try openclaw-gateway first, then openclaw
  for (const pattern of ["openclaw-gateway", "openclaw"]) {
    try {
      const output = execFileSync("pgrep", ["-f", pattern], {
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
      if (output) {
        return check("gateway_alive", "ok", `Gateway process found (PID: ${output.split("\n")[0]})`);
      }
    } catch {
      // pgrep exits non-zero when no match — continue
    }
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
    // Take last line (skip header)
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

/**
 * TCP probe using Node.js net module — no shell involved.
 */
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

/**
 * HTTP probe using execFileSync with curl (no shell interpolation).
 */
function httpProbe(url: string, timeoutMs: number): boolean {
  try {
    execFileSync("curl", ["-sf", "--max-time", String(Math.ceil(timeoutMs / 1000)), url], {
      timeout: timeoutMs + 2000,
      stdio: "ignore",
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
      // Validate host/port to prevent any funny business
      if (!/^[\w.\-]+$/.test(ep.host) || ep.port < 1 || ep.port > 65535) {
        results.push(check(`service:${ep.name}`, "warn", `Invalid host/port: ${ep.host}:${ep.port}`));
        continue;
      }
      // TCP probe is async — use sync wrapper for daemon context
      // Fall back to execFileSync with timeout utility (no shell)
      try {
        execFileSync("node", ["-e",
          `const s=require("net").createConnection({host:${JSON.stringify(ep.host)},port:${ep.port}},()=>{s.destroy();process.exit(0)});s.setTimeout(${ep.timeoutMs});s.on("timeout",()=>{s.destroy();process.exit(1)});s.on("error",()=>{s.destroy();process.exit(1)})`
        ], { timeout: ep.timeoutMs + 2000, stdio: "ignore" });
        results.push(check(`service:${ep.name}`, "ok", `${ep.name} reachable at ${ep.host}:${ep.port}`));
      } catch {
        results.push(check(`service:${ep.name}`, "warn", `${ep.name} unreachable at ${ep.host}:${ep.port}`));
      }
    }
  }
  return results;
}

function autoDiscoverFreshnessTargets(workspace: string): FreshnessTarget[] {
  const targets: FreshnessTarget[] = [];
  const candidates = [
    { rel: "BOOTSTRAP.md", name: "boot-context", warnHours: 4, critHours: 8 },
    { rel: "memory/reboot/threads.json", name: "threads", warnHours: 24, critHours: 48 },
    { rel: "memory/reboot/decisions.json", name: "decisions", warnHours: 24, critHours: 48 },
    { rel: "memory/reboot/goals.json", name: "goals", warnHours: 48, critHours: 96 },
  ];
  for (const c of candidates) {
    const full = join(workspace, c.rel);
    if (existsSync(full)) {
      targets.push({ name: c.name, path: full, warnHours: c.warnHours, critHours: c.critHours });
    }
  }
  return targets;
}

// ============================================================
// Main
// ============================================================

function runDaemon(cfg: DaemonConfig): StatusFile {
  const checks: DaemonCheck[] = [];

  // Auto-discover freshness targets if none configured
  const freshnessTargets = cfg.checks.file_freshness.targets.length > 0
    ? cfg.checks.file_freshness.targets
    : autoDiscoverFreshnessTargets(cfg.workspace);

  if (cfg.checks.file_freshness.enabled && freshnessTargets.length > 0) {
    checks.push(...checkFileFreshness(freshnessTargets));
  }

  if (cfg.checks.gateway_alive.enabled) {
    checks.push(checkGatewayAlive());
  }

  if (cfg.checks.plugin_loading.enabled) {
    checks.push(checkPluginLoading());
  }

  if (cfg.checks.disk_usage.enabled) {
    checks.push(checkDiskUsage(cfg.checks.disk_usage.warnPercent, cfg.checks.disk_usage.critPercent));
  }

  if (cfg.checks.service_health.enabled && cfg.checks.service_health.endpoints.length > 0) {
    checks.push(...checkServiceHealth(cfg.checks.service_health.endpoints));
  }

  // Compute overall severity
  let overall: "ok" | "warn" | "critical" = "ok";
  for (const c of checks) {
    if (c.severity === "critical") { overall = "critical"; break; }
    if (c.severity === "warn") overall = "warn";
  }

  return {
    last_check: now(),
    overall_severity: overall,
    daemon_checks: checks,
    cognitive_checks: [],
    auto_heal_history: [],
  };
}

function loadDaemonConfig(configPath?: string): DaemonConfig {
  const cfg = defaultConfig();
  if (configPath && existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (raw.statusPath) cfg.statusPath = raw.statusPath;
      if (raw.workspace) cfg.workspace = raw.workspace;
      if (raw.watchIntervalMin) cfg.watchIntervalMin = raw.watchIntervalMin;
      // Merge checks config...
      if (raw.checks?.file_freshness?.targets) {
        cfg.checks.file_freshness.targets = raw.checks.file_freshness.targets;
      }
      if (raw.checks?.service_health?.endpoints) {
        cfg.checks.service_health.endpoints = raw.checks.service_health.endpoints;
      }
    } catch {
      console.error(`[leuko-daemon] Failed to parse config at ${configPath}`);
    }
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
  runDaemon,
  loadDaemonConfig,
  writeStatus,
  defaultConfig,
  checkFileFreshness,
  checkGatewayAlive,
  checkPluginLoading,
  checkDiskUsage,
  checkServiceHealth,
  autoDiscoverFreshnessTargets,
  httpProbe,
  tcpProbe,
  check,
  hoursAgo,
};

export type { DaemonCheck, StatusFile, DaemonConfig, FreshnessTarget, ServiceEndpoint };

// ============================================================
// CLI
// ============================================================

export function main(argv: string[] = process.argv.slice(2)): void {
  const watchMode = argv.includes("--watch");
  const configIdx = argv.indexOf("--config");
  const configPath = configIdx >= 0 ? argv[configIdx + 1] : undefined;

  const cfg = loadDaemonConfig(configPath);

  // Validate watch interval
  if (cfg.watchIntervalMin < 1) cfg.watchIntervalMin = 1;
  if (cfg.watchIntervalMin > 1440) cfg.watchIntervalMin = 1440;

  console.log(`[leuko-daemon] Workspace: ${cfg.workspace}`);
  console.log(`[leuko-daemon] Status output: ${cfg.statusPath}`);

  function tick() {
    const t0 = Date.now();
    const status = runDaemon(cfg);
    writeStatus(status, cfg.statusPath);
    const ms = Date.now() - t0;
    const warn = status.daemon_checks.filter(c => c.severity === "warn").length;
    const crit = status.daemon_checks.filter(c => c.severity === "critical").length;
    console.log(`[leuko-daemon] ${status.overall_severity.toUpperCase()} — ${status.daemon_checks.length} checks (${warn} warn, ${crit} crit) in ${ms}ms`);
  }

  tick();

  if (watchMode) {
    console.log(`[leuko-daemon] Watch mode: running every ${cfg.watchIntervalMin} minutes`);
    setInterval(tick, cfg.watchIntervalMin * 60 * 1000);
  }
}

// Only run CLI when executed directly (not imported for tests)
const isDirectExecution = process.argv[1]?.endsWith("daemon/index.js") ||
  process.argv[1]?.endsWith("daemon/index.ts") ||
  process.argv[1]?.endsWith("leuko-daemon");

if (isDirectExecution) {
  main();
}
