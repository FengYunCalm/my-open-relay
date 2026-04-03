import { deleteRelayPluginState, readRelayPluginState } from "../../runtime/plugin-instance-registry.js";

export function getRelayPluginStateForTest(projectID: string) {
  return readRelayPluginState(projectID);
}

export async function stopRelayPluginForTest(projectID: string): Promise<void> {
  const state = readRelayPluginState(projectID);
  if (!state) {
    return;
  }

  state.runtime.close();
  await state.host.stop();
  deleteRelayPluginState(projectID);
}
