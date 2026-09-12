import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatResultPictogram, examplePictograms } from "./ExamplePictograms";
import { landingCopies } from "@/pages/landingCopy";
import { SUPPORTED_LOCALES } from "@/pages/appLocales";

/**
 * The landing page draws pictograms where it used to show picture-like tiles.
 * These tests render the real components and check the two properties that
 * make that substitution safe: one drawing per example in every locale, and a
 * palette that stays on the site's colours instead of drifting into artwork of
 * its own.
 */
const PALETTE = new Set(["#14203D", "#2541C9", "#8B2FE0"]);

function markupFor(Pictogram: (typeof examplePictograms)[number]): string {
  return renderToStaticMarkup(createElement(Pictogram, {}));
}

describe("example pictograms", () => {
  it("covers every example in every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(landingCopies[locale].examples).toHaveLength(
        examplePictograms.length
      );
    }
  });

  it("renders decorative inline SVG the copy can speak for", () => {
    for (const Pictogram of [...examplePictograms, ChatResultPictogram]) {
      const markup = markupFor(Pictogram);
      expect(markup).toContain("<svg");
      expect(markup).toContain('viewBox="0 0 96 64"');
      expect(markup).toContain('aria-hidden="true"');
      // A pictogram is a symbol, not a picture: nothing here may load or embed
      // an image the visitor could read as a generated result.
      expect(markup).not.toMatch(/<image|url\(|data:/);
    }
  });

  it("stays on the landing page palette", () => {
    for (const Pictogram of [...examplePictograms, ChatResultPictogram]) {
      const colours = markupFor(Pictogram).match(/#[0-9A-Fa-f]{3,8}/g) ?? [];
      expect(colours).not.toHaveLength(0);
      for (const colour of colours) {
        expect(PALETTE).toContain(colour);
      }
    }
  });

  it("draws a distinct pictogram per example", () => {
    const drawings = examplePictograms.map(markupFor);
    expect(new Set(drawings).size).toBe(drawings.length);
  });
});

/**
 * The motion on these drawings has to stay free. These pin the two properties
 * that keep it that way: only compositor-friendly properties are animated, and
 * nothing runs unless a pointer is over a card or the row has just scrolled in.
 */
describe("pictogram motion", () => {
  const styles = fs.readFileSync(
    new URL("../index.css", import.meta.url),
    "utf8"
  );
  const motion = styles.slice(styles.indexOf("Pictogram motion."));

  it("is part of the stylesheet", () => {
    expect(motion).toContain(".pictogram [data-picto]");
    expect(motion).toContain("@keyframes picto-settle");
  });

  it("animates only transform and opacity", () => {
    const transitioned = [...motion.matchAll(/transition:\s*([a-z-]+)/g)].map(
      match => match[1]
    );
    expect(transitioned).not.toHaveLength(0);
    expect(transitioned.every(property => property === "transform")).toBe(true);
    // Anything that forces layout or paint on every frame does not belong here.
    expect(motion).not.toMatch(
      /\b(width|height|top|left|right|bottom|margin|padding|box-shadow|filter|backdrop-filter):/
    );
  });

  it("never loops at rest", () => {
    expect(motion).not.toContain("infinite");
    // Every hover rule is gated behind a pointer over the card.
    for (const rule of motion.match(/^\.[^\n{]*\[data-picto="[a-z]+"\]/gm) ??
      []) {
      expect(rule).toContain(":hover");
    }
  });
});
