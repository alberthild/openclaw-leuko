# @vainplex/openclaw-leuko

**Cognitive immune system for OpenClaw** — L2 semantic health checks with LLM analysis, tool exposure for agent queries, and Sitrep replacement.

Part of the [Vainplex OpenClaw Plugin Suite](https://github.com/alberthild/vainplex-openclaw).

## Architecture

Leuko operates as a **two-tier hybrid system**:

- **Level 1 (L1 Daemon):** Heuristic checks — file freshness, gateway alive, plugin loading, disk usage, service health. Runs every 15min, zero API cost. **Included in this package** since v0.2.0.
- **Level 2 (L2 Plugin):** Cognitive checks — semantic analysis via LLM + deterministic correlation. Runs every 2h or on-demand.

```
  L1 Daemon (Node.js)        Plugin (L2)                    Agents
        │                         │                           │
  ┌─ 7 heuristic checks          │                           │
  ├─ Write daemon_checks[]        │                           │
  │  to leuko-status.json         │                           │
  │                    ┌──────────┘                           │
  │                    ├─ Read daemon_checks[]                │
  │                    ├─ Run CK-01..CK-06 (4 LLM + 2 det.) │
  │                    ├─ Write cognitive_checks[]            │
  │                    │                                      │
  │                    ├── leuko_status tool ─────────────────┤
  │                    ├── before_agent_start hook ───────────┤
  │                    └── /leuko command ───────────────────→│
  │                                                           │
  └── npx leuko-daemon [--watch] (standalone)                 │
```

## L1 Daemon

The L1 daemon is a portable Node.js process that produces `leuko-status.json` — no Python, no NATS, no external dependencies required.

### Usage

```bash
# Run once
npx @vainplex/openclaw-leuko daemon

# Watch mode (re-check every 15min)
npx @vainplex/openclaw-leuko daemon --watch

# Custom config
npx @vainplex/openclaw-leuko daemon --config /path/to/daemon-config.json
```

Or via the `leuko-daemon` binary after global install:

```bash
npm install -g @vainplex/openclaw-leuko
leuko-daemon --watch
```

### L1 Checks

| Check | What it does |
|-------|-------------|
| File Freshness | Monitors key files (BOOTSTRAP.md, threads.json, etc.) for staleness |
| Gateway Alive | Verifies OpenClaw gateway process is running |
| Plugin Loading | Reads `openclaw.json` and counts enabled plugins |
| Disk Usage | Warns at configurable thresholds (default: 85% warn, 95% crit) |
| Service Health | HTTP/TCP probes for configured endpoints |

Auto-discovers workspace by looking for `.openclaw/` or `AGENTS.md`.

### Daemon Config

Optional JSON config file:

```json
{
  "statusPath": "~/.openclaw/leuko-status.json",
  "workspace": "~/clawd",
  "watchIntervalMin": 15,
  "checks": {
    "file_freshness": {
      "targets": [
        { "name": "boot-context", "path": "~/clawd/BOOTSTRAP.md", "warnHours": 4, "critHours": 8 }
      ]
    },
    "service_health": {
      "endpoints": [
        { "name": "nats", "type": "tcp", "host": "localhost", "port": 4222, "timeoutMs": 3000 },
        { "name": "ollama", "type": "http", "url": "http://localhost:11434/api/tags", "timeoutMs": 3000 }
      ]
    },
    "disk_usage": { "warnPercent": 85, "critPercent": 95 }
  }
}
```

If no config is provided, freshness targets are auto-discovered from the workspace.

## Quick Start

```bash
npm install @vainplex/openclaw-leuko
```

Add to `openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "openclaw-leuko": { "enabled": true }
    }
  }
}
```

The plugin will auto-create a default config at `~/.openclaw/plugins/openclaw-leuko/config.json` on first run.

## Cognitive Checks

| Check | ID | Type | Purpose |
|-------|-----|------|---------|
| Goal Quality | CK-01 | LLM | Are pending goals specific, actionable, non-redundant? |
| Thread Health | CK-02 | LLM | Are threads stale, duplicate, or accumulating? |
| Pipeline Correlation | CK-03 | Deterministic | Are inputs flowing to outputs? (NATS → threads) |
| Anomaly Detection | CK-04 | Deterministic | Statistical deviations in metrics and directory sizes |
| Bootstrap Integrity | CK-05 | LLM | Is BOOTSTRAP.md factually current? |
| Recommendations | CK-06 | LLM | Proactive housekeeping suggestions |

### Severity Levels

- **`ok`** — All checks pass, no issues detected
- **`warn`** — Issues found that should be reviewed
- **`critical`** — Significant problems requiring attention

## Tool: `leuko_status`

Agents can query system health:

```
leuko_status({ section: "summary" })
leuko_status({ section: "cognitive", severity_filter: "warn" })
leuko_status({ section: "recommendations" })
```

Sections: `summary` | `daemon` | `cognitive` | `recommendations` | `all`

## Command: `/leuko`

```
/leuko              — Health summary
/leuko refresh      — Trigger immediate L2 check cycle
/leuko detail       — All checks with findings
/leuko config       — Active configuration
```

## Hook: `before_agent_start`

When system health is degraded, injects a one-liner into the agent's context:

```
⚕️ Leuko Health: WARN — 2 issues: goal_quality (3/9 vague goals), facts (stale 48h)
```

Configurable: only injected when issues exist, respects maxLength.

## Configuration

Full config lives at `~/.openclaw/plugins/openclaw-leuko/config.json`:

```json
{
  "enabled": true,
  "statusPath": "~/clawd/memory/leuko-status.json",
  "intervalMinutes": 120,
  "llm": {
    "primary": {
      "provider": "ollama",
      "model": "qwen3:14b",
      "baseUrl": "http://localhost:11434",
      "timeoutSec": 30
    },
    "fallback": {
      "provider": "litellm",
      "model": "gemini/gemini-2.0-flash-lite",
      "baseUrl": "http://localhost:4000",
      "timeoutSec": 30
    }
  },
  "checks": {
    "goal_quality": { "enabled": true, "usesLlm": true },
    "thread_health": { "enabled": true, "staleDays": 5 },
    "pipeline_correlation": { "enabled": true },
    "anomaly_detection": { "enabled": true },
    "bootstrap_integrity": { "enabled": true },
    "recommendations": { "enabled": true, "maxRecommendations": 5 }
  }
}
```

## LLM Integration

- **Primary:** `ollama/qwen3:14b` (local, $0.00/run)
- **Fallback:** `gemini/gemini-2.0-flash-lite` via LiteLLM (~$0.002/run)
- **Budget:** ≤ $0.05 per run (30x margin)
- **Max 4 LLM calls per run** (CK-01, CK-02, CK-05, CK-06)
- **Fail-open:** If LLM unavailable, severity defaults to `ok` with explanatory detail

## Sitrep Deprecation

This plugin replaces `@vainplex/openclaw-sitrep`. Sitrep's `errors` and `custom` collectors are adopted; `systemd_timers`, `nats`, `goals`, `threads`, and `calendar` collectors are either absorbed into cognitive checks or dropped (covered by L1).

## Development

```bash
npm install
npm run build          # TypeScript compilation
npm run test           # Run all tests
npm run test:coverage  # Coverage report (>80% lines)
npm run typecheck      # Type checking only
```

## Standards

- TypeScript strict mode, `noUncheckedIndexedAccess`
- 0 `any` types
- ESM (`type: module`)
- 0 runtime dependencies (only `node:*` builtins)
- vitest for tests
- kebab-case filenames

## License

MIT
