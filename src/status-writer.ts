import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CognitiveCheckResult,
  CognitiveMeta,
  SitrepCollectorResult,
  PluginLogger,
} from "./types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface WritePayload {
  cognitive_checks: CognitiveCheckResult[];
  cognitive_meta: CognitiveMeta;
  sitrep_collectors?: SitrepCollectorResult[];
}

/**
 * Atomic write of cognitive check results to leuko-status.json.
 *
 * Preserves daemon_checks and auto_heal_history (L1 fields).
 * Uses write-to-tmp-then-rename for atomicity.
 */
export function writeCognitiveResults(
  statusPath: string,
  payload: WritePayload,
  logger?: PluginLogger,
): boolean {
  try {
    // Read existing status to preserve daemon fields
    let existing: Record<string, unknown> = {};
    if (existsSync(statusPath)) {
      try {
        const content = readFileSync(statusPath, "utf-8");
        const parsed: unknown = JSON.parse(content);
        if (isRecord(parsed)) {
          existing = parsed;
        }
      } catch {
        logger?.warn("[leuko] Could not read existing status file — will overwrite cognitive fields only");
      }
    }

    // Merge: preserve daemon fields, replace cognitive fields
    const merged: Record<string, unknown> = {
      ...existing,
      cognitive_checks: payload.cognitive_checks,
      cognitive_meta: payload.cognitive_meta,
    };

    if (payload.sitrep_collectors) {
      merged["sitrep_collectors"] = payload.sitrep_collectors;
    }

    // Atomic write via temp file
    const tmpPath = statusPath + ".l2tmp";
    const dir = dirname(statusPath);
    if (!existsSync(dir)) {
      logger?.warn(`[leuko] Status directory does not exist: ${dir}`);
      return false;
    }

    writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, statusPath);

    logger?.info(`[leuko] Wrote ${payload.cognitive_checks.length} cognitive checks to ${statusPath}`);
    return true;
  } catch (e) {
    logger?.error(
      `[leuko] Failed to write status: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
