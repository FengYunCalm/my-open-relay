import type { RelayMessage, MessageStore } from "../store/message-store.js";
import type { RelayRoom, RelayRoomKind, RelayRoomMemberRole, RoomStore } from "../store/room-store.js";
import type { RelayThread, ThreadStore } from "../store/thread-store.js";

export type RelayNotificationDecision = {
  allowed: boolean;
  reason: string;
};

export type RelayDeliveryHooks = {
  recordDiagnostic?: (eventType: string, payload: Record<string, unknown>) => void;
  resolveNotificationDecision(sessionID: string): RelayNotificationDecision;
  notifyPrivateRoomPeer(input: {
    sourceSessionID: string;
    peerSessionID: string;
    roomCode: string;
    message: string;
  }): Promise<void>;
  notifyThreadParticipant(thread: RelayThread, sessionID: string, messages: RelayMessage[]): Promise<void>;
  reserveThreadNotifications?(thread: RelayThread, sessionID: string, messages: RelayMessage[]): RelayMessage[];
  releaseThreadNotifications?(thread: RelayThread, sessionID: string, messages: RelayMessage[]): void;
};

export type SendThreadMessageResult = {
  threadId: string;
  seq: number;
  notifiedRecipients: string[];
  queuedRecipients: Array<{ sessionID: string; reason: string }>;
};

export type SendRoomMessageResult = {
  peerSessionID: string;
  roomCode: string;
  threadId: string;
  accepted: boolean;
  reason?: string;
  notifiedRecipients: string[];
  queuedRecipients: Array<{ sessionID: string; reason: string }>;
};

export type CreateThreadInput = {
  roomCode?: string;
  kind: "direct" | "group";
  createdBySessionID: string;
  participantSessionIDs: string[];
  title?: string;
};

const standaloneDeliveryReason = "standalone relay MCP stores messages only; use relay plugin tools for session delivery";

export class RelayRoomOrchestrator {
  constructor(
    private readonly roomStore: RoomStore,
    private readonly threadStore: ThreadStore,
    private readonly messageStore: MessageStore,
    private readonly deliveryHooks?: RelayDeliveryHooks
  ) {}

  createRoom(sessionID: string, kind: RelayRoomKind = "private"): RelayRoom {
    const room = this.roomStore.createRoom(sessionID, kind);
    this.ensureDefaultThreadsForRoom(room.roomCode);
    return room;
  }

  joinRoom(roomCode: string, sessionID: string, alias?: string): RelayRoom {
    const room = this.roomStore.joinRoom(roomCode, sessionID, alias);
    this.ensureDefaultThreadsForRoom(room.roomCode);
    return room;
  }

  resolveRoomForSession(sessionID: string, roomCode?: string): RelayRoom {
    if (roomCode) {
      const room = this.roomStore.getRoom(roomCode);
      if (!room) {
        throw new Error(`Room ${roomCode} does not exist.`);
      }
      const member = this.roomStore.getMember(roomCode, sessionID);
      if (!member || member.membershipStatus !== "active") {
        throw new Error(`Session ${sessionID} is not an active member of room ${roomCode}.`);
      }
      return room;
    }

    const rooms = this.roomStore.listRoomsBySession(sessionID);
    if (rooms.length === 0) {
      throw new Error(`No relay room is bound to session ${sessionID}.`);
    }
    if (rooms.length > 1) {
      const roomSummary = rooms.map((room) => `${room.roomCode}:${room.kind}`).join(", ");
      throw new Error(`Session ${sessionID} is bound to multiple rooms (${roomSummary}); specify roomCode explicitly.`);
    }
    return rooms[0]!;
  }

  getPeerSessionID(sessionID: string, roomCode?: string): string | undefined {
    const room = this.resolveRoomForSession(sessionID, roomCode);
    const otherMembers = this.roomStore.listWritableMembers(room.roomCode).filter((member) => member.sessionID !== sessionID);
    if (otherMembers.length !== 1) {
      return undefined;
    }
    return otherMembers[0]?.sessionID;
  }

