/**
 * html.ts against the real Jx build. Every fragment of real markup in the fixtures (the body of each
 * rendered page, the saved HTML of each block in the database rows, the classic-editor posts) is
 * converted, placed in a layout-free Jx page, built with `jx build`, and the built markup is compared
 * with the original through `canon` below.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeJxMarkdown } from "@jxsuite/parser/serialize";
import { transpileJxMarkdown } from "@jxsuite/parser/transpile";
import { parse as parseBlocks } from "@wordpress/block-serialization-default-parser";
import type { Element as HastElement, Nodes as HastNodes } from "hast";
import { fromHtml } from "hast-util-from-html";
import type { DefaultTreeAdapterMap } from "parse5";
import { parse as parseDocument, parseFragment } from "parse5";
import postcss from "postcss";
import { find, html as htmlSchema, normalize } from "property-information";
import { htmlToContent, htmlToNodes, nodesToHtml } from "../src/html.ts";
import type { HtmlOptions } from "../src/html.ts";
import type { JxElement, JxNode, Report, ReportEntry } from "../src/types.ts";
import { FIXTURES } from "./helpers/fixture-db.ts";
import {
  buildJxProject,
  cleanupJxProjects,
  TMP_ROOT,
  validateJxProject,
  writeJxProject,
} from "./helpers/jx-build.ts";

// A build of every real fragment, and the comparison, take seconds, not milliseconds.
setDefaultTimeout(120_000);
afterAll(cleanupJxProjects);

// ── The real fragments ───────────────────────────────────────────────────────────────────────────

interface Fragment {
  id: string;
  kind: "page" | "block" | "classic";
  site: string;
  /** The page file, the block name, or `<post type>:<id>`. */
  name: string;
  html: string;
  /** How many times this exact markup occurs in the fixtures. */
  count: number;
}

/**
 * The body of a rendered page with script, style and noscript cut out, as source text: element
 * positions from the parser say where each one starts and ends, so nothing is re-serialised.
 */
