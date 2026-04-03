# OpenCode A2A Plugin Relay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Build a production-oriented OpenCode plugin that exposes an A2A-compliant agent surface, bridges A2A requests into OpenCode sessions, and keeps MCP capability embedded inside the plugin as an internal implementation detail rather than a separate public protocol surface.

**Architecture:** The final product is a plugin-first system. Externally, it speaks A2A: Agent Card discovery, HTTP(S)+JSON-RPC request handling, Task/Message/Artifact semantics, and streaming status updates. Internally, the plugin owns OpenCode session integration, persistence, replay, human takeover, loop safety, and an optional embedded MCP ops surface for private tooling/resources.

**Tech Stack:** TypeScript, pnpm workspace, Node.js/Bun runtime, OpenCode Plugin SDK, OpenCode JS SDK, A2A Protocol (Agent Card, JSON-RPC 2.0 over HTTP, SSE), Zod, SQLite, Vitest.

---

## 0. Supersession and Direction Change

This plan **supersedes** `docs/plans/2026-04-02-opencode-peer-session-relay-implementation-plan.md` for future implementation work.

The previous plan assumed:
- a custom relay envelope as the primary wire contract
- a separate `relay-mcp` package as a durable mailbox/execution plane
- A2A compatibility as a v1 non-goal

Those assumptions are now obsolete.

### New invariants

1. **The final artifact is a plugin.**
2. **The external protocol is A2A.**
3. **MCP is internal to the plugin** — useful for private tools/resources/ops, but not the public agent-to-agent contract.
4. **OpenCode session bridging must use documented OpenCode capabilities** such as plugin events, `session.status`, `session.prompt({ noReply: true })`, and compaction hooks.
5. **Do not fake A2A** by shipping a custom envelope and calling it compatible.

---

## 1. Scope and Delivery Standard

This plan targets a real first implementation, not a demo.

The first shipped version must include:
- A2A Agent Card discovery for direct configuration / local endpoint use
- A2A request handling over HTTP + JSON-RPC 2.0
- A2A Task/Message/Artifact mapping for OpenCode-backed execution
- streaming task updates for long-running work
- OpenCode session bridging using supported plugin/SDK APIs
- idle-gated execution using `session.status` as the primary signal
- human takeover / pause behavior
- loop guard and duplicate suppression
- restart-safe persistence for unresolved tasks
- replayable audit trail
- end-to-end tests for happy path, interrupt path, restart recovery, and duplicate suppression

### Explicit non-goals for the first implementation

Do **not** implement these in the first pass:
- legacy custom relay envelope as public wire format
- public MCP protocol as the external contract
- multi-hop routing across arbitrary remote agents
- public registry/federation beyond direct Agent Card discovery
- browser/dashboard UI beyond minimal operator hooks
- full enterprise auth matrix before local/direct A2A loop works
- binary attachment streaming beyond the minimum A2A Part support needed by tests

---

## 2. Target Repository Structure

```text
packages/
  a2a-protocol/
    src/
      agent-card.ts
      jsonrpc.ts
      message.ts
      task.ts
      events.ts
      security.ts
      extensions.ts
      ids.ts
  relay-plugin/
    src/
      index.ts
      config.ts
      runtime/
        plugin-state.ts
        session-registry.ts
        delivery-gate.ts
        injector.ts
        response-observer.ts
        human-guard.ts
        loop-guard.ts
        compaction-anchor.ts
      a2a/
        host.ts
        agent-card.ts
        auth.ts
        mapper/
          inbound-request.ts
          outbound-events.ts
        handlers/
          send-message.ts
          send-message-stream.ts
          get-task.ts
          cancel-task.ts
      internal/
        store/
          schema.ts
          task-store.ts
          audit-store.ts
          session-link-store.ts
        mcp/
          server.ts
          tools/
            relay-status.ts
            relay-replay.ts
          resources/
            task-resource.ts
  relay-shared/
    src/
      logger.ts
      time.ts
      result.ts
      constants.ts
tests/
  protocol/
  plugin/
  e2e/
assets/
  skills/
    relay-ops/
      SKILL.md
```

### Important structural decisions

