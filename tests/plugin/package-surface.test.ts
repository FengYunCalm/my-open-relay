import { describe, expect, it } from "vitest";
import * as plugin from "@opencode-peer-session-relay/relay-plugin";

describe("relay plugin package surface", () => {
  it("only exposes the exact public plugin entry symbols", () => {
    expect(Object.keys(plugin).sort()).toEqual([
      "RelayPlugin",
      "pluginPackageName",
      "pluginVersion",
      "server"
    ]);
    expect(plugin.pluginPackageName).toBe("@opencode-peer-session-relay/relay-plugin");
    expect(plugin.pluginVersion).toBe("0.1.0");
    expect(typeof plugin.server).toBe("function");
  });
});
