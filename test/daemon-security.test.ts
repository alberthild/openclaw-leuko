import { describe, it, expect } from "vitest";
import { checkServiceHealth, tcpProbeSync } from "../src/daemon/index.js";

describe("shell injection prevention", () => {
  it("rejects semicolon in host", () => {
    const r = checkServiceHealth([
      { name: "x", type: "tcp", host: "127.0.0.1;cat /etc/passwd", port: 80, timeoutMs: 500 },
    ]);
    expect(r[0]!.detail).toContain("Invalid");
  });

  it("rejects backtick injection", () => {
    const r = checkServiceHealth([
      { name: "x", type: "tcp", host: "`id`", port: 80, timeoutMs: 500 },
    ]);
    expect(r[0]!.detail).toContain("Invalid");
  });

  it("rejects dollar injection", () => {
    const r = checkServiceHealth([
      { name: "x", type: "tcp", host: "$(whoami)", port: 80, timeoutMs: 500 },
    ]);
    expect(r[0]!.detail).toContain("Invalid");
  });

  it("allows valid hostnames", () => {
    const r = checkServiceHealth([
      { name: "v", type: "tcp", host: "my-server.example.com", port: 59998, timeoutMs: 500 },
    ]);
    expect(r[0]!.detail).not.toContain("Invalid");
  });
});

describe("tcpProbeSync() type validation", () => {
  it("rejects non-integer port", () => {
    expect(tcpProbeSync("localhost", 80.5, 1000)).toBe(false);
  });

  it("rejects string-as-port", () => {
    expect(tcpProbeSync("localhost", "80;evil" as unknown as number, 1000)).toBe(false);
  });

  it("rejects negative port", () => {
    expect(tcpProbeSync("localhost", -1, 1000)).toBe(false);
  });

  it("rejects port > 65535", () => {
    expect(tcpProbeSync("localhost", 70000, 1000)).toBe(false);
  });

  it("rejects non-integer timeout", () => {
    expect(tcpProbeSync("localhost", 80, "fast" as unknown as number)).toBe(false);
  });
});
