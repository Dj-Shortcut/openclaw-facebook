import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

type MessengerChannelRuntime = {
  monitorMessengerProvider?: typeof import("./monitor.js").monitorMessengerProvider;
  probeMessengerPage?: typeof import("./probe.js").probeMessengerPage;
  resolveMessengerAccount?: typeof import("./accounts.js").resolveMessengerAccount;
  sendMessengerText?: typeof import("./send.js").sendMessengerText;
};

type MessengerRuntime = PluginRuntime & {
  channel: PluginRuntime["channel"] & {
    facebook?: MessengerChannelRuntime;
  };
};

const {
  setRuntime: setMessengerRuntime,
  clearRuntime: clearMessengerRuntime,
  getRuntime: getMessengerRuntime,
} = createPluginRuntimeStore<MessengerRuntime>({
  pluginId: "facebook",
  errorMessage: "Facebook runtime not initialized - plugin not registered",
});

export { clearMessengerRuntime, getMessengerRuntime, setMessengerRuntime };
