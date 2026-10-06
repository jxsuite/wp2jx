/**
 * The comparison logic on hand-made captures: pixels, computed-style equality, element matching,
 * and the findings each kind of difference produces. No browser: a capture is plain JSON.
 */
import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import {
  comparePixels,
  compareDocuments,
  domFindings,
  matchElements,
  pageFindings,
  sameStyleValue,
  visualFindings,
} from "../../src/verify/compare.ts";
import { parseRedirects } from "../../src/verify/redirects.ts";
import type {
  ElementProbe,
  ImageInfo,
  LinkInfo,
  PageSnapshot,
  StyleProbe,
} from "../../src/verify/types.ts";
import { createResolver } from "../../src/verify/urls.ts";

const LIVE = "https://finelinepainting.pro";
const LOCAL = "http://127.0.0.1:4000";
const resolver = createResolver({
  liveUrl: LIVE,
  localOrigin: LOCAL,
  rules: parseRedirects("/old /new/ 301\n"),
});

// ── Builders ─────────────────────────────────────────────────────────────────────────────────────

const style = (over: Partial<StyleProbe> = {}): StyleProbe => ({
  fontFamily: "Arial, sans-serif",
  fontSize: "16px",
  fontWeight: "400",
  color: "rgb(0, 0, 0)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  display: "block",
  margin: "0px",
  padding: "0px",
  ...over,
});

let counter = 0;
const el = (tag: string, text: string, over: Partial<ElementProbe> = {}): ElementProbe => ({
  path: `body > ${tag}:nth-child(${++counter})`,
  tag,
  classes: [],
  text,
  landmark: "body",
  rect: { x: 0, y: counter * 30, width: 100, height: 20 },
  style: style(),
  ...over,
});

const snap = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  requestedUrl: `${LIVE}/p/`,
  finalUrl: `${LIVE}/p/`,
  status: 200,
  viewport: { width: 1366, height: 900 },
  title: "Page",
  description: "",
  canonical: "",
  robots: "",
  lang: "en",
  docWidth: 1366,
  docHeight: 2000,
  textBlocks: [],
  headings: [],
  links: [],
  images: [],
  elements: [],
  overflow: { scrollWidth: 1366, clientWidth: 1366, overflow: false, offenders: [] },
  truncated: 0,
  consoleErrors: [],
  failedRequests: [],
  ...over,
});

const block = (text: string, path = `body > p:nth-child(${++counter})`) => ({ path, text });
const link = (raw: string, text: string, path = `body > a:nth-child(${++counter})`): LinkInfo => ({
  href: new URL(raw, `${LIVE}/p/`).href,
  raw,
  text,
  path,
});
const image = (src: string, over: Partial<ImageInfo> = {}): ImageInfo => ({
  kind: "img",
  src,
  currentSrc: src,
  alt: "",
  naturalWidth: 800,
  naturalHeight: 600,
  width: 400,
  height: 300,
  loaded: true,
  path: `body > img:nth-child(${++counter})`,
  ...over,
});

function png(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number] = () => [255, 255, 255],
): Buffer {
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(out);
}

const compare = (live: PageSnapshot, local: PageSnapshot, width = 1366) => {
  const { dom, work } = compareDocuments(live, local, resolver);
  return { dom, work, findings: domFindings(dom, work, live, local, resolver, width) };
};
const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

// ── Pixels ───────────────────────────────────────────────────────────────────────────────────────

describe("comparePixels", () => {
  test("identical images score 1 everywhere and report no bands", () => {
    const a = png(100, 400);
    const { visual, diffPng } = comparePixels(a, a);
    expect(visual).toMatchObject({
      fidelity: 1,
      aboveFold: 1,
      width: 100,
      height: 400,
      mismatchedPixels: 0,
      bands: [],
    });
    expect(PNG.sync.read(diffPng).height).toBe(400);
  });

  test("fidelity is one minus the share of differing pixels, and the worst band is where the difference is", () => {
    const live = png(100, 400);
    const local = png(100, 400, (x, y) =>
      y >= 300 && y < 340 && x < 50 ? [0, 0, 0] : [255, 255, 255],
    );
    const { visual } = comparePixels(live, local, { viewportHeight: 200 });
    // 40 rows x 50 columns of 100 x 400.
    expect(visual.mismatchedPixels).toBe(2000);
    expect(visual.fidelity).toBeCloseTo(1 - 2000 / 40000, 4);
    expect(visual.aboveFold).toBe(1);
    expect(visual.bands[0]).toMatchObject({ y: 200, height: 200 });
    expect(visual.bands[0]?.mismatch).toBeCloseTo(2000 / 20000, 4);
    expect(visual.bands).toHaveLength(1);
  });

  test("the first screen is scored on its own, so a bad tail does not hide a good fold", () => {
    const live = png(100, 1000);
    const local = png(100, 1000, (_x, y) => (y >= 500 ? [0, 0, 0] : [255, 255, 255]));
    const { visual } = comparePixels(live, local, { viewportHeight: 400 });
    expect(visual.aboveFold).toBe(1);
    expect(visual.fidelity).toBeCloseTo(0.5, 2);
  });

  test("a difference inside the first screen lowers the above-the-fold score by its share of that screen", () => {
    const live = png(100, 1000);
    const local = png(100, 1000, (_x, y) => (y < 100 ? [0, 0, 0] : [255, 255, 255]));
    const { visual } = comparePixels(live, local, { viewportHeight: 400 });
    expect(visual.aboveFold).toBeCloseTo(0.75, 4);
    expect(visual.fidelity).toBeCloseTo(0.9, 4);
  });

  test("a shorter page is padded with a colour no page has, so its missing tail counts even when it is white", () => {
    const live = png(100, 400);
    const local = png(100, 300);
    const { visual } = comparePixels(live, local);
    expect(visual).toMatchObject({ height: 400, liveHeight: 400, localHeight: 300 });
    expect(visual.fidelity).toBeCloseTo(0.75, 2);
  });

  test("a wider capture pads the width too", () => {
    const { visual } = comparePixels(png(100, 100), png(120, 100));
    expect(visual.width).toBe(120);
    expect(visual.fidelity).toBeLessThan(1);
  });

  test("the colour tolerance decides what counts as the same colour", () => {
    const live = png(50, 50, () => [100, 100, 100]);
    const local = png(50, 50, () => [140, 140, 140]);
    expect(comparePixels(live, local, { tolerance: 0.1 }).visual.fidelity).toBeLessThan(1);
    expect(comparePixels(live, local, { tolerance: 0.5 }).visual.fidelity).toBe(1);
    expect(comparePixels(live, local).visual.tolerance).toBe(0.1);
  });
});

// ── Computed style equality ──────────────────────────────────────────────────────────────────────

