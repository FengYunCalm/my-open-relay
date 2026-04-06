import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import {
  A2ARelayHost,
  RelayPlugin,
  SessionInjector,
  getRelayPluginStateForTest,
  stopRelayPlugin
} from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

function createPluginInput(projectID = "project-test"): PluginInput {
  return {
    client: {} as PluginInput["client"],
    project: {
      id: projectID,
      name: "relay-project",
      path: "C:/relay-project",
      worktree: "C:/relay-project",
      time: { created: Date.now() }
    } as unknown as PluginInput["project"],
    directory: "C:/relay-project",
    worktree: "C:/relay-project",
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as PluginInput["$"]
  };
}

afterEach(async () => {
  await stopRelayPlugin("project-test");
  await stopRelayPlugin("project-test-2");
  await stopRelayPlugin("project-test-3");
  await stopRelayPlugin("project-test-4");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
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

  it("injector separates silent injection from turn-starting submission", async () => {
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
    await injector.submitAsync("session-1", "relay submit async");

    expect(prompt).toHaveBeenCalledWith({
      path: { id: "session-1" },
      body: {
        noReply: true,
        system: undefined,
        parts: [{ type: "text", text: "relay anchor" }]
      }
    });
    expect(promptAsync).toHaveBeenNthCalledWith(1, {
      path: { id: "session-1" },
      body: {
        noReply: true,
        system: undefined,
        parts: [{ type: "text", text: "relay anchor async" }]
      }
    });
    expect(promptAsync).toHaveBeenNthCalledWith(2, {
      path: { id: "session-1" },
      body: {
        system: undefined,
        parts: [{ type: "text", text: "relay submit async" }]
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

  it("reuses a single relay instance across concurrent projects with the same config", async () => {
    const databasePath = createTestDatabaseLocation("bootstrap-shared-instance");
    dbLocations.push(databasePath);
    const startSpy = vi.spyOn(A2ARelayHost.prototype, "start").mockImplementation(async function () {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "http://127.0.0.1:7339/a2a";
    });

    const [hooksA, hooksB] = await Promise.all([
      RelayPlugin(createPluginInput("project-test-3"), { a2a: { port: 7339 }, runtime: { databasePath } }),
      RelayPlugin(createPluginInput("project-test-4"), { a2a: { port: 7339 }, runtime: { databasePath } })
    ]);

    expect(hooksA.tool).toBeDefined();
    expect(hooksB.tool).toBeDefined();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(getRelayPluginStateForTest("project-test-3")).toBe(getRelayPluginStateForTest("project-test-4"));

    startSpy.mockRestore();
  });
});
