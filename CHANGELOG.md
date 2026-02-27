# Changelog

## [0.2.0] — 2026-02-27

### Added
- **L1 Daemon** — Portable Node.js health monitor, zero external dependencies
  - 7 heuristic checks: file freshness, gateway alive, plugin loading, disk usage, service health (HTTP + TCP)
  - Auto-discovers workspace (`AGENTS.md` / `.openclaw/` detection)
  - CLI: `npx @vainplex/openclaw-leuko daemon [--watch] [--config <path>]`
  - Binary: `leuko-daemon` (via `bin` field in package.json)
  - Watch mode with configurable interval (1–1440 min), graceful shutdown (SIGTERM/SIGINT)
  - TCP probes via `net.createConnection` (no shell, no bash dependency)
  - HTTP probes via `execFileSync("curl", [...])` (no shell interpolation)
- `src/daemon/types.ts` — Shared type definitions for daemon checks, config, and status
- 43 new tests (34 daemon + 9 security) — 160 total

### Security
- No `execSync` anywhere — all subprocess calls use `execFileSync` (no shell)
- Host regex validation (`/^[\w.\-]+$/`) before any network probe
- `Number.isInteger()` validation on port and timeout before template interpolation
- `main()` guard prevents auto-execution on import (testable module)
- Gateway alive check filters own PID + PPID to prevent self-match false positives
- Config type-checking: `typeof` guards on all loaded values

### Changed
- Architecture diagram updated to show L1 ↔ L2 data flow

## [0.1.0] — 2026-02-23

### Added
- Initial release of `@vainplex/openclaw-leuko` — Cognitive Immune System Plugin
- 6 Cognitive Checks (CK-01 through CK-06):
  - CK-01: Goal Quality Assessment (LLM) — with pre-filter for expired/stale goals
  - CK-02: Thread Health Assessment (LLM) — with pre-filter for stale threads
  - CK-03: Pipeline Correlation (deterministic) — NATS/thread/cron cross-referencing
  - CK-04: Anomaly Detection (deterministic) — directory size and metric trend analysis
  - CK-05: Bootstrap Integrity (LLM) — BOOTSTRAP.md factual verification
  - CK-06: Recommendations (LLM) — proactive housekeeping suggestions
- `leuko_status` tool for agent health queries (sections: summary, daemon, cognitive, recommendations, all)
- `/leuko` command (subcommands: refresh, detail, config)
- `before_agent_start` hook for health context injection
- External config pattern (`~/.openclaw/plugins/openclaw-leuko/config.json`)
- LLM client with primary (Ollama) + fallback (LiteLLM) support
- Atomic write protocol for `leuko-status.json` (preserves daemon fields)
- Consecutive-critical tracking with `escalation_needed` flag
- Fail-open behavior: LLM failures default to `severity: "ok"`
- Adopted Sitrep `errors` and `custom` collector config (implementation deferred to v0.2.0)

### Replaces
- `@vainplex/openclaw-sitrep` (deprecated) — absorbed goals/threads pre-filtering, dropped redundant collectors
