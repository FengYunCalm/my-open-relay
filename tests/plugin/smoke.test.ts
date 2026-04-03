import { describe, expect, it } from "vitest";
import * as plugin from "@opencode-peer-session-relay/relay-plugin";

describe("relay plugin package", () => {
  it("resolves the plugin entrypoint", () => {
    expect(plugin).toBeDefined();
    expect(typeof plugin.RelayPlugin).toBe("function");
  });
});
