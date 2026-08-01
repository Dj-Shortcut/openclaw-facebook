import {
  PUBLIC_BUSINESS_DETAILS,
  formatPublicBusinessAddress,
} from "@shared/publicBusinessDetails";

const legalLinks = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Voorwaarden" },
  { href: "/data-deletion", label: "Gegevens verwijderen" },
  { href: "/billing-policy", label: "Prijs- en betaalinfo" },
];

export default function Footer() {
  return (
    <footer className="border-t border-stone-200 bg-[#f6f2ea] px-4 py-8 text-sm text-stone-600 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-6 md:grid-cols-[1fr_auto] md:items-end">
        <address className="not-italic leading-6">
          <strong className="text-stone-900">
            {PUBLIC_BUSINESS_DETAILS.brandName} ·{" "}
            {PUBLIC_BUSINESS_DETAILS.legalName}
          </strong>
          <br />
          {formatPublicBusinessAddress()} · KBO{" "}
          {PUBLIC_BUSINESS_DETAILS.enterpriseNumber}
          <br />
          <a
            className="hover:text-stone-900 hover:underline"
            href={`tel:${PUBLIC_BUSINESS_DETAILS.phoneHref}`}
          >
            {PUBLIC_BUSINESS_DETAILS.phoneDisplay}
          </a>{" "}
          ·{" "}
          <a
            className="hover:text-stone-900 hover:underline"
            href={`mailto:${PUBLIC_BUSINESS_DETAILS.email}`}
          >
            {PUBLIC_BUSINESS_DETAILS.email}
          </a>
        </address>

        <nav
          aria-label="Juridische informatie"
          className="flex flex-wrap gap-x-4 gap-y-2"
        >
          {legalLinks.map(link => (
            <a
              className="transition-colors hover:text-stone-900 hover:underline"
              href={link.href}
              key={link.href}
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
