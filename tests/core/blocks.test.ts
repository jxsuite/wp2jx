import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeJxMarkdown } from "@jxsuite/parser/serialize";
import { transpileJxMarkdown } from "@jxsuite/parser/transpile";
import { parseFragment } from "parse5";
import {
  convertCoreBlock,
  coreConverters,
  findShortcodes,
  layoutClasses,
  shortcodeAttributes,
  supportsOf,
} from "../../src/core/blocks.ts";
import { targetOf } from "../../src/core/static.ts";
import { texturizeHtml } from "../../src/cwicly/tokens.ts";
import { nodesToHtml } from "../../src/html.ts";
import type { ConvertCtx, JxElement, JxNode, ReportEntry, WpBlock } from "../../src/types.ts";
import { parseBlocks, walkBlocks } from "../../src/wp/blocks.ts";
import { decodeEntities } from "../../src/wp/model.ts";
import { FIXTURES } from "../helpers/fixture-db.ts";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "../helpers/jx-build.ts";
import {
  allSubjects,
  loadSite,
  makeCtx,
  stubRewriteUrl,
  subjectBlocks,
  subjectPost,
} from "../helpers/ctx.ts";
import type { SiteName, Subject } from "../helpers/ctx.ts";

// The corpus sweeps and the builds take seconds each, more on a busy machine.
setDefaultTimeout(120_000);
afterAll(() => cleanupJxProjects());

// ── A driver for ctx.convert (the real one is written later) ─────────────────────────────────────

/**
 * Core and legacy-embed blocks convert through the module under test. A Cwicly block is not this
 * module's: the driver looks through it at what it holds, so the core blocks inside a Cwicly section
 * are still converted and the converted content of a page can be compared with what the page shows.
 * Any other namespace (`fluentfom/…`, `ideabox/…`, `drupalblock/…`) goes to `convertCoreBlock`, whose
 * answer for a name it does not know is part of what is tested.
 */
function drive(ctx: ConvertCtx): ConvertCtx {
  const convert = (blocks: WpBlock[], overrides?: Partial<ConvertCtx>): JxNode[] => {
    const here = overrides ? { ...ctx, ...overrides, convert } : ctx;
    const out: JxNode[] = [];
    for (const b of blocks) {
      if (b.name?.startsWith("cwicly/")) out.push(...convert(b.innerBlocks, overrides));
      else out.push(...convertCoreBlock(b, here));
    }
    return out;
  };
  ctx.convert = convert;
  return ctx;
}

const driven = async (
  site: SiteName,
  subject: Subject,
  overrides: Partial<ConvertCtx> = {},
): Promise<ConvertCtx> => drive(await makeCtx(site, subject, overrides));

/** Convert `markup` (serialized blocks) as the block converters would, in a real subject's context. */
async function convertMarkup(
  markup: string,
  site: SiteName = "fineline",
  subject: Subject = { kind: "post", id: 3483 },
  overrides: Partial<ConvertCtx> = {},
): Promise<{ nodes: JxNode[]; html: string; ctx: ConvertCtx; codes: string[] }> {
  const ctx = await driven(site, subject, overrides);
  const nodes = ctx.convert(parseBlocks(markup));
  return {
    nodes,
    html: nodesToHtml(nodes),
    ctx,
    codes: ctx.report.entries().map((e) => e.code),
  };
}

const FL_PAGE: Subject = { kind: "post", id: 3483 }; // privacy policy: a JSON page

const entriesOf = (ctx: ConvertCtx, code: string): ReportEntry[] =>
  ctx.report.entries().filter((e) => e.code === code);

/** The visible text of a node tree, the way a browser would run it together. */
function textOfNodes(nodes: readonly JxNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      out += node;
      continue;
    }
    if (typeof node.textContent === "string") out += node.textContent;
    else if (typeof node.innerHTML === "string") out += textOfHtml(node.innerHTML);
    else if (Array.isArray(node.children)) out += textOfNodes(node.children);
    if (node.tagName === "br") out += " ";
  }
  return out;
}

function textOfHtml(html: string): string {
  const fragment: any = parseFragment(html);
  const walk = (n: any): string =>
    n.nodeName === "#text"
      ? n.value
      : n.tagName === "script" || n.tagName === "style"
        ? ""
        : n.tagName === "br"
          ? " "
          : (n.childNodes ?? []).map(walk).join("");
  return walk(fragment);
}

/** Saved text of a block's own markup and its inner blocks', for the conservation test. */
const squash = (text: string): string =>
  decodeEntities(text).replace(/ /g, " ").replace(/\s+/g, " ").trim();

// ── The live pages as an oracle ──────────────────────────────────────────────────────────────────

/** Elements that carry content a visitor reads or sees; a page is compared as the ordered list of these. */
const CONTENT = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "pre",
  "td",
  "th",
  "figcaption",
  "dt",
  "dd",
  "summary",
  "hr",
  "img",
  "iframe",
  "video",
  "audio",
]);

type P5 = any;
const attrOf = (n: P5, name: string): string | undefined =>
  (n.attrs ?? []).find((a: P5) => a.name === name)?.value;
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);
const hasContentBelow = (n: P5): boolean =>
  (n.childNodes ?? []).some(
    (c: P5) => (c.tagName !== undefined && CONTENT.has(c.tagName)) || hasContentBelow(c),
  );
const plainText = (n: P5): string =>
  n.nodeName === "#text"
    ? n.value
    : SKIP_TAGS.has(n.tagName ?? "")
      ? ""
      : n.tagName === "br"
        ? " "
        : (n.childNodes ?? []).map(plainText).join("");
/** A content element's own text: what is in it that is not in a content element below it. */
function ownText(n: P5): string {
  let out = "";
  for (const c of n.childNodes ?? []) {
    if (c.nodeName === "#text") out += c.value;
    else if (c.tagName === "br") out += " ";
    else if (c.tagName === undefined) continue;
    // A Markdown list item holds its text in a paragraph: it is the item's own text.
    else if (n.tagName === "li" && c.tagName === "p") out += `${ownText(c)} `;
    else if (CONTENT.has(c.tagName)) continue;
    else if (hasContentBelow(c)) out += ownText(c);
    else out += plainText(c);
  }
  return out;
}

/**
 * The normalisation. WordPress prints a page through `wptexturize` (typographic quotes), which a
 * static page does not run; the migration carries the saved text, so quotes, dashes, the ellipsis and
 * non-breaking spaces are compared as their plain forms, and whitespace as one space.
 */
export const normalise = (text: string): string =>
  text
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * A page as the ordered list of its content elements: `tag | text | links | source`. Text is the
 * element's own, links are the addresses of the anchors inside it (path and fragment of an
 * internal one, the whole of an external one), and the source is an image's or frame's address by
 * file name, so a `-1024x768` derivative and the original it was collapsed to compare equal.
 */
