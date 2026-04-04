# OpenCode A2A Plugin Relay

[中文说明](./README.zh-CN.md)

A plugin-first A2A relay for OpenCode. This repository exposes an A2A-facing HTTP/JSON-RPC/SSE surface, bridges requests into OpenCode sessions, and keeps MCP as an internal operations capability rather than the public protocol.

Repository: https://github.com/FengYunCalm/opencode-peer-session-relay

## What this repo contains

- `packages/a2a-protocol` — shared A2A schemas and JSON-RPC/task/message/event contracts
- `packages/relay-plugin` — plugin runtime, A2A host, request routing, persistence, replay, and guards
- `packages/relay-shared` — small shared utilities and constants
- `tests/` — protocol, plugin, and end-to-end verification
- `docs/plans/2026-04-03-opencode-a2a-plugin-relay-implementation-plan.md` — implementation plan used to drive the current design
- `.opencode/skills/relay-room/SKILL.md` — project-local relay-room execution skill

## Current architecture

- **Public contract:** A2A over HTTP JSON-RPC and SSE
- **Runtime shape:** plugin-first; the plugin owns host bootstrap and session bridge logic
- **Delivery gate:** `session.status` is the primary scheduling signal
- **Persistence:** local SQLite-backed task, audit, session-link, and room state
- **Operations surface:** internal MCP only, not the public agent-to-agent interface

## Implemented capabilities

- Agent Card exposure
- `sendMessage`, `getTask`, `cancelTask`, `sendMessageStream`
- room-code pairing flow: `relay_room_create`, `relay_room_join`, `relay_room_status`, `relay_room_send`
- SSE task event streaming
- idle-gated dispatch into OpenCode sessions
- duplicate suppression, human takeover guard, replay path, and audit trail
- public response/event sanitization for task metadata

## OpenCode skill and local plugin workflow

- Project-local skill: `.opencode/skills/relay-room/SKILL.md`
- Global install target used during local testing: `~/.config/opencode/plugins/opencode-a2a-relay.js`
- For OpenCode 1.3.6 local-path plugin compatibility, the installed bundle uses `default export { id, server }`

Typical room-code flow:
1. Conversation A creates a room
2. Conversation B joins with the room code
3. Either side sends a relayed message to the paired peer

## Verification

Current local verification target:

```bash
corepack pnpm test
corepack pnpm exec tsc -b --pretty false
```

At the time of writing, the repository passes the full local test suite and TypeScript project build.

## Development

Install dependencies:

```bash
corepack pnpm install
```

Run tests:

```bash
corepack pnpm test
```

Run typecheck:

```bash
corepack pnpm exec tsc -b --pretty false
```

## What we learned from OMO plugins

This repository was shaped by learning from the OhMyOpenCode / OMO plugin ecosystem, especially around how plugin capabilities, skills, and room-like workflows are surfaced inside OpenCode sessions.

Key takeaways applied here:
- plugin tools and MCP tools are different runtime surfaces and must not be conflated
- execution-oriented room workflows need stronger "tool first, then reply" behavior than a generic explanatory skill
- local plugin compatibility for OpenCode 1.3.6 depends on the correct `default export { id, server }` shape

## Thanks

Special thanks to the OMO / OhMyOpenCode ecosystem for the plugin patterns, operator workflow inspiration, and practical context that informed this relay-room design.

## Repository status

This repository has been split into its own standalone git repository so it can be published independently from the larger parent workspace it originally lived in.

## License

MIT
