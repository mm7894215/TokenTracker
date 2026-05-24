import { describe, expect, it } from "vitest";

import { loadInsforgeServeConfig, resolveInsforgeBaseUrlForLocation } from "../insforge-config";

const REMOTE = "https://srctyff5.us-east.insforge.app";

function loc(url: string): Location {
  return new URL(url) as unknown as Location;
}

describe("resolveInsforgeBaseUrlForLocation", () => {
  it("uses the same-origin auth proxy for localhost and 127.0.0.1", () => {
    expect(resolveInsforgeBaseUrlForLocation(loc("http://localhost:7680/"), REMOTE)).toBe(
      "http://localhost:7680",
    );
    expect(resolveInsforgeBaseUrlForLocation(loc("http://127.0.0.1:7680/"), REMOTE)).toBe(
      "http://127.0.0.1:7680",
    );
  });

  it("uses the same-origin auth proxy for CLI-configured allowed hosts", () => {
    expect(
      resolveInsforgeBaseUrlForLocation(loc("https://agents.internal.test/dashboard"), REMOTE, [
        "agents.internal.test",
      ]),
    ).toBe("https://agents.internal.test");
  });

  it("loads CLI-configured allowed hosts from the same-origin dashboard config route", async () => {
    const fetchConfig = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/dashboard-config");
      expect(init?.credentials).toBe("same-origin");
      return new Response(JSON.stringify({ allowedHosts: ["configured.example.org"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await loadInsforgeServeConfig(fetchConfig as typeof fetch);

    expect(resolveInsforgeBaseUrlForLocation(loc("https://configured.example.org/dashboard"), REMOTE)).toBe(
      "https://configured.example.org",
    );
  });

  it("does not infer tunnel hostnames from hard-coded port-like prefixes", () => {
    expect(resolveInsforgeBaseUrlForLocation(loc("https://7680.unconfigured.internal.test/"), REMOTE)).toBe(
      REMOTE,
    );
  });

  it("keeps public deployments on the remote InsForge origin", () => {
    expect(resolveInsforgeBaseUrlForLocation(loc("https://www.tokentracker.cc/dashboard"), REMOTE)).toBe(
      REMOTE,
    );
  });
});
