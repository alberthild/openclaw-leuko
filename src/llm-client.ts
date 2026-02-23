import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import type { LlmClient, LlmResponse, LlmProviderConfig, PluginLogger } from "./types.js";

interface RawCompletion { content: string | null; tokens: number; error?: string }

function buildEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function buildRequestBody(model: string, system: string, user: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.1,
    max_tokens: 2048,
    response_format: { type: "json_object" },
  });
}

function parseCompletionResponse(data: string): RawCompletion {
  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== "object" || parsed === null) {
    return { content: null, tokens: 0, error: "Invalid response structure" };
  }
  const obj = parsed as Record<string, unknown>;
  const choices = obj["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return { content: null, tokens: 0, error: "Invalid response structure" };
  }
  const msg = (choices[0] as Record<string, unknown> | undefined)?.["message"];
  const content = (msg as Record<string, unknown> | undefined)?.["content"];
  const usage = obj["usage"] as Record<string, unknown> | undefined;
  const tokens = typeof usage?.["total_tokens"] === "number" ? usage["total_tokens"] : 0;
  return { content: typeof content === "string" ? content : null, tokens };
}

function sendHttpRequest(
  config: LlmProviderConfig,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
  logger: PluginLogger,
): Promise<RawCompletion> {
  return new Promise((resolve) => {
    try {
      const url = new URL(buildEndpoint(config.baseUrl));
      const body = buildRequestBody(config.model, systemPrompt, userPrompt);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      };
      if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

      const proto = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = proto({
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers,
        timeout: timeoutMs,
      }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          try { resolve(parseCompletionResponse(data)); }
          catch { resolve({ content: null, tokens: 0, error: "Failed to parse LLM response JSON" }); }
        });
      });
      req.on("error", (err: Error) => {
        logger.debug(`[leuko-llm] Request error: ${err.message}`);
        resolve({ content: null, tokens: 0, error: err.message });
      });
      req.on("timeout", () => {
        req.destroy();
        const elapsed = Date.now();
        logger.debug(`[leuko-llm] Timeout after ${elapsed}ms`);
        resolve({ content: null, tokens: 0, error: `Timeout after ${elapsed}ms` });
      });
      req.write(body);
      req.end();
    } catch (err) {
      resolve({ content: null, tokens: 0, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * Creates an LlmClient that tries the primary provider first,
 * then falls back to the fallback provider.
 */
export function createLlmClient(
  primary: LlmProviderConfig,
  fallback: LlmProviderConfig,
  logger: PluginLogger,
): LlmClient {
  return {
    async generate(systemPrompt, userPrompt, timeoutMs): Promise<LlmResponse> {
      const startMs = Date.now();

      const prim = await sendHttpRequest(primary, systemPrompt, userPrompt, timeoutMs, logger);
      if (prim.content !== null) {
        return { content: prim.content, model: `${primary.provider}/${primary.model}`, tokens: prim.tokens, durationMs: Date.now() - startMs };
      }

      logger.warn(`[leuko-llm] Primary (${primary.provider}/${primary.model}) failed: ${prim.error ?? "unknown"} — trying fallback`);
      const fb = await sendHttpRequest(fallback, systemPrompt, userPrompt, timeoutMs, logger);
      if (fb.content !== null) {
        return { content: fb.content, model: `${fallback.provider}/${fallback.model}`, tokens: fb.tokens, durationMs: Date.now() - startMs };
      }

      logger.warn(`[leuko-llm] Fallback (${fallback.provider}/${fallback.model}) also failed: ${fb.error ?? "unknown"}`);
      return {
        content: null,
        model: `${primary.provider}/${primary.model}`,
        tokens: 0,
        durationMs: Date.now() - startMs,
        error: `Both providers failed. Primary: ${prim.error ?? "unknown"}; Fallback: ${fb.error ?? "unknown"}`,
      };
    },
  };
}
