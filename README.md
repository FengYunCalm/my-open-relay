# OpenCode A2A Plugin Relay

English | [简体中文](README.zh-CN.md)

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
- **Runtime shape:** plugin-first for session hooks, room operations, and session-aware delivery; standalone MCP is compatibility-only
- **Delivery gate:** `session.status` is the primary scheduling signal
- **Persistence:** local SQLite-backed task, audit, session-link, room, thread, and message state
- **Operations surface:** plugin relay tools are the primary operator surface; standalone MCP is compatibility-only and uses distinct `compat_*` tool names

## Implemented capabilities

- Agent Card exposure
- `sendMessage`, `getTask`, `cancelTask`, `sendMessageStream`
- private/group room flow: `relay_room_create`, `relay_room_join`, `relay_room_status`, `relay_room_send`
- team governance: `relay_room_members`, `relay_room_set_role`
- durable thread/message flow: `relay_thread_create`, `relay_thread_list`, `relay_message_list`, `relay_message_send`, `relay_message_mark_read`, `relay_transcript_export`
- workflow bootstrap/status flow: `relay_team_start`, `relay_team_status`
- SSE task event streaming
- idle-gated dispatch into OpenCode sessions
- duplicate suppression, human takeover guard, replay path, and audit trail
- public response/event sanitization for task metadata

## OpenCode skill and local plugin workflow

- Project-local skill: `.opencode/skills/relay-room/SKILL.md`
- Global install target used during local testing:
  - plugin bundle: `~/.config/opencode/plugins/opencode-a2a-relay.js`
  - relay MCP bundle: `~/.config/opencode/plugins/opencode-a2a-relay-mcp.js`
- Global OpenCode config now includes a local MCP server entry named `relay`
- For OpenCode 1.3.6 local-path plugin compatibility, the installed plugin bundle uses `default export { id, server }`

### Why plugin-first
Normal room and message operations must go through the relay plugin tool surface so that session-aware injection and wake-up hooks actually run.
The standalone MCP bridge remains available only for compatibility and manual storage-oriented operations, and now uses distinct `compat_*` tool names to avoid colliding with plugin relay tools.
For normal session-aware relay usage, call only the plugin tools: `relay_room_*`, `relay_thread_*`, `relay_message_*`, and `relay_transcript_export`. Any `relay_compat_*` tool is compatibility-only and does not represent the standard auto-injection path.

### Private room flow (unchanged)
1. Conversation A creates a room
2. Conversation B joins with the room code
3. Either side sends a relayed message to the paired peer

### Group room flow
1. Conversation A creates a **group** room and becomes the owner
2. Other conversations join with a room code **and alias**
3. The owner can broadcast to the room or privately message a specific alias
4. Agents can inspect threads, read durable messages, mark read cursors, and export transcripts

### Team workflow flow
1. The manager session runs `/team <task>`
2. The plugin creates a group room plus child worker sessions
3. Workers join with fixed aliases and report workflow signals such as `[TEAM_READY]`, `[TEAM_PROGRESS]`, `[TEAM_BLOCKER]`, and `[TEAM_DONE]`
4. The manager checks `relay_team_status` to monitor readiness, active work, blockers, completion, and the recent workflow event trail

Quick tutorial: `docs/team-workflow-quickstart.md`

## Get the code

```bash
git clone https://github.com/FengYunCalm/opencode-peer-session-relay.git
cd opencode-peer-session-relay
```

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
- plugin tools and standalone MCP tools are different runtime surfaces and must not be conflated
- execution-oriented room workflows need stronger "tool first, then reply" behavior than a generic explanatory skill
- local plugin compatibility for OpenCode 1.3.6 depends on the correct `default export { id, server }` shape
- the relay plugin may expose either bare `relay_*` tool names or equivalent namespaced `mcp__relay__*` aliases; both belong to the plugin surface, not the standalone compatibility path

## Thanks

Special thanks to the OMO / OhMyOpenCode ecosystem for the plugin patterns, operator workflow inspiration, and practical context that informed this relay-room design.

## Repository status

This repository is source-oriented. It does not claim any npm package, hosted deployment, or public release channel.

## License

MIT
