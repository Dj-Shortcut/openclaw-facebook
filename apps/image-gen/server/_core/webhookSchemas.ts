import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const messengerAttachmentSchema = z
  .object({
    type: nonEmptyString.optional(),
    payload: z
      .object({
        url: z.string().url().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const messengerMessageSchema = z
  .object({
    mid: nonEmptyString.optional(),
    is_echo: z.boolean().optional(),
    text: z.string().optional(),
    quick_reply: z
      .object({
        payload: nonEmptyString.optional(),
      })
      .passthrough()
      .optional(),
    attachments: z.array(messengerAttachmentSchema).optional(),
  })
  .passthrough();

const messengerEventSchema = z
  .object({
    sender: z
      .object({
        id: nonEmptyString,
        locale: z.string().optional(),
      })
      .passthrough(),
    recipient: z
      .object({
        id: nonEmptyString,
      })
      .passthrough(),
    message: messengerMessageSchema.optional(),
    postback: z
      .object({
        title: z.string().optional(),
        payload: z.string().optional(),
        referral: z
          .object({
            ref: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    referral: z
      .object({
        ref: z.string().optional(),
      })
      .passthrough()
      .optional(),
    timestamp: z.number().int().nonnegative().optional(),
    delivery: z.unknown().optional(),
    read: z.unknown().optional(),
  })
  .passthrough()
  .refine(
    event =>
      Boolean(
        event.message ||
        event.postback ||
        event.referral ||
        event.delivery ||
        event.read
      ),
    {
      message: "messaging event must include at least one Messenger event type",
    }
  );

const webhookEntrySchema = z
  .object({
    id: nonEmptyString.optional(),
    time: z.number().int().nonnegative().optional(),
    messaging: z.array(messengerEventSchema).default([]),
  })
  .passthrough();

export const facebookWebhookPayloadSchema = z
  .object({
    object: z.literal("page"),
    entry: z.array(webhookEntrySchema).min(1),
  })
  .passthrough();

export type FacebookWebhookPayload = z.infer<
  typeof facebookWebhookPayloadSchema
>;