describe("sameStyleValue", () => {
  test("font families are the same when the first family is, whatever the fallbacks and quotes", () => {
    expect(
      sameStyleValue("fontFamily", '"Source Sans Pro", sans-serif', "'source sans pro', Arial"),
    ).toBe(true);
    expect(sameStyleValue("fontFamily", "Arial, sans-serif", "Verdana, sans-serif")).toBe(false);
  });

  test("sub-pixel font sizes are the same; half a pixel and more is not", () => {
    expect(sameStyleValue("fontSize", "20px", "20.3px")).toBe(true);
    expect(sameStyleValue("fontSize", "20px", "21px")).toBe(false);
  });

  test("weights compare as numbers, keywords included", () => {
    expect(sameStyleValue("fontWeight", "bold", "700")).toBe(true);
    expect(sameStyleValue("fontWeight", "normal", "400")).toBe(true);
    expect(sameStyleValue("fontWeight", "400", "600")).toBe(false);
  });

  test("colours are the same within two levels a channel; two transparent colours are the same whatever their rgb", () => {
    expect(sameStyleValue("color", "rgb(213, 49, 45)", "rgb(214, 49, 44)")).toBe(true);
    expect(sameStyleValue("color", "rgb(213, 49, 45)", "rgb(213, 49, 60)")).toBe(false);
    expect(sameStyleValue("color", "rgb(213, 49, 45)", "rgb(220, 49, 45)")).toBe(false);
    expect(sameStyleValue("color", "rgb(213, 49, 45)", "rgb(213, 60, 45)")).toBe(false);
    expect(sameStyleValue("backgroundColor", "rgba(0, 0, 0, 0)", "rgba(255, 255, 255, 0)")).toBe(
      true,
    );
    expect(sameStyleValue("backgroundColor", "rgba(0, 0, 0, 0.5)", "rgb(0, 0, 0)")).toBe(false);
    expect(sameStyleValue("backgroundColor", "rgb(0 0 0 / 50%)", "rgba(0, 0, 0, 0.5)")).toBe(true);
    expect(sameStyleValue("color", "color(srgb 1 0 0)", "rgb(255, 0, 0)")).toBe(false);
  });

  test("margin and padding compare side by side with a pixel and a half of room", () => {
    expect(sameStyleValue("margin", "0px 183px", "0px 183.5px")).toBe(true);
    expect(sameStyleValue("padding", "10px 20px", "10px 24px")).toBe(false);
    expect(sameStyleValue("margin", "0px auto", "0px auto")).toBe(true);
    expect(sameStyleValue("margin", "0px auto", "0px 20px")).toBe(false);
    expect(sameStyleValue("padding", "10px", "10px 10px")).toBe(false);
  });

  test("display is exact", () => {
    expect(sameStyleValue("display", "flex", "block")).toBe(false);
    expect(sameStyleValue("display", "flex", "flex")).toBe(true);
  });
});

// ── Matching ─────────────────────────────────────────────────────────────────────────────────────

describe("matchElements", () => {
  test("elements pair by tag and own text first, repeats in document order", () => {
    const a1 = el("a", "Learn more");
    const a2 = el("a", "Learn more");
    const b1 = el("a", "Learn more");
    const b2 = el("a", "Learn more");
    const pairs = matchElements([a1, a2], [b1, b2]);
    expect(pairs.map((p) => [p.live, p.local])).toEqual([
      [a1, b1],
      [a2, b2],
    ]);
  });

  test("text is compared normalised: typography and spacing do not break a match", () => {
    const live = el("h2", "Fine Line’s  work");
    const local = el("h2", "Fine Line's work");
    expect(matchElements([live], [local])).toHaveLength(1);
  });

  test("a block with no text pairs by its Cwicly class id, whatever its tag", () => {
    const live = el("section", "", { classes: ["section-c93760b", "cc-sct"] });
    const local = el("section", "", { classes: ["section-c93760b", "section-hero"] });
    const other = el("section", "", { classes: ["section-aaaaaaa"] });
    expect(matchElements([live, other], [local])).toEqual([{ live, local }]);
  });

  test("landmarks pair by tag and the landmark they sit in", () => {
    const live = el("nav", "");
    const local = el("nav", "");
    expect(matchElements([live], [local])).toHaveLength(1);
    expect(matchElements([el("div", "")], [el("div", "")])).toEqual([]);
  });

  test("an element nothing pairs is left out, and each local element is used once", () => {
    const live = [el("p", "one"), el("p", "one"), el("p", "two")];
    const local = [el("p", "one")];
    expect(matchElements(live, local)).toHaveLength(1);
  });

  test("a copy only the live page has is left unpaired rather than matched to the other copy far away", () => {
    // The phone number is in the header and the footer on live, and only in the footer on the migrated page.
    const header = el("a", "717-228-6606", {
      path: "body > div.container-c6fbfe8:nth-child(2) > a.button-c01e7f6:nth-child(1)",
      rect: { x: 900, y: 40, width: 100, height: 20 },
    });
    const footer = el("a", "717-228-6606", {
      path: "body > section.section-cee39ac:nth-child(11) > a.button-c672e62:nth-child(2)",
      rect: { x: 100, y: 8000, width: 100, height: 20 },
    });
    const localFooter = el("a", "717-228-6606", {
      path: "body > section.section-cee39ac:nth-child(11) > a.button-c672e62:nth-child(2)",
      rect: { x: 100, y: 8100, width: 100, height: 20 },
    });
    expect(matchElements([header, footer], [localFooter])).toEqual([
      { live: footer, local: localFooter },
    ]);
    // Without block ids to go by, a copy within reach pairs and one far away does not.
    const near = el("a", "Call", {
      path: "body > a:nth-child(1)",
      rect: { x: 0, y: 100, width: 10, height: 10 },
    });
    const far = el("a", "Call", {
      path: "body > a:nth-child(9)",
      rect: { x: 0, y: 9000, width: 10, height: 10 },
    });
    const localNear = el("a", "Call", {
      path: "body > a:nth-child(1)",
      rect: { x: 0, y: 130, width: 10, height: 10 },
    });
    expect(matchElements([near, far], [localNear])).toEqual([{ live: near, local: localNear }]);
    expect(matchElements([far, near], [localNear])).toEqual([{ live: near, local: localNear }]);
    // Two far copies against one near one: neither is the near one's twin.
    const far2 = el("a", "Call", {
      path: "body > a:nth-child(10)",
      rect: { x: 0, y: 9500, width: 10, height: 10 },
    });
    expect(matchElements([far, far2], [localNear])).toEqual([]);
    // One for one is always a pair: a page that grew by thousands of pixels still has its elements.
    expect(matchElements([far], [localNear])).toEqual([{ live: far, local: localNear }]);
  });

  test("a repeat the migrated page has twice and live once pairs the copy that sits in the same place", () => {
    const live = el("a", "More", {
      path: "body > section.s-aaaaaaa:nth-child(3) > a:nth-child(1)",
      rect: { x: 0, y: 2000, width: 10, height: 10 },
    });
    const first = el("a", "More", {
      path: "body > section.s-bbbbbbb:nth-child(2) > a:nth-child(1)",
      rect: { x: 0, y: 500, width: 10, height: 10 },
    });
    const second = el("a", "More", {
      path: "body > section.s-aaaaaaa:nth-child(3) > a:nth-child(1)",
      rect: { x: 0, y: 2010, width: 10, height: 10 },
    });
    expect(matchElements([live], [first, second])).toEqual([{ live, local: second }]);
  });

  test("results follow the live page's document order", () => {
    const a = el("p", "a");
    const b = el("section", "", { classes: ["x-1234567"] });
    const c = el("p", "c");
    const pairs = matchElements(
      [a, b, c],
      [el("p", "c"), el("section", "", { classes: ["x-1234567"] }), el("p", "a")],
    );
    expect(pairs.map((p) => p.live)).toEqual([a, b, c]);
  });
});

