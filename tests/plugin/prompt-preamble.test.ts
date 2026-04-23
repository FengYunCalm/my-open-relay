import { describe, expect, it } from "vitest";

import { buildTaskRelayPrompt, buildThreadRelayPrompt } from "../support/relay-plugin-testkit.js";

describe("relay prompt preamble", () => {
  it("builds a task relay prompt with fixed agent-awareness preamble", () => {
    const prompt = buildTaskRelayPrompt({
      sourceSessionID: "session-a",
      taskId: "task-1",
      contextId: "ctx-1",
      content: "Implement feature X"
    });

    expect(prompt).toContain("[RELAYED AGENT INPUT]");
    expect(prompt).toContain("Sender: another agent (not a human user)");
    expect(prompt).toContain("Task ID: task-1");
    expect(prompt).toContain("Response mode: use tools/workflow actions, not end-user chat replies");
    expect(prompt).toContain("Implement feature X");
  });

  it("builds a thread relay prompt with room and thread context", () => {
    const prompt = buildThreadRelayPrompt({
      roomCode: "123456",
      recipientSessionID: "session-b",
      thread: {
        threadId: "thread-1",
        roomCode: "123456",
        kind: "group",
        title: "team-main",
        createdBySessionID: "session-owner",
        createdAt: 1,
        updatedAt: 1
      },
      messages: [
        {
          threadId: "thread-1",
          seq: 1,
          messageId: "relaymsg-1",
          senderSessionID: "session-a",
          messageType: "relay",
          body: { text: "hello group" },
          createdAt: 1
        }
      ],
      senderRoles: {
        "session-a": "member"
      }
    });

    expect(prompt).toContain("Thread: thread-1 (group)");
    expect(prompt).toContain("Sender: one or more relay agents (not human users)");
    expect(prompt).toContain("Response mode: use tools/workflow actions, not end-user chat replies");
    expect(prompt).toContain("sender_role=member");
    expect(prompt).toContain("hello group");
  });

  it("uses the old simple private relay prompt for private direct threads", () => {
    const prompt = buildThreadRelayPrompt({
      roomCode: "654321",
      roomKind: "private",
      recipientSessionID: "session-b",
      thread: {
        threadId: "thread-private",
        roomCode: "654321",
        kind: "direct",
        createdBySessionID: "session-a",
        createdAt: 1,
        updatedAt: 1
      },
      messages: [
        {
          threadId: "thread-private",
          seq: 1,
          messageId: "relaymsg-1",
          senderSessionID: "session-a",
          messageType: "relay",
          body: { text: "hello private" },
          createdAt: 1
        }
      ],
      senderRoles: {
        "session-a": "owner"
      }
    });

    expect(prompt).toContain("[RELAYED AGENT INPUT]");
    expect(prompt).toContain("Sender: paired agent session session-a (not a human user)");
    expect(prompt).toContain("Response mode: use tools/workflow actions, not end-user chat replies");
    expect(prompt).toContain("Message:");
    expect(prompt).toContain("hello private");
  });

  it("builds a compact manager summary with worker session links for team rooms", () => {
    const prompt = buildThreadRelayPrompt({
      roomCode: "030900",
      recipientSessionID: "session-manager",
      thread: {
        threadId: "thread-team",
        roomCode: "030900",
        kind: "group",
        title: "room-main",
        createdBySessionID: "session-manager",
        createdAt: 1,
        updatedAt: 1
      },
      messages: [
        {
          threadId: "thread-team",
          seq: 5,
          messageId: "relaymsg-5",
          senderSessionID: "session-reviewer",
          messageType: "relay",
          body: {
            text: '[TEAM_DONE] {"source":"omo","phase":"signal-review-complete","note":"Verdict pass","progress":100,"evidence":["ok"]}'
          },
          createdAt: 1
        }
      ],
      senderRoles: {
        "session-reviewer": "member"
      },
      senderAliases: {
        "session-reviewer": "reviewer"
      },
      managerView: {
        directory: "C:/relay-project",
        workerLinks: [
          { alias: "planner", role: "planner", sessionID: "session-planner" },
          { alias: "implementer", role: "implementer", sessionID: "session-implementer" },
          { alias: "reviewer", role: "reviewer", sessionID: "session-reviewer" }
        ]
      }
    });

    expect(prompt).toContain("[RELAY TEAM UPDATE]");
    expect(prompt).toContain("Worker sessions:");
    expect(prompt).toContain("[planner](/QzovcmVsYXktcHJvamVjdA/session/session-planner)");
    expect(prompt).toContain("[implementer](/QzovcmVsYXktcHJvamVjdA/session/session-implementer)");
    expect(prompt).toContain("[reviewer](/QzovcmVsYXktcHJvamVjdA/session/session-reviewer)");
    expect(prompt).toContain("reviewer (member) DONE [phase=signal-review-complete · progress=100% · source=omo]: Verdict pass");
    expect(prompt).not.toContain("[RELAYED AGENT INPUT]");
  });
});
