import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import { RelayPlugin, getRelayPluginStateForTest, stopRelayPlugin } from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

function createPluginInput(projectID = "project-team-message-format", promptAsync = vi.fn().mockResolvedValue({ data: true })): PluginInput {
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
  await stopRelayPlugin("project-team-message-format");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("manager relay message formatting", () => {
  it("injects a compact manager summary with worker session links for team thread updates", async () => {
    const databasePath = createTestDatabaseLocation("team-message-format");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    await RelayPlugin(createPluginInput("project-team-message-format", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const state = getRelayPluginStateForTest("project-team-message-format")!;
    const room = state.runtime.createRoom("session-manager", "group");
    state.runtime.roomStore.joinRoom(room.roomCode, "session-reviewer", "reviewer");
    const run = state.runtime.teamStore.createRun({
      managerSessionID: "session-manager",
      roomCode: room.roomCode,
      task: "测试一下"
    });
    state.runtime.teamStore.addWorker({
      runId: run.runId,
      sessionID: "session-reviewer",
      role: "reviewer",
      alias: "reviewer",
      title: "team/reviewer: 测试一下"
    });
    state.runtime.teamStore.addWorker({
      runId: run.runId,
      sessionID: "session-planner",
      role: "planner",
      alias: "planner",
      title: "team/planner: 测试一下"
    });
    state.runtime.teamStore.addWorker({
      runId: run.runId,
      sessionID: "session-implementer",
      role: "implementer",
      alias: "implementer",
      title: "team/implementer: 测试一下"
    });

    state.runtime.teamStore.markWorkerSignal("session-reviewer", room.roomCode, {
      status: "completed",
      note: "Verdict pass",
      ready: true,
      source: "omo",
      phase: "signal-review-complete",
      progress: 100,
      evidence: ["ok"]
    });

    const thread = state.runtime.createThread({
      roomCode: room.roomCode,
      kind: "direct",
      createdBySessionID: "session-manager",
      participantSessionIDs: ["session-manager", "session-reviewer"],
      title: "review"
    });

    await state.runtime.sendThreadMessage({
      threadId: thread.threadId,
      senderSessionID: "session-reviewer",
      message: '[TEAM_DONE] {"source":"omo","phase":"signal-review-complete","note":"Verdict pass","progress":100,"evidence":["ok"]}',
      messageType: "relay"
    });

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const promptText = promptAsync.mock.calls[0]?.[0]?.body?.parts?.[0]?.text as string;
    expect(promptText).toContain("[TEAM UPDATE]");
    expect(promptText).toContain("[planner](/QzovcmVsYXktcHJvamVjdA/session/session-planner)");
    expect(promptText).toContain("[implementer](/QzovcmVsYXktcHJvamVjdA/session/session-implementer)");
    expect(promptText).toContain("[reviewer](/QzovcmVsYXktcHJvamVjdA/session/session-reviewer)");
    expect(promptText).toContain("Status:");
    expect(promptText).toContain("- reviewer: done [signal-review-complete · 100%] - Verdict pass");
    expect(promptText).toContain("Action:");
    expect(promptText).toContain("- no manager action yet; wait for more worker signals or open relay_team_status");
    expect(promptText).not.toContain("[RELAYED AGENT INPUT]");
  });

  it("suppresses unchanged manager summaries when a stable non-blocking update arrives", async () => {
    const databasePath = createTestDatabaseLocation("team-message-format-stable");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    await RelayPlugin(createPluginInput("project-team-message-format", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const state = getRelayPluginStateForTest("project-team-message-format")!;
    const room = state.runtime.createRoom("session-manager", "group");
    state.runtime.roomStore.joinRoom(room.roomCode, "session-reviewer", "reviewer");
    state.runtime.roomStore.joinRoom(room.roomCode, "session-planner", "planner");
    const run = state.runtime.teamStore.createRun({
      managerSessionID: "session-manager",
      roomCode: room.roomCode,
      task: "测试一下"
    });
    state.runtime.teamStore.addWorker({ runId: run.runId, sessionID: "session-reviewer", role: "reviewer", alias: "reviewer", title: "team/reviewer: 测试一下" });
    state.runtime.teamStore.addWorker({ runId: run.runId, sessionID: "session-planner", role: "planner", alias: "planner", title: "team/planner: 测试一下" });
    state.runtime.teamStore.markWorkerSignal("session-reviewer", room.roomCode, {
      status: "blocked",
      note: "Need live evidence",
      ready: true,
      source: "omo",
      phase: "final-acceptance-waiting-on-live-evidence",
      progress: 85
    });
    const reviewerThread = state.runtime.createThread({
      roomCode: room.roomCode,
      kind: "direct",
      createdBySessionID: "session-manager",
      participantSessionIDs: ["session-manager", "session-reviewer"],
      title: "review"
    });

    await state.runtime.sendThreadMessage({
      threadId: reviewerThread.threadId,
      senderSessionID: "session-reviewer",
      message: '[TEAM_BLOCKER] {"source":"omo","phase":"final-acceptance-waiting-on-live-evidence","note":"Need live evidence","progress":85}',
      messageType: "relay"
    });

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const firstPrompt = promptAsync.mock.calls[0]?.[0]?.body?.parts?.[0]?.text as string;
    expect(firstPrompt).toContain("Blocking:");
    expect(firstPrompt).toContain("- reviewer: blocked - waiting on manager-provided live evidence or environment access");

    state.runtime.teamStore.markWorkerSignal("session-planner", room.roomCode, {
      status: "in_progress",
      note: "No plan change",
      ready: true,
      source: "superpowers",
      phase: "blocker-stable-no-new-evidence",
      progress: 85
    });
    const plannerThread = state.runtime.createThread({
      roomCode: room.roomCode,
      kind: "direct",
      createdBySessionID: "session-manager",
      participantSessionIDs: ["session-manager", "session-planner"],
      title: "planning"
    });

    await state.runtime.sendThreadMessage({
      threadId: plannerThread.threadId,
      senderSessionID: "session-planner",
      message: '[TEAM_PROGRESS] {"source":"superpowers","phase":"blocker-stable-no-new-evidence","note":"No plan change","progress":85}',
      messageType: "relay"
    });

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });
});
