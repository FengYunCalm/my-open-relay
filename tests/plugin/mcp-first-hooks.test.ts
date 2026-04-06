import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import { RelayPlugin, stopRelayPlugin } from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

function createPluginInput(projectID = "project-mcp-first-hooks", promptAsync = vi.fn().mockResolvedValue({ data: true })): PluginInput {
  return {
    client: {
      session: {
        prompt: vi.fn().mockResolvedValue({ data: true }),
        promptAsync
      }
    } as unknown as PluginInput["client"],
    project: {
      id: projectID,
      worktree: "C:/relay-project",
      time: { created: Date.now() }
    } as PluginInput["project"],
    directory: "C:/relay-project",
    worktree: "C:/relay-project",
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as PluginInput["$"]
  };
}

afterEach(async () => {
  await stopRelayPlugin("project-mcp-first-hooks");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("MCP-first relay hooks", () => {
  it("injects session-aware args for relay MCP tools", async () => {
    const databasePath = createTestDatabaseLocation("mcp-first-hooks");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput(), {
      a2a: { port: 0 },
      runtime: { databasePath }
    });

    const output = { args: { kind: "group" } as Record<string, unknown> };
    await hooks["tool.execute.before"]?.({ tool: "mcp__relay__room_create", sessionID: "session-a", callID: "call-1" }, output);
    expect(output.args.sessionID).toBe("session-a");

    const sendOutput = { args: { threadId: "thread-1", message: "hello" } as Record<string, unknown> };
    await hooks["tool.execute.before"]?.({ tool: "mcp__relay__message_send", sessionID: "session-a", callID: "call-2" }, sendOutput);
    expect(sendOutput.args.senderSessionID).toBe("session-a");
  });

  it("replaces reserved current placeholders with the active session for relay MCP tools", async () => {
    const databasePath = createTestDatabaseLocation("mcp-first-current-placeholder");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput(), {
      a2a: { port: 0 },
      runtime: { databasePath }
    });

    const joinOutput = { args: { roomCode: "123456", sessionID: "current" } as Record<string, unknown> };
    await hooks["tool.execute.before"]?.({ tool: "mcp__relay__room_join", sessionID: "session-a", callID: "call-3" }, joinOutput);
    expect(joinOutput.args.sessionID).toBe("session-a");

    const roleOutput = { args: { targetSessionID: "session-b", role: "member", actorSessionID: "current" } as Record<string, unknown> };
    await hooks["tool.execute.before"]?.({ tool: "mcp__relay__room_set_role", sessionID: "session-a", callID: "call-4" }, roleOutput);
    expect(roleOutput.args.actorSessionID).toBe("session-a");

    const markReadOutput = { args: { threadId: "thread-1", seq: 1, sessionID: " current " } as Record<string, unknown> };
    await hooks["tool.execute.before"]?.({ tool: "mcp__relay__message_mark_read", sessionID: "session-a", callID: "call-5" }, markReadOutput);
    expect(markReadOutput.args.sessionID).toBe("session-a");

    const threadListOutput = { args: { roomCode: "123456", sessionID: "current" } as Record<string, unknown> };
    await hooks["tool.execute.before"]?.({ tool: "mcp__relay__thread_list", sessionID: "session-a", callID: "call-6" }, threadListOutput);
    expect(threadListOutput.args.sessionID).toBe("session-a");

    const slashCreateOutput = { args: { kind: "private", sessionID: "/" } as Record<string, unknown> };
    await hooks["tool.execute.before"]?.({ tool: "mcp__relay__room_create", sessionID: "session-a", callID: "call-7" }, slashCreateOutput);
    expect(slashCreateOutput.args.sessionID).toBe("session-a");

    const slashMessageOutput = { args: { threadId: "thread-1", message: "hello", senderSessionID: " / " } as Record<string, unknown> };
    await hooks["tool.execute.before"]?.({ tool: "mcp__relay__message_send", sessionID: "session-a", callID: "call-8" }, slashMessageOutput);
    expect(slashMessageOutput.args.senderSessionID).toBe("session-a");
  });

  it("flushes pending notifications after namespaced relay MCP tool execution", async () => {
    const databasePath = createTestDatabaseLocation("mcp-first-flush");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-mcp-first-hooks", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    await hooks.event?.({ event: { type: "session.status", properties: { sessionID: "session-b", status: { type: "idle" } } } as never });

    const createArgs = { args: { kind: "private" } as Record<string, unknown> };
    await hooks["tool.execute.before"]?.({ tool: "mcp__relay__room_create", sessionID: "session-a", callID: "call-1" }, createArgs);
    const state = (await import("../../packages/relay-plugin/src/internal/testing/state-access.ts")).getRelayPluginStateForTest("project-mcp-first-hooks");
    const room = state!.runtime.roomStore.createRoom(createArgs.args.sessionID as string, "private");
    state!.runtime.roomStore.joinRoom(room.roomCode, "session-b");
    state!.runtime.ensureDefaultThreadsForRoom(room.roomCode);
    const thread = state!.runtime.threadStore.ensureDirectThread(room.roomCode, ["session-a", "session-b"], "session-a");
    await state!.runtime.sendThreadMessage({ threadId: thread.threadId, senderSessionID: "session-a", message: "hello", messageType: "relay" });

    await hooks["tool.execute.after"]?.({ tool: "mcp__relay__message_send", sessionID: "session-a", callID: "call-2", args: {} }, { title: "done", output: "ok", metadata: {} });
    expect(promptAsync).toHaveBeenCalled();
  });
});