- `packages/relay-mcp/` should **not** become a separately deployed mailbox package.
- If the existing empty `packages/relay-mcp/` directory remains in the repo temporarily, treat it as transitional clutter and remove or repurpose it early.
- `a2a-protocol` is the shared contract package.
- `relay-plugin` is the real system.
- `relay-shared` only contains boring shared primitives.
- Any MCP surface is embedded under `relay-plugin/src/internal/mcp/` and is optional/private.

---

## 3. Delivery Phases

Implementation must follow this order.

1. Prove the plugin can host the required runtime shape.
2. Freeze the A2A contract package.
3. Build plugin bootstrap and internal persistence.
4. Expose Agent Card and A2A request entrypoints.
5. Bridge A2A requests into OpenCode sessions.
6. Add streaming updates, human takeover, and safety guards.
7. Add recovery, replay, and auditability.
8. Only then add optional internal MCP ops surfaces.
9. Finish with end-to-end verification.

If any early feasibility assumption fails, stop and correct the architecture before proceeding.

---

## 4. Critical Architectural Guardrails

These are hard rules.

- Do **not** use `session.idle` as the primary gate. Use `session.status` and treat `session.idle` as compatibility noise only.
- Do **not** expose a custom relay envelope on the wire and label it A2A.
- Do **not** make MCP the public agent protocol.
- Do **not** depend on undocumented plugin teardown/shutdown guarantees.
- Do **not** let internal plugin state become the only source of truth for task recovery.
- Do **not** start with optional OMO skill exposure before core A2A loop is green.
- Do **not** block the project on full OIDC/OpenID Connect support before local direct A2A is proven.

---

## 5. Task Breakdown

### Task 1: Workspace foundation and package reshaping

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `packages/a2a-protocol/package.json`
- Create: `packages/relay-plugin/package.json`
- Create: `packages/relay-shared/package.json`
- Create: `packages/a2a-protocol/src/index.ts`
- Create: `packages/relay-plugin/src/index.ts`
- Create: `packages/relay-shared/src/index.ts`
- Create: `tests/protocol/smoke.test.ts`
- Create: `tests/plugin/smoke.test.ts`
- Create: `tests/e2e/smoke.test.ts`
- Delete or retire: `packages/relay-mcp/` if it remains only as an empty placeholder

**Step 1: Write failing smoke tests**
- Add one import smoke test per package.

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/protocol/smoke.test.ts tests/plugin/smoke.test.ts tests/e2e/smoke.test.ts
```
Expected: FAIL because packages and entrypoints are not wired.

**Step 3: Add minimal workspace scaffolding**
- Configure pnpm workspace.
- Configure shared TypeScript base config.
- Configure Vitest workspace.
- Add package entrypoint declarations.

**Step 4: Add minimal entry files**
- Add stub `index.ts` files so imports resolve.

**Step 5: Re-run tests**
Expected: PASS.

**QA:** The workspace installs, package imports resolve, and the obsolete separate MCP package is no longer part of the target architecture.

---

### Task 2: A2A protocol contract package

**Files:**
- Create: `packages/a2a-protocol/src/agent-card.ts`
- Create: `packages/a2a-protocol/src/jsonrpc.ts`
- Create: `packages/a2a-protocol/src/message.ts`
- Create: `packages/a2a-protocol/src/task.ts`
- Create: `packages/a2a-protocol/src/events.ts`
- Create: `packages/a2a-protocol/src/security.ts`
- Create: `packages/a2a-protocol/src/extensions.ts`
- Create: `packages/a2a-protocol/src/ids.ts`
- Create: `tests/protocol/agent-card.test.ts`
- Create: `tests/protocol/jsonrpc.test.ts`
- Create: `tests/protocol/task-model.test.ts`

**Step 1: Write failing tests**
Cover:
- valid Agent Card parse
- invalid Agent Card rejection
- JSON-RPC request/response validation
- Message vs Task response distinction
- Part validation (`text`, `url`, `data`, optional metadata)
- task lifecycle state validation
- extension declaration shape validation

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/protocol/agent-card.test.ts tests/protocol/jsonrpc.test.ts tests/protocol/task-model.test.ts
```
Expected: FAIL.