  listRoomMembers(roomCodeOrSession: string, sessionID?: string): unknown {
    if (sessionID) {
      const room = this.resolveRoomForSession(sessionID, roomCodeOrSession || undefined);
      return this.roomStore.listMembers(room.roomCode);
    }
    return this.roomStore.listMembers(roomCodeOrSession);
  }

  setRoomMemberRole(roomCode: string | undefined, actorSessionID: string, targetSessionID: string, role: RelayRoomMemberRole): unknown {
    const room = this.resolveRoomForSession(actorSessionID, roomCode);
    const actor = this.roomStore.getMember(room.roomCode, actorSessionID);
    if (!actor || actor.role !== "owner") {
      throw new Error(`Only the room owner can change member roles in room ${room.roomCode}.`);
    }

    const updated = this.roomStore.setMemberRole(room.roomCode, targetSessionID, role);
    this.ensureDefaultThreadsForRoom(room.roomCode);
    return updated;
  }

  createThread(input: CreateThreadInput): RelayThread {
    const room = this.resolveRoomForSession(input.createdBySessionID, input.roomCode);

    const actor = this.roomStore.getMember(room.roomCode, input.createdBySessionID);
    if (!actor || actor.role === "observer") {
      throw new Error(`Session ${input.createdBySessionID} is not allowed to create threads in room ${room.roomCode}.`);
    }

    const memberIDs = new Set(this.roomStore.getMemberSessionIDs(room.roomCode));
    for (const participantSessionID of input.participantSessionIDs) {
      if (!memberIDs.has(participantSessionID)) {
        throw new Error(`Session ${participantSessionID} is not an active member of room ${room.roomCode}.`);
      }
    }

    if (!input.participantSessionIDs.includes(input.createdBySessionID)) {
      throw new Error(`Thread creator ${input.createdBySessionID} must be part of the thread participants.`);
    }

    if (room.kind === "private") {
      if (input.kind !== "direct") {
        throw new Error("Private rooms only allow direct threads.");
      }
      const owner = this.roomStore.getOwner(room.roomCode);
      if (input.participantSessionIDs.length !== 2) {
        throw new Error("Direct threads must contain exactly 2 participants.");
      }
      if (!input.participantSessionIDs.includes(owner.sessionID)) {
        throw new Error(`Direct threads must include the room owner ${owner.sessionID}.`);
      }
      return this.threadStore.ensureDirectThread(room.roomCode, input.participantSessionIDs, input.createdBySessionID);
    }

    if (input.kind === "group") {
      if (actor.role !== "owner") {
        throw new Error(`Only the room owner can create group threads in room ${room.roomCode}.`);
      }
      return this.threadStore.createGroupThread(room.roomCode, input.participantSessionIDs, input.createdBySessionID, input.title);
    }

    const writableMemberIDs = new Set(this.roomStore.listWritableMembers(room.roomCode).map((member) => member.sessionID));
    if (input.participantSessionIDs.length !== 2) {
      throw new Error("Direct threads must contain exactly 2 participants.");
    }
    for (const participantSessionID of input.participantSessionIDs) {
      if (!writableMemberIDs.has(participantSessionID)) {
        throw new Error("Direct threads in group rooms require writable members only.");
      }
    }

    return this.threadStore.ensureDirectThread(room.roomCode, input.participantSessionIDs, input.createdBySessionID);
  }

  listThreads(options: { sessionID?: string; roomCode?: string }): unknown {
    if (options.roomCode) {
      return this.threadStore.listThreadsForRoom(options.roomCode).map((thread) => this.decorateThread(thread));
    }
    if (options.sessionID) {
      return this.threadStore.listThreadsForSession(options.sessionID).map(({ participant, ...thread }) => ({
        ...this.decorateThread(thread),
        participant
      }));
    }
    return [];
  }

