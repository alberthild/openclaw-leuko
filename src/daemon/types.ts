/** Leuko L1 Daemon — Shared types */

export interface DaemonCheck {
  check_name: string;
  severity: "ok" | "warn" | "critical";
  detail: string;
  auto_healed: boolean;
  timestamp: string;
  heal_action: string | null;
  heal_key: string | null;
}

export interface StatusFile {
  last_check: string;
  overall_severity: "ok" | "warn" | "critical";
  daemon_checks: DaemonCheck[];
  cognitive_checks: never[];
  auto_heal_history: never[];
}

export interface DaemonConfig {
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

export interface FreshnessTarget {
  name: string;
  path: string;
  warnHours: number;
  critHours: number;
}

export interface ServiceEndpoint {
  name: string;
  type: "http" | "tcp";
  url?: string;
  host?: string;
  port?: number;
  timeoutMs: number;
}
