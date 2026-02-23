import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLlmClient } from "../src/llm-client.js";
import type { LlmProviderConfig, PluginLogger } from "../src/types.js";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";

function mockLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const primaryConfig: LlmProviderConfig = {
  provider: "ollama",
  model: "qwen3:14b",
  baseUrl: "http://127.0.0.1:0", // will be replaced with actual port
  timeoutSec: 5,
};

const fallbackConfig: LlmProviderConfig = {
  provider: "litellm",
  model: "gemini/flash",
  baseUrl: "http://127.0.0.1:0",
  timeoutSec: 5,
};

function createMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("LlmClient", () => {
  let servers: Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await closeServer(s);
    }
    servers = [];
  });

  it("returns content from primary provider", async () => {
    const { server, port } = await createMockServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"severity":"ok","detail":"Fine"}' } }],
          usage: { total_tokens: 150 },
        }));
      });
    });
    servers.push(server);

    const client = createLlmClient(
      { ...primaryConfig, baseUrl: `http://127.0.0.1:${port}` },
      fallbackConfig,
      mockLogger(),
    );

    const result = await client.generate("system", "user prompt", 5000);
    expect(result.content).toContain("severity");
    expect(result.model).toBe("ollama/qwen3:14b");
    expect(result.tokens).toBe(150);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("falls back when primary fails", async () => {
    // Primary: returns error
    const { server: primary, port: primaryPort } = await createMockServer((req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });
    servers.push(primary);

    // Fallback: succeeds
    const { server: fallback, port: fallbackPort } = await createMockServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"severity":"warn","detail":"Issue found"}' } }],
          usage: { total_tokens: 200 },
        }));
      });
    });
    servers.push(fallback);

    const logger = mockLogger();
    const client = createLlmClient(
      { ...primaryConfig, baseUrl: `http://127.0.0.1:${primaryPort}` },
      { ...fallbackConfig, baseUrl: `http://127.0.0.1:${fallbackPort}` },
      logger,
    );

    const result = await client.generate("system", "user", 5000);
    expect(result.content).toContain("warn");
    expect(result.model).toBe("litellm/gemini/flash");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns null content when both providers fail", async () => {
    const { server: s1, port: p1 } = await createMockServer((req, res) => {
      res.writeHead(500);
      res.end("Error");
    });
    servers.push(s1);

    const { server: s2, port: p2 } = await createMockServer((req, res) => {
      res.writeHead(500);
      res.end("Error");
    });
    servers.push(s2);

    const logger = mockLogger();
    const client = createLlmClient(
      { ...primaryConfig, baseUrl: `http://127.0.0.1:${p1}` },
      { ...fallbackConfig, baseUrl: `http://127.0.0.1:${p2}` },
      logger,
    );

    const result = await client.generate("system", "user", 5000);
    expect(result.content).toBeNull();
    expect(result.error).toBeTruthy();
    expect(result.tokens).toBe(0);
  });

  it("handles connection refused gracefully", async () => {
    // Use a port that nothing is listening on
    const client = createLlmClient(
      { ...primaryConfig, baseUrl: "http://127.0.0.1:59999" },
      { ...fallbackConfig, baseUrl: "http://127.0.0.1:59998" },
      mockLogger(),
    );

    const result = await client.generate("system", "user", 3000);
    expect(result.content).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("sends Authorization header when apiKey provided", async () => {
    let receivedAuth = "";
    const { server, port } = await createMockServer((req, res) => {
      receivedAuth = req.headers["authorization"] ?? "";
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { total_tokens: 10 },
        }));
      });
    });
    servers.push(server);

    const client = createLlmClient(
      { ...primaryConfig, baseUrl: `http://127.0.0.1:${port}`, apiKey: "test-api-key-12345" },
      fallbackConfig,
      mockLogger(),
    );

    await client.generate("system", "user", 5000);
    expect(receivedAuth).toBe("Bearer test-api-key-12345");
  });

  it("records duration across both attempts", async () => {
    const client = createLlmClient(
      { ...primaryConfig, baseUrl: "http://127.0.0.1:59999" },
      { ...fallbackConfig, baseUrl: "http://127.0.0.1:59998" },
      mockLogger(),
    );

    const result = await client.generate("system", "user", 2000);
    expect(result.durationMs).toBeGreaterThan(0);
  });
});