**Step 3: Implement protocol contracts**
- Use Zod schemas.
- Model Agent Card identity, endpoint URL, skills/capabilities, auth requirements.
- Model JSON-RPC 2.0 request/response objects.
- Model A2A Message, Task, Artifact, Part, and task status events.
- Model minimal security scheme representation needed by the first implementation.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** No OpenCode-specific fields leak into the public wire contract.

---

### Task 3: Embedded A2A host feasibility inside the plugin

**Files:**
- Create: `packages/relay-plugin/src/config.ts`
- Create: `packages/relay-plugin/src/a2a/host.ts`
- Create: `tests/plugin/a2a-host.test.ts`

**Step 1: Write failing tests**
Cover:
- plugin config can define A2A host/port/base path
- host starts exactly once
- duplicate initialization does not bind a second listener
- host exposes health/readiness callback points
- host can be shut down through explicit runtime control owned by the plugin

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/plugin/a2a-host.test.ts
```
Expected: FAIL.

**Step 3: Implement minimal host bootstrap**
- Build a tiny embeddable HTTP server wrapper for the plugin runtime.
- Make startup idempotent.
- Make shutdown explicit in local runtime code rather than relying on undocumented plugin teardown.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** We have real proof that the plugin can own an A2A listener without inventing unsupported platform hooks.

---

### Task 4: Plugin bootstrap and OpenCode runtime bridge foundation

**Files:**
- Create: `packages/relay-plugin/src/runtime/plugin-state.ts`
- Create: `packages/relay-plugin/src/runtime/session-registry.ts`
- Create: `packages/relay-plugin/src/runtime/delivery-gate.ts`
- Create: `packages/relay-plugin/src/runtime/injector.ts`
- Create: `packages/relay-plugin/src/runtime/compaction-anchor.ts`
- Modify: `packages/relay-plugin/src/index.ts`
- Create: `tests/plugin/bootstrap.test.ts`
- Create: `tests/plugin/delivery-gate.test.ts`

**Step 1: Write failing tests**
Cover:
- plugin boot loads config and runtime state
- sessions can be registered and resolved
- delivery gate uses `session.status` and ignores deprecated assumptions
- injector supports `session.prompt({ noReply: true })` for anchor/context injection
- compaction hook can preserve relay context summary

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/plugin/bootstrap.test.ts tests/plugin/delivery-gate.test.ts
```
Expected: FAIL.

**Step 3: Implement bootstrap foundation**
- Create the plugin entrypoint.
- Initialize state registry and delivery gate.
- Wire session events through a single runtime facade.
- Keep this layer unaware of the old custom envelope design.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** Plugin runtime uses documented OpenCode behavior, not imagined lifecycle APIs.

---

### Task 5: A2A discovery and non-stream request handling

**Files:**
- Create: `packages/relay-plugin/src/a2a/agent-card.ts`
- Create: `packages/relay-plugin/src/a2a/auth.ts`
- Create: `packages/relay-plugin/src/a2a/mapper/inbound-request.ts`
- Create: `packages/relay-plugin/src/a2a/handlers/send-message.ts`
- Create: `packages/relay-plugin/src/a2a/handlers/get-task.ts`
- Create: `packages/relay-plugin/src/a2a/handlers/cancel-task.ts`
- Create: `tests/plugin/agent-card.test.ts`
- Create: `tests/plugin/send-message.test.ts`

**Step 1: Write failing tests**
Cover:
- Agent Card returns correct identity/capabilities/endpoint metadata
- `sendMessage` accepts valid A2A request shape
- request validation rejects malformed JSON-RPC or malformed Message/Task payloads
- non-stream request creates a tracked task record
- `getTask` returns task state
- `cancelTask` marks only cancellable tasks

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/plugin/agent-card.test.ts tests/plugin/send-message.test.ts
```
Expected: FAIL.

**Step 3: Implement minimal A2A request handlers**
- Serve Agent Card.
- Validate auth shape needed for local/direct mode.
- Accept `sendMessage` and create internal task records.
- Return A2A-compliant immediate response objects.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** The public HTTP contract is A2A from day one.

---

### Task 6: Internal persistence and OpenCode task mapping

**Files:**
- Create: `packages/relay-plugin/src/internal/store/schema.ts`
- Create: `packages/relay-plugin/src/internal/store/task-store.ts`
- Create: `packages/relay-plugin/src/internal/store/audit-store.ts`
- Create: `packages/relay-plugin/src/internal/store/session-link-store.ts`
- Create: `packages/relay-plugin/src/runtime/response-observer.ts`
- Create: `tests/plugin/store.test.ts`
- Create: `tests/plugin/response-observer.test.ts`

**Step 1: Write failing tests**
Cover:
- create task record from inbound A2A request
- persist task/session correlation
- append audit events
- map OpenCode session/message observations back into A2A task state
- restart can reload unresolved tasks

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/plugin/store.test.ts tests/plugin/response-observer.test.ts
```
Expected: FAIL.