// ── Documents ────────────────────────────────────────────────────────────────────────────────────

describe("compareDocuments: text", () => {
  test("missing, extra and changed blocks are told apart, each with its path", () => {
    const live = snap({
      textBlocks: [
        block("Welcome", "p.a"),
        block("We paint barns and houses in Lancaster", "p.b"),
        block("Only on live", "p.c"),
        block("Call us", "p.d"),
      ],
    });
    const local = snap({
      textBlocks: [
        block("Welcome", "q.a"),
        block("We paint barns and homes in Lancaster", "q.b"),
        block("Call us", "q.d"),
        block("Brand new block of words", "q.e"),
      ],
    });
    const { dom, findings } = compare(live, local);
    expect(dom.text.missing).toEqual([{ path: "p.c", text: "Only on live" }]);
    expect(dom.text.extra).toEqual([{ path: "q.e", text: "Brand new block of words" }]);
    expect(dom.text.changed).toEqual([
      {
        livePath: "p.b",
        localPath: "q.b",
        live: "We paint barns and houses in Lancaster",
        local: "We paint barns and homes in Lancaster",
        similarity: expect.any(Number),
      },
    ]);
    expect(codes(findings)).toEqual(
      expect.arrayContaining(["text.missing", "text.extra", "text.changed"]),
    );
    expect(findings.find((f) => f.code === "text.missing")).toMatchObject({
      selector: "p.c",
      count: 1,
    });
  });

  test("words split differently are regrouped, not missing; a block that is really gone still is", () => {
    const live = snap({
      textBlocks: [
        block("Projects", "n1"),
        block("Service Area", "n2"),
        block("Financing", "n3"),
        block("Truly gone from the page", "p9"),
      ],
    });
    const local = snap({ textBlocks: [block("ProjectsService AreaFinancing", "nav")] });
    const { dom, findings } = compare(live, local);
    expect(dom.text.regrouped).toBe(4);
    expect(dom.text.missing).toEqual([{ path: "p9", text: "Truly gone from the page" }]);
    expect(dom.text.extra).toEqual([]);
    expect(findings.find((f) => f.code === "text.regrouped")).toMatchObject({
      severity: "info",
      count: 4,
    });
  });

  test("the same regrouping the other way round: split on the migrated page, joined on live", () => {
    const live = snap({ textBlocks: [block("ProjectsService AreaFinancing", "nav")] });
    const local = snap({
      textBlocks: [block("Projects", "n1"), block("Service Area", "n2"), block("Financing", "n3")],
    });
    const { dom } = compare(live, local);
    expect(dom.text.missing).toEqual([]);
    expect(dom.text.extra).toEqual([]);
    expect(dom.text.regrouped).toBe(4);
  });

  test("a short block is never taken for part of a longer one", () => {
    const { dom } = compare(
      snap({ textBlocks: [block("Hi"), block("Other words entirely here")] }),
      snap({ textBlocks: [block("Say Hi to the crowd today")] }),
    );
    expect(dom.text.regrouped).toBe(0);
    expect(dom.text.missing.map((m) => m.text)).toContain("Hi");
    const reverse = compare(
      snap({ textBlocks: [block("Say Hi to the crowd today")] }),
      snap({ textBlocks: [block("Hi")] }),
    ).dom;
    expect(reverse.text.regrouped).toBe(0);
    expect(reverse.text.extra.map((m) => m.text)).toEqual(["Hi"]);
  });

  test("a different word inside another block does not hide a missing and an extra block", () => {
    const first = compare(
      snap({ textBlocks: [block("Home"), block("Painting services")] }),
      snap({ textBlocks: [block("Homeowner guide")] }),
    ).dom;
    expect(first.text.regrouped).toBe(0);
    expect(first.text.missing.map((m) => m.text)).toEqual(["Home", "Painting services"]);
    expect(first.text.extra.map((m) => m.text)).toEqual(["Homeowner guide"]);
    const second = compare(
      snap({ textBlocks: [block("Paint"), block("Stain")] }),
      snap({ textBlocks: [block("Painting and staining guide")] }),
    );
    expect(second.dom.text.regrouped).toBe(0);
    expect(codes(second.findings)).not.toContain("text.regrouped");
    const told = [
      ...second.dom.text.missing.map((m) => m.text),
      ...second.dom.text.changed.map((c) => c.live),
    ];
    expect(told.sort()).toEqual(["Paint", "Stain"]);
  });

  test("a regrouped run leaves no text.changed behind for the block it was paired with", () => {
    const { dom, findings } = compare(
      snap({
        textBlocks: [block("Home"), block("About"), block("Contact"), block("Footer text here")],
      }),
      snap({ textBlocks: [block("Home About Contact"), block("Footer text here")] }),
    );
    expect(dom.text.regrouped).toBe(4);
    expect(dom.text.changed).toEqual([]);
    expect(dom.text.missing).toEqual([]);
    expect(dom.text.extra).toEqual([]);
    expect(codes(findings)).toEqual(["text.regrouped"]);
  });

  test("short blocks count toward a regrouping once a longer one anchors it", () => {
    const { dom } = compare(
      snap({ textBlocks: [block("Projects"), block("FAQ"), block("Financing")] }),
      snap({ textBlocks: [block("ProjectsFAQFinancing")] }),
    );
    expect(dom.text.regrouped).toBe(4);
    expect(dom.text.missing).toEqual([]);
  });

  test("typographic differences are not differences", () => {
    const live = snap({ textBlocks: [block("It’s “good” – really")] });
    const local = snap({ textBlocks: [block('It\'s "good" - really')] });
    const { dom, findings } = compare(live, local);
    expect(dom.text.similarity).toBe(1);
    expect(findings).toEqual([]);
  });

  test("losing a fifth of the words is an error, a few words a warning, a short extra a note", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const big = compare(
      snap({ textBlocks: [block(words(10)), block(words(5)), block("keep this text")] }),
      snap({ textBlocks: [block("keep this text")] }),
    );
    expect(big.findings.find((f) => f.code === "text.missing")?.severity).toBe("error");
    const live = snap({ textBlocks: [block(words(40)), block("lost words here")] });
    const small = compare(live, snap({ textBlocks: [block(words(40))] }));
    expect(small.findings.find((f) => f.code === "text.missing")?.severity).toBe("warning");
    const extra = compare(
      snap({ textBlocks: [block(words(100))] }),
      snap({ textBlocks: [block(words(100)), block("one more line")] }),
    );
    expect(extra.findings.find((f) => f.code === "text.extra")?.severity).toBe("info");
  });

  test("the share of live words lost sets the severity: 20% is an error, 5% a warning, less a note", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const sev = (lost: number) =>
      compare(
        snap({ textBlocks: [block(words(100 - lost)), block(words(lost).replace(/w/g, "x"))] }),
        snap({ textBlocks: [block(words(100 - lost))] }),
      ).findings.find((f) => f.code === "text.missing")?.severity;
    expect([sev(20), sev(19), sev(5), sev(4)]).toEqual(["error", "warning", "warning", "info"]);
  });

  test("a change that keeps nine tenths of its words is a note, a heavier one a warning", () => {
    const base = "one two three four five six seven eight nine ten eleven twelve";
    const light = compare(
      snap({ textBlocks: [block(base)] }),
      snap({ textBlocks: [block(`${base} thirteen`)] }),
    );
    expect(light.findings.find((f) => f.code === "text.changed")?.severity).toBe("info");
    const heavy = compare(
      snap({ textBlocks: [block(base)] }),
      snap({ textBlocks: [block("one two three four five six x y z")] }),
    );
    expect(heavy.findings.find((f) => f.code === "text.changed")?.severity).toBe("warning");
  });
});

