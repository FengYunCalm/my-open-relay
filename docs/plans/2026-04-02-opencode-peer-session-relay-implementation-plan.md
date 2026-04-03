# OpenCode Peer Session Relay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Build a complete first production-ready version of a peer main-session relay system for OpenCode, where two top-level sessions communicate asynchronously like subagents through a plugin control plane plus an MCP-backed mailbox.

**Architecture:** The plugin is the only control plane inside OpenCode. It owns session registration, event subscriptions, background polling, idle-gated delivery, communication-message wrapping, human takeover, loop guards, and compaction-safe state. The MCP service is the durable mailbox and execution plane. It owns send/claim/ack/retry/history, route lookup, correlation tracking, dead-lettering, and replay. There is no separate always-on bridge/orchestrator process.

**Tech Stack:** TypeScript, pnpm workspace, Node.js, OpenCode Plugin SDK, OpenCode SDK/Server API, MCP server, SQLite, Vitest, Zod.

---

## 1. Scope and Delivery Standard

This plan targets a **complete v1**, not a throwaway MVP. That means the first shipped version must already include:

- durable mailbox semantics
- correlation and reply routing
- plugin-owned background worker
- idle-gated delivery
- explicit communication-message wrapping
- human takeover and pause/resume
- loop guard and dedupe
- compaction-safe state preservation
- audit logs and replay/debug entry points
- end-to-end tests for normal flow, retry flow, human interruption, and restart recovery

### Explicit non-goals for v1

Do **not** implement the following in v1:

- group chat / broadcast / fan-out
- multi-hop routing
- binary attachments
- arbitrary artifact streaming
- full A2A compatibility
- cross-machine federation
- UI dashboard beyond minimal debug/ops commands
- end-to-end encryption

---

## 2. Target Repository Structure

This plan assumes the project root is the current folder and uses the following structure:

```text
packages/
  relay-protocol/
    src/
      envelope.ts
      states.ts
      errors.ts
      guards.ts
      ids.ts
  relay-mcp/
    src/
      index.ts
      config.ts
      tools/
        send.ts
        claim.ts
        ack.ts
        nack.ts
        history.ts
        routes.ts
        replay.ts
      store/
        schema.ts
        message-store.ts
        route-store.ts
        lease-store.ts
        audit-store.ts
  relay-plugin/
    src/
      index.ts
      config.ts
      hooks/
        chat-message.ts
        event-handler.ts
        compaction.ts
      runtime/
        worker.ts
        pending-queue.ts
        session-registry.ts
        injector.ts
        reply-router.ts
        state-anchor.ts
        stop-guard.ts
        loop-guard.ts
        relay-state.ts
      format/
        inbound-message.ts
        outbound-message.ts
      commands/
        relay-status.ts
        relay-pause.ts
        relay-resume.ts
        relay-replay.ts
  relay-shared/
    src/
      logger.ts
      time.ts
      result.ts
      constants.ts
tests/
  protocol/
  mcp/
  plugin/
  e2e/
```

---

## 3. Delivery Phases

Implementation must follow this order. Do not skip forward.

1. Freeze protocol and state machine.
2. Build the MCP mailbox core.
3. Build plugin bootstrap and runtime state.
4. Build idle-gated delivery and inbound injection.
5. Build reply routing and outbound publishing.
6. Build human takeover and loop guard.
7. Build compaction-safe persistence and restart recovery.
8. Build observability and replay/debug commands.
9. Build end-to-end tests.
10. Only then consider polish.

---

## 4. Task Breakdown

### Task 1: Workspace and package foundation

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `packages/relay-protocol/package.json`
- Create: `packages/relay-mcp/package.json`
- Create: `packages/relay-plugin/package.json`
- Create: `packages/relay-shared/package.json`

