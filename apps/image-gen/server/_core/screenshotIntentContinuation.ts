import { t, type Lang } from "./i18n";
import type { HandlerContext } from "./webhookHandlerTypes";

type ScreenshotIntentContinuationInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
};

export async function runScreenshotIntentContinuation(
  ctx: HandlerContext,
  input: ScreenshotIntentContinuationInput,
  sourceImageUrl: string,
  priorPrompt: string
): Promise<void> {
  await ctx.sendLoggedText(
    input.psid,
    t(input.lang, "screenshotIntentContinuation"),
    input.reqId
  );
  await ctx.runImageGeneration(
    input.psid,
    input.userId,
    input.reqId,
    input.lang,
    sourceImageUrl,
    priorPrompt,
    "source_image_edit"
  );
}
