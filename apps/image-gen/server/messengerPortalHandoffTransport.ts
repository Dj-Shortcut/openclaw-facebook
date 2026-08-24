import { sendText, type MessengerSendOutcome } from "./_core/messengerApi";

export async function sendMessengerPortalHandoffText(input: {
  psid: string;
  text: string;
  pageId: string;
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  userKey: string;
  privacyEpoch: number;
  operationId: string;
}): Promise<MessengerSendOutcome> {
  return sendText(input.psid, input.text, {
    pageId: input.pageId,
    workspaceId: input.workspaceId,
    channelConnectionId: input.channelConnectionId,
    bindingEpoch: input.bindingEpoch,
    userKey: input.userKey,
    privacyEpoch: input.privacyEpoch,
    operationId: input.operationId,
  });
}
