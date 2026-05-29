import type { Lang } from "./i18n";
import type { NormalizedInboundMessage } from "./normalizedInboundMessage";

export type NormalizedWhatsAppEvent = NormalizedInboundMessage & {
  channel: "whatsapp";
};

export type WhatsAppHandlerContext = {
  reqId: string;
  lang: Lang;
};