describe("compareDocuments: headings", () => {
  const h = (level: number, text: string) => ({
    level,
    text,
    path: `body > h${level}:nth-child(${++counter})`,
  });

  test("a missing h1 is an error, a missing h3 a warning, a level change is told by text", () => {
    const live = snap({ headings: [h(1, "Welcome"), h(2, "Services"), h(3, "Barns")] });
    const local = snap({ headings: [h(2, "Welcome"), h(2, "Services")] });
    const { dom, findings } = compare(live, local);
    expect(dom.headings.levelChanged.map((c) => [c.live.level, c.local.level])).toEqual([[1, 2]]);
    expect(dom.headings.missing.map((x) => x.text)).toEqual(["Barns"]);
    expect(findings.find((f) => f.code === "heading.level")?.severity).toBe("warning");
    expect(findings.find((f) => f.code === "heading.missing")?.severity).toBe("warning");
    const lostH1 = compare(snap({ headings: [h(1, "Welcome")] }), snap());
    expect(lostH1.findings.find((f) => f.code === "heading.missing")?.severity).toBe("error");
  });

  test("an extra heading is a note", () => {
    const { findings } = compare(snap(), snap({ headings: [h(2, "New")] }));
    expect(findings.find((f) => f.code === "heading.extra")?.severity).toBe("info");
  });
});

describe("compareDocuments: links", () => {
  test("a link counts as the same when it leads to the same place after redirects, even from another origin", () => {
    const live = snap({
      links: [
        link("/old", "Services"),
        link(`${LIVE}/about/`, "About"),
        link("mailto:Info@x.com", "Mail"),
      ],
    });
    const local = snap({
      finalUrl: `${LOCAL}/p/`,
      links: [
        link(`${LOCAL}/new/`, "Services"),
        link("/about", "About"),
        link("mailto:info@x.com", "Mail"),
      ],
    });
    const { dom, findings } = compare(live, local);
    expect(dom.links.missing).toEqual([]);
    expect(dom.links.hrefChanged).toEqual([]);
    expect(dom.links.extra).toEqual([]);
    expect(findings).toEqual([]);
  });

  test("a link with the same label and another target is a changed href; one with neither is missing", () => {
    const live = snap({ links: [link("/services/", "Services"), link("/gone/", "Gone page")] });
    const local = snap({ links: [link("/our-services/", "Services")] });
    const { dom, findings } = compare(live, local);
    expect(dom.links.hrefChanged.map((c) => [c.live.raw, c.local.raw])).toEqual([
      ["/services/", "/our-services/"],
    ]);
    expect(dom.links.missing.map((l) => l.raw)).toEqual(["/gone/"]);
    expect(findings.find((f) => f.code === "link.href-changed")?.data?.examples).toEqual([
      expect.objectContaining({ live: "/services/", local: "/our-services/", text: "Services" }),
    ]);
    expect(findings.find((f) => f.code === "link.missing")?.severity).toBe("warning");
  });

  test("duplicates are counted: a link twice on the live page and once on the local one leaves one missing", () => {
    const live = snap({ links: [link("/a/", "A"), link("/a/", "A")] });
    const local = snap({ links: [link("/a/", "A")] });
    expect(compare(live, local).dom.links.missing).toHaveLength(1);
  });

  test("a WordPress-internal link missing from the migrated page is only a note; extras are notes", () => {
    const { findings } = compare(
      snap({ links: [link("/wp-json/", "API"), link("/feed/", "Feed")] }),
      snap({ links: [link("/extra/", "Extra")] }),
    );
    expect(findings.find((f) => f.code === "link.missing")?.severity).toBe("info");
    expect(findings.find((f) => f.code === "link.extra")?.severity).toBe("info");
  });

  test("anchors and empty hrefs are not compared", () => {
    const { dom } = compare(snap({ links: [link("#top", "Top"), link("", "Nothing")] }), snap());
    expect(dom.links.missing).toEqual([]);
  });
});

