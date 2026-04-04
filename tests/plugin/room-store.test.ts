import { afterEach, describe, expect, it } from "vitest";

import { RoomStore } from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("room store", () => {
  it("creates and joins a room, then recognizes the paired sessions", () => {
    const location = createTestDatabaseLocation("room-store");
    dbLocations.push(location);
    const roomStore = new RoomStore(location);

    const room = roomStore.createRoom("session-a");
    expect(room.roomCode).toMatch(/^\d{6}$/);
    expect(room.status).toBe("open");

    const joined = roomStore.joinRoom(room.roomCode, "session-b");
    expect(joined.status).toBe("active");
    expect(joined.joinedSessionID).toBe("session-b");
    expect(roomStore.getPeerSessionID("session-a")).toBe("session-b");
    expect(roomStore.areSessionsPaired("session-a", "session-b")).toBe(true);
    expect(roomStore.areSessionsPaired("session-a", "session-c")).toBe(false);
  });
});