  listMessages(threadId: string, afterSeq = 0, limit = 100): RelayMessage[] {
    return this.messageStore.listMessages(threadId, afterSeq, limit);
  }

  markThreadRead(threadId: string, sessionID: string, seq: number): unknown {
    return this.threadStore.markRead(threadId, sessionID, seq);
  }

  exportTranscript(threadId: string): unknown {
    const thread = this.threadStore.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist.`);
    }
    return this.messageStore.exportTranscript(thread, this.threadStore.listParticipants(threadId));
  }

  ensureDefaultThreadsForRoom(roomCode: string): void {
    const room = this.roomStore.getRoom(roomCode);
    const owner = this.roomStore.getOwner(roomCode);
    const activeMembers = this.roomStore.listMembers(roomCode);
    const writableMembers = activeMembers.filter((member) => member.role !== "observer");

    if (room?.kind === "group") {
      this.threadStore.ensureGroupThread(roomCode, activeMembers.map((member) => member.sessionID), owner.sessionID, "room-main");
    }

    for (const member of writableMembers) {
      if (member.sessionID === owner.sessionID) {
        continue;
      }
      this.threadStore.ensureDirectThread(roomCode, [owner.sessionID, member.sessionID], owner.sessionID);
    }
  }

  async sendRoomMessage(sourceSessionID: string, message: string, targetAlias?: string, roomCode?: string): Promise<SendRoomMessageResult> {
    const room = this.resolveRoomForSession(sourceSessionID, roomCode);
    this.deliveryHooks?.recordDiagnostic?.("relay.send.route", {
      roomCode: room.roomCode,
      roomKind: room.kind,
      sourceSessionID,
      targetMode: room.kind === "group" ? (targetAlias ? "alias-direct" : "broadcast") : "paired-peer"
    });

    const actor = this.roomStore.getMember(room.roomCode, sourceSessionID);
    if (!actor || actor.role === "observer") {
      throw new Error(`Session ${sourceSessionID} is not allowed to send room messages in room ${room.roomCode}.`);
    }

    if (room.kind === "group") {
      if (targetAlias) {
        const target = this.roomStore.getMemberByAlias(room.roomCode, targetAlias);
        if (!target) {
          throw new Error(`Alias ${targetAlias} does not exist in room ${room.roomCode}.`);
        }
        const thread = this.threadStore.ensureDirectThread(room.roomCode, [sourceSessionID, target.sessionID], sourceSessionID);
        const result = await this.sendThreadMessage({ threadId: thread.threadId, senderSessionID: sourceSessionID, message, messageType: "relay" });
        return {
          peerSessionID: target.sessionID,
          roomCode: room.roomCode,
          threadId: thread.threadId,
          accepted: true,
          reason: result.queuedRecipients.find((entry) => entry.sessionID === target.sessionID)?.reason,
          notifiedRecipients: result.notifiedRecipients,
          queuedRecipients: result.queuedRecipients
        };
      }

      const groupThread = this.threadStore.ensureGroupThread(room.roomCode, this.roomStore.getMemberSessionIDs(room.roomCode), this.roomStore.getOwner(room.roomCode).sessionID, "room-main");
      const result = await this.sendThreadMessage({ threadId: groupThread.threadId, senderSessionID: sourceSessionID, message, messageType: "relay" });
      return {
        peerSessionID: "group",
        roomCode: room.roomCode,
        threadId: groupThread.threadId,
        accepted: true,
        reason: result.queuedRecipients.length > 0 ? "some members are currently queued" : undefined,
        notifiedRecipients: result.notifiedRecipients,
        queuedRecipients: result.queuedRecipients
      };
    }

    const activeWritableMembers = this.roomStore.listWritableMembers(room.roomCode);
    if (activeWritableMembers.length > 2) {
      throw new Error(`Room ${room.roomCode} has multiple active members; use relay_thread_create and relay_message_send for multi-agent messaging.`);
    }

    const peerSessionID = this.getPeerSessionID(sourceSessionID, room.roomCode);
    if (!peerSessionID) {
      throw new Error(`Room ${room.roomCode} does not have a connected peer yet.`);
    }

    const thread = this.threadStore.ensureDirectThread(room.roomCode, [sourceSessionID, peerSessionID], sourceSessionID);
    const result = await this.sendPrivateRoomMessage({
      roomCode: room.roomCode,
      threadId: thread.threadId,
      sourceSessionID,
      peerSessionID,
      message
    });

    return {
      peerSessionID,
      roomCode: room.roomCode,
      threadId: thread.threadId,
      accepted: true,
      reason: result.queuedRecipients.find((entry) => entry.sessionID === peerSessionID)?.reason,
      notifiedRecipients: result.notifiedRecipients,
      queuedRecipients: result.queuedRecipients
    };
  }

  private async sendPrivateRoomMessage(input: {
    roomCode: string;
    threadId: string;
    sourceSessionID: string;
    peerSessionID: string;
    message: string;
  }): Promise<SendThreadMessageResult> {
    const message = this.messageStore.appendMessage({
      threadId: input.threadId,
      senderSessionID: input.sourceSessionID,
      messageType: "relay",
      body: { text: input.message }
    });
    this.threadStore.touchThread(input.threadId);
    this.threadStore.markRead(input.threadId, input.sourceSessionID, message.seq);
    this.threadStore.markNotified(input.threadId, input.sourceSessionID, message.seq);

    const queuedRecipients: Array<{ sessionID: string; reason: string }> = [];
    const notifiedRecipients: string[] = [];
    const decision = this.deliveryHooks
      ? this.deliveryHooks.resolveNotificationDecision(input.peerSessionID)
      : { allowed: false, reason: standaloneDeliveryReason };
    this.deliveryHooks?.recordDiagnostic?.("relay.send.decision", {
      deliveryPath: "private-direct-hook",
      roomCode: input.roomCode,
      threadId: input.threadId,
      sourceSessionID: input.sourceSessionID,
      recipientSessionID: input.peerSessionID,
      allowed: decision.allowed,
      reason: decision.reason
    });

    if (!decision.allowed) {
      queuedRecipients.push({ sessionID: input.peerSessionID, reason: decision.reason });
    } else {
      try {
        await this.deliveryHooks!.notifyPrivateRoomPeer({
          sourceSessionID: input.sourceSessionID,
          peerSessionID: input.peerSessionID,
          roomCode: input.roomCode,
          message: input.message
        });
        this.threadStore.markNotified(input.threadId, input.peerSessionID, message.seq);
        notifiedRecipients.push(input.peerSessionID);
      } catch (error) {
        queuedRecipients.push({
          sessionID: input.peerSessionID,
          reason: `live delivery failed: ${error instanceof Error ? error.message : "unknown error"}`
        });
      }
    }

    return {
      threadId: input.threadId,
      seq: message.seq,
      notifiedRecipients,
      queuedRecipients
    };
  }

  async sendThreadMessage(input: {
    threadId: string;
    senderSessionID: string;
    message: string;
    messageType?: string;
  }): Promise<SendThreadMessageResult> {
    const thread = this.threadStore.getThread(input.threadId);
    if (!thread) {
      throw new Error(`Thread ${input.threadId} does not exist.`);
    }

    const senderParticipant = this.threadStore.getParticipant(input.threadId, input.senderSessionID);
    if (!senderParticipant) {
      throw new Error(`Sender ${input.senderSessionID} is not part of thread ${input.threadId}.`);
    }

    const senderRole = this.roomStore.getMember(thread.roomCode, input.senderSessionID)?.role;
    if (!senderRole || senderRole === "observer") {
      throw new Error(`Session ${input.senderSessionID} is not allowed to send messages in thread ${input.threadId}.`);
    }

    const room = this.roomStore.getRoom(thread.roomCode);
    if (room?.kind === "private" && thread.kind === "direct") {
      this.deliveryHooks?.recordDiagnostic?.("relay.send.route", {
        roomCode: thread.roomCode,
        roomKind: room.kind,
        threadId: input.threadId,
        threadKind: thread.kind,
        sourceSessionID: input.senderSessionID,
        deliveryPath: "private-direct-hook"
      });
      const peerParticipant = this.threadStore
        .listParticipants(input.threadId)
        .find((participant) => participant.sessionID !== input.senderSessionID);
      if (!peerParticipant) {
        throw new Error(`Private thread ${input.threadId} does not have a writable peer participant.`);
      }

      return this.sendPrivateRoomMessage({
        roomCode: thread.roomCode,
        threadId: input.threadId,
        sourceSessionID: input.senderSessionID,
        peerSessionID: peerParticipant.sessionID,
        message: input.message
      });
    }

    const message = this.messageStore.appendMessage({
      threadId: input.threadId,
      senderSessionID: input.senderSessionID,
      messageType: input.messageType ?? "relay",
      body: { text: input.message }
    });
    this.threadStore.touchThread(input.threadId);
    this.threadStore.markRead(input.threadId, input.senderSessionID, message.seq);
    this.threadStore.markNotified(input.threadId, input.senderSessionID, message.seq);

    const queuedRecipients: Array<{ sessionID: string; reason: string }> = [];
    const notifiedRecipients: string[] = [];
    this.deliveryHooks?.recordDiagnostic?.("relay.send.route", {
      roomCode: thread.roomCode,
      roomKind: room?.kind,
      threadId: input.threadId,
      threadKind: thread.kind,
      sourceSessionID: input.senderSessionID,
      deliveryPath: "thread-notify-loop"
    });
    for (const participant of this.threadStore.listParticipants(input.threadId)) {
      if (participant.sessionID === input.senderSessionID) continue;

      const decision = this.deliveryHooks
        ? this.deliveryHooks.resolveNotificationDecision(participant.sessionID)
        : { allowed: false, reason: standaloneDeliveryReason };
      this.deliveryHooks?.recordDiagnostic?.("relay.send.decision", {
        deliveryPath: "thread-notify-loop",
        roomCode: thread.roomCode,
        roomKind: room?.kind,
        threadId: input.threadId,
        threadKind: thread.kind,
        sourceSessionID: input.senderSessionID,
        recipientSessionID: participant.sessionID,
        allowed: decision.allowed,
        reason: decision.reason
      });
      if (!decision.allowed) {
        queuedRecipients.push({ sessionID: participant.sessionID, reason: decision.reason });
        continue;
      }

      const reservedMessages = this.deliveryHooks?.reserveThreadNotifications?.(thread, participant.sessionID, [message]) ?? [message];
      if (reservedMessages.length === 0) {
        continue;
      }

      try {
        await this.deliveryHooks!.notifyThreadParticipant(thread, participant.sessionID, reservedMessages);
        const lastDeliveredSeq = reservedMessages[reservedMessages.length - 1]?.seq;
        if (lastDeliveredSeq !== undefined) {
          this.threadStore.markNotified(input.threadId, participant.sessionID, lastDeliveredSeq);
        }
        notifiedRecipients.push(participant.sessionID);
      } catch (error) {
        queuedRecipients.push({
          sessionID: participant.sessionID,
          reason: `live delivery failed: ${error instanceof Error ? error.message : "unknown error"}`
        });
      } finally {
        this.deliveryHooks?.releaseThreadNotifications?.(thread, participant.sessionID, reservedMessages);
      }
    }

    return {
      threadId: input.threadId,
      seq: message.seq,
      notifiedRecipients,
      queuedRecipients
    };
  }

  private decorateThread(thread: RelayThread): RelayThread & { latestSeq: number; participantCount: number } {
    return {
      ...thread,
      latestSeq: this.messageStore.getLatestSeq(thread.threadId),
      participantCount: this.threadStore.listParticipants(thread.threadId).length
    };
  }
}