describe("compareDocuments: images", () => {
  test("an upload on the live site and its migrated copy are the same image, and size differences are told", () => {
    const live = snap({
      images: [
        image(`${LIVE}/wp-content/uploads/2024/03/barn-1024x768.jpg`, { width: 400, height: 300 }),
      ],
    });
    const local = snap({
      images: [image(`${LOCAL}/media/barn.webp`, { width: 400, height: 300, naturalWidth: 800 })],
    });
    const { dom, findings } = compare(live, local);
    expect(dom.images).toMatchObject({ matched: 1, missing: [], extra: [], broken: [] });
    // Where the live address went: the migrated media path, with both sizes.
    expect(dom.images.pairs).toEqual([
      {
        key: "barn",
        kind: "img",
        liveSrc: `${LIVE}/wp-content/uploads/2024/03/barn-1024x768.jpg`,
        localSrc: `${LOCAL}/media/barn.webp`,
        liveNatural: "800x600",
        localNatural: "800x600",
        liveRendered: "400x300",
        localRendered: "400x300",
        loaded: true,
        path: expect.stringMatching(/^body > img:nth-child\(\d+\)$/),
      },
    ]);
    expect(findings).toEqual([]);
    const resized = compare(
      live,
      snap({ images: [image(`${LOCAL}/media/barn.webp`, { width: 300, height: 225 })] }),
    );
    expect(resized.findings.find((f) => f.code === "image.rendered-size")).toMatchObject({
      severity: "warning",
      count: 1,
    });
  });

  test("an image the migrated page lacks is missing, with its address and path", () => {
    const live = snap({
      images: [
        image(`${LIVE}/wp-content/uploads/barn.jpg`, { alt: "Barn", path: "body > img.hero" }),
        image(`${LIVE}/wp-content/uploads/house.jpg`),
      ],
    });
    const local = snap({ images: [image(`${LOCAL}/media/house.jpg`)] });
    const { dom, findings } = compare(live, local);
    expect(dom.images.missing.map((i) => i.path)).toEqual(["body > img.hero"]);
    const f = findings.find((x) => x.code === "image.missing");
    expect(f).toMatchObject({ severity: "error", count: 1, selector: "body > img.hero" });
    expect(f?.data?.examples).toEqual([
      expect.objectContaining({ src: `${LIVE}/wp-content/uploads/barn.jpg`, alt: "Barn" }),
    ]);
  });

  test("a renamed file with the same alt text still counts as the same image", () => {
    const live = snap({ images: [image(`${LIVE}/wp-content/uploads/a.jpg`, { alt: "Our barn" })] });
    const local = snap({ images: [image(`${LOCAL}/media/b.jpg`, { alt: "Our  barn" })] });
    expect(compare(live, local).dom.images.matched).toBe(1);
  });

  test("an image that did not load is broken, an error, wherever it came from", () => {
    const local = snap({
      images: [
        image(`${LOCAL}/media/gone.jpg`, {
          loaded: false,
          naturalWidth: 0,
          path: "body > img.gone",
        }),
      ],
    });
    const { findings } = compare(snap(), local);
    expect(findings.find((f) => f.code === "image.broken")).toMatchObject({
      severity: "error",
      selector: "body > img.gone",
    });
    expect(findings.find((f) => f.code === "image.extra")).toBeDefined();
  });

  test("an image that never loaded on the live page is not missing from the migrated one", () => {
    const deadBackground = `${LIVE}/wp-content/uploads/swash-flip.svg`;
    const live = snap({
      images: [
        image(deadBackground, { kind: "background" }),
        image(`${LIVE}/wp-content/uploads/broken.jpg`, { loaded: false, naturalWidth: 0 }),
        image(`${LIVE}/wp-content/uploads/barn.jpg`),
      ],
      failedRequests: [{ url: deadBackground, status: 404 }],
    });
    const local = snap({ images: [] });
    const { dom, findings } = compare(live, local);
    expect(dom.images.missing.map((i) => i.src)).toEqual([`${LIVE}/wp-content/uploads/barn.jpg`]);
    expect(findings.find((f) => f.code === "image.missing")).toMatchObject({
      count: 1,
      message: "1 of 1 images on the live page are not on the migrated page",
    });
    const dead = findings.find((f) => f.code === "image.broken-on-live");
    expect(dead).toMatchObject({ severity: "info", count: 2 });
  });

  test("an image with no address, or one dead on the live page as well, is not a broken load", () => {
    const deadUrl = `${LIVE}/wp-content/uploads/Lehigh-County-PA.png`;
    const live = snap({
      images: [
        image("", { loaded: false, naturalWidth: 0, path: "body > img.slot" }),
        image(deadUrl, { loaded: false, naturalWidth: 0 }),
      ],
      failedRequests: [{ url: deadUrl, status: 404 }],
    });
    const local = snap({
      images: [
        image("", { loaded: false, naturalWidth: 0, path: "body > img.slot" }),
        image(deadUrl, { loaded: false, naturalWidth: 0 }),
        image(`${LOCAL}/media/gone.jpg`, {
          loaded: false,
          naturalWidth: 0,
          path: "body > img.gone",
        }),
        // An empty slot the live page has no twin of: still nothing that failed to load.
        image("", { loaded: false, naturalWidth: 0, path: "body > img.stray" }),
      ],
    });
    const { dom, findings } = compare(live, local);
    expect(dom.images.broken.map((i) => i.path)).toEqual(["body > img.gone"]);
    expect(findings.find((f) => f.code === "image.broken")).toMatchObject({ count: 1 });
  });

  test("an image the oracle itself blocks is not broken on the migrated page", () => {
    const local = snap({
      images: [
        image("https://i.ytimg.com/vi/abc/hqdefault.jpg", { loaded: false, blocked: true }),
        image(`${LOCAL}/media/gone.jpg`, { loaded: false }),
      ],
    });
    const f = compare(snap(), local).findings.find((x) => x.code === "image.broken");
    expect(f).toMatchObject({ severity: "error", count: 1 });
    // A blocked image on live that the migration lost is still lost: it was never broken there.
    const live = snap({
      images: [image("https://i.ytimg.com/vi/abc/hqdefault.jpg", { loaded: false, blocked: true })],
    });
    expect(compare(live, snap()).dom.images.missing).toHaveLength(1);
  });

  test("a rendered size is told apart past six pixels and eight percent, width and height each on their own", () => {
    const sizes = (liveW: number, liveH: number, localW: number, localH: number) => {
      const live = snap({
        images: [image(`${LIVE}/wp-content/uploads/a.jpg`, { width: liveW, height: liveH })],
      });
      const local = snap({
        images: [image(`${LOCAL}/media/a.jpg`, { width: localW, height: localH })],
      });
      return compare(live, local).findings.some((f) => f.code === "image.rendered-size");
    };
    // 8% of 400 is 32: a 32px difference is within it, 33 is not; the same for the height.
    expect(sizes(400, 300, 432, 300)).toBe(false);
    expect(sizes(400, 300, 433, 300)).toBe(true);
    expect(sizes(400, 300, 400, 324)).toBe(false);
    expect(sizes(400, 300, 400, 325)).toBe(true);
    expect(sizes(400, 300, 367, 300)).toBe(true);
    // Small images get six pixels, whatever eight percent of them is.
    expect(sizes(20, 20, 26, 20)).toBe(false);
    expect(sizes(20, 20, 27, 20)).toBe(true);
    expect(sizes(20, 20, 20, 27)).toBe(true);
  });

  test("fewer pixels than live at the same rendered size is a note about resolution", () => {
    const live = snap({
      images: [
        image(`${LIVE}/wp-content/uploads/barn.jpg`, {
          naturalWidth: 2000,
          width: 400,
          height: 300,
        }),
      ],
    });
    const local = snap({
      images: [image(`${LOCAL}/media/barn.jpg`, { naturalWidth: 480, width: 400, height: 300 })],
    });
    expect(
      compare(live, local).findings.find((f) => f.code === "image.low-resolution"),
    ).toMatchObject({ severity: "info" });
  });

  test("backgrounds match backgrounds and are never called broken", () => {
    const live = snap({
      images: [image(`${LIVE}/wp-content/uploads/hero.jpg`, { kind: "background" })],
    });
    const local = snap({
      images: [image(`${LOCAL}/media/hero.jpg`, { kind: "background", loaded: true })],
    });
    expect(compare(live, local).dom.images.matched).toBe(1);
    const asImg = snap({ images: [image(`${LOCAL}/media/hero.jpg`)] });
    expect(compare(live, asImg).dom.images.missing).toHaveLength(1);
  });
});

