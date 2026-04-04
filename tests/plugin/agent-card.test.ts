import { describe, expect, it } from "vitest";

import { buildRelayAgentCard, isRelayPairAllowed, resolveRelayPluginConfig, validateLocalAuth } from "../support/relay-plugin-testkit.js";

describe("relay agent card", () => {
  it("builds an A2A agent card from plugin config", () => {
    const config = resolveRelayPluginConfig({
      configPath: "C:/does-not-exist/opencode-a2a-relay.config.json",
      a2a: { host: "127.0.0.1", port: 7331, basePath: "/a2a" }
    });
    const card = buildRelayAgentCard({ config });

    expect(card.url).toBe("http://127.0.0.1:7331/a2a");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.securitySchemes[0]?.type).toBe("noauth");
  });

  it("accepts noauth local validation", () => {
    const config = resolveRelayPluginConfig({ configPath: "C:/does-not-exist/opencode-a2a-relay.config.json" });
    const card = buildRelayAgentCard({ config });

    expect(validateLocalAuth(card.securitySchemes, {})).toBe(true);
  });

  it("enforces pair-only routing when configured", () => {
    const config = resolveRelayPluginConfig({
      configPath: "C:/does-not-exist/opencode-a2a-relay.config.json",
      routing: {
        mode: "pair",
        pairs: [
          {
            sourceSessionID: "session-a",
            targetSessionID: "session-b",
            bidirectional: true
          }
        ]
      }
    });

    expect(isRelayPairAllowed(config, "session-a", "session-b")).toBe(true);
    expect(isRelayPairAllowed(config, "session-b", "session-a")).toBe(true);
    expect(isRelayPairAllowed(config, "session-a", "session-c")).toBe(false);
    expect(isRelayPairAllowed(config, undefined, "session-b")).toBe(false);
  });
});