export function signatures(root: P5, origins: readonly string[]): string[] {
  const out: string[] = [];
  const address = (url: string): string => {
    let u = url.trim();
    for (const origin of origins) if (u.startsWith(origin)) u = u.slice(origin.length) || "/";
    return u.replace(/^\/media\//, "/wp-content/uploads/");
  };
  const file = (url: string): string =>
    address(url)
      .split(/[?#]/)[0]!
      .replace(/^.*\//, "")
      .replace(/-(?:\d{1,5}x\d{1,5}|scaled)(?=\.[a-z0-9]+$)/i, "");
  const walk = (n: P5): void => {
    if (SKIP_TAGS.has(n.tagName ?? "")) return;
    if (
      n.tagName !== undefined &&
      CONTENT.has(n.tagName) &&
      !(n.tagName === "p" && n.parentNode?.tagName === "li")
    ) {
      const links: string[] = [];
      const collect = (x: P5): void => {
        if (x.tagName === "a" && attrOf(x, "href") !== undefined)
          links.push(address(attrOf(x, "href")!));
        for (const c of x.childNodes ?? []) collect(c);
      };
      collect(n);
      const text = normalise(ownText(n));
      const src = n.tagName === "img" || n.tagName === "iframe" ? (attrOf(n, "src") ?? "") : "";
      const source = n.tagName === "img" ? file(src) : src;
      if (text !== "" || source !== "" || n.tagName === "hr") {
        // A Markdown table has only header cells in its first row: th and td are one kind of cell.
        const kind = n.tagName === "th" ? "td" : n.tagName;
        out.push(`${kind}|${text}|${links.join(",")}|${source}`);
      }
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** The part of a parsed page under the first element matching `selector` (`tag.class` or `tag`), or the whole page. */
function regionOf(root: P5, selector: string | undefined): P5 {
  if (selector === undefined) return root;
  const [tag, cls] = selector.split(".") as [string, string | undefined];
  let found: P5;
  const walk = (n: P5): void => {
    if (found !== undefined) return;
    if (
      n.tagName === tag &&
      (cls === undefined || (attrOf(n, "class") ?? "").split(/\s+/).includes(cls))
    ) {
      found = n;
      return;
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(root);
  if (found === undefined) throw new Error(`no ${selector} in the page`);
  return found;
}

export interface Alignment {
  /** Converted signatures found, in order, among the live ones. */
  matched: number;
  /** Converted signatures with no counterpart (the mismatches to explain). */
  missing: string[];
  /** Live signatures between the first and the last match that the conversion has no counterpart for. */
  extra: string[];
}

/** Longest common subsequence of two signature lists, reported from the converted side. */
export function align(converted: readonly string[], live: readonly string[]): Alignment {
  const n = converted.length;
  const m = live.length;
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        converted[i] === live[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const missing: string[] = [];
  const hits: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (converted[i] === live[j]) {
      hits.push(j);
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      missing.push(converted[i]!);
      i++;
    } else j++;
  }
  while (i < n) missing.push(converted[i++]!);
  const first = hits[0] ?? 0;
  const last = hits.at(-1) ?? -1;
  const inWindow = new Set(hits);
  const extra: string[] = [];
  for (let k = first; k <= last; k++) if (!inWindow.has(k)) extra.push(live[k]!);
  return { matched: hits.length, missing, extra };
}

const tagsOf = (nodes: readonly JxNode[], into = new Set<string>()): Set<string> => {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (typeof node.tagName === "string") into.add(node.tagName);
    if (Array.isArray(node.children)) tagsOf(node.children, into);
  }
  return into;
};

/**
 * The markup `jx build` wrote for converted blocks, the way the migration will ship them: a page is
 * built as a JSON page, a post as a Markdown entry (written by `serializeJxMarkdown`, read back by the
 * build's collection reader, every tag declared in `$elements` as the entry emitter will have to).
 */
async function builtBody(nodes: JxNode[], target: "page" | "markdown"): Promise<P5> {
  const options = { name: "core", timeoutMs: 110_000 };
  const site =
    target === "page"
      ? await buildJxProject({ "pages/index.json": { children: nodes } }, options)
      : await buildJxProject(
          {
            "project.json": {
              name: "entries",
              url: "https://example.com",
              extensions: ["@jxsuite/parser"],
              images: { optimize: false, lazyLoad: false },
              content: {
                posts: {
                  source: "content/posts",
                  format: "Markdown",
                  $elements: [...tagsOf(nodes), "a", "p"].filter((t) => /^[a-z][a-z0-9]*$/.test(t)),
                  schema: {
                    type: "object",
                    properties: { title: { type: "string" }, slug: { type: "string" } },
                  },
                },
              },
            },
            "content/posts/entry.md": serializeJxMarkdown(
              { title: "Entry", slug: "entry", children: nodes } as never,
              { mode: "roundtrip" },
            ),
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
          },
          options,
        );
  const html = site.html(target === "page" ? "/" : "/posts/entry/");
  return parseFragment(html.slice(html.indexOf("<body")));
}

interface OraclePage {
  site: SiteName;
  /** The rendered page in `tests/fixtures/<site>/html`. */
  file: string;
  subject: Subject;
  /** Where the converted blocks sit on the live page; undefined compares against the whole page. */
  region?: string;
}

const liveRoot = (site: SiteName, file: string): P5 =>
  parseFragment(readFileSync(join(FIXTURES, site, "html", `${file}.html`), "utf8"));

async function oracle(
  page: OraclePage,
  target?: "page" | "markdown",
): Promise<{
  converted: string[];
  live: string[];
  alignment: Alignment;
  ctx: ConvertCtx;
}> {
  const loaded = await loadSite(page.site);
  const ctx = await driven(
    page.site,
    page.subject,
    target === undefined ? {} : ({ target } as Partial<ConvertCtx>),
  );
  const nodes = ctx.convert(subjectBlocks(loaded, page.subject));
  const origins = [loaded.model.site.url, loaded.model.site.home];
  const built = await builtBody(nodes, targetOf(ctx));
  const converted = signatures(built, origins);
  const live = signatures(regionOf(liveRoot(page.site, page.file), page.region), origins);
  return { converted, live, alignment: align(converted, live), ctx };
}

/** The converted signatures with no counterpart on the live page, and the live ones nothing converted accounts for. */
function leftovers(
  converted: readonly string[],
  live: readonly string[],
): { missing: string[]; liveOnly: string[] } {
  const { missing } = align(converted, live);
  const budget = new Map<string, number>();
  for (const c of converted) budget.set(c, (budget.get(c) ?? 0) + 1);
  const liveOnly: string[] = [];
  for (const l of live) {
    const n = budget.get(l) ?? 0;
    if (n > 0) budget.set(l, n - 1);
    else liveOnly.push(l);
  }
  return { missing, liveOnly };
}

const ESSAY: OraclePage[] = [
  {
    site: "ap",
    file: "essays__the-cultural-captivity-of-the-gospel",
    subject: { kind: "post", id: 8819 },
    region: "div.content-essay",
  },
  {
    site: "ap",
    file: "essays__the-way-we-live-is-the-way-we-educate",
    subject: { kind: "post", id: 7260 },
    region: "div.content-essay",
  },
  {
    site: "ap",
    file: "essays__keeshons-story-a-knock-heard-round-the-hood-part-3",
    subject: { kind: "post", id: 773 },
    region: "div.content-essay",
  },
  {
    site: "fineline",
    file: "choosing-the-best-log-home-stain",
    subject: { kind: "post", id: 3371 },
    region: "article.content-post",
  },
];
const PRIVACY: OraclePage = {
  site: "fineline",
  file: "privacy-policy",
  subject: { kind: "post", id: 3483 },
  region: "div.content-cd27ea0",
};

const squeezed = (signature: string): string => signature.replace(/\s+/g, "");
const uniqueLinks = (signature: string): string => {
  const [tag, text, links, source] = signature.split("|") as [string, string, string, string];
  // `2 Timothy 2:15` read back with `:15` as a directive prints as `2 Timothy 2 <15>`.
  const colon = squeezed(text).replace(/<([^<>\s]+)>/g, ":$1");
  return `${tag}|${colon}|${[...new Set(links.split(","))].join(",")}|${source}`;
};

describe("converted blocks against the live pages: built as JSON pages", () => {
  test.each(ESSAY.slice(0, 3))(
    "$file: every converted element is on the live page, in order",
    async (page) => {
      const { converted, live, alignment } = await oracle(page, "page");
      expect(converted.length).toBeGreaterThan(15);
      expect(live.length).toBe(converted.length);
      expect(alignment.matched).toBe(converted.length);
      expect(alignment.missing).toEqual([]);
      expect(alignment.extra).toEqual([]);
    },
  );

  test("a blog post: all 118 content elements match; what the live article has besides is the Cwicly related-posts query", async () => {
    const page = ESSAY[3]!;
    const { converted, live, alignment } = await oracle(page, "page");
    expect(converted.length).toBe(118);
    expect(alignment.matched).toBe(118);
    expect(alignment.missing).toEqual([]);
    const { liveOnly } = leftovers(converted, live);
    expect(liveOnly).toEqual([
      "h2|Read Our Blogs About Log Cabin Staining||",
      "img|||how-to-stain-a-log-cabin-with-chinking-in-lebanon-pa.jpg",
      "h3|How To Stain A Log Cabin With Chinking|/how-to-stain-a-log-cabin-with-chinking/|",
      "img|||Log-Home-Stained-in-Denver-PA-.jpg",
      "h3|How Often To Stain A Log Home? Everything You Need to Know|/how-often-to-stain-a-log-home-10-things-you-need-to-know/|",
      "img|||Log-Cabin-Staining-In-PA-.webp",
      "h3|Choosing the Best Log Home Stain|/choosing-the-best-log-home-stain/|",
      "img|||Staining-a-Log-Cabin-in-lebanon.webp",
      "h3|5 Steps to Staining a Log Cabin|/5-steps-to-staining-a-log-cabin/|",
    ]);
  });

  test("the privacy policy: 92 of 93 match; the one that does not is Cloudflare's email obfuscation of the live page", async () => {
    const { converted, live, alignment } = await oracle(PRIVACY, "page");
    expect(converted.length).toBe(93);
    expect(alignment.matched).toBe(92);
    expect(alignment.missing).toEqual(["p|kris@manheimmarketing.com 717-693-4444||"]);
    // The live page prints `[email protected]` with a /cdn-cgi/ link in its place: the address in the
    // database is what the migration carries.
    expect(leftovers(converted, live).liveOnly).toEqual([
      "p|[email protected] 717-693-4444|/cdn-cgi/l/email-protection|",
    ]);
  });

  test("a Cwicly page's core paragraphs are on the live page", async () => {
    for (const page of [
      { site: "fineline", file: "about-us", subject: { kind: "post", id: 1716 } },
      { site: "fineline", file: "residential", subject: { kind: "post", id: 195 } },
    ] as OraclePage[]) {
      const { converted, alignment } = await oracle(page, "page");
      expect(converted.length).toBe(1);
      expect(alignment.missing).toEqual([]);
    }
  });
});

describe("converted blocks against the live pages: written as Markdown entries and built", () => {
  // The entry path is serializeJxMarkdown, the build's collection reader and the build. What it changes
  // is the serializer's and the build's, not the converter's (the tests above show the nodes are exact):
  // the Jx build writes a space between inline siblings, and the Markdown parser reads `4:30` as a text
  // directive. Every element that differs is one of those, and nothing else differs.
  const expected: Record<string, { converted: number; matched: number }> = {
    "essays__the-cultural-captivity-of-the-gospel": { converted: 85, matched: 80 },
    "essays__the-way-we-live-is-the-way-we-educate": { converted: 20, matched: 19 },
    "essays__keeshons-story-a-knock-heard-round-the-hood-part-3": { converted: 24, matched: 22 },
    "choosing-the-best-log-home-stain": { converted: 118, matched: 118 },
  };

  test.each(ESSAY)("$file", async (page) => {
    const { converted, live, alignment } = await oracle(page, "markdown");
    expect({ converted: converted.length, matched: alignment.matched }).toEqual(
      expected[page.file]!,
    );
    const { missing, liveOnly } = leftovers(converted, live);
    const counterparts = new Set(liveOnly.map(uniqueLinks));
    // Each element that differs differs only in the whitespace the build wrote (`20 th`, `HER E`), in
    // a colon read as a directive (`2 Timothy 2 <15>`), or in a link the Markdown reader added around
    // a bare address.
    for (const signature of missing) expect(counterparts.has(uniqueLinks(signature))).toBe(true);
  });

  test("the colon the Markdown parser reads as a directive (`John 3:16` would come back as `John 3<16>`) is written as a span, so the digits are kept", async () => {
    const { nodes, ctx } = await convertMarkup(
      `<!-- wp:paragraph --><p>See John 3:16 and Psalm 23:1-4.</p><!-- /wp:paragraph -->`,
      "ap",
      { kind: "post", id: 8819 },
    );
    const entry = serializeJxMarkdown({ title: "t", slug: "s", children: nodes } as never, {
      mode: "roundtrip",
    });
    const back = (transpileJxMarkdown(entry).children ?? []) as JxNode[];
    expect(JSON.stringify(back)).not.toContain('"tagName":"16"');
    expect(JSON.stringify(back)).not.toContain('"tagName":"1-4"');
    expect(textOfNodes(back).replace(/\s+/g, "")).toBe("SeeJohn3:16andPsalm23:1-4.");
    expect(ctx.report.entries().filter((e) => e.code === "block.text-directive")).toHaveLength(1);
  });
});

// ── Text conservation over both sites ────────────────────────────────────────────────────────────

/** The text a block's saved markup holds, in document order, inner blocks where their `null`s are. */
function savedText(block: WpBlock): string {
  let out = "";
  let at = 0;
  for (const part of block.innerContent) {
    // WordPress texturizes the text of everything `the_content` prints: that is the saved text's reading.
    out += part === null ? savedText(block.innerBlocks[at++]!) : textOfHtml(texturizeHtml(part));
  }
  return out;
}

/** The letters of a text, for comparing two renderings of it: entities decoded, no whitespace at all. */
const letters = (text: string): string => decodeEntities(text).replace(/[\s ​]+/g, "");

/** Every block (Cwicly's looked through, since the driver does) with the context it converts in. */
function* coreBlocks(site: SiteName, loaded: Awaited<ReturnType<typeof loadSite>>) {
  for (const subject of allSubjects(loaded)) {
    const found: WpBlock[] = [];
    const visit = (blocks: WpBlock[]): void => {
      for (const b of blocks) {
        if (b.name?.startsWith("cwicly/")) visit(b.innerBlocks);
        else found.push(b);
      }
    };
    visit(subjectBlocks(loaded, subject));
    for (const block of found) yield { site, subject, block, post: subjectPost(loaded, subject) };
  }
}

/** Blocks whose converted text is not their saved text, and why (each is asserted below). */
const REPLACED = new Set([
  // The saved text is the address; the converted element is the player WordPress's oEmbed made of it.
  "core/embed",
  "core-embed/youtube",
  // The saved text is `[name attr=…]`; the converted element is a placeholder naming the plugin.
  "core/shortcode",
  // The saved markup is empty; the list is built from the post's `footnotes` meta.
  "core/footnotes",
  // Placeholders and bindings: the saved markup is empty or is a form WordPress builds.
  "core/search",
  // The saved markup is empty; an archive template prints the term's name through a binding.
  "core/query-title",
]);

/** All the saved markup of a block and its descendants. */
const markupOf = (block: WpBlock): string => {
  let out = "";
  walkBlocks([block], (b) => {
    out += b.innerContent.join("");
  });
  return out;
};

const holdsCwicly = (block: WpBlock): boolean => {
  let found = false;
  walkBlocks([block], (b) => {
    if (b.name?.startsWith("cwicly/")) found = true;
  });
  return found;
};

describe("text conservation over both sites", () => {
  for (const target of ["page", "default"] as const) {
    test(`every block's converted text is its saved text (${target === "page" ? "as JSON pages" : "each subject's own target"})`, async () => {
      const compared = { fineline: 0, ap: 0 };
      const explained: Record<string, number> = {};
      const unexplained: string[] = [];
      for (const siteName of ["fineline", "ap"] as const) {
        const loaded = await loadSite(siteName);
        let current: string | undefined;
        let ctx!: ConvertCtx;
        for (const { subject, block, post } of coreBlocks(siteName, loaded)) {
          const key = JSON.stringify(subject);
          if (key !== current) {
            current = key;
            ctx = await driven(
              siteName,
              subject,
              target === "page" ? ({ target } as Partial<ConvertCtx>) : {},
            );
          }
          compared[siteName]++;
          const saved = letters(savedText(block));
          const converted = letters(textOfNodes(convertCoreBlock(block, ctx)));
          if (saved === converted) continue;
          const name = block.name ?? "freeform";
          const why = REPLACED.has(name)
            ? "replaced"
            : /\[[a-z_]+[^\]]*\]/i.test(savedText(block))
              ? "shortcode"
              : holdsCwicly(block)
                ? "cwicly-inside"
                : block.innerHTML.includes("<iframe")
                  ? "malformed-iframe"
                  : /<svg[^>]*class="ext"/.test(markupOf(block))
                    ? "icon-dropped"
                    : // The saved text is the address; the converted element is the player `autoembed` made of it.
                      name === "core/paragraph" && /^\s*https?:\/\/\S+\s*$/.test(savedText(block))
                      ? "autoembed"
                      : undefined;
          if (why === undefined) unexplained.push(`${siteName} ${post?.type}:${post?.id} ${name}`);
          else
            explained[`${siteName} ${name} (${why})`] =
              (explained[`${siteName} ${name} (${why})`] ?? 0) + 1;
        }
      }
      expect(compared.fineline).toBeGreaterThan(1200);
      expect(compared.ap).toBeGreaterThan(3000);
      expect(unexplained).toEqual([]);
      // The Drupal link icons are dropped from Markdown entries only (their `<title>` text goes with them).
      const icons =
        target === "page"
          ? {}
          : { "ap core/group (icon-dropped)": 2, "ap core/paragraph (icon-dropped)": 2 };
      expect(explained).toEqual({
        ...icons,
        "fineline core/shortcode (replaced)": 5,
        "fineline core/search (replaced)": 2,
        "fineline core/embed (replaced)": 4,
        "fineline core/group (cwicly-inside)": 1,
        "fineline core/html (shortcode)": 3,
        "ap core/shortcode (replaced)": 15,
        "ap core/search (replaced)": 2,
        "ap core/query-title (replaced)": 2,
        "ap core-embed/youtube (replaced)": 1,
        "ap core/paragraph (malformed-iframe)": 1,
        "ap core/paragraph (autoembed)": 1,
        "ap freeform (shortcode)": 1,
        "ap core/embed (replaced)": 3,
        "ap core/html (shortcode)": 1,
        "ap core/footnotes (replaced)": 1,
      });
    }, 120_000);
  }
});

// ── The census ───────────────────────────────────────────────────────────────────────────────────

/** Every block of the two sites that is not Cwicly's, by name, over every subject (nested ones included). */
const CENSUS: Record<SiteName, Record<string, number>> = {
  fineline: {
    "core/paragraph": 525,
    "core/heading": 359,
    "core/spacer": 193,
    "core/list-item": 174,
    "core/image": 68,
    "core/list": 58,
    "core/template-part": 26,
    "core/group": 19,
    "core/table": 11,
    "icb/image-compare": 11,
    "core/shortcode": 7,
    "core/embed": 4,
    "fluentfom/guten-block": 3,
    "core/html": 3,
    "core/search": 2,
    "core/columns": 1,
    "core/column": 1,
    "core/post-content": 1,
  },
  ap: {
    "core/paragraph": 2560,
    "core/heading": 223,
    "core/group": 209,
    "core/list-item": 187,
    "core/list": 106,
    "core/quote": 76,
    "core/template-part": 46,
    "core/image": 38,
    "core/shortcode": 16,
    "core/separator": 16,
    "core/verse": 11,
    "core/block": 10,
    "ideabox/counter": 10,
    "core/post-content": 6,
    "core/spacer": 6,
    "core/post-title": 5,
    "fluentfom/guten-block": 5,
    "core/buttons": 4,
    "core/button": 4,
    "core/preformatted": 3,
    "core/html": 3,
    "core/table": 3,
    "core/embed": 3,
    "core/query-title": 3,
    "lazyblock/episode-audio-embed": 2,
    "core/post-terms": 2,
    "core/search": 2,
    "lazyblock/no-slug": 1,
    "core-embed/youtube": 1,
    "drupalmedia/drupal-media-entity": 1,
    "drupalblock/views-block-supporters-updates-block-1": 1,
    "give/donation-form": 1,
    "drupalblock/civicrm-block-3": 1,
    "drupalblock/views-block-team-block-1": 1,
    "drupalblock/views-block-team-block-4": 1,
    "drupalblock/views-block-team-block-3": 1,
    "drupalblock/views-block-team-block-2": 1,
    "lazyblock/donor-dashboard-here": 1,
    "core/loginout": 1,
    "core/cover": 1,
    "core/gallery": 1,
    "give/donation-form-grid": 1,
    "core/footnotes": 1,
  },
};
const FREEFORM = { fineline: 6, ap: 104 };

describe("census: every block name of both sites converts", () => {
  for (const siteName of ["fineline", "ap"] as const) {
    test(`${siteName}: the block names and their counts are the census`, async () => {
      const loaded = await loadSite(siteName);
      const counts: Record<string, number> = {};
      let freeform = 0;
      for (const subject of allSubjects(loaded)) {
        walkBlocks(subjectBlocks(loaded, subject), (b) => {
          if (b.name === null) freeform++;
          else if (!b.name.startsWith("cwicly/")) counts[b.name] = (counts[b.name] ?? 0) + 1;
        });
      }
      expect(counts).toEqual(CENSUS[siteName]);
      expect(freeform).toBe(FREEFORM[siteName]);
    });

    test(`${siteName}: every block converts without throwing, and every unknown name is reported with its location`, async () => {
      const loaded = await loadSite(siteName);
      const unsupported: Record<string, number> = {};
      let converted = 0;
      for (const subject of allSubjects(loaded)) {
        const ctx = await driven(siteName, subject);
        ctx.convert(subjectBlocks(loaded, subject));
        converted += 1;
        for (const e of ctx.report.entries()) {
          expect(e.where).toMatch(/^(post|template|component):/);
          expect(e.code).toMatch(/^[a-z]+\.[a-z-]+$/);
          if (e.code === "block.unsupported") {
            const name = String(e.data?.block);
            unsupported[name] = (unsupported[name] ?? 0) + 1;
          }
        }
      }
      expect(converted).toBe(allSubjects(loaded).length);
      const expected = Object.fromEntries(
        Object.entries(CENSUS[siteName]).filter(
          ([name]) => !Object.hasOwn(coreConverters, name) && !name.startsWith("core-embed/"),
        ),
      );
      expect(unsupported).toEqual(expected);
    });
  }

  test("the registry names exactly the core blocks the census and the assignment need", () => {
    expect(Object.keys(coreConverters).sort()).toEqual(
      [
        "core/audio",
        "core/block",
        "core/button",
        "core/buttons",
        "core/code",
        "core/column",
        "core/columns",
        "core/cover",
        "core/details",
        "core/embed",
        "core/file",
        "core/footnotes",
        "core/freeform",
        "core/gallery",
        "core/group",
        "core/heading",
        "core/html",
        "core/image",
        "core/list",
        "core/list-item",
        "core/loginout",
        "core/media-text",
        "core/more",
        "core/navigation",
        "core/navigation-link",
        "core/navigation-submenu",
        "core/nextpage",
        "core/paragraph",
        "core/post-content",
        "core/post-date",
        "core/post-excerpt",
        "core/post-featured-image",
        "core/post-terms",
        "core/post-title",
        "core/preformatted",
        "core/pullquote",
        "core/query-title",
        "core/quote",
        "core/search",
        "core/separator",
        "core/shortcode",
        "core/social-link",
        "core/social-links",
        "core/spacer",
        "core/table",
        "core/template-part",
        "core/verse",
        "core/video",
        "icb/image-compare",
      ].sort(),
    );
  });
});

// ── Real blocks, by name ─────────────────────────────────────────────────────────────────────────

interface Real {
  block: WpBlock;
  subject: Subject;
  ctx: ConvertCtx;
  nodes: JxNode[];
  html: string;
}

/** The `nth` real block of a name (that `pick` accepts), converted in the context of the subject that holds it. */
async function real(
  siteName: SiteName,
  name: string | null,
  pick: (block: WpBlock) => boolean = () => true,
  nth = 0,
  overrides: Partial<ConvertCtx> = {},
): Promise<Real> {
  const loaded = await loadSite(siteName);
  let seen = 0;
  for (const subject of allSubjects(loaded)) {
    const hits: WpBlock[] = [];
    walkBlocks(subjectBlocks(loaded, subject), (b) => {
      if (b.name === name && pick(b)) hits.push(b);
    });
    for (const block of hits) {
      if (seen++ < nth) continue;
      const ctx = await driven(siteName, subject, overrides);
      const nodes = convertCoreBlock(block, ctx);
      return { block, subject, ctx, nodes, html: nodesToHtml(nodes) };
    }
  }
  throw new Error(`no ${name} block (#${nth}) in ${siteName}`);
}

const classes = (node: JxNode | undefined): string[] =>
  typeof node === "string" || node === undefined
    ? []
    : (node.className ?? "").split(/\s+/).filter(Boolean);

const firstEl = (nodes: JxNode[]): JxElement => {
  const node = nodes.find((n): n is JxElement => typeof n !== "string");
  if (!node) throw new Error("no element");
  return node;
};

/** A block of `markup` converted for a JSON page (or, with `target: "markdown"`, a Markdown entry). */
async function page(
  markup: string,
  target: "page" | "markdown" = "page",
  site: SiteName = "fineline",
  overrides: Partial<ConvertCtx> = {},
) {
  return convertMarkup(markup, site, FL_PAGE, { target, ...overrides } as Partial<ConvertCtx>);
}

/**
 * The stub address rewriting (same-site addresses lose their origin), for the tests that invent an
 * upload no media plan or route knows. The real tools leave such an address absolute and report it
 * (`url.unresolved`); one test below holds them to that.
 */
const stubbed = async (site: SiteName = "fineline"): Promise<Partial<ConvertCtx>> => ({
  rewriteUrl: stubRewriteUrl(await loadSite(site)),
});
const para = (inner: string, attrs = ""): string =>
  `<!-- wp:paragraph${attrs} --><p>${inner}</p><!-- /wp:paragraph -->`;

describe("text blocks", () => {
  test("a paragraph is its saved markup: no class WordPress adds at render time and nothing styles", async () => {
    const r = await real("fineline", "core/paragraph", (b) =>
      b.innerHTML.includes("Manheim Marketing"),
    );
    expect(r.html.startsWith("<p>")).toBe(true);
    expect(r.html).not.toContain("class=");
    expect(squash(textOfNodes(r.nodes))).toBe(
      "© 2026 finelinepainting.pro | Website by Manheim Marketing",
    );
    expect(r.ctx.report.entries()).toEqual([]);
  });

  test("the classes a paragraph's markup carries are kept in className", async () => {
    const r = await page(
      `<!-- wp:paragraph {"align":"center","fontSize":"large"} --><p class="has-text-align-center has-large-font-size has-primary-color has-text-color">x</p><!-- /wp:paragraph -->`,
    );
    expect(classes(r.nodes[0])).toEqual([
      "has-text-align-center",
      "has-large-font-size",
      "has-primary-color",
      "has-text-color",
    ]);
  });

  test("an inline style becomes a style object scoped to its own class, so it leaks onto no other element", async () => {
    const r = await page(
      para(`a`).replace("<p>", `<p class="note" style="font-weight:400;margin-top:1rem">`),
    );
    const p = firstEl(r.nodes);
    expect(p.style).toEqual({ fontWeight: "400", marginTop: "1rem" });
    expect(classes(p)[0]).toMatch(/^jx-[0-9a-f]{10}$/);
    expect(classes(p)[1]).toBe("note");
    expect(p.attributes?.style).toBeUndefined();
  });

  test("real: ap's verse block keeps its pre, its spans' styles as objects, and its note marker link", async () => {
    // As a JSON page: a Markdown entry writes the lines as text (see "Markdown entries: what the serializer cannot write").
    const r = await real("ap", "core/verse", (b) => b.innerHTML.includes("solitude of space"), 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    const pre = firstEl(r.nodes);
    expect(pre.tagName).toBe("pre");
    expect(classes(pre)).toEqual(["wp-block-verse"]);
    expect(r.html).toContain(`<span style="font-weight: 400">There is a solitude of space </span>`);
    expect(r.html).toContain(`<sup><a class="ek-link" href="#note7">7</a></sup>`);
  });

  test("a heading keeps wp-block-heading, an anchor id and a link; its level is its tag", async () => {
    const r = await page(
      `<!-- wp:heading {"level":3,"anchor":"top"} --><h3 class="wp-block-heading" id="top">Hi <a href="https://finelinepainting.pro/about-us/">there</a></h3><!-- /wp:heading -->`,
    );
    expect(r.html).toBe(
      `<h3 id="top" class="wp-block-heading">Hi <a href="/about-us/">there</a></h3>`,
    );
  });

  test("real: fineline's blog list keeps its class on a page and gets a plain list in an entry", async () => {
    const asPage = await real(
      "fineline",
      "core/list",
      (b) => b.innerHTML.includes("wp-block-list"),
      0,
      {
        target: "page",
      } as Partial<ConvertCtx>,
    );
    expect(classes(asPage.nodes[0])).toEqual(["wp-block-list"]);
    expect(asPage.html).toBe(
      `<ul class="wp-block-list"><li><strong>Lack of time</strong></li></ul>`,
    );
    const asEntry = await real("fineline", "core/list", (b) =>
      b.innerHTML.includes("wp-block-list"),
    );
    const ul = firstEl(asEntry.nodes);
    expect(ul.className).toBeUndefined();
    // Nothing styles wp-block-list by itself, so dropping it is not worth a report.
    expect(entriesOf(asEntry.ctx, "block.markdown-attributes-dropped")).toEqual([]);
  });

  test("a list saved before the class existed is not given it, unless it has a background", async () => {
    const plain = await page(
      `<!-- wp:list --><ul><!-- wp:list-item --><li>a</li><!-- /wp:list-item --></ul><!-- /wp:list -->`,
    );
    expect(firstEl(plain.nodes).className).toBeUndefined();
    const bg = await page(
      `<!-- wp:list {"backgroundColor":"base"} --><ul class="has-base-background-color has-background"><!-- wp:list-item --><li>a</li><!-- /wp:list-item --></ul><!-- /wp:list -->`,
    );
    expect(classes(bg.nodes[0])).toEqual([
      "has-base-background-color",
      "has-background",
      "wp-block-list",
    ]);
  });

  test("real: a nested list keeps the inner list inside the item that held it", async () => {
    const r = await real(
      "ap",
      "core/list",
      (b) => b.innerBlocks.some((i) => i.innerBlocks.length > 0),
      0,
      {
        target: "page",
      } as Partial<ConvertCtx>,
    );
    expect(r.html).toMatch(/<li>[^<]+<ul>(<li>.*<\/li>)+<\/ul><\/li>/);
  });

  test("an ordered list keeps start, reversed and type", async () => {
    const r = await page(
      `<!-- wp:list {"ordered":true,"start":3,"reversed":true} --><ol start="3" reversed class="wp-block-list"><!-- wp:list-item --><li>a</li><!-- /wp:list-item --></ol><!-- /wp:list -->`,
    );
    const ol = firstEl(r.nodes);
    expect(ol.tagName).toBe("ol");
    expect(ol.attributes).toMatchObject({ start: "3" });
    expect(r.html).toContain("reversed");
  });

  test("real: ap's quote keeps its blockquote, its paragraph, and the note marker", async () => {
    const r = await real("ap", "core/quote", (b) => b.innerHTML.includes("blockquote"), 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    expect(r.html.startsWith(`<blockquote class="wp-block-quote"><p>`)).toBe(true);
    expect(r.html).toMatch(
      /<sup><a (?:href="#note1" class="ek-link"|class="ek-link" href="#note1")>1<\/a><\/sup>/,
    );
  });

  test("a pullquote, a code block and a preformatted block are their saved markup", async () => {
    const r = await page(
      `<!-- wp:pullquote --><figure class="wp-block-pullquote"><blockquote><p>Words</p><cite>Someone</cite></blockquote></figure><!-- /wp:pullquote -->` +
        `<!-- wp:code --><pre class="wp-block-code"><code>a &lt; b\n  c</code></pre><!-- /wp:code -->` +
        `<!-- wp:preformatted --><pre class="wp-block-preformatted">one<br>two</pre><!-- /wp:preformatted -->`,
    );
    expect(r.html).toBe(
      `<figure class="wp-block-pullquote"><blockquote><p>Words</p><cite>Someone</cite></blockquote></figure>` +
        `<pre class="wp-block-code"><code>a &lt; b\n  c</code></pre>` +
        `<pre class="wp-block-preformatted">one<br>two</pre>`,
    );
  });

  test("the separator is an hr with its classes, the spacer a div with its height", async () => {
    const r = await page(
      `<!-- wp:separator {"opacity":"css"} --><hr class="wp-block-separator has-css-opacity"/><!-- /wp:separator -->` +
        `<!-- wp:spacer {"height":"40px"} --><div style="height:40px" aria-hidden="true" class="wp-block-spacer"></div><!-- /wp:spacer -->`,
    );
    const [hr, spacer] = r.nodes as JxElement[];
    expect(hr).toEqual({ tagName: "hr", className: "wp-block-separator has-css-opacity" });
    expect(spacer!.tagName).toBe("div");
    expect(spacer!.style).toEqual({ height: "40px" });
    expect(spacer!.attributes).toEqual({ "aria-hidden": "true" });
    expect(classes(spacer)[1]).toBe("wp-block-spacer");
  });

  test("real: every one of fineline's 193 spacers keeps its height", async () => {
    const loaded = await loadSite("fineline");
    let n = 0;
    for (const subject of allSubjects(loaded)) {
      const spacers: WpBlock[] = [];
      walkBlocks(subjectBlocks(loaded, subject), (b) => {
        if (b.name === "core/spacer") spacers.push(b);
      });
      if (spacers.length === 0) continue;
      const ctx = await driven("fineline", subject);
      for (const b of spacers) {
        const el = firstEl(convertCoreBlock(b, ctx));
        const saved = /style="height:\s*([^;"]+)/.exec(b.innerHTML)![1]!;
        expect(el.style).toEqual({ height: saved });
        n++;
      }
    }
    expect(n).toBe(193);
  });
});

describe("media blocks", () => {
  test("real: an image's uploads URL becomes the media plan's path and the size of the file the markup named, and the figure keeps its classes", async () => {
    const r = await real("fineline", "core/image", (b) => b.attrs.id === 2173, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    const figure = firstEl(r.nodes);
    expect(figure.tagName).toBe("figure");
    expect(classes(figure)).toEqual(["wp-block-image", "size-large"]);
    expect(r.html).toBe(
      `<figure class="wp-block-image size-large"><img class="wp-image-2173" src="/media/whole-house-painting-in-lancaster-and-lebanon-pa.jpeg" alt="whole house painting in lancaster and lebanon pa" width="1024" height="768"></figure>`,
    );
    expect(r.ctx.report.entries()).toEqual([]);
  });

  test("real: a linked image keeps the link, rewritten, around the image", async () => {
    const r = await real("ap", "core/image", (b) => b.attrs.id === 13312, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    // The PDF is an upload of the site, so the link goes where the plan ships it.
    expect(r.html).toContain(`<a href="/media/2025-Ministry-Report-Digital.pdf"><img`);
    expect(r.html).toContain(`src="/media/2025-Ministry-Report-Preview-Image.jpg"`);
    // The editor's own size (a width and `height:auto` in the style) is kept next to the plan's.
    expect(r.html).toMatch(/style="width: 466px; height: auto"/);
  });

  test("real: a resized image keeps the width and height the editor wrote, not the shipped file's", async () => {
    const r = await real("ap", "core/image", (b) => b.attrs.id === 734);
    expect(r.html).toContain(`width="240" height="162"`);
    expect(r.html).toContain("<figcaption>Here is our summary financial report");
  });

  test("real: a caption keeps its markup and its link, rewritten", async () => {
    const r = await real("ap", "core/image", (b) => b.attrs.id === 722, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    expect(r.html).toContain(`<figcaption class="wp-element-caption">Marlin Sommers`);
    // /partners is a draft page here (a Drupal-era address): no route accounts for it, so the link
    // keeps its own address and the report says so.
    expect(r.html).toContain(
      `<a href="https://anabaptistperspectives.org/partners">monthly financial partners.</a>`,
    );
    expect(entriesOf(r.ctx, "url.unresolved").map((e) => e.data?.url)).toContain(
      "https://anabaptistperspectives.org/partners",
    );
  });

  test("srcset and sizes are dropped, and a new-window link gets noopener", async () => {
    const r = await page(
      `<!-- wp:image {"id":2173} --><figure class="wp-block-image"><a href="https://example.com/x" target="_blank"><img src="https://finelinepainting.pro/wp-content/uploads/whole-house-painting-in-lancaster-and-lebanon-pa-1024x768.jpeg" srcset="https://finelinepainting.pro/wp-content/uploads/whole-house-painting-in-lancaster-and-lebanon-pa-300x225.jpeg 300w" sizes="(max-width: 1024px) 100vw, 1024px" alt="a"/></a></figure><!-- /wp:image -->`,
    );
    expect(r.html).not.toContain("srcset");
    expect(r.html).not.toContain("sizes");
    expect(r.html).toContain(`rel="noopener"`);
    expect(r.html).toContain(`src="/media/whole-house-painting-in-lancaster-and-lebanon-pa.jpeg"`);
  });

  test("a lightbox is reported (it is WordPress's script) and the image is kept in place", async () => {
    const r = await page(
      `<!-- wp:image {"id":2173,"lightbox":{"enabled":true}} --><figure class="wp-block-image"><img src="https://finelinepainting.pro/wp-content/uploads/whole-house-painting-in-lancaster-and-lebanon-pa-1024x768.jpeg" alt=""/></figure><!-- /wp:image -->`,
    );
    expect(r.html).toContain("<img");
    const [entry] = entriesOf(r.ctx, "block.image-lightbox");
    expect(entry).toMatchObject({
      severity: "info",
      where: "post:3483",
      data: { block: "core/image", id: 2173 },
    });
    // A block with the lightbox off is not reported.
    const off = await page(
      `<!-- wp:image {"id":2173,"lightbox":{"enabled":false}} --><figure class="wp-block-image"><img src="https://finelinepainting.pro/wp-content/uploads/whole-house-painting-in-lancaster-and-lebanon-pa-1024x768.jpeg" alt=""/></figure><!-- /wp:image -->`,
    );
    expect(off.codes).toEqual([]);
  });

  test("real: ap's old Drupal image paths stay as paths (rewriteUrl reports them), their attributes kept", async () => {
    const r = await real("ap", "core/image", (b) => b.attrs.id === 540);
    expect(r.html).toContain(
      `src="/sites/anabaptistperspectives.org/files/styles/large/public/inline-images/image.png"`,
    );
  });

  test("real: the new-style gallery keeps its figures, their captions and the gallery's classes", async () => {
    const r = await real("ap", "core/gallery", () => true, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    const gallery = firstEl(r.nodes);
    expect(classes(gallery)).toEqual([
      "wp-block-gallery",
      "has-nested-images",
      "columns-default",
      "is-cropped",
    ]);
    expect(gallery.children).toHaveLength(3);
    expect(r.html).toContain(
      `<figcaption class="wp-element-caption">Discussion and collaboration among the team</figcaption>`,
    );
    expect(r.html).toContain(`src="/media/IMG_2362-scaled.jpg"`);
  });

  test("the pre-5.9 gallery (a list of figures) keeps its list", async () => {
    const r = await page(
      `<!-- wp:gallery {"columns":2} --><figure class="wp-block-gallery columns-2 is-cropped"><ul class="blocks-gallery-grid"><li class="blocks-gallery-item"><figure><img src="https://finelinepainting.pro/wp-content/uploads/whole-house-painting-in-lancaster-and-lebanon-pa-1024x768.jpeg" alt="a"/><figcaption class="blocks-gallery-item__caption">cap</figcaption></figure></li></ul></figure><!-- /wp:gallery -->`,
    );
    expect(r.html).toContain(
      `<ul class="blocks-gallery-grid"><li class="blocks-gallery-item"><figure><img`,
    );
    expect(r.html).toContain("cap</figcaption>");
  });

  test("a video keeps its controls, its source and its poster, rewritten", async () => {
    const loaded = await loadSite("fineline");
    const attachment = loaded.model.attachments.get(2173)!;
    const r = await page(
      `<!-- wp:video {"id":5} --><figure class="wp-block-video"><video controls poster="${attachment.url}" src="https://finelinepainting.pro/wp-content/uploads/2024/01/tour.mp4"></video><figcaption class="wp-element-caption">Tour</figcaption></figure><!-- /wp:video -->`,
      "page",
      "fineline",
      await stubbed(),
    );
    expect(r.html).toContain(
      `poster="/media/whole-house-painting-in-lancaster-and-lebanon-pa.jpeg"`,
    );
    expect(r.html).toContain(`controls`);
    expect(r.html).toContain(`src="/wp-content/uploads/2024/01/tour.mp4"`);
    expect(r.html).toContain(`<figcaption class="wp-element-caption">Tour</figcaption>`);
    expect(firstEl(r.nodes).tagName).toBe("figure");
  });

  test("audio and file blocks keep their markup, their addresses and the download button", async () => {
    const r = await page(
      `<!-- wp:audio --><figure class="wp-block-audio"><audio controls src="https://finelinepainting.pro/a.mp3"></audio></figure><!-- /wp:audio -->` +
        `<!-- wp:file {"id":9} --><div class="wp-block-file"><a id="wp-block-file--media-1" href="https://finelinepainting.pro/doc.pdf">Doc</a><a href="https://finelinepainting.pro/doc.pdf" class="wp-block-file__button wp-element-button" download aria-describedby="wp-block-file--media-1">Download</a></div><!-- /wp:file -->`,
      "page",
      "fineline",
      await stubbed(),
    );
    expect(r.html).toMatch(/<audio controls(?:="")? src="\/a\.mp3"><\/audio>/);
    expect(r.html).toContain(`<a id="wp-block-file--media-1" href="/doc.pdf">Doc</a>`);
    expect(r.html).toContain(`download`);
    expect(r.html).toContain(`class="wp-block-file__button wp-element-button"`);
    expect(r.html).toContain(`aria-describedby="wp-block-file--media-1"`);
  });

  test("an upload of the site that the media plan does not ship keeps its address and is reported", async () => {
    const r = await page(
      `<!-- wp:audio --><figure class="wp-block-audio"><audio controls src="https://finelinepainting.pro/a.mp3"></audio></figure><!-- /wp:audio -->`,
    );
    expect(r.html).toMatch(
      /<audio controls(?:="")? src="https:\/\/finelinepainting\.pro\/a\.mp3">/,
    );
    expect(entriesOf(r.ctx, "url.unresolved").map((e) => e.data?.url)).toEqual([
      "https://finelinepainting.pro/a.mp3",
    ]);
  });

  test("a cover block keeps its image as the plan's path, its dim span and its inner blocks", async () => {
    const r = await real("ap", "core/cover", () => true, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    const cover = firstEl(r.nodes);
    expect(classes(cover)).toEqual(["wp-block-cover"]);
    expect(r.html).toContain(
      `<span class="wp-block-cover__background has-background-dim" aria-hidden="true"></span>`,
    );
    expect(r.html).toContain(`src="/media/Chester-and-Reagan-recording-scaled.jpg"`);
    // The inner paragraph is INSIDE the cover's container. The cover's empty span and image next to
    // the container make the build separate them with a space, so the usual conversion would hold
    // the container as markup and the paragraph could not be put in it.
    expect(r.html).toContain(
      `<div class="wp-block-cover__inner-container is-layout-flow wp-block-cover-is-layout-flow"><p class="has-text-align-center has-large-font-size"></p></div></div>`,
    );
    expect(entriesOf(r.ctx, "block.inner-misplaced")).toEqual([]);
    expect(entriesOf(r.ctx, "block.inline-gap")).toHaveLength(1);
  });

  test("a media-text block keeps its grid style and its two halves", async () => {
    const r = await page(
      `<!-- wp:media-text {"mediaPosition":"right","mediaWidth":33,"mediaType":"image"} --><div class="wp-block-media-text has-media-on-the-right is-stacked-on-mobile" style="grid-template-columns:auto 33%"><div class="wp-block-media-text__content"><!-- wp:paragraph --><p>Text</p><!-- /wp:paragraph --></div><figure class="wp-block-media-text__media"><img src="https://finelinepainting.pro/wp-content/uploads/whole-house-painting-in-lancaster-and-lebanon-pa-1024x768.jpeg" alt=""/></figure></div><!-- /wp:media-text -->`,
    );
    const root = firstEl(r.nodes);
    expect(root.style).toEqual({ gridTemplateColumns: "auto 33%" });
    expect(classes(root).slice(1)).toEqual([
      "wp-block-media-text",
      "has-media-on-the-right",
      "is-stacked-on-mobile",
    ]);
    expect(r.html).toContain(`<div class="wp-block-media-text__content"><p>Text</p></div>`);
    expect(r.html).toContain(`<figure class="wp-block-media-text__media"><img`);
  });

  test("details keeps summary and body as native elements", async () => {
    const r = await page(
      `<!-- wp:details {"showContent":true} --><details class="wp-block-details" open><summary>Question</summary><!-- wp:paragraph --><p>Answer</p><!-- /wp:paragraph --></details><!-- /wp:details -->`,
    );
    expect(r.html).toBe(
      `<details class="wp-block-details is-layout-flow wp-block-details-is-layout-flow" open=""><summary>Question</summary><p>Answer</p></details>`,
    );
  });
});

describe("embeds", () => {
  test("real: the player is the oEmbed response WordPress cached in the post's meta, title and all", async () => {
    const r = await real("fineline", "core/embed", () => true, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    expect(r.html).toContain(
      `<iframe title="How Often Should I Stain My Log Cabin or Wood Sided Home?"`,
    );
    expect(r.html).toContain(`src="https://www.youtube.com/embed/0v6Am_4p1Xk?feature=oembed"`);
    expect(r.html).not.toContain("https://www.youtube.com/watch");
    expect(classes(r.nodes[0])).toEqual([
      "wp-block-embed",
      "is-type-video",
      "is-provider-youtube",
      "wp-block-embed-youtube",
      "wp-embed-aspect-16-9",
      "wp-has-aspect-ratio",
    ]);
    expect(r.ctx.report.entries()).toEqual([]);
  });

  test("real: an embed keeps its caption next to the player", async () => {
    const r = await real("ap", "core/embed", () => true, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    expect(r.html).toContain(`<iframe title="Mennonite Nazis — Chester Weaver — Ep. 098"`);
    expect(r.html).toContain(
      `<figcaption><strong>Mennonite Nazis</strong> (a lecture by Chester Weaver)`,
    );
  });

  test("real: the pre-5.6 spelling core-embed/youtube is an embed too", async () => {
    const r = await real("ap", "core-embed/youtube", () => true, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    expect(r.html).toContain(`<iframe title="How Should We Live? — Elijah Yoder — Ep. 008"`);
    expect(r.ctx.report.entries()).toEqual([]);
  });

  test("with no cached response a YouTube address becomes the player an oEmbed would return, and it is reported", async () => {
    const r = await page(
      `<!-- wp:embed {"url":"https://youtu.be/abc123","type":"video","providerNameSlug":"youtube"} --><figure class="wp-block-embed is-type-video is-provider-youtube wp-block-embed-youtube"><div class="wp-block-embed__wrapper">\nhttps://youtu.be/abc123\n</div></figure><!-- /wp:embed -->`,
    );
    expect(r.html).toContain(`<iframe title="YouTube video player"`);
    expect(r.html).toContain(`src="https://www.youtube.com/embed/abc123?feature=oembed"`);
    expect(entriesOf(r.ctx, "block.embed-reconstructed")[0]).toMatchObject({
      severity: "info",
      where: "post:3483",
      data: { url: "https://youtu.be/abc123", provider: "youtube" },
    });
  });

  test("YouTube playlists and Vimeo addresses are rebuilt with their own ids", async () => {
    const list = await page(
      `<!-- wp:embed {"url":"https://www.youtube.com/playlist?list=PL42"} --><figure class="wp-block-embed"><div class="wp-block-embed__wrapper">\nhttps://www.youtube.com/playlist?list=PL42\n</div></figure><!-- /wp:embed -->`,
    );
    expect(list.html).toContain(
      `src="https://www.youtube.com/embed/videoseries?list=PL42&amp;feature=oembed"`,
    );
    const withList = await page(
      `<!-- wp:embed {"url":"https://www.youtube.com/watch?v=abc&list=PL42"} --><figure class="wp-block-embed"><div class="wp-block-embed__wrapper">\nhttps://www.youtube.com/watch?v=abc&list=PL42\n</div></figure><!-- /wp:embed -->`,
    );
    expect(withList.html).toContain(`embed/abc?list=PL42&amp;feature=oembed`);
    const vimeo = await page(
      `<!-- wp:embed {"url":"https://vimeo.com/123456789","providerNameSlug":"vimeo"} --><figure class="wp-block-embed"><div class="wp-block-embed__wrapper">\nhttps://vimeo.com/123456789\n</div></figure><!-- /wp:embed -->`,
    );
    expect(vimeo.html).toContain(
      `<iframe title="Vimeo video" src="https://player.vimeo.com/video/123456789?dnt=1`,
    );
  });

  test("a provider with no player to build (a tweet) stays a link, and is reported as unresolved", async () => {
    const r = await page(
      `<!-- wp:embed {"url":"https://twitter.com/jx/status/1","providerNameSlug":"twitter"} --><figure class="wp-block-embed is-provider-twitter"><div class="wp-block-embed__wrapper">\nhttps://twitter.com/jx/status/1\n</div></figure><!-- /wp:embed -->`,
    );
    // Rank Math opens every external link of a post's content in a new window, this one included.
    expect(r.html).toContain(
      `<a href="https://twitter.com/jx/status/1" target="_blank" rel="noopener">https://twitter.com/jx/status/1</a>`,
    );
    expect(entriesOf(r.ctx, "block.embed-unresolved")[0]).toMatchObject({
      severity: "warn",
      data: { url: "https://twitter.com/jx/status/1", provider: "twitter" },
    });
  });

  test("an embed whose wrapper holds nothing is its saved markup", async () => {
    const r = await page(
      `<!-- wp:embed --><figure class="wp-block-embed"><figcaption>x</figcaption></figure><!-- /wp:embed -->`,
    );
    expect(r.html).toBe(`<figure class="wp-block-embed"><figcaption>x</figcaption></figure>`);
    expect(r.codes).toEqual([]);
  });
});

describe("tables", () => {
  const TABLE = (cls: string) =>
    `<!-- wp:table {"className":"${cls}"} --><figure class="wp-block-table ${cls}"><table class="${cls}"><thead><tr><th>Size</th><th>Price</th></tr></thead><tbody><tr><td>1</td><td colspan="2">$4,200</td></tr></tbody></table></figure><!-- /wp:table -->`;

  test("real: a table is its saved markup on a JSON page, classes included", async () => {
    const r = await real(
      "fineline",
      "core/table",
      (b) => b.innerHTML.includes("has-fixed-layout"),
      0,
      {
        target: "page",
      } as Partial<ConvertCtx>,
    );
    const figure = firstEl(r.nodes);
    expect(classes(figure)).toEqual(["wp-block-table", "has-fixed-layout"]);
    expect(r.html).toContain(`<table class="has-fixed-layout"><tbody><tr><td>House Size</td>`);
    expect(r.ctx.report.entries()).toEqual([]);
  });

  test("in a Markdown entry the table's own classes are dropped, because the serializer writes a classed table EMPTY", async () => {
    const r = await page(TABLE("is-style-stripes"), "markdown");
    const figure = firstEl(r.nodes);
    expect(classes(figure)).toEqual(["wp-block-table", "is-style-stripes"]);
    const table = (figure.children as JxElement[])[0]!;
    expect(table.tagName).toBe("table");
    expect(table.className).toBeUndefined();
    const md = serializeJxMarkdown({ children: r.nodes } as never, { mode: "roundtrip" });
    expect(md).toMatch(/\| Size\s+\| Price\s+\|/);
    expect(md).toContain("$4,200");
    const [dropped] = entriesOf(r.ctx, "block.markdown-attributes-dropped");
    expect(dropped).toMatchObject({
      severity: "info",
      where: "post:3483",
      data: { element: "table", classes: ["is-style-stripes"], count: 1 },
    });
  });

  test("a table inside a group is reported once, not once per level that holds it", async () => {
    const r = await page(
      `<!-- wp:group --><div class="wp-block-group"><!-- wp:group --><div class="wp-block-group">${TABLE("x")}</div><!-- /wp:group --></div><!-- /wp:group -->`,
      "markdown",
    );
    expect(entriesOf(r.ctx, "block.table-span-dropped")).toHaveLength(1);
    expect(entriesOf(r.ctx, "block.markdown-attributes-dropped")).toHaveLength(1);
  });

  test("a cell that spans columns cannot be written in Markdown: the loss is reported", async () => {
    const r = await page(TABLE("x"), "markdown");
    expect(entriesOf(r.ctx, "block.table-span-dropped")[0]).toMatchObject({
      severity: "warn",
      data: { cells: 1 },
    });
    const asPage = await page(TABLE("x"), "page");
    expect(asPage.codes).toEqual([]);
    expect(asPage.html).toContain(`<td colspan="2">$4,200</td>`);
  });
});

describe("layout blocks", () => {
  test("real: a group keeps its id and class, and gets the layout classes WordPress adds when it renders", async () => {
    const r = await real("ap", "core/group", (b) => b.innerHTML.includes('id="note1context"'), 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    const div = firstEl(r.nodes);
    expect(div.id).toBe("note1context");
    expect(classes(div)).toEqual([
      "wp-block-group",
      "is-layout-flow",
      "wp-block-group-is-layout-flow",
    ]);
    expect(r.html).toContain(`<blockquote class="wp-block-quote"><p>`);
  });

  test("the layout type in the attributes decides the layout classes; `inherit` and a content size mean constrained", async () => {
    const group = async (attrs: string) =>
      classes(
        (
          await page(
            `<!-- wp:group ${attrs} --><div class="wp-block-group"></div><!-- /wp:group -->`,
          )
        ).nodes[0],
      );
    expect(await group("{}")).toEqual([
      "wp-block-group",
      "is-layout-flow",
      "wp-block-group-is-layout-flow",
    ]);
    expect(await group('{"layout":{"type":"constrained"}}')).toEqual([
      "wp-block-group",
      "is-layout-constrained",
      "wp-block-group-is-layout-constrained",
    ]);
    expect(await group('{"layout":{"inherit":true}}')).toContain("is-layout-constrained");
    expect(await group('{"layout":{"contentSize":"800px"}}')).toContain("is-layout-constrained");
    expect(await group('{"layout":{"type":"flex","orientation":"vertical"}}')).toContain(
      "is-layout-flex",
    );
    expect(await group('{"layout":{"type":"grid"}}')).toContain("wp-block-group-is-layout-grid");
    expect(await group('{"layout":{"type":"default"}}')).toContain("is-layout-flow");
  });

  test("a layout class the markup already carries is not written twice", async () => {
    const r = await page(
      `<!-- wp:group --><div class="wp-block-group is-layout-flow wp-block-group-is-layout-flow"></div><!-- /wp:group -->`,
    );
    expect(classes(r.nodes[0])).toEqual([
      "wp-block-group",
      "is-layout-flow",
      "wp-block-group-is-layout-flow",
    ]);
  });

  test("layoutClasses: blocks with no layout support get none, the defaults are per block", () => {
    expect(layoutClasses("paragraph", {})).toEqual([]);
    expect(layoutClasses("columns", {})).toEqual([
      "is-layout-flex",
      "wp-block-columns-is-layout-flex",
    ]);
    expect(layoutClasses("buttons", {})).toEqual([
      "is-layout-flex",
      "wp-block-buttons-is-layout-flex",
    ]);
    expect(layoutClasses("post-content", {})).toEqual([
      "is-layout-flow",
      "wp-block-post-content-is-layout-flow",
    ]);
    expect(layoutClasses("group", { layout: "not an object" })).toEqual([
      "is-layout-flow",
      "wp-block-group-is-layout-flow",
    ]);
  });

  test("real: columns keep their flex classes and each column keeps its percentage width as a style object", async () => {
    const r = await real("fineline", "core/columns", () => true, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    const columns = firstEl(r.nodes);
    expect(classes(columns)).toEqual([
      "wp-block-columns",
      "is-layout-flex",
      "wp-block-columns-is-layout-flex",
    ]);
    const column = (columns.children as JxElement[])[0]!;
    expect(classes(column).slice(1)).toEqual([
      "wp-block-column",
      "is-layout-flow",
      "wp-block-column-is-layout-flow",
    ]);
    // The block library's `[style*=flex-basis]{flex-grow:0}` cannot see a style object: it is written.
    expect(column.style).toEqual({ flexBasis: "100%", flexGrow: "0" });
  });

  test("a column with no width is not given a flex-grow of its own", async () => {
    const r = await page(
      `<!-- wp:column --><div class="wp-block-column"></div><!-- /wp:column -->`,
    );
    expect(firstEl(r.nodes).style).toBeUndefined();
  });

  test("a column's own flex-grow in the saved style wins over the one written for flex-basis", async () => {
    const r = await page(
      `<!-- wp:column {"width":"30%"} --><div class="wp-block-column" style="flex-basis:30%;flex-grow:2"></div><!-- /wp:column -->`,
    );
    expect(firstEl(r.nodes).style).toEqual({ flexBasis: "30%", flexGrow: "2" });
  });

  test("real: buttons and a button keep their classes and the rewritten link", async () => {
    const r = await real("ap", "core/buttons", () => true, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    const buttons = firstEl(r.nodes);
    expect(classes(buttons)).toEqual([
      "wp-block-buttons",
      "is-layout-flex",
      "wp-block-buttons-is-layout-flex",
    ]);
    expect(r.html).toContain(
      `<div class="wp-block-button"><a class="wp-block-button__link" href="/donate/?fbclid=IwAR1Q18ruADj9iTLnDCthr5UzxglRpqNeTq5sSUsEcDdscAzYRUcctckFStc">Support Anabaptist Perspectives Here</a></div>`,
    );
  });

  test("social links: the list takes the flex layout, each link keeps its address and label", async () => {
    const r = await page(
      `<!-- wp:social-links {"openInNewTab":true} --><ul class="wp-block-social-links"><!-- wp:social-link {"url":"https://facebook.com/fp","service":"facebook","rel":"noopener"} /--><!-- wp:social-link {"url":"https://finelinepainting.pro/contact-us/","service":"mail","label":"Write us"} /--></ul><!-- /wp:social-links -->`,
    );
    const ul = firstEl(r.nodes);
    expect(classes(ul)).toEqual([
      "wp-block-social-links",
      "is-layout-flex",
      "wp-block-social-links-is-layout-flex",
    ]);
    expect(r.html).toContain(
      // The parent's openInNewTab is what opens the link in a new window, with the rel WordPress adds.
      `<li class="wp-social-link wp-social-link-facebook wp-block-social-link"><a class="wp-block-social-link-anchor" href="https://facebook.com/fp" rel="noopener nofollow" target="_blank"><span class="wp-block-social-link-label screen-reader-text">Facebook</span></a></li>`,
    );
    expect(r.html).toContain(`href="/contact-us/"`);
    expect(r.html).toContain(`>Write us<`);
    expect(entriesOf(r.ctx, "block.social-icon")).toHaveLength(2);
  });
});

describe("raw HTML, shortcodes and classic content", () => {
  test("a raw HTML block is converted as markup, with its addresses rewritten", async () => {
    const r = await page(
      `<!-- wp:html --><div class="x"><a href="https://finelinepainting.pro/about-us/" target="_blank">About</a> <b>us</b></div><!-- /wp:html -->`,
    );
    expect(r.html).toBe(
      `<div class="x"><a href="/about-us/" target="_blank" rel="noopener">About</a> <b>us</b></div>`,
    );
    expect(r.codes).toEqual([]);
  });

  test("real: a script in a raw HTML block is kept as written and reported with its address", async () => {
    const r = await real("fineline", "core/shortcode", (b) => b.innerHTML.includes("<script"), 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    expect(r.html).toMatch(
      /<script defer(?:="")? async(?:="")? src="https:\/\/cdn\.trustindex\.io\/loader\.js\?cbb085470d64073e5496e8a974f"><\/script>/,
    );
    // WordPress runs wpautop over the block: the live page prints `<p><script …></script></p>`
    expect(r.html).toStartWith("<p><script");
    expect(r.html).toEndWith("</script></p>");
    expect(entriesOf(r.ctx, "block.html-script")[0]).toMatchObject({
      severity: "warn",
      data: { src: "https://cdn.trustindex.io/loader.js?cbb085470d64073e5496e8a974f" },
    });
    expect(entriesOf(r.ctx, "block.shortcode")[0]!.message).toContain(
      "holds markup and no shortcode",
    );
  });

  test("an inline script is kept and reported by its length", async () => {
    const r = await page(`<!-- wp:html --><script>window.x = 1;</script><!-- /wp:html -->`);
    expect(r.html).toContain("window.x = 1;");
    expect(entriesOf(r.ctx, "block.html-script")[0]!.data).toEqual({
      block: "core/html",
      length: 13,
    });
  });

  test("real: [trustindex] and the Interactive Geo Maps shortcode become placeholders with data attributes, and are reported", async () => {
    const trust = await real("fineline", "core/shortcode", (b) =>
      b.innerHTML.includes("[trustindex"),
    );
    expect(trust.nodes).toEqual([
      {
        tagName: "wp2jx-shortcode",
        attributes: {
          "data-shortcode": "trustindex",
          "data-attributes": '{"no-registration":"google"}',
          "data-source": "[trustindex no-registration=google]",
        },
      },
    ]);
    expect(entriesOf(trust.ctx, "block.shortcode")[0]).toMatchObject({
      severity: "warn",
      data: {
        block: "core/shortcode",
        shortcode: "trustindex",
        attributes: { "no-registration": "google" },
        label: "Trustindex review widget",
      },
    });
    const map = await real("fineline", "core/shortcode", (b) =>
      b.innerHTML.includes("[display-map"),
    );
    expect(firstEl(map.nodes).attributes).toMatchObject({
      "data-shortcode": "display-map",
      "data-attributes": '{"id":"3197"}',
    });
  });

  test("a shortcode block with an unknown name is still a placeholder; one with no shortcode in it is kept", async () => {
    const unknown = await page(`<!-- wp:shortcode -->[mystery a=1]<!-- /wp:shortcode -->`);
    expect(firstEl(unknown.nodes).attributes).toMatchObject({ "data-shortcode": "mystery" });
    expect(entriesOf(unknown.ctx, "block.shortcode")[0]!.data).not.toHaveProperty("label");
    const text = await page(`<!-- wp:shortcode -->just words<!-- /wp:shortcode -->`);
    expect(text.html).toBe("<p>just words</p>");
    expect(entriesOf(text.ctx, "block.shortcode")[0]!.message).toContain("holds no shortcode");
    const empty = await page(`<!-- wp:shortcode -->  <!-- /wp:shortcode -->`);
    expect(empty.nodes).toEqual([]);
  });

  test("an enclosing shortcode keeps what it encloses inside its placeholder; a doubled bracket is not a shortcode", async () => {
    const r = await page(
      `<!-- wp:shortcode -->[caption id="a"]inner [su_spacer][/caption][[escaped]]<!-- /wp:shortcode -->`,
    );
    expect(r.html).toContain(`<wp2jx-shortcode data-shortcode="caption" data-attributes="`);
    expect(r.html).toContain(`<wp2jx-shortcode data-shortcode="su_spacer"`);
    expect(r.html).toContain("[[escaped]]");
    expect(entriesOf(r.ctx, "block.shortcode")).toHaveLength(1);
  });

  test("a raw HTML block reports a known shortcode in it and leaves bracketed prose alone", async () => {
    const r = await page(
      `<!-- wp:html --><p>[fluentform id="6"] and [Jesus] said</p><!-- /wp:html -->`,
    );
    expect(r.html).toContain(`<wp2jx-shortcode data-shortcode="fluentform"`);
    expect(r.html).toContain("[Jesus]");
    expect(entriesOf(r.ctx, "block.shortcode")[0]!.data).toMatchObject({
      shortcode: "fluentform",
      label: "Fluent Forms form",
    });
  });

  test("classic content gets the paragraphs wpautop would make, and its shortcodes become placeholders", async () => {
    const r = await page(
      'Line one\n\nLine two<br>\nstill two\n\n[su_spacer size="30"]\n\n<h2>Head</h2>\n<p>Para</p>',
    );
    expect(r.html).toBe(
      `<p>Line one</p><p>Line two<br>still two</p><p><wp2jx-shortcode data-shortcode="su_spacer" data-attributes="{&quot;size&quot;:&quot;30&quot;}" data-source="[su_spacer size=&quot;30&quot;]"></wp2jx-shortcode></p><h2>Head</h2><p>Para</p>`,
    );
    expect(r.ctx.report.entries().map((e) => e.code)).toEqual(["block.shortcode"]);
  });

  test("real: classic content between blocks keeps its links, rewritten, and a bare run of text is a paragraph", async () => {
    const r = await real("ap", null, (b) => b.innerHTML.includes("Fundamentalism and Anabaptists"));
    // No page of the site answers /fundamentalism/ (the address is a Drupal-era one): it keeps its
    // own address and is reported instead of being turned into a link that leads nowhere.
    expect(r.html).toBe(
      `<p><a href="https://anabaptistperspectives.org/fundamentalism/">Fundamentalism and Anabaptists</a></p><p></p>`,
    );
    expect(entriesOf(r.ctx, "url.unresolved").map((e) => e.data?.url)).toContain(
      "https://anabaptistperspectives.org/fundamentalism/",
    );
    const bare = await real(
      "ap",
      null,
      (b) => b.innerHTML === "stories of radical faith and radical living",
    );
    expect(bare.html).toBe("<p>stories of radical faith and radical living</p>");
  });

  test("an empty classic block converts to nothing", () => {
    return makeCtx("fineline", FL_PAGE).then((ctx) => {
      const empty: WpBlock = {
        name: null,
        attrs: {},
        innerBlocks: [],
        innerHTML: " \n ",
        innerContent: [" \n "],
      };
      expect(convertCoreBlock(empty, ctx)).toEqual([]);
    });
  });

  test("more and nextpage are dropped, and the page says so", async () => {
    const r = await page(
      `${para("a")}<!-- wp:more --><!--more--><!-- /wp:more --><!-- wp:nextpage --><!--nextpage--><!-- /wp:nextpage -->${para("b")}`,
    );
    expect(r.html).toBe("<p>a</p><p>b</p>");
    expect(entriesOf(r.ctx, "block.more-dropped")).toHaveLength(1);
    expect(entriesOf(r.ctx, "block.nextpage-dropped")).toHaveLength(1);
    expect(entriesOf(r.ctx, "block.more-dropped")[0]).toMatchObject({
      severity: "info",
      where: "post:3483",
    });
  });
});

// ── Dynamic blocks ───────────────────────────────────────────────────────────────────────────────

const AP_ESSAY: Subject = { kind: "post", id: 8819 };

const TEMPLATE_MARKUP =
  `<!-- wp:post-title {"level":1,"isLink":true} /-->` +
  `<!-- wp:post-featured-image {"isLink":true} /-->` +
  `<!-- wp:post-date {"format":"F j, Y"} /-->` +
  `<!-- wp:post-excerpt {"moreText":"Read more"} /-->` +
  `<!-- wp:post-terms {"term":"post_tag","separator":", ","prefix":"Tags: "} /-->` +
  `<!-- wp:post-content /-->`;

describe("dynamic blocks: the current post, in a static page", () => {
  const run = (markup: string) =>
    convertMarkup(markup, "ap", AP_ESSAY, { target: "page" } as Partial<ConvertCtx>);

  test("post-title is the post's title in a heading of the block's level, linked when asked", async () => {
    const r = await run(
      `<!-- wp:post-title {"level":1,"isLink":true,"linkTarget":"_blank","textAlign":"center"} /-->`,
    );
    expect(r.html).toBe(
      `<h1 class="wp-block-post-title has-text-align-center"><a href="/essays/the-cultural-captivity-of-the-gospel/" target="_blank" rel="noopener">The Cultural Captivity of the Gospel</a></h1>`,
    );
    const plain = await run(`<!-- wp:post-title /-->`);
    expect(firstEl(plain.nodes).tagName).toBe("h2");
    expect((await run(`<!-- wp:post-title {"level":0} /-->`)).html).toMatch(/^<p /);
  });

  test("post-title keeps a literal dollar-brace as text", async () => {
    const r = await convertMarkup(
      `<!-- wp:post-title /-->`,
      "fineline",
      { kind: "post", id: 3483 },
      {
        subject: {
          kind: "post",
          id: "3483",
          post: {
            ...(await makeCtx("fineline", FL_PAGE)).subject.post!,
            title: "Cost ${price} & more",
          },
        },
      },
    );
    expect(r.html).toContain("&#36;{price} &amp; more");
  });

  test("post-featured-image is the thumbnail the media plan ships, with its size, linked to the post", async () => {
    const r = await run(
      `<!-- wp:post-featured-image {"isLink":true,"aspectRatio":"16/9","width":"100px"} /-->`,
    );
    const figure = firstEl(r.nodes);
    expect(figure.tagName).toBe("figure");
    expect(classes(figure)).toEqual(["wp-block-post-featured-image"]);
    expect(r.html).toContain(`<a href="/essays/the-cultural-captivity-of-the-gospel/"><img`);
    // A linked image is described by the post's title, as WordPress does.
    expect(r.html).toContain(
      `width="1920" height="1080" src="/media/The-Cultural-Captivity-of-the-Gospel.jpg" alt="The Cultural Captivity of the Gospel"`,
    );
    // The aspect ratio needs the full width, a width alone needs `height: auto`, and `scale` defaults to cover.
    expect(r.html).toContain(
      `style="aspect-ratio: 16/9; width: 100px; height: auto; object-fit: cover"`,
    );
  });

  test("a post with no thumbnail prints no featured image", async () => {
    const r = await convertMarkup(`<!-- wp:post-featured-image /-->`, "fineline", FL_PAGE);
    expect(r.nodes).toEqual([]);
  });

  test("post-date is the date in the site's zone and the block's PHP format, as a time element", async () => {
    const r = await run(`<!-- wp:post-date {"format":"F j, Y","isLink":true} /-->`);
    expect(r.html).toBe(
      `<div class="wp-block-post-date"><a href="/essays/the-cultural-captivity-of-the-gospel/"><time datetime="2024-11-02T12:03:00-04:00">November 2, 2024</time></a></div>`,
    );
    const modified = await run(
      `<!-- wp:post-date {"displayType":"modified","format":"Y-m-d"} /-->`,
    );
    expect(modified.html).toMatch(/<time datetime="[^"]+">\d{4}-\d\d-\d\d<\/time>/);
  });

  test("post-excerpt is the post's own excerpt, and an excerpt it has not got is the first words of the content", async () => {
    const r = await run(`<!-- wp:post-excerpt {"moreText":"Read more","excerptLength":12} /-->`);
    // The more link is on a line of its own unless the block says it is not (showMoreOnNewLine defaults to true).
    expect(r.html).toContain(`<p class="wp-block-post-excerpt__excerpt">Frank Reed urges us`);
    expect(r.html).toContain(`<p class="wp-block-post-excerpt__more-text"><a class=`);
    expect(r.html).toContain(
      `<a class="wp-block-post-excerpt__more-link" href="/essays/the-cultural-captivity-of-the-gospel/">Read more</a>`,
    );
    const loaded = await loadSite("ap");
    const post = { ...loaded.model.posts.get(8819)!, excerpt: "" };
    const trimmed = await convertMarkup(
      `<!-- wp:post-excerpt {"excerptLength":5} /-->`,
      "ap",
      AP_ESSAY,
      {
        subject: { kind: "post", id: "8819", post },
        target: "page",
      } as Partial<ConvertCtx>,
    );
    expect(squash(textOfNodes(trimmed.nodes))).toBe("My father’s roots were in…");
  });

  test("post-terms are the post's terms of the taxonomy, linked, with the block's prefix and separator", async () => {
    const r = await run(
      `<!-- wp:post-terms {"term":"post_tag","separator":", ","prefix":"Tags: "} /-->`,
    );
    expect(classes(r.nodes[0])).toEqual(["taxonomy-post-tag", "wp-block-post-terms"]);
    expect(r.html).toContain(
      `<span class="wp-block-post-terms__prefix">Tags: </span><a href="/tag/church-community/" rel="tag">Church Community</a><span class="wp-block-post-terms__separator">, </span><a href="/tag/discipleship/" rel="tag">Discipleship</a>`,
    );
    expect(r.html).toContain(`<a href="/tag/kingdom-of-god/" rel="tag">Kingdom of God</a>`);
    const none = await run(`<!-- wp:post-terms {"term":"season"} /-->`);
    expect(none.nodes).toEqual([]);
  });

  test("post-content prints the post's own blocks where it stands, converted", async () => {
    const r = await run(`<!-- wp:post-content /-->`);
    const div = firstEl(r.nodes);
    expect(classes(div)).toEqual([
      "wp-block-post-content",
      "entry-content",
      "is-layout-flow",
      "wp-block-post-content-is-layout-flow",
    ]);
    expect((div.children as JxNode[]).length).toBeGreaterThan(80);
    expect(r.html).toContain("My father’s roots were in West Virginia.");
  });

  test("a post whose body holds post-content itself does not recurse forever", async () => {
    const loaded = await loadSite("ap");
    const post = {
      ...loaded.model.posts.get(8819)!,
      content: `<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph --><!-- wp:post-content /-->`,
    };
    const r = await convertMarkup(`<!-- wp:post-content /-->`, "ap", AP_ESSAY, {
      subject: { kind: "post", id: "8819", post },
    });
    expect(r.html).toBe(
      `<div class="wp-block-post-content entry-content is-layout-flow wp-block-post-content-is-layout-flow"><p>x</p></div>`,
    );
  });

  test("a template (no post to read) keeps a placeholder, and the page layout's slot stands for post-content", async () => {
    const ctx = await driven("ap", { kind: "template", slug: "single" });
    const nodes = ctx.convert(
      parseBlocks(
        `<!-- wp:post-title {"level":1,"textAlign":"left"} /--><!-- wp:post-terms {"term":"category"} /--><!-- wp:post-date /--><!-- wp:post-excerpt /--><!-- wp:post-featured-image /--><!-- wp:query-title {"type":"archive"} /--><!-- wp:post-content {"className":"hidden-by-default"} /-->`,
      ),
    );
    const tags = (nodes as JxElement[]).map((n) => n.tagName);
    expect(tags).toEqual([
      "wp2jx-post-title",
      "wp2jx-post-terms",
      "wp2jx-post-date",
      "wp2jx-post-excerpt",
      "wp2jx-post-featured-image",
      "wp2jx-query-title",
      "div",
    ]);
    const title = nodes[0] as JxElement;
    expect(title.className).toBe("wp-block-post-title has-text-align-left");
    expect(title.attributes).toEqual({
      "data-block": "core/post-title",
      "data-attrs": '{"level":1,"textAlign":"left"}',
    });
    const content = nodes[6] as JxElement;
    expect(content.className).toContain("hidden-by-default");
    expect(content.children).toEqual([{ tagName: "slot" }]);
    expect(ctx.report.entries().filter((e) => e.code === "block.dynamic-placeholder")).toHaveLength(
      6,
    );
    expect(ctx.report.entries()[0]).toMatchObject({
      severity: "info",
      where: "template:cwicly//single",
    });
  });

  test("the block supports become classes, an id and an inline style on the element WordPress builds", async () => {
    const r = await run(
      `<!-- wp:post-title {"level":2,"textColor":"primary","fontSize":"large","anchor":"t","className":"mine","style":{"spacing":{"margin":{"top":"var:preset|spacing|40"}},"typography":{"fontWeight":"700"}}} /-->`,
    );
    const h = firstEl(r.nodes);
    expect(h.id).toBe("t");
    expect(h.className).toBe(
      "wp-block-post-title has-primary-color has-text-color has-large-font-size mine",
    );
    expect(h.style).toEqual({ fontWeight: "700", marginTop: "var(--wp--preset--spacing--40)" });
  });
});

describe("dynamic blocks: an entry template binds to the entry", () => {
  const entry = (markup: string, subject: Subject = { kind: "template", slug: "single" }) =>
    convertMarkup(markup, "ap", subject, { mode: "entry", entryExpr: "state.entry" });

  test("each block reads the entry through ctx.entryExpr, by the entry data contract", async () => {
    const r = await entry(TEMPLATE_MARKUP);
    expect(r.html).toContain(
      `<h1 class="wp-block-post-title"><a href="\${state.entry.data.url ?? ''}">\${state.entry.data.title ?? ''}</a></h1>`,
    );
    expect(r.html).toContain(`src="\${state.entry.data.featuredImage?.src ?? ''}"`);
    expect(r.html).toContain(
      `<time datetime="\${state.entry.data.date ?? ''}">\${state.entry.data.date ? new Date(state.entry.data.date).toLocaleDateString('en-US'`,
    );
    expect(r.html).toContain(`\${state.entry.data.excerpt ?? ''}`);
    expect(r.html).toContain(`state.entry.data.terms?.["post_tag"]`);
    expect(JSON.stringify(r.nodes)).toContain(`"children":"\${state.entry.$children}"`);
  });

  test("a title and an excerpt are bindings, not text that happens to look like one", async () => {
    const r = await entry(`<!-- wp:post-title /--><!-- wp:post-excerpt /-->`);
    const [title, excerpt] = r.nodes as JxElement[];
    expect(title!.textContent).toBe("${state.entry.data.title ?? ''}");
    expect(JSON.stringify(excerpt)).toContain(`"textContent":"\${state.entry.data.excerpt ?? ''}"`);
    expect(JSON.stringify(r.nodes)).not.toContain("&#36;");
  });

  test("inside a query loop the entry is the loop's item", async () => {
    const r = await convertMarkup(
      `<!-- wp:post-title /-->`,
      "ap",
      { kind: "template", slug: "archive" },
      {
        mode: "entry",
        entryExpr: "$map.item",
      },
    );
    expect(r.html).toBe(`<h2 class="wp-block-post-title">\${$map.item.data.title ?? ''}</h2>`);
  });

  test("a date format with no Intl equivalent falls back to the ISO date, and says so", async () => {
    const r = await entry(`<!-- wp:post-date {"format":"l jS","displayType":"modified"} /-->`);
    expect(r.html).toContain("${String(state.entry.data.modified ?? '').slice(0, 10)}");
    expect(entriesOf(r.ctx, "block.date-format")[0]).toMatchObject({
      severity: "info",
      data: { format: "l jS" },
    });
  });

  test("the site's date format and time zone are the default", async () => {
    const r = await entry(`<!-- wp:post-date /-->`);
    expect(r.html).toContain(
      `toLocaleDateString('en-US', {"year":"numeric","month":"long","day":"numeric","timeZone":"America/New_York"})`,
    );
  });

  test("query-title in an archive template is the term's name", async () => {
    const ctx = await driven(
      "ap",
      { kind: "template", slug: "taxonomy" },
      { termExpr: "state.term" },
    );
    const nodes = ctx.convert(parseBlocks(`<!-- wp:query-title {"type":"archive","level":1} /-->`));
    expect(nodesToHtml(nodes)).toBe(`<h1 class="wp-block-query-title">\${state.term.name}</h1>`);
  });

  test("the featured image of an entry without one is hidden by CSS, not by a client-side binding", async () => {
    const r = await entry(`<!-- wp:post-featured-image /-->`);
    const figure = firstEl(r.nodes);
    expect(figure.hidden).toBeUndefined();
    expect(figure.style).toEqual({ ':has(img[src=""])': { display: "none" } });
    expect(classes(figure)[0]).toMatch(/^jx-/);
  });

  test("built through Jx with a real entry, every binding shows the entry's own value", async () => {
    const r = await entry(TEMPLATE_MARKUP);
    const md = [
      "---",
      `title: "A & B <i>"`,
      "slug: entry",
      `date: "2024-11-02T12:03:00-04:00"`,
      `excerpt: "Short & sweet"`,
      "url: /posts/entry/",
      `featuredImage: { src: /media/a.jpg, width: 10, height: 20, alt: "An alt" }`,
      `terms: { post_tag: [ { slug: x, name: "X & Y", url: /post_tag/x/ }, { slug: z, name: "Z", url: /post_tag/z/ } ] }`,
      "---",
      "",
      "Hello *world* body.",
      "",
    ].join("\n");
    const site = await buildJxProject(
      {
        "project.json": {
          name: "e",
          url: "https://example.com",
          extensions: ["@jxsuite/parser"],
          images: { optimize: false, lazyLoad: false },
          content: {
            posts: {
              source: "content/posts",
              format: "Markdown",
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  slug: { type: "string" },
                  date: { type: "string" },
                  excerpt: { type: "string" },
                  url: { type: "string" },
                  featuredImage: { type: "object" },
                  terms: { type: "object" },
                },
              },
            },
          },
        },
        "content/posts/entry.md": md,
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
          children: r.nodes,
        },
        "pages/index.json": { children: [{ tagName: "p", textContent: "home" }] },
      },
      { name: "entry", timeoutMs: 110_000 },
    );
    const html = site.html("/posts/entry/");
    const body = html.slice(html.indexOf("<body"));
    expect(body).toContain(
      `<h1 class="wp-block-post-title"><a href="/posts/entry/">A &amp; B &lt;i&gt;</a></h1>`,
    );
    // The image is linked, so it is described by the post's title (WordPress's own rule), and its
    // object-fit is the block's `scale` default.
    expect(body).toMatch(
      /<img class="jx-[0-9a-f]+ attachment-post-thumbnail size-post-thumbnail wp-post-image" src="\/media\/a\.jpg" width="10" height="20" alt="A &amp; B &lt;i&gt;">/,
    );
    expect(body).toContain(`<time datetime="2024-11-02T12:03:00-04:00">November 2, 2024</time>`);
    expect(body).toContain(`Short &amp; sweet`);
    expect(body).toContain(
      `<a href="/post_tag/x/" rel="tag">X &amp; Y</a><span class="wp-block-post-terms__separator">, </span><a href="/post_tag/z/" rel="tag">Z</a>`,
    );
    expect(body).toMatch(
      /<div class="wp-block-post-content[^>]*><p>Hello\s+<em>world<\/em>\s+body\.<\/p><\/div>/,
    );
    expect(html).toContain(`:has(img[src=""]) { display: none }`);
  });
});

describe("footnotes", () => {
  const FOOTNOTE_POST: Subject = { kind: "post", id: 12549 };

  test("real: the list WordPress builds from the post's meta, with the note's own markup and a link back to the marker", async () => {
    const r = await real("ap", "core/footnotes", () => true, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    expect(r.html).toBe(
      `<ol class="wp-block-footnotes"><li id="66000d24-2ff7-4c5e-85f6-567740d5c18f">This phrase is taken from <em>The Divine Conspiracy </em>by Dallas Willard<em>.</em> <a href="#66000d24-2ff7-4c5e-85f6-567740d5c18f-link" aria-label="Jump to footnote reference 1">↩︎</a></li></ol>`,
    );
    expect(r.ctx.report.entries()).toEqual([]);
  });

  test("real: every marker in the text, the list item it points at and the back link survive the Markdown entry round trip", async () => {
    const loaded = await loadSite("ap");
    const ctx = await driven("ap", FOOTNOTE_POST);
    const nodes = ctx.convert(subjectBlocks(loaded, FOOTNOTE_POST));
    const md = serializeJxMarkdown({ title: "t", slug: "s", children: nodes } as never, {
      mode: "roundtrip",
    });
    const back = nodesToHtml((transpileJxMarkdown(md).children ?? []) as JxNode[]);
    const id = "66000d24-2ff7-4c5e-85f6-567740d5c18f";
    expect(back).toContain(
      `<sup class="fn" data-fn="${id}"><a id="${id}-link" href="#${id}">1</a></sup>`,
    );
    expect(back).toContain(`<ol class="wp-block-footnotes"><li id="${id}">`);
    expect(back).toContain(`<a href="#${id}-link">↩︎</a>`);
    expect(squash(back.replace(/<[^>]+>/g, ""))).toContain(
      "This phrase is taken from The Divine Conspiracy by Dallas Willard.",
    );
  });

  test("real: no other post of either site has footnote markers, and no other has a non-empty footnotes meta", async () => {
    for (const siteName of ["fineline", "ap"] as const) {
      const loaded = await loadSite(siteName);
      const withNotes: number[] = [];
      for (const [id, meta] of loaded.model.postMeta) {
        const raw = meta.footnotes?.[0];
        if (typeof raw === "string" && raw.trim() !== "" && raw !== "[]") withNotes.push(id);
        const post = loaded.model.posts.get(id);
        if (post?.content.includes("data-fn=")) expect(withNotes).toContain(id);
      }
      expect(withNotes).toEqual(siteName === "ap" ? [12549] : []);
    }
  });

  test("a footnotes block with no notes to list is reported and prints nothing", async () => {
    const r = await convertMarkup(`<!-- wp:footnotes /-->`, "fineline", FL_PAGE);
    expect(r.nodes).toEqual([]);
    expect(entriesOf(r.ctx, "block.footnotes-missing")[0]).toMatchObject({
      severity: "warn",
      where: "post:3483",
    });
    // A `footnotes` meta that is not JSON is the same finding.
    const loaded = await loadSite("fineline");
    const meta = new Map(loaded.model.postMeta);
    meta.set(3483, { footnotes: ["not json"] });
    const bad = await convertMarkup(`<!-- wp:footnotes /-->`, "fineline", FL_PAGE, {
      model: { ...loaded.model, postMeta: meta },
    });
    expect(bad.codes).toEqual(["block.footnotes-missing"]);
  });
});

describe("reusable blocks, template parts, menus, search", () => {
  test("real: a reusable block is converted in place, where it is used", async () => {
    const r = await convertMarkup(`<!-- wp:block {"ref":63} /-->`, "fineline", FL_PAGE, {
      target: "page",
    } as Partial<ConvertCtx>);
    expect(r.html.startsWith("<p>")).toBe(true);
    expect(squash(textOfNodes(r.nodes))).toBe(
      "© 2026 finelinepainting.pro | Website by Manheim Marketing",
    );
  });

  test("real: a reference to a reusable block the export does not hold is reported and prints nothing", async () => {
    const r = await real("ap", "core/block", (b) => b.attrs.ref === 1459);
    expect(r.nodes).toEqual([]);
    expect(entriesOf(r.ctx, "block.reusable-missing")[0]).toMatchObject({
      severity: "warn",
      where: "post:1081",
      data: { block: "core/block", ref: 1459 },
    });
  });

  test("a reusable block that contains itself is expanded once and then reported", async () => {
    const loaded = await loadSite("fineline");
    const post = loaded.model.posts.get(63)!;
    const looping = {
      ...post,
      content: `<!-- wp:paragraph --><p>again</p><!-- /wp:paragraph --><!-- wp:block {"ref":63} /-->`,
    };
    const posts = new Map(loaded.model.posts);
    posts.set(63, looping);
    const r = await convertMarkup(`<!-- wp:block {"ref":63} /-->`, "fineline", FL_PAGE, {
      model: { ...loaded.model, posts },
    });
    expect(r.html).toBe("<p>again</p>");
    expect(entriesOf(r.ctx, "block.reusable-missing")[0]).toMatchObject({
      severity: "error",
      data: { ref: 63 },
    });
    // And the guard is released: the same block converts again.
    expect(
      (
        await convertMarkup(`<!-- wp:block {"ref":63} /-->`, "fineline", FL_PAGE, {
          model: { ...loaded.model, posts },
        })
      ).html,
    ).toBe("<p>again</p>");
  });

  test("real: a template part is a placeholder the template emitter replaces, with its slug and theme", async () => {
    const r = await real("fineline", "core/template-part", (b) => b.attrs.slug === "header");
    expect(r.nodes).toEqual([
      {
        tagName: "wp2jx-template-part",
        className: "wp-block-template-part",
        attributes: {
          "data-block": "core/template-part",
          "data-attrs": '{"slug":"header","theme":"cwicly"}',
          slug: "header",
          theme: "cwicly",
        },
      },
    ]);
  });

  test("a template part with an area and a tag name carries them, and the theme defaults to the site's", async () => {
    const r = await page(
      `<!-- wp:template-part {"slug":"footer","area":"footer","tagName":"footer","className":"x"} /-->`,
    );
    expect(r.nodes).toEqual([
      {
        tagName: "wp2jx-template-part",
        className: "wp-block-template-part x",
        attributes: {
          "data-block": "core/template-part",
          "data-attrs": '{"slug":"footer","area":"footer","tagName":"footer","className":"x"}',
          slug: "footer",
          theme: "cwicly",
          area: "footer",
          tag: "footer",
        },
      },
    ]);
  });

  test("navigation is a placeholder for the menu converter with the block's own links inside, and is reported", async () => {
    const r = await page(
      `<!-- wp:navigation {"ref":55} --><!-- wp:navigation-link {"label":"About","type":"page","id":1716,"url":"https://finelinepainting.pro/about-us/","kind":"post-type"} /--><!-- wp:navigation-submenu {"label":"Services","kind":"custom","url":"#"} --><!-- wp:navigation-link {"label":"Out","url":"https://example.com/","opensInNewTab":true,"kind":"custom"} /--><!-- /wp:navigation-submenu --><!-- /wp:navigation -->`,
    );
    const nav = firstEl(r.nodes);
    expect(nav.tagName).toBe("wp2jx-navigation");
    expect(nav.attributes).toMatchObject({ "data-block": "core/navigation", "data-ref": "55" });
    expect(r.html).toContain(
      `<li class="wp-block-navigation-item wp-block-navigation-link"><a class="wp-block-navigation-item__content" href="/about-us/"><span class="wp-block-navigation-item__label">About</span></a></li>`,
    );
    expect(r.html).toContain(
      `<li class="wp-block-navigation-item has-child wp-block-navigation-submenu">`,
    );
    expect(r.html).toContain(
      `<ul class="wp-block-navigation__submenu-container"><li class="wp-block-navigation-item wp-block-navigation-link"><a class="wp-block-navigation-item__content" href="https://example.com/" target="_blank" rel="noopener">`,
    );
    expect(entriesOf(r.ctx, "block.navigation")[0]).toMatchObject({
      severity: "info",
      data: { ref: 55 },
    });
  });

  test("a navigation link with an object id and no address is resolved through urlFor, and a term link through the term's route", async () => {
    const loaded = await loadSite("fineline");
    const term = [...loaded.model.terms.values()][0]!;
    const r = await page(
      `<!-- wp:navigation-link {"label":"Page","id":1716,"kind":"post-type"} /--><!-- wp:navigation-link {"label":"Term","id":${term.termId},"kind":"taxonomy"} /--><!-- wp:navigation-link {"label":"None"} /-->`,
    );
    expect(r.html).toContain(`href="/about-us/"`); // pages live at /<slug>/
    expect(r.html).toContain(`href="/${term.taxonomy}/${term.slug}/"`);
    expect(r.html).toContain(`<a class="wp-block-navigation-item__content"><span`);
  });

  test("the search form is the markup WordPress prints, pointed at a page of Jx's search, and reported", async () => {
    const r = await real("ap", "core/search", (b) => b.attrs.buttonUseIcon === true, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    const form = firstEl(r.nodes);
    expect(form.tagName).toBe("form");
    expect(classes(form)).toEqual([
      "wp-block-search__button-inside",
      "wp-block-search__icon-button",
      "wp-block-search",
      "wp-block-search-light",
    ]);
    expect(form.attributes).toMatchObject({
      role: "search",
      method: "get",
      action: "/search/",
      "data-wp2jx": "search",
    });
    expect(r.html).toContain(
      `<label class="wp-block-search__label screen-reader-text" for="wp-block-search__input-1">Search</label>`,
    );
    expect(r.html).toContain(
      `<input class="wp-block-search__input" id="wp-block-search__input-1" placeholder="" value="" type="search" name="s"`,
    );
    expect(r.html).toContain(
      `<button aria-label="Search" class="wp-block-search__button has-icon wp-element-button" type="submit"><svg`,
    );
    expect(entriesOf(r.ctx, "block.search")[0]).toMatchObject({
      severity: "warn",
      where: expect.stringMatching(/^template:/),
    });
  });

  test("the search form's button and label follow the block's attributes", async () => {
    const outside = await page(
      `<!-- wp:search {"label":"Find","buttonText":"Go","placeholder":"Type","showLabel":true,"className":"c"} /-->`,
    );
    expect(outside.html).toContain(`wp-block-search__button-outside wp-block-search c`);
    expect(outside.html).toContain(
      `<label class="wp-block-search__label" for="wp-block-search__input-1">Find</label>`,
    );
    expect(outside.html).toContain(`placeholder="Type"`);
    expect(outside.html).toContain(`type="submit">Go</button>`);
    const none = await page(`<!-- wp:search {"buttonPosition":"no-button"} /-->`);
    expect(none.html).toContain("wp-block-search__no-button");
    expect(none.html).not.toContain("<button");
  });

  test("a login link has no static form: dropped, and reported", async () => {
    const r = await page(`<!-- wp:loginout /-->`);
    expect(r.nodes).toEqual([]);
    expect(entriesOf(r.ctx, "block.dynamic-dropped")[0]).toMatchObject({
      severity: "warn",
      where: "post:3483",
    });
  });
});

describe("convertCoreBlock: names it does not know", () => {
  test("a block no converter claims is reported with its name and location, and its saved markup is kept", async () => {
    const r = await convertMarkup(
      `<!-- wp:ideabox/counter {"title":"T"} --><div class="wp-block-ideabox-counter"><span class="n">27773</span></div><!-- /wp:ideabox/counter -->`,
    );
    expect(r.html).toBe(`<div class="wp-block-ideabox-counter"><span class="n">27773</span></div>`);
    expect(entriesOf(r.ctx, "block.unsupported")[0]).toMatchObject({
      severity: "warn",
      where: "post:3483",
      data: { block: "ideabox/counter", kept: true },
    });
  });

  test("one that saved nothing (WordPress builds it per request) is a placeholder carrying its attributes", async () => {
    const r = await convertMarkup(`<!-- wp:fluentfom/guten-block {"formId":"9"} /-->`);
    expect(r.nodes).toEqual([
      {
        tagName: "wp2jx-block",
        attributes: { "data-block": "fluentfom/guten-block", "data-attrs": '{"formId":"9"}' },
      },
    ]);
    expect(entriesOf(r.ctx, "block.unsupported")[0]).toMatchObject({ data: { kept: false } });
    expect(entriesOf(r.ctx, "block.unsupported")[0]!.message).toContain("placeholder");
  });

  test("an unknown block's inner blocks are converted and kept", async () => {
    const r = await convertMarkup(
      `<!-- wp:acme/box --><div class="box"><!-- wp:paragraph --><p>inside</p><!-- /wp:paragraph --></div><!-- /wp:acme/box -->`,
    );
    expect(r.html).toBe(`<div class="box"><p>inside</p></div>`);
  });

  test("a block whose name is an Object.prototype key is unknown, not a converter", async () => {
    const ctx = await driven("fineline", FL_PAGE);
    const block: WpBlock = {
      name: "constructor",
      attrs: {},
      innerBlocks: [],
      innerHTML: "<p>x</p>",
      innerContent: ["<p>x</p>"],
    };
    expect(nodesToHtml(convertCoreBlock(block, ctx))).toBe("<p>x</p>");
    expect(ctx.report.entries()[0]).toMatchObject({
      code: "block.unsupported",
      data: { block: "constructor" },
    });
  });

  test("a block of any name that is in the registry never reports unsupported", async () => {
    const r = await convertMarkup(
      para("a") + `<!-- wp:heading --><h2 class="wp-block-heading">b</h2><!-- /wp:heading -->`,
    );
    expect(r.codes).toEqual([]);
  });
});

describe("what a Markdown entry cannot hold, put right before the serializer sees it", () => {
  const entry = (markup: string) => page(markup, "markdown");
  const roundTrip = (nodes: JxNode[]): JxNode[] =>
    transpileJxMarkdown(serializeJxMarkdown({ children: nodes } as never, { mode: "roundtrip" }))
      .children as JxNode[];

  test("text next to an inline element in a list item is wrapped in the paragraph the serializer reads it back as", async () => {
    const r = await entry(
      `<!-- wp:list --><ul><!-- wp:list-item --><li>forget the 20<sup>th</sup> century</li><!-- /wp:list-item --></ul><!-- /wp:list -->`,
    );
    const li = (firstEl(r.nodes).children as JxElement[])[0]!;
    expect(li.tagName).toBe("li");
    expect(li.children).toEqual([
      {
        tagName: "p",
        children: ["forget the 20", { tagName: "sup", textContent: "th" }, " century"],
      },
    ]);
    expect(nodesToHtml(roundTrip(r.nodes))).toBe(
      `<ul><li><p>forget the 20<sup>th</sup> century</p></li></ul>`,
    );
  });

  test("the same holds for a caption, a definition and a quote", async () => {
    const r = await entry(
      `<!-- wp:html --><figure><img src="/a.jpg" alt="a"><figcaption>Cap <b>x</b>y</figcaption></figure><dl><dt>a</dt><dd>b <i>c</i>d</dd></dl><blockquote>q <em>e</em> r</blockquote><!-- /wp:html -->`,
    );
    const html = nodesToHtml(r.nodes);
    expect(html).toContain(`<figcaption><p>Cap <b>x</b>y</p></figcaption>`);
    expect(html).toContain(`<dd><p>b <i>c</i>d</p></dd>`);
    expect(html).toContain(`<blockquote><p>q <em>e</em> r</p></blockquote>`);
  });

  test("an inline element on its own (a link that is the whole item, a quote's cite) is left alone", async () => {
    const r = await entry(
      `<!-- wp:html --><ul><li><a href="/x">only link</a></li></ul><blockquote><p>Words</p><cite>Someone</cite></blockquote><!-- /wp:html -->`,
    );
    expect(nodesToHtml(r.nodes)).toBe(
      `<ul><li><a href="/x">only link</a></li></ul><blockquote><p>Words</p><cite>Someone</cite></blockquote>`,
    );
    expect(nodesToHtml(roundTrip(r.nodes))).toContain(
      `<blockquote><p>Words</p><cite>Someone</cite></blockquote>`,
    );
  });

  test("a plain list item (text only) and an item that holds blocks are left as they are", async () => {
    const r = await entry(
      `<!-- wp:html --><ul><li>plain</li><li><p>para</p><ul><li>inner</li></ul></li></ul><!-- /wp:html -->`,
    );
    expect(nodesToHtml(r.nodes)).toBe(
      `<ul><li>plain</li><li><p>para</p><ul><li>inner</li></ul></li></ul>`,
    );
  });

  test("a list or table that carries a class, id or style would be written inside a second one: the attributes go, and the report says which", async () => {
    const r = await entry(
      `<!-- wp:html --><ul class="a b" id="u" style="color:red"><li>x</li></ul><ol class="wp-block-list"><li>y</li></ol><!-- /wp:html -->`,
    );
    const [ul, ol] = r.nodes as JxElement[];
    expect(ul).toMatchObject({ tagName: "ul" });
    expect(ul!.className ?? ul!.id ?? ul!.style).toBeUndefined();
    expect(ol!.className).toBeUndefined();
    const entries = entriesOf(r.ctx, "block.markdown-attributes-dropped");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data).toEqual({
      element: "list",
      classes: ["a", "b"],
      id: true,
      style: true,
      count: 1,
    });
    expect(nodesToHtml(roundTrip(r.nodes))).not.toContain("<ul><ul>");
  });

  test("a list with an item that has a class keeps its own: every item is then a directive, which carries them", async () => {
    const r = await entry(
      `<!-- wp:html --><ul class="grid"><li class="item">x</li><li class="item">y</li></ul><!-- /wp:html -->`,
    );
    expect(firstEl(r.nodes).className).toBe("grid");
    expect(nodesToHtml(roundTrip(r.nodes))).toContain(`<ul class="grid"><li class="item">`);
    expect(r.codes).not.toContain("block.markdown-attributes-dropped");
  });

  test("emphasis around line breaks is split at them: `<strong><br></strong>` printed `&#xA;`", async () => {
    const r = await entry(
      `${para(`<strong>Step 1</strong><strong><br></strong>Text <strong>a<br>b</strong>`)}`,
    );
    expect(nodesToHtml(r.nodes)).toBe(
      `<p><strong>Step 1</strong><br>Text <strong>a</strong><br><strong>b</strong></p>`,
    );
    const back = nodesToHtml(roundTrip(r.nodes));
    expect(back).not.toContain("&#xA;");
    expect(back).not.toContain("&amp;#");
  });

  test("an empty emphasis element, which the serializer writes as four asterisks, is dropped", async () => {
    const r = await entry(
      `<!-- wp:heading --><h2 class="wp-block-heading">Title<strong></strong></h2><!-- /wp:heading -->`,
    );
    expect(nodesToHtml(r.nodes)).toBe(`<h2 class="wp-block-heading">Title</h2>`);
    expect(nodesToHtml(roundTrip(r.nodes))).not.toContain("****");
  });

  test("the old Drupal site's external-link icon is dropped from an entry, and from nothing else", async () => {
    const svg = `<svg class="ext" xmlns=" http://www.w3.org/2000/svg " viewBox="0 0 80 40" role="img" aria-label="(link is external)"><title>(link is external)</title><path d="M0 0"/></svg>`;
    const markup = para(`See https://example.org/x${svg} and <a href="/y">y</a>`);
    const asEntry = await entry(markup);
    expect(asEntry.html).not.toContain("<svg");
    expect(entriesOf(asEntry.ctx, "block.icon-dropped")[0]).toMatchObject({
      severity: "info",
      data: { icons: 1 },
    });
    const asPage = await page(markup, "page");
    expect(asPage.html).toContain("<svg");
    expect(asPage.codes).not.toContain("block.icon-dropped");
    // A different icon is kept.
    const other = await entry(para(`x <svg class="icon" viewBox="0 0 1 1"><path d="M0 0"/></svg>`));
    expect(other.html).toContain("<svg");
  });

  test("inline markup flush against text is reported once per entry, however many blocks hold it", async () => {
    const r = await entry(
      para(`20<sup>th</sup> a`) + para(`<b>x</b>.`) + para(`plain, with <b>space</b> around`),
    );
    const gaps = entriesOf(r.ctx, "block.inline-gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ severity: "warn", where: "post:3483", data: { blocks: 2 } });
    // A JSON page keeps the text exact, so there is nothing to report.
    expect((await page(para(`20<sup>th</sup> a`), "page")).codes).toEqual([]);
  });

  test("a colon before a digit is a span of its own, and the entry says so; one before a letter is left to the serializer, which escapes it", async () => {
    const r = await entry(para(`John 3:16 and a:b`));
    expect(textOfNodes(r.nodes)).toBe("John 3:16 and a:b");
    expect(firstEl(r.nodes).children).toEqual([
      "John 3",
      { tagName: "span", textContent: ":" },
      "16 and a:b",
    ]);
    expect(entriesOf(r.ctx, "block.text-directive")).toEqual([
      expect.objectContaining({ severity: "warn", data: { colons: 1 } }),
    ]);
    // The space the build writes around the span is the inline gap, which is reported for the entry.
    expect(entriesOf(r.ctx, "block.inline-gap")).toHaveLength(1);
  });
});

describe("block supports and shortcode parsing", () => {
  const block = (attrs: Record<string, unknown>, name = "core/paragraph"): WpBlock => ({
    name,
    attrs,
    innerBlocks: [],
    innerHTML: "",
    innerContent: [],
  });

  test("supportsOf: the classes, id and inline declarations WordPress derives from a block's attributes", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    const s = supportsOf(
      block({
        align: "wide",
        textAlign: "center",
        textColor: "primary",
        backgroundColor: "base",
        gradient: "vivid",
        fontSize: "large",
        fontFamily: "serif",
        className: "mine",
        anchor: "top",
        style: {
          color: {
            text: "#111",
            background: "var:preset|color|accent",
            gradient: "linear-gradient(red, blue)",
          },
          typography: {
            fontSize: "2rem",
            lineHeight: "1.5",
            fontWeight: "700",
            textTransform: "uppercase",
          },
          spacing: { padding: { top: "1rem", left: "var:preset|spacing|40" }, margin: "0" },
          border: {
            radius: { topLeft: "4px", bottomRight: "8px" },
            width: "2px",
            color: "#000",
            style: "solid",
          },
          dimensions: { minHeight: "50vh", aspectRatio: "16/9" },
        },
      }),
      ctx,
    );
    expect(s.id).toBe("top");
    expect(s.classes).toEqual([
      "alignwide",
      "has-text-align-center",
      "has-primary-color",
      "has-text-color",
      "has-base-background-color",
      "has-background",
      "has-vivid-gradient-background",
      "has-background",
      "has-large-font-size",
      "has-serif-font-family",
      "has-text-color",
      "has-background",
      "has-background",
      "has-border-color",
      "mine",
    ]);
    expect(Object.fromEntries(s.style)).toEqual({
      color: "#111",
      "background-color": "var(--wp--preset--color--accent)",
      background: "linear-gradient(red, blue)",
      "font-size": "2rem",
      "line-height": "1.5",
      "font-weight": "700",
      "text-transform": "uppercase",
      "padding-top": "1rem",
      "padding-left": "var(--wp--preset--spacing--40)",
      margin: "0",
      "border-top-left-radius": "4px",
      "border-bottom-right-radius": "8px",
      "border-width": "2px",
      "border-color": "#000",
      "border-style": "solid",
      "min-height": "50vh",
      "aspect-ratio": "16/9",
    });
    expect(ctx.report.entries()).toEqual([]);
  });

  test("supportsOf: a style setting that WordPress writes into a generated stylesheet is reported, not guessed", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    supportsOf(
      block({
        style: {
          elements: { link: { color: { text: "red" } } },
          shadow: "x",
          color: { duotone: "y" },
          spacing: { blockGap: "1rem" },
        },
      }),
      ctx,
    );
    expect(ctx.report.entries()).toHaveLength(1);
    expect(ctx.report.entries()[0]).toMatchObject({
      severity: "warn",
      code: "block.style-dropped",
      where: "post:3483",
      data: {
        block: "core/paragraph",
        keys: ["elements", "shadow", "color.duotone", "spacing.blockGap"],
      },
    });
  });

  test("supportsOf: an empty or malformed attribute set is no classes and no style", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    expect(supportsOf(block({}), ctx)).toEqual({ classes: [], style: [] });
    expect(supportsOf(block({ style: "x", align: "", textColor: 3, anchor: "" }), ctx)).toEqual({
      classes: [],
      style: [],
    });
  });

  test("findShortcodes: outermost first, enclosing and self-closing forms, escaped brackets, an accept filter", () => {
    const text = `a [one x=1] b [two]inner [three][/two] c [[esc]] d [four/] e [Jesus] [five][/five]`;
    const found = findShortcodes(text);
    expect(found.map((f) => [f.name, f.attributes, f.content, f.raw])).toEqual([
      ["one", "x=1", undefined, "[one x=1]"],
      ["two", "", "inner [three]", "[two]inner [three][/two]"],
      ["four", "", undefined, "[four/]"],
      ["Jesus", "", undefined, "[Jesus]"],
      ["five", "", "", "[five][/five]"],
    ]);
    for (const f of found) expect(text.slice(f.start, f.end)).toBe(f.raw);
    expect(findShortcodes(text, (name) => name === "four").map((f) => f.name)).toEqual(["four"]);
    expect(findShortcodes("no brackets here")).toEqual([]);
    expect(findShortcodes("[a-b_c]")[0]!.name).toBe("a-b_c");
  });

  test("shortcodeAttributes: quoted, single-quoted, bare and positional values", () => {
    expect(shortcodeAttributes(`id="3" name='x y' bare=word flag "pos one" tail`)).toEqual({
      id: "3",
      name: "x y",
      bare: "word",
      "0": "flag",
      "1": "pos one",
      "2": "tail",
    });
    expect(shortcodeAttributes("")).toEqual({});
    expect(shortcodeAttributes(`no-registration=google data-widget-id=cbb08`)).toEqual({
      "no-registration": "google",
      "data-widget-id": "cbb08",
    });
  });
});

describe("edges of the dynamic blocks", () => {
  const withOptions = async (set: Record<string, string>): Promise<Partial<ConvertCtx>> => {
    const loaded = await loadSite("ap");
    const options = new Map(loaded.model.options);
    for (const [k, v] of Object.entries(set)) options.set(k, v);
    return { model: { ...loaded.model, options }, target: "page" } as Partial<ConvertCtx>;
  };

  test("a time zone the runtime does not know falls back to the site's UTC offset, and no offset is UTC", async () => {
    const date = `<!-- wp:post-date {"format":"Y-m-d H:i"} /-->`;
    const offset = await convertMarkup(
      date,
      "ap",
      AP_ESSAY,
      await withOptions({ timezone_string: "Nowhere/Land", gmt_offset: "-3.5" }),
    );
    expect(offset.html).toContain(`datetime="2024-11-02T12:33:00-03:30">2024-11-02 12:33<`);
    const none = await convertMarkup(
      date,
      "ap",
      AP_ESSAY,
      await withOptions({ timezone_string: "", gmt_offset: "0" }),
    );
    expect(none.html).toContain(`datetime="2024-11-02T16:03:00+00:00"`);
    const east = await convertMarkup(
      date,
      "ap",
      AP_ESSAY,
      await withOptions({ timezone_string: "", gmt_offset: "5.75" }),
    );
    expect(east.html).toContain(`datetime="2024-11-02T21:48:00+05:45"`);
  });

  test("a more link on its own line follows the excerpt as a second paragraph", async () => {
    const r = await convertMarkup(
      `<!-- wp:post-excerpt {"moreText":"Continue","showMoreOnNewLine":true} /-->`,
      "ap",
      AP_ESSAY,
      {
        target: "page",
      } as Partial<ConvertCtx>,
    );
    expect(r.html).toContain(
      `</p><p class="wp-block-post-excerpt__more-text"><a class="wp-block-post-excerpt__more-link" href="/essays/the-cultural-captivity-of-the-gospel/">Continue</a></p>`,
    );
    const entry = await convertMarkup(
      `<!-- wp:post-excerpt {"moreText":"Continue","showMoreOnNewLine":true} /-->`,
      "ap",
      { kind: "template", slug: "single" },
      {
        mode: "entry",
      },
    );
    expect(entry.html).toContain(
      `<a class="wp-block-post-excerpt__more-link" href="\${state.entry.data.url ?? ''}">Continue</a>`,
    );
  });

  test("an embed address that is not a URL at all stays a link, reported unresolved", async () => {
    const r = await page(
      `<!-- wp:embed {"url":"not a url"} --><figure class="wp-block-embed"><div class="wp-block-embed__wrapper">\nnot a url\n</div></figure><!-- /wp:embed -->`,
    );
    expect(r.codes).toEqual(["block.embed-unresolved"]);
  });

  test("blocks that need a loop or an author have no converter: reported unsupported, with nothing lost", async () => {
    const r = await page(
      `<!-- wp:query {"queryId":1} --><div class="wp-block-query"><!-- wp:post-template --><!-- wp:post-title /--><!-- /wp:post-template --></div><!-- /wp:query -->`,
    );
    // The inner blocks are converted first, so the loop's own block is reported after them.
    expect(entriesOf(r.ctx, "block.unsupported").map((e) => e.data?.block)).toEqual([
      "core/post-template",
      "core/query",
    ]);
    expect(r.html).toContain(`<div class="wp-block-query">`);
  });
});

describe("Markdown entries keep their text through the serializer", () => {
  /** Text with a mark after every node, so a colon run (`:30`) ends where its element does. */
  const marked = (nodes: readonly JxNode[]): string => {
    let out = "";
    for (const node of nodes) {
      if (typeof node === "string") {
        out += `${node}\uE000`;
        continue;
      }
      if (typeof node.textContent === "string") out += node.textContent;
      else if (typeof node.innerHTML === "string") out += textOfHtml(node.innerHTML);
      else if (Array.isArray(node.children)) out += marked(node.children);
      out += "\uE000";
    }
    return out;
  };
  const bare = (text: string): string => decodeEntities(text).replace(/[\s ​\uE000]+/g, "");

  test("every post and custom post type of both sites reads back with the text it was written with", async () => {
    let entries = 0;
    const lost: string[] = [];
    for (const siteName of ["fineline", "ap"] as const) {
      const loaded = await loadSite(siteName);
      for (const subject of allSubjects(loaded)) {
        const post = subjectPost(loaded, subject);
        if (subject.kind !== "post" || !post || post.type === "page") continue;
        entries++;
        const ctx = await driven(siteName, subject);
        const nodes = ctx.convert(subjectBlocks(loaded, subject));
        const entry = serializeJxMarkdown({ title: "t", slug: "s", children: nodes } as never, {
          mode: "roundtrip",
        });
        const back = (transpileJxMarkdown(entry).children ?? []) as JxNode[];
        const written = marked(nodes);
        const read = marked(back);
        if (bare(written) === bare(read)) continue;
        lost.push(`${siteName} ${post.type}:${post.id}`);
      }
    }
    expect(entries).toBe(436);
    expect(lost).toEqual([]);
  }, 120_000);
});

describe("the converted nodes are valid Jx", () => {
  const PLACEHOLDERS =
    `<!-- wp:template-part {"slug":"header","theme":"cwicly","area":"header"} /-->` +
    `<!-- wp:navigation {"ref":55} --><!-- wp:navigation-link {"label":"About","url":"/about-us/"} /--><!-- /wp:navigation -->` +
    `<!-- wp:search {"buttonUseIcon":true,"buttonPosition":"button-inside"} /-->` +
    `<!-- wp:shortcode -->[trustindex no-registration=google]<!-- /wp:shortcode -->` +
    `<!-- wp:fluentfom/guten-block {"formId":"9"} /-->` +
    `<!-- wp:social-links --><ul class="wp-block-social-links"><!-- wp:social-link {"url":"https://facebook.com/fp","service":"facebook"} /--></ul><!-- /wp:social-links -->` +
    `<!-- wp:embed {"url":"https://youtu.be/abc123"} --><figure class="wp-block-embed"><div class="wp-block-embed__wrapper">\nhttps://youtu.be/abc123\n</div></figure><!-- /wp:embed -->` +
    `<!-- wp:post-title /--><!-- wp:post-content /-->`;

  test("the privacy policy and every kind of placeholder pass `jx validate` and build", async () => {
    const loaded = await loadSite("fineline");
    const ctx = await driven("fineline", FL_PAGE, { target: "page" } as Partial<ConvertCtx>);
    const nodes = [
      ...ctx.convert(subjectBlocks(loaded, FL_PAGE)),
      ...ctx.convert(parseBlocks(PLACEHOLDERS)),
    ];
    const site = await buildJxProject(
      { "pages/index.json": { children: nodes } },
      { name: "valid", timeoutMs: 110_000 },
    );
    const result = await validateJxProject(site.dir);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(site.html("/")).toContain("<wp2jx-template-part");
  }, 120_000);

  test("a Markdown entry of an ap essay validates as a collection entry and builds", async () => {
    const loaded = await loadSite("ap");
    const ctx = await driven("ap", AP_ESSAY);
    const nodes = ctx.convert(subjectBlocks(loaded, AP_ESSAY));
    const entry = serializeJxMarkdown({ title: "t", slug: "entry", children: nodes } as never, {
      mode: "roundtrip",
    });
    const site = await buildJxProject(
      {
        "project.json": {
          name: "e",
          url: "https://example.com",
          extensions: ["@jxsuite/parser"],
          images: { optimize: false, lazyLoad: false },
          content: {
            posts: {
              source: "content/posts",
              format: "Markdown",
              $elements: [...tagsOf(nodes), "a", "p"].filter((t) => /^[a-z][a-z0-9]*$/.test(t)),
              schema: {
                type: "object",
                properties: { title: { type: "string" }, slug: { type: "string" } },
              },
            },
          },
        },
        "content/posts/entry.md": entry,
        "pages/index.json": { children: [{ tagName: "p", textContent: "home" }] },
      },
      { name: "valid-entry", timeoutMs: 110_000 },
    );
    expect((await validateJxProject(site.dir)).ok).toBe(true);
    expect(site.exists("index.html")).toBe(true);
  }, 120_000);
});

// ── Review findings: what a Markdown entry loses ─────────────────────────────────────────────────

describe("Markdown entries: what the serializer cannot write is put right or reported", () => {
  const entry = (markup: string, site: SiteName = "fineline") => page(markup, "markdown", site);
  const roundTrip = (nodes: JxNode[]): JxNode[] =>
    transpileJxMarkdown(serializeJxMarkdown({ children: nodes } as never, { mode: "roundtrip" }))
      .children as JxNode[];

  /** A real post of a site, converted as the entry it is. */
  async function realEntry(siteName: SiteName, id: number) {
    const loaded = await loadSite(siteName);
    const ctx = await driven(siteName, { kind: "post", id });
    const nodes = ctx.convert(subjectBlocks(loaded, { kind: "post", id }));
    return { ctx, nodes, back: roundTrip(nodes) };
  }

  test("a line break at the end of a paragraph, heading or item is dropped, and does not read back as a backslash", async () => {
    const r = await entry(
      `${para("text<br>")}${para("<br>")}${para("text&nbsp;<br>")}${para("<strong>bold<br></strong>")}` +
        `<!-- wp:heading --><h2 class="wp-block-heading">Title<br></h2><!-- /wp:heading -->` +
        `<!-- wp:list --><ul class="wp-block-list"><!-- wp:list-item --><li>item<br></li><!-- /wp:list-item --></ul><!-- /wp:list -->`,
    );
    expect(r.html).toBe(
      `<p>text</p><p>text</p><p><strong>bold</strong></p><h2 class="wp-block-heading">Title</h2><ul><li>item</li></ul>`,
    );
    expect(textOfNodes(roundTrip(r.nodes))).not.toContain("\\");
    const said = entriesOf(r.ctx, "block.line-break-dropped");
    expect(said.every((e) => e.severity === "info")).toBe(true);
    expect(said.reduce((n, e) => n + Number(e.data!.breaks), 0)).toBe(6);
  });

  test("a line break between two lines is a line break: it is the one the serializer writes", async () => {
    const r = await entry(para("a<br>b"));
    expect(r.html).toBe(`<p>a<br>b</p>`);
    expect(nodesToHtml(roundTrip(r.nodes))).toBe(`<p>a<br>b</p>`);
    expect(entriesOf(r.ctx, "block.line-break-dropped")).toEqual([]);
  });

  test("real: fineline post 3518 (a paragraph that is only a break) reads back with no backslash", async () => {
    const { ctx, back } = await realEntry("fineline", 3518);
    expect(textOfNodes(back)).not.toContain("\\");
    expect(entriesOf(ctx, "block.line-break-dropped").length).toBeGreaterThan(0);
  });

  test("real: a poem of one span per line (ap post 738) keeps its lines, and its note marker", async () => {
    const { ctx, back } = await realEntry("ap", 738);
    const findVerse = (list: readonly JxNode[]): JxElement | undefined => {
      for (const n of list) {
        if (typeof n === "string") continue;
        if (n.className === "wp-block-verse") return n;
        const inner = Array.isArray(n.children) ? findVerse(n.children) : undefined;
        if (inner) return inner;
      }
      return undefined;
    };
    const pre = findVerse(back)!;
    const text = textOfNodes([pre]);
    expect(text).toContain(
      "There is a solitude of space \nA solitude of sea \nA solitude of death",
    );
    expect(nodesToHtml([pre])).toContain(`<sup><a class="ek-link" href="#note7">7</a></sup>`);
    // The spans' own weight is the one thing given up, and the report says so.
    expect(entriesOf(ctx, "block.pre-flattened")[0]).toMatchObject({
      severity: "info",
      data: { styledSpans: expect.any(Number) },
    });
  });

  test("verse of plain lines and breaks is the text it is, newlines kept", async () => {
    const r = await entry(
      `<!-- wp:verse --><pre class="wp-block-verse"><span>one </span>\n<span>two</span><br>three</pre><!-- /wp:verse -->`,
    );
    expect(r.nodes).toEqual([
      { tagName: "pre", className: "wp-block-verse", textContent: "one \ntwo\nthree" },
    ]);
    expect(textOfNodes(roundTrip(r.nodes))).toBe("one \ntwo\nthree");
  });

  test("a link's target, rel and aria-label, which a Markdown link has no place for, are reported (ap post 775)", async () => {
    const { ctx } = await realEntry("ap", 775);
    const [entryFor] = entriesOf(ctx, "block.link-attributes-dropped");
    expect(entryFor).toMatchObject({ severity: "info" });
    expect(entryFor!.data!.attributes).toContain("aria-label");
    const r = await entry(
      `<!-- wp:html --><a href="https://x.org/" target="_blank">x</a><!-- /wp:html -->`,
    );
    expect(entriesOf(r.ctx, "block.link-attributes-dropped")[0]).toMatchObject({
      data: { links: 1, attributes: ["target", "rel"] },
    });
    // A link written as a directive keeps its attributes, so nothing is lost there.
    const kept = await entry(
      `<!-- wp:html --><a class="b" href="/x" target="_blank">x</a><!-- /wp:html -->`,
    );
    expect(entriesOf(kept.ctx, "block.link-attributes-dropped")).toEqual([]);
  });

  test("an ordered list's type is reported, because a Markdown list is numbered 1, 2, 3 (ap post 808)", async () => {
    const { ctx } = await realEntry("ap", 808);
    expect(entriesOf(ctx, "block.list-type-dropped")).toEqual([
      expect.objectContaining({ severity: "info", data: { lists: 1 } }),
    ]);
  });

  test("a table with fixed layout hands the class to its figure and is reported as a warning, not as info (fineline post 3518)", async () => {
    const r = await real("fineline", "core/table", (b) => /has-fixed-layout/.test(b.innerHTML), 0, {
      target: "markdown",
    } as Partial<ConvertCtx>);
    const figure = firstEl(r.nodes);
    expect(classes(figure)).toContain("has-fixed-layout");
    expect(entriesOf(r.ctx, "block.markdown-attributes-dropped")[0]).toMatchObject({
      severity: "warn",
      data: { element: "table", classes: expect.arrayContaining(["has-fixed-layout"]) },
    });
    // The table itself is written without it, as before.
    expect(JSON.stringify(figure.children)).not.toContain("has-fixed-layout");
  });

  test("a colon straight after emphasis (`*given*:For`), which the serializer does not escape, is a span too", async () => {
    const r = await entry(para(`<em>given</em>:For there`));
    expect(firstEl(r.nodes).children).toEqual([
      { tagName: "em", textContent: "given" },
      { tagName: "span", textContent: ":" },
      "For there",
    ]);
    expect(JSON.stringify(roundTrip(r.nodes))).not.toContain('"tagName":"For"');
  });

  test("real: every verse reference of ap post 753 reads back whole (`Luke 12:42`)", async () => {
    const { ctx, nodes, back } = await realEntry("ap", 753);
    const squashed = (n: JxNode[]) => textOfNodes(n).replace(/\s+/g, "");
    expect(squashed(back)).toBe(squashed(nodes));
    expect(squashed(back)).toContain("Luke12:42–46ESV");
    expect(entriesOf(ctx, "block.text-directive").length).toBeGreaterThan(0);
  });
});

// ── Review findings: the dynamic blocks and the markup built by hand ─────────────────────────────

/** Evaluate the one `${…}` template a binding is, against a state, as the Jx build does. */
function evalBinding(template: string, state: Record<string, unknown>): string {
  const m = /^\$\{([\s\S]*)\}$/.exec(template);
  if (!m) throw new Error(`not one template: ${template}`);
  return String(new Function("state", `return (${m[1]})`)(state));
}

/** An entry-mode context whose options say something else than the site's. */
const withOptions = async (
  options: Record<string, string>,
  site: SiteName = "ap",
): Promise<Partial<ConvertCtx>> => {
  const ctx = await makeCtx(site, { kind: "template", slug: "single" });
  return {
    mode: "entry",
    entryExpr: "state.entry",
    model: { ...ctx.model, options: new Map([...ctx.model.options, ...Object.entries(options)]) },
  };
};

describe("post-terms: WordPress's separator and order", () => {
  const AP_TAGS: Subject = { kind: "post", id: 750 };
  const run = (markup: string) =>
    convertMarkup(markup, "ap", AP_TAGS, { target: "page" } as Partial<ConvertCtx>);

  test("the separator is ', ' unless the block says another: the attribute's default is not saved in the comment", async () => {
    const live = readFileSync(
      join(FIXTURES, "ap/html/essays__the-essence-of-anabaptism-dean-taylor.html"),
      "utf8",
    );
    // The ground truth: a `{"term":"category"}` block on the live page.
    expect(live).toContain(`</a><span class="wp-block-post-terms__separator">, </span><a href=`);
    const r = await run(`<!-- wp:post-terms {"term":"post_tag"} /-->`);
    expect(r.html).toContain(`</a><span class="wp-block-post-terms__separator">, </span><a href=`);
    // An empty separator is `empty()` in PHP, which is a space; another one is kept as written.
    expect(
      (await run(`<!-- wp:post-terms {"term":"post_tag","separator":""} /-->`)).html,
    ).toContain(`__separator"> </span>`);
    expect(
      (await run(`<!-- wp:post-terms {"term":"post_tag","separator":" | "} /-->`)).html,
    ).toContain(`__separator"> | </span>`);
  });

  test("the terms are listed by name, as get_the_terms returns them, not in the order they were attached (ap post 750)", async () => {
    const r = await run(`<!-- wp:post-terms {"term":"post_tag"} /-->`);
    const names = [...r.html.matchAll(/rel="tag">([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual(["Abortion", "Adoption", "Ways to Serve"]);
  });

  test("a prefix and a suffix are printed as the markup they are", async () => {
    const r = await run(
      `<!-- wp:post-terms {"term":"post_tag","prefix":"<strong>Tags</strong>: ","suffix":" &amp; more"} /-->`,
    );
    expect(r.html).toContain(
      `<span class="wp-block-post-terms__prefix"><strong>Tags</strong>: </span>`,
    );
    expect(r.html).toContain(`<span class="wp-block-post-terms__suffix"> &amp; more</span>`);
  });

  describe("in an entry template", () => {
    const entry = (markup: string) =>
      convertMarkup(
        markup,
        "ap",
        { kind: "template", slug: "single" },
        {
          mode: "entry",
          entryExpr: "state.entry",
        },
      );
    const state = (terms: unknown) => ({ entry: { data: { terms } } });

    test("a taxonomy named like a number, a quote or a hyphen is a string key, and the binding is JavaScript", async () => {
      for (const taxonomy of ["3d_tag", "a'b", "a-b", `a"b`, "plain"]) {
        const r = await entry(`<!-- wp:post-terms ${JSON.stringify({ term: taxonomy })} /-->`);
        const inner = (firstEl(r.nodes).innerHTML as string) ?? "";
        const out = evalBinding(
          inner,
          state({
            [taxonomy]: [
              { name: "B", url: "/b/" },
              { name: "A <i>", url: "/a/" },
            ],
          }),
        );
        // By name, with the default separator, and the name escaped.
        expect(out).toBe(
          `<a href="/a/" rel="tag">A &lt;i></a><span class="wp-block-post-terms__separator">, </span><a href="/b/" rel="tag">B</a>`,
        );
        expect(evalBinding(inner, state({}))).toBe("");
      }
    });

    test("a separator with a newline, a prefix with a backslash and a suffix with a quote reach the page as written", async () => {
      const r = await entry(
        `<!-- wp:post-terms {"term":"category","separator":"\\n; ","prefix":"a\\\\b ","suffix":" it's"} /-->`,
      );
      const inner = firstEl(r.nodes).innerHTML as string;
      const out = evalBinding(
        inner,
        state({
          category: [
            { name: "x", url: "/x/" },
            { name: "y", url: "/y/" },
          ],
        }),
      );
      expect(out).toContain(`<span class="wp-block-post-terms__prefix">a\\b </span>`);
      expect(out).toContain(`<span class="wp-block-post-terms__separator">\n; </span>`);
      expect(out).toContain(`<span class="wp-block-post-terms__suffix"> it's</span>`);
    });
  });
});

describe("search: one input id per search", () => {
  test("two search blocks of a run do not share an id, and each label points at its own input", async () => {
    const r = await convertMarkup(
      `<!-- wp:search {"label":"Search"} /--><!-- wp:search {"label":"Find"} /-->`,
      "ap",
      { kind: "template", slug: "search" },
    );
    const ids = [...r.html.matchAll(/ id="(wp-block-search__input-\d+)"/g)].map((m) => m[1]);
    const fors = [...r.html.matchAll(/ for="(wp-block-search__input-\d+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["wp-block-search__input-1", "wp-block-search__input-2"]);
    expect(fors).toEqual(ids);
  });

  test("real: the search template and the mobile menu part it includes (both hold a search) share nothing", async () => {
    const template = await driven("ap", { kind: "template", slug: "search" });
    const part = await driven(
      "ap",
      { kind: "part", slug: "mobile-menu" },
      {
        report: template.report,
      },
    );
    const loaded = await loadSite("ap");
    const ids: string[] = [];
    for (const [ctx, subject] of [
      [template, { kind: "template", slug: "search" }],
      [part, { kind: "part", slug: "mobile-menu" }],
    ] as const) {
      const html = nodesToHtml(ctx.convert(subjectBlocks(loaded, subject)));
      ids.push(...[...html.matchAll(/ id="(wp-block-search__input-\d+)"/g)].map((m) => m[1]!));
    }
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("embeds: the address is not trusted", () => {
  const embed = (url: string) =>
    page(
      `<!-- wp:embed {"url":"${url}"} --><figure class="wp-block-embed"><div class="wp-block-embed__wrapper">\n${url}\n</div></figure><!-- /wp:embed -->`,
    );

  test("a video id that could close an attribute is not an id: the embed stays a link, nothing is injected", async () => {
    const evil = [
      "https://www.youtube.com/watch?v=abc%22%20onload%3D%22alert(1)",
      "https://www.youtube.com/watch?v=abc%22%20onload%3Dalert(1)%20x%3D%22",
      "https://www.youtube.com/playlist?list=PL%22x",
      "https://www.youtube.com/embed/ab%22c",
      "https://youtu.be/ab%22c",
    ];
    for (const url of evil) {
      const r = await embed(url);
      expect(r.html).not.toContain("<iframe");
      expect(r.html).not.toContain("onload=");
      expect(r.codes).toContain("block.embed-unresolved");
    }
  });

  test("a list id that is not made of word characters is dropped, the video it belongs to is kept", async () => {
    const r = await embed("https://www.youtube.com/watch?v=abc_-1&list=PL%22x");
    expect(r.html).toContain(`src="https://www.youtube.com/embed/abc_-1?feature=oembed"`);
    const ok = await embed("https://www.youtube.com/watch?v=abc_-1&list=PLab-9");
    expect(ok.html).toContain(`embed/abc_-1?list=PLab-9&amp;feature=oembed`);
  });

  test("shorts and the mobile host are the ids and the player they look like", async () => {
    for (const url of [
      "https://www.youtube.com/shorts/Abc123_-x",
      "https://m.youtube.com/watch?v=Abc123_-x",
      "https://youtu.be/Abc123_-x",
    ]) {
      const r = await embed(url);
      expect(r.html).toContain(`src="https://www.youtube.com/embed/Abc123_-x?feature=oembed"`);
    }
  });

  test("a paragraph that is only a YouTube address is the player WordPress embeds there (ap post 732)", async () => {
    const r = await convertMarkup(
      `<!-- wp:paragraph -->\n<p> https://www.youtube.com/watch?v=OEg_OSAggnA</p>\n<!-- /wp:paragraph -->`,
      "ap",
      { kind: "post", id: 732 },
      { target: "page" } as Partial<ConvertCtx>,
    );
    // The live page's own response, which the post cached in its meta.
    expect(r.html).toMatch(
      /^<p><iframe title="[^"]*Falwell[^"]*" width="500" height="281" src="https:\/\/www\.youtube\.com\/embed\/OEg_OSAggnA\?feature=oembed"/,
    );
    // An address inside a sentence stays text, and so does one that is not a video.
    const text = await page(
      `<!-- wp:paragraph --><p>see https://youtu.be/abc and https://example.org/x</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>https://example.org/x</p><!-- /wp:paragraph -->`,
    );
    expect(text.html).not.toContain("<iframe");
  });

  test("an address alone on a line of classic content is embedded; with no cached response it is rebuilt, and said", async () => {
    const r = await page(`first\n\nhttps://vimeo.com/123456\n\nlast`);
    expect(r.html).toContain(
      `<p><iframe title="Vimeo video" src="https://player.vimeo.com/video/123456`,
    );
    expect(entriesOf(r.ctx, "block.embed-reconstructed")).toHaveLength(1);
  });
});

describe("post-date: the date, the zone and the format", () => {
  const entry = async (markup: string, options: Record<string, string> = {}) =>
    convertMarkup(markup, "ap", { kind: "template", slug: "single" }, await withOptions(options));

  test("a site with only a gmt_offset prints the date of that offset, not of UTC", async () => {
    const r = await entry(`<!-- wp:post-date {"format":"F j, Y"} /-->`, {
      timezone_string: "",
      gmt_offset: "-4",
    });
    const time = firstEl(firstEl(r.nodes).children as JxNode[]);
    const text = time.textContent as string;
    expect(text).toContain(`"timeZone":"-04:00"`);
    // 22:00 on November 2 in UTC-4 is already November 3 in UTC.
    expect(evalBinding(text, { entry: { data: { date: "2024-11-02T22:00:00-04:00" } } })).toBe(
      "November 2, 2024",
    );
    expect(evalBinding(text, { entry: { data: {} } })).toBe("");
  });

  test("M j, Y is the short month", async () => {
    const r = await entry(`<!-- wp:post-date {"format":"M j, Y"} /-->`);
    const text = firstEl(firstEl(r.nodes).children as JxNode[]).textContent as string;
    expect(evalBinding(text, { entry: { data: { date: "2024-11-02T12:00:00-04:00" } } })).toBe(
      "Nov 2, 2024",
    );
  });

  describe("in a static page", () => {
    const run = (markup: string) =>
      convertMarkup(markup, "ap", AP_ESSAY, { target: "page" } as Partial<ConvertCtx>);

    test("human-diff depends on the day the page is read: it is the site's format, and the report says so", async () => {
      const r = await run(`<!-- wp:post-date {"format":"human-diff"} /-->`);
      expect(r.html).toContain(`>November 2, 2024</time>`);
      expect(entriesOf(r.ctx, "block.date-format")[0]).toMatchObject({
        data: { format: "human-diff" },
      });
    });

    test("a block bound to the modified date shows it; the legacy displayType: modified has its own class", async () => {
      const bound = await run(
        `<!-- wp:post-date {"metadata":{"bindings":{"datetime":{"source":"core/post-data","args":{"field":"modified"}}}}} /-->`,
      );
      const post = (await loadSite("ap")).model.posts.get(8819)!;
      expect(post.modified).not.toBe(post.date);
      const modifiedDay = bound.html.match(/<time datetime="([^"]+)"/)![1]!;
      expect(Date.parse(modifiedDay)).toBe(Date.parse(post.modified));
      expect(bound.html).not.toContain("wp-block-post-date__modified-date");
      const legacy = await run(`<!-- wp:post-date {"displayType":"modified"} /-->`);
      expect(classes(firstEl(legacy.nodes))).toContain("wp-block-post-date__modified-date");
      const published = await run(
        `<!-- wp:post-date {"metadata":{"bindings":{"datetime":{"source":"core/post-data","args":{"field":"date"}}}}} /-->`,
      );
      expect(published.html).toContain(`datetime="2024-11-02T12:03:00-04:00"`);
    });

    test("a datetime the block holds is the date it shows", async () => {
      const r = await run(`<!-- wp:post-date {"datetime":"2020-01-05T08:00:00-05:00"} /-->`);
      expect(r.html).toContain(`<time datetime="2020-01-05T08:00:00-05:00">January 5, 2020</time>`);
    });
  });
});

describe("post-excerpt: the length and the more link", () => {
  const AP_EXCERPT = async (own: string, attrs: string) => {
    const loaded = await loadSite("ap");
    const post = { ...loaded.model.posts.get(8819)!, excerpt: own };
    return convertMarkup(`<!-- wp:post-excerpt ${attrs} /-->`, "ap", AP_ESSAY, {
      subject: { kind: "post", id: "8819", post },
      target: "page",
    } as Partial<ConvertCtx>);
  };
  const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

  test("an excerpt the post wrote is trimmed to the length too, 55 words when the block does not say", async () => {
    const r = await AP_EXCERPT(words(80), `{}`);
    const text = textOfNodes(r.nodes).trim();
    expect(text.split(/\s+/)).toHaveLength(55);
    expect(text.endsWith("…")).toBe(true);
    const ten = await AP_EXCERPT(words(80), `{"excerptLength":10}`);
    expect(textOfNodes(ten.nodes).trim().split(/\s+/)).toHaveLength(10);
  });

  test("an excerpt of exactly the length is whole, with no ellipsis; one word more is trimmed", async () => {
    const exact = await AP_EXCERPT(words(10), `{"excerptLength":10}`);
    expect(textOfNodes(exact.nodes)).toBe(words(10));
    const more = await AP_EXCERPT(words(11), `{"excerptLength":10}`);
    expect(textOfNodes(more.nodes)).toBe(`${words(10)}…`);
  });

  test("the more text is RichText: markup is markup and an entity is one character", async () => {
    const r = await AP_EXCERPT("Short", `{"moreText":"Read &amp; more <em>now</em>"}`);
    expect(r.html).toContain(`>Read &amp; more <em>now</em></a>`);
    expect(r.html).not.toContain("&amp;amp;");
  });

  test("the more link follows inline when the block says so, with a space unless the excerpt is empty", async () => {
    const r = await AP_EXCERPT("Short", `{"moreText":"More","showMoreOnNewLine":false}`);
    expect(r.html).toContain(
      `<p class="wp-block-post-excerpt__excerpt"><span>Short</span> <a class="wp-block-post-excerpt__more-link"`,
    );
    expect(r.html).not.toContain("wp-block-post-excerpt__more-text");
  });
});

describe("a template string in a value the converter does not control", () => {
  const unknown = (attrs: object) =>
    convertMarkup(`<!-- wp:acme/thing ${JSON.stringify(attrs)} /-->`, "fineline", FL_PAGE, {
      target: "page",
    } as Partial<ConvertCtx>);

  test("a placeholder carries a `${` in its attributes as data, not as a binding", async () => {
    const attrs = { a: "price ${evil} now", n: 3 };
    const r = await unknown(attrs);
    const el = firstEl(r.nodes);
    const json = JSON.stringify(r.nodes);
    expect(json).not.toContain("${");
    // Nothing is lost: the attributes read back as they were.
    expect(JSON.parse(el.attributes!["data-attrs"] as string)).toEqual(attrs);
  });

  test("a slug, a class and a more text with a `${` are made inert, and the report says so; the text stays text", async () => {
    const r = await convertMarkup(
      `<!-- wp:template-part {"slug":"x\${y}","className":"c\${z}"} /-->`,
      "fineline",
      FL_PAGE,
    );
    expect(JSON.stringify(r.nodes)).not.toContain("${");
    expect(entriesOf(r.ctx, "block.template-literal").length).toBeGreaterThan(0);
    const loaded = await loadSite("ap");
    const post = { ...loaded.model.posts.get(8819)!, excerpt: "Short" };
    const more = await convertMarkup(
      `<!-- wp:post-excerpt {"moreText":"Read \${z}"} /-->`,
      "ap",
      AP_ESSAY,
      { subject: { kind: "post", id: "8819", post }, target: "page" } as Partial<ConvertCtx>,
    );
    expect(more.html).toContain("&#36;{z}");
    expect(JSON.stringify(more.nodes)).not.toContain("${");
  });

  test("an anchor that is not a selector (2024-report) keeps the style on a scope class, with the id an attribute", async () => {
    const r = await convertMarkup(
      `<!-- wp:post-title {"anchor":"2024-report","style":{"color":{"text":"#f00"}}} /-->`,
      "ap",
      AP_ESSAY,
      { target: "page" } as Partial<ConvertCtx>,
    );
    const h = firstEl(r.nodes);
    expect(h.id).toBeUndefined();
    expect(h.attributes).toEqual({ id: "2024-report" });
    expect(h.style).toEqual({ color: "#f00" });
    expect(classes(h)[0]).toMatch(/^jx-/);
    // An anchor that is a selector is the id, as before.
    const ok = await convertMarkup(
      `<!-- wp:post-title {"anchor":"report","style":{"color":{"text":"#f00"}}} /-->`,
      "ap",
      AP_ESSAY,
      { target: "page" } as Partial<ConvertCtx>,
    );
    expect(firstEl(ok.nodes).id).toBe("report");
    expect(classes(firstEl(ok.nodes))[0]).toBe("wp-block-post-title");
  });
});

describe("RichText attributes are markup (wp_kses_post), the placeholder an attribute (esc_attr)", () => {
  test("a navigation label with an entity shows one ampersand, with inline markup it has the markup", async () => {
    const r = await page(
      `<!-- wp:navigation-link {"label":"Missions &amp; Evangelism","url":"/m/"} /--><!-- wp:navigation-link {"label":"Q <em>and</em> A","url":"/q/"} /-->`,
    );
    expect(r.html).toContain(
      `<span class="wp-block-navigation-item__label">Missions &amp; Evangelism</span>`,
    );
    expect(r.html).not.toContain("&amp;amp;");
    expect(r.html).toContain(`>Q <em>and</em> A</span>`);
  });

  test("markup the filter does not allow is shown as the text it was typed as, and no attribute runs a script", async () => {
    const r = await page(
      `<!-- wp:navigation-link {"label":"a <script>x()</script> <b onclick=\\"y()\\" class=\\"k\\">b</b> <a href=\\"javascript:z()\\">c</a>","url":"/m/"} /-->`,
    );
    expect(r.html).not.toContain("<script");
    expect(r.html).not.toContain("onclick");
    expect(r.html).not.toContain("javascript:");
    expect(r.html).toContain(`<b class="k">b</b>`);
    // An entity does not get a scheme past the filter.
    const entity = await page(
      `<!-- wp:navigation-link {"label":"<a href=\\"&#106;avascript&colon;z()\\">c</a>","url":"/m/"} /-->`,
    );
    expect(entity.html).not.toMatch(/javascript|&#106;/i);
  });

  test("a navigation link with no label is not printed", async () => {
    expect((await page(`<!-- wp:navigation-link {"url":"/m/"} /-->`)).nodes).toEqual([]);
    expect((await page(`<!-- wp:navigation-link {"label":"","url":"/m/"} /-->`)).nodes).toEqual([]);
  });

  test("the search label, the button text and the placeholder are not encoded twice", async () => {
    const r = await page(
      `<!-- wp:search {"label":"Search &amp; <em>find</em>","buttonText":"Go &amp; see","placeholder":"a &quot;b&quot; &amp; c"} /-->`,
    );
    expect(r.html).toContain(`>Search &amp; <em>find</em></label>`);
    expect(r.html).toContain(`>Go &amp; see</button>`);
    expect(r.html).toContain(`placeholder="a &quot;b&quot; &amp; c"`);
    expect(r.html).not.toContain("&amp;amp;");
  });

  test("a social link's label is escaped once", async () => {
    const r = await page(
      `<!-- wp:social-link {"url":"https://x.org","service":"x","label":"Tom &amp; Jerry"} /-->`,
    );
    expect(r.html).toContain(`>Tom &amp; Jerry</span>`);
  });
});

describe("shortcodes are matched as WordPress's registry does: by exact name", () => {
  test("[Video], [Gallery] and [Audio: clip] in raw HTML are text; [video] is the shortcode", async () => {
    const text = await page(
      `<!-- wp:html --><p>[Video] and [Gallery] and [Audio: clip]</p><!-- /wp:html -->`,
    );
    expect(text.html).toBe(`<p>[Video] and [Gallery] and [Audio: clip]</p>`);
    expect(text.codes).toEqual([]);
    const real = await page(`<!-- wp:html --><p>[video src="a.mp4"]</p><!-- /wp:html -->`);
    expect(real.html).toContain("wp2jx-shortcode");
    expect(real.codes).toEqual(["block.shortcode"]);
  });
});

describe("core/block: a reusable block WordPress would not print", () => {
  test("a draft is not printed, and the report says why (ap 1069)", async () => {
    const r = await convertMarkup(`<!-- wp:block {"ref":1069} /-->`, "ap", {
      kind: "post",
      id: 8819,
    });
    expect(r.nodes).toEqual([]);
    expect(entriesOf(r.ctx, "block.reusable-unpublished")[0]).toMatchObject({
      severity: "warn",
      data: { ref: 1069, status: "draft" },
    });
    // A published one is printed, in place.
    const loaded = await loadSite("ap");
    const published = {
      ...loaded.model.posts.get(8)!,
      id: 99_991,
      content: `<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->`,
    };
    const shown = await convertMarkup(
      `<!-- wp:block {"ref":99991} /-->`,
      "ap",
      { kind: "post", id: 8819 },
      {
        model: { ...loaded.model, posts: new Map(loaded.model.posts).set(99_991, published) },
      } as Partial<ConvertCtx>,
    );
    expect(shown.html).toBe("<p>Hi</p>");
  });

  test("a password-protected one is not printed, and a post that is not a reusable block is missing", async () => {
    const loaded = await loadSite("ap");
    const protectedPost = { ...loaded.model.posts.get(8)!, passwordProtected: true };
    const models = { ...loaded.model, posts: new Map(loaded.model.posts).set(8, protectedPost) };
    const hidden = await convertMarkup(
      `<!-- wp:block {"ref":8} /-->`,
      "ap",
      { kind: "post", id: 8819 },
      {
        model: models,
      } as Partial<ConvertCtx>,
    );
    expect(hidden.nodes).toEqual([]);
    expect(entriesOf(hidden.ctx, "block.reusable-unpublished")[0]).toMatchObject({
      data: { passwordProtected: true },
    });
    const wrongType = await convertMarkup(`<!-- wp:block {"ref":8819} /-->`, "ap", {
      kind: "post",
      id: 8819,
    });
    expect(wrongType.nodes).toEqual([]);
    expect(entriesOf(wrongType.ctx, "block.reusable-missing")).toHaveLength(1);
  });
});

describe("query-title: the archive's own prefix", () => {
  const title = async (slug: string, attrs = `{"type":"archive"}`) => {
    const ctx = await driven("ap", { kind: "template", slug }, { termExpr: "state.term" });
    const nodes = ctx.convert(parseBlocks(`<!-- wp:query-title ${attrs} /-->`));
    return { ctx, html: nodesToHtml(nodes) };
  };

  test("a tag archive is `Tag: name`, a custom taxonomy has its singular label (ap `series`)", async () => {
    expect((await title("tag")).html).toBe(
      `<h1 class="wp-block-query-title">Tag: \${state.term.name}</h1>`,
    );
    const series = await title("taxonomy-series");
    expect(series.html).toMatch(
      /^<h1 class="wp-block-query-title">Series: \$\{state\.term\.name\}<\/h1>$/,
    );
  });

  test("showPrefix: false is the name alone", async () => {
    expect((await title("tag", `{"type":"archive","showPrefix":false}`)).html).toBe(
      `<h1 class="wp-block-query-title">\${state.term.name}</h1>`,
    );
  });

  test("an archive template that shows more than one kind has no one label: the name alone, and the report says why", async () => {
    const r = await title("archive");
    expect(r.html).toBe(`<h1 class="wp-block-query-title">\${state.term.name}</h1>`);
    expect(entriesOf(r.ctx, "block.archive-prefix")).toHaveLength(1);
  });
});

describe("entry bindings are coalesced, so an entry without a field builds to nothing, not to a binding left for the client", () => {
  test("built with an entry that has no excerpt, no date and no image: every binding resolves, none is left for the client", async () => {
    const r = await convertMarkup(
      `<!-- wp:post-title /--><!-- wp:post-date /--><!-- wp:post-excerpt {"moreText":"More"} /--><!-- wp:post-featured-image /--><!-- wp:post-content /-->`,
      "ap",
      { kind: "template", slug: "single" },
      { mode: "entry", entryExpr: "state.entry" },
    );
    const site = await buildJxProject(
      {
        "project.json": {
          name: "e",
          url: "https://example.com",
          extensions: ["@jxsuite/parser"],
          images: { optimize: false, lazyLoad: false },
          content: {
            posts: {
              source: "content/posts",
              format: "Markdown",
              schema: {
                type: "object",
                properties: { title: { type: "string" }, slug: { type: "string" } },
              },
            },
          },
        },
        "content/posts/entry.md": [
          "---",
          "title: Only a title",
          "slug: entry",
          "---",
          "",
          "Body.",
          "",
        ].join("\n"),
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
          children: r.nodes,
        },
        "pages/index.json": { children: [{ tagName: "p", textContent: "home" }] },
      },
      { name: "coalesce", timeoutMs: 110_000 },
    );
    const html = site.html("/posts/entry/");
    expect(html).not.toContain("data-bind");
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("undefined");
  });
});

describe("layout classes: orientation, justification and nowrap, and the blocks that have a layout without saying", () => {
  test("the classes layout.php adds from the attributes come before the layout's own", () => {
    expect(
      layoutClasses("buttons", { layout: { type: "flex", justifyContent: "center" } }),
    ).toEqual([
      "is-content-justification-center",
      "is-layout-flex",
      "wp-block-buttons-is-layout-flex",
    ]);
    expect(
      layoutClasses("group", {
        layout: {
          type: "flex",
          orientation: "vertical",
          justifyContent: "space-between",
          flexWrap: "nowrap",
        },
      }),
    ).toEqual([
      "is-vertical",
      "is-content-justification-space-between",
      "is-nowrap",
      "is-layout-flex",
      "wp-block-group-is-layout-flex",
    ]);
    // A wrap that is not `nowrap` adds nothing.
    expect(layoutClasses("group", { layout: { type: "flex", flexWrap: "wrap" } })).toEqual([
      "is-layout-flex",
      "wp-block-group-is-layout-flex",
    ]);
  });

  test("a cover and a details support a layout and default to flow", () => {
    expect(layoutClasses("cover", {})).toEqual(["is-layout-flow", "wp-block-cover-is-layout-flow"]);
    expect(layoutClasses("details", {})).toEqual([
      "is-layout-flow",
      "wp-block-details-is-layout-flow",
    ]);
    expect(layoutClasses("paragraph", { layout: { type: "flex" } })).toEqual([]);
  });

  test("real: ap post 2935's buttons keep their justification (the rule that centres them selects on it)", async () => {
    const r = await real(
      "ap",
      "core/buttons",
      (b) => JSON.stringify(b.attrs).includes("justifyContent"),
      0,
      {
        target: "page",
      } as Partial<ConvertCtx>,
    );
    expect(classes(firstEl(r.nodes))).toEqual([
      "wp-block-buttons",
      "is-content-justification-center",
      "is-layout-flex",
      "wp-block-buttons-is-layout-flex",
    ]);
  });

  test("a cover's layout classes are on its inner container, where WordPress puts them", async () => {
    const r = await real("ap", "core/cover", () => true, 0, {
      target: "page",
    } as Partial<ConvertCtx>);
    expect(classes(firstEl(r.nodes))).toEqual(["wp-block-cover"]);
    expect(r.html).toContain(
      `class="wp-block-cover__inner-container is-layout-flow wp-block-cover-is-layout-flow"`,
    );
  });
});

describe("block supports: borders, typography and what is not carried", () => {
  const supports = async (attrs: object) => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    const block: WpBlock = {
      name: "core/post-title",
      attrs: attrs as Record<string, unknown>,
      innerBlocks: [],
      innerHTML: "",
      innerContent: [],
    };
    return { s: supportsOf(block, ctx), ctx };
  };

  test("a border width alone adds no has-border-color (the style engine adds it for a colour), and a number is pixels", async () => {
    const { s } = await supports({ style: { border: { width: "2px" } } });
    expect(s.classes).toEqual([]);
    expect(s.style).toEqual([["border-width", "2px"]]);
    expect((await supports({ style: { border: { width: 3 } } })).s.style).toEqual([
      ["border-width", "3px"],
    ]);
  });

  test("a border colour, named or custom, has the class; a named one names itself and needs no style", async () => {
    const custom = await supports({ style: { border: { color: "#123" } } });
    expect(custom.s.classes).toEqual(["has-border-color"]);
    expect(custom.s.style).toEqual([["border-color", "#123"]]);
    const named = await supports({ borderColor: "primary" });
    expect(named.s.classes).toEqual(["has-border-color", "has-primary-border-color"]);
    expect(named.s.style).toEqual([]);
  });

  test("each side has its own width, colour and style; each corner its own radius, to its own property", async () => {
    const { s } = await supports({
      style: {
        border: {
          top: { width: "1px", color: "#000", style: "solid" },
          left: { width: 2 },
          radius: {
            topLeft: "1px",
            topRight: "2px",
            bottomLeft: "3px",
            bottomRight: "4px",
          },
        },
      },
    });
    expect(Object.fromEntries(s.style)).toEqual({
      "border-top-left-radius": "1px",
      "border-top-right-radius": "2px",
      "border-bottom-left-radius": "3px",
      "border-bottom-right-radius": "4px",
      "border-top-width": "1px",
      "border-top-color": "#000",
      "border-top-style": "solid",
      "border-left-width": "2px",
    });
  });

  test("a numeric line height and weight are written, a text alignment is a declaration", async () => {
    const { s } = await supports({
      style: { typography: { lineHeight: 1.6, fontWeight: 700, textAlign: "center" } },
    });
    expect(Object.fromEntries(s.style)).toEqual({
      "line-height": "1.6",
      "font-weight": "700",
      "text-align": "center",
    });
  });

  test("a setting nothing here writes is reported with its path, not dropped in silence", async () => {
    const { ctx } = await supports({
      style: {
        border: { colour: "x", top: { sides: 1 } },
        typography: { fontSize: 14, hyphens: "auto" },
        dimensions: { width: "10px" },
      },
    });
    const [entry] = entriesOf(ctx, "block.style-dropped");
    expect(entry!.data!.keys).toEqual(
      expect.arrayContaining([
        "typography.fontSize",
        "typography.hyphens",
        "border.colour",
        "border.top.sides",
        "dimensions.width",
      ]),
    );
  });

  test("a value that is an array is not a record: a malformed attribute is ignored, not read", async () => {
    const { s } = await supports({ style: ["color"], layout: ["x"] });
    expect(s.classes).toEqual([]);
    expect(s.style).toEqual([]);
    expect(layoutClasses("group", { layout: ["x"] })).toEqual([
      "is-layout-flow",
      "wp-block-group-is-layout-flow",
    ]);
    const colour = await supports({ style: { color: ["text"], border: ["x"], spacing: ["x"] } });
    expect(colour.s.style).toEqual([]);
  });
});

describe("post-featured-image: what WordPress derives", () => {
  const run = (attrs: string) =>
    convertMarkup(`<!-- wp:post-featured-image ${attrs} /-->`, "ap", AP_ESSAY, {
      target: "page",
    } as Partial<ConvertCtx>);
  const imgOf = (nodes: JxNode[]): JxElement => {
    const find = (list: readonly JxNode[]): JxElement | undefined => {
      for (const n of list) {
        if (typeof n === "string") continue;
        if (n.tagName === "img") return n;
        const inner = Array.isArray(n.children) ? find(n.children) : undefined;
        if (inner) return inner;
      }
      return undefined;
    };
    return find(nodes)!;
  };

  test("scale defaults to cover, so object-fit is always written", async () => {
    expect(imgOf((await run(`{}`)).nodes).style).toEqual({ objectFit: "cover" });
    expect(imgOf((await run(`{"scale":"contain"}`)).nodes).style).toEqual({ objectFit: "contain" });
  });

  test("an aspect ratio needs the full width; auto adds no ratio; a width alone needs height auto; a height is the height", async () => {
    expect(imgOf((await run(`{"aspectRatio":"16/9"}`)).nodes).style).toEqual({
      aspectRatio: "16/9",
      width: "100%",
      objectFit: "cover",
    });
    expect(imgOf((await run(`{"aspectRatio":"auto"}`)).nodes).style).toEqual({
      width: "100%",
      objectFit: "cover",
    });
    expect(imgOf((await run(`{"width":"50%"}`)).nodes).style).toEqual({
      width: "50%",
      height: "auto",
      objectFit: "cover",
    });
    expect(imgOf((await run(`{"width":"50%","height":"200px"}`)).nodes).style).toEqual({
      width: "50%",
      height: "200px",
      objectFit: "cover",
    });
  });

  test("a dim ratio is an overlay span after the image, inside the link when there is one", async () => {
    const r = await run(
      `{"isLink":true,"dimRatio":50,"overlayColor":"black","customOverlayColor":"#111"}`,
    );
    expect(r.html).toMatch(/><\/span><\/a><\/figure>$/);
    const overlay = r.html.match(
      /<span class="[^"]*wp-block-post-featured-image__overlay[^"]*"[^>]*>/,
    )![0];
    expect(overlay).toContain(
      "has-background-dim has-background-dim-50 has-black-background-color",
    );
    expect(overlay).toContain(`aria-hidden="true"`);
    expect(overlay).toContain("background-color: #111");
    // No dim ratio, no overlay.
    expect((await run(`{"dimRatio":0,"overlayColor":"black"}`)).html).not.toContain("__overlay");
  });
});

describe("social links: what the parent says, and WordPress's address rules", () => {
  const links = (inner: string, parent = "") =>
    page(
      `<!-- wp:social-links ${parent} --><ul class="wp-block-social-links">${inner}</ul><!-- /wp:social-links -->`,
    );

  test("showLabels shows the label; openInNewTab adds target and rel noopener nofollow, after the link's own rel", async () => {
    const shown = await links(
      `<!-- wp:social-link {"url":"https://x.org","service":"x","rel":"me"} /-->`,
      `{"showLabels":true,"openInNewTab":true}`,
    );
    expect(shown.html).toContain(`class="wp-block-social-link-label">X</span>`);
    expect(shown.html).toContain(`rel="me noopener nofollow" target="_blank"`);
    const plain = await links(`<!-- wp:social-link {"url":"https://x.org","service":"x"} /-->`);
    expect(plain.html).toContain(`screen-reader-text">X</span>`);
    expect(plain.html).not.toContain("target=");
  });

  test("an e-mail address is a mailto link, an address with no scheme gets https, a fragment and a root path are kept", async () => {
    const r = await links(
      `<!-- wp:social-link {"url":"me@x.org","service":"mail"} /--><!-- wp:social-link {"url":"example.com/me","service":"x"} /--><!-- wp:social-link {"url":"#top","service":"link"} /--><!-- wp:social-link {"url":"//cdn.x.org/a","service":"link"} /-->`,
    );
    expect(r.html).toContain(`href="mailto:me@x.org"`);
    expect(r.html).toContain(`href="https://example.com/me"`);
    expect(r.html).toContain(`href="#top"`);
    expect(r.html).toContain(`href="//cdn.x.org/a"`);
  });

  test("a link with no address is not printed", async () => {
    const r = await links(`<!-- wp:social-link {"service":"x"} /-->`);
    expect(r.html).not.toContain("<li");
  });
});

describe("post-title: a link's own attributes", () => {
  test("a custom class and an anchor with a template string are made inert, and the report says so", async () => {
    const r = await convertMarkup(
      `<!-- wp:post-title {"className":"a\${b}","anchor":"x\${y}"} /-->`,
      "ap",
      AP_ESSAY,
      { target: "page" } as Partial<ConvertCtx>,
    );
    expect(JSON.stringify(r.nodes)).not.toContain("${");
    expect(entriesOf(r.ctx, "block.template-literal")).toHaveLength(2);
  });

  test("a link target with a template string is made inert", async () => {
    const r = await convertMarkup(
      `<!-- wp:post-title {"isLink":true,"linkTarget":"_b\${x}"} /-->`,
      "ap",
      AP_ESSAY,
      { target: "page" } as Partial<ConvertCtx>,
    );
    expect(JSON.stringify(r.nodes)).not.toContain("${");
  });
});

describe("freeform content and wpautop", () => {
  test("a driver that knows the template prints content as saved (Cwicly's content block) turns wpautop off", async () => {
    const markup = `stories of radical faith`;
    const normal = await page(markup);
    expect(normal.html).toBe(`<p>stories of radical faith</p>`);
    const ctx = await driven("fineline", FL_PAGE, {
      target: "page",
      wpautop: false,
    } as Partial<ConvertCtx>);
    const nodes = ctx.convert(parseBlocks(markup));
    expect(nodesToHtml(nodes)).toBe(`stories of radical faith`);
    // Paragraphs the author wrote are markup either way.
    expect(nodesToHtml(ctx.convert(parseBlocks(`<p>a</p>`)))).toBe(`<p>a</p>`);
  });
});