describe("compareDocuments: styles and boxes", () => {
  const navLinks = (font: string, count = 5) =>
    Array.from({ length: count }, (_, i) =>
      el("a", `Item ${i}`, {
        landmark: "nav",
        style: style({ fontFamily: font }),
        rect: { x: i * 100, y: 10, width: 90, height: 20 },
      }),
    );

  test("every nav link in another font is one systematic finding with both values, the group and examples", () => {
    const { dom, findings } = compare(
      snap({ elements: navLinks("Arial, sans-serif") }),
      snap({ elements: navLinks("Verdana, sans-serif") }),
    );
    expect(dom.elements.groups[0]).toMatchObject({
      group: "nav > a",
      property: "fontFamily",
      elements: 5,
      differing: 5,
      live: "Arial, sans-serif",
      local: "Verdana, sans-serif",
    });
    const f = findings.find((x) => x.code === "style.systematic");
    expect(f).toMatchObject({
      severity: "error",
      property: "fontFamily",
      live: "Arial, sans-serif",
      local: "Verdana, sans-serif",
      count: 5,
    });
    expect(f?.data).toMatchObject({ group: "nav > a", elements: 5 });
    expect(f?.selector).toMatch(/^body > a:nth-child\(\d+\)$/);
    expect(findings.find((x) => x.code === "style.mismatch")).toBeUndefined();
  });

  test("two differing links of five are isolated mismatches, not a systematic difference", () => {
    const live = navLinks("Arial");
    const local = navLinks("Arial");
    for (const e of local.slice(0, 2)) e.style = style({ fontFamily: "Verdana" });
    const { findings } = compare(snap({ elements: live }), snap({ elements: local }));
    expect(findings.find((f) => f.code === "style.systematic")).toBeUndefined();
    expect(findings.find((f) => f.code === "style.mismatch")).toMatchObject({
      severity: "info",
      property: "fontFamily",
      count: 2,
    });
  });

  test("three of ten is not most of a group, and two of two is not enough elements to call it systematic", () => {
    const live = Array.from({ length: 10 }, (_, i) => el("p", `p${i}`));
    const local = live.map((e, i) => ({
      ...e,
      path: `${e.path}'`,
      style: i < 3 ? style({ color: "rgb(90, 90, 90)" }) : e.style,
    }));
    const three = compare(snap({ elements: live }), snap({ elements: local })).findings;
    expect(three.find((f) => f.code === "style.systematic")).toBeUndefined();
    expect(three.find((f) => f.code === "style.mismatch")).toMatchObject({
      property: "color",
      count: 3,
    });
    const pair = [el("h2", "x"), el("h2", "y")];
    const pairLocal = pair.map((e) => ({
      ...e,
      path: `${e.path}'`,
      style: style({ fontSize: "30px" }),
    }));
    const two = compare(snap({ elements: pair }), snap({ elements: pairLocal })).findings;
    expect(two.find((f) => f.code === "style.systematic")).toBeUndefined();
    expect(two.find((f) => f.code === "style.mismatch")).toMatchObject({
      property: "fontSize",
      count: 2,
    });
  });

  test("a colour difference on most of a group is systematic but only a warning", () => {
    const live = Array.from({ length: 4 }, (_, i) =>
      el("p", `p${i}`, { style: style({ color: "rgb(0, 0, 0)" }) }),
    );
    const local = Array.from({ length: 4 }, (_, i) =>
      el("p", `p${i}`, { style: style({ color: "rgb(51, 51, 51)" }) }),
    );
    const f = compare(snap({ elements: live }), snap({ elements: local })).findings.find(
      (x) => x.code === "style.systematic",
    );
    expect(f).toMatchObject({ severity: "warning", property: "color" });
  });

  test("the first element whose position moves is named, with what is above it", () => {
    const live = [
      el("h1", "A", { rect: { x: 0, y: 0, width: 100, height: 40 } }),
      el("p", "B", { rect: { x: 0, y: 50, width: 100, height: 20 } }),
      el("p", "C", { rect: { x: 0, y: 80, width: 100, height: 20 } }),
    ];
    const local = [
      el("h1", "A", { rect: { x: 0, y: 0, width: 100, height: 40 } }),
      el("p", "B", { rect: { x: 0, y: 90, width: 100, height: 20 } }),
      el("p", "C", { rect: { x: 0, y: 120, width: 100, height: 20 } }),
    ];
    const f = compare(snap({ elements: live }), snap({ elements: local })).findings.find(
      (x) => x.code === "layout.first-shift",
    );
    expect(f).toMatchObject({ severity: "warning", live: live[1]?.path, selector: local[1]?.path });
    expect(f?.data).toMatchObject({ dy: 40, matchedAbove: 1 });
  });

  test("boxes with another width or height are listed biggest first; a handful is a note, many a warning", () => {
    const live = Array.from({ length: 3 }, (_, i) =>
      el("p", `p${i}`, { rect: { x: 0, y: i * 40, width: 100, height: 20 } }),
    );
    const local = [
      el("p", "p0", { rect: { x: 0, y: 0, width: 160, height: 20 } }),
      el("p", "p1", { rect: { x: 0, y: 40, width: 100, height: 20 } }),
      el("p", "p2", { rect: { x: 0, y: 80, width: 100, height: 60 } }),
    ];
    const f = compare(snap({ elements: live }), snap({ elements: local })).findings.find(
      (x) => x.code === "layout.size-changed",
    );
    expect(f).toMatchObject({ severity: "info", count: 2 });
    expect((f?.data?.examples as { text: string }[] | undefined)?.[0]?.text).toBe("p0");
    const manyLive = Array.from({ length: 25 }, (_, i) =>
      el("p", `m${i}`, { rect: { x: 0, y: i * 40, width: 100, height: 20 } }),
    );
    const manyLocal = manyLive.map((e) => ({
      ...e,
      path: `${e.path}'`,
      rect: { ...e.rect, width: 200 },
    }));
    expect(
      compare(snap({ elements: manyLive }), snap({ elements: manyLocal })).findings.find(
        (x) => x.code === "layout.size-changed",
      )?.severity,
    ).toBe("warning");
  });

  test("the delta list is the 300 biggest; every matched element still counts", () => {
    const many = (size: string) =>
      Array.from({ length: 350 }, (_, i) =>
        el("p", `paragraph number ${i}`, { style: style({ fontSize: size }) }),
      );
    const { dom, work } = compare(
      snap({ elements: many("16px") }),
      snap({ elements: many("20px") }),
    );
    expect(dom.elements.matched).toBe(350);
    expect(work.allDeltas).toHaveLength(350);
    expect(dom.elements.deltas).toHaveLength(300);
  });

  test("past a quarter of a million candidate pairs, repeated elements pair in order instead of by place", () => {
    const far = (count: number, y: number) =>
      Array.from({ length: count }, () =>
        el("a", "Call", {
          path: "body > a:nth-child(1)",
          rect: { x: 0, y, width: 10, height: 10 },
        }),
      );
    // Near the cap the aligner looks at where each copy sits: all of these are far apart, so none pairs.
    expect(matchElements(far(300, 0), far(200, 9000))).toEqual([]);
    // Past it, the pairing is positional and cheap: the first 500 pair with the 500 there are.
    const live = far(600, 0);
    const local = far(500, 9000);
    const pairs = matchElements(live, local);
    expect(pairs).toHaveLength(500);
    expect(pairs[7]).toEqual({ live: live[7] as ElementProbe, local: local[7] as ElementProbe });
  });

  test("identical probes produce no findings and no deltas", () => {
    const a = navLinks("Arial");
    const { dom, findings } = compare(
      snap({ elements: a }),
      snap({ elements: a.map((e) => ({ ...e })) }),
    );
    expect(dom.elements).toMatchObject({ matched: 5, deltas: [], groups: [] });
    expect(findings).toEqual([]);
  });
});

