import { describe, expect, it } from "vitest";

import { concreteRelaySessionIDSchema, shouldInjectRelaySessionID } from "../../packages/relay-plugin/src/session-id.ts";

describe("relay session ID safeguards", () => {
  it("treats current as a plugin-side placeholder that should be replaced", () => {
    expect(shouldInjectRelaySessionID(undefined)).toBe(true);
    expect(shouldInjectRelaySessionID("current")).toBe(true);
    expect(shouldInjectRelaySessionID(" CURRENT ")).toBe(true);
    expect(shouldInjectRelaySessionID("session-a")).toBe(false);
  });

  it("rejects reserved current placeholders for direct relay MCP inputs", () => {
    expect(() => concreteRelaySessionIDSchema.parse("current")).toThrow(/reserved session placeholder/i);
    expect(() => concreteRelaySessionIDSchema.parse(" current ")).toThrow(/reserved session placeholder/i);
    expect(concreteRelaySessionIDSchema.parse("session-a")).toBe("session-a");
  });
});
