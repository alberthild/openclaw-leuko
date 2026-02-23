# Changelog

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
