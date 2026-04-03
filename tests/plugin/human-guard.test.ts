import { describe, expect, it } from "vitest";

import { HumanGuard } from "../support/relay-plugin-testkit.js";

describe("human guard", () => {
  it("pauses and resumes a session", () => {
    const guard = new HumanGuard();

    guard.pauseSession("session-1", "manual override");
    expect(guard.isPaused("session-1")).toBe(true);
    expect(guard.reason("session-1")).toBe("manual override");

    guard.resumeSession("session-1");
    expect(guard.isPaused("session-1")).toBe(false);
  });
});
