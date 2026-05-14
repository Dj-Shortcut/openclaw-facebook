import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { messengerSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(messengerSetupPlugin);
