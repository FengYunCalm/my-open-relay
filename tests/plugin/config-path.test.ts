import { describe, expect, it } from "vitest";

import { resolveInstalledConfigPathFromModuleUrl } from "../support/relay-plugin-testkit.js";

describe("relay plugin config path resolution", () => {
  it("converts Windows file URLs into usable config file paths", () => {
    const resolved = resolveInstalledConfigPathFromModuleUrl("file:///C:/relay/plugins/opencode-a2a-relay.js");

    expect(resolved).toBe(String.raw`C:\relay\plugins\opencode-a2a-relay.config.json`);
  });
});
