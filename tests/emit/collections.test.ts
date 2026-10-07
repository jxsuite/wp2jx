/**
 * Markdown content collections (src/emit/collections.ts), over the real data of both fixture sites and
 * the real Jx: every entry is written, read back, checked against its collection's schema by the
 * loader's own validation and by Ajv, built with `jx build`, and its text held against the live page.
 *
 * The numbers asserted here are measured, and the module's header says what each one means. The
 * conversions of the bodies belong to other modules, which were still being written (the Cwicly
 * component, query and interactive converters arrived while this was), so what depends on them is
 * asserted as a bound or by property (no entry is lossy, every colon is kept), and what the collections
 * module decides itself (which posts, which files, which keys, the colon, the files' bytes) as an exact
 * value.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse } from "parse5";
import { transpileJxMarkdown } from "@jxsuite/parser";
import { loadContentSection } from "@jxsuite/parser/content-loader";
import { Markdown } from "@jxsuite/parser/markdown";
import { serializeJxMarkdown } from "@jxsuite/parser/serialize";
import { parse as parseYaml } from "yaml";
import {
  convertSubject,
  converters,
  ensureConverters,
  registerConverters,
} from "../../src/convert.ts";
import {
  autolinkable,
  buildCollections,
  canonNodes,
  degradeTemplate,
  DIRECTIVES_SWITCH,
  emptyNotes,
  entryFile,
  expectedTree,
  fitBody,
  fixText,
  frontmatterYaml,
  inlineGaps,
  itemParagraphs,
  nodesToHtml,
  readBack,
  relaxAddressFormats,
  rewriteAddresses,
  rfc3339,
  schemaProblems,
  sentinelsFor,
  sortDeep,
  tableIsNative,
  treeDiff,
  verifyFile,
  writeBody,
  type CollectionsOptions,
  type CollectionsOutput,
  type CollectionSchema,
} from "../../src/emit/collections.ts";
import { usedForms } from "../../src/emit/fluentform.ts";
import { pilotForms } from "../helpers/fluentform-db.ts";
import { collectWpClasses } from "../../src/core/block-css.ts";
import { createReport } from "../../src/report.ts";
import { acfValues, postTarget } from "../../src/wp/acf.ts";
import { buildRoutes, createUrlTools } from "../../src/routes.ts";
import { subjectCtx, type SiteContext } from "../../src/site.ts";
import { postData } from "../../src/cwicly/tokens.ts";
import { setUserProfiles } from "../../src/wp/profiles.ts";
import { AUDIO_PHP } from "../wp/lazyblocks.test.ts";
import { decodeEntities as decodeEntitiesOf } from "../../src/wp/model.ts";

/** What the paragraph of a list item or cell gives up: its spacing, and the type the theme sets on paragraphs. */
const ITEM_PARAGRAPH_STYLE = {
  margin: "0 !important",
  padding: "0 !important",
  font: "inherit !important",
  color: "inherit !important",
  textAlign: "inherit !important",
  letterSpacing: "inherit !important",
};
import type { JxElement, JxNode, WpPost } from "../../src/types.ts";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "../helpers/jx-build.ts";
import type { BuiltProject, ProjectFile } from "../helpers/jx-build.ts";
import { loadSite, type SiteName } from "../helpers/ctx.ts";
import { FIXTURES } from "../helpers/fixture-db.ts";

setDefaultTimeout(300_000);
afterAll(cleanupJxProjects);

// ── Shared fixtures ──────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-01-01T00:00:00Z");
const SITES: readonly SiteName[] = ["fineline", "ap"];

const outputs = new Map<string, Promise<CollectionsOutput>>();

/** The collections of a site, built once per process for each option set that has a name. */
function collectionsOf(
  name: SiteName,
  key = "default",
  opts: CollectionsOptions = {},
): Promise<CollectionsOutput> {
  const id = `${name}:${key}`;
  let found = outputs.get(id);
  if (!found) {
    found = loadSite(name).then((site) => buildCollections(site, { now: NOW, ...opts }));
    outputs.set(id, found);
  }
  return found;
}

/** A page that renders an entry's body in an `<article>`, for every family of entries the routes say a site has. */
function entryPages(site: SiteContext, out: CollectionsOutput): Record<string, ProjectFile> {
  const files: Record<string, ProjectFile> = {};
  for (const dp of site.routes.dynamicPages()) {
    if (dp.kind !== "entries" || !out.collections[dp.source]) continue;
    files[dp.file] = {
      $paths: dp.paths,
      title: "${state.entry.data.title}",
      state: {
        entry: {
          $prototype: "ContentEntry",
          contentType: dp.source,
          id: { $ref: `#/$params/${dp.param}` },
          $src: "@jxsuite/parser/ContentEntry.class.json",
          timing: "compiler",
        },
      },
      children: [{ tagName: "article", children: "${state.entry.$children ?? []}" }],
    };
  }
  return files;
}

function projectFiles(site: SiteContext, out: CollectionsOutput): Record<string, ProjectFile> {
  const files: Record<string, ProjectFile> = {
    "project.json": {
      name: "collections-test",
      url: "https://example.com",
      extensions: ["@jxsuite/parser"],
      defaults: { layout: "./layouts/base.json" },
      content: structuredClone(out.collections),
    },
    "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
    ...entryPages(site, out),
  };
  for (const file of out.files) files[file.path] = file.content;
  return files;
}

const built = new Map<string, Promise<BuiltProject>>();

/** The real build of every entry of a site, once per option set. */
function buildOf(
  name: SiteName,
  key = "default",
  opts: CollectionsOptions = {},
): Promise<BuiltProject> {
  const id = `${name}:${key}`;
  let found = built.get(id);
  if (!found) {
    found = (async () => {
      const site = await loadSite(name);
      const out = await collectionsOf(name, key, opts);
      return buildJxProject(projectFiles(site, out), { name: `col-${name}`, timeoutMs: 280_000 });
    })();
    built.set(id, found);
  }
  return found;
}

// ── Text of a page, compared the way a reader compares it ────────────────────────────────────────

interface P5 {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5[];
}

const attrOf = (n: P5, name: string): string | undefined =>
  n.attrs?.find((a) => a.name === name)?.value;

function findNode(n: P5, pred: (n: P5) => boolean): P5 | undefined {
  if (pred(n)) return n;
  for (const c of n.childNodes ?? []) {
    const f = findNode(c, pred);
    if (f) return f;
  }
  return undefined;
}

/** Text a reader sees: no scripts, styles, templates or an iframe's fallback; a space where a block starts or ends. */
const SKIPPED = new Set(["script", "style", "noscript", "template", "iframe"]);
const BLOCKS =
  /^(p|div|li|ul|ol|h[1-6]|blockquote|figure|figcaption|table|tr|td|th|section|article|br|hr)$/;

function textOf(n: P5, out: string[]): void {
  if (n.nodeName === "#text") {
    out.push(n.value ?? "");
    return;
  }
  if (SKIPPED.has(n.nodeName)) return;
  const block = BLOCKS.test(n.nodeName);
  if (block) out.push(" ");
  for (const c of n.childNodes ?? []) textOf(c, out);
  if (block) out.push(" ");
}

/**
 * The words of an element. What the live pages print that no migration could carry is taken out of both
 * sides: Drupal's "(link is external)" icon label (`block.icon-dropped`) and an e-mail address, which
 * Cloudflare obfuscates on the live page (`in**@****es.org`).
 */