**Step 3: Implement store layer**
- Use SQLite.
- Persist A2A task state, correlation, session link, and audit timeline.
- Keep store schema private to the plugin.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** Task recovery no longer depends on volatile in-memory runtime only.

---

### Task 7: Streaming task updates and session execution bridge

**Files:**
- Create: `packages/relay-plugin/src/a2a/mapper/outbound-events.ts`
- Create: `packages/relay-plugin/src/a2a/handlers/send-message-stream.ts`
- Modify: `packages/relay-plugin/src/runtime/injector.ts`
- Modify: `packages/relay-plugin/src/runtime/response-observer.ts`
- Create: `tests/plugin/send-message-stream.test.ts`
- Create: `tests/e2e/a2a-happy-path.test.ts`

**Step 1: Write failing tests**
Cover:
- `sendMessageStream` opens a stream and emits submitted/working/completed updates
- OpenCode execution starts only when delivery gate allows it
- OpenCode output becomes A2A task status or artifact events
- immediate response vs streamed task behavior follows A2A semantics

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/plugin/send-message-stream.test.ts tests/e2e/a2a-happy-path.test.ts
```
Expected: FAIL.

**Step 3: Implement streaming bridge**
- Map A2A request to plugin-owned task.
- Inject request context into the target session correctly.
- Stream status/event updates back to the A2A client.
- Ensure artifacts/messages come from task semantics, not from the old custom envelope idea.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** We can execute one real A2A request end to end through an OpenCode session.

---

### Task 8: Human takeover, duplicate suppression, and compaction safety

**Files:**
- Create: `packages/relay-plugin/src/runtime/human-guard.ts`
- Create: `packages/relay-plugin/src/runtime/loop-guard.ts`
- Modify: `packages/relay-plugin/src/runtime/compaction-anchor.ts`
- Create: `tests/plugin/human-guard.test.ts`
- Create: `tests/plugin/loop-guard.test.ts`
- Create: `tests/e2e/human-interrupt.test.ts`
- Create: `tests/e2e/restart-recovery.test.ts`

**Step 1: Write failing tests**
Cover:
- user interruption pauses automated continuation
- duplicate inbound task requests are safely suppressed or coalesced
- loop protection prevents runaway self-chatter
- compaction preserves enough state for unresolved task continuation
- restart restores unresolved tasks without double-processing

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/plugin/human-guard.test.ts tests/plugin/loop-guard.test.ts tests/e2e/human-interrupt.test.ts tests/e2e/restart-recovery.test.ts
```
Expected: FAIL.

**Step 3: Implement safety layer**
- Human always wins over automation.
- Duplicate suppression uses task/session correlation, not brittle text matching.
- Compaction anchor stores only minimal recoverable state.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** The bridge behaves safely under real interruption and restart conditions.

---

### Task 9: Embedded MCP ops surface (optional/internal)

**Files:**
- Create: `packages/relay-plugin/src/internal/mcp/server.ts`
- Create: `packages/relay-plugin/src/internal/mcp/tools/relay-status.ts`
- Create: `packages/relay-plugin/src/internal/mcp/tools/relay-replay.ts`
- Create: `packages/relay-plugin/src/internal/mcp/resources/task-resource.ts`
- Create: `assets/skills/relay-ops/SKILL.md`
- Create: `tests/plugin/internal-mcp.test.ts`