describe("domFindings: the page's own health", () => {
  test("horizontal overflow that live does not have is an error with the offending elements", () => {
    const local = snap({
      overflow: {
        scrollWidth: 720,
        clientWidth: 390,
        overflow: true,
        offenders: [{ path: "body > div.wide", right: 720, width: 700 }],
      },
    });
    const live = snap({
      viewport: { width: 390, height: 844 },
      overflow: { scrollWidth: 390, clientWidth: 390, overflow: false, offenders: [] },
    });
    const f = compare(live, local, 390).findings.find((x) => x.code === "layout.overflow-x");
    expect(f).toMatchObject({
      severity: "error",
      live: 390,
      local: 720,
      selector: "body > div.wide",
      viewport: 390,
    });
  });

  test("overflow that live has too is a warning, and none is nothing", () => {
    const wide = { scrollWidth: 720, clientWidth: 390, overflow: true, offenders: [] };
    const wider = { scrollWidth: 900, clientWidth: 390, overflow: true, offenders: [] };
    expect(
      compare(snap({ overflow: wide }), snap({ overflow: wider })).findings.find(
        (x) => x.code === "layout.overflow-x",
      )?.severity,
    ).toBe("warning");
    expect(compare(snap({ overflow: wide }), snap({ overflow: wide })).findings).toEqual([]);
  });

  test("failed requests and console errors that live does not have are the migration's; shared ones are not", () => {
    const live = snap({
      failedRequests: [
        { url: "https://ads.example/x.js", failure: "net::ERR_FAILED" },
        { url: `${LIVE}/favicon.ico`, status: 404 },
      ],
      consoleErrors: [
        { message: "Third party blew up" },
        { message: "Failed to load resource: 404", url: `${LIVE}/favicon.ico` },
      ],
    });
    const local = snap({
      failedRequests: [
        { url: "https://ads.example/x.js", failure: "net::ERR_FAILED" },
        { url: `${LOCAL}/favicon.ico`, status: 404 },
        { url: `${LOCAL}/media/gone.jpg`, status: 404 },
        { url: "https://fonts.example/f.woff", failure: "net::ERR_FAILED" },
      ],
      consoleErrors: [
        { message: "Third party blew up" },
        { message: "Failed to load resource: 404", url: `${LOCAL}/favicon.ico` },
        { message: "Failed to load resource: 404", url: `${LOCAL}/media/gone.jpg` },
        { message: "Uncaught TypeError: x is undefined", url: `${LOCAL}/app.js` },
      ],
    });
    const { findings } = compare(live, local);
    const failed = findings.find((f) => f.code === "request.failed");
    expect(failed).toMatchObject({ severity: "error", count: 2 });
    expect(failed?.data?.examples).toEqual([
      { url: `${LOCAL}/media/gone.jpg`, status: 404 },
      { url: "https://fonts.example/f.woff", failure: "net::ERR_FAILED" },
    ]);
    expect(findings.find((f) => f.code === "console.error")).toMatchObject({
      severity: "warning",
      count: 2,
    });
  });

  test("resources the migrated page still loads from the live site are a warning, whoever asked", () => {
    const local = snap({
      images: [
        image(`${LIVE}/wp-content/uploads/Lehigh.png`),
        image(`${LOCAL}/media/fine.png`),
        image(`https://www.finelinepainting.pro/a.png`, { kind: "background" }),
      ],
      requests: [
        `${LOCAL}/p/`,
        `${LIVE}/wp-content/uploads/Lehigh.png`,
        `${LIVE}/wp-content/themes/x/style.css`,
        "https://fonts.example/f.woff",
      ],
    });
    const f = compare(snap(), local).findings.find((x) => x.code === "resource.live-origin");
    expect(f).toMatchObject({ severity: "warning", count: 3 });
    expect(f?.data?.examples).toEqual([
      `${LIVE}/wp-content/uploads/Lehigh.png`,
      "https://www.finelinepainting.pro/a.png",
      `${LIVE}/wp-content/themes/x/style.css`,
    ]);
    const clean = compare(
      snap({ images: [image(`${LOCAL}/media/a.png`)] }),
      snap({ requests: [`${LOCAL}/p/`], images: [image(`${LOCAL}/media/a.png`)] }),
    );
    expect(clean.findings).toEqual([]);
  });

  test("a page cut by the extractor's caps says so, with what was dropped", () => {
    const f = compare(snap(), snap({ truncated: 12, truncatedBlocks: 40 })).findings.find(
      (x) => x.code === "extract.truncated",
    );
    expect(f).toMatchObject({ severity: "info", viewport: 1366 });
    expect(f?.data).toMatchObject({ local: { elements: 12, blocks: 40 } });
    expect(
      compare(snap({ truncatedBlocks: 3 }), snap()).findings.find(
        (x) => x.code === "extract.truncated",
      )?.data,
    ).toMatchObject({ live: { elements: 0, blocks: 3 } });
  });

  test("a failed external request alone is a warning", () => {
    const local = snap({
      failedRequests: [{ url: "https://fonts.example/f.woff", failure: "net::ERR_FAILED" }],
    });
    expect(compare(snap(), local).findings.find((f) => f.code === "request.failed")?.severity).toBe(
      "warning",
    );
  });
});

