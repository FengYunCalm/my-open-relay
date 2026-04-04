import { describe, expect, it } from "vitest";

import localPlugin from "../../packages/relay-plugin/src/local-plugin.ts";

describe("local plugin entry", () => {
  it("exports a default object with id and server for OpenCode 1.3.6", () => {
    expect(localPlugin).toMatchObject({
      id: "opencode-a2a-relay"
    });
    expect(typeof localPlugin.server).toBe("function");
  });
});