**Step 1: Write failing tests**
Cover:
- internal MCP server can expose task status and replay operations
- task resource exposes auditable task detail without becoming the public agent protocol
- optional skill metadata can point at the embedded MCP surface

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/plugin/internal-mcp.test.ts
```
Expected: FAIL.

**Step 3: Implement the embedded ops surface**
- Keep MCP tools/resources private and operational.
- Document clearly that this MCP surface is an implementation detail and operator aid.
- Do not route external agent traffic through this surface.

**Step 4: Re-run tests**
Expected: PASS.

**QA:** MCP is genuinely integrated into the plugin without replacing A2A as the external contract.

---

### Task 10: Observability and final end-to-end verification

**Files:**
- Create: `packages/relay-shared/src/logger.ts`
- Create: `packages/relay-shared/src/time.ts`
- Create: `packages/relay-shared/src/result.ts`
- Create: `packages/relay-shared/src/constants.ts`
- Create: `tests/e2e/streaming-status.test.ts`
- Create: `tests/e2e/replay-flow.test.ts`
- Create: `tests/e2e/duplicate-suppression.test.ts`

**Step 1: Write failing tests**
Cover:
- streamed status updates are observable and ordered
- replay can recover a failed or interrupted task safely
- duplicate suppression prevents repeated business execution
- logs contain task IDs, session IDs, and correlation details

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm vitest run tests/e2e/streaming-status.test.ts tests/e2e/replay-flow.test.ts tests/e2e/duplicate-suppression.test.ts
```
Expected: FAIL.

**Step 3: Implement observability primitives**
- structured logging
- time helpers
- typed result helpers
- constants for task/event names

**Step 4: Re-run tests**
Expected: PASS.

**QA:** The system is operable, debuggable, and replayable.

---

## 6. Required A2A-to-OpenCode Mapping Rules

These rules must be treated as design constraints, not suggestions.

### Request ingress
- Incoming A2A `Message` or task-start request is validated as A2A first.
- Internal plugin persistence may normalize data, but the public wire shape remains A2A.

### Session execution
- The plugin may inject preparatory context using `session.prompt({ noReply: true })`.
- The actual execution turn must be mapped deliberately and auditable.
- `tui.appendPrompt()` is not the primary transport path for execution.

### Statusing
- Internal plugin state may have more detail than public A2A task status.
- Public responses must map back into valid A2A Task / Message / Artifact semantics.

### Safety
- Human interruption must pause automatic continuation.
- Loop protection must rely on task/session correlation and bounded automatic continuation rules.

### MCP relationship
- MCP tools/resources can help operators and internal workflows.
- MCP must not replace Agent Card discovery, `sendMessage`, or streamed A2A task updates.

---

## 7. Required Acceptance Criteria

The implementation is complete only when all of the following are observable:

### Functional
- An A2A client can discover the plugin through an Agent Card.
- An A2A client can send a request and receive a valid A2A response.
- A long-running request can stream status/artifact updates.
- The plugin can bridge a request into an OpenCode session and map results back into A2A task state.

### Reliability
- Restart reloads unresolved tasks without double-processing.
- Replay can re-drive a recoverable task.
- Duplicate inbound requests are safely suppressed or deduplicated.

### Safety
- Human interruption pauses automation.
- Loop guard prevents runaway self-conversation.
- Deprecated `session.idle` is not the primary scheduling primitive.

### Architecture integrity
- Public wire contract is A2A.
- MCP remains internal/private.
- No legacy custom relay envelope leaks into public API semantics.

### Manual QA
- Run one Agent Card discovery from a real client.
- Run one `sendMessage` happy path.
- Run one `sendMessageStream` happy path.
- Run one human interruption scenario.
- Run one restart recovery scenario.

---

## 8. Suggested First Execution Batch

If execution starts immediately, the first batch should be:
1. Task 1 workspace foundation and package reshaping
2. Task 2 A2A protocol contract package
3. Task 3 embedded A2A host feasibility inside the plugin
4. Task 4 plugin bootstrap and OpenCode runtime bridge foundation

Only after those four are green should the project move on to request handlers and persistence.

---

## 9. Final Note

The biggest risk in this project is no longer “how to relay one session to another.” The real risk is building the wrong public contract. If the public surface is A2A, the architecture must behave like A2A from the start; MCP can still be valuable, but only as a private capability layer inside the plugin. Get the wire contract and runtime boundaries right first, and the rest becomes implementation work rather than semantic rework.
