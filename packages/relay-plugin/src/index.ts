import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";

import { buildRelayPluginInstanceKey, resolveRelayPluginConfig } from "./config.js";
import { applyRelaySessionDefaults, createRelayPluginTools, isHookedRelayTool } from "./relay-tool-surface.js";
import { buildCompactionContext } from "./runtime/compaction-anchor.js";
import { createRelayPluginState, type RelayPluginState } from "./runtime/plugin-state.js";
import { deleteRelayPluginStartup, readRelayPluginStartup, readRelayPluginState, registerRelayPluginStartup, registerRelayPluginState, registerRelayProjectInstance } from "./runtime/plugin-instance-registry.js";
import { RelayRuntime } from "./runtime/relay-runtime.js";
import { createRelayA2AHost } from "./a2a/relay-host-factory.js";
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
  const instanceKey = buildRelayPluginInstanceKey(config, projectKey);

  let state: RelayPluginState | undefined = readRelayPluginState(instanceKey);

  if (!state) {
    const existingStartup = readRelayPluginStartup(instanceKey);
    if (existingStartup) {
      state = await existingStartup;
    } else {
      const startup = (async () => {
        const sessionRegistry = new SessionRegistry();
        const runtime = new RelayRuntime(input, config, sessionRegistry);
        const host = createRelayA2AHost(config.a2a, runtime, projectKey);

        await host.start();
        const nextState = createRelayPluginState(config, host, runtime);
        registerRelayPluginState(instanceKey, nextState);
        return nextState;
      })();

      registerRelayPluginStartup(instanceKey, startup);
      try {
        state = await startup;
      } finally {
        deleteRelayPluginStartup(instanceKey);
      }
    }
  }

  registerRelayProjectInstance(projectKey, instanceKey);

  const { relayTools, namespacedRelayTools } = createRelayPluginTools(input, state);

  return {
    event: async ({ event }) => {
      if (event.type !== "session.status" && event.type !== "session.idle") {
        return;
      }

      const sessionID = tryExtractSessionID(event);
      if (!sessionID) {
        return;
      }

      const status = event.type === "session.idle" ? { type: "idle" as const } : event.properties.status;

      await state.runtime.onSessionStatus(sessionID, status);
    },
    tool: {
      ...relayTools,
      ...namespacedRelayTools
    },
    "tool.execute.before": async ({ tool, sessionID }, output) => {
      if (!isHookedRelayTool(tool)) {
        return;
      }

      const args = (output.args ?? {}) as Record<string, unknown>;
      applyRelaySessionDefaults(tool, args, sessionID);
      output.args = args;
    },
    "tool.execute.after": async ({ tool }, _output) => {
      if (!isHookedRelayTool(tool)) {
        return;
      }

      await state.runtime.flushPendingForKnownIdleSessions();
    },
    "experimental.session.compacting": async ({ sessionID }, output) => {
      output.context.push(...buildCompactionContext(state, sessionID));
    }
  };
};

export const server = RelayPlugin;
