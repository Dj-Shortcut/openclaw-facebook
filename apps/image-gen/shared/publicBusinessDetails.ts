export const PUBLIC_BUSINESS_DETAILS = Object.freeze({
  brandName: "Leaderbot",
  legalName: "Andy Arijs",
  enterpriseNumber: "1040.495.145",
  vatNumber: "BE 1040.495.145",
  streetAddress: "Savooistraat 50",
  postalCode: "9400",
  locality: "Ninove",
  country: "België",
  phoneDisplay: "+32 469 79 26 56",
  phoneHref: "+32469792656",
  email: "privacy@leaderbot.live",
  // TODO(andy): replace with the real Page username before merging, e.g.
  // "https://m.me/yourpageusername". This placeholder is intentionally
  // obvious so a wrong link doesn't silently ship.
  messengerUrl: "https://m.me/REPLACE_WITH_LEADERBOT_PAGE_USERNAME",
});

export function formatPublicBusinessAddress(): string {
  return `${PUBLIC_BUSINESS_DETAILS.streetAddress}, ${PUBLIC_BUSINESS_DETAILS.postalCode} ${PUBLIC_BUSINESS_DETAILS.locality}, ${PUBLIC_BUSINESS_DETAILS.country}`;
}