function wordsOf(node: P5 | undefined): string[] {
  if (!node) return [];
  const out: string[] = [];
  textOf(node, out);
  return out
    .join("")
    .replaceAll(/\((?:link|email) is external\)/g, "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "" && !w.includes("@"));
}

function lcs(a: readonly string[], b: readonly string[]): number {
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** `2 * lcs / (live + built)`: 1 is the same words in the same order. */
const ratio = (a: readonly string[], b: readonly string[]): number =>
  a.length + b.length === 0 ? 1 : (2 * lcs(a, b)) / (a.length + b.length);

const squash = (words: readonly string[]): string => words.join("");

const liveElement = (site: SiteName, file: string, tag: string, cls: string): P5 | undefined => {
  const doc = parse(readFileSync(join(FIXTURES, site, "html", file), "utf8")) as unknown as P5;
  return findNode(
    doc,
    (n) => n.nodeName === tag && (attrOf(n, "class") ?? "").split(" ").includes(cls),
  );
};

const articleOf = (project: BuiltProject, route: string): P5 | undefined =>
  findNode(parse(project.html(route)) as unknown as P5, (n) => n.nodeName === "article");

// ── The body: what the serializer writes and the reader reads back ──────────────────────────────

type N = JxNode;

/** A body written the way the module writes it, and read back. */
function roundTrip(nodes: N[]) {
  const sentinels = sentinelsFor(nodes);
  const fit = fitBody(nodes, sentinels);
  const md = writeBody(fit.nodes, sentinels);
  const expected = expectedTree(fit.nodes, sentinels);
  const back = (transpileJxMarkdown(`---\nx: 1\n---\n\n${md}`).children ?? []) as N[];
  return { md, fit, expected, back, diff: treeDiff(canonNodes(expected), canonNodes(back)) };
}

/** The same nodes through the serializer and the reader as they are: the control that shows what the module is for. */
function raw(nodes: N[]) {
  const md = serializeJxMarkdown({ children: nodes }, { mode: "roundtrip", frontmatter: false });
  const back = (transpileJxMarkdown(md).children ?? []) as N[];
  return { md, back, diff: treeDiff(canonNodes(nodes), canonNodes(back)) };
}

const p = (...children: N[]): N => ({ tagName: "p", children });
const t = (tagName: string, textContent: string, more: Record<string, unknown> = {}): N =>
  ({ tagName, textContent, ...more }) as N;

describe("a colon before a digit or letter (Jx reads `3:16` as a text directive)", () => {
  const CASES: { text: string; colons: number; damaged: boolean }[] = [
    { text: "Luke 3:16 says so", colons: 1, damaged: true },
    { text: "at 12:30pm sharp", colons: 1, damaged: true },
    { text: "Matt 5:3-12; 6:1 and 7:21", colons: 3, damaged: true },
    { text: "(see 3:16)", colons: 1, damaged: true },
    { text: "é:é", colons: 1, damaged: true },
    { text: ":16 at the start", colons: 1, damaged: true },
    // The serializer escapes a colon between two ASCII letters itself, so it does not damage these.
    { text: "ratio x:y here", colons: 1, damaged: false },
    // A colon followed by a space, punctuation or the end of the text is not a directive.
    { text: "Note: this, and this:", colons: 0, damaged: false },
    { text: "http://example.org/a", colons: 0, damaged: false },
    { text: "x::1", colons: 0, damaged: false },
  ];

  for (const c of CASES) {
    test(`${JSON.stringify(c.text)}: ${c.damaged ? "damaged by the serializer, kept by the module" : "kept"}`, () => {
      const nodes = [t("p", c.text)];
      const control = raw(nodes);
      const text = (n: N[]): string => JSON.stringify(canonNodes(n));
      if (c.damaged) expect(text(control.back)).not.toBe(text(nodes));
      const mine = roundTrip(nodes);
      expect(mine.diff).toEqual([]);
      expect(text(mine.back)).toBe(text(nodes));
      expect(mine.fit.notes.colons).toBe(c.colons);
      if (c.colons > 0) expect(mine.md).toContain("\\:");
    });
  }

  test("a colon after emphasis, in a heading, a cell and a link is kept; a colon in code is code", () => {
    const nodes: N[] = [
      p(t("em", "given"), ":2 for you"),
      { tagName: "h2", children: ["Luke 2:11 ", t("em", "then:12")] },
      p({ tagName: "a", attributes: { href: "/x" }, children: ["Acts 2:38"] }),
      { tagName: "pre", children: [t("code", "a:1\nb:2")] },
      p("run ", t("code", "x:1"), " now"),
    ];
    const control = raw(nodes);
    expect(control.diff.length).toBeGreaterThan(0);
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    // The code keeps its colons as they are: nothing was escaped there.
    expect(mine.md).toContain("a:1\nb:2");
    expect(mine.md).toContain("`x:1`");
    expect(mine.fit.notes.colons).toBe(4);
  });

  test("the core converters' span around a colon is put back into the text", () => {
    const nodes: N[] = [
      p("Luke 12", { tagName: "span", textContent: ":" }, "42 and ", t("em", "x")),
    ];
    const mine = roundTrip(nodes);
    expect(mine.fit.notes.colonSpans).toBe(1);
    expect(mine.fit.notes.colons).toBe(1);
    expect(JSON.stringify(mine.expected)).not.toContain('"span"');
    expect(mine.diff).toEqual([]);
    expect(canonNodes(mine.back)).toEqual(canonNodes([p("Luke 12:42 and ", t("em", "x"))]));
  });

  test("the stand-ins are characters the body does not have", () => {
    const nodes: N[] = [t("p", "uses \u{F0A01} and \u{F0A02} already, and 3:16")];
    const s = sentinelsFor(nodes);
    expect(JSON.stringify(nodes)).not.toContain(s.colon);
    expect(JSON.stringify(nodes)).not.toContain(s.newline);
    expect(s.colon).not.toBe(s.newline);
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(JSON.stringify(mine.back)).toContain("\u{F0A01}");
    expect(() => sentinelsFor([t("p", "\u{F0A01}\u{F0A02}\u{F0A03}")])).not.toThrow();
    expect(() => sentinelsFor([t("p", "\u{F0A01}\u{F0A02}\u{F0A03}\u{F0A04}")])).toThrow(
      /private-use/,
    );
  });

  test("fixText leaves text with no colon, and a colon in code, as it is", () => {
    const s = { colon: "\u{F0A01}", newline: "\u{F0A02}" };
    const notes = emptyNotes();
    expect(fixText("plain text", s, notes)).toBe("plain text");
    expect(fixText("a:1", s, notes, { code: true })).toBe("a:1");
    expect(fixText("a:1", s, notes)).toBe("a\u{F0A01}1");
    expect(fixText("a\n\n\n\nb\n\nc", s, notes, { code: true })).toBe(
      "a\u{F0A02}\u{F0A02}\u{F0A02}\u{F0A02}b\n\nc",
    );
    expect(notes.colons).toBe(1);
    expect(notes.codeBreaks).toBe(1);
  });
});

describe("what the serializer and reader do to a body, and what the module does about it", () => {
  test("a custom property in an element's style is lost by the reader; it is moved to a rule of the element's scope", () => {
    const el = (extra: Record<string, unknown>): N => ({
      tagName: "div",
      style: {
        "--cc-gallery-height": "300px",
        display: "grid",
        "@--sm": { "--cc-gallery-height": "100px" },
      },
      textContent: "g",
      ...extra,
    });
    // Control: the reader turns `--name` into a media query and the build drops it.
    const control = raw([el({ className: "gallery-c1 cc-grid" })]);
    const style = (control.back[0] as { style?: Record<string, unknown> }).style;
    expect(style).toHaveProperty("@--cc-gallery-height", "300px");
    expect(style).not.toHaveProperty("--cc-gallery-height");

    const byClass = roundTrip([el({ className: "gallery-c1 cc-grid" })]);
    expect(byClass.diff).toEqual([]);
    expect(byClass.fit.hoisted).toEqual([
      { selector: ".gallery-c1", style: { "--cc-gallery-height": "300px" } },
    ]);
    // The responsive override is a nested key, which the reader keeps.
    expect((byClass.back[0] as { style: Record<string, unknown> }).style).toEqual({
      display: "grid",
      "@--sm": { "--cc-gallery-height": "100px" },
    });
    const byId = roundTrip([el({ id: "g", className: "other" })]);
    expect(byId.fit.hoisted[0]!.selector).toBe("#g");
    const nowhere = roundTrip([el({})]);
    expect(nowhere.fit.hoisted).toEqual([]);
    expect(nowhere.fit.notes.styleLost).toEqual(["--cc-gallery-height"]);
  });

  test("a run of three line breaks in code is collapsed by the serializer; the module keeps it", () => {
    const nodes: N[] = [
      { tagName: "pre", children: [t("code", "a\n\n\n\nb\n\nc", { className: "language-js" })] },
    ];
    expect(raw(nodes).diff.length).toBeGreaterThan(0);
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(mine.md).toContain("a\n\n\n\nb\n\nc");
    expect(mine.fit.notes.codeBreaks).toBe(1);
  });

  test("text and inline markup directly in a container sit in a paragraph, as the reader makes one", () => {
    const nodes: N[] = [
      {
        tagName: "ul",
        children: [t("li", "plain"), { tagName: "li", children: ["with ", t("em", "mark")] }],
      },
      {
        tagName: "figure",
        children: [
          { tagName: "img", attributes: { src: "/a.jpg", alt: "" } },
          t("figcaption", "caption"),
        ],
      },
      { tagName: "div", className: "box", children: ["loose ", t("strong", "text")] },
      t("blockquote", "quoted"),
      "root text",
    ];
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    // (The image alone in the figure is a directive instead: see below.)
    expect(mine.fit.notes.wrapped).toEqual({
      li: 2,
      figcaption: 1,
      div: 1,
      blockquote: 1,
      root: 1,
    });
    expect(mine.fit.notes.alone).toBe(1);
    expect(raw(nodes).diff.length).toBeGreaterThan(0);
  });

  test("an empty paragraph and the last trailing line break go (nothing is shown by either); a break that shows a blank line is a line holding a no-break space", () => {
    const nodes: N[] = [
      { tagName: "p" },
      p("kept", { tagName: "br" }),
      p("a", { tagName: "br" }, "b"),
    ];
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(mine.fit.notes.emptyBlocks).toBe(1);
    expect(mine.fit.notes.breaks).toBe(1);
    expect(mine.fit.notes.breaksKept).toBe(0);
    expect(mine.expected).toHaveLength(2);
    expect(raw(nodes).md).toContain("\\\n");

    // `<p><br></p>` and a second trailing break DO show a blank line: the live pages print them.
    const lines = roundTrip([p({ tagName: "br" }), p("a", { tagName: "br" }, { tagName: "br" })]);
    expect(lines.diff).toEqual([]);
    expect(lines.fit.notes.breaksKept).toBe(2);
    expect(lines.fit.notes.breaks).toBe(1);
    expect(lines.fit.notes.emptyBlocks).toBe(0);
    expect(lines.md).toBe("&#xA0;\n\na\\\n&#xA0;\n");
    expect(lines.back).toEqual([
      { tagName: "p", textContent: "\u00a0" },
      { tagName: "p", children: ["a", { tagName: "br" }, "\u00a0"] },
    ]);
    // Three breaks in a paragraph with nothing else are three lines; a heading is the same.
    const three = roundTrip([
      p({ tagName: "br" }, { tagName: "br" }, { tagName: "br" }),
      { tagName: "h2", children: ["T", { tagName: "br" }, { tagName: "br" }] },
    ]);
    expect(three.diff).toEqual([]);
    expect(three.fit.notes.breaksKept).toBe(4);
    expect(three.md).toContain("&#xA0;\\\n&#xA0;\\\n&#xA0;");
    // Without a character to stand in for the no-break space the lines go, as an empty paragraph does.
    const free = sentinelsFor([]);
    const bare = fitBody([p({ tagName: "br" })], { colon: free.colon, newline: free.newline });
    expect(bare.nodes).toEqual([]);
    expect(bare.notes.breaksKept).toBe(0);
    expect(bare.notes.breaks).toBe(1);
    expect(bare.notes.emptyBlocks).toBe(1);
  });

  test("a table is a Markdown table only when Markdown can say all of it", () => {
    const cell = (tag: string, text: string, attributes?: Record<string, string>): N =>
      t(tag, text, attributes ? { attributes } : {});
    const row = (...cells: N[]): N => ({ tagName: "tr", children: cells });
    const table = (head: N | undefined, body: N[], more: Record<string, unknown> = {}): N =>
      ({
        tagName: "table",
        ...more,
        children: [
          ...(head ? [{ tagName: "thead", children: [head] }] : []),
          { tagName: "tbody", children: body },
        ],
      }) as N;
    const native = table(row(cell("th", "A"), cell("th", "B")), [
      row(cell("td", "1: x"), cell("td", "2")),
    ]);
    const noHeader = table(undefined, [row(cell("td", "1"), cell("td", "2"))]);
    const span = table(row(cell("th", "A"), cell("th", "B")), [
      row(cell("td", "wide", { colspan: "2" })),
    ]);
    const classed = table(row(cell("th", "A")), [row(cell("td", "1"))], { className: "wp-table" });
    const uneven = table(row(cell("th", "A"), cell("th", "B")), [row(cell("td", "1"))]);
    const blocky = table(row(cell("th", "A")), [
      row({ tagName: "tr", children: [{ tagName: "td", children: [p("x")] }] }),
    ]);

    expect(tableIsNative(native as never)).toBe(true);
    for (const t of [noHeader, span, classed, uneven, blocky])
      expect(tableIsNative(t as never)).toBe(false);

    const a = roundTrip([native]);
    expect(a.diff).toEqual([]);
    expect(a.md).toContain("| A ");
    expect(a.fit.notes.tables).toBe(0);

    // Without the module the first row of a table with no header becomes one and a span is gone.
    expect(raw([noHeader]).diff.length).toBeGreaterThan(0);
    expect(JSON.stringify(raw([span]).back)).not.toContain("colspan");

    for (const t of [noHeader, span, classed, uneven, blocky]) {
      const mine = roundTrip([t]);
      expect(mine.diff).toEqual([]);
      expect(mine.fit.notes.tables).toBe(1);
      expect(mine.md).toContain(":::table");
    }
    // Everything the table said is still there.
    expect(JSON.stringify(roundTrip([span]).back)).toContain('"colspan":"2"');
    expect(JSON.stringify(roundTrip([classed]).back)).toContain("wp-table");
  });

  test("a list with a class, or one classed item, is a list of directives: a Markdown item inside a directive reads back as a list in a list", () => {
    const classedList: N = {
      tagName: "ul",
      className: "wp-list",
      children: [t("li", "one"), t("li", "two")],
    };
    const classedItem: N = {
      tagName: "ol",
      attributes: { start: "3" },
      children: [t("li", "x"), t("li", "y", { className: "hot" })],
    };
    expect(raw([classedList]).diff.length).toBeGreaterThan(0);
    for (const list of [classedList, classedItem]) {
      const mine = roundTrip([list]);
      expect(mine.diff).toEqual([]);
      expect(mine.fit.notes.lists).toBeGreaterThan(0);
    }
    expect(JSON.stringify(roundTrip([classedItem]).back)).toContain('"start":"3"');
    // A plain nested list stays Markdown.
    const nested = roundTrip([
      {
        tagName: "ul",
        children: [{ tagName: "li", children: ["a", { tagName: "ul", children: [t("li", "b")] }] }],
      },
    ]);
    expect(nested.diff).toEqual([]);
    expect(nested.fit.notes.lists).toBe(0);
    expect(nested.md).not.toContain(":::");
  });

  test("an image with attributes a Markdown image has no place for, a link with no address and a block in a link are directives", () => {
    const img = (attributes: Record<string, string>): N => ({ tagName: "img", attributes });
    const nodes: N[] = [
      p(img({ src: "/a.jpg", alt: "x", width: "10", height: "5", loading: "lazy" })),
      p(img({ src: "/b.jpg", alt: "plain" })),
      p("named ", { tagName: "a", children: ["anchor"] }, " here"),
      {
        tagName: "a",
        attributes: { href: "/card" },
        children: [{ tagName: "div", children: [p("a card")] }],
      },
    ];
    const control = raw(nodes);
    expect(control.diff.length).toBeGreaterThan(0);
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(mine.fit.notes.images).toBe(1);
    expect(mine.fit.notes.links).toBe(1);
    expect(mine.md).toContain("![plain](/b.jpg)");
    expect(JSON.stringify(mine.back)).toContain('"width":"10"');
  });

  test("an element's innerHTML is carried in an attribute the reader reads back as innerHTML, a Markdown tag included (it is written as a directive)", () => {
    const html = '<b>x</b> "q" & <i>y</i> &lt;b&gt; &amp;amp; &#36;{x}\n\ttab {a} \\ `t`';
    const nodes: N[] = [
      { tagName: "div", className: "raw", innerHTML: html },
      { tagName: "p", innerHTML: "<b>kept</b> &#36;{price}" },
    ];
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(mine.fit.notes.innerHtml).toBe(2);
    expect(mine.fit.notes.innerHtmlLost).toEqual([]);
    expect((mine.back[0] as { innerHTML?: string }).innerHTML).toBe(html);
    expect((mine.back[1] as { innerHTML?: string }).innerHTML).toBe("<b>kept</b> &#36;{price}");
    expect(mine.md).toContain("innerHTML=");
    expect(mine.md).not.toContain("data-wp2jx");
    // The serializer, left alone, writes no innerHTML at all.
    expect(raw([nodes[0]!]).md).not.toContain("<b>x</b>");
    expect(raw([nodes[1]!]).md).not.toContain("kept");

    // Every Markdown tag the converters give innerHTML (a literal `${` is what does it): the text stays.
    const tags = ["p", "li", "strong", "em", "code", "a", "h2", "blockquote", "td"];
    for (const tag of tags) {
      const el: N =
        tag === "a"
          ? { tagName: "a", attributes: { href: "/x/" }, innerHTML: "para &#36;{x} end" }
          : { tagName: tag, innerHTML: "para &#36;{x} end" };
      const body: N[] =
        tag === "li"
          ? [{ tagName: "ul", children: [el] }]
          : tag === "td"
            ? [
                {
                  tagName: "table",
                  children: [
                    { tagName: "thead", children: [{ tagName: "tr", children: [t("th", "h")] }] },
                    { tagName: "tbody", children: [{ tagName: "tr", children: [el] }] },
                  ],
                },
              ]
            : ["strong", "em", "code", "a"].includes(tag)
              ? [p("before ", el, " after")]
              : [el];
      const one = roundTrip(body);
      expect(JSON.stringify(one.back), tag).toContain("para &#36;{x} end");
      expect(one.fit.notes.innerHtmlLost, tag).toEqual([]);
    }

    // Only an element that holds its content both ways (children and innerHTML) cannot be carried.
    const both = roundTrip([{ tagName: "p", children: ["x"], innerHTML: "<b>lost</b>" } as N]);
    expect(both.fit.notes.innerHtmlLost).toEqual(["p"]);
  });

  test("an inline element alone in a container written as a directive is a directive too: no paragraph is made around it", () => {
    const img: N = { tagName: "img", attributes: { src: "/a.jpg", alt: "x" } };
    const link = (child: N): N => ({
      tagName: "a",
      attributes: { href: "/big.jpg" },
      children: [child],
    });
    const figure = roundTrip([{ tagName: "figure", children: [img, t("figcaption", "cap")] }]);
    expect(figure.diff).toEqual([]);
    expect(figure.fit.notes.alone).toBe(1);
    expect(figure.fit.notes.wrapped).toEqual({ figcaption: 1 });
    expect(figure.md).toContain('::img{src="/a.jpg" alt="x"}');
    // The figure's own children are the image and the caption, not a paragraph around the image.
    expect(
      (figure.back[0] as { children: { tagName: string }[] }).children.map((c) => c.tagName),
    ).toEqual(["img", "figcaption"]);
    const linked = roundTrip([{ tagName: "figure", children: [link(img)] }]);
    expect(linked.diff).toEqual([]);
    expect(
      (linked.back[0] as { children: { tagName: string }[] }).children.map((c) => c.tagName),
    ).toEqual(["a"]);
    // In a Markdown container (a list item, a quote, the page) there is a paragraph anyway.
    const native = roundTrip([
      { tagName: "ul", children: [{ tagName: "li", children: [link(img)] }] },
      img,
    ]);
    expect(native.diff).toEqual([]);
    expect(native.fit.notes.alone).toBe(0);
    expect(native.fit.notes.wrapped).toEqual({ li: 1, root: 1 });
    // Without the module the figure's image comes back inside a paragraph.
    const control = raw([{ tagName: "figure", children: [img] }]);
    expect(
      (control.back[0] as { children: { tagName: string }[] }).children.map((c) => c.tagName),
    ).toEqual(["p"]);
  });

  test("a component instance: className and id are attributes for the reader, its style moves to a rule of its class, its properties are strings", () => {
    const instance: N = {
      tagName: "wp-card",
      className: "jx-1 cs-a",
      id: "c1",
      hidden: true,
      lang: "en",
      style: { display: "contents", "@--sm": { display: "block" } },
      $props: {
        label: "Hi ${x}",
        n: 3,
        on: true,
        off: false,
        list: [1, 2],
        none: null,
        image: { src: "/a.jpg", width: 10, alt: "" },
      },
      children: [p("slot content")],
    } as N;
    // Control: the reader makes a custom element's className an attribute of that name, and the build then
    // writes the class its style scoped to beside it.
    const control = raw([instance]);
    expect((control.back[0] as { attributes: Record<string, string> }).attributes.className).toBe(
      "jx-1 cs-a",
    );
    const mine = roundTrip([instance]);
    expect(mine.diff).toEqual([]);
    const back = mine.back[0] as {
      attributes: Record<string, string>;
      style?: unknown;
      $props: unknown;
    };
    expect(back.attributes).toEqual({ class: "jx-1 cs-a", id: "c1", hidden: "", lang: "en" });
    expect(back.style).toBeUndefined();
    expect(mine.fit.hoisted).toEqual([
      { selector: "#c1", style: { display: "contents", "@--sm": { display: "block" } } },
    ]);
    expect(mine.fit.notes.scoped).toBe(1);
    // A property is the text it prints as; false, null and a list have no such form (and a null is said too).
    expect(back.$props).toEqual({
      label: "Hi $\u200b{x}",
      n: "3",
      on: "true",
      image: { src: "/a.jpg", width: "10", alt: "" },
    });
    expect(mine.fit.notes.propsStringified).toBe(3);
    expect(mine.fit.notes.propsLost).toEqual(["props.off", "props.list", "props.none"]);
    // With no class or id to scope a style by, it stays on the element: the build gives it a class of its own.
    const bare = roundTrip([{ tagName: "x-box", style: { color: "red" } } as N]);
    expect(bare.diff).toEqual([]);
    expect(bare.fit.hoisted).toEqual([]);
    expect((bare.back[0] as { style: unknown }).style).toEqual({ color: "red" });
  });

  test("an id given as an attribute is the element's own for the reader, so its style moves to its class first", () => {
    const el: N = {
      tagName: "div",
      className: "query-c1",
      attributes: { id: "query-1", "data-query_id": "1" },
      style: { color: "red" },
      textContent: "x",
    };
    const mine = roundTrip([el]);
    expect(mine.diff).toEqual([]);
    const back = mine.back[0] as {
      id?: string;
      attributes: Record<string, string>;
      style?: unknown;
    };
    expect(back.id).toBe("query-1");
    expect(back.attributes).toEqual({ "data-query_id": "1" });
    expect(back.style).toBeUndefined();
    expect(mine.fit.hoisted).toEqual([{ selector: ".query-c1", style: { color: "red" } }]);
    // Control: the reader moves the id, so the style the converters kept off `#id` is scoped to it.
    expect((raw([el]).back[0] as { id?: string }).id).toBe("query-1");
    expect(raw([el]).diff.length).toBeGreaterThan(0);
  });

  test("a Markdown element with an attribute only a directive carries is a directive; a link's and an ordered list's are left out (the core converters report them)", () => {
    const nodes: N[] = [
      { tagName: "p", attributes: { "data-a": "1" }, textContent: "para" },
      {
        tagName: "ul",
        children: [t("li", "x", { attributes: { "aria-label": "x" } }), t("li", "y")],
      },
      { tagName: "hr", attributes: { "aria-hidden": "true" } },
      p({ tagName: "a", attributes: { href: "/x", target: "_blank" }, children: ["out"] }),
    ];
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(mine.fit.notes.attributes).toBe(3);
    expect(mine.fit.notes.lists).toBe(3);
    expect(JSON.stringify(mine.back)).toContain('"data-a":"1"');
    expect(JSON.stringify(mine.back)).toContain('"aria-label":"x"');
    expect(JSON.stringify(mine.back)).not.toContain("target");
    expect(mine.fit.notes.attributesDropped).toEqual(["a:target"]);
    expect(raw(nodes).diff.length).toBeGreaterThan(0);
  });

  test("a literal dollar-brace is spelled so the build cannot evaluate it", () => {
    const mine = roundTrip([
      t("p", "costs ${state.entry.data.slug} or $5 {x}", { attributes: { title: "${x}" } }),
    ]);
    expect(mine.diff).toEqual([]);
    expect(mine.md).not.toContain("${");
    expect(mine.md).toContain("$\u200b{state.entry.data.slug}");
    expect(mine.md).toContain("$5 {x}");
    expect(mine.fit.notes.templates).toBe(1);
    expect(degradeTemplate("a ${b} ${c}")).toBe("a $\u200b{b} $\u200b{c}");
  });

  test("a link's attributes beyond its address and title, and an ordered list's, are not carried (the core converters report it)", () => {
    const mine = roundTrip([
      p({
        tagName: "a",
        attributes: { href: "/x", target: "_blank", rel: "noopener" },
        children: ["out"],
      }),
    ]);
    expect(mine.diff).toEqual([]);
    expect(JSON.stringify(mine.back)).not.toContain("target");
  });
});

describe("comparing two trees the way a browser would", () => {
  test("text content and a text child, runs of white space, a block's edges and an address that is its text are the same", () => {
    const a = canonNodes([
      { tagName: "p", textContent: "Hello   world\u00a0 " },
      p("x ", {
        tagName: "a",
        attributes: { href: "https://e.org/" },
        children: ["https://e.org/"],
      }),
    ]);
    const b = canonNodes([p("Hello world"), p("x https://e.org/")]);
    expect(a).toEqual(b);
    // A difference that shows is a difference.
    expect(treeDiff(canonNodes([p("a b")]), canonNodes([p("a  c")]))).toHaveLength(1);
    expect(treeDiff(canonNodes([p("a")]), canonNodes([p("a"), p("b")]))[0]).toMatchObject({
      kind: "children",
    });
    expect(treeDiff(canonNodes([t("h2", "a")]), canonNodes([t("h3", "a")]))[0]).toMatchObject({
      kind: "tag",
    });
    expect(
      treeDiff(
        canonNodes([{ tagName: "div", className: "a", textContent: "x" }]),
        canonNodes([{ tagName: "div", className: "b", textContent: "x" }]),
      )[0],
    ).toMatchObject({ kind: "attribute" });
    expect(
      treeDiff(
        canonNodes([{ tagName: "div", style: { color: "red" }, textContent: "x" }]),
        canonNodes([{ tagName: "div", style: { color: "blue" }, textContent: "x" }]),
      )[0],
    ).toMatchObject({ kind: "style" });
    // White space in code counts.
    expect(
      treeDiff(
        canonNodes([{ tagName: "pre", children: [t("code", "a  b")] }]),
        canonNodes([{ tagName: "pre", children: [t("code", "a b")] }]),
      ),
    ).toHaveLength(1);
  });

  test("verifyFile says what a file does not read back as", () => {
    const body: N[] = [
      {
        tagName: "table",
        children: [
          {
            tagName: "thead",
            children: [{ tagName: "tr", children: [t("th", "A"), t("th", "B")] }],
          },
          {
            tagName: "tbody",
            children: [
              { tagName: "tr", children: [t("td", "wide", { attributes: { colspan: "2" } })] },
            ],
          },
        ],
      },
    ];
    // A Markdown table, written as the serializer writes it with no regard for the span.
    const lossy = entryFile("slug: s\n", raw(body).md);
    const verdict = verifyFile(lossy, { slug: "s" }, body);
    expect(verdict.tree.length).toBeGreaterThan(0);
    expect(verdict.frontmatter).toEqual([]);
    // The module's own form is the same tree.
    const mine = roundTrip(body);
    expect(verifyFile(entryFile("slug: s\n", mine.md), { slug: "s" }, mine.expected)).toEqual({
      tree: [],
      frontmatter: [],
      gaps: [],
    });
    // A value that the YAML reader makes something else of.
    expect(verifyFile(entryFile("slug: 12345\n", ""), { slug: "12345" }, []).frontmatter).toEqual([
      "/slug",
    ]);
    expect(verifyFile(entryFile('slug: "12345"\n', ""), { slug: "12345" }, []).frontmatter).toEqual(
      [],
    );
    expect(readBack("not frontmatter\n").body).toHaveLength(1);
  });
});

describe("the space the build writes between inline siblings", () => {
  const sup = (text: string): N => t("sup", text);
  const em = (text: string): N => t("em", text);

  test("a boundary with no white space on either side is a gap; beside a space, a break or a block it is not", () => {
    const gaps = (nodes: N[]): number => inlineGaps(nodes).length;
    expect(gaps([p("20", sup("th"), " century")])).toBe(1);
    expect(
      gaps([p("see the ", { tagName: "a", attributes: { href: "/x" }, children: ["link"] }, ".")]),
    ).toBe(1);
    expect(gaps([p("a ", em("b"), " c")])).toBe(0);
    expect(gaps([p("a", { tagName: "br" }, "b")])).toBe(0);
    expect(gaps([p("a", { tagName: "img", attributes: { src: "/i.png" } }, "b")])).toBe(2);
    expect(gaps([p(em("a"), em("b"))])).toBe(1);
    expect(gaps([p("a", em(" b"))])).toBe(0);
    expect(gaps([p("a ", em("b"))])).toBe(0);
    expect(gaps([{ tagName: "div", children: [p("a"), p("b")] }])).toBe(0);
    // Inside an inline element too.
    expect(gaps([p({ tagName: "em", children: ["a", sup("1")] })])).toBe(1);
    // A no-break space is not white space the browser collapses: the build's own is added to it.
    expect(gaps([p("2", sup("1"), "\u00a0next")])).toBe(2);
    expect(inlineGaps([p("see the ", em("link"), ".")])).toEqual([{ at: "link|." }]);
  });

  test("autolinkable counts the addresses in text outside links and code", () => {
    expect(
      autolinkable([
        p("see https://a.org/x and www.b.org, mail me@c.org"),
        p({ tagName: "a", attributes: { href: "https://d.org" }, children: ["https://d.org"] }),
        p(t("code", "https://e.org")),
        { tagName: "pre", children: [t("code", "https://f.org")] },
        t("p", "plain, no address"),
      ]),
    ).toBe(3);

    // They are what the reader links: the text is read back as a link, and no spelling of the colon prevents it.
    for (const text of ["see https://a.org/x now", "see www.b.org now", "mail me@c.org now"]) {
      const control = raw([p(text)]);
      expect(JSON.stringify(control.back)).toContain('"tagName":"a"');
      expect(roundTrip([p(text)]).diff).toEqual([]);
    }
  });

  test("nodesToHtml writes inline nodes as the HTML a browser reads back, and says when it cannot", () => {
    expect(
      nodesToHtml([
        "a & <b> ",
        {
          tagName: "a",
          attributes: { href: "/x?a=1&b=2", title: 'say "hi"' },
          className: "k",
          children: ["link"],
        },
        { tagName: "br" },
        { tagName: "img", attributes: { src: "/i.png", alt: "" } },
        { tagName: "span", id: "s", style: { fontSize: "12px", "--x": "1" }, textContent: "x" },
      ]),
    ).toBe(
      'a &amp; &lt;b&gt; <a href="/x?a=1&amp;b=2" title="say &quot;hi&quot;" class="k">link</a><br><img src="/i.png" alt><span id="s" style="font-size: 12px; --x: 1">x</span>',
    );
    expect(
      nodesToHtml([{ tagName: "span", style: { ":hover": { color: "red" } }, textContent: "x" }]),
    ).toBeUndefined();
    expect(nodesToHtml([{ tagName: "x-card", $props: { a: 1 } } as never])).toBeUndefined();
  });
});

describe("the file", () => {
  test("keys are sorted at every depth and undefined is gone", () => {
    const sorted = sortDeep({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined, B: 3 }, u: undefined });
    expect(JSON.stringify(sorted)).toBe('{"a":{"B":3,"d":[{"y":2,"z":1}]},"b":1}');
  });

  test("a string that the reader would take for something else is quoted, and every string reads back as it was", () => {
    const tricky = [
      "2024-02-15",
      "2024-02-15T17:30:00Z",
      "1_000",
      "0x1F",
      "1e3",
      ".5",
      "+1",
      "-x",
      "12:30",
      "true",
      "No",
      "null",
      "~",
      "<<",
      "=",
      "",
      " lead",
      "trail ",
      "multi\nline",
      "line one \nline two",
      "para\n\n\nthree",
      "blank\n \nline",
      "x\n",
      "# not a comment",
      "a: b",
      "- item",
      "[x]",
      "{x}",
      "'q' \"d\"",
      "tab\there",
      "unicode \u2028 sep",
      "emoji \u{1F600}",
      "long ".repeat(60),
    ];
    const data = {
      slug: "s",
      values: tricky,
      nested: { first: tricky[0], rows: tricky.map((v) => ({ v })) },
    };
    for (const quoted of [false, true]) {
      const file = entryFile(frontmatterYaml(data, quoted), "");
      expect(readBack(file).frontmatter).toEqual(sortDeep(data) as Record<string, unknown>);
    }
    const yaml = frontmatterYaml({ date: "2024-02-15T17:30:00Z", n: "1_000", plain: "plain text" });
    expect(yaml).toContain('date: "2024-02-15T17:30:00Z"');
    expect(yaml).toContain('n: "1_000"');
    expect(yaml).toContain("plain: plain text");
    // Long text stays on one line and keeps a block scalar's readability where it can.
    expect(frontmatterYaml({ s: "long ".repeat(60) }).split("\n")).toHaveLength(2);
    expect(parseYaml(frontmatterYaml({ s: "a\nb" }))).toEqual({ s: "a\nb" });
  });

  test("an entry file is frontmatter, a blank line and the body; an entry with no body is the frontmatter alone", () => {
    expect(entryFile("a: 1\n", "text\n")).toBe("---\na: 1\n---\n\ntext\n");
    expect(entryFile("a: 1\n", "")).toBe("---\na: 1\n---\n");
  });

  test("a date is RFC 3339 in UTC with no fraction, and nothing else is one", () => {
    expect(rfc3339("2024-02-15T17:30:00.000Z")).toBe("2024-02-15T17:30:00Z");
    expect(rfc3339("2024-02-15T19:30:00+02:00")).toBe("2024-02-15T17:30:00Z");
    expect(rfc3339("not a date")).toBeUndefined();
    expect(rfc3339("")).toBeUndefined();
  });

  test("schemaProblems reads a schema the way the loader does: required, type and date format", () => {
    const schema: CollectionSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        n: { type: "integer" },
        tags: { type: "array" },
        flag: { type: "boolean" },
        either: { type: ["string", "number"] },
        date: { type: "string", format: "date-time" },
        day: { type: "string", format: "date" },
        free: {},
      },
      required: ["title", "slug"],
    };
    expect(
      schemaProblems(
        {
          title: "t",
          slug: "s",
          n: 1,
          tags: [],
          flag: true,
          either: 2,
          date: "2024-02-15T17:30:00Z",
          day: "2024-02-15",
          free: {},
        },
        schema,
      ),
    ).toEqual([]);
    expect(schemaProblems({ title: null }, schema)).toEqual([
      'missing required field "title"',
      'missing required field "slug"',
    ]);
    expect(
      schemaProblems(
        { title: "t", slug: "s", n: 1.5, tags: "x", flag: "yes", either: true },
        schema,
      ),
    ).toEqual([
      'field "n" expected integer, got number',
      'field "tags" expected array, got string',
      'field "flag" expected boolean, got string',
      'field "either" expected string|number, got boolean',
    ]);
    expect(
      schemaProblems(
        { title: "t", slug: "s", date: "yesterday", day: "2024-02-15T00:00:00Z" },
        schema,
      ),
    ).toEqual([
      'field "date" is declared date-time but "yesterday" is not RFC 3339',
      'field "day" is declared date but "2024-02-15T00:00:00Z" is not YYYY-MM-DD',
    ]);
  });
});

