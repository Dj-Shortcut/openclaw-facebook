import type { ReactNode } from "react";

/**
 * Pictograms for the landing page examples and the mocked chat result.
 *
 * These replace the abstract gradient tiles that used to stand in for a
 * picture. The landing page never shows a real generated result, and a flat
 * line drawing cannot be mistaken for one: each pictogram diagrams the edit an
 * instruction performs instead of imitating its output.
 *
 * Every pictogram shares one grammar so the six read as a set: the framed
 * subject on the left is what you send, the symbol on the right is what
 * Leaderbot does with it. Shapes stay large and few on purpose — at the size
 * these render, fine detail turns into noise. Colours stay on the site palette
 * (ink `#14203D`, Messenger blue `#2541C9`, violet `#8B2FE0`) so the section
 * keeps its identity without the saturated tiles.
 */
const INK = "#14203D";
const ACCENT = "#2541C9";
const HIGHLIGHT = "#8B2FE0";

export type PictogramProps = { className?: string };

function PictogramSvg({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      role="presentation"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2.2}
      viewBox="0 0 96 64"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

/** The photo or message you send: everything else is drawn inside it. */
function Frame() {
  return (
    <rect
      height="38"
      rx="7"
      stroke={INK}
      strokeOpacity="0.55"
      width="52"
      x="4"
      y="13"
    />
  );
}

/**
 * What Leaderbot does with it, always in the same place beside the frame.
 *
 * `data-picto` names the one motion this symbol makes when a pointer is over
 * its card. The rules live in `index.css`; nothing moves at rest.
 */
type PictogramMotion = "shift" | "lift" | "pop" | "spin" | "twinkle";

function Action({
  children,
  motion,
}: {
  children: ReactNode;
  motion: PictogramMotion;
}) {
  return (
    <g data-picto={motion} stroke={HIGHLIGHT}>
      {children}
    </g>
  );
}

/** A four-point star. Filled rather than stroked: at this size an outlined
 * star collapses into a plus sign. */
function Sparkle({
  cx,
  cy,
  fill,
  r,
}: {
  cx: number;
  cy: number;
  fill: string;
  r: number;
}) {
  const waist = r * 0.18;
  return (
    <path
      d={`M0 ${-r}Q${waist} ${-waist} ${r} 0Q${waist} ${waist} 0 ${r}Q${-waist} ${waist} ${-r} 0Q${-waist} ${-waist} 0 ${-r}Z`}
      fill={fill}
      stroke="none"
      transform={`translate(${cx} ${cy})`}
    />
  );
}

function Person() {
  return (
    <>
      <circle cx="20" cy="27" r="5.5" stroke={INK} />
      <path d="M10 45c0-5.5 4.5-10 10-10s10 4.5 10 10" stroke={INK} />
    </>
  );
}

/** Replace the background: the person stays, the setting behind them swaps. */
export function BackgroundPictogram({ className }: PictogramProps) {
  return (
    <PictogramSvg className={className}>
      <Frame />
      <rect height="14" rx="2" stroke={ACCENT} width="15" x="36" y="23" />
      <path d="M43.5 23v14M36 30h15" stroke={ACCENT} />
      <Person />
      <Action motion="shift">
        <path d="M68 27h16M79 22l5 5-5 5" />
        <path d="M90 37H74M79 32l-5 5 5 5" />
      </Action>
    </PictogramSvg>
  );
}

/** Freshen up a photo: the same shot, polished on one side of the split. */
export function PolishPictogram({ className }: PictogramProps) {
  return (
    <PictogramSvg className={className}>
      <Frame />
      <path
        d="M33 51 46 13"
        stroke={INK}
        strokeDasharray="4 5"
        strokeOpacity="0.4"
      />
      <Person />
      <Sparkle cx={50} cy={24} fill={ACCENT} r={5} />
      <Sparkle cx={43} cy={42} fill={ACCENT} r={3.4} />
      <Action motion="twinkle">
        <path d="M69 43l13-13" />
        <Sparkle cx={85} cy={25} fill={HIGHLIGHT} r={7} />
        <Sparkle cx={73} cy={23} fill={HIGHLIGHT} r={3.4} />
      </Action>
    </PictogramSvg>
  );
}

/** Prepare a product photo: the item on a clean, even surface. */
export function ProductPictogram({ className }: PictogramProps) {
  return (
    <PictogramSvg className={className}>
      <Frame />
      <path d="M9 43h42" stroke={ACCENT} />
      <path d="M25 41.5h12" stroke={INK} strokeOpacity="0.3" />
      <rect height="15" rx="2" stroke={INK} width="20" x="21" y="24" />
      <path d="M21 30h20M31 24v6" stroke={INK} strokeOpacity="0.6" />
      <Action motion="lift">
        <path d="M70 28h18v13a3 3 0 01-3 3H73a3 3 0 01-3-3z" />
        <path d="M75 28v-3a4 4 0 018 0v3" />
      </Action>
    </PictogramSvg>
  );
}

/** A brand-new image from text: written lines, no photo attached. */
export function TextToImagePictogram({ className }: PictogramProps) {
  return (
    <PictogramSvg className={className}>
      <Frame />
      <path d="M11 24h32" stroke={INK} strokeOpacity="0.7" />
      <path d="M11 32h26" stroke={INK} strokeOpacity="0.7" />
      <path d="M11 40h18" stroke={INK} strokeOpacity="0.7" />
      <path d="M34 35v10" stroke={ACCENT} />
      <Action motion="pop">
        <rect height="19" rx="3" width="22" x="68" y="22" />
        <circle cx="74.5" cy="28.5" r="1.8" />
        <path d="M68.5 40l6.5-7 5 5 3.5-3.5 6.5 6.5" />
      </Action>
    </PictogramSvg>
  );
}

/** Adjust light and colour: the same scene, warmer and brighter. */
export function LightPictogram({ className }: PictogramProps) {
  return (
    <PictogramSvg className={className}>
      <Frame />
      <circle cx="16" cy="24" r="4" stroke={ACCENT} />
      <path d="M16 16v2.5M16 29.5V32M8 24h2.5M21.5 24H24" stroke={ACCENT} />
      <path d="M8 45l12-13 7 8 6-6 12 11" stroke={INK} />
      <Action motion="spin">
        <circle cx="79" cy="32" r="6" />
        <path d="M79 21v3M79 40v3M68 32h3M87 32h3" />
        <path d="M71.8 24.8l2.1 2.1M84.1 37.1l2.1 2.1M86.2 24.8l-2.1 2.1M73.9 37.1l-2.1 2.1" />
      </Action>
    </PictogramSvg>
  );
}

/** Merge photos: several pictures in, one picture out. */
export function MergePictogram({ className }: PictogramProps) {
  return (
    <PictogramSvg className={className}>
      <Frame />
      <rect
        height="19"
        rx="3"
        stroke={INK}
        strokeOpacity="0.6"
        width="24"
        x="8"
        y="18"
      />
      <rect height="18" rx="3" stroke={ACCENT} width="26" x="24" y="28" />
      <Action motion="shift">
        <path d="M68 24h4l7 8M68 40h4l7-8" />
        <path d="M79 32h9M84 28l4 4-4 4" />
      </Action>
    </PictogramSvg>
  );
}

/**
 * One pictogram per landing example, in the order the copy lists them. The
 * landing page falls back to the first entry, so an added example still gets a
 * drawing rather than an empty tile.
 */
export const examplePictograms = [
  BackgroundPictogram,
  PolishPictogram,
  ProductPictogram,
  TextToImagePictogram,
  LightPictogram,
  MergePictogram,
] as const;

/**
 * The mocked chat answers a background-replacement prompt in every locale, so
 * the reply tile carries that same pictogram instead of a picture-like tile.
 */
export const ChatResultPictogram = BackgroundPictogram;
