import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import {
  RelayPlugin,
  SessionInjector,
  getRelayPluginStateForTest,
  stopRelayPlugin
} from "../support/relay-plugin-testkit.js";

function createPluginInput(projectID = "project-test"): PluginInput {
  return {
    client: {} as PluginInput["client"],
    project: {
      id: projectID,
      name: "relay-project",
      path: "C:/relay-project"
    } as PluginInput["project"],
    directory: "C:/relay-project",
    worktree: "C:/relay-project",
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as PluginInput["$"]
  };
}

afterEach(async () => {
  await stopRelayPlugin("project-test");
  await stopRelayPlugin("project-test-2");
});

describe("relay plugin bootstrap", () => {
  it("boots plugin runtime and tracks session status events", async () => {
    const hooks = await RelayPlugin(createPluginInput(), {
      a2a: { port: 0 }
    });

    expect(hooks.event).toBeTypeOf("function");

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: { type: "idle" }
        }
      } as never
    });

    const state = getRelayPluginStateForTest("project-test");
    expect(state).toBeDefined();
    expect(state?.sessionRegistry.get("session-1")?.status?.type).toBe("idle");
  });

  it("injector uses noReply context injection", async () => {
    const prompt = vi.fn().mockResolvedValue({ data: true });
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const injector = new SessionInjector({
      session: {
        prompt,
        promptAsync
      }
    });

    await injector.injectAnchor("session-1", "relay anchor");
    await injector.injectAsync("session-1", "relay anchor async");

    expect(prompt).toHaveBeenCalledWith({
      path: { id: "session-1" },
      body: {
        noReply: true,
        system: undefined,
        parts: [{ type: "text", text: "relay anchor" }]
      }
    });
    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: "session-1" },
      body: {
        noReply: true,
        system: undefined,
        parts: [{ type: "text", text: "relay anchor async" }]
      }
    });
  });

  it("compaction hook preserves relay context summary", async () => {
    const hooks = await RelayPlugin(createPluginInput("project-test-2"), {
      a2a: { port: 0 }
    });

    const output = { context: [] as string[] };
    await hooks["experimental.session.compacting"]?.({ sessionID: "session-2" }, output);

    expect(output.context.join("\n")).toContain("Relay Context");
    expect(output.context.join("\n")).toContain("session-2");
  });
});
