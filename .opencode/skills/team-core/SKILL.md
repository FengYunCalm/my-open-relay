---
name: team-core
description: Bootstrap a minimal relay-backed OpenCode workflow team from the current session and keep the current session as manager.
license: MIT
compatibility: opencode
metadata:
  audience: operators
  workflow: team-runtime
---

# Team Core Skill

Use this skill when the user wants to start an OpenCode workflow team from the current conversation.

## Core rule

The current session stays the **manager**.
Do not ask the user to manually create rooms, track session IDs, or wire child sessions together.

## First action

When the user gives a concrete task, your **first action must be**:

- call `relay_team_start`
- or call `mcp__relay__team_start` if the session exposes only the namespaced plugin alias
- pass the task text as `task`

Do not start by explaining the workflow.
Do not ask for confirmation when the task is already clear.
Do not switch to the compatibility path.

## What this tool is expected to do

`relay_team_start` should:

1. create a relay-backed group room owned by the current session
2. create the default worker sessions as children of the current manager session
3. bootstrap the workers so they join the room with fixed aliases
4. return the room code plus the worker session IDs

`relay_team_status` should:

1. report the current team run status for the current manager or worker session
2. show each worker's role, alias, and workflow state
3. make blockers or failures visible without requiring raw session tracking

## Manager contract after bootstrap

After the tool call, stay in the current session as manager.

- report the actual room code and worker sessions from tool output
- treat workers as asynchronous child sessions
- use `relay_team_status` / `mcp__relay__team_status` to monitor readiness, blockers, and completion
- use `relay_team_status` as the manager timeline view; it includes recent workflow events in addition to the latest worker snapshot
- use normal plugin relay tools for any follow-up coordination
- keep all normal relay work on the plugin surface: `relay_room_*`, `relay_thread_*`, `relay_message_*`, `relay_transcript_export`, or the equivalent `mcp__relay__*` aliases

## Worker message protocol

Workers should coordinate through short structured room messages:

- `[TEAM_READY]` — worker joined and is ready
- `[TEAM_PROGRESS] {"source":"openspec|superpowers|omo","phase":"...","note":"...","progress":40,"evidence":[...],"handoffTo":"manager","deliverables":[...]}` — actual work has started
- `[TEAM_BLOCKER] {"source":"openspec|superpowers|omo","phase":"...","note":"what is blocked","evidence":[...],"handoffTo":"manager"}`
- `[TEAM_DONE] {"source":"openspec|superpowers|omo","phase":"...","note":"completion handoff","evidence":[...],"handoffTo":"manager","deliverables":[...]}`

These markers help the manager keep workflow state readable and durable across compaction.
Include optional handoff fields like `handoffTo` and `deliverables` when a worker is handing work back to the manager or another role.

## Worker capability contract

The spawned worker sessions may use any skills, workflows, or plugins that are actually exposed in their own session environment.
Prefer this routing when the corresponding tools are actually exposed in the child session:

- **planner** → OpenSpec commands/MCP/skills for proposal/spec/design/tasks artifacts
- **implementer** → Superpowers execution skills such as writing-plans / executing-plans / subagent-driven-development style flows
- **reviewer** → OMO review/orchestration capabilities for escalation, quality review, and structured follow-up

BMAD remains optional planning-mode only when it is actually exposed and the task is large enough to justify it.
Do not promise tools or skills that are not actually present.

## Must not do

- do not use `relay_compat_*` or any standalone compatibility-path tool for normal workflow bootstrap
- do not fabricate room codes, session IDs, aliases, or team state
- do not tell the user to hand-edit `sessionID`
- do not make `/team` itself the runtime; the runtime is the relay plugin plus the session API

## Failure handling

If `relay_team_start` / `mcp__relay__team_start` is missing, report that plainly.
If `relay_team_status` / `mcp__relay__team_status` is missing, report that plainly.
If the tool fails because the session API is unavailable, report that plainly.
Do not silently fall back to a fake or storage-only path.