**Step 1: Write the failing smoke tests**
- Add one workspace test per package that asserts the package entrypoint can be imported.

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/protocol tests/mcp tests/plugin
```
Expected: import/entry failures because entry files do not exist yet.

**Step 3: Add minimal workspace scaffolding**
- Configure pnpm workspace.
- Configure shared TypeScript base config.
- Configure Vitest workspace.
- Add package entrypoint declarations.

**Step 4: Add minimal entry files**
- Add stub `index.ts` files in each package so imports resolve.

**Step 5: Run tests to verify they pass**
Run:
```bash
pnpm vitest run tests/protocol tests/mcp tests/plugin
```
Expected: PASS.

**QA:** Workspace installs cleanly and all package entrypoints resolve.

---

### Task 2: Relay protocol contract

**Files:**
- Create: `packages/relay-protocol/src/envelope.ts`
- Create: `packages/relay-protocol/src/states.ts`
- Create: `packages/relay-protocol/src/errors.ts`
- Create: `packages/relay-protocol/src/guards.ts`
- Create: `packages/relay-protocol/src/ids.ts`
- Create: `tests/protocol/envelope.test.ts`
- Create: `tests/protocol/states.test.ts`

**Step 1: Write failing tests**
Cover:
- valid envelope parse
- invalid envelope rejection
- legal state transitions only
- hop count guard behavior
- dedupe key creation stability

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/protocol/envelope.test.ts tests/protocol/states.test.ts
```
Expected: FAIL because protocol files are not implemented.

**Step 3: Implement protocol types and schemas**
- Use Zod for envelope validation.
- Define message kinds: `agent_turn`, `reply`, `control`.
- Define state machine values: `created`, `queued`, `claimed`, `injected`, `observed`, `replied`, `completed`, `retryable_failed`, `dead_letter`, `suppressed`.
- Define helper guards for hop count, trace loop detection, and reply requirements.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** Protocol is frozen and reusable by both MCP and plugin packages.

---

### Task 3: MCP mailbox schema and store layer

**Files:**
- Create: `packages/relay-mcp/src/store/schema.ts`
- Create: `packages/relay-mcp/src/store/message-store.ts`
- Create: `packages/relay-mcp/src/store/route-store.ts`
- Create: `packages/relay-mcp/src/store/lease-store.ts`
- Create: `packages/relay-mcp/src/store/audit-store.ts`
- Create: `tests/mcp/store.test.ts`

**Step 1: Write failing store tests**
Cover:
- insert message
- claim message with lease
- ack message
- retry on nack
- dead-letter after max failures
- route register + resolve
- audit row creation

**Step 2: Run tests to verify failure**
Run:
```bash
pnpm vitest run tests/mcp/store.test.ts
```
Expected: FAIL.

**Step 3: Implement SQLite schema**
Tables minimum:
- `relay_messages`
- `relay_routes`
- `relay_leases`
- `relay_audit`

Required columns include:
- relay ID
- correlation ID
- thread ID
- from/to session
- state
- dedupe key
- attempt count
- lease timestamps
- created/updated timestamps

**Step 4: Implement stores**
- deterministic route registration
- claim with lease timeout
- ack transition to `injected`
- nack transition to `retryable_failed`
- dead-letter transition
- replay/history lookup

**Step 5: Re-run tests**
Expected: PASS.

**QA:** Mailbox durability and state transitions are trustworthy without the plugin.

---

### Task 4: MCP tool surface

**Files:**
- Create: `packages/relay-mcp/src/index.ts`
- Create: `packages/relay-mcp/src/config.ts`
- Create: `packages/relay-mcp/src/tools/send.ts`
- Create: `packages/relay-mcp/src/tools/claim.ts`
- Create: `packages/relay-mcp/src/tools/ack.ts`
- Create: `packages/relay-mcp/src/tools/nack.ts`
- Create: `packages/relay-mcp/src/tools/history.ts`
- Create: `packages/relay-mcp/src/tools/routes.ts`
- Create: `packages/relay-mcp/src/tools/replay.ts`
- Create: `tests/mcp/tools.test.ts`

**Step 1: Write failing tool tests**
Cover:
- `send`
- `claim`
- `ack`
- `nack`
- `history`
- `registerRoute`
- `resolveRoute`
- `replay`

**Step 2: Run tests to verify failure**
Run:
```bash
pnpm vitest run tests/mcp/tools.test.ts
```
Expected: FAIL.

**Step 3: Implement MCP tool layer**
- Validate all inputs using protocol schemas.
- Ensure tool outputs are stable JSON objects with explicit status codes.
- Ensure `ack` means only “successfully injected into target session entrypoint”, not “fully processed by receiver”.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** MCP tool contract is stable enough for plugin integration.

