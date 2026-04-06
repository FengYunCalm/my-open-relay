import { RelayPlugin } from "./index.js";

export const OpencodeA2ARelayPlugin = RelayPlugin;

const LocalRelayPlugin = {
  id: "opencode-a2a-relay",
  server: RelayPlugin
};

export default LocalRelayPlugin;
