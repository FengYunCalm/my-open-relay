import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";

import { A2ARelayHost } from "./a2a/host.js";
import { resolveRelayPluginConfig } from "./config.js";
import { buildCompactionContext } from "./runtime/compaction-anchor.js";
import { createRelayPluginState, type RelayPluginState } from "./runtime/plugin-state.js";
import { readRelayPluginState, registerRelayPluginState } from "./runtime/plugin-instance-registry.js";
import { RelayRuntime } from "./runtime/relay-runtime.js";
import { SessionRegistry } from "./runtime/session-registry.js";

export const pluginPackageName = "@opencode-peer-session-relay/relay-plugin";
export const pluginVersion = "0.1.0";

function tryExtractSessionID(event: Event): string | undefined {
  if ("properties" in event && event.properties && typeof event.properties === "object") {
    const maybeSessionID = (event.properties as { sessionID?: unknown }).sessionID;
    if (typeof maybeSessionID === "string") {
      return maybeSessionID;
    }
  }

  return undefined;
}

export const RelayPlugin: Plugin = async (input, options) => {
  const config = resolveRelayPluginConfig(options);
  const projectKey = input.project.id;

  let state: RelayPluginState | undefined = readRelayPluginState(projectKey);

  if (!state) {
    const sessionRegistry = new SessionRegistry();
    const runtime = new RelayRuntime(input, config, sessionRegistry);
    let host: A2ARelayHost;
    host = new A2ARelayHost(config.a2a, {
      readiness: () => ({ ok: true, detail: "relay plugin runtime booted" }),
      health: () => ({
        projectID: projectKey,
        startedAt: new Date().toISOString(),
        activeTaskCount: runtime.taskStore.listActiveTasks().length
      }),
      agentCard: () => runtime.buildAgentCard(host.url),
      rpc: async (payload) => runtime.handleJsonRpc(payload)
    });

    await host.start();
    state = createRelayPluginState(config, host, runtime);
    registerRelayPluginState(projectKey, state);
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.status") {
        return;
      }

      const sessionID = tryExtractSessionID(event);
      const status = event.properties.status;
      if (!sessionID) {
        return;
      }

      await state.runtime.onSessionStatus(sessionID, status);
    },
    "experimental.session.compacting": async ({ sessionID }, output) => {
      output.context.push(...buildCompactionContext(state, sessionID));
    }
  };
};