---

### Task 5: Plugin bootstrap and runtime registry

**Files:**
- Create: `packages/relay-plugin/src/index.ts`
- Create: `packages/relay-plugin/src/config.ts`
- Create: `packages/relay-plugin/src/runtime/session-registry.ts`
- Create: `packages/relay-plugin/src/runtime/relay-state.ts`
- Create: `tests/plugin/bootstrap.test.ts`

**Step 1: Write failing tests**
Cover:
- plugin config loads
- session registration works
- session registry resolves by session ID and optional slug
- runtime state records relay enable/disable flags

**Step 2: Run tests to verify failure**
Run:
```bash
pnpm vitest run tests/plugin/bootstrap.test.ts
```
Expected: FAIL.

**Step 3: Implement plugin bootstrap**
- Create plugin entrypoint.
- Load config from environment/plugin options.
- Initialize MCP client.
- Initialize runtime state store.
- Initialize session registry.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** Plugin can boot consistently and owns its runtime state.

---

### Task 6: Plugin-owned background worker and pending queue

**Files:**
- Create: `packages/relay-plugin/src/runtime/worker.ts`
- Create: `packages/relay-plugin/src/runtime/pending-queue.ts`
- Create: `tests/plugin/worker.test.ts`

**Step 1: Write failing tests**
Cover:
- poll MCP and enqueue pending messages
- do not deliver directly when session is busy
- respect lease + dedupe
- handle retryable failures cleanly

**Step 2: Run tests to verify failure**
Run:
```bash
pnpm vitest run tests/plugin/worker.test.ts
```
Expected: FAIL.

**Step 3: Implement worker**
- Worker polls MCP on interval or long-poll.
- Claimed messages go into local pending queue keyed by target session.
- Worker must never call the model or session directly during claim handling.
- Delivery is deferred until `session.idle`.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** Polling exists only in plugin runtime, not in model behavior.

---

### Task 7: Inbound formatting and idle-gated injection

**Files:**
- Create: `packages/relay-plugin/src/format/inbound-message.ts`
- Create: `packages/relay-plugin/src/runtime/injector.ts`
- Create: `packages/relay-plugin/src/hooks/event-handler.ts`
- Create: `tests/plugin/injector.test.ts`

**Step 1: Write failing tests**
Cover:
- communication message is wrapped with explicit metadata
- injector fires only after `session.idle`
- `promptAsync` is called with wrapped parts
- successful injection triggers MCP ack

**Step 2: Run tests to verify failure**
Run:
```bash
pnpm vitest run tests/plugin/injector.test.ts
```
Expected: FAIL.

**Step 3: Implement inbound format**
Required format must clearly state:
- this is a communication message
- from session
- from agent
- thread ID
- correlation ID
- reply target

**Step 4: Implement idle-gated injector**
- Listen for `session.idle` events.
- Drain the local pending queue for that session.
- Inject using `session.promptAsync()`.
- Only ack after promptAsync succeeds.

**Step 5: Re-run tests**
Expected: PASS.

**QA:** No message is injected into a busy session.

---

### Task 8: Outbound publishing and reply routing

**Files:**
- Create: `packages/relay-plugin/src/format/outbound-message.ts`
- Create: `packages/relay-plugin/src/runtime/reply-router.ts`
- Create: `packages/relay-plugin/src/hooks/chat-message.ts`
- Create: `tests/plugin/reply-router.test.ts`

**Step 1: Write failing tests**
Cover:
- outbound relay request from session A to B
- reply from B is routed back to A using correlation metadata
- non-relay local chat is ignored
- wrong-thread reply is rejected

**Step 2: Run tests to verify failure**
Run:
```bash
pnpm vitest run tests/plugin/reply-router.test.ts
```
Expected: FAIL.

**Step 3: Implement outbound path**
- Publish relay envelopes via MCP `send`.
- Maintain correlation ledger locally for fast checks.
- Ensure reply uses explicit `replyTo` and original `threadId`.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** Replies never rely on fuzzy text inference.

---

### Task 9: Human takeover and stop guard

**Files:**
- Create: `packages/relay-plugin/src/runtime/stop-guard.ts`
- Create: `packages/relay-plugin/src/commands/relay-pause.ts`
- Create: `packages/relay-plugin/src/commands/relay-resume.ts`
- Create: `tests/plugin/stop-guard.test.ts`

