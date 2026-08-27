import { afterEach, describe, expect, it, vi } from "vitest";

import { messengerGatewayAdapter } from "./gateway.js";
import { clearMessengerRuntime, setMessengerRuntime } from "./runtime.js";

function gatewayContext() {
  return {
    account: {
      accountId: "default",
      enabled: true,
      pageId: "page-1",
      pageAccessToken: "page-token",
      appSecret: "app-secret",
      verifyToken: "verify-token",
      tokenSource: "config",
      config: {},
    },
    cfg: {},
    runtime: {},
    abortSignal: new AbortController().signal,
    log: { info: vi.fn() },
  };
}

afterEach(() => {
  clearMessengerRuntime();
});

describe("Messenger gateway startup", () => {
  it("starts the personal Messenger provider without a customer quota handshake", async () => {
    const monitor = vi.fn(async () => undefined);
    setMessengerRuntime({
      channel: { facebook: { monitorMessengerProvider: monitor } },
    } as never);

    await messengerGatewayAdapter.startAccount(gatewayContext() as never);

    expect(monitor).toHaveBeenCalledTimes(1);
  });
});
