import {
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
} from "openclaw/plugin-sdk/channel-message";
import {
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { type ChannelPlugin, type ResolvedMessengerAccount } from "./channel-api.js";
import { FACEBOOK_CHANNEL_ID } from "./naming.js";
import {
  getMessengerQuickReplies,
  renderMessengerPresentationPayload,
  renderMessengerReplyPayload,
} from "./presentation.js";
import { getMessengerRuntime } from "./runtime.js";
import { MESSENGER_TEXT_CHUNK_LIMIT } from "./send.js";

const loadMessengerRuntime = createLazyRuntimeModule(() => import("./send.js"));

export const messengerOutboundAdapter: NonNullable<
  ChannelPlugin<ResolvedMessengerAccount>["outbound"]
> = {
  deliveryMode: "direct",
  textChunkLimit: MESSENGER_TEXT_CHUNK_LIMIT,
  presentationCapabilities: {
    supported: true,
    buttons: true,
    selects: true,
    limits: {
      actions: {
        maxActions: 4,
        maxActionsPerRow: 4,
        maxRows: 1,
        maxLabelLength: 20,
        maxValueBytes: 1000,
        supportsStyles: false,
        supportsDisabled: false,
      },
      selects: {
        maxOptions: 4,
        maxLabelLength: 20,
        maxValueBytes: 1000,
      },
      text: {
        maxLength: MESSENGER_TEXT_CHUNK_LIMIT,
        encoding: "characters",
        markdownDialect: "plain",
      },
    },
  },
  renderPresentation: ({ payload, presentation }) =>
    renderMessengerPresentationPayload({ payload, presentation }),
  chunker: (text, limit) => getMessengerRuntime().channel.text.chunkMarkdownText(text, limit),
  sendPayload: async ({ to, payload, accountId, cfg }) => {
    const deliveryPayload = renderMessengerReplyPayload(payload);
    const sendText =
      getMessengerRuntime().channel.facebook?.sendMessengerText ??
      (await loadMessengerRuntime()).sendMessengerText;
    const result = await sendText(to, deliveryPayload.text ?? "", {
      cfg,
      accountId: accountId ?? undefined,
      quickReplies: getMessengerQuickReplies(deliveryPayload),
    });
    return createEmptyChannelResult(FACEBOOK_CHANNEL_ID, {
      messageId: result.messageId,
      receipt: result.receipt,
    });
  },
  ...createAttachedChannelResultAdapter({
    channel: FACEBOOK_CHANNEL_ID,
    sendText: async ({ cfg, to, text, accountId }) => {
      const sendText =
        getMessengerRuntime().channel.facebook?.sendMessengerText ??
        (await loadMessengerRuntime()).sendMessengerText;
      return await sendText(to, text, { cfg, accountId: accountId ?? undefined });
    },
  }),
};

function toMessengerMessageSendResult(
  result: Awaited<ReturnType<NonNullable<typeof messengerOutboundAdapter.sendPayload>>>,
): ChannelMessageSendResult {
  if (!result.receipt) {
    throw new Error("Messenger message adapter send did not return a receipt");
  }
  return {
    messageId: result.messageId || result.receipt.primaryPlatformMessageId,
    receipt: result.receipt,
  };
}

export const messengerMessageAdapter = defineChannelMessageAdapter({
  id: FACEBOOK_CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, accountId }) => {
      const result = await messengerOutboundAdapter.sendPayload!({
        cfg,
        to,
        text,
        accountId,
        payload: { text },
      });
      return toMessengerMessageSendResult(result);
    },
  },
  receive: {
    defaultAckPolicy: "after_agent_dispatch",
    supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
  },
});
