import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import type { LlmClient, LlmResponse, LlmProviderConfig, PluginLogger } from "./types.js";

/**
 * Call an OpenAI-compatible chat completions endpoint (Ollama or LiteLLM).
 * Returns parsed JSON response content or null on failure.
 */
function callChatCompletion(
  config: LlmProviderConfig,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
  logger: PluginLogger,
): Promise<{ content: string | null; tokens: number; error?: string }> {
  return new Promise((resolve) => {
    const startMs = Date.now();
    try {
      // baseUrl may already include /v1 — normalize
      const base = config.baseUrl.replace(/\/+$/, "");
      const endpoint = base.endsWith("/v1")
        ? `${base}/chat/completions`
        : `${base}/v1/chat/completions`;

      const url = new URL(endpoint);
      const body = JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: "json_object" },
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      };
      if (config.apiKey) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
      }

      const proto = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = proto(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname,
          method: "POST",
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => {
            try {
              const parsed: unknown = JSON.parse(data);
              if (typeof parsed === "object" && parsed !== null) {
                const obj = parsed as Record<string, unknown>;
                const choices = obj["choices"];
                if (Array.isArray(choices) && choices.length > 0) {
                  const firstChoice = choices[0] as Record<string, unknown> | undefined;
                  const message = firstChoice?.["message"] as Record<string, unknown> | undefined;
                  const content = message?.["content"];
                  const usage = obj["usage"] as Record<string, unknown> | undefined;
                  const tokens =
                    typeof usage?.["total_tokens"] === "number"
                      ? usage["total_tokens"]
                      : 0;
                  resolve({
                    content: typeof content === "string" ? content : null,
                    tokens,
                  });
                  return;
                }
              }
              resolve({ content: null, tokens: 0, error: "Invalid response structure" });
            } catch {
              resolve({ content: null, tokens: 0, error: "Failed to parse LLM response JSON" });
            }
          });
        },
      );

      req.on("error", (err: Error) => {
        logger.debug(`[leuko-llm] Request error: ${err.message}`);
        resolve({ content: null, tokens: 0, error: err.message });
      });

      req.on("timeout", () => {
        req.destroy();
        const elapsed = Date.now() - startMs;
        logger.debug(`[leuko-llm] Timeout after ${elapsed}ms`);
        resolve({ content: null, tokens: 0, error: `Timeout after ${elapsed}ms` });
      });

      req.write(body);
      req.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ content: null, tokens: 0, error: msg });
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
    async generate(
      systemPrompt: string,
      userPrompt: string,
      timeoutMs: number,
    ): Promise<LlmResponse> {
      const startMs = Date.now();

      // Try primary
      const primaryResult = await callChatCompletion(
        primary,
        systemPrompt,
        userPrompt,
        timeoutMs,
        logger,
      );

      if (primaryResult.content !== null) {
        return {
          content: primaryResult.content,
          model: `${primary.provider}/${primary.model}`,
          tokens: primaryResult.tokens,
          durationMs: Date.now() - startMs,
        };
      }

      logger.warn(
        `[leuko-llm] Primary (${primary.provider}/${primary.model}) failed: ${primaryResult.error ?? "unknown"} — trying fallback`,
      );

      // Try fallback
      const fallbackResult = await callChatCompletion(
        fallback,
        systemPrompt,
        userPrompt,
        timeoutMs,
        logger,
      );

      if (fallbackResult.content !== null) {
        return {
          content: fallbackResult.content,
          model: `${fallback.provider}/${fallback.model}`,
          tokens: fallbackResult.tokens,
          durationMs: Date.now() - startMs,
        };
      }

      logger.warn(
        `[leuko-llm] Fallback (${fallback.provider}/${fallback.model}) also failed: ${fallbackResult.error ?? "unknown"}`,
      );

      return {
        content: null,
        model: `${primary.provider}/${primary.model}`,
        tokens: 0,
        durationMs: Date.now() - startMs,
        error: `Both providers failed. Primary: ${primaryResult.error ?? "unknown"}; Fallback: ${fallbackResult.error ?? "unknown"}`,
      };
    },
  };
}
