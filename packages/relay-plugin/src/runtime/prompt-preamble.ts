import type { RelayMessage } from "../internal/store/message-store.js";
import type { RelayRoomMemberRole } from "../internal/store/room-store.js";
import type { RelayThread } from "../internal/store/thread-store.js";
import { classifyRelayWorkflowSignal, relayWorkflowSignalPrefixes } from "./team-workflow.js";

type ManagerRelayWorkerLink = {
  alias: string;
  role: string;
  sessionID: string;
};

function encodeDirectorySlug(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createSessionHref(directory: string, sessionID: string): string {
  return `/${encodeDirectorySlug(directory)}/session/${sessionID}`;
}

function renderManagerMessageLine(message: RelayMessage, alias?: string, role?: RelayRoomMemberRole): string {
  const text = typeof message.body.text === "string" ? message.body.text.trim() : JSON.stringify(message.body, null, 2);
  const signal = classifyRelayWorkflowSignal(text);
  const senderLabel = alias ?? message.senderSessionID;
  const roleLabel = role ? ` (${role})` : "";

  if (signal.matched && signal.accepted) {
    const signalLabel = text.startsWith(relayWorkflowSignalPrefixes.ready)
      ? "READY"
      : text.startsWith(relayWorkflowSignalPrefixes.progress)
        ? "PROGRESS"
        : text.startsWith(relayWorkflowSignalPrefixes.blocker)
          ? "BLOCKER"
          : "DONE";
    const details = [
      signal.phase ? `phase=${signal.phase}` : undefined,
      signal.progress !== undefined ? `progress=${signal.progress}%` : undefined,
      signal.source ? `source=${signal.source}` : undefined
    ].filter(Boolean).join(" · ");
    return `- ${senderLabel}${roleLabel} ${signalLabel}${details ? ` [${details}]` : ""}: ${signal.note}`;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  return `- ${senderLabel}${roleLabel}: ${normalized}`;
}

function buildManagerThreadRelayPrompt(input: {
  roomCode: string;
  thread: RelayThread;
  recipientSessionID: string;
  messages: RelayMessage[];
  senderRoles: Record<string, RelayRoomMemberRole | undefined>;
  senderAliases?: Record<string, string | undefined>;
  directory: string;
  workerLinks: ManagerRelayWorkerLink[];
}): string {
  const workerLinkLine = input.workerLinks.length > 0
    ? input.workerLinks
      .map((worker) => `[${worker.alias}](${createSessionHref(input.directory, worker.sessionID)})`)
      .join(" | ")
    : "none";

  const lines = input.messages.map((message) => renderManagerMessageLine(
    message,
    input.senderAliases?.[message.senderSessionID],
    input.senderRoles[message.senderSessionID]
  ));

  return [
    "[RELAY TEAM UPDATE]",
    `Room: ${input.roomCode}`,
    `Thread: ${input.thread.threadId} (${input.thread.kind})`,
    `Recipient session: ${input.recipientSessionID}`,
    `Worker sessions: ${workerLinkLine}`,
    "Use relay_team_status for the aggregate state; use room/thread transcript tools only if you need raw details.",
    "Updates:",
    ...lines
  ].join("\n\n");
}

function renderMessageBody(message: RelayMessage): string {
  const text = typeof message.body.text === "string" ? message.body.text : JSON.stringify(message.body, null, 2);
  return [`[seq:${message.seq}] sender=${message.senderSessionID} type=${message.messageType}`, text].join("\n");
}

function renderPrivateRelayMessage(message: RelayMessage): string {
  return typeof message.body.text === "string" ? message.body.text : JSON.stringify(message.body, null, 2);
}

export function buildTaskRelayPrompt(input: {
  sourceSessionID?: string;
  taskId: string;
  contextId?: string;
  content: string;
}): string {
  const header = [
    "[RELAYED AGENT INPUT]",
    "Sender: another agent (not a human user)",
    input.sourceSessionID ? `Source session: ${input.sourceSessionID}` : undefined,
    `Task ID: ${input.taskId}`,
    input.contextId ? `Context ID: ${input.contextId}` : undefined,
    "Response mode: use tools/workflow actions, not end-user chat replies"
  ].filter((value): value is string => Boolean(value));

  return [...header, "Task content:", input.content].join("\n\n");
}

export function buildThreadRelayPrompt(input: {
  roomCode: string;
  thread: RelayThread;
  roomKind?: "private" | "group";
  recipientSessionID: string;
  messages: RelayMessage[];
  senderRoles: Record<string, RelayRoomMemberRole | undefined>;
  senderAliases?: Record<string, string | undefined>;
  managerView?: {
    directory: string;
    workerLinks: ManagerRelayWorkerLink[];
  };
}): string {
  if (input.roomKind === "private" && input.thread.kind === "direct") {
    const latestSender = input.messages[input.messages.length - 1]?.senderSessionID ?? "unknown-session";
    const renderedMessages = input.messages.map((message) => renderPrivateRelayMessage(message)).join("\n\n");
    return [
      "[RELAYED AGENT INPUT]",
      `Sender: paired agent session ${latestSender} (not a human user)`,
      `Room: ${input.roomCode}`,
      "Response mode: use tools/workflow actions, not end-user chat replies",
      "Message:",
      renderedMessages
    ].join("\n\n");
  }

  if (input.managerView) {
    return buildManagerThreadRelayPrompt({
      roomCode: input.roomCode,
      thread: input.thread,
      recipientSessionID: input.recipientSessionID,
      messages: input.messages,
      senderRoles: input.senderRoles,
      senderAliases: input.senderAliases,
      directory: input.managerView.directory,
      workerLinks: input.managerView.workerLinks
    });
  }

  const header = [
    "[RELAYED AGENT INPUT]",
    "Sender: one or more relay agents (not human users)",
    `Room: ${input.roomCode}`,
    `Thread: ${input.thread.threadId} (${input.thread.kind})`,
    `Recipient session: ${input.recipientSessionID}`,
    "Response mode: use tools/workflow actions, not end-user chat replies"
  ];

  const renderedMessages = input.messages.map((message) => {
    const role = input.senderRoles[message.senderSessionID];
    const alias = input.senderAliases?.[message.senderSessionID];
    const meta = [
      role ? `sender_role=${role}` : undefined,
      alias ? `sender_alias=${alias}` : undefined
    ].filter(Boolean).join(" ");
    return [meta, renderMessageBody(message)].filter(Boolean).join("\n");
  });

  return [...header, "Messages:", ...renderedMessages].join("\n\n");
}
