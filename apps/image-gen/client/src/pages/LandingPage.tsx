import { PUBLIC_BUSINESS_DETAILS } from "@shared/publicBusinessDetails";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Combine,
  CreditCard,
  Layers,
  Lock,
  MessageCircle,
  Package,
  Send,
  ShieldCheck,
  Sparkles,
  SunMedium,
  Type,
  Image as ImageIcon,
  Trash2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  landingCopies,
  messengerPremiumCopies,
  type LandingCopy,
} from "./landingCopy";
import { SUPPORTED_LOCALES, type AppLocale } from "./appLocales";

const HeroOrbCanvas = lazy(() => import("@/components/HeroOrbCanvas"));

const exampleIcons = [Layers, Sparkles, Package, Type, SunMedium, Combine];

/** One abstract gradient per example card. These are decorative illustrations
 * on purpose: the landing page never shows a real generated result, so no
 * visitor can mistake the artwork for proof of what the bot produced. */
const exampleTileGradients = [
  "bg-[linear-gradient(140deg,#2541C9,#4F46E5_55%,#8B2FE0)]",
  "bg-[linear-gradient(140deg,#6D28D9,#8B2FE0_55%,#C026D3)]",
  "bg-[linear-gradient(140deg,#0F766E,#2541C9_60%,#4F46E5)]",
  "bg-[linear-gradient(140deg,#8B2FE0,#DB2777_60%,#F97316)]",
  "bg-[linear-gradient(140deg,#B45309,#DB2777_55%,#8B2FE0)]",
  "bg-[linear-gradient(140deg,#4F46E5,#2541C9_55%,#0F766E)]",
];

const trustCardIcons = [Lock, ShieldCheck, CheckCircle2, Trash2];

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2541C9]";

function LanguagePicker({
  copy,
  locale,
  onChange,
}: {
  copy: LandingCopy;
  locale: AppLocale;
  onChange: (locale: AppLocale) => void;
}) {
  return (
    <div
      aria-label={copy.languageLabel}
      className="inline-flex rounded-full border border-[#14203D]/15 bg-white p-1"
      role="group"
    >
      {SUPPORTED_LOCALES.map(option => (
        <button
          aria-pressed={option === locale}
          className={`min-h-9 min-w-9 rounded-full px-3 text-xs font-semibold transition-colors ${focusRing} ${
            option === locale
              ? "bg-[#2541C9] text-white"
              : "text-[#14203D]/70 hover:bg-[#14203D]/5 hover:text-[#14203D]"
          }`}
          key={option}
          type="button"
          onClick={() => onChange(option)}
        >
          {option === "nl-BE" ? "NL" : option === "fr-BE" ? "FR" : "EN"}
        </button>
      ))}
    </div>
  );
}

function MessengerCta({
  label,
  variant = "solid",
  size = "md",
  className = "",
}: {
  label: string;
  variant?: "solid" | "ghost" | "onDark";
  size?: "md" | "lg";
  className?: string;
}) {
  const sizeClasses =
    size === "lg" ? "min-h-14 px-7 text-base" : "min-h-11 px-5 text-sm";
  const variantClasses =
    variant === "solid"
      ? "bg-[linear-gradient(120deg,#2541C9,#8B2FE0)] text-white shadow-[0_14px_30px_-14px_rgba(37,65,201,0.6)] transition hover:brightness-110"
      : variant === "onDark"
        ? "bg-white text-[#2541C9] transition hover:bg-white/90"
        : "border border-[#14203D]/20 text-[#14203D] transition hover:border-[#14203D]/35 hover:bg-[#14203D]/5";
  return (
    <a
      className={`inline-flex max-w-full items-center justify-center gap-2 text-balance rounded-full text-center font-bold ${focusRing} ${sizeClasses} ${variantClasses} ${className}`}
      href={PUBLIC_BUSINESS_DETAILS.messengerUrl}
      rel="noreferrer"
      target="_blank"
    >
      <MessageCircle className="h-4 w-4" aria-hidden="true" />
      {label}
    </a>
  );
}

