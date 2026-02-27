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

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

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
  try {
    const output = execSync("pgrep -f openclaw-gateway || pgrep -f openclaw", {
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
    if (output) {
      return check("gateway_alive", "ok", `Gateway process found (PID: ${output.split("\n")[0]})`);
    }
    return check("gateway_alive", "critical", "No OpenClaw gateway process found");
  } catch {
    return check("gateway_alive", "critical", "No OpenClaw gateway process found");
  }
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
    const output = execSync("df -h / | tail -1", { timeout: 5000, encoding: "utf-8" }).trim();
    const match = output.match(/(\d+)%/);
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

function checkServiceHealth(endpoints: ServiceEndpoint[]): DaemonCheck[] {
  const results: DaemonCheck[] = [];
  for (const ep of endpoints) {
    if (ep.type === "http" && ep.url) {
      try {
        execSync(`curl -sf --max-time 3 "${ep.url}" > /dev/null 2>&1`, { timeout: 5000 });
        results.push(check(`service:${ep.name}`, "ok", `${ep.name} reachable`));
      } catch {
        results.push(check(`service:${ep.name}`, "warn", `${ep.name} unreachable at ${ep.url}`));
      }
    } else if (ep.type === "tcp" && ep.host && ep.port) {
      try {
        execSync(`timeout 3 bash -c 'echo > /dev/tcp/${ep.host}/${ep.port}' 2>/dev/null`, { timeout: 5000 });
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
// CLI
// ============================================================

const args = process.argv.slice(2);
const watchMode = args.includes("--watch");
const configIdx = args.indexOf("--config");
const configPath = configIdx >= 0 ? args[configIdx + 1] : undefined;

const cfg = loadDaemonConfig(configPath);

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