**Step 1: Write failing tests**
Cover:
- real user message pauses auto relay
- manual pause blocks automatic injection
- resume re-enables delivery
- pending queue remains intact while paused

**Step 2: Run tests to verify failure**
Run:
```bash
pnpm vitest run tests/plugin/stop-guard.test.ts
```
Expected: FAIL.

**Step 3: Implement stop guard**
- When a real user message appears, clear stop state only when safe and suspend automatic relay.
- Provide pause/resume commands.
- Guard against permission/question waiting states if surfaced by event stream.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** Human always wins over automation.

---

### Task 10: Loop guard and duplicate suppression

**Files:**
- Create: `packages/relay-plugin/src/runtime/loop-guard.ts`
- Create: `tests/plugin/loop-guard.test.ts`

**Step 1: Write failing tests**
Cover:
- repeated trace causes suppression
- hop count over max causes suppression
- same dedupe key cannot produce repeated auto-processing
- auto reply limit prevents infinite ping-pong

**Step 2: Run tests to verify failure**
Run:
```bash
pnpm vitest run tests/plugin/loop-guard.test.ts
```
Expected: FAIL.

**Step 3: Implement loop guard**
- max hop count
- repeated trace detection
- dedupe key cache
- max automatic turns per thread

**Step 4: Re-run tests**
Expected: PASS.

**QA:** Two sessions cannot get trapped in infinite automatic conversation.

---

### Task 11: Compaction-safe state anchors and restart recovery

**Files:**
- Create: `packages/relay-plugin/src/runtime/state-anchor.ts`
- Create: `packages/relay-plugin/src/hooks/compaction.ts`
- Create: `tests/plugin/compaction.test.ts`
- Create: `tests/e2e/restart-recovery.test.ts`

**Step 1: Write failing tests**
Cover:
- compaction hook injects minimum relay context
- `noReply` anchor preserves unresolved correlation metadata
- plugin restart can recover pending delivery state
- already acked messages are not reinjected after restart

**Step 2: Run tests to verify failure**
Run:
```bash
pnpm vitest run tests/plugin/compaction.test.ts tests/e2e/restart-recovery.test.ts
```
Expected: FAIL.

**Step 3: Implement compaction-safe state**
- Use `experimental.session.compacting` to inject minimal context.
- Use `session.prompt({ noReply: true })` for anchor state only.
- Rebuild runtime state from MCP + local anchors on startup.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** Compaction and restart do not break unresolved relay threads.

---

### Task 12: Observability, replay, and operator commands

**Files:**
- Create: `packages/relay-shared/src/logger.ts`
- Create: `packages/relay-shared/src/time.ts`
- Create: `packages/relay-shared/src/result.ts`
- Create: `packages/relay-shared/src/constants.ts`
- Create: `packages/relay-plugin/src/commands/relay-status.ts`
- Create: `packages/relay-plugin/src/commands/relay-replay.ts`
- Create: `tests/e2e/relay-status.test.ts`

**Step 1: Write failing tests**
Cover:
- status command reports queue + route + pause state
- replay command requeues dead-letter or historical message safely
- logs contain correlation ID and relay ID

**Step 2: Run tests to verify failure**
Run:
```bash
pnpm vitest run tests/e2e/relay-status.test.ts
```
Expected: FAIL.

**Step 3: Implement shared observability primitives**
- structured logger
- time helpers
- result helpers
- constants

**Step 4: Implement operator commands**
- `/relay-status`
- `/relay-pause`
- `/relay-resume`
- `/relay-replay`

**Step 5: Re-run tests**
Expected: PASS.

**QA:** Failures are inspectable and recoverable.

---

### Task 13: Full end-to-end relay verification

**Files:**
- Create: `tests/e2e/peer-relay-happy-path.test.ts`
- Create: `tests/e2e/retry-flow.test.ts`
- Create: `tests/e2e/human-takeover.test.ts`
- Create: `tests/e2e/loop-suppression.test.ts`

