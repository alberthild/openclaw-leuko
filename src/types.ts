// ============================================================
// OpenClaw Plugin API Types (contract — subset we use)
// ============================================================

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export interface PluginApi {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerTool(tool: ToolDefinition): void;
  registerCommand(command: PluginCommand): void;
  on(
    hookName: string,
    handler: (...args: unknown[]) => unknown | Promise<unknown>,
    opts?: { priority?: number },
  ): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

export interface PluginCommand {
  name: string;
  description: string;
  handler(
    args?: Record<string, unknown>,
  ): { text: string } | Promise<{ text: string }>;
}

// ============================================================
// Severity
// ============================================================

export type Severity = "ok" | "warn" | "critical";

// ============================================================
// Cognitive Check Result
// ============================================================

export interface CognitiveCheckResult {
  check_name: string;
  severity: Severity;
  detail: string;
  findings?: ReadonlyArray<CheckFinding>;
  correlations?: ReadonlyArray<CorrelationEntry>;
  anomalies?: ReadonlyArray<AnomalyEntry>;
  baselines?: Record<string, number>;
  recommendations?: ReadonlyArray<Recommendation>;
  escalation_needed?: boolean;
  consecutive_critical_count?: number;
  first_critical_at?: string;
  timestamp: string;
  model_used?: string;
  tokens_used?: number;
  duration_ms: number;
}

export interface CheckFinding {
  item_id?: string;
  thread_id?: string;
  issue: string;
  detail: string;
  recommendation?: string;
  days_since_update?: number;
  line?: string;
}

export interface CorrelationEntry {
  input: string;
  input_value: number;
  output: string;
  output_value: number;
  diagnosis: string;
}

export interface AnomalyEntry {
  metric: string;
  current: number;
  baseline: number;
  deviation: string;
  severity: Severity;
}

export interface Recommendation {
  type: string;
  target: string;
  reason: string;
  priority: "low" | "medium" | "high";
}

// ============================================================
// Cognitive Meta
// ============================================================

export interface CognitiveMeta {
  last_run: string;
  total_duration_ms: number;
  total_tokens: number;
  total_cost_usd: number;
  model: string;
  checks_completed: number;
  checks_failed: number;
  plugin_version: string;
}

// ============================================================
// Daemon Check (from L1)
// ============================================================

export interface DaemonCheck {
  check_name: string;
  severity: Severity;
  detail: string;
  auto_healed: boolean;
  timestamp: string;
  heal_action?: string | null;
  heal_key?: string | null;
}

// ============================================================
// Leuko Status File
// ============================================================

export interface LeukoStatus {
  last_check: string;
  overall_severity: Severity;
  daemon_checks: DaemonCheck[];
  auto_heal_history?: unknown[];
  cognitive_checks?: CognitiveCheckResult[];
  cognitive_meta?: CognitiveMeta;
  sitrep_collectors?: SitrepCollectorResult[];
}

// ============================================================
// Sitrep Collector (adopted)
// ============================================================

export interface SitrepCollectorResult {
  collector_name: string;
  status: Severity;
  items: ReadonlyArray<Record<string, unknown>>;
  summary: string;
  duration_ms: number;
  timestamp: string;
}

// ============================================================
// LLM Config
// ============================================================

export interface LlmProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  timeoutSec: number;
  apiKey?: string;
  maxCostUsd?: number;
}

export interface LlmConfig {
  primary: LlmProviderConfig;
  fallback: LlmProviderConfig;
}

// ============================================================
// Check-Specific Configs
// ============================================================

export interface GoalQualityCheckConfig {
  enabled: boolean;
  inputPath: string;
  usesLlm: boolean;
}

export interface ThreadHealthCheckConfig {
  enabled: boolean;
  inputPath: string;
  usesLlm: boolean;
  staleDays: number;
}

export interface PipelineCorrelationCheckConfig {
  enabled: boolean;
  usesLlm: boolean;
  natsStream: string;
  correlationWindowHours: number;
  businessHours: { start: number; end: number; tz: string };
}

export interface AnomalyDetectionCheckConfig {
  enabled: boolean;
  usesLlm: boolean;
  monitoredDirs: ReadonlyArray<{ path: string; label: string }>;
}

export interface BootstrapIntegrityCheckConfig {
  enabled: boolean;
  inputPath: string;
  usesLlm: boolean;
}

export interface RecommendationsCheckConfig {
  enabled: boolean;
  usesLlm: boolean;
  maxRecommendations: number;
}

export interface ChecksConfig {
  goal_quality: GoalQualityCheckConfig;
  thread_health: ThreadHealthCheckConfig;
  pipeline_correlation: PipelineCorrelationCheckConfig;
  anomaly_detection: AnomalyDetectionCheckConfig;
  bootstrap_integrity: BootstrapIntegrityCheckConfig;
  recommendations: RecommendationsCheckConfig;
}

// ============================================================
// Adopted Collectors Config
// ============================================================

export interface ErrorsCollectorConfig {
  enabled: boolean;
  patternsPath: string;
  recentHours: number;
}

export interface CustomCollectorEntry {
  name: string;
  command: string;
  warnThreshold?: number;
  criticalThreshold?: number;
}

export interface AdoptedCollectorsConfig {
  errors: ErrorsCollectorConfig;
  custom: CustomCollectorEntry[];
}

// ============================================================
// Health Injection Config
// ============================================================

export interface HealthInjectionConfig {
  enabled: boolean;
  onlyOnIssues: boolean;
  maxLength: number;
}

// ============================================================
// Full Plugin Config
// ============================================================

export interface LeukoConfig {
  enabled: boolean;
  statusPath: string;
  historyPath: string;
  intervalMinutes: number;
  runTimeoutSec: number;
  llm: LlmConfig;
  checks: ChecksConfig;
  adoptedCollectors: AdoptedCollectorsConfig;
  healthInjection: HealthInjectionConfig;
}

// ============================================================
// LLM Client Interface (injectable for testing)
// ============================================================

export interface LlmClient {
  generate(
    systemPrompt: string,
    userPrompt: string,
    timeoutMs: number,
  ): Promise<LlmResponse>;
}

export interface LlmResponse {
  content: string | null;
  model: string;
  tokens: number;
  durationMs: number;
  error?: string;
}

// ============================================================
// Goal / Thread data shapes (from cortex files)
// ============================================================

export interface PendingGoal {
  id: string;
  title: string;
  proposed_action?: string;
  proposed_at?: string;
  expires?: string;
  status?: string;
  priority?: string;
  category?: string;
  [key: string]: unknown;
}

export interface ThreadEntry {
  id: string;
  title: string;
  status: string;
  summary?: string;
  description?: string;
  last_activity?: string;
  created?: string;
  priority?: string;
  decisions?: string[];
  waiting_for?: string | null;
  [key: string]: unknown;
}

export interface ThreadsFile {
  version?: number;
  updated?: string;
  threads: ThreadEntry[];
}

// ============================================================
// History file
// ============================================================

export interface HistorySnapshot {
  timestamp: string;
  metrics: Record<string, number>;
}

export interface LeukoHistory {
  snapshots: HistorySnapshot[];
}
