import { describe, expect, it } from "vitest";

import { evaluateDelivery } from "../support/relay-plugin-testkit.js";

describe("delivery gate", () => {
  it("allows delivery only when session.status is idle", () => {
    expect(evaluateDelivery({ type: "idle" }).allowed).toBe(true);
    expect(evaluateDelivery({ type: "busy" }).allowed).toBe(false);
    expect(evaluateDelivery({ type: "retry", attempt: 2, message: "retrying", next: Date.now() }).allowed).toBe(false);
  });

  it("does not treat deprecated session.idle as a scheduling input", () => {
    const decision = evaluateDelivery(undefined);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("unknown");
  });
});