/** Free-image dots plus a distinct "+8" credit badge — the whole
 * free/paid mechanic in one glance inside the hero chat mockup. The 8 mirrors
 * the premium bundle size in the checkout offer contract. */
function QuotaMeter({ usedToday = 1 }: { usedToday?: number }) {
  return (
    <div className="flex items-center gap-2" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, index) => (
        <span
          key={index}
          className={`h-2.5 w-2.5 rounded-full ${
            index < usedToday ? "bg-[#2541C9]" : "bg-[#14203D]/20"
          }`}
        />
      ))}
      <span className="ml-1 flex h-5 items-center rounded-full bg-gradient-to-r from-blue-100 to-violet-100 px-2 text-[10px] font-bold uppercase tracking-wide text-[#5B21B6]">
        +8
      </span>
    </div>
  );
}

/** The hero conversation plays itself like a live Messenger thread.
 *
 * The finished exchange is the resting state, so the first paint, a shared
 * link preview, and any visitor who asked for reduced motion all show the
 * whole conversation. Playback only ever replays what is already there. */
type ConversationBeat = 0 | 1 | 2 | 3;
const CONVERSATION_SETTLED: ConversationBeat = 3;

function useConversationPlayback(): {
  beat: ConversationBeat;
  typing: boolean;
} {
  const [beat, setBeat] = useState<ConversationBeat>(CONVERSATION_SETTLED);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timers: number[] = [];
    const stop = () => {
      timers.forEach(timer => window.clearTimeout(timer));
      timers = [];
    };
    const at = (ms: number, run: () => void) => {
      timers.push(window.setTimeout(run, ms));
    };
    const play = () => {
      setBeat(0);
      setTyping(false);
      at(700, () => setBeat(1));
      at(1500, () => setTyping(true));
      at(2700, () => {
        setTyping(false);
        setBeat(2);
      });
      at(3600, () => setTyping(true));
      at(5200, () => {
        setTyping(false);
        setBeat(3);
      });
      at(13000, play);
    };
    const apply = () => {
      stop();
      if (motion.matches) {
        // Settle immediately: a visitor who asks for stillness mid-cycle should
        // be left with the whole conversation, not a half-played one.
        setBeat(CONVERSATION_SETTLED);
        setTyping(false);
        return;
      }
      // Hold the settled conversation first; the replay is the second thing seen.
      at(1200, play);
    };

    apply();
    motion.addEventListener("change", apply);
    return () => {
      motion.removeEventListener("change", apply);
      stop();
    };
  }, []);

  return { beat, typing };
}

function conversationBeatClass(beat: ConversationBeat, at: number): string {
  return beat >= at
    ? "translate-y-0 opacity-100"
    : "pointer-events-none translate-y-2 opacity-0";
}

/** Reports whether a section is on screen, so the pinned mobile call to action
 * can step aside once the closing one is visible. Without an observer the bar
 * simply stays put, which is the safe direction. */
function useSectionInView(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(entries =>
      setInView(entries.some(entry => entry.isIntersecting))
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return inView;
}

/** Subtle cursor-following spotlight over the hero mockup card — a plain
 * CSS/pointer-events micro-interaction layered on top of the WebGL orb. It is
 * skipped entirely when the visitor asked for reduced motion. */
function PointerGlow() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const onMove = (event: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      el.style.setProperty("--gx", `${x}%`);
      el.style.setProperty("--gy", `${y}%`);
      el.style.opacity = "1";
    };
    const onLeave = () => {
      el.style.opacity = "0";
    };
    parent.addEventListener("pointermove", onMove);
    parent.addEventListener("pointerleave", onLeave);
    return () => {
      parent.removeEventListener("pointermove", onMove);
      parent.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity duration-300"
      ref={ref}
      style={{
        background:
          "radial-gradient(280px circle at var(--gx, 50%) var(--gy, 50%), rgba(255,255,255,0.55), transparent 70%)",
      }}
    />
  );
}