// ── The real Jx build of bodies written by the module ───────────────────────────────────────────

describe("the Jx build of synthetic bodies, against the same bodies written without the module", () => {
  interface Case {
    nodes: N[];
    /** Written with `inlineGaps: "innerHTML"`. */
    html?: boolean;
  }
  const grid = (extra: Record<string, unknown>): N => ({
    tagName: "div",
    className: "g1 cc-grid",
    style: {
      "--cc-gallery-height": "300px",
      display: "grid",
      "@--sm": { "--cc-gallery-height": "100px" },
    },
    textContent: "gallery",
    ...extra,
  });
  const CASES: Record<string, Case> = {
    colons: {
      nodes: [
        p("Luke 3:16 and 12:30pm, and (Acts 2:38), x:y"),
        { tagName: "h2", textContent: "John 3:16" },
        { tagName: "ul", children: [t("li", "Rom 8:1")] },
        p(t("em", "given"), ":2 for you"),
      ],
    },
    template: { nodes: [p("costs ${state.entry.data.slug} here")] },
    gaps: {
      nodes: [
        p("It was the 20", t("sup", "th"), " century", t("sup", "1"), "."),
        p(
          "See the ",
          { tagName: "a", attributes: { href: "/x" }, children: ["link"] },
          ", and then ",
          t("em", "this"),
          "!",
        ),
        p("no gap ", t("em", "here"), " at all"),
      ],
    },
    gapsHtml: {
      nodes: [
        p("It was the 20", t("sup", "th"), " century", t("sup", "1"), "."),
        p(
          "See the ",
          { tagName: "a", attributes: { href: "/x" }, children: ["link"] },
          ", and then ",
          t("em", "this"),
          "!",
        ),
        p("no gap ", t("em", "here"), " at all"),
      ],
      html: true,
    },
    hoist: { nodes: [grid({})] },
    code: { nodes: [{ tagName: "pre", children: [t("code", "one\n\n\n\ntwo\nthree:4")] }] },
    structure: {
      nodes: [
        { tagName: "ul", className: "wp-list", children: [t("li", "a"), t("li", "b")] },
        {
          tagName: "table",
          children: [
            {
              tagName: "tbody",
              children: [
                { tagName: "tr", children: [t("td", "wide", { attributes: { colspan: "2" } })] },
                { tagName: "tr", children: [t("td", "x"), t("td", "y")] },
              ],
            },
          ],
        },
        p({
          tagName: "img",
          attributes: { src: "/media/a.jpg", alt: "pic", width: "40", height: "30" },
        }),
      ],
    },
  };

  const synth = (() => {
    let run:
      | Promise<{ project: BuiltProject; hoisted: Record<string, Record<string, unknown>> }>
      | undefined;
    return () =>
      (run ??= (async () => {
        const files: Record<string, ProjectFile> = {
          "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
          "pages/e/[slug].json": {
            $paths: { contentType: "items", param: "slug", field: "slug" },
            title: "${state.entry.data.title}",
            state: {
              entry: {
                $prototype: "ContentEntry",
                contentType: "items",
                field: "slug",
                id: { $ref: "#/$params/slug" },
                $src: "@jxsuite/parser/ContentEntry.class.json",
                timing: "compiler",
              },
            },
            children: [{ tagName: "article", children: "${state.entry.$children ?? []}" }],
          },
        };
        const hoisted: Record<string, Record<string, unknown>> = {};
        for (const [name, c] of Object.entries(CASES)) {
          const sentinels = sentinelsFor(c.nodes);
          const fit = fitBody(c.nodes, sentinels, c.html ? "innerHTML" : "report");
          for (const rule of fit.hoisted) hoisted[rule.selector] = rule.style;
          files[`content/items/${name}.md`] = entryFile(
            frontmatterYaml({ title: name, slug: name }),
            writeBody(fit.nodes, sentinels),
          );
          // The same body through the serializer as it is (with another class, so that the rule the
          // module hoisted for the first does not reach it).
          const control = JSON.parse(JSON.stringify(c.nodes).replaceAll("g1", "g2")) as N[];
          files[`content/items/raw-${name}.md`] = entryFile(
            frontmatterYaml({ title: `raw ${name}`, slug: `raw-${name}` }),
            serializeJxMarkdown({ children: control }, { mode: "roundtrip", frontmatter: false }),
          );
        }
        files["project.json"] = {
          name: "synthetic",
          url: "https://example.com",
          extensions: ["@jxsuite/parser"],
          defaults: { layout: "./layouts/base.json" },
          $media: { "--": "1366px", "--sm": "(max-width: 576px)" },
          style: hoisted,
          content: {
            items: {
              source: "content/items",
              format: "Markdown",
              $elements: [DIRECTIVES_SWITCH],
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
          },
        };
        return { project: await buildJxProject(files, { name: "synthetic" }), hoisted };
      })());
  })();

  const articleText = async (name: string): Promise<string> => {
    const { project } = await synth();
    return wordsOf(articleOf(project, `/e/${name}/`)).join(" ");
  };
  const articleHtml = async (name: string): Promise<string> => {
    const { project } = await synth();
    return /<article>[\s\S]*<\/article>/.exec(project.html(`/e/${name}/`))![0];
  };

  test("a colon before a digit prints as the colon; without the module the digits are lost", async () => {
    expect(await articleText("colons")).toBe(
      // (The gap before ":2" is the inline-gap bug, below, and shows the colon is there.)
      "Luke 3:16 and 12:30pm, and (Acts 2:38), x:y John 3:16 Rom 8:1 given :2 for you",
    );
    const damaged = await articleText("raw-colons");
    expect(damaged).not.toContain("3:16");
    expect(await articleHtml("raw-colons")).toMatch(/<16>|<30pm>|<38>/);
    expect(await articleHtml("colons")).not.toMatch(/<\d/);
  });

  test("a literal dollar-brace prints literally; written as it is, the build evaluates it", async () => {
    expect(await articleText("template")).toBe("costs $\u200b{state.entry.data.slug} here");
    expect(await articleText("raw-template")).toBe("costs raw-template here");
  });

  test("the gap the build writes between inline siblings is the one inlineGaps counts; innerHTML paragraphs have none", async () => {
    const intended = "It was the 20th century1. See the link, and then this! no gap here at all";
    const nodes = CASES.gaps!.nodes;
    const predicted = inlineGaps(nodes).length;
    expect(predicted).toBe(5);
    const measured = await articleText("gaps");
    // Each boundary the build wrote adds one space to the text; the paragraphs are separated by one.
    expect(measured.length - intended.length).toBe(predicted);
    expect(measured).toContain("20 th century 1 .");
    expect(measured).toContain("link , and then this !");
    expect(await articleText("gapsHtml")).toBe(intended);
    expect(await articleHtml("gapsHtml")).toContain("<sup>th</sup>");
    expect(await articleHtml("gapsHtml")).not.toContain("<p>It was the 20\n");
  });

  test("a custom property reaches the page as a rule of the element's class, and the responsive override keeps working", async () => {
    const { project, hoisted } = await synth();
    expect(hoisted).toEqual({ ".g1": { "--cc-gallery-height": "300px" } });
    const css = project
      .html("/e/hoist/")
      .match(/<style>[\s\S]*?<\/style>/g)!
      .join("\n");
    expect(css).toMatch(/\.g1 \{ --cc-gallery-height: 300px \}/);
    expect(css).toMatch(/@media \(max-width: 576px\) \{ \.g1 \{ --cc-gallery-height: 100px \} \}/);
    expect(css).toMatch(/\.g1 \{ display: grid \}/);
    // Without the module the page never has the base value.
    expect(project.html("/e/raw-hoist/")).not.toMatch(/\.g2 \{ --cc-gallery-height: 300px \}/);
    expect(project.html("/e/raw-hoist/")).toContain("g2 cc-grid");
  });

  test("code keeps its blank lines", async () => {
    expect(await articleHtml("code")).toContain("one\n\n\n\ntwo\nthree:4");
    expect(await articleHtml("raw-code")).not.toContain("one\n\n\n\ntwo");
  });

  test("a class on a list, a colspan and an image's attributes are all on the page", async () => {
    const html = await articleHtml("structure");
    expect(html).toContain('<ul class="wp-list">');
    expect(html).not.toMatch(/<ul[^>]*>\s*<ul/);
    expect(html).toMatch(/<td colspan="2">/);
    expect(html).toMatch(
      /<img[^>]*src="\/media\/a\.jpg"[^>]*width="40"[^>]*height="30"|<img[^>]*width="40"[^>]*src="\/media\/a\.jpg"/,
    );
    const control = await articleHtml("raw-structure");
    expect(control).not.toContain("colspan");
    expect(control).toContain('<ul class="wp-list"><ul>');
  });
});

// ── Both fixture sites ───────────────────────────────────────────────────────────────────────────

/** What the sites hold, which is what the collections module decides about: exact. */
const EXPECTED = {
  fineline: {
    collections: { post: 11, project: 82, service: 19 },
    excluded: ["project:draft:7", "project:private:2", "service:draft:1"],
    unrouted: ["grw_feed:6", "igmap:1", "wpcb_snippet_post:1"],
    // the eight before and after sliders are drawn now (`icb/image-compare`); what is left is a shortcode
    placeholders: { min: 1 },
    colonEntries: 0,
    colons: 0,
    autolinked: { entries: 0, addresses: 0 },
  },
  ap: {
    collections: { episode: 98, post: 97, supporters_update: 13 },
    excluded: [
      "captivate_podcast:draft:3",
      "episode:draft:2",
      "fc_template:draft:1",
      "fcrm-dummy:draft:1",
      "post:draft:3",
      "rm_content_editor:draft:1",
      "supporters_update:draft:1",
      "uip-ui-template:draft:1",
    ],
    unrouted: [
      "captivate_podcast:97",
      "give_pdf_template:6",
      "uip-admin-page:1",
      "uip-ui-template:1",
      "uipress_admin_menu:1",
    ],
    placeholders: { min: 1 },
    colonEntries: 64,
    colons: 467,
    autolinked: { entries: 10, addresses: 15 },
  },
} as const;

const reportOf = (out: CollectionsOutput, code: string) =>
  out.report.entries().filter((e) => e.code === code);

/** Write the project and load its content the way the build does, with the loader's warnings collected. */
async function loadWithJx(site: SiteContext, out: CollectionsOutput) {
  const { writeJxProject } = await import("../helpers/jx-build.ts");
  const dir = writeJxProject(projectFiles(site, out), { name: "loader" });
  const format = {
    name: "Markdown",
    remote: false,
    capabilities: { discover: true },
    call: (capability: string, ...args: unknown[]): unknown =>
      capability === "discover"
        ? Markdown.discover(...(args as [string, { baseDir?: string }]))
        : Markdown.load(...(args as [string, never])),
  };
  const registry = {
    byName: (n: string) => (n === "Markdown" ? format : undefined),
    byExtension: () => format,
  };
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]): void => void warnings.push(a.join(" "));
  try {
    const loaded = await loadContentSection(
      out.collections as never,
      dir,
      registry as never,
      {
        content: out.collections,
      } as never,
    );
    return { loaded, warnings };
  } finally {
    console.warn = warn;
  }
}

