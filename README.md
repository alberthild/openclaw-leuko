# @vainplex/openclaw-leuko

**Cognitive immune system for OpenClaw** — L2 semantic health checks with LLM analysis, tool exposure for agent queries, and Sitrep replacement.

Part of the [Vainplex OpenClaw Plugin Suite](https://github.com/alberthild/vainplex-openclaw).

## Architecture

Leuko operates as a **two-tier hybrid system**:

- **Level 1 (Python daemon):** Heuristic checks — file freshness, JSON validity, service connectivity, cron health. Runs every 15min, zero API cost.
- **Level 2 (This plugin):** Cognitive checks — semantic analysis via LLM + deterministic correlation. Runs every 2h or on-demand.

```
                  Plugin (L2)                    Agents
                       │                           │
  ┌─ Read daemon_checks[] from leuko-status.json   │
  ├─ Run CK-01..CK-06 (4 LLM + 2 deterministic)   │
  ├─ Write cognitive_checks[] to leuko-status.json  │
  │                                                 │
  ├── leuko_status tool ────────────────────────────┤
  ├── before_agent_start hook ──────────────────────┤
  └── /leuko command ──────────────────────────────→│
```

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
