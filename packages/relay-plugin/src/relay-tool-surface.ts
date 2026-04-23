import { tool, type PluginInput } from "@opencode-ai/plugin";

import type { RelayPluginState } from "./runtime/plugin-state.js";
import { bootstrapRelayWorkflowTeam } from "./runtime/team-workflow.js";
import { isRelayCurrentSessionPlaceholder, shouldInjectRelaySessionID } from "./session-id.js";

const hookedRelayToolSuffixes = [
  "room_create",
  "room_join",
  "room_status",
  "room_send",
  "room_members",
  "room_set_role",
  "thread_create",
  "thread_list",
  "message_send",
  "message_mark_read",
  "message_list",
  "transcript_export"
] as const;

type HookedRelayToolSuffix = typeof hookedRelayToolSuffixes[number];
type RelayPluginTool = ReturnType<typeof tool>;
type RelayPluginToolMap = Record<string, RelayPluginTool>;

function parseParticipantSessionIDs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRoomRole(role: string): "owner" | "member" | "observer" {
  return role === "observer" ? "observer" : role === "owner" ? "owner" : "member";
}

function normalizeTeamAction(action: string): "retry" | "reassign" | "unblock" | "nudge" {
  return action === "reassign"
    ? "reassign"
    : action === "unblock"
      ? "unblock"
      : action === "nudge"
        ? "nudge"
        : "retry";
}

function parseDeliverables(deliverables: string | undefined): string[] | undefined {
  return deliverables
    ? deliverables.split(",").map((item) => item.trim()).filter(Boolean)
    : undefined;
}

function getNamespacedRelayToolID(toolID: string): string {
  if (!toolID.startsWith("relay_")) {
    throw new Error(`Relay plugin tool IDs must start with relay_: ${toolID}`);
  }

  return `mcp__relay__${toolID.slice("relay_".length)}`;
}

function createNamespacedRelayTools(relayTools: RelayPluginToolMap): RelayPluginToolMap {
  return Object.fromEntries(
    Object.entries(relayTools).map(([toolID, definition]) => [getNamespacedRelayToolID(toolID), definition])
  ) as RelayPluginToolMap;
}

export function getRelayToolSuffix(toolID: string): HookedRelayToolSuffix | undefined {
  for (const suffix of hookedRelayToolSuffixes) {
    if (
      toolID === suffix
      || toolID === `relay_${suffix}`
      || toolID.endsWith(`__${suffix}`)
      || toolID.endsWith(`.${suffix}`)
      || toolID.endsWith(`:${suffix}`)
      || toolID.endsWith(`/${suffix}`)
    ) {
      return suffix;
    }
  }

  return undefined;
}

export function isHookedRelayTool(toolID: string): boolean {
  return getRelayToolSuffix(toolID) !== undefined;
}

export function applyRelaySessionDefaults(toolID: string, args: Record<string, unknown>, sessionID: string) {
  const suffix = getRelayToolSuffix(toolID);
  if (!suffix) {
    return;
  }

  if (["room_create", "room_join", "room_status", "room_send", "room_members"].includes(suffix) && shouldInjectRelaySessionID(args.sessionID)) {
    args.sessionID = sessionID;
  }
  if (suffix === "room_set_role" && shouldInjectRelaySessionID(args.actorSessionID)) {
    args.actorSessionID = sessionID;
  }
  if (suffix === "thread_create" && shouldInjectRelaySessionID(args.createdBySessionID)) {
    args.createdBySessionID = sessionID;
  }
  if (suffix === "thread_list" && (isRelayCurrentSessionPlaceholder(args.sessionID) || (args.roomCode === undefined && shouldInjectRelaySessionID(args.sessionID)))) {
    args.sessionID = sessionID;
  }
  if (suffix === "message_send" && shouldInjectRelaySessionID(args.senderSessionID)) {
    args.senderSessionID = sessionID;
  }
  if (suffix === "message_mark_read" && shouldInjectRelaySessionID(args.sessionID)) {
    args.sessionID = sessionID;
  }
}