function SectionEyebrow({ children }: { children: string }) {
  return (
    <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#2541C9]">
      {children}
    </p>
  );
}

export default function LandingPage() {
  const [locale, setLocale] = useState<AppLocale>("nl-BE");
  // This page describes the Messenger purchase path, not its live availability.
  // The user-bound checkout owns the actual offer and Test/live mode display.
  // The fixed mobile call to action sits above the shared footer, so the page
  // itself has to reserve that strip. A body class keeps the reservation in
  // sync with this page only; other routes have no fixed bar.
  useEffect(() => {
    document.body.classList.add("has-mobile-cta");
    return () => document.body.classList.remove("has-mobile-cta");
  }, []);

  const copy = landingCopies[locale];
  const premiumGuidance = messengerPremiumCopies[locale];
  const { beat, typing } = useConversationPlayback();
  const heroCtaRef = useRef<HTMLDivElement>(null);
  const heroCtaInView = useSectionInView(heroCtaRef);
  const closingRef = useRef<HTMLDivElement>(null);
  const closingInView = useSectionInView(closingRef);
  // The pinned bar is a safety net for the scroll, not a third button on the
  // first screen: it waits until the hero call to action is gone and steps
  // aside again at the closing one.
  const pinnedCtaHidden = heroCtaInView || closingInView;
  const microLine = premiumGuidance.microLine;
  const premiumNote = premiumGuidance.note;
  const trustCards = copy.trustCards.map((card, index) => {
    if (index === 0) return { ...card, body: premiumGuidance.mollieCardBody };
    if (index === 2) return { ...card, body: premiumGuidance.creditsCardBody };
    return card;
  });
  const questions = copy.questions.map((question, index) =>
    index === 2 ? { ...question, answer: premiumGuidance.faqAnswer } : question
  );

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: questions.map(item => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };

  return (
    <main className="min-h-full overflow-x-clip bg-[#f6f2ea] text-[#14203D]">
      <a
        className={`sr-only z-50 rounded-md bg-white px-4 py-2 font-semibold text-[#14203D] focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:shadow-lg ${focusRing}`}
        href="#main-content"
      >
        Skip to content
      </a>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(faqSchema).replace(/</g, "\\u003c"),
        }}
      />

      <header className="sticky top-0 z-40 border-b border-[#14203D]/10 bg-[#f6f2ea]/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
          <a
            className={`flex items-center gap-3 rounded-xl ${focusRing}`}
            href="/"
            aria-label="Leaderbot home"
          >
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[linear-gradient(135deg,#2541C9,#8B2FE0)] font-black text-white">
              L
            </span>
            <span>
              <strong className="block text-base">Leaderbot</strong>
              <span className="block text-xs text-[#14203D]/70">
                leaderbot.live
              </span>
            </span>
          </a>
          <nav
            className="hidden items-center gap-6 text-sm text-[#14203D]/75 lg:flex"
            aria-label="Primary"
          >
            <a
              className={`rounded px-1 py-1 hover:text-[#14203D] ${focusRing}`}
              href="#how-it-works"
            >
              {copy.nav.howItWorks}
            </a>
            <a
              className={`rounded px-1 py-1 hover:text-[#14203D] ${focusRing}`}
              href="#examples"
            >
              {copy.nav.examples}
            </a>
            <a
              className={`rounded px-1 py-1 hover:text-[#14203D] ${focusRing}`}
              href="#pricing"
            >
              {copy.nav.pricing}
            </a>
            <a
              className={`rounded px-1 py-1 hover:text-[#14203D] ${focusRing}`}
              href="#faq"
            >
              {copy.nav.faq}
            </a>
          </nav>
          <div className="flex items-center gap-2 sm:gap-4">
            <LanguagePicker copy={copy} locale={locale} onChange={setLocale} />
            <span className="hidden sm:inline-flex">
              <MessengerCta label={copy.headerCta} variant="solid" />
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div
          className="grid gap-12 py-14 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.85fr)] lg:items-center lg:py-24"
          id="main-content"
        >
          <div className="min-w-0">
            <p className="inline-flex items-center gap-2 rounded-full border border-[#2541C9]/20 bg-white/70 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-[#2541C9]">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {copy.eyebrow}
            </p>
            <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-[#14203D] sm:text-5xl lg:text-6xl">
              {copy.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-[#14203D]/75">
              {copy.subtitle}
            </p>
            <div
              className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap"
              ref={heroCtaRef}
            >
              <MessengerCta
                label={copy.heroPrimaryCta}
                variant="solid"
                size="lg"
              />
              <a
                className={`inline-flex min-h-14 max-w-full items-center justify-center gap-2 rounded-full border border-[#14203D]/20 px-7 text-center text-base font-bold text-[#14203D] transition hover:border-[#14203D]/35 hover:bg-[#14203D]/5 ${focusRing}`}
                href="#examples"
              >
                {copy.heroSecondaryCta}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
            <p className="mt-5 flex max-w-2xl items-start gap-2 text-sm leading-6 text-[#14203D]/75">
              <ShieldCheck
                className="mt-0.5 h-4 w-4 shrink-0 text-[#2541C9]"
                aria-hidden="true"
              />
              {microLine}
            </p>
          </div>

          <div className="relative mx-auto w-full min-w-0 max-w-xl">
            <div
              className="absolute -inset-4 rounded-full bg-gradient-to-br from-blue-200/50 via-violet-200/40 to-transparent blur-3xl sm:-inset-10"
              aria-hidden="true"
            />
            <div
              className="absolute -inset-4 opacity-90 [mask-image:radial-gradient(closest-side,black,transparent)] sm:-inset-10"
              aria-hidden="true"
            >
              <Suspense fallback={null}>
                <HeroOrbCanvas />
              </Suspense>
            </div>
            <figure className="relative m-0">
              <div className="relative overflow-hidden rounded-[2rem] border border-[#14203D]/10 bg-white p-3 shadow-[0_30px_70px_-35px_rgba(20,32,61,0.35)]">
                <PointerGlow />
                <div className="rounded-[1.45rem] bg-[#f7f8fb] p-5 sm:p-6">
                  <div className="flex items-center justify-between gap-3 border-b border-[#14203D]/10 pb-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-full bg-[linear-gradient(135deg,#2541C9,#8B2FE0)] text-white">
                        <MessageCircle className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <div>
                        <div className="font-semibold text-[#14203D]">
                          Leaderbot
                        </div>
                        <div className="text-xs text-emerald-800">
                          Messenger
                        </div>
                      </div>
                    </div>
                    <span className="hidden shrink-0 rounded-full bg-[#14203D]/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#14203D]/70 min-[380px]:inline-block">
                      {copy.chat.label}
                    </span>
                  </div>
                  <div className="mt-5 grid gap-4">
                    <div
                      className={`ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-[#2541C9] px-4 py-3 text-sm leading-6 text-white transition duration-300 ease-out ${conversationBeatClass(beat, 1)}`}
                    >
                      {copy.chat.prompt}
                    </div>
                    <div
                      className={`relative max-w-[88%] rounded-2xl rounded-bl-md bg-white px-4 py-3 text-sm leading-6 text-[#14203D]/85 shadow-sm ring-1 ring-[#14203D]/10 transition duration-300 ease-out ${
                        typing || beat >= 2
                          ? "translate-y-0 opacity-100"
                          : "pointer-events-none translate-y-2 opacity-0"
                      }`}
                    >
                      <span
                        className={
                          typing && beat < 2 ? "opacity-0" : "opacity-100"
                        }
                      >
                        {copy.chat.reply}
                      </span>
                      {typing && beat < 2 ? (
                        <span
                          aria-hidden="true"
                          className="absolute inset-0 flex items-center gap-1.5 px-4"
                        >
                          {[0, 1, 2].map(dot => (
                            <span
                              key={dot}
                              className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#14203D]/45"
                              style={{ animationDelay: `${dot * 160}ms` }}
                            />
                          ))}
                        </span>
                      ) : null}
                    </div>
                    <div
                      className={`overflow-hidden rounded-2xl border border-[#14203D]/10 bg-white p-4 shadow-sm transition duration-300 ease-out ${conversationBeatClass(beat, 3)}`}
                    >
                      <div className="flex min-h-32 items-end justify-between rounded-xl bg-[radial-gradient(circle_at_25%_20%,rgba(255,255,255,0.35),transparent_45%),linear-gradient(135deg,#2541C9,#6D28D9_60%,#8B2FE0)] p-4 text-white">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-white/85">
                            {copy.chat.resultTag}
                          </div>
                          <div className="mt-1 text-xl font-semibold">
                            {copy.chat.resultCaption}
                          </div>
                        </div>
                        <Sparkles
                          className="h-7 w-7 text-white"
                          aria-hidden="true"
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-xs text-[#14203D]/75">
                          <Check
                            className="h-4 w-4 text-[#2541C9]"
                            aria-hidden="true"
                          />
                          {copy.chat.quotaCaption}
                        </span>
                        <QuotaMeter usedToday={1} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <figcaption className="mt-3 text-center text-xs leading-5 text-[#14203D]/70">
                {copy.chat.disclaimer}
              </figcaption>
            </figure>
          </div>
        </div>
      </div>

      <section
        aria-labelledby="how-it-works-title"
        className="bg-white px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
        id="how-it-works"
      >
        <div className="mx-auto max-w-7xl">
          <SectionEyebrow>{copy.howEyebrow}</SectionEyebrow>
          <h2
            className="mt-4 max-w-3xl text-3xl font-semibold tracking-[-0.025em] text-[#14203D] sm:text-5xl"
            id="how-it-works-title"
          >
            {copy.howTitle}
          </h2>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-[#14203D]/75">
            {copy.howBody}
          </p>
          <ol className="mt-12 grid list-none gap-5 p-0 lg:grid-cols-3">
            {copy.steps.map((step, index) => {
              const Icon = [MessageCircle, Send, ImageIcon][index] ?? Send;
              return (
                <li
                  className="relative overflow-hidden rounded-3xl border border-[#14203D]/10 bg-[#f6f2ea] p-7 shadow-sm transition hover:shadow-md motion-safe:hover:-translate-y-1"
                  key={step.title}
                >
                  <div className="flex items-center gap-3">
                    <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#2541C9]/10 text-[#2541C9]">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span
                      aria-hidden="true"
                      className="text-4xl font-black tracking-[-0.06em] text-[#14203D]/15"
                    >
                      0{index + 1}
                    </span>
                  </div>
                  <h3 className="mt-6 text-xl font-semibold text-[#14203D]">
                    {step.title}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-[#14203D]/75">
                    {step.body}
                  </p>
                </li>
              );
            })}
          </ol>
          <div className="mt-8">
            <MessengerCta label={copy.stepsCta} variant="solid" />
          </div>
        </div>
      </section>

      <section
        aria-labelledby="examples-title"
        className="px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
        id="examples"
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
            <div>
              <SectionEyebrow>{copy.examplesEyebrow}</SectionEyebrow>
              <h2
                className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-[#14203D] sm:text-5xl"
                id="examples-title"
              >
                {copy.examplesTitle}
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#14203D]/75">
              {copy.examplesBody}
            </p>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {copy.examples.map((example, index) => {
              const Icon = exampleIcons[index] ?? Sparkles;
              const gradient =
                exampleTileGradients[index] ?? exampleTileGradients[0];
              return (
                <article
                  className="flex flex-col overflow-hidden rounded-3xl border border-[#14203D]/10 bg-white shadow-sm transition hover:shadow-md motion-safe:hover:-translate-y-1"
                  key={example.title}
                >
                  <div
                    aria-hidden="true"
                    className={`relative flex h-32 items-end justify-between p-5 ${gradient}`}
                  >
                    <span className="absolute inset-0 bg-[radial-gradient(circle_at_20%_15%,rgba(255,255,255,0.45),transparent_55%)]" />
                    <span className="relative text-[11px] font-semibold uppercase tracking-[0.16em] text-white/90">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <Icon className="relative h-8 w-8 text-white" />
                  </div>
                  <div className="flex grow flex-col p-6">
                    <h3 className="text-base font-semibold text-[#14203D]">
                      {example.title}
                    </h3>
                    <p className="mt-3 rounded-2xl rounded-bl-md bg-[#f1ede3] px-4 py-3 text-sm leading-6 text-[#14203D]/85">
                      &ldquo;{example.instruction}&rdquo;
                    </p>
                    <p className="mt-3 text-sm leading-6 text-[#14203D]/75">
                      {example.outcome}
                    </p>
                  </div>
                </article>
              );
            })}

            <article className="flex flex-col justify-between gap-6 rounded-3xl border border-dashed border-[#2541C9]/35 bg-[#2541C9]/5 p-7">
              <div>
                <h3 className="text-base font-semibold text-[#14203D]">
                  {copy.examplesCta.title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-[#14203D]/75">
                  {copy.examplesCta.body}
                </p>
              </div>
              <MessengerCta
                label={copy.examplesCta.cta}
                variant="solid"
                className="self-start"
              />
            </article>
          </div>
          <p className="mt-6 text-sm leading-6 text-[#14203D]/70">
            {copy.examplesDisclaimer}
          </p>
        </div>
      </section>

      <section
        aria-labelledby="pricing-title"
        className="bg-[#f1ece1] px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
        id="pricing"
      >
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <SectionEyebrow>{copy.pricingEyebrow}</SectionEyebrow>
            <h2
              className="mx-auto mt-4 max-w-3xl text-3xl font-semibold tracking-[-0.025em] text-[#14203D] sm:text-5xl"
              id="pricing-title"
            >
              {copy.pricingTitle}
            </h2>
            <p className="mx-auto mt-5 max-w-3xl text-lg leading-8 text-[#14203D]/75">
              {copy.pricingBody}
            </p>
          </div>
          <div className="mt-12 grid gap-5 lg:grid-cols-2">
            <article className="rounded-3xl border border-[#14203D]/10 bg-white p-7 shadow-sm sm:p-9">
              <h3 className="text-xl font-semibold text-[#14203D]">
                {copy.free.name}
              </h3>
              <div className="mt-6 flex items-end gap-3">
                <span className="text-5xl font-semibold tracking-[-0.04em] text-[#14203D]">
                  {copy.free.price}
                </span>
                <span className="pb-1 text-sm text-[#14203D]/70">
                  {copy.free.suffix}
                </span>
              </div>
              <ul className="mt-6 grid gap-3 text-sm text-[#14203D]/85">
                {copy.free.features.map(feature => (
                  <li className="flex items-start gap-3" key={feature}>
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#2541C9]"
                      aria-hidden="true"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                <MessengerCta label={copy.free.cta} variant="ghost" />
              </div>
            </article>

            <article className="relative overflow-hidden rounded-3xl border border-[#14203D]/10 bg-[#14203D] p-7 text-white shadow-xl sm:p-9">
              <div
                className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-to-br from-violet-500/40 to-blue-400/30 blur-3xl"
                aria-hidden="true"
              />
              <span className="relative inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">
                <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
                {premiumGuidance.badge}
              </span>
              <h3 className="relative mt-5 text-xl font-semibold">
                {copy.credits.name}
              </h3>
              <div className="relative mt-6 flex items-end gap-3">
                <span className="text-5xl font-semibold tracking-[-0.04em]">
                  {copy.credits.price}
                </span>
                <span className="pb-1 text-sm text-white/75">
                  {copy.credits.suffix}
                </span>
              </div>
              <ul className="relative mt-6 grid gap-3 text-sm text-white/90">
                {copy.credits.features.map(feature => (
                  <li className="flex items-start gap-3" key={feature}>
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#C4B5FD]"
                      aria-hidden="true"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
              <p className="relative mt-8 flex items-start gap-2 text-sm leading-6 text-white/80">
                <MessageCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-white/60"
                  aria-hidden="true"
                />
                {premiumNote}
              </p>
            </article>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="trust-title"
        className="bg-white px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
      >
        <div className="mx-auto max-w-7xl">
          <div className="max-w-2xl">
            <SectionEyebrow>{copy.trustEyebrow}</SectionEyebrow>
            <h2
              className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-[#14203D] sm:text-5xl"
              id="trust-title"
            >
              {copy.trustTitle}
            </h2>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2">
            {trustCards.map((card, index) => {
              const Icon = trustCardIcons[index] ?? ShieldCheck;
              return (
                <article
                  className="rounded-3xl border border-[#14203D]/10 bg-[#f6f2ea] p-7 shadow-sm"
                  key={card.title}
                >
                  <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#2541C9]/10 text-[#2541C9]">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold text-[#14203D]">
                    {card.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#14203D]/75">
                    {card.body}
                  </p>
                  {card.links ? (
                    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
                      {card.links.map(link => (
                        <a
                          className={`inline-flex items-center gap-1.5 rounded px-1 py-1 text-sm font-semibold text-[#2541C9] hover:underline ${focusRing}`}
                          href={link.href}
                          key={link.href}
                        >
                          {link.label}
                          <ArrowRight
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                        </a>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section
        aria-labelledby="faq-title"
        className="bg-[#f1ece1] px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
        id="faq"
      >
        <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.72fr_1.28fr]">
          <div>
            <SectionEyebrow>{copy.faqEyebrow}</SectionEyebrow>
            <h2
              className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-[#14203D] sm:text-5xl"
              id="faq-title"
            >
              {copy.faqTitle}
            </h2>
          </div>
          <div className="divide-y divide-[#14203D]/10 border-y border-[#14203D]/10">
            {questions.map(item => (
              <details className="group py-2" key={item.question}>
                <summary
                  className={`flex min-h-14 cursor-pointer list-none items-center justify-between gap-5 rounded-lg px-2 font-semibold text-[#14203D] [&::-webkit-details-marker]:hidden ${focusRing}`}
                >
                  {item.question}
                  <span
                    className="text-2xl font-light text-[#2541C9] transition group-open:rotate-45"
                    aria-hidden="true"
                  >
                    +
                  </span>
                </summary>
                <p className="max-w-2xl px-2 pb-4 pt-1 text-sm leading-6 text-[#14203D]/75">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section
        aria-labelledby="closing-title"
        className="px-4 py-20 sm:px-6 lg:px-8 lg:py-24"
      >
        <div className="mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-[#14203D] px-7 py-12 text-white sm:px-12 sm:py-16">
          <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
            <div>
              <h2
                className="text-3xl font-semibold tracking-[-0.025em] sm:text-4xl"
                id="closing-title"
              >
                {copy.closing.title}
              </h2>
              <p className="mt-4 max-w-xl text-lg leading-8 text-white/80">
                {copy.closing.body}
              </p>
            </div>
            <div className="lg:justify-self-end" ref={closingRef}>
              <MessengerCta
                label={copy.closing.cta}
                variant="onDark"
                size="lg"
              />
            </div>
          </div>
        </div>
      </section>

      <div
        // `inert` takes the faded bar out of the tab order and the
        // accessibility tree together, so nobody can focus an invisible link.
        inert={pinnedCtaHidden}
        className={`fixed inset-x-0 bottom-0 z-40 border-t border-[#14203D]/10 bg-[#f6f2ea]/95 px-4 pt-3 backdrop-blur transition-opacity duration-200 sm:hidden ${
          pinnedCtaHidden ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        <MessengerCta
          className="w-full"
          label={copy.heroPrimaryCta}
          size="md"
          variant="solid"
        />
      </div>
    </main>
  );
}