function pageBody(source: string): string {
  const cuts: [number, number][] = [];
  let body: HastElement | undefined;
  const walk = (node: HastNodes): void => {
    if (node.type === "element") {
      if (node.tagName === "body") body = node;
      if (["script", "style", "noscript"].includes(node.tagName) && node.position) {
        cuts.push([node.position.start.offset ?? 0, node.position.end.offset ?? 0]);
        return;
      }
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(fromHtml(source));
  const first = body?.children[0]?.position?.start.offset;
  const last = body?.children.at(-1)?.position?.end.offset;
  if (first === undefined || last === undefined) throw new Error("page has no body content");
  let out = "";
  let at = first;
  for (const [start, end] of cuts
    .filter(([s]) => s >= first && s < last)
    .sort((a, b) => a[0] - b[0])) {
    out += source.slice(at, start);
    at = end;
  }
  return out + source.slice(at, last);
}

/** Post types whose content is markup (the rest hold PHP, CSS or nothing). */
const CONTENT_TYPES = new Set([
  "page",
  "post",
  "project",
  "service",
  "episode",
  "captivate_podcast",
  "supporters_update",
  "wp_template",
  "wp_template_part",
  "cc_block",
  "wp_block",
  "wp_navigation",
]);

function loadFragments(): Fragment[] {
  const unique = new Map<string, Fragment>();
  const add = (fragment: Omit<Fragment, "id" | "count">): void => {
    const key = `${fragment.kind}\0${fragment.html}`;
    const known = unique.get(key);
    if (known) known.count++;
    else
      unique.set(key, {
        ...fragment,
        id: `${fragment.site}:${fragment.kind}:${unique.size}`,
        count: 1,
      });
  };
  for (const site of ["fineline", "ap"]) {
    const pages = join(FIXTURES, site, "html");
    for (const file of readdirSync(pages).sort()) {
      add({
        kind: "page",
        site,
        name: file,
        html: pageBody(readFileSync(join(pages, file), "utf8")),
      });
    }
    const rows = JSON.parse(readFileSync(join(FIXTURES, site, "rows/posts.json"), "utf8")) as {
      ID: number;
      post_type: string;
      post_content: string | null;
    }[];
    for (const row of rows) {
      const content = row.post_content ?? "";
      if (!CONTENT_TYPES.has(row.post_type)) continue;
      if (content.includes("<!-- wp:")) {
        const walk = (blocks: ReturnType<typeof parseBlocks>): void => {
          for (const block of blocks) {
            if (block.blockName && block.innerHTML.trim()) {
              add({ kind: "block", site, name: block.blockName, html: block.innerHTML });
            }
            walk(block.innerBlocks);
          }
        };
        walk(parseBlocks(content));
      } else if (content.includes("<")) {
        add({ kind: "classic", site, name: `${row.post_type}:${row.ID}`, html: content });
      }
    }
  }
  return [...unique.values()];
}

// ── The oracle ───────────────────────────────────────────────────────────────────────────────────
//
// Two HTML trees are the same page when `canon` renders them to the same string. It keeps every tag,
// every attribute name and value, and every character of text. It does not keep what the build is
// documented to change, or what no browser can tell apart:
//
//  - comments;
//  - the `style` attribute (the build moves inline styles into a stylesheet; `checkStyles` compares
//    those against the stylesheet instead), and so the `display` an inline style sets, which is
//    read from the original and lent to the built tree element for element;
//  - the order and repetition of classes, and the `jx-*` classes the build and html.ts generate;
//  - `class=""` and `id=""` against no attribute; a boolean attribute spelled `x` or `x="x"`;
//  - Unicode normalisation: the build puts every string in NFC (U+2000 becomes U+2002);
//  - whitespace as a browser collapses it: runs become one space, a space at a line edge goes (the
//    edge of a block, a `<br>`, the inside of a button), and two spaces that meet across inline
//    tags are one. The build separates sibling children with a newline and two spaces, so this is
//    what lets it be compared at all; it is also what notices a separator that SHOWS;
//
// A collapsible space keeps its side of an inline tag: `Interior<a> Painting</a>` and
// `Interior <a>Painting</a>` are different pages (the link is a space wider), and the build turns the
// first into the second whenever it separates the two siblings, which is why html.ts keeps such an
// element's content as markup.
//
// What it does not do is look at CSS, so a class that makes a `<span>` a block is invisible to it.
//
// Its model of whitespace was checked against a real browser, not only against itself: Chrome 154,
// scripts and remote resources blocked, original and built pages side by side in iframes, compared
// element for element on `innerText`, on every element's box (to 0.01px), and on the computed value
// of every inline-style declaration. With the converter as it is, all 7,543 fragments (27,895
// elements) matched on all three; with `inlineGaps: "children"`, 853 differed, which is also the
// number this oracle reports. That run is not part of the suite (it needs a browser).

type P5 = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];

const NS_HTML = "http://www.w3.org/1999/xhtml";
const words = (list: string): Set<string> => new Set(list.split(" "));
const BLOCK = words(
  "address article aside blockquote body caption center col colgroup dd details dir div dl dt " +
    "fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr html legend li " +
    "main menu nav ol optgroup option p pre search section summary table tbody td tfoot th thead tr ul",
);
const NOT_RENDERED = words(
  "area base datalist head link meta noscript param rp script source style template title track",
);
const ATOM = words("audio canvas embed iframe img input math meter object progress svg video");
const INLINE_BLOCK = words("button select");
const PREFORMATTED = words("pre textarea listing plaintext xmp");
const VOID = words("area base br col embed hr img input link meta param source track wbr");
const SVG_TEXT = words("text tspan textPath title desc a foreignObject");

const isElement = (node: P5): node is P5Element => "tagName" in node;
const childrenOf = (el: P5Element): P5[] =>
  el.tagName === "template" && el.namespaceURI === NS_HTML
    ? (el as DefaultTreeAdapterMap["template"]).content.childNodes
    : el.childNodes;
const attr = (el: P5Element, name: string): string | undefined =>
  el.attrs.find((a) => a.name === name)?.value;

/**
 * B block, R line break, I inline, A atom (an inline box that is one unit), X inline-block (one unit
 * outside, a line of its own inside), H not rendered.
 */
function kindOf(el: P5Element): string {
  const display = /(?:^|;)\s*display\s*:\s*([a-z-]+)/i
    .exec(attr(el, "style") ?? "")?.[1]
    ?.toLowerCase();
  if (display === "none") return "H";
  if (display?.startsWith("inline-")) return "X";
  if (display === "inline" || display === "contents") return "I";
  if (display) return "B";
  const tag = el.tagName;
  if (el.namespaceURI !== NS_HTML) return tag === "svg" || tag === "math" ? "A" : "I";
  if (tag === "br") return "R";
  const hidden = attr(el, "hidden");
  if (hidden !== undefined && hidden.toLowerCase() !== "until-found") return "H";
  if (tag === "input" && attr(el, "type")?.toLowerCase() === "hidden") return "H";
  if (tag === "dialog") return attr(el, "open") === undefined ? "H" : "B";
  if (NOT_RENDERED.has(tag)) return "H";
  if (INLINE_BLOCK.has(tag)) return "X";
  if (ATOM.has(tag)) return "A";
  return BLOCK.has(tag) ? "B" : "I";
}

const nfc = (s: string): string => s.normalize("NFC");
const escapeTag = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

function attributesOf(el: P5Element): string {
  const out: [string, string][] = [];
  for (const a of el.attrs) {
    const name = nfc(a.prefix ? `${a.prefix}:${a.name}` : a.name);
    let value = nfc(a.value);
    if (name === "style") continue;
    if (name === "class") {
      const classes = [
        ...new Set(value.split(/[ \t\n\f\r]+/).filter((c) => c && !c.startsWith("jx-"))),
      ];
      if (classes.length === 0) continue;
      value = classes.sort().join(" ");
    } else if (name === "id" && value === "") {
      continue;
    } else if (el.namespaceURI === NS_HTML) {
      // `find` looks names up in plain objects: `constructor` and `__proto__` come back as nothing.
      const info = find(htmlSchema, name) as ReturnType<typeof find> | undefined;
      if (
        (info?.boolean || info?.overloadedBoolean) &&
        normalize(value) === normalize(info.attribute)
      ) {
        value = "";
      }
    }
    out.push([name, value]);
  }
  out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return out.map(([name, value]) => ` ${name}="${escapeTag(value)}"`).join("");
}

interface Walk {
  /** Kinds lent by the original, in document order (see the header). */
  lent: string[] | undefined;
  seen: string[];
  /** What is not rendered, compared on its own: it is still content. */
  hidden: string[];
}

function tokens(nodes: P5[], preserved: boolean, shapes: boolean, out: string[], walk: Walk): void {
  for (const node of nodes) {
    if (node.nodeName === "#text") {
      const value = nfc((node as DefaultTreeAdapterMap["textNode"]).value);
      if (shapes && value.trim() === "") continue;
      const text = value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      // Preserved whitespace is swapped for symbols so the collapsing below cannot touch it.
      out.push(
        preserved
          ? text.replaceAll(" ", "␠").replaceAll("\n", "␤").replaceAll("\t", "␉")
          : text.replaceAll(/[ \t\n\f\r]+/g, " "),
      );
    } else if (isElement(node)) {
      const tag = node.tagName;
      const html = node.namespaceURI === NS_HTML;
      const own = kindOf(node);
      const kind = walk.lent?.[walk.seen.length] ?? own;
      walk.seen.push(own);
      const keep =
        preserved ||
        (html && PREFORMATTED.has(tag)) ||
        /(?:^|;)\s*white-space\s*:\s*pre/i.test(attr(node, "style") ?? "");
      const target = kind === "H" ? [] : out;
      target.push(`<${kind}:${tag}${attributesOf(node)}>`);
      if (!(html && VOID.has(tag))) {
        tokens(childrenOf(node), keep, !html && !SVG_TEXT.has(tag), target, walk);
        target.push(`</${kind}:${tag}>`);
      }
      if (kind === "H") walk.hidden.push(collapse(target.join("")));
    }
  }
}

/** Collapse whitespace across the token string the way a browser lays out a line. */
function collapse(tokenText: string): string {
  const inline = String.raw`</?I:[^>]*>`;
  const run = `(?:${inline})*`;
  const breakTag = String.raw`</?[BR]:[^>]*>`;
  const start = new RegExp(`(${breakTag}|<X:[^>]*>|<#root>)(${run}) +`, "g");
  const end = new RegExp(` +(${run})(${breakTag}|</X:[^>]*>|</#root>)`, "g");
  const middle = new RegExp(` (${run}) `, "g");
  let text = `<#root>${tokenText}</#root>`;
  for (let i = 0; i < 20; i++) {
    const before = text;
    text = text.replace(start, "$1$2").replace(end, "$1$2").replace(middle, " $1");
    if (text === before) break;
  }
  return text.replace(/<\/?#root>/g, "");
}

interface Canon {
  text: string;
  /** The kind of every element, in document order, for lending to the built tree. */
  kinds: string[];
}

function canon(nodes: P5[], lent?: string[]): Canon {
  const walk: Walk = { lent, seen: [], hidden: [] };
  const out: string[] = [];
  tokens(nodes, false, false, out, walk);
  return { text: [collapse(out.join("")), ...walk.hidden].join("\u0001"), kinds: walk.seen };
}

const fragmentNodes = (html: string): P5[] =>
  parseFragment(html, { scriptingEnabled: false }).childNodes;

/** What a fragment's original markup is, worked out once however many builds compare against it. */
const originals = new Map<string, { nodes: P5[]; canon: Canon }>();
function original(fragment: Fragment): { nodes: P5[]; canon: Canon } {
  let known = originals.get(fragment.id);
  if (!known) {
    const nodes = fragmentNodes(fragment.html);
    known = { nodes, canon: canon(nodes) };
    originals.set(fragment.id, known);
  }
  return known;
}

function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const window = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 50), i + 70));
  return `at ${i}\n  original: ${window(a)}\n  built:    ${window(b)}`;
}

// ── Elements in document order, for aligning an original with its build ─────────────────────────

function elementsOf(nodes: P5[]): P5Element[] {
  const out: P5Element[] = [];
  const walk = (list: P5[]): void => {
    for (const node of list) {
      if (!isElement(node)) continue;
      out.push(node);
      walk(childrenOf(node));
    }
  };
  walk(nodes);
  return out;
}

// ── Building fragments ───────────────────────────────────────────────────────────────────────────

const PER_PAGE = 400;
/** No image rewriting: the converter's `<img>` must come out as it went in. */
const PROJECT = {
  name: "round-trip",
  url: "https://example.com",
  images: { optimize: false, lazyLoad: false },
};

type Convert = (fragment: Fragment) => Pick<JxElement, "children" | "textContent" | "innerHTML">;

interface Outcome {
  fragment: Fragment;
  /** Which built page it was on. */
  page: number;
  ok: boolean;
  difference: string;
  elements: number;
  original: P5[];
  built: P5[];
}

interface RoundTrip {
  outcomes: Outcome[];
  dir: string;
  pages: number;
  /** The `<style>` text of each page, by page index. */
  styles: string[];
}