export function createRelayPluginTools(
  input: PluginInput,
  state: RelayPluginState
): {
  relayTools: RelayPluginToolMap;
  namespacedRelayTools: RelayPluginToolMap;
} {
  const relayTools = {
    relay_room_create: tool({
      description: "Create a private or group relay room and return the room code",
      args: {
        kind: tool.schema.string().optional()
      },
      execute: async ({ kind }, context) => {
        const normalizedKind = kind === "group" ? "group" : "private";
        const room = state.runtime.createRoom(context.sessionID, normalizedKind);
        return [
          `Room code: ${room.roomCode}`,
          `Room kind: ${room.kind}`,
          `Creator session: ${room.createdBySessionID}`,
          room.kind === "group"
            ? "Tell other conversations to join this room with an alias."
            : "Tell the other conversation to use the relay-room skill and join this room code."
        ].join("\n");
      }
    }),
    relay_room_join: tool({
      description: "Join a relay room with a room code; group rooms require an alias",
      args: {
        roomCode: tool.schema.string().min(1),
        alias: tool.schema.string().optional()
      },
      execute: async ({ roomCode, alias }, context) => {
        const room = state.runtime.joinRoom(roomCode, context.sessionID, alias);
        const peerSessionID = state.runtime.getPeerSessionID(context.sessionID, room.roomCode);
        return [
          `Joined room: ${room.roomCode}`,
          `Room kind: ${room.kind}`,
          `Current session: ${context.sessionID}`,
          alias ? `Alias: ${alias}` : undefined,
          `Peer session: ${peerSessionID ?? "waiting"}`
        ].filter(Boolean).join("\n");
      }
    }),
    relay_room_status: tool({
      description: "Show the current relay room binding for this conversation",
      args: {
        roomCode: tool.schema.string().optional()
      },
      execute: async ({ roomCode }, context) => {
        const room = state.runtime.resolveRoomForSession(context.sessionID, roomCode);
        const peerSessionID = room.kind === "private" ? (state.runtime.getPeerSessionID(context.sessionID, room.roomCode) ?? "waiting") : "group";
        return [
          `Room code: ${room.roomCode}`,
          `Room kind: ${room.kind}`,
          `Status: ${room.status}`,
          `Current session: ${context.sessionID}`,
          `Peer session: ${peerSessionID}`
        ].join("\n");
      }
    }),
    relay_room_send: tool({
      description: "Send a message in the current relay room; group rooms may target a specific alias",
      args: {
        roomCode: tool.schema.string().optional(),
        message: tool.schema.string().min(1),
        targetAlias: tool.schema.string().optional()
      },
      execute: async ({ roomCode, message, targetAlias }, context) => {
        state.runtime.recordDiagnostic("relay.send.entry", {
          surface: "plugin",
          tool: "relay_room_send",
          sessionID: context.sessionID,
          roomCode: roomCode ?? null,
          targetAlias: targetAlias ?? null
        });
        const result = await state.runtime.sendRoomMessage(context.sessionID, message, targetAlias, roomCode);
        return [
          `Sent to peer session: ${result.peerSessionID}`,
          `Room code: ${result.roomCode}`,
          `Thread ID: ${result.threadId}`,
          `Accepted: ${result.accepted ? "yes" : "no"}`,
          targetAlias ? `Target alias: ${targetAlias}` : undefined,
          result.reason ? `Reason: ${result.reason}` : undefined,
          `Message length: ${message.length}`
        ].filter(Boolean).join("\n");
      }
    }),
    relay_room_members: tool({
      description: "List active members in the current relay room",
      args: {
        roomCode: tool.schema.string().optional()
      },
      execute: async ({ roomCode }, context) => {
        const members = state.runtime.listRoomMembers(roomCode ?? "", context.sessionID);
        const room = state.runtime.resolveRoomForSession(context.sessionID, roomCode);
        return JSON.stringify({
          roomCode: room.roomCode,
          roomKind: room.kind,
          members
        }, null, 2);
      }
    }),
    relay_room_set_role: tool({
      description: "Set the role of a room member; only the room owner may do this",
      args: {
        roomCode: tool.schema.string().optional(),
        targetSessionID: tool.schema.string().min(1),
        role: tool.schema.string().min(1)
      },
      execute: async ({ roomCode, targetSessionID, role }, context) => {
        const updated = state.runtime.setRoomMemberRole(roomCode, context.sessionID, targetSessionID, normalizeRoomRole(role));
        return JSON.stringify(updated, null, 2);
      }
    }),
    relay_thread_create: tool({
      description: "Create a private or group durable thread inside the current relay room",
      args: {
        roomCode: tool.schema.string().optional(),
        kind: tool.schema.string().min(1),
        participantSessionIDs: tool.schema.string().min(1),
        title: tool.schema.string().optional()
      },
      execute: async ({ roomCode, kind, participantSessionIDs, title }, context) => {
        state.runtime.resolveRoomForSession(context.sessionID, roomCode);

        const participants = parseParticipantSessionIDs(participantSessionIDs);
        if (!participants.includes(context.sessionID)) {
          participants.unshift(context.sessionID);
        }

        const thread = state.runtime.createThread({
          roomCode,
          kind: kind === "group" ? "group" : "direct",
          createdBySessionID: context.sessionID,
          participantSessionIDs: participants,
          title
        });

        return JSON.stringify(thread, null, 2);
      }
    }),
    relay_thread_list: tool({
      description: "List durable threads for the current relay room or session",
      args: {
        roomCode: tool.schema.string().optional(),
        scope: tool.schema.string().optional()
      },
      execute: async ({ roomCode, scope }, context) => {
        if (scope === "room") {
          const resolvedRoom = state.runtime.resolveRoomForSession(context.sessionID, roomCode);
          return JSON.stringify(state.runtime.listThreads({ roomCode: resolvedRoom.roomCode }), null, 2);
        }
        return JSON.stringify(state.runtime.listThreads({ sessionID: context.sessionID }), null, 2);
      }
    }),
    relay_message_list: tool({
      description: "List messages from a durable relay thread",
      args: {
        threadId: tool.schema.string().min(1),
        afterSeq: tool.schema.number().int().nonnegative().optional(),
        limit: tool.schema.number().int().positive().optional()
      },
      execute: async ({ threadId, afterSeq, limit }, context) => JSON.stringify(state.runtime.listMessages(threadId, afterSeq, limit, context.sessionID), null, 2)
    }),
    relay_message_send: tool({
      description: "Append a durable message into a relay thread",
      args: {
        threadId: tool.schema.string().min(1),
        message: tool.schema.string().min(1),
        messageType: tool.schema.string().optional()
      },
      execute: async ({ threadId, message, messageType }, context) => {
        state.runtime.recordDiagnostic("relay.send.entry", {
          surface: "plugin",
          tool: "relay_message_send",
          sessionID: context.sessionID,
          threadId,
          messageType: messageType ?? "relay"
        });
        const result = await state.runtime.sendThreadMessage({
          threadId,
          senderSessionID: context.sessionID,
          message,
          messageType
        });
        return JSON.stringify(result, null, 2);
      }
    }),
    relay_message_mark_read: tool({
      description: "Advance the read cursor for the current session in a thread",
      args: {
        threadId: tool.schema.string().min(1),
        seq: tool.schema.number().int().nonnegative()
      },
      execute: async ({ threadId, seq }, context) => JSON.stringify(state.runtime.markThreadRead(threadId, context.sessionID, seq), null, 2)
    }),
    relay_transcript_export: tool({
      description: "Export the full durable transcript for a thread",
      args: {
        threadId: tool.schema.string().min(1)
      },
      execute: async ({ threadId }, context) => JSON.stringify(state.runtime.exportTranscript(threadId, context.sessionID), null, 2)
    }),
    relay_team_start: tool({
      description: "Create a relay-backed workflow team from the current session and bootstrap the default worker sessions",
      args: {
        task: tool.schema.string().min(1)
      },
      execute: async ({ task }, context) => JSON.stringify(await bootstrapRelayWorkflowTeam(input, state.runtime, context.sessionID, task), null, 2)
    }),
    relay_team_status: tool({
      description: "Show the current relay workflow team status for this session or a specific run/room",
      args: {
        runId: tool.schema.string().optional(),
        roomCode: tool.schema.string().optional()
      },
      execute: async ({ runId, roomCode }, context) => JSON.stringify(state.runtime.getTeamStatus(context.sessionID, runId, roomCode), null, 2)
    }),
    relay_team_intervene: tool({
      description: "Issue a manager intervention into the relay workflow team and record it in the workflow timeline",
      args: {
        runId: tool.schema.string().optional(),
        roomCode: tool.schema.string().optional(),
        action: tool.schema.string().min(1),
        targetAlias: tool.schema.string().optional(),
        note: tool.schema.string().min(1),
        handoffTo: tool.schema.string().optional(),
        deliverables: tool.schema.string().optional()
      },
      execute: async ({ runId, roomCode, action, targetAlias, note, handoffTo, deliverables }, context) => JSON.stringify(await state.runtime.interveneTeam(context.sessionID, {
        runId,
        roomCode,
        action: normalizeTeamAction(action),
        targetAlias,
        note,
        handoffTo,
        deliverables: parseDeliverables(deliverables)
      }), null, 2)
    }),
    relay_team_apply_policy: tool({
      description: "Apply one explicit policy decision from relay_team_status through the standard manager intervention path",
      args: {
        runId: tool.schema.string().optional(),
        roomCode: tool.schema.string().optional(),
        action: tool.schema.string().min(1),
        targetAlias: tool.schema.string().optional()
      },
      execute: async ({ runId, roomCode, action, targetAlias }, context) => JSON.stringify(await state.runtime.applyTeamPolicy(context.sessionID, {
        runId,
        roomCode,
        action: normalizeTeamAction(action),
        targetAlias
      }), null, 2)
    })
  } satisfies RelayPluginToolMap;

  return {
    relayTools,
    namespacedRelayTools: createNamespacedRelayTools(relayTools)
  } as const;
}
