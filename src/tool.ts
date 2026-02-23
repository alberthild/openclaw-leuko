import type {
  PluginApi,
  LeukoConfig,
  LeukoStatus,
  Severity,
  ToolResult,
  CognitiveCheckResult,
  DaemonCheck,
} from "./types.js";
import { readStatusFile } from "./status-reader.js";

interface ToolParams {
  section?: string;
  severity_filter?: string;
}

function computeOverallSeverity(status: LeukoStatus): Severity {
  const allSeverities: Severity[] = [
    ...status.daemon_checks.map((c) => c.severity),
    ...(status.cognitive_checks ?? []).map((c) => c.severity),
  ];
  if (allSeverities.includes("critical")) return "critical";
  if (allSeverities.includes("warn")) return "warn";
  return "ok";
}

function countBySeverity(
  checks: ReadonlyArray<{ severity: Severity }>,
): { total: number; ok: number; warn: number; critical: number } {
  let ok = 0;
  let warn = 0;
  let critical = 0;
  for (const c of checks) {
    if (c.severity === "ok") ok++;
    else if (c.severity === "warn") warn++;
    else if (c.severity === "critical") critical++;
  }
  return { total: checks.length, ok, warn, critical };
}

function filterBySeverity<T extends { severity: Severity }>(
  items: ReadonlyArray<T>,
  filter: string | undefined,
): ReadonlyArray<T> {
  if (!filter || filter === "all") return items;
  if (filter === "critical") return items.filter((i) => i.severity === "critical");
  if (filter === "warn") return items.filter((i) => i.severity === "warn" || i.severity === "critical");
  return items;
}

interface TopIssue {
  source: string;
  severity: Severity;
  detail: string;
}

function getTopIssues(status: LeukoStatus): TopIssue[] {
  const issues: TopIssue[] = [];

  for (const c of status.daemon_checks) {
    if (c.severity !== "ok") {
      issues.push({ source: c.check_name, severity: c.severity, detail: c.detail });
    }
  }

  for (const c of status.cognitive_checks ?? []) {
    if (c.severity !== "ok") {
      issues.push({ source: c.check_name, severity: c.severity, detail: c.detail });
    }
  }

  // Sort critical first, then warn
  issues.sort((a, b) => {
    const order: Record<Severity, number> = { critical: 0, warn: 1, ok: 2 };
    return order[a.severity] - order[b.severity];
  });

  return issues.slice(0, 10);
}

function formatSummary(status: LeukoStatus): Record<string, unknown> {
  return {
    overall: computeOverallSeverity(status),
    daemon_summary: countBySeverity(status.daemon_checks),
    cognitive_summary: countBySeverity(status.cognitive_checks ?? []),
    top_issues: getTopIssues(status),
    recommendations: (status.cognitive_checks ?? [])
      .filter((c) => c.check_name === "cognitive:recommendations")
      .flatMap((c) => c.recommendations ?? []).length,
    last_l1_run: status.last_check,
    last_l2_run: status.cognitive_meta?.last_run ?? null,
  };
}

export function formatToolResponse(
  status: LeukoStatus | null,
  params: ToolParams,
): ToolResult {
  if (!status) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "Status file not available" }) }],
    };
  }

  const section = params.section ?? "summary";
  let result: unknown;

  switch (section) {
    case "summary":
      result = formatSummary(status);
      break;
    case "daemon":
      result = {
        daemon_checks: filterBySeverity(status.daemon_checks, params.severity_filter),
        last_check: status.last_check,
      };
      break;
    case "cognitive":
      result = {
        cognitive_checks: filterBySeverity(status.cognitive_checks ?? [], params.severity_filter),
        cognitive_meta: status.cognitive_meta,
      };
      break;
    case "recommendations":
      result = {
        recommendations: (status.cognitive_checks ?? [])
          .filter((c) => c.check_name === "cognitive:recommendations")
          .flatMap((c) => c.recommendations ?? []),
      };
      break;
    case "all":
      result = {
        ...formatSummary(status),
        daemon_checks: filterBySeverity(status.daemon_checks, params.severity_filter),
        cognitive_checks: filterBySeverity(status.cognitive_checks ?? [], params.severity_filter),
        sitrep_collectors: status.sitrep_collectors,
        cognitive_meta: status.cognitive_meta,
      };
      break;
    default:
      result = formatSummary(status);
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

export function registerLeukoTool(api: PluginApi, config: LeukoConfig): void {
  api.registerTool({
    name: "leuko_status",
    description:
      "Get current system health status from Leuko (L1 heuristic + L2 cognitive checks)",
    parameters: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["all", "daemon", "cognitive", "summary", "recommendations"],
          description:
            "Which section of health data to return (default: summary)",
        },
        severity_filter: {
          type: "string",
          enum: ["all", "warn", "critical"],
          description:
            "Filter results by minimum severity (default: all)",
        },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const status = readStatusFile(config.statusPath, api.logger);
      return formatToolResponse(status, {
        section: typeof params["section"] === "string" ? params["section"] : undefined,
        severity_filter: typeof params["severity_filter"] === "string" ? params["severity_filter"] : undefined,
      });
    },
  });
}
