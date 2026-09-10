import { PUBLIC_BUSINESS_DETAILS } from "./publicBusinessDetails";

export type PublicLegalLink = Readonly<{
  href: string;
  label: string;
  external?: boolean;
}>;

/**
 * The one public navigation set. The site footer and the server-rendered legal
 * pages both read it so a visitor sees the same links and labels wherever the
 * page happens to be rendered.
 */
export const PUBLIC_LEGAL_LINKS: readonly PublicLegalLink[] = Object.freeze([
  Object.freeze({ href: "/privacy", label: "Privacybeleid" }),
  Object.freeze({ href: "/terms", label: "Algemene voorwaarden" }),
  Object.freeze({ href: "/billing-policy", label: "Terugbetalingsbeleid" }),
  Object.freeze({ href: "/data-deletion", label: "Gegevens verwijderen" }),
  Object.freeze({
    href: `mailto:${PUBLIC_BUSINESS_DETAILS.email}`,
    label: "Contact",
  }),
  Object.freeze({
    href: PUBLIC_BUSINESS_DETAILS.messengerUrl,
    label: "Facebook Messenger",
    external: true,
  }),
]);
