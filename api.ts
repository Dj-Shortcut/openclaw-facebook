export type {
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginRuntime,
} from "openclaw/plugin-sdk/core";
export type { ResolvedMessengerAccount } from "./src/types.js";
export { messengerPlugin } from "./src/channel.js";
export { messengerSetupPlugin } from "./src/channel.setup.js";
