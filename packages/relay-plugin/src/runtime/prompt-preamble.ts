import type { RelayMessage } from "../internal/store/message-store.js";
import type { RelayRoomMemberRole } from "../internal/store/room-store.js";
import type { RelayThread } from "../internal/store/thread-store.js";

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