// ── Visual and page findings ─────────────────────────────────────────────────────────────────────

describe("visualFindings", () => {
  const visual = (fidelity: number) => ({
    fidelity,
    aboveFold: fidelity,
    width: 1366,
    height: 2000,
    liveHeight: 2000,
    localHeight: 2000,
    mismatchedPixels: 1,
    totalPixels: 2,
    tolerance: 0.1,
    bands: [],
  });

  test("fidelity under 0.97 is noted, under 0.9 a warning, under 0.7 an error; above it, nothing", () => {
    const sev = (f: number) =>
      visualFindings(visual(f), snap(), snap(), 1366).find((x) => x.code === "visual.low-fidelity")
        ?.severity;
    expect([sev(0.99), sev(0.96), sev(0.85), sev(0.5)]).toEqual([
      undefined,
      "info",
      "warning",
      "error",
    ]);
  });

  test("a page taller or shorter than live by more than two percent is a height delta with the sizes", () => {
    const f = visualFindings(
      visual(1),
      snap({ docHeight: 2000 }),
      snap({ docHeight: 2300 }),
      390,
    ).find((x) => x.code === "layout.height-delta");
    expect(f).toMatchObject({ severity: "error", live: 2000, local: 2300, viewport: 390 });
    expect(f?.message).toContain("300px taller");
    expect(
      visualFindings(visual(1), snap({ docHeight: 2000 }), snap({ docHeight: 2050 }), 1366).find(
        (x) => x.code === "layout.height-delta",
      )?.severity,
    ).toBe("warning");
    expect(
      visualFindings(visual(1), snap({ docHeight: 2000 }), snap({ docHeight: 2030 }), 1366),
    ).toEqual([]);
    expect(
      visualFindings(visual(1), snap({ docHeight: 2000 }), snap({ docHeight: 1500 }), 1366)[0]
        ?.message,
    ).toContain("shorter");
  });

  test("a page that never settled says which side it was", () => {
    const f = (live: boolean, local: boolean) =>
      visualFindings(
        visual(1),
        snap(live ? { unstable: true } : {}),
        snap(local ? { unstable: true } : {}),
        1366,
      ).find((x) => x.code === "visual.unstable");
    expect(f(true, false)?.message).toContain("the live page was");
    expect(f(false, true)?.message).toContain("the migrated page was");
    expect(f(true, true)).toMatchObject({ severity: "info", data: { live: true, local: true } });
    expect(f(true, true)?.message).toContain("both pages were");
    expect(f(false, false)).toBeUndefined();
  });

  test("a clipped screenshot says so", () => {
    expect(codes(visualFindings(visual(1), snap({ clippedAt: 16000 }), snap(), 1366))).toContain(
      "visual.truncated",
    );
  });
});

describe("pageFindings", () => {
  test("a capture that failed is an error naming the side", () => {
    const f = pageFindings(snap(), snap({ error: "navigation failed: timeout" }), resolver);
    expect(f).toEqual([
      expect.objectContaining({
        code: "page.load-failed",
        severity: "error",
        viewport: null,
        data: { side: "local" },
      }),
    ]);
    expect(pageFindings(snap({ error: "x" }), snap({ error: "y" }), resolver)).toHaveLength(2);
  });

  test("a status that differs is an error when the migrated page is a 404", () => {
    const f = pageFindings(snap(), snap({ status: 404 }), resolver);
    expect(f).toEqual([
      expect.objectContaining({ code: "page.status", severity: "error", live: 200, local: 404 }),
    ]);
  });

  test("ending somewhere else is an error, and the redirect table does not hide it: where a page ended is not redirected again", () => {
    expect(
      codes(
        pageFindings(snap({ finalUrl: `${LIVE}/a/` }), snap({ finalUrl: `${LOCAL}/b/` }), resolver),
      ),
    ).toContain("page.redirect");
    // `/old` redirects to `/new/` in the table, but live ENDED at /old/ and the migrated site at /new/: different pages.
    expect(
      codes(
        pageFindings(
          snap({ finalUrl: `${LIVE}/old/` }),
          snap({ finalUrl: `${LOCAL}/new/` }),
          resolver,
        ),
      ),
    ).toContain("page.redirect");
    expect(
      pageFindings(
        snap({ finalUrl: `${LIVE}/new/` }),
        snap({ finalUrl: `${LOCAL}/new` }),
        resolver,
      ),
    ).toEqual([]);
  });

  test("a different title is a warning, a different description or canonical a note", () => {
    const f = pageFindings(
      snap({ title: "A", description: "d", canonical: `${LIVE}/p/` }),
      snap({ title: "B", description: "e", canonical: `${LOCAL}/q/` }),
      resolver,
    );
    expect(f.map((x) => [x.code, x.severity])).toEqual([
      ["meta.title", "warning"],
      ["meta.description", "info"],
      ["meta.canonical", "info"],
    ]);
  });

  test("a migrated page that is noindex when live is not is an error; the other way, nofollow and language are told", () => {
    const f = (live: Partial<PageSnapshot>, local: Partial<PageSnapshot>) =>
      pageFindings(snap(live), snap(local), resolver).map((x) => [x.code, x.severity]);
    expect(f({ robots: "index, follow" }, { robots: "noindex, nofollow" })).toEqual([
      ["meta.robots", "error"],
    ]);
    expect(f({ robots: "noindex" }, { robots: "index, follow" })).toEqual([
      ["meta.robots", "warning"],
    ]);
    expect(f({ robots: "index, follow" }, { robots: "index, nofollow" })).toEqual([
      ["meta.robots", "warning"],
    ]);
    expect(f({ robots: "none" }, { robots: "noindex, nofollow" })).toEqual([]);
    // Rank Math's long directive list against a bare one, and an absent tag, are the same instruction.
    expect(
      f({ robots: "follow, index, max-snippet:-1, max-video-preview:-1" }, { robots: "" }),
    ).toEqual([]);
    expect(f({ lang: "en-US" }, { lang: "fr" })).toEqual([["meta.lang", "warning"]]);
    expect(f({ lang: "en-US" }, { lang: "en" })).toEqual([["meta.lang", "info"]]);
    expect(f({ lang: "EN" }, { lang: "en" })).toEqual([]);
    expect(f({ lang: "" }, { lang: "en" })).toEqual([["meta.lang", "info"]]);
  });

  test("the same head, in another origin and typography, has nothing to report", () => {
    expect(
      pageFindings(
        snap({ title: "It’s fine", canonical: `${LIVE}/p/` }),
        snap({ title: "It's fine", canonical: `${LOCAL}/p` }),
        resolver,
      ),
    ).toEqual([]);
  });
});
