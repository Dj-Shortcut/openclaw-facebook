import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelPlugin,
  OpenClawPluginApi,
  PluginRuntime,
} from "openclaw/plugin-sdk/core";
import { messengerPlugin } from "./src/channel.js";
import { setMessengerRuntime } from "./src/runtime.js";
import type { ResolvedMessengerAccount } from "./src/types.js";

type FacebookPluginEntry = {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: ChannelPlugin<ResolvedMessengerAccount>;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

const facebookPluginEntry: FacebookPluginEntry = defineChannelPluginEntry({
  id: "facebook",
  name: "Facebook",
  description: "Facebook Page Messenger channel plugin",
  plugin: messengerPlugin,
  setRuntime: setMessengerRuntime,
});

export default facebookPluginEntry;
