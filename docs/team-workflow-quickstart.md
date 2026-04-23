# Team Workflow Quickstart

This repository now exposes a minimal relay-backed team workflow on top of the plugin-first relay runtime.

## What it does

- keeps the current conversation as the **manager**
- creates a relay **group room**
- creates three worker root sessions: `planner`, `implementer`, `reviewer`
- bootstraps those workers so they join the room and report status through relay messages

## Start a workflow

In an OpenCode conversation inside this repository, run:

```text
/team <your task>
```

Example:

```text
/team implement a stable relay workflow status surface
```

The workflow tool will return:

- `runId`
- `roomCode`
- `managerSessionID`
- the worker root sessions that were created

## Check workflow status

In the manager session, use:

```text
relay_team_status
```

or the namespaced plugin alias if that is what the session exposes:

```text
mcp__relay__team_status
```

This returns the current workflow state plus each worker's role, alias, and status.

`relay_team_status` also returns structured worker metadata when the worker reports it through a `[TEAM_*]` JSON payload, including:

- `workflowSource`
- `workflowPhase`
- `progress`
- `evidence`

It also returns a `recentEvents` timeline so the manager can see what actually happened recently instead of relying only on the latest worker snapshot.

## Worker message protocol

Workers use short relay room messages with these markers:

- `[TEAM_READY]` — joined and ready
- `[TEAM_PROGRESS] {"source":"openspec|superpowers|omo","phase":"...","note":"...","progress":40,"evidence":[...],"handoffTo":"manager","deliverables":[...]}` — real work is now underway
- `[TEAM_BLOCKER] {"source":"openspec|superpowers|omo","phase":"...","note":"blocked and needs help","evidence":[...],"handoffTo":"manager"}`
- `[TEAM_DONE] {"source":"openspec|superpowers|omo","phase":"...","note":"completed their part","evidence":[...],"handoffTo":"manager","deliverables":[...]}`

These signals are persisted in the workflow state and are also included in compaction context.
`[TEAM_PROGRESS]`, `[TEAM_BLOCKER]`, and `[TEAM_DONE]` must include valid structured fields. If `source`, `phase`, or required completion evidence is missing, the runtime can reject the signal and keep the previous worker status.

The runtime does **not** parse OMO, Superpowers, or OpenSpec native state machines directly. It only trusts the unified `[TEAM_*]` signals plus health/stale detection.

## Preferred role tooling

Use the workflow systems already exposed in the session environment like this:

1. **planner** → prefer OpenSpec commands/MCP/skills to create or update proposal/spec/design/tasks artifacts for the current change
2. **implementer** → prefer Superpowers execution skills such as writing-plans / executing-plans / subagent-driven-development style flows
3. **reviewer** → prefer OMO review/orchestration capabilities for structured review, escalation, and follow-up

If one of those systems is not actually exposed in the worker session, fall back to the normal local skills/tools in that session and keep reporting through `[TEAM_*]` signals.

## How to coordinate as manager

1. Start the team with `/team ...`
2. Watch `relay_team_status` until workers move from `bootstrapped` / `joined` to `ready`, and then to `in_progress` when real work begins
3. Use normal plugin relay tools for follow-up coordination:
   - `relay_room_send`
   - `relay_thread_create`
   - `relay_message_send`
   - `relay_transcript_export`
4. If a worker becomes `blocked`, `failed`, `stale`, or repeatedly sends rejected TEAM signals, use `relay_team_intervene` to issue a standardized manager action (`retry`, `reassign`, `unblock`, `nudge`)
5. Use `relay_team_status` again to confirm the intervention was recorded in `recentEvents`
6. After a run reaches `completed` or `failed`, use `relay_team_cleanup` to delete the worker root sessions without losing relay room, thread, or audit history

`relay_team_status` also returns:

- `recommendedActions` — manager-side suggestions derived from stale workers, rejected TEAM signals, blocked workers, or explicit handoff hints
- `attentionItems` — more stable high-priority issues that should not be missed even if the recent event window keeps moving
- `interventionOutcomes` — whether a manager intervention is still pending, has been acknowledged by a valid TEAM signal, has been resolved by a completion/handoff signal, or is still problematic after the intervention
- `policyDecisions` — a normalized manager policy layer that summarizes whether the current situation should be observed, manually intervened, or escalated

If the same worker keeps sending rejected TEAM signals or remains problematic after intervention, `attentionItems` can escalate the issue and suggest a stronger action such as `reassign`.

If you want to apply one of the explicit policy decisions directly, use `relay_team_apply_policy` instead of manually translating the decision into a separate intervention call.

## Important boundary

Normal workflow usage must stay on the **plugin** surface.

- Use `relay_*` or `mcp__relay__*`
- Do **not** use `relay_compat_*` for normal workflow execution

The compatibility path is storage-oriented and does not provide the session-aware relay workflow behavior.

## Operator commands

Inside this repository, you can also use these repo-local commands for operator workflows:

- `/relay-status [taskId]`
- `/relay-pause <sessionID> [reason]`
- `/relay-resume <sessionID>`
- `/relay-replay <taskId>`

These commands target the internal relay ops surface for inspection, pause/resume control, and recoverable replay. They do not replace the plugin-first room or team workflow tools.
