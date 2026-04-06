import type { RelayPluginState } from "./plugin-state.js";

const pluginStateByInstance = new Map<string, RelayPluginState>();
const pluginStartupByInstance = new Map<string, Promise<RelayPluginState>>();
const projectToInstance = new Map<string, string>();

export function registerRelayPluginState(instanceKey: string, state: RelayPluginState): void {
  pluginStateByInstance.set(instanceKey, state);
}

export function registerRelayProjectInstance(projectID: string, instanceKey: string): void {
  projectToInstance.set(projectID, instanceKey);
}

export function readRelayPluginState(projectOrInstanceKey: string): RelayPluginState | undefined {
  const instanceKey = projectToInstance.get(projectOrInstanceKey) ?? projectOrInstanceKey;
  return pluginStateByInstance.get(instanceKey);
}

export function registerRelayPluginStartup(instanceKey: string, startup: Promise<RelayPluginState>): void {
  pluginStartupByInstance.set(instanceKey, startup);
}

export function readRelayPluginStartup(instanceKey: string): Promise<RelayPluginState> | undefined {
  return pluginStartupByInstance.get(instanceKey);
}

export function deleteRelayPluginStartup(instanceKey: string): void {
  pluginStartupByInstance.delete(instanceKey);
}

export function deleteRelayPluginState(projectOrInstanceKey: string): void {
  const instanceKey = projectToInstance.get(projectOrInstanceKey) ?? projectOrInstanceKey;
  pluginStateByInstance.delete(instanceKey);
  pluginStartupByInstance.delete(instanceKey);

  for (const [projectID, mappedInstanceKey] of projectToInstance.entries()) {
    if (mappedInstanceKey === instanceKey || projectID === projectOrInstanceKey) {
      projectToInstance.delete(projectID);
    }
  }
}