for (const name of SITES) {
  describe(`${name}: the collections`, () => {
    const expected = EXPECTED[name];

    test("one entry for every published, routed post, at the route's file, in order", async () => {
      const site = await loadSite(name);
      const out = await collectionsOf(name);
      const counts: Record<string, number> = {};
      for (const e of out.entries) counts[e.collection] = (counts[e.collection] ?? 0) + 1;
      expect(counts).toEqual(expected.collections);
      expect(Object.keys(out.collections)).toEqual(Object.keys(expected.collections));
      expect(out.files.map((f) => f.path)).toEqual(out.entries.map((e) => e.file));
      expect(new Set(out.files.map((f) => f.path)).size).toBe(out.files.length);
      const ordered = out.entries.map((e) => `${e.collection}/${e.id}`);
      expect(ordered).toEqual(ordered.toSorted());
      const routes = site.routes.all().filter((r) => r.kind === "entry");
      expect(out.entries.map((e) => e.postId).sort((a, b) => a - b)).toEqual(
        routes.map((r) => Number(r.id)).sort((a, b) => a - b),
      );
      for (const e of out.entries) {
        const route = site.routes.forPost(e.postId)!;
        expect(e.file).toBe(route.file);
        expect(e.file).toBe(`content/${e.collection}/${e.id}.md`);
        expect(e.route).toBe(route.jxRoute);
        expect(site.model.posts.get(e.postId)!.status).toBe("publish");
      }
    });

    test("drafts, private posts and the types no route knows are reported and left out", async () => {
      const site = await loadSite(name);
      const out = await collectionsOf(name);
      const excluded = reportOf(out, "collection.excluded").map(
        (e) => `${e.data!.type}:${e.data!.status}:${e.data!.count}`,
      );
      expect(excluded.sort()).toEqual([...expected.excluded].sort());
      const unrouted = reportOf(out, "collection.unrouted").map(
        (e) => `${e.data!.type}:${e.data!.count}`,
      );
      expect(unrouted.sort()).toEqual([...expected.unrouted].sort());
      const ids = new Set(out.entries.map((e) => e.postId));
      for (const e of reportOf(out, "collection.excluded")) {
        for (const id of e.data!.ids as number[]) {
          expect(ids.has(id)).toBe(false);
          expect(site.model.posts.get(id)!.status).toBe(e.data!.status as string);
        }
        expect(e.severity).toBe("info");
      }
      for (const e of reportOf(out, "collection.unrouted")) {
        expect(e.severity).toBe("warn");
        expect(Object.keys(out.collections)).not.toContain(e.data!.type as string);
      }
      for (const code of [
        "collection.no-route",
        "collection.protected",
        "collection.duplicate-file",
        "entry.date-invalid",
        "entry.seo-failed",
      ]) {
        expect(reportOf(out, code)).toEqual([]);
      }
      // No draft, private or pending post has a file.
      for (const post of site.model.posts.values()) {
        if (post.status !== "publish") expect(ids.has(post.id)).toBe(false);
      }
    });

    test("the frontmatter is the Entry data contract: postData, with the dates in UTC, authorUrl and seo", async () => {
      const site = await loadSite(name);
      const out = await collectionsOf(name);
      for (const e of out.entries) {
        const post = site.model.posts.get(e.postId) as WpPost;
        const ctx = await subjectCtx(site, { kind: "post", id: post.id }, { target: "markdown" });
        const data = postData(ctx, post);
        const fm = e.frontmatter;
        // The keys every template binds.
        expect(fm.title).toBe(data.title);
        expect(fm.slug).toBe(post.slug);
        expect(fm.excerpt).toBe(data.excerpt);
        expect(fm.hasExcerpt).toBe(data.hasExcerpt);
        expect(fm.url).toBe(e.route);
        expect(fm.terms).toEqual(data.terms);
        expect(fm.author).toBe(data.author);
        expect(fm.featuredImage).toEqual(data.featuredImage);
        expect(fm.authorUrl).toBe(site.urls.urlForAuthor(post.authorId));
        // A list of several types asks every entry what it is.
        expect(fm.postType).toBe(post.type);
        expect(fm.date).toBe(rfc3339(post.date));
        expect(fm.modified).toBe(rfc3339(post.modified));
        expect(fm.date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
        expect(fm.modified).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
        // (Not toMatchObject with expect.any: Bun writes the matcher over the value it matched.)
        const seo = fm.seo as { title: unknown; description: unknown; robots: unknown };
        expect([typeof seo.title, typeof seo.description, typeof seo.robots]).toEqual([
          "string",
          "string",
          "string",
        ]);
        // Everything else postData has (the ACF fields) is there, unchanged.
        const acf = Object.keys(data).filter(
          (k) =>
            ![
              "title",
              "slug",
              "date",
              "modified",
              "excerpt",
              "hasExcerpt",
              "author",
              "url",
              "featuredImage",
              "terms",
            ].includes(k),
        );
        // (The addresses in an ACF value are the routes and /media paths of the Jx site.)
        for (const k of acf) expect(fm[k]).toEqual(rewriteAddresses(data[k], ctx.rewriteUrl));
        expect(
          Object.keys(fm).every(
            (k) =>
              acf.includes(k) ||
              [
                "title",
                "slug",
                "date",
                "modified",
                "excerpt",
                "hasExcerpt",
                "author",
                "authorUrl",
                "url",
                "featuredImage",
                "terms",
                "seo",
                "postType",
              ].includes(k),
          ),
        ).toBe(true);
        // The titles and excerpts are what WordPress prints: texturized.
        expect(fm.title).not.toMatch(/[\u0027\u0022]/);
      }
    });

    test("every key of every object is in order, and the file says the same", async () => {
      const out = await collectionsOf(name);
      for (const [i, e] of out.entries.entries()) {
        expect(JSON.stringify(e.frontmatter)).toBe(JSON.stringify(sortDeep(e.frontmatter)));
        const text = out.files[i]!.content;
        expect(text.startsWith("---\n")).toBe(true);
        const yaml = text.slice(4, text.indexOf("\n---\n"));
        const keys = Object.keys(parseYaml(yaml) as Record<string, unknown>);
        expect(keys).toEqual([...keys].sort());
      }
    });

    test("media are public /media paths, and an address of the site that is left is one the report says it could not resolve", async () => {
      const site = await loadSite(name);
      const out = await collectionsOf(name);
      const isMedia = (v: unknown): boolean => typeof v === "string" && v.startsWith("/media/");
      let images = 0;
      for (const e of out.entries) {
        const fm = e.frontmatter as {
          featuredImage?: { src: string };
          seo?: { image?: { src: string } };
        };
        if (fm.featuredImage) {
          images++;
          expect(isMedia(fm.featuredImage.src)).toBe(true);
        }
        // (A Rank Math image of the old Drupal site is an address no attachment accounts for: reported below.)
        if (fm.seo?.image && !isMedia(fm.seo.image.src)) {
          expect(fm.seo.image.src).toMatch(/\/sites\/[^?#]*\/files\//);
        }
      }
      expect(images).toBeGreaterThan(out.entries.length / 2);

      const hosts = [site.model.site.url, site.model.site.home, site.media.uploadsBase].map((u) =>
        u.replace(/\/$/, ""),
      );
      const bare = (u: string): string =>
        u
          .replace(/&amp;/g, "&")
          .replace(/[?#].*$/, "")
          .replace(/\/$/, "");
      const unresolved = new Map<number, Set<string>>();
      for (const r of reportOf(out, "url.unresolved")) {
        const id = Number(String(r.where).replace("post:", ""));
        (unresolved.get(id) ?? unresolved.set(id, new Set()).get(id)!).add(
          bare(String(r.data!.url)),
        );
      }
      const strings = (v: unknown, into: string[] = []): string[] => {
        if (typeof v === "string") into.push(v);
        else if (Array.isArray(v)) for (const x of v) strings(x, into);
        else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, into);
        return into;
      };
      let left = 0;
      for (const [i, e] of out.entries.entries()) {
        const content = out.files[i]!.content;
        const body = content.slice(content.indexOf("\n---\n", 4) + 5);
        // The targets of links and images in the body, and of the addresses and markup in the data.
        const found = [...body.matchAll(/(?:\]\(|\bsrc="|\bhref="|<)(https?:\/\/[^)"\s>]+)/g)].map(
          (m) => m[1]!,
        );
        for (const text of strings(e.frontmatter)) {
          if (/^https?:\/\/\S+$/.test(text)) found.push(text);
          else
            found.push(
              ...[...text.matchAll(/\b(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!),
            );
        }
        for (const address of found) {
          if (!hosts.some((h) => address.startsWith(h))) continue;
          left++;
          expect([e.postId, address, unresolved.get(e.postId)?.has(bare(address))]).toEqual([
            e.postId,
            address,
            true,
          ]);
        }
      }
      // An internal address that has a route is not left: the rewritten ones are routes and /media paths.
      const rewritten = out.files.filter(
        (f) => /\]\(\/[a-z]/.test(f.content) || /href="\/[a-z]/.test(f.content),
      );
      expect(rewritten.length).toBeGreaterThan(0);
    });

    test("every entry reads back as written, and the report says so", async () => {
      const out = await collectionsOf(name);
      expect(reportOf(out, "md.lossy")).toEqual([]);
      expect(reportOf(out, "md.frontmatter-mismatch")).toEqual([]);
      expect(reportOf(out, "md.style-lost")).toEqual([]);
      expect(reportOf(out, "md.innerhtml-lost")).toEqual([]);
      expect(
        out.report
          .entries()
          .filter((e) => e.severity === "error" && /^(md|entry|collection)\./.test(e.code)),
      ).toEqual([]);
      // An independent read: the frontmatter of the file is the entry's, and the gaps found in the tree
      // read back are the ones the report counts for the tree written.
      let boundaries = 0;
      let withGaps = 0;
      for (const [i, e] of out.entries.entries()) {
        const back = readBack(out.files[i]!.content);
        expect(back.frontmatter).toEqual(sortDeep(e.frontmatter) as Record<string, unknown>);
        const gaps = inlineGaps(back.body).length;
        boundaries += gaps;
        if (gaps > 0) withGaps++;
      }
      const gapReports = reportOf(out, "block.inline-gap");
      expect(gapReports.length).toBe(withGaps);
      expect(gapReports.reduce((n, e) => n + (e.data!.boundaries as number), 0)).toBe(boundaries);
      for (const r of gapReports) expect(r.severity).toBe("warn");
      const linked = reportOf(out, "md.autolinked");
      expect([
        linked.length,
        linked.reduce((n, r) => n + (r.data!.addresses as number), 0),
      ]).toEqual([expected.autolinked.entries, expected.autolinked.addresses]);
      for (const r of linked) expect(r.severity).toBe("info");
      // The converters' own versions are replaced by the module's count.
      expect(reportOf(out, "block.text-directive")).toEqual([]);
    });

    test("a placeholder has nothing to be in a Markdown entry: it is left out, and said", async () => {
      const out = await collectionsOf(name);
      const dropped = reportOf(out, "entry.placeholder-dropped");
      expect(dropped.length).toBeGreaterThanOrEqual(expected.placeholders.min);
      for (const d of dropped) {
        expect(d.severity).toBe("warn");
        expect(d.data!.tag).toMatch(/^wp2jx-/);
      }
      for (const f of out.files) expect(f.content).not.toContain("wp2jx-");
    });

    test("the schema holds every entry, by the loader's own check and by Ajv", async () => {
      const site = await loadSite(name);
      const out = await collectionsOf(name);
      expect(reportOf(out, "entry.schema-invalid")).toEqual([]);
      for (const e of out.entries) {
        expect(schemaProblems(e.frontmatter, out.collections[e.collection]!.schema)).toEqual([]);
      }
      // The collections' own shape.
      for (const [coll, def] of Object.entries(out.collections)) {
        expect(def.source).toBe(`content/${coll}`);
        expect(def.format).toBe("Markdown");
        expect(def.schema.type).toBe("object");
        expect(def.schema.required).toEqual(expect.arrayContaining(["title", "slug"]));
        for (const key of [
          "title",
          "slug",
          "date",
          "modified",
          "excerpt",
          "author",
          "authorUrl",
          "url",
          "featuredImage",
          "terms",
          "seo",
          "hasExcerpt",
        ]) {
          expect(def.schema.properties).toHaveProperty(key);
        }
        expect(def.schema.properties.date).toMatchObject({ type: "string", format: "date-time" });
        const keys = Object.keys(def.schema.properties);
        expect(keys).toEqual(keys.toSorted());
      }
      // Ajv, with the formats: every entry's data, as the loader hands it to the build.
      const { loaded, warnings } = await loadWithJx(site, out);
      expect(warnings).toEqual([]);
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      addFormats(ajv);
      let checked = 0;
      for (const [coll, def] of Object.entries(out.collections)) {
        const validate = ajv.compile(def.schema);
        const entries = loaded.get(coll)!;
        expect(entries.length).toBe(
          expected.collections[coll as keyof typeof expected.collections],
        );
        for (const entry of entries) {
          const ok = validate(entry.data);
          expect(ok ? [] : validate.errors).toEqual([]);
          checked++;
        }
      }
      expect(checked).toBe(out.entries.length);
      // The id the build gives each file is the one the routes gave the entry.
      for (const e of out.entries) {
        expect(loaded.get(e.collection)!.some((entry) => entry.id === e.id)).toBe(true);
      }
    });

    test("jx validate accepts the project, and jx build writes a page for every entry with nothing to say", async () => {
      const project = await buildOf(name);
      const out = await collectionsOf(name);
      const v = await validateJxProject(project.dir);
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
      expect(project.code).toBe(0);
      expect(`${project.stdout}${project.stderr}`).not.toMatch(
        /Content (validation|dates|relationships)|warning/i,
      );
      for (const e of out.entries)
        expect(project.exists(`${e.route.replace(/^\/|\/$/g, "")}/index.html`)).toBe(true);
    });

    test("the same site writes the same bytes", async () => {
      const site = await loadSite(name);
      const a = await collectionsOf(name);
      const b = await buildCollections(site, { now: NOW });
      expect(b.files).toEqual(a.files);
      expect(b.entries).toEqual(a.entries);
      expect(b.collections).toEqual(a.collections);
      expect(JSON.stringify(b.report.entries())).toBe(JSON.stringify(a.report.entries()));
      expect([...b.used.components]).toEqual([...a.used.components]);
      expect([...b.used.wpClasses].sort()).toEqual([...a.used.wpClasses].sort());
      expect(b.used.hoisted).toEqual(a.used.hoisted);
    });
  });
}

// ── The live pages ───────────────────────────────────────────────────────────────────────────────

describe("the built entries against the live pages in the fixtures", () => {
  const ESSAYS = [
    "keeshons-story-a-knock-heard-round-the-hood-part-3",
    "the-cultural-captivity-of-the-gospel",
    "the-way-we-live-is-the-way-we-educate",
  ];

  interface Match {
    live: string[];
    built: string[];
    ratio: number;
    squashed: boolean;
    boundaries: number;
  }

  async function essayMatch(slug: string, key: string, opts: CollectionsOptions): Promise<Match> {
    const out = await collectionsOf("ap", key, opts);
    const project = await buildOf("ap", key, opts);
    const entry = out.entries.find((e) => e.collection === "post" && e.id === slug)!;
    const live = wordsOf(liveElement("ap", `essays__${slug}.html`, "div", "content-essay"));
    const built = wordsOf(articleOf(project, entry.route));
    const gap = reportOf(out, "block.inline-gap").find((r) => r.where === `post:${entry.postId}`);
    return {
      live,
      built,
      ratio: ratio(live, built),
      squashed: squash(live) === squash(built),
      boundaries: (gap?.data?.boundaries as number | undefined) ?? 0,
    };
  }

  test("anabaptistperspectives essays: the text is the live page's, but for a space at each inline gap", async () => {
    for (const slug of ESSAYS) {
      const m = await essayMatch(slug, "default", {});
      // The same words in the same order once the space the build adds is not counted.
      expect([slug, m.squashed]).toEqual([slug, true]);
      expect(m.ratio).toBeGreaterThan(0.995);
      expect(m.ratio).toBeLessThan(1);
      // Each gap splits at most one word, and the report counted them.
      expect(m.built.length).toBeGreaterThan(m.live.length);
      expect(m.built.length - m.live.length).toBeLessThanOrEqual(m.boundaries);
    }
  });

  test("with inlineGaps: innerHTML the same essays match the live words one for one", async () => {
    for (const slug of ESSAYS) {
      const m = await essayMatch(slug, "html", { inlineGaps: "innerHTML" });
      expect([slug, m.squashed]).toEqual([slug, true]);
      expect(m.built).toEqual(m.live);
    }
    const out = await collectionsOf("ap", "html", { inlineGaps: "innerHTML" });
    const plain = await collectionsOf("ap");
    const bodyOf = (text: string): string => text.slice(text.indexOf("\n---\n", 4));
    const html = out.files.filter((f) => bodyOf(f.content).includes("innerHTML="));
    expect(html.length).toBeGreaterThan(
      plain.files.filter((f) => bodyOf(f.content).includes("innerHTML=")).length,
    );
    // Fewer boundaries are left (headings and other containers have no such form), and nothing is lossy.
    const left = (o: CollectionsOutput): number =>
      reportOf(o, "block.inline-gap").reduce((n, r) => n + (r.data!.boundaries as number), 0);
    expect(left(out)).toBeLessThan(left(plain) / 10);
    expect(reportOf(out, "md.lossy")).toEqual([]);
    expect(reportOf(out, "md.frontmatter-mismatch")).toEqual([]);
    // The paragraphs are HTML in an attribute: the report says how many.
    const normalized = reportOf(out, "md.normalized");
    expect(normalized.some((r) => (r.data!.paragraphsAsInnerHtml as number) > 0)).toBe(true);
  });

  test("finelinepainting post: every word built is on the live page; what is missing is what other converters build", async () => {
    const out = await collectionsOf("fineline");
    const project = await buildOf("fineline");
    const entry = out.entries.find(
      (e) => e.collection === "post" && e.id === "choosing-the-best-log-home-stain",
    )!;
    const live = wordsOf(
      liveElement("fineline", "choosing-the-best-log-home-stain.html", "article", "content-post"),
    );
    const built = wordsOf(articleOf(project, entry.route));
    // The related posts at the end of the live post are a query block, converted by another module.
    expect(lcs(live, built) / built.length).toBeGreaterThan(0.99);
    expect(ratio(live, built)).toBeGreaterThan(0.99);
    expect(built.length).toBeGreaterThan(2000);
  });
});

// ── The colon, over the real essays ─────────────────────────────────────────────────────────────

describe("a colon before a digit, over the real anabaptistperspectives essays", () => {
  /** The verse references and times in the text of a post's saved content. */
  const colonsOf = (post: WpPost): string[] =>
    decodeEntitiesOf(
      post.content.replaceAll(/<!--[\s\S]*?-->/g, " ").replaceAll(/<[^>]*>/g, " "),
    ).match(/\d+:\d+/g) ?? [];

  /** Put the core converters' spans around a colon back into the text, as it was before they worked around the bug. */
  function unsplit(nodes: N[]): N[] {
    const out: N[] = [];
    for (const node of nodes) {
      const next: N =
        typeof node === "string" || !Array.isArray(node.children)
          ? node
          : { ...node, children: unsplit(node.children) };
      const text =
        typeof next !== "string" &&
        next.tagName === "span" &&
        next.textContent === ":" &&
        Object.keys(next).length === 2
          ? ":"
          : next;
      const last = out[out.length - 1];
      if (typeof text === "string" && typeof last === "string") out[out.length - 1] = last + text;
      else out.push(text);
    }
    return out;
  }

  test("64 entries cite a verse or a time; every reference is in the built page", async () => {
    const site = await loadSite("ap");
    const out = await collectionsOf("ap");
    const project = await buildOf("ap");
    const reports = reportOf(out, "md.colon-escaped");
    expect(reports).toHaveLength(EXPECTED.ap.colonEntries);
    expect(reports.reduce((n, r) => n + (r.data!.colons as number), 0)).toBe(EXPECTED.ap.colons);
    let references = 0;
    for (const r of reports) {
      const entry = out.entries.find((e) => `post:${e.postId}` === r.where)!;
      const post = site.model.posts.get(entry.postId)!;
      const text = wordsOf(articleOf(project, entry.route)).join(" ");
      for (const reference of colonsOf(post)) {
        references++;
        expect([entry.id, reference, text.includes(reference)]).toEqual([
          entry.id,
          reference,
          true,
        ]);
      }
    }
    expect(references).toBeGreaterThan(300);
  });

  test("without the module every one of those essays is damaged", async () => {
    const site = await loadSite("ap");
    const out = await collectionsOf("ap");
    let damaged = 0;
    let lost = 0;
    for (const r of reportOf(out, "md.colon-escaped")) {
      const entry = out.entries.find((e) => `post:${e.postId}` === r.where)!;
      const converted = await convertSubject(
        site,
        { kind: "post", id: entry.postId },
        { target: "markdown" },
      );
      const nodes = unsplit(converted.nodes as N[]);
      const control = raw(nodes);
      const text = (list: N[]): string => JSON.stringify(canonNodes(list));
      const before = colonsOf(site.model.posts.get(entry.postId)!).length;
      const after = (JSON.stringify(canonNodes(control.back)).match(/\d+:\d+/g) ?? []).length;
      if (text(control.back) !== text(nodes)) damaged++;
      lost += Math.max(0, before - after);
    }
    expect(damaged).toBe(EXPECTED.ap.colonEntries);
    expect(lost).toBeGreaterThan(300);
  });
});

// ── Other ways to ask ───────────────────────────────────────────────────────────────────────────

describe("what a collection is made of", () => {
  test("$elements lists the components, and names the switch for a collection whose bodies use directives and no component", async () => {
    const fineline = await collectionsOf("fineline");
    // Every component the bodies use is listed by the collection that uses it, and a collection with none
    // lists the switch.
    const listed = new Set<string>();
    for (const [name, def] of Object.entries(fineline.collections)) {
      const refs = def.$elements.filter((e): e is { $ref: string } => typeof e !== "string");
      for (const ref of refs) listed.add(/^\.\/components\/(.+)\.json$/.exec(ref.$ref)![1]!);
      if (refs.length === 0) expect([name, def.$elements]).toEqual([name, [DIRECTIVES_SWITCH]]);
      else expect(def.$elements).toEqual(refs);
    }
    expect([...listed].sort()).toEqual([...fineline.used.components].sort());
    expect(fineline.collections.post!.$elements).toEqual([DIRECTIVES_SWITCH]);
    const ap = await collectionsOf("ap");
    // The episodes have no body at all: the template renders them from their data.
    expect(ap.collections.episode!.$elements).toEqual([]);
    expect(ap.collections.post!.$elements).toEqual([DIRECTIVES_SWITCH]);
    const episodes = ap.files.filter((f) => f.path.startsWith("content/episode/"));
    for (const f of episodes) expect(f.content.endsWith("\n---\n")).toBe(true);
    // The switch is what turns directives on: without it the build leaves them as text.
    const site = await loadSite("ap");
    const entry = ap.entries.find(
      (e, i) =>
        e.collection === "post" &&
        /^:{2,}[a-z0-9]+\{/m.test(
          ap.files[i]!.content.slice(ap.files[i]!.content.indexOf("\n---\n", 4)),
        ),
    )!;
    const files = projectFiles(site, ap);
    (
      files["project.json"] as { content: Record<string, { $elements: unknown[] }> }
    ).content.post!.$elements = [];
    const off = await buildJxProject(files, { name: "switch-off" });
    expect(off.html(entry.route)).toMatch(/<p>:{2,}[a-z0-9]+\{/);
    const on = await buildOf("ap");
    expect(on.html(entry.route)).not.toMatch(/<p>:{2,}[a-z0-9]+\{/);
  });

  test("the route of a plugin's post type makes it a collection: routeTypes", async () => {
    const site = await loadSite("ap");
    const out = await collectionsOf("ap", "podcast", {
      routeTypes: { captivate_podcast: { rewriteSlug: "podcast", rewriteWithFront: false } },
      include: (post) => post.type === "captivate_podcast",
    });
    expect(Object.keys(out.collections)).toEqual(["captivate_podcast"]);
    expect(out.entries).toHaveLength(97);
    expect(out.entries.every((e) => e.route === `/podcast/${e.id}/`)).toBe(true);
    expect(reportOf(out, "collection.unrouted")).toEqual([]);
    expect(reportOf(out, "md.lossy")).toEqual([]);
    expect(reportOf(out, "collection.excluded").map((r) => r.data!.count)).toEqual([3]);
    // Its address is the site's now: another post that links to a podcast gets the route.
    const withRoute = out.entries[0]!;
    expect(site.routes.forPost(withRoute.postId)).toBeUndefined();
    const project = await buildOf("ap", "podcast", {
      routeTypes: { captivate_podcast: { rewriteSlug: "podcast", rewriteWithFront: false } },
      include: (post) => post.type === "captivate_podcast",
    }).catch((error: unknown) => error);
    // (The page that renders them is the routes module's `pages/podcast/[slug].json`: the project has none here.)
    expect(project).toBeDefined();
  });

  test("a post that lost its route, one with no route, a protected post and two posts for one file are reported and skipped", async () => {
    const site = await loadSite("ap");
    const routes = site.routes.all().filter((r) => r.kind === "entry" && r.type === "post");
    const [lost, noRoute, twin, other] = routes;
    const winner = site.routes.all().find((r) => r.kind === "page")!;
    const table = {
      ...site.routes,
      all: () => site.routes.all().filter((r) => r !== lost && r !== noRoute),
      forPost: (id: number) =>
        id === Number(lost!.id)
          ? winner
          : id === Number(noRoute!.id)
            ? undefined
            : site.routes.forPost(id),
    };
    const duplicate = { ...twin!, id: other!.id, file: twin!.file };
    const protectedId = Number(routes[4]!.id);
    const posts = new Map(site.model.posts);
    posts.set(protectedId, { ...posts.get(protectedId)!, passwordProtected: true });
    const altered: SiteContext = {
      ...site,
      model: { ...site.model, posts },
      routes: {
        ...table,
        all: () => [...table.all().filter((r) => r !== other), duplicate],
      } as SiteContext["routes"],
    };
    const picked = new Set([lost, noRoute, twin, other, routes[4]].map((r) => Number(r!.id)));
    const out = await buildCollections(altered, { now: NOW, include: (p) => picked.has(p.id) });
    const by = (code: string) => reportOf(out, code);
    expect(
      by("collection.no-route")
        .map((r) => r.where)
        .sort(),
    ).toEqual([`post:${lost!.id}`, `post:${noRoute!.id}`].sort());
    expect(
      by("collection.no-route").find((r) => r.where === `post:${lost!.id}`)!.data,
    ).toMatchObject({ winner: `${winner.kind}:${winner.id}` });
    expect(by("collection.protected").map((r) => r.where)).toEqual([`post:${protectedId}`]);
    expect(by("collection.duplicate-file")).toHaveLength(1);
    expect(by("collection.duplicate-file")[0]!.severity).toBe("error");
    // What was left: the twin (one file), nothing else.
    expect(out.entries.map((e) => e.file)).toEqual([twin!.file]);
  });

  test("a date permalink structure gives nested entry ids, and the build derives the same ids from the paths", async () => {
    const site = await loadSite("ap");
    const model = {
      ...site.model,
      site: { ...site.model.site, permalinkStructure: "/%year%/%monthnum%/%postname%/" },
    };
    const routes = buildRoutes(model, site.acf, { report: site.report, media: site.media });
    const urls = createUrlTools(model, routes, site.media, { report: site.report });
    const dated: SiteContext = { ...site, model, routes, urls };
    const out = await buildCollections(dated, { now: NOW, include: (p) => p.type === "post" });
    expect(out.entries).toHaveLength(97);
    for (const e of out.entries) {
      expect(e.id).toMatch(/^\d{4}\/\d{2}\/[^/]+$/);
      expect(e.file).toBe(`content/post/${e.id}.md`);
      expect(e.route).toBe(`/${e.id}/`);
      expect(e.frontmatter.url).toBe(e.route);
    }
    const dynamic = routes.dynamicPages().find((d) => d.kind === "entries" && d.source === "post")!;
    expect(dynamic.param).toBe("path");
    const { loaded, warnings } = await loadWithJx(dated, out);
    expect(warnings).toEqual([]);
    expect(
      loaded
        .get("post")!
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(out.entries.map((e) => e.id).sort());
    const project = await buildJxProject(projectFiles(dated, out), { name: "dated" });
    for (const e of out.entries.slice(0, 5))
      expect(project.exists(`${e.id}/index.html`)).toBe(true);
  });

  test("a component instance in a body is a directive, listed in $elements, and builds as the component with its classes and properties", async () => {
    const site = await loadSite("fineline");
    await ensureConverters();
    // The Cwicly component converter of the data module: an instance is the component's tag with its
    // variant classes, a rule for the host (display: contents) and its properties.
    expect(converters["cwicly/component"]).toBeDefined();
    const ids = [1078, 1377];
    const out = await buildCollections(site, { now: NOW, include: (p) => ids.includes(p.id) });
    expect(out.entries).toHaveLength(2);
    const tags = [...out.used.components].sort();
    expect(tags).toEqual(["wp-icon-card", "wp-image-card"]);
    expect(out.collections.project!.$elements).toEqual(
      tags.map((tag) => ({ $ref: `./components/${tag}.json` })),
    );
    expect(reportOf(out, "md.lossy")).toEqual([]);
    expect(reportOf(out, "md.props-lost")).toEqual([]);
    const bodies = out.files.map((f) => f.content).join("\n");
    for (const tag of tags) expect(bodies).toContain(`${tag}{`);
    // The classes are the `class` attribute (the reader makes a component's className an attribute of that name)
    // and the host's own rule, which the component converter hoists, is a rule of the project.
    expect(bodies).toMatch(/::wp-icon-card\{\.cs-[a-z0-9]+ /);
    expect(bodies).not.toMatch(/wp-(?:icon|image)-card\{[^}]*className=/);
    expect(bodies).toContain('props.image.src="/media/');
    const rule = out.used.hoisted.find((r) => r.selector === "wp-icon-card");
    expect(rule!.style).toEqual({ display: "contents" });

    // The same two entries built with the components' files: each instance renders as the component.
    const files = projectFiles(site, out);
    for (const tag of tags) {
      const info = [...site.components.values()].find((c) => c.tagName === tag)!;
      files[`components/${tag}.json`] = {
        tagName: tag,
        state: Object.fromEntries(info.props.map((p) => [p.key, ""])),
        children: [
          {
            tagName: "span",
            className: "inst",
            textContent: `\${state.${info.props[0]!.key} ?? ''}`,
          },
        ],
      };
    }
    // (The project assembler writes the hoisted rules into the project's style; this project needs the one.)
    (files["project.json"] as { style?: unknown }).style = { [rule!.selector]: rule!.style };
    const project = await buildJxProject(files, { name: "components" });
    for (const [i, e] of out.entries.entries()) {
      const html = project.html(e.route);
      // One component per instance in the Markdown.
      const instances = out.files[i]!.content.match(/::wp-(?:icon|image)-card\{/g)!.length;
      expect(instances).toBeGreaterThan(0);
      expect(html.match(/<span class="inst">/g)!.length).toBe(instances);
      // The host element has the classes of the instance (and one `class` attribute), not a `className` attribute.
      expect(html).toMatch(/<wp-(?:icon|image)-card class="[a-z0-9 -]*cs-[a-z0-9]+[a-z0-9 -]*"/);
      expect(html).not.toContain("className=");
      expect(html).not.toMatch(/class="[^"]*"[^>]*\sclass="/);
      expect(html).not.toMatch(/<p>:+wp-/);
    }
    const css = project
      .html(out.entries[0]!.route)
      .match(/<style>[\s\S]*?<\/style>/g)!
      .join("\n");
    expect(css).toMatch(/wp-icon-card \{ display: contents \}/);
  });

  /** The site with one post changed (and, when asked, one of its meta rows): what a hand-made case needs. */
  function withPost(
    site: SiteContext,
    id: number,
    patch: Partial<WpPost>,
    meta?: (row: Record<string, unknown[]>) => void,
  ): SiteContext {
    const posts = new Map(site.model.posts);
    posts.set(id, { ...posts.get(id)!, ...patch });
    const postMeta = new Map(site.model.postMeta);
    if (meta) {
      const row = { ...postMeta.get(id) } as Record<string, unknown[]>;
      meta(row);
      postMeta.set(id, row);
    }
    return { ...site, model: { ...site.model, posts, postMeta } };
  }

  test("a dollar-brace in the data is spelled so the build cannot evaluate it, and a date that is not one is left out", async () => {
    const site = await loadSite("fineline");
    const id = 3371;
    const changed = withPost(site, id, {
      title: "Costs ${state.entry.data.slug} more",
      excerpt: "Pay $5 {now}, then ${later}",
      date: "not a date",
      modified: "2024-02-15T12:00:00.000Z",
    });
    const out = await buildCollections(changed, { now: NOW, include: (p) => p.id === id });
    const fm = out.entries[0]!.frontmatter as Record<string, string>;
    expect(fm.title).toBe("Costs $\u200b{state.entry.data.slug} more");
    expect(fm.excerpt).toBe("Pay $5 {now}, then $\u200b{later}");
    expect(out.files[0]!.content).not.toContain("${");
    expect(reportOf(out, "md.literal-template")).toHaveLength(1);
    expect(reportOf(out, "md.literal-template")[0]!.data!.count).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(fm)).not.toContain("${");
    expect(fm).not.toHaveProperty("date");
    expect(fm.modified).toBe("2024-02-15T12:00:00Z");
    const invalid = reportOf(out, "entry.date-invalid");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.message).toContain("not a date");
    // Nothing else is wrong with it: `date` is declared date-time but is optional.
    expect(reportOf(out, "entry.schema-invalid")).toEqual([]);
  });

  test("an entry that does not satisfy its schema is an error, and says which field", async () => {
    const site = await loadSite("fineline");
    const project = [...site.model.posts.values()].find(
      (p) => p.type === "project" && p.status === "publish",
    )!;
    const changed = withPost(site, project.id, {}, (row) => {
      delete row.project_location;
      delete row._project_location;
    });
    // The collection's schema comes from every project: a second project that has the field keeps it required.
    const other = [...site.model.posts.values()].find(
      (p) => p.type === "project" && p.status === "publish" && p.id !== project.id,
    )!;
    const out = await buildCollections(changed, {
      now: NOW,
      include: (p) => p.id === project.id || p.id === other.id,
    });
    const bad = reportOf(out, "entry.schema-invalid");
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe("error");
    expect(bad[0]!.where).toBe(`post:${project.id}`);
    expect(bad[0]!.data!.problems).toEqual(['missing required field "project_location"']);
  });

  test("a body that needs the page's own state loses those elements, and says so: an entry has none", async () => {
    const site = await loadSite("fineline");
    await ensureConverters();
    const original = converters["cwicly/query"];
    registerConverters({
      "cwicly/query": (_block, ctx) => {
        (ctx as unknown as { defineState(key: string, def: unknown): string }).defineState(
          "related",
          {
            $prototype: "ContentCollection",
            contentType: "post",
          },
        );
        return [
          {
            $prototype: "Array",
            items: { $ref: "#/state/related" },
            map: { tagName: "p", textContent: "item" },
          } as never,
          { tagName: "p", textContent: "kept paragraph" },
        ];
      },
    });
    try {
      const out = await buildCollections(site, { now: NOW, include: (p) => p.id === 3371 });
      const dropped = reportOf(out, "entry.dynamic-dropped");
      expect(dropped).toHaveLength(1);
      expect(dropped[0]!.severity).toBe("warn");
      expect(dropped[0]!.data).toEqual({ elements: { $prototype: 1 }, state: ["related"] });
      expect(out.files[0]!.content).toContain("kept paragraph");
      expect(out.files[0]!.content).not.toContain("Array");
      expect(out.files[0]!.content).not.toContain("#/state");
      expect(reportOf(out, "md.lossy")).toEqual([]);
    } finally {
      if (original === undefined) delete converters["cwicly/query"];
      else registerConverters({ "cwicly/query": original });
    }
  });

  test("a post that cannot be written is an error of its own and does not stop the others", async () => {
    const site = await loadSite("fineline");
    await ensureConverters();
    const original = converters["cwicly/query"];
    // A tag chosen at render time: Markdown has no directive name for it, and the serializer throws.
    registerConverters({
      "cwicly/query": () => [{ tagName: { $switch: "x", cases: ["a", "b"] } } as never],
    });
    try {
      const out = await buildCollections(site, {
        now: NOW,
        include: (p) => p.id === 3371 || p.id === 3518,
      });
      const failed = reportOf(out, "entry.failed");
      const hasQuery = (id: number): boolean =>
        site.model.posts.get(id)!.content.includes("cwicly/query");
      expect(failed.map((f) => f.where)).toEqual(
        [3371, 3518].filter(hasQuery).map((id) => `post:${id}`),
      );
      for (const f of failed) {
        expect(f.severity).toBe("error");
        expect(f.message).toContain("Markdown cannot express a tag chosen at creation");
      }
      expect(out.entries.map((e) => e.postId)).toEqual([3371, 3518].filter((id) => !hasQuery(id)));
      expect(failed.length).toBeGreaterThan(0);
    } finally {
      if (original === undefined) delete converters["cwicly/query"];
      else registerConverters({ "cwicly/query": original });
    }
  });

  test("a Fluent Forms block in a post is drawn as the form's own markup, the way a page draws it, and is no longer left out", async () => {
    // The fixture database has no forms table; the pilot's forms are committed beside it.
    const site = { ...(await loadSite("fineline")), forms: await pilotForms() };
    // With a route type the entries are made against a copy of the site; the forms they draw are still the site's.
    const out = await buildCollections(site, {
      now: NOW,
      routeTypes: { captivate_podcast: { rewriteSlug: "podcast", rewriteWithFront: false } },
    });
    // The service "Line Painting" ends with `<!-- wp:fluentfom/guten-block {"formId":"5"} /-->`.
    const file = out.files.find((f) => f.path === "content/service/line-painting.md")!;
    expect(file.content).toContain('data-wp2jx="fluentform:5"');
    expect(file.content).toContain("fluentform_5");
    expect(file.content).not.toContain("wp2jx-block");
    const mine = out.report.entries().filter((e) => e.where === "post:5305");
    expect(mine.map((e) => e.code)).toContain("form.not-submittable");
    expect(mine.map((e) => e.code)).not.toContain("entry.placeholder-dropped");
    // The form's stylesheet is the project's: the draw is filed where the assembler looks for it.
    expect(usedForms(site).map((u) => u.id)).toContain(5);
    // What a post's block has no form for is still left out and said, as before.
    expect(
      reportOf(out, "entry.placeholder-dropped").some((e) =>
        (e.data!.blocks as string[]).includes("fluentfom/guten-block"),
      ),
    ).toBe(false);
  });

  test("a [fluentform] shortcode in a post is drawn the same way, and a form the site does not have is left out and said", async () => {
    const base = { ...(await loadSite("fineline")), forms: await pilotForms() };
    const content = (id: number): string =>
      `<!-- wp:paragraph -->\n<p>Ask us:</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:shortcode -->\n[fluentform id="${id}"]\n<!-- /wp:shortcode -->`;
    const draw = async (id: number) => {
      const site = patched(base, 6833, { content: content(id) });
      return buildCollections(site, { now: NOW, include: (p) => p.id === 6833 });
    };
    const drawn = await draw(5);
    expect(drawn.files[0]!.content).toContain('data-wp2jx="fluentform:5"');
    expect(drawn.report.entries().some((e) => e.code === "form.not-submittable")).toBe(true);
    // The block form of the same thing (`fluentfom/guten-block`, the plugin's own spelling) for a form that is not there.
    const blockSite = patched(base, 6833, {
      content:
        '<!-- wp:paragraph -->\n<p>Ask us:</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:fluentfom/guten-block {"formId":"99999"} /-->',
    });
    const blockAbsent = await buildCollections(blockSite, {
      now: NOW,
      include: (p) => p.id === 6833,
    });
    expect(blockAbsent.report.entries().map((e) => e.code)).toEqual(
      expect.arrayContaining(["form.missing", "entry.placeholder-dropped"]),
    );
    const absent = await draw(99999);
    // (the excerpt of the front matter keeps the shortcode's text; the body must not)
    expect(absent.files[0]!.content.split("\n---\n").slice(1).join("")).not.toContain("fluentform");
    expect(absent.report.entries().map((e) => e.code)).toEqual(
      expect.arrayContaining(["form.missing", "entry.placeholder-dropped"]),
    );
  });

  test("what the conversions reported is passed on with its location, and the entries' own findings are located and linked", async () => {
    const out = await collectionsOf("fineline");
    const codes = new Set(out.report.entries().map((e) => e.code));
    for (const code of [
      "url.unresolved",
      "block.link-attributes-dropped",
      "md.normalized",
      "block.inline-gap",
      "entry.placeholder-dropped",
    ]) {
      expect(codes.has(code)).toBe(true);
    }
    for (const e of out.report
      .entries()
      .filter((r) => /^(md|entry)\./.test(r.code) || r.code === "block.inline-gap")) {
      expect(e.where).toMatch(/^post:\d+$/);
      expect(e.url).toMatch(/^https:\/\/finelinepainting\.pro\/\?p=\d+$/);
    }
  });
});

// ── What a post can hold that the reader reads as something else ────────────────────────────────

describe("hostile text: what a body can hold that the Markdown reader reads as something else", () => {
  const text = (nodes: readonly N[]): string => JSON.stringify(canonNodes(nodes));

  test("a colon that ends a text before an element written as a text directive is escaped, or the element is lost", () => {
    const written = ["sup", "b", "span", "abbr", "mark", "small", "i"];
    for (const tag of written) {
      const nodes: N[] = [p("Note:", t(tag, "1"), " and Genesis 1:", t(tag, "2"))];
      const control = raw(nodes);
      // Written as the serializer does, the colon and the directive's own colon are one `::name[…]`: no element.
      expect(control.md, tag).toContain(`Note::${tag}[1]`);
      expect(control.diff.length, tag).toBeGreaterThan(0);
      const mine = roundTrip(nodes);
      expect(mine.diff, tag).toEqual([]);
      expect(mine.md, tag).toContain(`Note\\::${tag}[1]`);
      expect(mine.fit.notes.colons, tag).toBe(2);
      expect(text(mine.back), tag).toBe(text(nodes));
    }
    // A heading, a directive that has a class, and an image that needs a directive are the same.
    const more: N[] = [
      { tagName: "h2", children: ["4:", t("sup", "1")] },
      p("a:", t("span", "b", { className: "x" })),
      p("Fig:", { tagName: "img", attributes: { src: "/a.png", alt: "x", width: "40" } }),
    ];
    const mine = roundTrip(more);
    expect(mine.diff).toEqual([]);
    expect(mine.fit.notes.colons).toBe(3);
    // Before an element the serializer writes as Markdown there is nothing to read as a directive.
    const native = roundTrip([
      p("Note:", t("em", "x"), " and ", t("strong", "y"), ":", t("code", "z")),
    ]);
    expect(native.diff).toEqual([]);
    expect(native.fit.notes.colons).toBe(0);
    expect(native.md).toContain("Note:*x*");
  });

  test("a colon before an astral code point (an emoji, a symbol) is escaped; before a symbol of the first plane it is not", () => {
    const nodes: N[] = [p("c:😀d and e:\u{1D7D8} and f:🇩🇪")];
    expect(raw(nodes).diff.length).toBeGreaterThan(0);
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(mine.fit.notes.colons).toBe(3);
    // No damage, so no escape: a symbol of the first plane is no name.
    const bmp = roundTrip([p("a:€ b:© c:→ d:\u2603")]);
    expect(bmp.diff).toEqual([]);
    expect(bmp.fit.notes.colons).toBe(0);
    expect(bmp.md).not.toContain("\\:");
  });

  test("the alt text and title of a Markdown image, and the title of a link, are text the reader reads directives in", () => {
    const nodes: N[] = [
      p(
        { tagName: "img", attributes: { src: "/a.png", alt: "John 3:16 inline", title: "t 1:2" } },
        " text ",
        { tagName: "a", attributes: { href: "/x/", title: "Acts 2:38" }, children: ["go"] },
      ),
    ];
    const control = raw(nodes);
    expect(control.diff.length).toBeGreaterThan(0);
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(mine.fit.notes.colons).toBe(3);
    const back = mine.back[0] as { children: { attributes: Record<string, string> }[] };
    expect(back.children[0]!.attributes.alt).toBe("John 3:16 inline");
    expect(back.children[0]!.attributes.title).toBe("t 1:2");
    expect(back.children[2]!.attributes.title).toBe("Acts 2:38");
    // The expected tree names the colon again (the stand-in is gone from every attribute).
    expect(JSON.stringify(mine.expected)).not.toMatch(/[\u{F0A00}-\u{F0AFF}]/u);
  });

  test("a run of colons that starts a line, before a name, is a block directive to the reader: the run is escaped there only", () => {
    const nodes: N[] = [
      p("::note[label]{k=v}"),
      p("a", { tagName: "br" }, "::note[x]"),
      p("one\n:::warn[y]\ntwo"),
      { tagName: "h2", textContent: "::heading[x]" },
      p("a::b and c:::d"),
    ];
    const control = raw(nodes);
    expect(control.diff.length).toBeGreaterThan(0);
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(text(mine.back)).toBe(text(nodes));
    expect(mine.md).toContain("a::b and c:::d");
    expect(mine.fit.notes.colons).toBe(2 + 2 + 3 + 2);
  });

  test("two strings side by side are one text, so a colon at the end of one meets the digit that starts the next", () => {
    const nodes: N[] = [p("x:", "12:30pm", " and ", "y:", "3")];
    expect(raw(nodes).diff.length).toBeGreaterThan(0);
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(mine.fit.notes.colons).toBe(3);
    expect(mine.md).toBe("x\\:12\\:30pm and y\\:3\n");
  });

  test("emphasis with a space at its edge is written with the space outside it, not as character references", () => {
    const nodes: N[] = [
      p(t("em", "sound "), "of"),
      p("Hearts & Voices, ", t("em", "Winter 2013")),
      p(t("strong", "Note: "), "text", t("del", " gone"), "!"),
      p("a ", { tagName: "strong", children: [{ tagName: "em", children: ["x "] }] }, "b"),
      p("keep", t("em", "\u00a0nb"), " end"),
      { tagName: "pre", children: [t("code", "  keep this  ")] },
    ];
    // Left as it is, the serializer writes a character reference for the space and the letter after it.
    expect(raw([nodes[0]!]).md).toContain("&#x20;");
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(mine.md).not.toContain("&#x20;");
    expect(mine.md).not.toMatch(/&#x[0-9A-F]+;\w/);
    expect(mine.md).toContain("*sound* of");
    expect(mine.md).toContain("**Note:** text ~~gone~~!");
    expect(mine.md).toContain("keep\u00a0*nb*");
    expect(mine.md).toContain("a **_x_** b");
    expect(mine.fit.notes.edgeSpaces).toBe(6);
    // What the browser shows is the same text.
    const shown = (list: readonly N[]): string =>
      JSON.stringify(canonNodes(list)).replaceAll(/\s+/g, "");
    expect(shown(mine.back)).toBe(shown(nodes));
    // Code is left as it is.
    expect(JSON.stringify(mine.back.at(-1))).toContain("  keep this  ");
    // Emphasis that is only a space is that space.
    const only = roundTrip([p("a", t("em", " "), "b")]);
    expect(only.diff).toEqual([]);
    expect(only.fit.nodes).toEqual([p("a b")]);
  });

  test("an address followed by a no-break space is written with a plain one, which ends the address the reader links", () => {
    const address = "http://www.aei.org/x/doubled/";
    const nodes: N[] = [p(`see ${address}.\u00a0and more, and www.example.org/a\u00a0then`)];
    const control = raw(nodes);
    expect(JSON.stringify(control.back)).toContain(`"href":"${address}.\u00a0and"`);
    const mine = roundTrip(nodes);
    expect(mine.diff).toEqual([]);
    expect(mine.fit.notes.addressSpaces).toBe(2);
    const hrefs = [...JSON.stringify(mine.back).matchAll(/"href":"([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([address, "http://www.example.org/a"]);
    expect(JSON.stringify(mine.back)).not.toContain("\u00a0");
    // A no-break space anywhere else is text, kept.
    expect(roundTrip([p("20\u00a0th and a\u00a0b")]).md).toContain("20\u00a0th and a\u00a0b");
    expect(
      fixText(
        "x\u00a0y http://a.b\u00a0z",
        { colon: "\u{F0A01}", newline: "\u{F0A02}" },
        emptyNotes(),
      ),
    ).toBe("x\u00a0y http://a.b z");
  });

  test("autolinkable is linear in the length of a long unbroken text", () => {
    const long = "a".repeat(120_000);
    const started = performance.now();
    expect(autolinkable([p(long)])).toBe(0);
    expect(autolinkable([p(`${"a".repeat(60_000)}@${"b".repeat(60_000)}`)])).toBe(0);
    expect(autolinkable([p(`${"w.".repeat(30_000)}@${"b-".repeat(30_000)}`)])).toBe(0);
    expect(performance.now() - started).toBeLessThan(1500);
    // The addresses it counts are unchanged.
    expect(
      autolinkable([
        p(
          "mail me@example.org, a.b+c@d-e.co.uk, www.example.org and https://x.y/z?q=1; not a@b or @c.d",
        ),
      ]),
    ).toBe(4);
    expect(autolinkable([p("(me@example.org) -me@example.org +x@y.zz")])).toBe(3);
  });
});

describe("what the module does with the rules, properties and addresses it is given", () => {
  test("a component property that is null, undefined or false, at any depth, is left out and said", () => {
    const instance = {
      tagName: "wp-x",
      $props: {
        n: null,
        u: undefined,
        f: false,
        l: [1],
        s: "str",
        z: 0,
        t: true,
        o: { k: null, k2: "v", k3: false, deep: { gone: undefined } },
      },
    } as unknown as N;
    const fit = fitBody([instance]);
    expect((fit.nodes[0] as { $props: unknown }).$props).toEqual({
      s: "str",
      z: "0",
      t: "true",
      o: { k2: "v" },
    });
    expect(fit.notes.propsLost).toEqual([
      "props.n",
      "props.u",
      "props.f",
      "props.l",
      "props.o.k",
      "props.o.k3",
      "props.o.deep.gone",
    ]);
  });

  test("a rule that entries disagree about is written for a class of its own declarations, wherever the module made it", () => {
    const body: N[] = [
      // A style moved to the class because the element has an id attribute (the query converters give one).
      {
        tagName: "div",
        className: "qt-c1 wrap",
        attributes: { id: "qt" },
        style: { rowGap: "10px" },
        textContent: "q",
      },
      // A heading's own style (the build writes it to `#its-text`).
      { tagName: "h2", className: "hd-c2", style: { color: "red" }, textContent: "1. Inspection" },
      // A custom property.
      {
        tagName: "div",
        className: "cp-c3",
        style: { "--x": "1px", color: "red" },
        textContent: "c",
      },
      // A component instance.
      { tagName: "wp-card", className: "card-c4 cs-a", style: { display: "contents" } },
    ];
    const plain = fitBody(body);
    expect(plain.hoisted.map((r) => r.selector)).toEqual([
      ".qt-c1",
      ".hd-c2",
      ".cp-c3",
      ".card-c4",
    ]);
    expect(plain.notes.scopedPerEntry).toBe(0);
    const scoped = fitBody(
      body,
      sentinelsFor(body),
      "report",
      new Set([".qt-c1", ".hd-c2", ".cp-c3", ".card-c4"]),
    );
    expect(scoped.notes.scopedPerEntry).toBe(4);
    const classes = scoped.hoisted.map(
      (r) => /^\.[\w-]+:where\(\.(jx-[0-9a-f]{10})\)$/.exec(r.selector)![1],
    );
    const el = (i: number) =>
      scoped.nodes[i] as { className?: string; attributes?: { class?: string } };
    expect(el(0).className).toBe(`qt-c1 wrap ${classes[0]}`);
    expect(el(1).className).toBe(`hd-c2 ${classes[1]}`);
    expect(el(2).className).toBe(`cp-c3 ${classes[2]}`);
    expect(el(3).attributes!.class).toBe(`card-c4 cs-a ${classes[3]}`);
    // The same declarations are the same class, other declarations another.
    const again = fitBody(
      [
        { ...(body[1] as object), textContent: "other" } as N,
        { ...(body[1] as object), style: { color: "blue" } } as N,
      ],
      sentinelsFor(body),
      "report",
      new Set([".hd-c2"]),
    );
    expect(again.hoisted[0]!.selector).toBe(scoped.hoisted[1]!.selector);
    expect(again.hoisted[1]!.selector).not.toBe(again.hoisted[0]!.selector);
    // A selector nobody disagrees about is left as it is.
    const other = fitBody(body, sentinelsFor(body), "report", new Set([".elsewhere"]));
    expect(other.hoisted.map((r) => r.selector)).toEqual(plain.hoisted.map((r) => r.selector));
  });

  test("a heading's own style goes to its class: the build gives every heading an id of its text, which a style would be scoped to", () => {
    const heading: N = {
      tagName: "h1",
      className: "heading-ce6a839 section-x",
      style: { position: "relative", "@--md": { textAlign: "center" } },
      textContent: "13 steps",
    };
    const fit = fitBody([heading]);
    expect(fit.hoisted).toEqual([
      {
        selector: ".heading-ce6a839",
        style: { position: "relative", "@--md": { textAlign: "center" } },
      },
    ]);
    expect((fit.nodes[0] as { style?: unknown }).style).toBeUndefined();
    expect((fit.nodes[0] as { className: string }).className).toBe("heading-ce6a839 section-x");
    expect(fit.notes.scoped).toBe(1);
    // An id of its own is the scope the author chose; a heading with no style has nothing to move.
    expect(fitBody([{ ...heading, id: "mine" } as N]).hoisted).toEqual([]);
    expect(fitBody([{ tagName: "h2", className: "x", textContent: "t" }]).hoisted).toEqual([]);
    const back = roundTrip([heading]);
    expect(back.diff).toEqual([]);
  });

  test("relaxAddressFormats makes every uri a uri-reference, at any depth, and nothing else", () => {
    const schema = {
      type: "object",
      properties: {
        link: { type: "string", format: "uri" },
        rows: {
          type: "array",
          items: { type: "object", properties: { href: { type: "string", format: "uri" } } },
        },
        when: { type: "string", format: "date-time" },
        format: { type: "string" },
      },
      required: ["link"],
    };
    const relaxed = relaxAddressFormats(schema);
    expect(relaxed.properties.link.format).toBe("uri-reference");
    expect(relaxed.properties.rows.items.properties.href.format).toBe("uri-reference");
    expect(relaxed.properties.when.format).toBe("date-time");
    expect(relaxed.required).toEqual(["link"]);
    expect(schema.properties.link.format).toBe("uri");
    expect(relaxAddressFormats("uri")).toBe("uri");
    expect(relaxAddressFormats([{ format: "uri" }])).toEqual([{ format: "uri-reference" }]);
  });

  test("rewriteAddresses goes through arrays of values: a list of link objects, a list of markup", () => {
    const rewrite = (url: string): string => url.replace("https://old.example", "/new");
    const value = {
      links: [
        { url: "https://old.example/a/", title: "A" },
        { url: "https://elsewhere.example/b/", title: "B" },
      ],
      html: [`<a href="https://old.example/c/">c</a>`, "plain text https://old.example/d/"],
      nested: [[{ src: "https://old.example/e.png" }]],
    };
    expect(rewriteAddresses(value, rewrite)).toEqual({
      links: [
        { url: "/new/a/", title: "A" },
        { url: "https://elsewhere.example/b/", title: "B" },
      ],
      html: [`<a href="/new/c/">c</a>`, "plain text https://old.example/d/"],
      nested: [[{ src: "/new/e.png" }]],
    });
  });

  test("a colon span among the loose nodes of the body itself is put back into the text", () => {
    const body: N[] = ["Luke 3", t("span", ":"), "16"];
    const fit = fitBody(body);
    expect(fit.notes.colonSpans).toBe(1);
    expect(fit.notes.colons).toBe(1);
    expect(expectedTree(fit.nodes, sentinelsFor(body))).toEqual([p("Luke 3:16")]);
  });

  test("itemParagraphs counts the list items and cells that hold a paragraph", () => {
    expect(
      itemParagraphs([
        { tagName: "ul", children: [{ tagName: "li", children: [p("a")] }, t("li", "b")] },
        {
          tagName: "table",
          children: [{ tagName: "tr", children: [{ tagName: "td", children: [p("c")] }] }],
        },
        p("not an item"),
      ]),
    ).toBe(2);
    expect(itemParagraphs([])).toBe(0);
  });
});

// ── Entries that disagree, and posts that hold what the module has to be careful with ───────────

/** The site with one post changed (its content, say). */
function patched(site: SiteContext, id: number, patch: Partial<WpPost>): SiteContext {
  const posts = new Map(site.model.posts);
  posts.set(id, { ...posts.get(id)!, ...patch });
  return { ...site, model: { ...site.model, posts } };
}

/** Run `fn` with the body of every `cwicly/query` block replaced by `make`, and put the converter back. */
async function withQueryBody(
  make: (
    postId: number,
    ctx: { hoist?: (rule: { selector: string; style: object }) => void },
  ) => N[],
  fn: () => Promise<void>,
): Promise<void> {
  await ensureConverters();
  const original = converters["cwicly/query"];
  registerConverters({
    "cwicly/query": (_block, ctx) => make(Number(ctx.subject.id), ctx as never) as never,
  });
  try {
    await fn();
  } finally {
    if (original === undefined) delete converters["cwicly/query"];
    else registerConverters({ "cwicly/query": original });
  }
}

describe("rules that more than one entry writes, with different declarations", () => {
  // Fineline services that hold a query block: two with an even id, two with an odd one.
  const IDS = [5270, 5278, 5291, 5307];
  const rowGap = (id: number): string => (id % 2 === 0 ? "10px" : "20px");
  const body = (id: number, same: boolean): N[] => [
    {
      tagName: "div",
      className: "qt-c1 wrap",
      attributes: { id: "qt" },
      style: { rowGap: same ? "10px" : rowGap(id), "@--sm": { marginTop: "0" } },
      textContent: "q",
    },
    {
      tagName: "h2",
      className: "hd-c2 x",
      style: { color: same || id % 2 === 0 ? "red" : "blue" },
      textContent: "1. Inspection",
    },
  ];
  const mine = (p: WpPost): boolean => IDS.includes(p.id);
  /** The rules of the bodies made here (the services' own blocks hoist rules too). */
  const ours = (out: CollectionsOutput) =>
    out.used.hoisted.filter((r) => /^\.(?:qt-c1|hd-c2)(?:$|:)/.test(r.selector));

  test("a class id that repeats with different declarations is scoped per entry: each page has its own rule, the real build shows it", async () => {
    const site = await loadSite("fineline");
    await withQueryBody(
      (id) => body(id, false),
      async () => {
        const out = await buildCollections(site, { now: NOW, include: mine });
        expect(out.entries.map((e) => e.postId).sort()).toEqual(IDS);
        const rules = ours(out)
          .map((r) => r.selector)
          .sort();
        // Two variants of each selector, shared by the entries that agree: four rules, none left plain.
        expect(rules).toHaveLength(4);
        expect(rules.filter((s) => /^\.hd-c2:where\(\.jx-[0-9a-f]{10}\)$/.test(s))).toHaveLength(2);
        expect(rules.filter((s) => /^\.qt-c1:where\(\.jx-[0-9a-f]{10}\)$/.test(s))).toHaveLength(2);
        const scoped = reportOf(out, "style.scoped-per-entry").filter((r) =>
          [".hd-c2", ".qt-c1"].includes(r.data!.selector as string),
        );
        expect(scoped.map((r) => r.data!.selector)).toEqual([".hd-c2", ".qt-c1"]);
        for (const r of scoped) {
          expect(r.severity).toBe("info");
          expect(r.data).toMatchObject({ variants: 2, posts: IDS });
        }
        expect(reportOf(out, "style.conflict")).toEqual([]);

        // Each entry's element carries the class of ITS declarations.
        for (const e of out.entries) {
          const file = out.files.find((f) => f.path === e.file)!;
          const els: JxElement[] = [];
          const walk = (list: readonly N[]): void => {
            for (const n of list) {
              if (typeof n === "string") continue;
              els.push(n);
              walk(Array.isArray(n.children) ? n.children : []);
            }
          };
          walk(readBack(file.content).body);
          const box = els.find((n) => String(n.className ?? "").includes("qt-c1")) as {
            className: string;
          };
          const scope = box.className.split(" ").find((c) => c.startsWith("jx-"))!;
          const rule = out.used.hoisted.find((r) => r.selector === `.qt-c1:where(.${scope})`);
          expect(rule!.style).toEqual({ rowGap: rowGap(e.postId), "@--sm": { marginTop: "0" } });
          expect(
            reportOf(out, "md.normalized").find((r) => r.where === `post:${e.postId}`)!.data!
              .stylesScopedPerEntry,
          ).toBeGreaterThanOrEqual(2);
        }

        // The page: the rule of the class in the project's style, the element with that class.
        const files = projectFiles(site, out);
        (files["project.json"] as { style?: unknown }).style = Object.fromEntries(
          out.used.hoisted.map((r) => [r.selector, r.style]),
        );
        const project = await buildJxProject(files, { name: "scoped-rules" });
        for (const e of out.entries) {
          const html = project.html(e.route);
          const cls = /<div[^>]*class="qt-c1 wrap (jx-[0-9a-f]{10})"/.exec(html)![1]!;
          const css = html.match(/<style>[\s\S]*?<\/style>/g)!.join("\n");
          const own = new RegExp(`\\.qt-c1:where\\(\\.${cls}\\) \\{[^}]*row-gap: (\\d+px)`).exec(
            css,
          );
          expect(own![1]).toBe(rowGap(e.postId));
        }
      },
    );
  });

  test("entries that agree keep the plain selector: no class, no report", async () => {
    const site = await loadSite("fineline");
    await withQueryBody(
      (id) => body(id, true),
      async () => {
        const out = await buildCollections(site, { now: NOW, include: mine });
        expect(
          ours(out)
            .map((r) => r.selector)
            .sort(),
        ).toEqual([".hd-c2", ".qt-c1"]);
        expect(
          reportOf(out, "style.scoped-per-entry").filter((r) =>
            [".hd-c2", ".qt-c1"].includes(r.data!.selector as string),
          ),
        ).toEqual([]);
        expect(
          reportOf(out, "style.conflict").filter(
            (r) => ours(out).length > 0 && /qt-c1|hd-c2/.test(String(r.data!.selector)),
          ),
        ).toEqual([]);
        expect(out.files.map((f) => f.content).join("\n")).not.toMatch(
          /(?:qt-c1[. ]wrap|hd-c2[. ]x)[. ]jx-/,
        );
      },
    );
  });

  test("a clash among the converters' own rules is reported, and the rules that agree are one", async () => {
    const site = await loadSite("fineline");
    await withQueryBody(
      (id, ctx) => {
        ctx.hoist!({ selector: ".conv", style: { color: id % 2 === 0 ? "red" : "blue" } });
        ctx.hoist!({ selector: ".same", style: { color: "green" } });
        return [{ tagName: "p", textContent: "x" }];
      },
      async () => {
        const out = await buildCollections(site, { now: NOW, include: mine });
        const conv = out.used.hoisted.filter((r) => r.selector === ".conv");
        // One rule for each declaration, not one for each entry and not one for the selector.
        expect(conv.map((r) => r.style)).toEqual([{ color: "red" }, { color: "blue" }]);
        expect(out.used.hoisted.filter((r) => r.selector === ".same")).toHaveLength(1);
        const clash = reportOf(out, "style.conflict");
        expect(clash).toHaveLength(1);
        expect(clash[0]!.severity).toBe("warn");
        expect(clash[0]!.where).toBe("style:.conv");
        expect(clash[0]!.data).toEqual({ selector: ".conv", variants: 2, posts: IDS });
        expect(
          reportOf(out, "style.scoped-per-entry").filter((r) => r.data!.selector === ".conv"),
        ).toEqual([]);
      },
    );
  });
});

describe("a post that holds what the reader, the serializer or the build would take for something else", () => {
  const wrap = (html: string): string => `<!-- wp:paragraph -->\n${html}\n<!-- /wp:paragraph -->`;
  const HOSTILE = [
    wrap("<p>para ${x} end</p>"),
    `<!-- wp:list -->\n<ul><li>item \${x} end</li><li>ok</li></ul>\n<!-- /wp:list -->`,
    wrap(
      '<p><strong>bold ${x}</strong> and <em>em ${x}</em> and <a href="https://example.org/x">link ${x} end</a> tail <code>${y}</code></p>',
    ),
    `<!-- wp:code -->\n<pre class="wp-block-code"><code>a \${x} b</code></pre>\n<!-- /wp:code -->`,
    wrap("<p>Note:<sup>1</sup> and Genesis 1:<sup>2</sup> and c:😀d</p>"),
    wrap("<p>::note[label]{k=v}</p>"),
    wrap("<p><em>sound </em>of</p>"),
    wrap("<p>see http://www.aei.org/x/doubled/.&nbsp;and more</p>"),
    wrap("<p>after</p>"),
  ].join("\n\n");

  const hostile = (() => {
    let run: Promise<{ out: CollectionsOutput; project: BuiltProject; route: string }> | undefined;
    return () =>
      (run ??= (async () => {
        const site = patched(await loadSite("ap"), 747, { content: HOSTILE });
        const out = await buildCollections(site, { now: NOW, include: (p) => p.id === 747 });
        const project = await buildJxProject(projectFiles(site, out), { name: "hostile" });
        return { out, project, route: out.entries[0]!.route };
      })());
  })();

  test("a literal dollar-brace in a paragraph, an item, emphasis, a link or code keeps its text: the entry is written, not emptied", async () => {
    const { out, project, route } = await hostile();
    const text = wordsOf(articleOf(project, route)).join(" ").replaceAll("​", "");
    for (const part of [
      "para ${x} end",
      "item ${x} end ok",
      "bold ${x} and em ${x} and link ${x} end tail ${y}",
      "a ${x} b",
    ]) {
      expect(text).toContain(part);
    }
    expect(reportOf(out, "md.innerhtml-lost")).toEqual([]);
    expect(reportOf(out, "html.innerhtml-unserialisable")).toEqual([]);
    expect(reportOf(out, "md.lossy")).toEqual([]);
    const html = project.html(route);
    // (The build writes the reference for the dollar sign, which is the two characters on the page.)
    expect(html).toContain("<code>&#36;{y}</code>");
    expect(html).toContain("<li>item &#36;{x} end</li>");
  });

  test("a colon before an element, before an emoji, and a line that looks like a directive are all text on the page", async () => {
    const { project, route } = await hostile();
    const html = project.html(route);
    expect(html).toMatch(/Note:\s*<sup>1<\/sup>/);
    expect(html).toMatch(/Genesis 1:\s*<sup>2<\/sup>/);
    expect(html).not.toContain("::sup");
    expect(html).toContain("c:😀d");
    expect(html).toContain("::note[label]{k=v}");
    expect(html).not.toMatch(/<note|<😀/);
  });

  test("emphasis has no character references in the Markdown, and the page shows the space where it was", async () => {
    const { out, project, route } = await hostile();
    expect(out.files[0]!.content).toContain("*sound* of");
    expect(out.files[0]!.content).not.toContain("&#x20;");
    expect(wordsOf(articleOf(project, route)).join(" ")).toContain("sound of");
  });

  test("an address followed by a no-break space links the address alone", async () => {
    const { out, project, route } = await hostile();
    const hrefs = [...project.html(route).matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toContain("http://www.aei.org/x/doubled/");
    expect(hrefs.some((h) => h!.includes(" "))).toBe(false);
    expect(reportOf(out, "md.autolinked")[0]!.data).toEqual({
      addresses: 1,
      spacesAfterAddress: 1,
    });
  });
});

describe("the schema of a collection and the keys of its entries", () => {
  const RENAME: Record<string, string> = { id: "authorUrl", premium: "hasExcerpt" };

  test("an ACF field called authorUrl or hasExcerpt has taken a key of the entry data contract: it is said", async () => {
    const site = await loadSite("ap");
    const acf = {
      ...site.acf,
      groups: site.acf.groups.map((g) => ({
        ...g,
        fields: g.fields.map((f) => (f.name in RENAME ? { ...f, name: RENAME[f.name]! } : f)),
      })),
    };
    const postMeta = new Map(site.model.postMeta);
    for (const [id, row] of postMeta) {
      if (site.model.posts.get(id)?.type !== "episode") continue;
      const next: Record<string, unknown[]> = { ...row };
      for (const [from, to] of Object.entries(RENAME)) {
        for (const [a, b] of [
          [from, to],
          [`_${from}`, `_${to}`],
        ] as const) {
          if (a in next) {
            next[b] = next[a]!;
            delete next[a];
          }
        }
      }
      postMeta.set(id, next);
    }
    const altered = { ...site, acf, model: { ...site.model, postMeta } } as SiteContext;
    const out = await buildCollections(altered, { now: NOW, include: (p) => p.type === "episode" });
    expect(out.entries).toHaveLength(98);
    const found = reportOf(out, "entry.key-collision");
    // One for each key an entry has a value for (an episode with no value for it has nothing to collide).
    const has = (key: string): number =>
      out.entries.filter((e) => {
        const post = altered.model.posts.get(e.postId)!;
        const values = acfValues(altered.model, altered.acf, postTarget(altered.model, post), {
          report: createReport(),
        });
        return Object.hasOwn(values, key);
      }).length;
    expect(has("authorUrl")).toBeGreaterThan(90);
    expect(found.filter((r) => r.data!.key === "authorUrl")).toHaveLength(has("authorUrl"));
    expect(found.filter((r) => r.data!.key === "hasExcerpt")).toHaveLength(has("hasExcerpt"));
    expect(found).toHaveLength(has("authorUrl") + has("hasExcerpt"));
    for (const r of found) {
      expect(r.severity).toBe("warn");
      expect(r.where).toMatch(/^post:\d+$/);
      expect(r.url).toMatch(/^https:\/\/anabaptistperspectives\.org\/\?p=\d+$/);
    }
    // The field's value is what the entry holds under the key (the contract's value is the one lost).
    const first = out.entries[0]!.frontmatter;
    expect(typeof first.hasExcerpt).toBe("boolean");
    expect(first.authorUrl).not.toMatch(/^\/people\//);
    // Without the rename there is nothing to say.
    const plain = await collectionsOf("ap");
    expect(reportOf(plain, "entry.key-collision")).toEqual([]);
  });

  test("a required ACF field is required of the entries its group applies to, and of no others", async () => {
    const site = await loadSite("fineline");
    const base = site.acf.groups.find((g) => g.title === "Blogs")!;
    const field = {
      ...base.fields[0]!,
      key: "field_zzz",
      name: "special",
      label: "Special",
      required: true,
      postId: 99991,
      conditionalLogic: [],
    };
    const withGroup = (location: unknown): SiteContext =>
      ({
        ...site,
        acf: {
          ...site.acf,
          groups: [
            ...site.acf.groups,
            {
              ...base,
              key: "group_zzz",
              postId: 99990,
              title: "Special",
              location,
              fields: [field],
            },
          ],
        },
      }) as SiteContext;
    const projects = (p: WpPost): boolean => p.type === "project";
    const type = [{ param: "post_type", operator: "==", value: "project" }];

    // Only the agricultural projects are in the group: the other projects owe it nothing.
    const some = await buildCollections(
      withGroup([
        [...type, { param: "post_taxonomy", operator: "==", value: "project_type:agricultural" }],
      ]),
      { now: NOW, include: projects },
    );
    expect(some.collections.project!.schema.properties.special).toBeDefined();
    expect(some.collections.project!.schema.required).not.toContain("special");
    expect(reportOf(some, "entry.schema-invalid")).toEqual([]);

    // Every project is in the group: the field is required, and an entry without it says so.
    const all = withGroup([type]);
    const ids = [...all.model.posts.values()].filter((p) => projects(p) && p.status === "publish");
    const postMeta = new Map(all.model.postMeta);
    for (const post of ids.slice(1)) {
      postMeta.set(post.id, { ...postMeta.get(post.id), special: ["x"], _special: ["field_zzz"] });
    }
    const out = await buildCollections(
      { ...all, model: { ...all.model, postMeta } } as SiteContext,
      { now: NOW, include: projects },
    );
    expect(out.collections.project!.schema.required).toContain("special");
    const bad = reportOf(out, "entry.schema-invalid");
    expect(bad.map((r) => r.where)).toEqual([`post:${ids[0]!.id}`]);
    expect(bad[0]!.data!.problems).toEqual(['missing required field "special"']);
  });
});

describe("the real sites: what the entries share, and what they carry of the live pages", () => {
  test("fineline: no selector has two bodies in the project's rules; the ones the entries disagreed about are scoped per entry and said", async () => {
    const out = await collectionsOf("fineline");
    const bodies = new Map<string, Set<string>>();
    for (const r of out.used.hoisted) {
      const found = bodies.get(r.selector) ?? new Set<string>();
      found.add(JSON.stringify(sortDeep(r.style)));
      bodies.set(r.selector, found);
    }
    expect([...bodies].filter(([, v]) => v.size > 1).map(([k]) => k)).toEqual([]);
    expect(bodies.size).toBe(out.used.hoisted.length);
    expect(reportOf(out, "style.conflict")).toEqual([]);
    const scoped = reportOf(out, "style.scoped-per-entry");
    expect(scoped).toHaveLength(19);
    for (const r of scoped) {
      expect(r.severity).toBe("info");
      expect(r.data!.variants as number).toBeGreaterThan(1);
      const own = new RegExp(
        `^${String(r.data!.selector).replaceAll(".", "\\.")}:where\\(\\.jx-[0-9a-f]{10}\\)$`,
      );
      expect(out.used.hoisted.filter((rule) => own.test(rule.selector)).length).toBe(
        r.data!.variants as number,
      );
      expect(out.used.hoisted.some((rule) => rule.selector === r.data!.selector)).toBe(false);
    }
    // ap hoists none of its own: the one rule is the paragraph of a list item taken out of the spacing.
    expect((await collectionsOf("ap")).used.hoisted).toEqual([
      {
        selector: "li > p, td > p, th > p, dd > p",
        style: ITEM_PARAGRAPH_STYLE,
      },
    ]);
  });

  test("used.wpClasses is the classes of the files as read back: a component's, and a paragraph's HTML", async () => {
    for (const [name, key, opts] of [
      ["fineline", "default", {}],
      ["ap", "html", { inlineGaps: "innerHTML" }],
      ["ap", "default", {}],
    ] as const) {
      const out = await collectionsOf(name, key, opts);
      const back = new Set<string>();
      for (const f of out.files)
        for (const c of collectWpClasses(readBack(f.content).body)) back.add(c);
      expect([...out.used.wpClasses].sort(), `${name} ${key}`).toEqual([...back].sort());
      expect(out.used.wpClasses.size).toBeGreaterThan(50);
    }
    expect((await collectionsOf("fineline")).used.wpClasses.has("cs-bmuh8n")).toBe(true);
    const html = await collectionsOf("ap", "html", { inlineGaps: "innerHTML" });
    expect(html.used.wpClasses.has("ext")).toBe(true);
    expect(html.used.wpClasses.has("fn")).toBe(true);
  });

  test("a heading's own style is on its class: the built pages have no rule for a heading's generated id, and none that starts with a digit", async () => {
    const out = await collectionsOf("fineline");
    const headings: { className: string; style?: unknown }[] = [];
    const walk = (list: readonly N[]): void => {
      for (const n of list) {
        if (typeof n === "string") continue;
        if (/^h[1-6]$/.test(String(n.tagName)) && typeof n.className === "string") {
          headings.push(n as { className: string; style?: unknown });
        }
        walk(Array.isArray(n.children) ? n.children : []);
      }
    };
    for (const f of out.files) walk(readBack(f.content).body);
    expect(headings.length).toBeGreaterThan(100);
    expect(headings.filter((h) => h.style !== undefined)).toEqual([]);
    const selectors = new Set(out.used.hoisted.map((r) => r.selector.replace(/:where\(.*$/, "")));
    expect(
      headings.filter((h) => selectors.has(`.${h.className.split(" ")[0]}`)).length,
    ).toBeGreaterThan(50);

    const project = await buildOf("fineline");
    let pages = 0;
    for (const e of out.entries) {
      const html = project.html(e.route);
      const css = (html.match(/<style>[\s\S]*?<\/style>/g) ?? []).join("\n");
      expect(css, e.route).not.toMatch(/(?:^|[\s,}{])#\d[\w-]* *\{/);
      for (const id of html.matchAll(/<h[1-6][^>]*\sid="([^"]+)"/g)) {
        expect(css, `${e.route} #${id[1]}`).not.toContain(`#${id[1]} {`);
      }
      pages++;
    }
    expect(pages).toBe(out.entries.length);
  });

  test("a paragraph the reader puts around the text of a list item or cell is said, with how many, on each entry that has one", async () => {
    for (const [name, entries, total] of [
      ["fineline", 10, 323],
      ["ap", 29, 257],
    ] as const) {
      const out = await collectionsOf(name);
      const said = reportOf(out, "md.item-paragraphs");
      expect(said, name).toHaveLength(entries);
      let sum = 0;
      for (const r of said) {
        expect(r.severity).toBe("warn");
        const entry = out.entries.find((e) => `post:${e.postId}` === r.where)!;
        const file = out.files.find((f) => f.path === entry.file)!;
        // Not a guess: the file as read back holds at least that many items and cells with a paragraph.
        const held = itemParagraphs(readBack(file.content).body);
        expect(r.data!.count as number).toBeGreaterThan(0);
        expect(r.data!.count as number).toBeLessThanOrEqual(held);
        sum += r.data!.count as number;
      }
      expect(sum, name).toBe(total);
    }
  });

  test("anabaptistperspectives: the addresses the live pages print as plain text before a no-break space link the address alone", async () => {
    const site = await loadSite("ap");
    const ids = [747, 3621, 801];
    const out = await buildCollections(site, { now: NOW, include: (p) => ids.includes(p.id) });
    expect(out.files).toHaveLength(3);
    let spaces = 0;
    for (const f of out.files) {
      const hrefs = [...JSON.stringify(readBack(f.content).body).matchAll(/"href":"([^"]*)"/g)].map(
        (m) => m[1]!,
      );
      expect(hrefs.length).toBeGreaterThan(0);
      expect(hrefs.filter((h) => / |\\u00a0/.test(h))).toEqual([]);
    }
    for (const r of reportOf(out, "md.autolinked")) {
      spaces += Number((r.data as { spacesAfterAddress?: number }).spacesAfterAddress ?? 0);
    }
    expect(spaces).toBe(3);
  });

  test("one line says how many entries show the space the build writes between inline siblings", async () => {
    for (const [name, gaps, of] of [
      ["fineline", 68, 112],
      ["ap", 90, 208],
    ] as const) {
      const out = await collectionsOf(name);
      expect(reportOf(out, "block.inline-gap")).toHaveLength(gaps);
      const summary = reportOf(out, "collection.inline-gap-summary");
      expect(summary).toHaveLength(1);
      expect(summary[0]!.severity).toBe("info");
      expect(summary[0]!.data).toEqual({ entries: gaps, of });
      expect(summary[0]!.message).toContain(`${gaps} entries of ${of}`);
    }
  });
});

describe("what the module depends on in the parser and in the pipeline around it", () => {
  test("the switch that turns directives on is a name the parser reads only as on or off: it parses every tag, none of which it names", async () => {
    // specs/parser.md says `$elements` are to become the allowed names of directives. The day the
    // parser enforces that, `div`, `sup` and `img` stop being parsed under `@jxsuite/parser` (a package
    // specifier, not a tag), and this test says so.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "wp2jx-switch-"));
    const file = join(dir, "e.md");
    writeFileSync(
      file,
      `---\ntitle: t\n---\n\n:::div{className=box}\nA:sup[1]\n\n::img{src="/a.png" alt="x"}\n:::\n`,
    );
    const [entry] = (await Markdown.load(file, {
      directiveOptions: { allowedNames: [DIRECTIVES_SWITCH] },
    } as never)) as unknown as { $children: N[] }[];
    const html = JSON.stringify(entry!.$children);
    expect(html).toContain('"tagName":"div"');
    expect(html).toContain('"tagName":"sup"');
    expect(html).toContain('"tagName":"img"');
    // Without the switch, the same source is text.
    const [off] = (await Markdown.load(file, {} as never)) as unknown as { $children: N[] }[];
    expect(JSON.stringify(off!.$children)).not.toContain('"tagName":"div"');
    // The version this was verified against: a new major is a reason to read specs/parser.md again.
    const version = (
      JSON.parse(
        readFileSync(
          join(import.meta.dir, "../../node_modules/@jxsuite/parser/package.json"),
          "utf8",
        ),
      ) as { version: string }
    ).version;
    expect(version).toMatch(/^1\./);
  });

  test("a body element that has a mapped list for its children is left out of the entry, and said", async () => {
    const site = await loadSite("fineline");
    await withQueryBody(
      () => [
        {
          tagName: "ul",
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/x" },
            map: { tagName: "li", textContent: "x" },
          },
        } as never,
        { tagName: "p", textContent: "kept paragraph" },
      ],
      async () => {
        const out = await buildCollections(site, { now: NOW, include: (p) => p.id === 3371 });
        const dropped = reportOf(out, "entry.dynamic-dropped");
        expect(dropped).toHaveLength(1);
        expect(dropped[0]!.data).toEqual({ elements: { children: 1 }, state: [] });
        expect(out.files[0]!.content).toContain("kept paragraph");
        expect(out.files[0]!.content).not.toContain("$prototype");
        expect(out.files[0]!.content).not.toContain(":::ul");
        expect(reportOf(out, "md.lossy")).toEqual([]);
      },
    );
  });

  test("a file whose first claimant could not be written is free for the next post that has the same address", async () => {
    const site = await loadSite("fineline");
    const hasQuery = (id: number): boolean =>
      site.model.posts.get(id)!.content.includes("cwicly/query");
    const services = site.routes
      .all()
      .filter((r) => r.kind === "entry" && r.type === "service")
      .sort((a, b) => Number(a.id) - Number(b.id));
    const first = services.find((r) => hasQuery(Number(r.id)))!;
    const second = services.find(
      (r) => !hasQuery(Number(r.id)) && Number(r.id) > Number(first.id),
    )!;
    const twin = { ...second, file: first.file };
    const altered = {
      ...site,
      routes: {
        ...site.routes,
        all: () => [...site.routes.all().filter((r) => r !== second), twin],
      } as SiteContext["routes"],
    } as SiteContext;
    await ensureConverters();
    const original = converters["cwicly/query"];
    registerConverters({
      "cwicly/query": () => [{ tagName: { $switch: "x", cases: ["a", "b"] } } as never],
    });
    try {
      const out = await buildCollections(altered, {
        now: NOW,
        include: (p) => p.id === Number(first.id) || p.id === Number(second.id),
      });
      expect(reportOf(out, "entry.failed").map((r) => r.where)).toEqual([`post:${first.id}`]);
      expect(reportOf(out, "collection.duplicate-file")).toEqual([]);
      expect(out.entries.map((e) => e.postId)).toEqual([Number(second.id)]);
      expect(out.entries[0]!.file).toBe(first.file);
    } finally {
      if (original === undefined) delete converters["cwicly/query"];
      else registerConverters({ "cwicly/query": original });
    }
  });
});

// ── A class the pages style otherwise, and what a Markdown body has no spelling for ──────────────

describe("an entry's rule for a class that a page, layout or component styles otherwise", () => {
  const el = (className: string, style: Record<string, unknown>): JxElement => ({
    tagName: "div",
    className,
    style: style as NonNullable<JxElement["style"]>,
    children: [{ tagName: "p", textContent: "Text." }],
  });
  const theirs = (selector: string, ...styles: Record<string, unknown>[]) =>
    new Map([[selector, new Set(styles.map((s) => JSON.stringify(sortDeep(s))))]]);
  const fit = (nodes: JxNode[], foreign: ReturnType<typeof theirs>) =>
    fitBody(nodes, undefined, "report", new Set(), foreign);

  test("what the page's rule contradicts moves to a rule one class more specific; the rest stays on the element", () => {
    const out = fit(
      [el("card", { padding: "5px", display: "flex", "@--sm": { width: "100%" } })],
      theirs(".card", { padding: "5px 5px 14px", display: "flex" }),
    );
    const [node] = out.nodes as JxElement[];
    expect(node?.className).toMatch(/^card jx-[0-9a-f]{10}$/);
    const cls = String(node?.className).split(" ")[1];
    expect(out.hoisted).toEqual([{ selector: `.card.${cls}`, style: { padding: "5px" } }]);
    // `display` agrees with the page's rule and `@--sm` is not in it: nothing contradicts them.
    expect(node?.style).toEqual({ display: "flex", "@--sm": { width: "100%" } });
    expect(out.notes.isolated).toBe(1);
  });

  test("a longhand against a shorthand is a contradiction, and so is a value inside a media block", () => {
    const out = fit(
      [el("card", { paddingBottom: "5px", "@--sm": { width: "100%", margin: "0" } })],
      theirs(".card", { padding: "5px 5px 14px", "@--sm": { width: "50%" } }),
    );
    const cls = String((out.nodes[0] as JxElement).className).split(" ")[1];
    expect(out.hoisted).toEqual([
      { selector: `.card.${cls}`, style: { paddingBottom: "5px", "@--sm": { width: "100%" } } },
    ]);
    expect((out.nodes[0] as JxElement).style).toEqual({ "@--sm": { margin: "0" } });
  });

  test("a declaration that wins at the top level wins in its media blocks too, and the blocks keep their order", () => {
    // The page's rule contradicts `display` only at the top. The winning rule is one class more
    // specific, so a `@--sm { display: flex }` left on the element would never override its grid.
    const style = {
      display: "grid",
      gap: "10px",
      "@--md": { display: "grid" },
      "@--sm": { display: "flex", margin: "0" },
    };
    const out = fit([el("grid", style)], theirs(".grid", { display: "flex" }));
    const cls = String((out.nodes[0] as JxElement).className).split(" ")[1];
    const rule = out.hoisted.find((r) => r.selector === `.grid.${cls}`);
    expect(rule?.style).toEqual({
      display: "grid",
      "@--md": { display: "grid" },
      "@--sm": { display: "flex" },
    });
    expect(Object.keys(rule!.style)).toEqual(["display", "@--md", "@--sm"]);
    expect((out.nodes[0] as JxElement).style).toEqual({ gap: "10px", "@--sm": { margin: "0" } });
  });

  test("a block the page's rule contradicts, and one that moved with a winner, stay in the order the style had them", () => {
    const style = {
      display: "grid",
      "@--md": { display: "grid" },
      "@--sm": { display: "flex", margin: "0" },
    };
    const out = fit(
      [el("grid", style)],
      theirs(".grid", { display: "flex", "@--sm": { margin: "5px" } }),
    );
    const cls = String((out.nodes[0] as JxElement).className).split(" ")[1];
    const rule = out.hoisted.find((r) => r.selector === `.grid.${cls}`);
    // `@--sm` won on its own (margin) and `@--md` came along with `display`: the narrow block stays last.
    expect(Object.keys(rule!.style)).toEqual(["display", "@--md", "@--sm"]);
    expect(rule?.style["@--sm"]).toEqual({ display: "flex", margin: "0" });
  });

  test("the same declarations are the same class in every entry, so the rule is written once", () => {
    const a = fit([el("card", { padding: "5px" })], theirs(".card", { padding: "9px" }));
    const b = fit([el("card", { padding: "5px" })], theirs(".card", { padding: "9px" }));
    expect(a.hoisted).toEqual(b.hoisted);
    const c = fit([el("card", { padding: "7px" })], theirs(".card", { padding: "9px" }));
    expect(c.hoisted[0]?.selector).not.toBe(a.hoisted[0]?.selector);
  });

  test("nothing changes when the pages do not style the class, or style it the same way and only that way", () => {
    const style = { padding: "5px" };
    const own = fit([el("card", style)], new Map());
    expect(own.hoisted).toEqual([]);
    expect((own.nodes[0] as JxElement).style).toEqual(style);
    const same = fit([el("card", style)], theirs(".card", style));
    expect(same.hoisted).toEqual([]);
    expect((same.nodes[0] as JxElement).style).toEqual(style);
    expect(same.notes.isolated).toBe(0);
    // A class the pages style with other properties only: nothing is contradicted, the element keeps its style.
    const apart = fit([el("card", style)], theirs(".card", { color: "red" }));
    expect(apart.hoisted).toEqual([]);
    expect((apart.nodes[0] as JxElement).style).toEqual(style);
  });

  test("a class the pages style the same way in one place and another way in a second is a clash: a project rule reaches both", () => {
    const style = { padding: "5px" };
    const out = fit([el("card", style)], theirs(".card", style, { padding: "9px" }));
    expect(out.hoisted).toHaveLength(1);
    expect(out.hoisted[0]?.selector).toMatch(/^\.card\.jx-[0-9a-f]{10}$/);
  });

  test("a class an element of the body carries beside its own is shared, and its rule keeps reaching them all", () => {
    const owner = el("featured-columns", { padding: "2rem" });
    const other = el("columns-c1 featured-columns", { display: "grid" });
    const out = fit([owner, other], theirs(".featured-columns", { padding: "1rem" }));
    expect(out.hoisted).toEqual([]);
    expect((out.nodes[0] as JxElement).style).toEqual({ padding: "2rem" });
  });

  test("an element with an id, or with no class, is left as it is: the build writes its style to the id or the tag", () => {
    const withId = { ...el("card", { padding: "5px" }), id: "x" };
    const out = fit([withId], theirs(".card", { padding: "1px" }));
    expect(out.hoisted).toEqual([]);
  });

  test("a heading's style, which moves to the project for want of an id the build could use, is scoped to this entry's elements; a small-screen override of what the page sets wins", () => {
    const heading: JxElement = {
      tagName: "h3",
      className: "heading-x",
      style: { padding: "2rem", "@--sm": { padding: "0rem", fontSize: "20px" } },
      textContent: "Title",
    };
    // The card in a template has the class too, with the same padding and no small-screen block: a
    // project rule would reach it, and its rule, written later in the page, would beat a media block.
    const out = fit([heading], theirs(".heading-x", { padding: "2rem" }));
    const classes = String((out.nodes[0] as JxElement).className).split(" ");
    expect(classes[0]).toBe("heading-x");
    expect(classes).toHaveLength(3);
    const byClass = (cls: string) => out.hoisted.find((r) => r.selector.includes(cls))!;
    expect(out.hoisted).toHaveLength(2);
    expect(byClass(classes[1]!).selector).toMatch(/^\.heading-x\.jx-[0-9a-f]{10}$/);
    expect(byClass(classes[1]!).style).toEqual({ "@--sm": { padding: "0rem" } });
    expect(byClass(classes[2]!).selector).toMatch(/^\.heading-x:where\(\.jx-[0-9a-f]{10}\)$/);
    expect(byClass(classes[2]!).style).toEqual({ padding: "2rem", "@--sm": { fontSize: "20px" } });
  });

  test("a custom property alone is never isolated: it is a part of the style, and nothing in the pages clashes with it", () => {
    const out = fit(
      [el("card", { "--gallery-height": "10px", padding: "5px" })],
      theirs(".card", { padding: "5px" }),
    );
    expect(out.hoisted).toEqual([{ selector: ".card", style: { "--gallery-height": "10px" } }]);
    expect((out.nodes[0] as JxElement).style).toEqual({ padding: "5px" });
    expect((out.nodes[0] as JxElement).className).toBe("card");
  });
});

describe("what the entries add to the project's style so that a Markdown body reads like the page", () => {
  test("fineline: the figure that carries has-fixed-layout gets WordPress's rule, and the item paragraph is taken out of the spacing", async () => {
    const out = await collectionsOf("fineline");
    const rules = out.used.hoisted.map((r) => r.selector);
    expect(rules).toContain(".wp-block-table.has-fixed-layout table");
    expect(rules).toContain("li > p, td > p, th > p, dd > p");
    const item = out.used.hoisted.find((r) => r.selector.startsWith("li > p"));
    expect(item?.style).toEqual(ITEM_PARAGRAPH_STYLE);
    expect(reportOf(out, "collection.item-paragraph-rule")).toHaveLength(1);
    expect(reportOf(out, "collection.fixed-layout-rule")).toHaveLength(1);
  });

  test("no rule for a paragraph that no entry holds: a project entry alone has no list", async () => {
    const site = await loadSite("fineline");
    const project = [...site.model.posts.values()].find(
      (p) => p.type === "project" && p.status === "publish" && !/<li\b|<td\b/i.test(p.content),
    )!;
    const out = await buildCollections(site, { now: NOW, include: (p) => p.id === project.id });
    expect(out.entries).toHaveLength(1);
    expect(out.used.hoisted.some((r) => r.selector.includes("li > p"))).toBe(false);
    expect(reportOf(out, "collection.item-paragraph-rule")).toEqual([]);
  });

  test("a site that has a paragraph in a list item itself keeps the space of its own", async () => {
    const site = await loadSite("fineline");
    const posts = new Map(site.model.posts);
    const sample = [...posts.values()].find((p) => p.type === "post")!;
    posts.set(sample.id, {
      ...sample,
      content: `${sample.content}\n<ul><li><!-- wp:paragraph --><p>kept</p></li></ul>`,
    });
    const edited = { ...site, model: { ...site.model, posts } } as SiteContext;
    const out = await buildCollections(edited, { now: NOW });
    const item = out.used.hoisted.find((r) => r.selector.includes("li > p"));
    expect(item).toBeUndefined();
    // The tags no page holds a paragraph in still have the rule.
    expect(out.used.hoisted.find((r) => r.selector.includes("td > p"))).toBeDefined();
  });
});

describe("the addresses in a rule a converter hoisted", () => {
  test("the live address of an upload in it is the project's own copy", async () => {
    const site = await loadSite("fineline");
    await ensureConverters();
    const original = converters["cwicly/query"];
    registerConverters({
      "cwicly/query": (_block, ctx) => {
        ctx.hoist?.({
          selector: ".zz-other .inner",
          style: {
            backgroundImage:
              "url(https://finelinepainting.pro/wp-content/uploads/swash-light-gray-vertical-flip-optimized.svg)",
          },
        });
        return [{ tagName: "div", className: "zz-other", textContent: "x" }];
      },
    });
    try {
      const withQuery = [...site.model.posts.values()].find(
        (p) => p.type === "service" && p.status === "publish" && p.content.includes("cwicly/query"),
      )!;
      const out = await buildCollections(site, { now: NOW, include: (p) => p.id === withQuery.id });
      const rule = out.used.hoisted.find((r) => r.selector === ".zz-other .inner");
      expect(rule).toBeDefined();
      expect(JSON.stringify(rule?.style)).toContain("url(/media/swash-light-gray");
      expect(JSON.stringify(rule?.style)).not.toContain("https://");
    } finally {
      if (original === undefined) delete converters["cwicly/query"];
      else registerConverters({ "cwicly/query": original });
    }
  });
});

describe("the addresses in a style", () => {
  for (const name of SITES) {
    test(`${name}: no style of an entry or of its hoisted rules names an upload by the live address`, async () => {
      const out = await collectionsOf(name);
      const live = /url\((?:https?:)?\/\/[^)]*wp-content\/uploads/i;
      expect(out.files.filter((f) => live.test(f.content)).map((f) => f.path)).toEqual([]);
      expect(out.used.hoisted.filter((r) => live.test(JSON.stringify(r.style)))).toEqual([]);
    });
  }

  test("fineline: the background images of the service entries are the project's own copies", async () => {
    const out = await collectionsOf("fineline");
    const mine = out.files.filter((f) => /style\.backgroundImage="url\(\/media\//.test(f.content));
    expect(mine.length).toBeGreaterThan(0);
  });
});

// ── What a post's templates read of a person and of an embedded player ───────────────────────────

describe("ap: the people and the players a post's templates read", () => {
  /** The site with one author who has a profile, and the two embed blocks of the site defined. */
  async function withProfileAndBlocks() {
    const loaded = await loadSite("ap");
    const authors = new Map<number, number>();
    for (const post of loaded.model.posts.values()) {
      if (post.type === "post") authors.set(post.authorId, (authors.get(post.authorId) ?? 0) + 1);
    }
    const [authorId] = [...authors].sort((a, b) => b[1] - a[1])[0]!;
    const user = loaded.model.users.get(authorId)!;
    const posts = new Map(loaded.model.posts);
    const postMeta = new Map(loaded.model.postMeta);
    const lazy = { id: 990001, type: "lazyblocks", status: "publish", title: "Audio" } as WpPost;
    posts.set(lazy.id, lazy);
    postMeta.set(lazy.id, {
      lazyblocks_slug: ["episode-audio-embed"],
      lazyblocks_code_frontend_html: [AUDIO_PHP],
    });
    const model = { ...loaded.model, posts, postMeta } as typeof loaded.model;
    // (The profiles are kept beside the model object they were read for: a copy needs its own.)
    setUserProfiles(
      model,
      new Map([
        [
          authorId,
          {
            ...user,
            meta: {
              position: "Contributor",
              _position: "field_62fea1aa7c14c",
              description: "A biography.",
              first_name: "Given",
              last_name: "",
            },
            roles: [],
          },
        ],
      ]),
    );
    const site = { ...loaded, model } as SiteContext;
    const out = await buildCollections(site, { now: NOW });
    return { site, out, authorId };
  }

  test("the schema of every collection allows the keys the templates read; `captivate` only where entries carry it", async () => {
    const { out } = await withProfileAndBlocks();
    for (const def of Object.values(out.collections)) {
      expect(def.schema.properties).toMatchObject({ postType: { type: "string" } });
    }
    for (const [name, def] of Object.entries(out.collections)) {
      const carries = out.entries.some(
        (e) => e.collection === name && e.frontmatter.captivate !== undefined,
      );
      expect(Object.hasOwn(def.schema.properties, "captivate")).toBe(carries);
    }
    expect(out.entries.some((e) => e.frontmatter.captivate !== undefined)).toBe(true);
  });

  test("an author's names and biography are in the entries they wrote (`authorInfo`), and in nobody else's", async () => {
    const { site, out, authorId } = await withProfileAndBlocks();
    let mine = 0;
    for (const e of out.entries) {
      if (site.model.posts.get(e.postId)!.authorId === authorId) {
        // (An empty name is not written.)
        expect(e.frontmatter.authorInfo).toEqual({
          description: "A biography.",
          first_name: "Given",
        });
        mine++;
      } else expect(e.frontmatter.authorInfo).toBeUndefined();
    }
    expect(mine).toBeGreaterThan(5);
    for (const [name, def] of Object.entries(out.collections)) {
      const carries = out.entries.some(
        (e) => e.collection === name && e.frontmatter.authorInfo !== undefined,
      );
      expect(Object.hasOwn(def.schema.properties, "authorInfo")).toBe(carries);
    }
  });

  test("an episode that names a podcast post with a Captivate id carries it, and no other entry does", async () => {
    const { site, out } = await withProfileAndBlocks();
    let carried = 0;
    for (const e of out.entries) {
      const meta = site.model.postMeta.get(e.postId) ?? {};
      const linked = Number(meta.captivate_episode?.[0]);
      const id = site.model.postMeta.get(linked)?.cfm_episode_id?.[0];
      if (typeof id === "string" && id !== "") {
        const media = site.model.postMeta.get(linked)?.cfm_episode_media_url?.[0];
        expect(e.frontmatter.captivate).toEqual({
          episodeId: id,
          ...(media ? { downloadUrl: `${String(media)}?download=1` } : {}),
        });
        carried++;
      } else expect(e.frontmatter.captivate).toBeUndefined();
    }
    expect(carried).toBeGreaterThan(5);
  });
});
