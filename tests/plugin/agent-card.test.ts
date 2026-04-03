import { describe, expect, it } from "vitest";

import { buildRelayAgentCard, resolveRelayPluginConfig, validateLocalAuth } from "../support/relay-plugin-testkit.js";

describe("relay agent card", () => {
  it("builds an A2A agent card from plugin config", () => {
    const config = resolveRelayPluginConfig({ a2a: { host: "127.0.0.1", port: 7331, basePath: "/a2a" } });
    const card = buildRelayAgentCard({ config });

    expect(card.url).toBe("http://127.0.0.1:7331/a2a");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.securitySchemes[0]?.type).toBe("noauth");
  });

  it("accepts noauth local validation", () => {
    const config = resolveRelayPluginConfig();
    const card = buildRelayAgentCard({ config });

    expect(validateLocalAuth(card.securitySchemes, {})).toBe(true);
  });
});