async function roundTrip(fragments: Fragment[], convert: Convert): Promise<RoundTrip> {
  const pages: Fragment[][] = [];
  fragments.forEach((fragment, i) => {
    (pages[Math.floor(i / PER_PAGE)] ??= []).push(fragment);
  });
  const files: Record<string, object> = { "project.json": PROJECT };
  pages.forEach((page, p) => {
    files[`pages/p${p}.json`] = {
      children: page.map((fragment) => ({
        tagName: "div",
        attributes: { "data-frag": fragment.id },
        ...convert(fragment),
      })),
    };
  });
  const site = await buildJxProject(files, { name: "round-trip" });

  const outcomes: Outcome[] = [];
  const styles: string[] = [];
  for (let p = 0; p < pages.length; p++) {
    const document = parseDocument(site.html(`/p${p}/`), { scriptingEnabled: false });
    const wrappers = new Map<string, P5Element>();
    const styleText: string[] = [];
    const walk = (node: P5): void => {
      if (isElement(node)) {
        const id = attr(node, "data-frag");
        if (id !== undefined) wrappers.set(id, node);
        if (node.tagName === "style") {
          styleText.push(node.childNodes.map((c) => ("value" in c ? c.value : "")).join(""));
        }
      }
      for (const child of "childNodes" in node ? node.childNodes : []) walk(child);
    };
    walk(document);
    styles.push(styleText.join("\n"));
    for (const fragment of pages[p] ?? []) {
      const { nodes: before, canon: expected } = original(fragment);
      const wrapper = wrappers.get(fragment.id);
      const built = wrapper ? wrapper.childNodes : [];
      const actual = wrapper ? canon(built, expected.kinds).text : "(no wrapper in the built page)";
      outcomes.push({
        fragment,
        page: p,
        ok: expected.text === actual,
        difference: expected.text === actual ? "" : firstDifference(expected.text, actual),
        elements: expected.kinds.length,
        original: before,
        built,
      });
    }
  }
  return { outcomes, dir: site.dir, pages: pages.length, styles };
}

const asNodes: (options?: HtmlOptions) => Convert = (options) => (fragment) => {
  const nodes = htmlToNodes(fragment.html, options);
  return nodes.length > 0 ? { children: nodes } : {};
};
const asContent: (options?: HtmlOptions) => Convert = (options) => (fragment) =>
  htmlToContent(fragment.html, options);

const failures = (trip: RoundTrip): Outcome[] => trip.outcomes.filter((o) => !o.ok);
const describeFailures = (trip: RoundTrip, limit = 8): string =>
  failures(trip)
    .slice(0, limit)
    .map((o) => `${o.fragment.id} ${o.fragment.kind} ${o.fragment.name}\n  ${o.difference}`)
    .join("\n");

// ── Inline styles against the built stylesheet ──────────────────────────────────────────────────

/** Declarations as the cascade leaves them: property to `value` or `value !important`. */
function cascade(
  declarations: Iterable<{ prop: string; value: string; important: boolean }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const { prop, value, important } of declarations) {
    const name = prop.startsWith("--") ? prop : prop.toLowerCase();
    if (out.get(name)?.endsWith("!important") && !important) continue;
    out.set(name, important ? `${value} !important` : value);
  }
  return out;
}

function declarationsOf(text: string): Map<string, string> {
  const found: { prop: string; value: string; important: boolean }[] = [];
  postcss
    .parse(`a{${text}}`)
    .walkDecls((d) => void found.push({ prop: d.prop, value: d.value, important: d.important }));
  return cascade(found);
}

/**
 * Rule bodies by selector, in stylesheet order. The build writes one `selector { declarations }` per
 * line and does not escape the selector, so an id that still holds a Cwicly token (`#x{idadd}`)
 * is not CSS a stylesheet parser would take; the lines are split by hand and only their bodies parsed.
 */
function rulesOf(css: string): Map<string, Map<string, string>> {
  const found = new Map<string, { prop: string; value: string; important: boolean }[]>();
  for (const line of css.split("\n")) {
    const match = /^(\S.*?) \{ (.*) \}$/.exec(line);
    if (!match) continue;
    const list = found.get(match[1] as string) ?? [];
    postcss
      .parse(`a{${match[2]}}`)
      .walkDecls((d) => void list.push({ prop: d.prop, value: d.value, important: d.important }));
    found.set(match[1] as string, list);
  }
  return new Map([...found].map(([selector, list]) => [selector, cascade(list)]));
}

