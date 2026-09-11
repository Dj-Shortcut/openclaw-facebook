/**
 * Locales the public page offers. These used to live in `portalLocales.ts`
 * alongside the customer portal copy; the portal is retired, but the public
 * landing page still ships in all three languages, so the constants live here
 * on their own.
 */
export const SUPPORTED_LOCALES = ["nl-BE", "fr-BE", "en"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "nl-BE";
export const FALLBACK_LOCALE: AppLocale = "en";