**Step 1: Write failing end-to-end tests**
Required flows:
1. A sends to B, B receives and processes, B replies, A receives reply.
2. Ack failure causes retry without duplicate business processing.
3. User interrupts target session and automation pauses.
4. Mutual auto-reply scenario is suppressed by loop guard.

**Step 2: Run tests to verify failure**
Run:
```bash
pnpm vitest run tests/e2e
```
Expected: FAIL.

**Step 3: Wire all layers together**
- Start MCP mailbox.
- Start plugin runtime.
- Simulate or connect test sessions.
- Validate event-driven flow.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** The system behaves as a real peer main-session relay, not as a fake demo.

---

## 5. Message Model Rules

### Required envelope fields

```json
{
  "relayId": "relay_01",
  "threadId": "thread_login_review",
  "correlationId": "corr_01",
  "replyTo": null,
  "from": {
    "sessionId": "ses_A",
    "slug": "planner-a",
    "agent": "planner"
  },
  "to": {
    "sessionId": "ses_B",
    "slug": "reviewer-b",
    "agent": "reviewer"
  },
  "kind": "agent_turn",
  "body": {
    "type": "text",
    "text": "请检查 login 流程的认证与 session 风险。"
  },
  "meta": {
    "hopCount": 0,
    "trace": ["ses_A"],
    "source": "relay-plugin",
    "requiresReply": true,
    "dedupeKey": "...",
    "createdAt": "2026-04-02T00:00:00+08:00"
  }
}
```

### Injection text template

```text
[对话通信消息]
from_session: ses_A
from_agent: planner
thread: thread_login_review
correlation: corr_01
reply_to: none
requires_reply: true

请检查 login 流程的认证与 session 风险。
```

Rules:
- Never pretend this is a native local user message.
- Behavior may be user-like, but trust semantics must stay explicit.
- `control` messages are not injected as normal chat turns.

---

## 6. State Machine Rules

### Delivery semantics
- `created`: accepted by sender
- `queued`: ready for claim
- `claimed`: lease held by a worker
- `injected`: `promptAsync` has succeeded
- `observed`: target session has emitted evidence of processing
- `replied`: target has published a reply envelope
- `completed`: original exchange is finished
- `retryable_failed`: temporary failure, may retry
- `dead_letter`: exceeded retry budget
- `suppressed`: intentionally blocked by human takeover or loop guard

### Hard semantic boundary
- `ack` means **the bridge successfully injected into the target session entrypoint**.
- `ack` does **not** mean the target fully processed the request.
- `completed` requires reply or explicit terminal no-reply policy.

---

## 7. Required Acceptance Criteria

The system is complete only when all of the following are observable:

### Functional
- Session A can publish a relay message to Session B.
- Session B only receives it on an idle-safe boundary.
- Session B can produce a reply that routes back to Session A.
- Session A receives the reply in the correct thread.

### Reliability
- A failed ack causes retry without duplicate processing.
- A crashed worker can recover unacked messages.
- Lease expiry results in safe re-claim.
- Dead-letter messages remain inspectable and replayable.

### Safety
- Injected messages explicitly identify relay origin.
- Human input interrupts automation.
- Loop guard halts infinite back-and-forth.
- Compaction and restart do not erase unresolved relay state.

### Manual QA
- Run one happy-path relay between two sessions.
- Run one human interruption scenario.
- Run one restart recovery scenario.
- Run one mutual auto-reply loop scenario and confirm suppression.

---

## 8. Implementation Order Guardrails

Do not start with UI.
Do not start with A2A compatibility.
Do not start with attachments.
Do not start with multi-hop routing.
Do not let the model itself poll for messages.
Do not acknowledge delivery before `promptAsync` succeeds.
Do not treat `messages.transform` or `session.compacting` as the only reliability mechanism.

---

## 9. Suggested First Execution Batch

If execution starts immediately, the first batch should be:
1. Task 1 workspace foundation
2. Task 2 protocol contract
3. Task 3 MCP schema/store
4. Task 4 MCP tools

Only after those four are green should the plugin package move beyond bootstrap.

---

## 10. Final Note

This plan intentionally chooses boring technology and explicit protocol semantics. The danger in this project is not code volume; it is ambiguous delivery semantics, wrong state boundaries, and human/automation conflict. Build the protocol and control plane correctly first, and the rest becomes implementation work rather than guesswork.
