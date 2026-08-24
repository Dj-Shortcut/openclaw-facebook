import type { Lang } from "./i18n";
import type { NormalizedInboundMessage } from "./normalizedInboundMessage";
import type { CostLedgerTenantScope } from "./costLedger";
import type { WhatsAppEndpoint } from "./conversationEndpoint";

export type NormalizedWhatsAppEvent = NormalizedInboundMessage & {
  channel: "whatsapp";
  endpoint: WhatsAppEndpoint;
};

export type WhatsAppHandlerContext = {
  reqId: string;
  lang: Lang;
  costLedgerScope: CostLedgerTenantScope;
};
