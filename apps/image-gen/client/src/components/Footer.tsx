export default function Footer() {
  return (
    <footer className="border-t border-stone-200 bg-[#f6f2ea] py-3 text-center text-xs text-stone-500">
      <a
        href="/privacy"
        className="transition-colors hover:text-stone-900 hover:underline"
      >
        Privacy Policy
      </a>

      <span className="mx-2" aria-hidden="true">.</span>

      <a
        href="/terms"
        className="transition-colors hover:text-stone-900 hover:underline"
      >
        Terms of Service
      </a>

      <span className="mx-2" aria-hidden="true">.</span>

      <a
        href="/data-deletion"
        className="transition-colors hover:text-stone-900 hover:underline"
      >
        Data Deletion
      </a>
    </footer>
  );
}
