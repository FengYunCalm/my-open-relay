import { afterEach, describe, expect, it } from "vitest";

import { RoomStore } from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("room store", () => {
  it("creates a room, tracks members, and preserves pair compatibility", () => {
    const location = createTestDatabaseLocation("room-store");
    dbLocations.push(location);
    const roomStore = new RoomStore(location);

    const room = roomStore.createRoom("session-owner");
    expect(room.roomCode).toMatch(/^\d{6}$/);
    expect(room.status).toBe("open");

    const joined = roomStore.joinRoom(room.roomCode, "session-a");
    expect(joined.status).toBe("active");
    expect(roomStore.getPeerSessionID("session-owner")).toBe("session-a");
    expect(roomStore.areSessionsPaired("session-owner", "session-a")).toBe(true);

    roomStore.joinRoom(room.roomCode, "session-b");
    const members = roomStore.listMembers(room.roomCode);
    expect(members).toHaveLength(2);
    expect(roomStore.getMemberSessionIDs(room.roomCode)).toEqual(["session-owner", "session-b"]);
    expect(roomStore.areSessionsPaired("session-owner", "session-b")).toBe(true);
    expect(roomStore.getPeerSessionID("session-owner")).toBe("session-b");
  });

  it("replaces the stale peer when a private room is rejoined from a new session", () => {
    const location = createTestDatabaseLocation("room-store-private-rejoin");
    dbLocations.push(location);
    const roomStore = new RoomStore(location);

    const room = roomStore.createRoom("session-owner");
    roomStore.joinRoom(room.roomCode, "session-old");
    expect(roomStore.getPeerSessionID("session-owner")).toBe("session-old");

    roomStore.joinRoom(room.roomCode, "session-new");

    expect(roomStore.getPeerSessionID("session-owner")).toBe("session-new");
    expect(roomStore.getMember(room.roomCode, "session-old")?.membershipStatus).toBe("removed");
    expect(roomStore.listMembers(room.roomCode).map((member) => member.sessionID)).toEqual(["session-owner", "session-new"]);
  });

  it("treats group aliases case-insensitively and allows a private room to coexist with a group room", () => {
    const location = createTestDatabaseLocation("room-store-alias");
    dbLocations.push(location);
    const roomStore = new RoomStore(location);

    const groupRoom = roomStore.createRoom("session-owner", "group");
    roomStore.joinRoom(groupRoom.roomCode, "session-a", "Alpha");
    expect(() => roomStore.joinRoom(groupRoom.roomCode, "session-b", "alpha")).toThrow(/already in use/);

    const privateRoom = roomStore.createRoom("session-owner", "private");
    expect(privateRoom.kind).toBe("private");
    expect(privateRoom.roomCode).not.toBe(groupRoom.roomCode);
  });
});