/** A selector a stylesheet parser reads as one `#id` or `.class`. */
const SIMPLE_SELECTOR = /^[#.](?:-?[_a-zA-Z]|--)[_a-zA-Z0-9-]*$/;

interface StyleCheck {
  checked: number;
  skipped: number;
  problems: string[];
}

/**
 * Every element that had an inline style, matched to its built element by position: its
 * declarations must be the ones the build wrote for it, in the stylesheet under `#id` or
 * `.firstClass`, or still inline where the markup stayed raw.
 */
function checkStyles(trip: RoundTrip): StyleCheck {
  const result: StyleCheck = { checked: 0, skipped: 0, problems: [] };
  const rules = trip.styles.map(rulesOf);
  // An id used by several styled elements on a page shares one rule; its rule cannot be told apart.
  const idUses = new Map<string, number>();
  for (const outcome of trip.outcomes) {
    for (const el of elementsOf(outcome.original)) {
      const id = attr(el, "id");
      if (!id || !attr(el, "style")) continue;
      const key = `${outcome.page}\0${id}`;
      idUses.set(key, (idUses.get(key) ?? 0) + 1);
    }
  }
  for (const outcome of trip.outcomes) {
    if (!outcome.ok) continue;
    const originals = elementsOf(outcome.original);
    const builts = elementsOf(outcome.built);
    if (originals.length !== builts.length) continue;
    originals.forEach((el, i) => {
      const text = attr(el, "style");
      if (text === undefined || text.trim() === "") return;
      const built = builts[i] as P5Element;
      const expected = declarationsOf(text);
      const id = attr(built, "id");
      const first = attr(built, "class")?.split(/\s+/)[0];
      const own = attr(built, "style");
      let actual: Map<string, string> | undefined;
      if (own !== undefined) {
        actual = declarationsOf(own);
      } else if (id) {
        if ((idUses.get(`${outcome.page}\0${id}`) ?? 0) > 1) {
          result.skipped++;
          return;
        }
        actual = rules[outcome.page]?.get(`#${id}`);
        if (!SIMPLE_SELECTOR.test(`#${id}`)) {
          result.problems.push(`${outcome.fragment.id} <${el.tagName}> #${id} is not a selector`);
        }
      } else if (first) {
        actual = rules[outcome.page]?.get(`.${first}`);
        if (!SIMPLE_SELECTOR.test(`.${first}`)) {
          result.problems.push(
            `${outcome.fragment.id} <${el.tagName}> .${first} is not a selector`,
          );
        }
      }
      result.checked++;
      if (!actual || JSON.stringify([...actual]) !== JSON.stringify([...expected])) {
        result.problems.push(
          `${outcome.fragment.id} <${el.tagName}> style="${text}" built as ${JSON.stringify(actual ? [...actual] : actual)}`,
        );
      }
    });
  }
  return result;
}

// ── The tests ────────────────────────────────────────────────────────────────────────────────────

const fragments = loadFragments();

describe("the fragments", () => {
  test("cover both sites: pages, blocks and classic posts", () => {
    const count = (kind: string, site?: string): number =>
      fragments.filter((f) => f.kind === kind && (!site || f.site === site)).length;
    expect(count("page", "fineline")).toBe(6);
    expect(count("page", "ap")).toBe(6);
    expect(count("block", "fineline")).toBeGreaterThan(3000);
    expect(count("block", "ap")).toBeGreaterThan(2000);
    expect(count("classic")).toBeGreaterThan(50);
    // Real block markup is mostly Cwicly and core blocks; the corpus has both.
    expect(fragments.some((f) => f.name.startsWith("cwicly/"))).toBe(true);
    expect(fragments.some((f) => f.name.startsWith("core/"))).toBe(true);
  });
});

/** Run once, on first use: a build of every fragment takes about a second. */
const lazy = <T>(make: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => (pending ??= make());
};

describe("a real build of every real fragment", () => {
  const svgFragments = fragments.filter((f) => f.html.includes("<svg"));
  const nodes = lazy(() => roundTrip(fragments, asNodes()));
  const content = lazy(() => roundTrip(fragments, asContent()));
  // A quarter of the fragments is plenty to show the separator at work.
  const sample = fragments.filter((_, i) => i % 4 === 0);
  const children = lazy(() => roundTrip(sample, asNodes({ inlineGaps: "children" })));
  const tree = lazy(() => roundTrip(svgFragments, asNodes({ svg: "tree" })));

  test("htmlToNodes: every fragment builds to the markup it came from", async () => {
    const trip = await nodes();
    expect(trip.outcomes).toHaveLength(fragments.length);
    expect(describeFailures(trip)).toBe("");
    // Enough was compared for "all of it matched" to mean something.
    expect(trip.outcomes.reduce((sum, o) => sum + o.elements, 0)).toBeGreaterThan(20_000);
    expect(trip.outcomes.every((o) => o.original.length > 0)).toBe(true);
  });

  test("htmlToContent: filling the element the content belongs to is as exact", async () => {
    expect(describeFailures(await content())).toBe("");
  });

  test("the oracle can tell: structured children alone fail on the build's separator", async () => {
    const failed = failures(await children());
    // About one fragment in nine has inline siblings the separator pulls apart. If this ever
    // stops failing, Jx has fixed the separator and `inlineGaps` can go.
    expect(failed.length).toBeGreaterThan(sample.length / 20);
    expect(failed.length).toBeLessThan(sample.length / 4);
    // Everything the guard fixes, and nothing else: with it on, none of these fail.
    const guarded = new Set(failures(await nodes()).map((o) => o.fragment.id));
    expect(failed.every((o) => !guarded.has(o.fragment.id))).toBe(true);
    // The Jx build puts a space before the full stop after a link or emphasis.
    expect(failed.some((o) => /<\/(?:a|em|strong)>[^<\s]/.test(o.fragment.html))).toBe(true);
  });

  test("svg: tree builds every fragment with an svg to the markup it came from", async () => {
    expect(svgFragments.length).toBeGreaterThan(50);
    expect(describeFailures(await tree())).toBe("");
    // The tree passes the schema too, namespaced attribute names and all.
    expect((await validateJxProject((await tree()).dir)).problems).toEqual([]);
    // And it really is a tree: no svg element carries its shapes as a string.
    const holdsMarkup = (node: JxNode): boolean =>
      typeof node !== "string" &&
      ((node.tagName === "svg" && node.innerHTML !== undefined) ||
        (Array.isArray(node.children) && node.children.some(holdsMarkup)));
    for (const fragment of svgFragments) {
      expect(htmlToNodes(fragment.html, { svg: "tree" }).some(holdsMarkup)).toBe(false);
    }
  });

  test("without the generated class the real comment avatars share one rule and all show the last", async () => {
    // ap: every comment's avatar is `div.div-comment-avatar` with its own `--background-image`.
    const avatars = fragments.filter((f) => f.html.includes("div-comment-avatar"));
    const urls = new Set(
      avatars.flatMap((f) =>
        [...f.html.matchAll(/--background-image:url\(([^)]*)\)/g)].map((m) => m[1]),
      ),
    );
    expect(urls.size).toBeGreaterThan(5);
    const leaking = checkStyles(await roundTrip(avatars, asNodes({ scopeStyle: false })));
    expect(leaking.problems.length).toBeGreaterThan(0);
    expect(checkStyles(await roundTrip(avatars, asNodes())).problems).toEqual([]);
  });

  test("inline styles come out of the build as the same declarations", async () => {
    const check = checkStyles(await nodes());
    expect(check.problems).toEqual([]);
    expect(check.checked).toBeGreaterThan(50);
    expect(checkStyles(await content()).problems).toEqual([]);
  });

  test("the built project passes jx validate", async () => {
    const result = await validateJxProject((await nodes()).dir);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("the converter reports nothing for any of it", () => {
    const entries: ReportEntry[] = [];
    const report: Report = { add: (entry) => void entries.push(entry), entries: () => entries };
    for (const fragment of fragments) htmlToNodes(fragment.html, { report, where: fragment.id });
    expect(entries).toEqual([]);
  });
});

describe("what the Jx build does that html.ts is written around", () => {
  const page = (...children: JxNode[]) => ({ "pages/index.json": { children } });
  const body = (html: string): string =>
    html.slice(html.indexOf("<body>"), html.indexOf("</body>"));

  test("it separates sibling children with a newline and two spaces, so inline markup gains a space", async () => {
    const children: JxNode[] = [
      { tagName: "p", children: ["Hello ", { tagName: "strong", textContent: "bold" }, "."] },
    ];
    const site = await buildJxProject(page(...children));
    expect(body(site.html("/"))).toContain("<strong>bold</strong>\n  .");
    // html.ts keeps such an element's content as markup, which the build writes as it is.
    const guarded = htmlToNodes("<p>Hello <strong>bold</strong>.</p>");
    const built = await buildJxProject(page(...guarded));
    expect(body(built.html("/"))).toContain("<p>Hello <strong>bold</strong>.</p>");
  });

  test("it HTML-escapes the text of script and style, which no parser decodes there", async () => {
    const source = `if (a < b && c) { x = "q"; }`;
    const site = await buildJxProject(
      page({ tagName: "script", textContent: source }, { tagName: "script", innerHTML: source }),
    );
    const html = body(site.html("/"));
    expect(html).toContain("if (a &lt; b &amp;&amp; c) { x = &quot;q&quot;; }");
    expect(html).toContain(`<script>${source}</script>`);
    // html.ts writes raw-text content as innerHTML.
    const built = await buildJxProject(
      page(...htmlToNodes(`<style>a > b { content: "x" }</style><script>${source}</script>`)),
    );
    expect(body(built.html("/"))).toContain(`<style>a > b { content: "x" }</style>`);
    expect(body(built.html("/"))).toContain(`<script>${source}</script>`);
  });

  test("it scopes an element's own style to its first class, so a shared class leaks", async () => {
    const avatar = (n: number): JxElement => ({
      tagName: "div",
      className: "avatar",
      style: { "--background-image": `url(https://x.test/${n}.jpg)` },
    });
    const leaking = await buildJxProject(page(avatar(1), avatar(2)));
    const css = leaking.html("/");
    expect(css).toContain(".avatar { --background-image: url(https://x.test/1.jpg) }");
    expect(css).toContain(".avatar { --background-image: url(https://x.test/2.jpg) }");
    // html.ts gives each its own first class, so each keeps its own style.
    const markup = (n: number) =>
      `<div class="avatar" style="--background-image:url(https://x.test/${n}.jpg)"></div>`;
    const scoped = await buildJxProject(page(...htmlToNodes(markup(1) + markup(2))));
    const scopedCss = scoped.html("/");
    expect(scopedCss).not.toContain(".avatar {");
    const rules = [
      ...scopedCss.matchAll(
        /^\.(jx-[0-9a-f]+) \{ --background-image: url\(https:\/\/x\.test\/(\d)\.jpg\) \}$/gm,
      ),
    ];
    expect(rules.map((m) => m[2])).toEqual(["1", "2"]);
    expect(new Set(rules.map((m) => m[1])).size).toBe(2);
    expect(body(scopedCss)).toContain(`class="${rules[0]?.[1]} avatar"`);
  });
});

describe("a newline that starts a pre", () => {
  const page = (...children: JxNode[]) => ({ "pages/index.json": { children } });

  test("the Jx emitter writes it once, and the parser drops it", async () => {
    // `<pre>\n\nx</pre>` has the text "\nx". Serialising that takes two newlines, since the parser
    // skips the first; the static emitter writes one, so the blank line disappears.
    const site = await buildJxProject(page({ tagName: "pre", textContent: "\nx" }));
    expect(site.html("/")).toContain("<pre>\nx</pre>");
  });

  test("html.ts holds such a pre's content as markup, written with the second newline", async () => {
    for (const tag of ["pre", "textarea", "listing"]) {
      const markup = `<${tag}>\n\n  x</${tag}>`;
      const nodes = htmlToNodes(markup);
      expect(nodes).toEqual([{ tagName: tag, innerHTML: "\n\n  x" }]);
      const site = await buildJxProject(page(...nodes));
      expect(site.html("/")).toContain(`<${tag}>\n\n  x</${tag}>`);
      const built = fragmentNodes(site.html("/").slice(site.html("/").indexOf("<body>")));
      const text = (el: P5Element): string =>
        el.childNodes.map((n) => ("value" in n ? n.value : "")).join("");
      expect(text(elementsOf(built).find((el) => el.tagName === tag) as P5Element)).toBe("\n  x");
    }
  });
});

describe("inline styles that cannot be rules", () => {
  const page = (...children: JxNode[]) => ({ "pages/index.json": { children } });
  const document = (html: string) => html.slice(html.indexOf("<head>"), html.indexOf("</html>"));

  test("an id that is not a CSS identifier leaves the style on the element, where it still applies", async () => {
    // ap: a Cwicly token still in an id. Without the fallback the build writes the invalid selector
    // `#cancel-comment-reply-link{idadd}`, the browser drops the rule, and the button is visible.
    const markup = `<button id="cancel-comment-reply-link{idadd}" class="button-cancel" style="display:none;">cancel</button>`;
    const site = await buildJxProject(page(...htmlToNodes(markup)));
    const html = document(site.html("/"));
    expect(html).toContain(`style="display:none;"`);
    expect(html).not.toContain("#cancel-comment-reply-link");
    // The unprotected node writes the invalid rule, which is what the fallback is for.
    const bare = await buildJxProject(
      page({
        tagName: "button",
        id: "cancel-comment-reply-link{idadd}",
        className: "button-cancel",
        style: { display: "none" },
        textContent: "cancel",
      }),
    );
    expect(document(bare.html("/"))).toContain(
      "#cancel-comment-reply-link{idadd} { display: none }",
    );
  });

  test("inlineStyle: attribute writes no rule at all", async () => {
    const markup = `<p class="has-text-align-center" style="font-size:1.2em">x</p>`;
    const site = await buildJxProject(page(...htmlToNodes(markup, { inlineStyle: "attribute" })));
    const html = site.html("/");
    expect(html).toContain(`<p class="has-text-align-center" style="font-size:1.2em">x</p>`);
    expect(html).not.toContain("<style>");
  });

  test("an unbalanced quote or bracket cannot swallow the rules written after it", async () => {
    // The build writes one rule per line and does not repair a value. A string or a parenthesis
    // left open ran into the rules of the elements after it, and a browser read none of them.
    const styles = (html: string): string => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    const bad = [
      `font-family:'Arial`,
      `content:"a`,
      `width:calc(1px + 2px`,
      `margin:0 {`,
      `grid-template-areas: "a b" "c`,
      `background:url(x`,
      `color:red}`,
      `background:url(//x/*.png)`,
      `--a:[;];color:rgb(255,0,0)`,
    ];
    for (const style of bad) {
      const markup =
        `<div class="a" style="${style.replaceAll('"', "&quot;")}">A</div>` +
        `<div class="b" style="color:rgb(0,128,0)">B</div><div class="c" style="color:rgb(0,0,255)">C</div>`;
      const site = await buildJxProject(page(...htmlToNodes(markup)));
      const colors: string[] = [];
      postcss.parse(styles(site.html("/"))).walkDecls("color", (d) => void colors.push(d.value));
      // `--a:[;];color:…` is two declarations, so its colour is A's own.
      expect(colors).toEqual([
        ...(style.startsWith("--a") ? ["rgb(255,0,0)"] : []),
        "rgb(0,128,0)",
        "rgb(0,0,255)",
      ]);
    }
  });

  test("two elements with one id and different styles each keep their own", async () => {
    // `#card` selects both, so the build's one rule per element gave the second's colour to both.
    const markup =
      `<div id="card" style="color:rgb(255,0,0)">first</div>` +
      `<div id="card" style="color:rgb(0,0,255)">second</div>`;
    const site = await buildJxProject(page(...htmlToNodes(markup)));
    const html = site.html("/");
    expect(html).not.toContain("#card");
    expect(html).toContain(`<div id="card" style="color:rgb(255,0,0)">first</div>`);
    expect(html).toContain(`<div id="card" style="color:rgb(0,0,255)">second</div>`);
    // What the bare nodes do: two rules for one selector, and the last wins for both.
    const bare = await buildJxProject(
      page(
        { tagName: "div", id: "card", style: { color: "rgb(255,0,0)" }, textContent: "first" },
        { tagName: "div", id: "card", style: { color: "rgb(0,0,255)" }, textContent: "second" },
      ),
    );
    expect(bare.html("/")).toContain("#card { color: rgb(255,0,0) }");
    expect(bare.html("/")).toContain("#card { color: rgb(0,0,255) }");
  });

  test("a declaration pair written as a fallback stays as written, for the browser to read", async () => {
    const markup = `<div style="width:100px;width:90px\\9">x</div>`;
    const site = await buildJxProject(page(...htmlToNodes(markup)));
    expect(site.html("/")).toContain(`<div style="width:100px;width:90px\\9">x</div>`);
    // As a style object only the last value is left, and a browser reads none of it.
    const object = await buildJxProject(
      page({ tagName: "div", style: { width: "90px\\9" }, textContent: "x" }),
    );
    expect(object.html("/")).toContain("width: 90px\\9");
    expect(object.html("/")).not.toContain("100px");
  });
});

describe("an img inside innerHTML, through the build's image pass", () => {
  // The default images config finds every `<img>` in an innerHTML string with `/<img\b([^>]*)>/`,
  // which ends the tag at the first `>` even inside quotes. (No `images` key here: the round trip
  // above turns the pass off, and so hid it.)
  const page = (...children: JxNode[]) => ({
    "project.json": { name: "images", url: "https://example.com" },
    "pages/index.json": { children },
  });
  const imgs = (html: string): { alt: string | undefined; loading: string | undefined }[] =>
    elementsOf(fragmentNodes(html.slice(html.indexOf("<body>"))))
      .filter((el) => el.tagName === "img")
      .map((el) => ({ alt: attr(el, "alt"), loading: attr(el, "loading") }));

  test("html.ts writes an angle bracket in an alt as a reference, and the pass leaves the value whole", async () => {
    const nodes = htmlToNodes(
      `<p><img src="/a.jpg" alt="Q&amp;A -&gt; answers &lt;b&gt;"><img src="/b.jpg" alt="plain"></p>`,
    );
    expect((nodes[0] as JxElement).innerHTML).toBeDefined();
    const site = await buildJxProject(page(...nodes));
    expect(imgs(site.html("/"))).toEqual([
      { alt: "Q&A -> answers <b>", loading: "lazy" },
      { alt: "plain", loading: "lazy" },
    ]);
  });

  test("a raw > in the markup is cut in two, which is why it is a reference", async () => {
    // If this starts to fail, Jx reads quoted values and the reference is no longer needed.
    const site = await buildJxProject(
      page({
        tagName: "p",
        innerHTML: `<img src="/a.jpg" alt="a > b"><img src="/b.jpg" alt="plain">`,
      }),
    );
    expect(imgs(site.html("/"))[0]?.alt).not.toBe("a > b");
  });
});

describe("markup nested as deep as a browser nests it, through the build", () => {
  const nest = (depth: number): string => "<div>".repeat(depth) + "x" + "</div>".repeat(depth);

  test("512 levels build as elements, and a deeper fragment is written as the markup it was", async () => {
    // jx build overflows its stack at about 1,300 levels and jx validate at 39, so a fragment is
    // not converted past what a browser builds itself.
    const deep = await buildJxProject({ "pages/index.json": { children: htmlToNodes(nest(512)) } });
    expect(deep.html("/")).toContain(nest(512));
    const kept = await buildJxProject({
      "pages/index.json": { children: htmlToNodes(nest(2000)) },
    });
    expect(kept.html("/")).toContain(nest(2000));
  });
});

describe("attributes named like what every object has, through the build", () => {
  test("constructor reaches the page, and so does the name of every ordinary attribute", async () => {
    const nodes = htmlToNodes(`<div constructor="x" tostring="y" data-a="1">t</div>`);
    const site = await buildJxProject({ "pages/index.json": { children: nodes } });
    expect(site.html("/")).toContain(`<div constructor="x" tostring="y" data-a="1">t</div>`);
  });

  test("the build drops __proto__, which html.ts keeps as an own attribute", async () => {
    // The node is right (it is an own property, and JSON carries it); Jx assigns attributes as it
    // reads them and a plain assignment of `__proto__` sets a prototype instead. If this starts to
    // fail, that is fixed.
    const nodes = htmlToNodes(`<div __proto__="y" data-a="1">t</div>`);
    expect(JSON.stringify(nodes)).toContain(`"__proto__":"y"`);
    const site = await buildJxProject({ "pages/index.json": { children: nodes } });
    expect(site.html("/")).toContain(`<div data-a="1">t</div>`);
  });
});

describe("nodesToHtml against the real emitter", () => {
  test("writes every kind of boolean attribute as the build writes it", async () => {
    // `aria-*`, draggable, contenteditable and spellcheck carry their word; the rest are present or absent.
    const attributes = {
      "aria-hidden": false,
      "aria-expanded": true,
      draggable: false,
      contenteditable: false,
      spellcheck: true,
      disabled: true,
      async: false,
      "data-on": "yes",
      "data-n": 2,
    };
    const node: JxElement = { tagName: "div", attributes };
    const site = await buildJxProject({ "pages/index.json": { children: [node] } });
    const mapOf = (html: string): Record<string, string> => {
      const el = elementsOf(fragmentNodes(html)).find((e) => attr(e, "data-on") !== undefined);
      return Object.fromEntries((el?.attrs ?? []).map((a) => [a.name, a.value]));
    };
    const built = mapOf(site.html("/").slice(site.html("/").indexOf("<body>")));
    expect(built).toEqual({
      "aria-hidden": "false",
      "aria-expanded": "true",
      draggable: "false",
      contenteditable: "false",
      spellcheck: "true",
      disabled: "",
      "data-on": "yes",
      "data-n": "2",
    });
    expect(mapOf(nodesToHtml([node]))).toEqual(built);
  });
});

describe("a literal ${ survives the build", () => {
  const page = (...children: JxNode[]) => ({ "pages/index.json": { children } });
  const body = (html: string): string =>
    html.slice(html.indexOf("<body>"), html.indexOf("</body>"));

  test("Jx has no escape for one in text or an attribute, which is why html.ts needs innerHTML", async () => {
    const tries: JxNode[] = [
      { tagName: "p", textContent: "a ${b} c" },
      { tagName: "p", textContent: "a \\${b} c" },
      { tagName: "p", textContent: "a &#36;{b} c" },
      { tagName: "p", attributes: { title: "a ${'x'} c" }, textContent: "evaluated" },
      { tagName: "p", attributes: { title: "a &#36;{b} c" }, textContent: "entity" },
    ];
    const site = await buildJxProject(page(...tries));
    const html = body(site.html("/"));
    // Evaluated or left for the client (and then evaluated again, in the browser, as undefined).
    expect(html).toContain(`<p data-bind :text-content="_t0"></p>`);
    expect(html).toContain(`<p data-bind :text-content="_t1"></p>`);
    // The entity is escaped a second time and shown as text.
    expect(html).toContain("<p>a &amp;#36;{b} c</p>");
    expect(html).toContain(`<p title="a x c">evaluated</p>`);
    expect(html).toContain(`title="a &amp;#36;{b} c"`);
    expect(site.exists("app.js")).toBe(true);
  });

  test("html.ts output holding one builds to exactly the text and attribute it was given", async () => {
    // A tutorial that shows template syntax; a link whose query string is a placeholder; a code block.
    const markup =
      `<p>Write <code>\${state.count}</code> to show the count, or pay \${price} &amp; \${tax}.</p>` +
      `<ul><li><a href="/search?q=\${term}" title="find \${term}">Search</a> for it</li></ul>` +
      `<pre><code>const msg = \`Hello \${name}\`;\n</code></pre>`;
    const nodes = htmlToNodes(markup);
    const site = await buildJxProject(
      page({ tagName: "div", attributes: { "data-frag": "x" }, children: nodes }),
    );
    const html = site.html("/");
    // Nothing was left for the client: no binding, no module, no evaluated text.
    expect(html).not.toContain("data-bind");
    expect(site.exists("app.js")).toBe(false);

    const document = parseDocument(html, { scriptingEnabled: false });
    let wrapper: P5Element | undefined;
    const walk = (node: P5): void => {
      if (isElement(node) && attr(node, "data-frag") === "x") wrapper = node;
      for (const child of "childNodes" in node ? node.childNodes : []) walk(child);
    };
    walk(document);
    const text = (el: P5Element): string =>
      el.childNodes.map((n) => (isElement(n) ? text(n) : "value" in n ? n.value : "")).join("");
    const built = wrapper as unknown as P5Element;
    expect(text(built).replaceAll(/\s+/g, " ").trim()).toBe(
      "Write ${state.count} to show the count, or pay ${price} & ${tax}. Search for it const msg = `Hello ${name}`;",
    );
    const link = elementsOf(built.childNodes).find((el) => el.tagName === "a");
    expect(link && attr(link, "href")).toBe("/search?q=${term}");
    expect(link && attr(link, "title")).toBe("find ${term}");
    // And it is the same page as the original, by the oracle.
    expect(canon(built.childNodes, canon(fragmentNodes(markup)).kinds).text).toBe(
      canon(fragmentNodes(markup)).text,
    );
  });

  test("a top-level literal is wrapped in an element that lays out as nothing, and still reads right", async () => {
    const nodes = htmlToNodes(`Pay \${amount} <a title="\${x}" href="/y">now</a>`);
    expect(nodes).toHaveLength(2);
    const site = await buildJxProject(page({ tagName: "p", children: nodes }));
    const html = body(site.html("/"));
    expect(html).not.toContain("data-bind");
    expect(html).toContain("Pay &#36;{amount}");
    expect(html).toContain(`title="&#36;{x}"`);
    // The wrapper's own rule is in the stylesheet.
    expect(site.html("/")).toMatch(/\.jx-\d+ \{ display: contents \}/);
  });

  test("htmlToContent fills the parent, so nothing needs wrapping", async () => {
    const content = htmlToContent(`Pay \${amount} <a title="\${x}" href="/y">now</a>`);
    expect(content).toEqual({
      innerHTML: `Pay &#36;{amount} <a title="&#36;{x}" href="/y">now</a>`,
    });
    const site = await buildJxProject(page({ tagName: "p", ...content }));
    expect(body(site.html("/"))).toContain(
      `<p>Pay &#36;{amount} <a title="&#36;{x}" href="/y">now</a></p>`,
    );
  });
});

describe("svg and script through the build", () => {
  const body = (html: string): string =>
    html.slice(html.indexOf("<body>"), html.indexOf("</body>"));

  test("an svg root builds to inline svg with every attribute name intact", async () => {
    const icon =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="icon size-6">` +
      `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/></linearGradient></defs>` +
      `<use xlink:href="#a"/><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" fill="url(#g)"/>` +
      `<foreignObject width="1" height="1"><p>x &amp; y</p></foreignObject></svg>`;
    for (const svg of ["innerHTML", "tree"] as const) {
      const site = await buildJxProject({
        "pages/index.json": {
          children: [
            {
              tagName: "div",
              attributes: { "data-frag": "i" },
              children: htmlToNodes(icon, { svg }),
            },
          ],
        },
      });
      const html = body(site.html("/"));
      for (const name of [
        "viewBox",
        "stroke-width",
        "xlink:href",
        "xmlns:xlink",
        "gradientUnits",
        "stroke-linecap",
        "foreignObject",
        "linearGradient",
      ]) {
        expect(html).toContain(name);
      }
      expect(html).not.toContain("strokeWidth");
      const document = parseDocument(site.html("/"), { scriptingEnabled: false });
      let wrapper: P5Element | undefined;
      const walk = (node: P5): void => {
        if (isElement(node) && attr(node, "data-frag") === "i") wrapper = node;
        for (const child of "childNodes" in node ? node.childNodes : []) walk(child);
      };
      walk(document);
      const original = canon(fragmentNodes(icon));
      expect(canon((wrapper as unknown as P5Element).childNodes, original.kinds).text).toBe(
        original.text,
      );
    }
  });

  test("the script and style elements of real pages come through byte for byte", async () => {
    // The head scripts and styles the fixtures' pages carry: the case the other tests cut out.
    const pages = ["fineline", "ap"].flatMap((site) =>
      readdirSync(join(FIXTURES, site, "html")).map((f) =>
        readFileSync(join(FIXTURES, site, "html", f), "utf8"),
      ),
    );
    const raw: string[] = [];
    for (const page of pages) {
      const walk = (node: HastNodes): void => {
        if (node.type === "element" && (node.tagName === "script" || node.tagName === "style")) {
          const text = node.children.map((c) => (c.type === "text" ? c.value : "")).join("");
          if (text.trim() !== "" && !text.includes("${"))
            raw.push(`<${node.tagName}>${text}</${node.tagName}>`);
          return;
        }
        if ("children" in node) for (const child of node.children) walk(child);
      };
      walk(fromHtml(page));
    }
    expect(raw.length).toBeGreaterThan(100);
    const unique = [...new Set(raw)].slice(0, 300);
    const nodes = unique.flatMap((markup) => htmlToNodes(markup));
    const site = await buildJxProject({ "pages/index.json": { children: nodes } });
    const html = site.html("/");
    for (const markup of unique) expect(html).toContain(markup.replaceAll("\r\n", "\n"));
  });
});

// ── Entries: html.ts, serializeJxMarkdown and the build ──────────────────────────────────────────

const collect = (): Report & { all: ReportEntry[] } => {
  const all: ReportEntry[] = [];
  return { all, add: (entry) => void all.push(entry), entries: () => all };
};

/** The text a browser shows for these nodes: script and style left out, whitespace as it came. */
function visibleText(nodes: P5[]): string {
  let out = "";
  const walk = (list: P5[]): void => {
    for (const node of list) {
      if (node.nodeName === "#text") out += (node as DefaultTreeAdapterMap["textNode"]).value;
      else if (isElement(node) && node.tagName !== "script" && node.tagName !== "style") {
        walk(childrenOf(node));
      }
    }
  };
  walk(nodes);
  return out;
}

/** The serializer writes `:26` of `19:26` as a text directive named 26 and the parser reads it so. */
const COLON_TAIL = /:[A-Za-z0-9]+/g;

/** What an entry must still show of a source's text: its letters, with the exemption above. */
const textOf = (html: string): string =>
  visibleText(fragmentNodes(html))
    .replaceAll(/\s+/g, " ")
    .replaceAll(COLON_TAIL, "")
    .replaceAll(" ", "")
    .normalize("NFC");

/** The letters a rebuilt entry shows, in the same form. */
const lettersOf = (text: string): string => text.replaceAll(/\s+/g, "").normalize("NFC");

/** Whether every character of `needle` is in `hay`, in order: text may have been added, not lost. */
function keeps(hay: string, needle: string): boolean {
  let at = 0;
  for (const ch of hay) if (ch === needle[at]) at++;
  return at === needle.length;
}

const holdsInnerHtml = (nodes: JxNode[]): boolean =>
  nodes.some(
    (node) =>
      typeof node === "object" &&
      (node.innerHTML !== undefined ||
        (Array.isArray(node.children) && holdsInnerHtml(node.children))),
  );

describe("the real fragments as Markdown entries", () => {
  // The design writes every post and custom post type through serializeJxMarkdown. It writes no
  // innerHTML, which is where the page target keeps what the build would show a gap in.
  const entryFragments = fragments.filter((f) => f.kind !== "page");
  const through = (nodes: JxNode[]): JxNode[] =>
    (transpileJxMarkdown(serializeJxMarkdown({ children: nodes } as never, { mode: "roundtrip" }))
      .children ?? []) as JxNode[];
  const textOfNodes = (nodes: JxNode[]): string => {
    const walk = (node: JxNode): string => {
      if (typeof node === "string") return node;
      if (node.tagName === "script" || node.tagName === "style") return "";
      if (typeof node.textContent === "string") return node.textContent;
      return Array.isArray(node.children) ? node.children.map(walk).join(" ") : "";
    };
    return lettersOf(nodes.map(walk).join(" "));
  };

  test("keep their text, where the page target loses a fifth of it", () => {
    let kept = 0;
    let pageKept = 0;
    let withInnerHtml = 0;
    for (const fragment of entryFragments) {
      const source = textOf(fragment.html);
      const report = collect();
      const nodes = htmlToNodes(fragment.html, { target: "markdown", report, where: fragment.id });
      if (holdsInnerHtml(nodes)) {
        withInnerHtml++;
        // What the serializer will drop is always said.
        expect(report.all.map((e) => e.code)).toContain("html.innerhtml-unserialisable");
      }
      if (keeps(textOfNodes(through(nodes)), source)) kept++;
      if (keeps(textOfNodes(through(htmlToNodes(fragment.html))), source)) pageKept++;
    }
    const total = entryFragments.length;
    expect(total).toBeGreaterThan(7_000);
    // What is left is the serializer's own: a table with a class comes out empty, a trailing <br>
    // gains a backslash, and so on. Nothing here is html.ts dropping what it could carry.
    expect(kept / total).toBeGreaterThan(0.97);
    expect(withInnerHtml).toBeLessThan(10);
    // The oracle can tell: the page target, through the same serializer, loses text in one
    // fragment in eight. If this stops failing, Jx writes innerHTML and `target` can go.
    expect(pageKept / total).toBeLessThan(0.9);
  });
});

describe("a Markdown entry, from html.ts to a built page", () => {
  const posts = JSON.parse(readFileSync(join(FIXTURES, "ap/rows/posts.json"), "utf8")) as {
    ID: number;
    post_content: string;
  }[];
  /** The paragraphs of an anabaptistperspectives essay, as the blocks saved them. */
  const essay = (): string[] => {
    const out: string[] = [];
    const walk = (blocks: ReturnType<typeof parseBlocks>): void => {
      for (const block of blocks) {
        if (block.blockName === "core/paragraph") out.push(block.innerHTML);
        walk(block.innerBlocks);
      }
    };
    walk(parseBlocks(posts.find((row) => row.ID === 738)?.post_content ?? ""));
    return out;
  };
  /** A collection of one entry. A tag used as a directive has to be declared, plain HTML ones too. */
  const project = (entry: string) => ({
    "project.json": {
      name: "entries",
      url: "https://example.com",
      extensions: ["@jxsuite/parser"],
      images: { optimize: false, lazyLoad: false },
      content: {
        posts: {
          source: "content/posts",
          format: "Markdown",
          $elements: ["a", "b", "br", "div", "em", "i", "p", "small", "span", "strong", "sup"],
          schema: {
            type: "object",
            properties: { title: { type: "string" }, slug: { type: "string" } },
          },
        },
      },
    },
    "content/posts/essay.md": entry,
    "pages/posts/[slug].json": {
      title: "post",
      $paths: { contentType: "posts", param: "slug", field: "slug" },
      state: {
        entry: {
          $prototype: "ContentEntry",
          contentType: "posts",
          field: "slug",
          id: { $ref: "#/$params/slug" },
          $src: "@jxsuite/parser/ContentEntry.class.json",
        },
      },
      children: [{ tagName: "div", children: "${state.entry.$children}" }],
    },
    "pages/index.json": { children: [{ tagName: "p", textContent: "home" }] },
  });
  const built = async (paragraphs: string[], options?: HtmlOptions): Promise<string> => {
    const nodes = paragraphs.flatMap((html) => htmlToNodes(html, options));
    const entry = serializeJxMarkdown({ title: "Essay", slug: "essay", children: nodes } as never, {
      mode: "roundtrip",
    });
    const site = await buildJxProject(project(entry));
    const html = site.html("/posts/essay/");
    return lettersOf(visibleText(fragmentNodes(html.slice(html.indexOf("<body>")))));
  };

  test("an essay keeps every word with target: markdown, and loses most of them without it", async () => {
    const paragraphs = essay();
    expect(paragraphs.length).toBeGreaterThan(20);
    const source = paragraphs.map(textOf).join("");
    expect(source.length).toBeGreaterThan(5_000);
    expect(keeps(await built(paragraphs, { target: "markdown" }), source)).toBe(true);
    // The first words are there, and then the first paragraph with a link or an emphasis is not.
    const page = await built(paragraphs);
    expect(keeps(page, source)).toBe(false);
    expect(page.length).toBeLessThan(source.length * 0.8);
  });
});

describe("the attribute hook on the real fragments", () => {
  // The design moves media to /media/… and drops srcset and sizes. Without a hook that is a regular
  // expression over the source, and two in five of the links of real block markup sit inside
  // innerHTML strings.
  const upload = /^https?:\/\/[^/]+\/wp-content\/uploads\//;

  /** Every attribute of every element, whatever namespace and wherever it sits. */
  const attributesOf = (html: string): { tag: string; name: string; value: string }[] => {
    const out: { tag: string; name: string; value: string }[] = [];
    for (const el of elementsOf(fragmentNodes(html))) {
      for (const a of el.attrs) out.push({ tag: el.tagName, name: a.name, value: a.value });
    }
    return out;
  };

  test("reaches every upload URL, in structured attributes and inside markup alike", () => {
    let seen = 0;
    let all = 0;
    let rewritten = 0;
    let expected = 0;
    let insideMarkup = 0;
    const left: string[] = [];
    for (const fragment of fragments) {
      const source = attributesOf(fragment.html);
      all += source.length;
      expected += source.filter((a) => upload.test(a.value) && a.name !== "srcset").length;
      const nodes = htmlToNodes(fragment.html, {
        attribute: (_tag, name, value) => {
          seen++;
          if (name === "srcset" || name === "sizes") return null;
          const next = value.replace(upload, "/media/");
          if (next !== value) rewritten++;
          return next;
        },
      });
      if (holdsInnerHtml(nodes)) insideMarkup++;
      // What a page would carry, inside an element's own attributes and inside its innerHTML.
      for (const { tag, name, value } of attributesOf(nodesToHtml(nodes))) {
        if ((upload.test(value) && name !== "srcset") || name === "srcset" || name === "sizes") {
          left.push(`${fragment.id} <${tag} ${name}="${value.slice(0, 60)}">`);
        }
      }
    }
    expect(left).toEqual([]);
    // Each was moved, and the hook heard of every attribute of every element exactly once.
    expect(rewritten).toBe(expected);
    expect(rewritten).toBeGreaterThan(300);
    expect(seen).toBe(all);
    // A good many of them were inside markup, where nothing else could have reached them.
    expect(insideMarkup).toBeGreaterThan(500);
  });
});

describe("buildJxProject", () => {
  test("writes files, builds, and returns what was built", async () => {
    const site = await buildJxProject({
      "pages/index.json": { children: [{ tagName: "p", textContent: "home" }] },
      "pages/about/team.json": { children: [{ tagName: "h1", textContent: "Team" }] },
      "public/robots-extra.txt": "hello",
    });
    expect(site.code).toBe(0);
    expect(site.stdout).toContain("Done: 2 routes");
    expect(site.dist.startsWith(TMP_ROOT)).toBe(true);
    expect(site.html("/")).toContain("<p>home</p>");
    expect(site.html("/about/team/")).toContain("<h1>Team</h1>");
    expect(site.html("about/team")).toBe(site.html("/about/team/index.html"));
    expect(site.read("robots-extra.txt")).toBe("hello");
    expect(site.exists("sitemap.xml")).toBe(true);
    expect(site.exists("nope.html")).toBe(false);
    expect(site.list()).toContain("about/team/index.html");
    expect(() => site.read("../project.json")).toThrow("leaves dist");
  });

  test("each call gets its own directory, with a project.json unless one is given", async () => {
    const a = await buildJxProject({ "pages/index.json": { children: [] } });
    const b = await buildJxProject({
      "project.json": { name: "custom", url: "https://custom.test" },
      "pages/index.json": { children: [] },
    });
    expect(a.dir).not.toBe(b.dir);
    expect(JSON.parse(readFileSync(join(a.dir, "project.json"), "utf8")).name).toBe("wp2jx-test");
    expect(JSON.parse(readFileSync(join(b.dir, "project.json"), "utf8")).url).toBe(
      "https://custom.test",
    );
    expect(b.html("/")).toContain("custom.test");
  });

  test("a failed build throws with the CLI's output unless told not to", async () => {
    const files = { "pages/index.json": "{ not json" };
    await expect(buildJxProject(files)).rejects.toThrow("Failed to parse Jx document");
    const failed = await buildJxProject(files, { allowFailure: true });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr + failed.stdout).toContain("Failed to parse Jx document");
  });

  test("writeJxProject and build: false leave the project unbuilt for validation", async () => {
    const dir = writeJxProject({
      "pages/index.json": { children: [{ tagName: "p", textContent: "x" }] },
    });
    expect(readdirSync(dir).sort()).toEqual(["pages", "project.json"]);
    const site = await buildJxProject({ "pages/index.json": { children: [] } }, { build: false });
    expect(site.list()).toEqual([]);
    expect(site.code).toBe(0);
  });

  test("validateJxProject says ok for a valid project and lists what is wrong in an invalid one", async () => {
    const good = await buildJxProject(
      { "pages/index.json": { children: [{ tagName: "p", textContent: "x" }] } },
      { build: false },
    );
    expect(await validateJxProject(good.dir)).toMatchObject({ ok: true, code: 0, problems: [] });

    const bad = await buildJxProject(
      { "pages/index.json": { children: [{ tagName: "o:p", textContent: "x" }] } },
      { build: false },
    );
    const result = await validateJxProject(bad.dir);
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe(0);
    expect(
      result.problems.some((p) =>
        p.startsWith("pages/index.json /children/0/tagName: must match pattern"),
      ),
    ).toBe(true);
    expect(result.problems.every((p) => !p.includes("unknown format"))).toBe(true);
  });

  // Last in the file: it removes every project this process built, including the ones above.
  test("cleanupJxProjects removes what the process created", async () => {
    const site = await buildJxProject({ "pages/index.json": { children: [] } }, { build: false });
    expect(readdirSync(site.dir)).toContain("project.json");
    cleanupJxProjects();
    expect(() => readdirSync(site.dir)).toThrow();
  });
});
