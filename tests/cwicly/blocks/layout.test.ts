/**
 * The Cwicly layout, text and media blocks (src/cwicly/blocks/layout.ts).
 *
 * The driver that dispatches every block does not exist while this module is written, so a small
 * stand-in does its job: core blocks go to the core converters, the blocks of this module to
 * `layoutConverters`, and every other Cwicly block (queries, components, menus, modals) to an empty
 * `wp2jx-block` placeholder, so a tree around them stays comparable. Everything real that exists is
 * real: the model, the options, the CSS index, routes and media, both fixture sites, and the Jx
 * build.
 *
 * What stands behind the converters, in the order of the file:
 * 1. each block, real wherever a fixture has one and hand-made where none does (named as such);
 * 2. the census: every layout block of both sites converts, with the counts asserted;
 * 3. the live pages (tests/fixtures/<site>/html), the ground truth: the converted blocks of a page's
 *    subjects are built through Jx and compared, element by element, with the page the site printed;
 * 4. the entry templates: the same blocks converted for a static page and for an entry template are
 *    built and must say the same thing;
 * 5. the Markdown target, and building and validating everything.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "parse5";
import { serializeJxMarkdown } from "@jxsuite/parser/serialize";
import { transpileJxMarkdown } from "@jxsuite/parser/transpile";
import { convertCoreBlock } from "../../../src/core/blocks.ts";
import { nodesToHtml } from "../../../src/html.ts";
import { layoutConverters } from "../../../src/cwicly/blocks/layout.ts";
import { placeholder } from "../../../src/cwicly/blocks/common.ts";
import { savedTags, styleBlock } from "../../../src/cwicly/style.ts";
import { postData, postFacts, resolveTokens } from "../../../src/cwicly/tokens.ts";
import { walkBlocks } from "../../../src/wp/blocks.ts";
import { parseBlocks } from "../../../src/wp/blocks.ts";
import type {
  ConvertCtx,
  JxElement,
  JxNode,
  JxStyle,
  ReportEntry,
  WpBlock,
} from "../../../src/types.ts";
import {
  allSubjects,
  componentsOf,
  loadSite,
  makeCtx,
  subjectBlocks,
  subjectPost,
} from "../../helpers/ctx.ts";
import type { LoadedSite, SiteName, Subject } from "../../helpers/ctx.ts";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "../../helpers/jx-build.ts";
import type { ProjectFile } from "../../helpers/jx-build.ts";

setDefaultTimeout(240_000);
afterAll(cleanupJxProjects);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The stand-in driver
// ═══════════════════════════════════════════════════════════════════════════════════════════════

interface Run {
  /** The key a block's own element is marked with, when the run is marked: its place in the subject's tree, else its uniqueID. */
  keyOf(block: WpBlock): string;
  ctx: ConvertCtx;
  /** What the blocks hoisted (rules that cannot live in one element's style). */
  hoisted: { selector: string; style: JxStyle }[];
  /** Each call of a layout converter: the block and what it returned. */
  calls: { block: WpBlock; nodes: JxNode[] }[];
}

const MINE = new Set(Object.keys(layoutConverters));

/**
 * The attribute the oracles find a block's own element by: the block's place in its subject's tree. A class cannot say which element
 * is a block's, because the authors of both sites copied Cwicly class lists onto core blocks and onto each other's blocks, and a
 * duplicated block keeps its uniqueID too.
 */
const MARK = "data-wp2jx";

/** `0.2.1`: the position of every block of a tree among its siblings, all the way down. */
function pathsOf(blocks: readonly WpBlock[]): WeakMap<WpBlock, string> {
  const paths = new WeakMap<WpBlock, string>();
  const visit = (list: readonly WpBlock[], prefix: string): void =>
    list.forEach((b, i) => {
      paths.set(b, `${prefix}${i}`);
      visit(b.innerBlocks, `${prefix}${i}.`);
    });
  visit(blocks, "");
  return paths;
}

function markOwn(nodes: JxNode[], block: WpBlock, key: string): void {
  const classID = block.attrs.classID;
  const uid = key;
  const visit = (n: JxNode | undefined): void => {
    if (typeof n === "string" || n === undefined) return;
    const first = (n.className ?? "")
      .split(" ")
      .find((c) => c !== "" && !/^jx-[0-9a-f]{10}$/.test(c));
    if (first === classID) {
      n.attributes = { ...n.attributes, [MARK]: String(uid) };
    } else if (Array.isArray(n.children) && n.children.length === 1) {
      visit(n.children[0]);
    }
  };
  visit(nodes[0]);
}

/** A context whose `convert` dispatches the way the real driver will. */
function standIn(base: ConvertCtx, paths?: WeakMap<WpBlock, string>): Run {
  const marked = paths !== undefined;
  const keyOf = (b: WpBlock): string =>
    paths?.get(b) ?? String(b.attrs.uniqueID ?? b.attrs.classID);
  const hoisted: Run["hoisted"] = [];
  const calls: Run["calls"] = [];
  const bind = (c: ConvertCtx): ConvertCtx => {
    const out: ConvertCtx = {
      ...c,
      hoist: (rule) => hoisted.push(rule),
      convert: (blocks, overrides) => {
        const inner = overrides ? bind({ ...out, ...overrides }) : out;
        return blocks.flatMap((b) => convertOne(b, inner));
      },
    };
    return out;
  };
  const convertOne = (b: WpBlock, ctx: ConvertCtx): JxNode[] => {
    if (b.name && Object.hasOwn(layoutConverters, b.name)) {
      const nodes = layoutConverters[b.name]!(b, ctx);
      if (marked && typeof b.attrs.classID === "string") markOwn(nodes, b, keyOf(b));
      calls.push({ block: b, nodes });
      return nodes;
    }
    if (b.name?.startsWith("cwicly/")) return [placeholder(b, "block")];
    return convertCoreBlock(b, ctx);
  };
  return { keyOf, ctx: bind(base), hoisted, calls };
}

/** How many report entries a context had before anything was converted (the stylesheet reader reports while it is made). */
const baseline = new WeakMap<object, number>();

async function runFor(
  site: SiteName,
  subject: Subject,
  over: Partial<ConvertCtx> = {},
  paths?: WeakMap<WpBlock, string>,
): Promise<Run> {
  const base = await makeCtx(site, subject, over);
  baseline.set(base.report, base.report.entries().length);
  const run = standIn(base, paths);
  baseline.set(run.ctx.report, base.report.entries().length);
  return run;
}

const reportsOf = (run: Run): ReportEntry[] =>
  run.ctx.report.entries().slice(baseline.get(run.ctx.report) ?? 0);

const codesOf = (run: Run): string[] => reportsOf(run).map((e) => e.code);

/** Convert the blocks of a subject. */
async function convertSubject(
  site: SiteName,
  subject: Subject,
  over: Partial<ConvertCtx> = {},
  marked = false,
): Promise<Run & { nodes: JxNode[]; blocks: WpBlock[] }> {
  const blocks = subjectBlocks(await loadSite(site), subject);
  const run = await runFor(site, subject, over, marked ? pathsOf(blocks) : undefined);
  return { ...run, blocks, nodes: run.ctx.convert(blocks) };
}

/** A real block by classID. */
async function realBlock(site: SiteName, subject: Subject, classID: string): Promise<WpBlock> {
  const loaded = await loadSite(site);
  let found: WpBlock | undefined;
  walkBlocks(subjectBlocks(loaded, subject), (b) => {
    if (b.attrs.classID === classID) found ??= b;
  });
  if (!found) throw new Error(`no block ${classID} in ${JSON.stringify(subject)}`);
  return found;
}

/** The first block of a subject a predicate accepts. */
async function findBlock(
  site: SiteName,
  subject: Subject,
  accept: (b: WpBlock) => boolean,
): Promise<WpBlock> {
  const loaded = await loadSite(site);
  let found: WpBlock | undefined;
  walkBlocks(subjectBlocks(loaded, subject), (b) => {
    if (found === undefined && accept(b)) found = b;
  });
  if (!found) throw new Error(`no matching block in ${JSON.stringify(subject)}`);
  return found;
}

/** One block converted on its own (its inner blocks are converted too, unless `bare`). */
async function convertBlock(
  site: SiteName,
  subject: Subject,
  b: WpBlock,
  over: Partial<ConvertCtx> = {},
  bare = false,
): Promise<Run & { nodes: JxNode[] }> {
  const run = await runFor(site, subject, over);
  return { ...run, nodes: run.ctx.convert([bare ? { ...b, innerBlocks: [] } : b]) };
}

const block = (
  name: string,
  attrs: Record<string, unknown> = {},
  innerHTML = "",
  innerBlocks: WpBlock[] = [],
): WpBlock => ({ name, attrs, innerBlocks, innerHTML, innerContent: [innerHTML] });

const el = (node: JxNode | undefined): JxElement => {
  if (typeof node === "string" || node === undefined) throw new Error("expected an element");
  return node;
};

const attrsOf = (node: JxNode | undefined): Record<string, unknown> =>
  (el(node).attributes ?? {}) as Record<string, unknown>;

const kids = (node: JxNode | undefined): JxNode[] => {
  const c = el(node).children;
  return Array.isArray(c) ? c : [];
};

/** Every element under (and including) the nodes, depth first. */
function* elements(nodes: readonly JxNode[]): Generator<JxElement> {
  for (const n of nodes) {
    if (typeof n === "string") continue;
    yield n;
    if (Array.isArray(n.children)) yield* elements(n.children);
  }
}

const htmlOf = (nodes: JxNode[]): string => nodesToHtml(nodes);

const PROJECT = (extra: Record<string, unknown> = {}): ProjectFile => ({
  name: "wp2jx-test",
  url: "https://example.com",
  defaults: { layout: "./layouts/base.json" },
  $media: { "--": "1366px", "--md": "(max-width: 992px)", "--sm": "(max-width: 576px)" },
  ...extra,
});

const LAYOUT: ProjectFile = { children: [{ tagName: "slot" }] };

async function buildPage(
  children: JxNode[],
  extra: Record<string, ProjectFile> = {},
  page: Record<string, unknown> = {},
) {
  return buildJxProject({
    "project.json": PROJECT(),
    "layouts/base.json": LAYOUT,
    "pages/index.json": { ...page, children },
    ...extra,
  });
}

const POST_195: Subject = { kind: "post", id: 195 };
const HEADER: Subject = { kind: "part", slug: "header" };
const FOOTER: Subject = { kind: "part", slug: "footer" };

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. Boxes
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("section, div, container, columns, column", () => {
  test("a section is its saved tag with the classID first and the structural class last", async () => {
    const b = await findBlock("fineline", HEADER, (x) => x.name === "cwicly/section");
    const { nodes } = await convertBlock("fineline", HEADER, b, {}, true);
    const node = el(nodes[0]);
    expect(node.tagName).toBe("section");
    const classes = (node.className ?? "").split(" ");
    expect(classes[0]).toBe(b.attrs.classID as string);
    expect(classes.at(-1)).toBe("cc-sct");
  });

  test("a section's inner blocks are its children, in order", async () => {
    const run = await convertSubject("fineline", POST_195);
    const top = run.nodes.filter((n) => typeof n !== "string");
    expect(top.length).toBeGreaterThan(3);
    const first = el(top[0]);
    expect(first.tagName).toBe("section");
    expect(kids(first).length).toBeGreaterThan(0);
  });

  test("a container is a div with cc-cntr, a column a div, columns a div (the layout is the stylesheet's)", async () => {
    const container = await findBlock("fineline", POST_195, (x) => x.name === "cwicly/container");
    const c = await convertBlock("fineline", POST_195, container, {}, true);
    expect(el(c.nodes[0]).tagName).toBe("div");
    expect(el(c.nodes[0]).className).toContain("cc-cntr");
    const columns = await findBlock(
      "fineline",
      { kind: "template", slug: "index" },
      (x) => x.name === "cwicly/columns",
    );
    const cs = await convertBlock(
      "fineline",
      { kind: "template", slug: "index" },
      columns,
      {},
      true,
    );
    expect(el(cs.nodes[0]).tagName).toBe("div");
    expect(el(cs.nodes[0]).className).toBe("featured-columns");
    // The columns' grid is the block's own rule.
    expect(el(cs.nodes[0]).style).toMatchObject({ display: "grid" });
  });

  test("a div keeps the tag the saved markup gives it: a, article, form", async () => {
    const linked = await realBlock("fineline", HEADER, "div-c64faab");
    expect(el((await convertBlock("fineline", HEADER, linked, {}, true)).nodes[0]).tagName).toBe(
      "a",
    );
    const article = await findBlock(
      "ap",
      { kind: "template", slug: "single-post" },
      (x) => x.name === "cwicly/div" && savedTags(x.innerHTML)[0]?.tag === "article",
    );
    expect(
      el(
        (await convertBlock("ap", { kind: "template", slug: "single-post" }, article, {}, true))
          .nodes[0],
      ).tagName,
    ).toBe("article");
    const form = await realBlock("ap", HEADER, "searchform-header");
    const formNodes = (await convertBlock("ap", HEADER, form, {}, true)).nodes;
    expect(el(formNodes[0]).tagName).toBe("form");
  });

  test("a form div keeps the attributes its tag prints", async () => {
    const form = await realBlock("ap", HEADER, "searchform-header");
    const saved = savedTags(form.innerHTML)[0]!;
    const { nodes } = await convertBlock("ap", HEADER, form, {}, true);
    for (const [name, value] of saved.attrs) {
      if (["class", "style", "id"].includes(name) || /\{/.test(value)) continue;
      expect(attrsOf(nodes[0])).toHaveProperty(name);
    }
  });

  test("a column that links is the anchor (a link-wrapped column)", async () => {
    const col = await realBlock("ap", { kind: "post", id: 13675 }, "column-cfa7888");
    const { nodes } = await convertBlock("ap", { kind: "post", id: 13675 }, col, {}, true);
    expect(el(nodes[0]).tagName).toBe("a");
    expect(attrsOf(nodes[0])).toHaveProperty("href");
  });

  test("the old section layout keeps its wrapper, with the wrapper's rule, around the inner blocks", async () => {
    const subject: Subject = { kind: "template", slug: "single-episode" };
    const hero = await realBlock("ap", subject, "section-hero");
    const { nodes } = await convertBlock("ap", subject, hero);
    const section = el(nodes[0]);
    expect(section.tagName).toBe("section");
    expect(section.className).toBe("section-hero cc-sct");
    const wrapper = el(kids(section)[0]);
    expect(wrapper.tagName).toBe("div");
    expect(wrapper.className).toBe("section-hero-wrapper cc-wrapper");
    expect(wrapper.style).toBeDefined();
    // The inner blocks are inside the wrapper, not beside it.
    expect(kids(section)).toHaveLength(1);
    expect(kids(wrapper).length).toBe(hero.innerBlocks.length);
  });

  test("a section without the wrapper has the inner blocks as its children", async () => {
    const subject: Subject = { kind: "template", slug: "single-episode" };
    const plain = await realBlock("ap", subject, "section-c9dae5d");
    const { nodes } = await convertBlock("ap", subject, plain);
    const section = el(nodes[0]);
    const wrapper = el(kids(section)[0]);
    expect(wrapper.className).toBe("section-c9dae5d-wrapper cc-wrapper");
  });

  test("a section hidden from guests is not converted, nor are its inner blocks", async () => {
    const hidden = block(
      "cwicly/section",
      { classID: "section-hg", hideGuest: true },
      '<section class="section-hg cc-sct"></section>',
      [
        block(
          "cwicly/heading",
          { classID: "h-in", content: "inner" },
          '<h2 class="h-in">inner</h2>',
        ),
      ],
    );
    const { nodes, calls } = await convertBlock("fineline", POST_195, hidden);
    expect(nodes).toEqual([]);
    expect(calls.map((c) => c.block.attrs.classID)).toEqual(["section-hg"]);
  });

  test("a div in the WooCommerce cart context keeps its children and says what it lost", async () => {
    const cart = block(
      "cwicly/div",
      { classID: "div-cart", dynamicContext: "woocart" },
      '<div class="div-cart"></div>',
      [block("cwicly/paragraph", { classID: "p-in", content: "Cart" }, '<p class="p-in">Cart</p>')],
    );
    const run = await convertBlock("fineline", POST_195, cart);
    expect(kids(run.nodes[0])).toHaveLength(1);
    expect(reportsOf(run).find((e) => e.code === "block.unsupported")).toMatchObject({
      severity: "warn",
      where: "post:195",
      data: { feature: "woocart", classID: "div-cart" },
    });
  });

  test("a styler prints nothing on the live site, and says so", async () => {
    const styler = block("cwicly/styler", { classID: "styler-1" }, '<div class="styler-1"></div>', [
      block("cwicly/paragraph", { content: "x" }, "<p>x</p>"),
    ]);
    const run = await convertBlock("fineline", POST_195, styler);
    expect(run.nodes).toEqual([]);
    expect(run.calls.map((c) => c.block.name)).toEqual(["cwicly/styler"]);
    expect(reportsOf(run).find((e) => e.code === "block.styler-dropped")?.severity).toBe("info");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1b. Text
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("heading and paragraph", () => {
  test("a heading is its tag, its text and its classes", async () => {
    const b = await findBlock("fineline", POST_195, (x) => x.name === "cwicly/heading");
    const { nodes } = await convertBlock("fineline", POST_195, b);
    const node = el(nodes[0]);
    expect(node.tagName).toBe(savedTags(b.innerHTML)[0]!.tag);
    expect(node.className?.split(" ")[0]).toBe(b.attrs.classID as string);
    expect(node.textContent).toBe(String(b.attrs.content));
  });

  test("text is texturized, as WordPress prints it", async () => {
    const b = block(
      "cwicly/heading",
      { classID: "h-t", headingTag: "h2", content: "Don't wait... 9 - 5" },
      '<h2 class="h-t">x</h2>',
    );
    const { nodes } = await convertBlock("fineline", POST_195, b);
    expect(el(nodes[0]).textContent).toBe("Don’t wait… 9 – 5");
  });

  test("a heading with no tag attribute is an h1, a paragraph a p, a span paragraph a span", async () => {
    const h = block("cwicly/heading", { content: "x" }, "");
    const p = block("cwicly/paragraph", { content: "x" }, "");
    const span = block(
      "cwicly/paragraph",
      { classID: "p-s", content: "x", containerLayoutTag: "span" },
      '<span class="p-s">x</span>',
    );
    const run = await runFor("fineline", POST_195);
    expect(el(run.ctx.convert([h])[0]).tagName).toBe("h1");
    expect(el(run.ctx.convert([p])[0]).tagName).toBe("p");
    expect(el(run.ctx.convert([span])[0]).tagName).toBe("span");
  });

  test("inline markup in the text keeps its structure (a break and a link of its own)", async () => {
    const b = await realBlock("fineline", POST_195, "heading-c51950d");
    const { nodes } = await convertBlock("fineline", POST_195, b);
    const html = htmlOf(nodes);
    expect(html).toContain("<br>");
    expect(html).toContain("We’ve Completed");
  });

  test("a heading's link wraps its text inside the heading (a project card: the title, linked to the post)", async () => {
    const subject: Subject = { kind: "post", id: 1078 };
    const b = await realBlock("fineline", subject, "heading-c235f2d");
    const { nodes } = await convertBlock("fineline", subject, b);
    const node = el(nodes[0]);
    expect(node.tagName).toBe("h3");
    expect(node.textContent).toBeUndefined();
    const anchor = el(kids(node)[0]);
    expect(anchor.tagName).toBe("a");
    expect(anchor.textContent).toBe("Log Cabin Staining In Fredericksburg PA");
    expect(attrsOf(anchor).href).toBe("/project/log-cabin-staining-in-fredericksburg-pa/");
    expect(attrsOf(node)).not.toHaveProperty("href");
  });

  test("a heading that opens a modal holds its text in a button that targets the modal: a popover opener cannot be an anchor", async () => {
    const b = block(
      "cwicly/heading",
      {
        classID: "h-m",
        headingTag: "h3",
        content: "Open it",
        linkWrapperActive: true,
        linkWrapperType: "action",
        linkWrapperAction: "modal",
        linkWrapperActionModalBlockId: "modal-pic",
        linkWrapperActionModalType: "open",
      },
      '<h3 class="h-m"></h3>',
    );
    const { nodes } = await convertBlock("fineline", POST_195, b);
    const h = el(nodes[0]);
    expect(h.tagName).toBe("h3");
    const opener = el(kids(h)[0]);
    expect(opener.tagName).toBe("button");
    expect(opener.attributes).toEqual({
      type: "button",
      popovertarget: "modal-pic",
      popovertargetaction: "show",
    });
    expect(opener.textContent).toBe("Open it");
    expect(JSON.stringify(nodes)).not.toContain('"a"');
  });

  test("in an entry template the same heading's text and address are the entry's", async () => {
    const subject: Subject = { kind: "template", slug: "archive-project" };
    const { nodes } = await convertBlock(
      "fineline",
      subject,
      await realBlock("fineline", { kind: "post", id: 1078 }, "heading-c235f2d"),
      { mode: "entry", entryType: "project", entryExpr: "$map.item" },
    );
    const anchor = el(kids(nodes[0])[0]);
    expect(anchor.textContent).toBe("${$map.item.data.title ?? ''}");
    expect(attrsOf(anchor).href).toBe("${$map.item.data.url ?? ''}");
  });

  test("a paragraph that links is an anchor, with a new window's rel", async () => {
    const b = await realBlock("fineline", FOOTER, "paragraph-cad3963");
    const { nodes } = await convertBlock("fineline", FOOTER, b);
    const node = el(nodes[0]);
    expect(node.tagName).toBe("a");
    expect(node.textContent).toBe(String(b.attrs.content));
    expect(node.attributes).toMatchObject({ target: "_blank", rel: "noopener" });
  });

  test("a paragraph's own links in a post open in a new window (Rank Math), in a template they do not", async () => {
    const post = await findBlock(
      "fineline",
      POST_195,
      (x) =>
        x.name === "cwicly/paragraph" &&
        /<a href="https?:\/\/(?!finelinepainting)/.test(String(x.attrs.content)),
    ).catch(() => undefined);
    const withLink = block(
      "cwicly/paragraph",
      { classID: "p-l", content: 'See <a href="https://example.com/x">this</a> page' },
      '<p class="p-l"></p>',
    );
    const asPost = await convertBlock("fineline", POST_195, post ?? withLink);
    expect(JSON.stringify(asPost.nodes)).toContain('"target":"_blank"');
    const asTemplate = await convertBlock("fineline", FOOTER, withLink);
    expect(JSON.stringify(asTemplate.nodes)).not.toContain("_blank");
  });

  test("a dynamic heading is a binding in an entry template and the value in a static page", async () => {
    const subject: Subject = { kind: "template", slug: "single-project" };
    const b = block(
      "cwicly/heading",
      { classID: "h-d", headingTag: "h1", dynamic: "wordpress", dynamicWordPressType: "title" },
      '<h1 class="h-d">{title}</h1>',
    );
    const entry = await convertBlock("fineline", subject, b, {
      mode: "entry",
      entryType: "project",
    });
    expect(el(entry.nodes[0]).textContent).toBe("${state.entry.data.title ?? ''}");
    const post = await loadSite("fineline");
    const real = [...post.model.posts.values()].find(
      (p) => p.type === "project" && p.status === "publish",
    )!;
    const staticRun = await convertBlock("fineline", { kind: "post", id: real.id }, b);
    expect(el(staticRun.nodes[0]).textContent).toBe(
      (await makeCtx("fineline", { kind: "post", id: real.id })).model.posts
        .get(real.id)!
        .title.replace(/&amp;/g, "&")
        .replace(/'/g, "’"),
    );
  });

  test("a component's content connector is a binding on the component's state", async () => {
    const props = new Map([["1nsiW", "heading"]]);
    const subject: Subject = { kind: "component", ref: "0a275b695a" };
    const b = await findBlock("fineline", subject, (x) => x.name === "cwicly/heading");
    const { nodes } = await convertBlock("fineline", subject, b, { props });
    expect(el(nodes[0]).textContent).toBe("${state.heading ?? ''}");
    // A rich text property is markup.
    const para = await findBlock("fineline", subject, (x) => x.name === "cwicly/paragraph");
    const rich = await convertBlock("fineline", subject, para, {
      props: new Map([["xdjvI", "paragraph"]]),
    });
    expect(el(rich.nodes[0]).innerHTML).toBe("${state.paragraph ?? ''}");
  });

  test("a block with no text is an empty element", async () => {
    const { nodes } = await convertBlock(
      "fineline",
      POST_195,
      block("cwicly/paragraph", { classID: "p-e" }, '<p class="p-e"></p>'),
    );
    expect(el(nodes[0])).toMatchObject({ tagName: "p", className: "p-e" });
    expect(el(nodes[0])).not.toHaveProperty("textContent");
  });

  test("an English text with an ampersand and angle brackets is escaped by the build, not by the converter", async () => {
    const b = block(
      "cwicly/paragraph",
      { classID: "p-amp", content: "Tom &amp; Jerry" },
      '<p class="p-amp"></p>',
    );
    const { nodes } = await convertBlock("fineline", POST_195, b);
    const site = await buildPage(nodes);
    expect(site.html("/")).toContain("Tom &amp; Jerry");
  });
});

describe("list", () => {
  test("a list is a div around the ul its content holds", async () => {
    const subject: Subject = { kind: "post", id: 5260 };
    const b = await realBlock("fineline", subject, "list-c69ba8f");
    const { nodes } = await convertBlock("fineline", subject, b);
    const node = el(nodes[0]);
    expect(node.tagName).toBe("div");
    const ul = el(kids(node)[0]);
    expect(ul.tagName).toBe("ul");
    expect(kids(ul).map((li) => el(li).tagName)).toEqual(["li", "li", "li", "li"]);
    expect(htmlOf(nodes)).toContain("<li><span>Residential</span></li>");
  });

  test("an ordered list keeps its ol (hand-made block)", async () => {
    const b = block(
      "cwicly/list",
      { classID: "list-o", content: "<ol><li>One</li><li>Two</li></ol>" },
      '<div class="list-o"></div>',
    );
    const { nodes } = await convertBlock("fineline", POST_195, b);
    expect(htmlOf(nodes)).toContain("<ol><li>One</li><li>Two</li></ol>");
  });

  test("content that holds only the li items is wrapped in the list the block's save would print: ap's ordered list keeps its ol, its unordered one its ul", async () => {
    const subject: Subject = { kind: "post", id: 1417 };
    const ordered = await realBlock("ap", subject, "list-c2d104e");
    expect(String(ordered.attrs.content).startsWith("<li>")).toBe(true);
    const o = await convertBlock("ap", subject, ordered);
    const oList = el(kids(o.nodes[0])[0]);
    expect(oList.tagName).toBe("ol");
    expect(kids(oList).every((li) => el(li).tagName === "li")).toBe(true);
    expect(kids(oList).length).toBeGreaterThan(2);

    const unordered = await realBlock("ap", subject, "list-c8f3fe7");
    expect(unordered.attrs.listTag).toBeUndefined();
    const u = await convertBlock("ap", subject, unordered);
    const uList = el(kids(u.nodes[0])[0]);
    expect(uList.tagName).toBe("ul");
    // The nested list inside an item is the item's own markup, kept as it is.
    expect(htmlOf(u.nodes)).toMatch(/<li>We represent Christianity[^<]*<ul><li>/);
    // Built, the items are inside a list.
    const html = (await buildPage(o.nodes)).html("/");
    expect(html).toMatch(/<div class="list-c2d104e[^"]*"[^>]*><ol>\s*<li>/);
  });

  test("every real list of both sites has the tags its saved markup has (the list element, its items, the nested lists)", async () => {
    let checked = 0;
    const lists: string[] = [];
    for (const site of ["fineline", "ap"] as const) {
      const loaded = await loadSite(site);
      for (const subject of allSubjects(loaded)) {
        const bs: WpBlock[] = [];
        walkBlocks(subjectBlocks(loaded, subject), (b) => {
          if (b.name === "cwicly/list") bs.push(b);
        });
        if (bs.length === 0) continue;
        const ctx = await makeCtx(site, subject);
        for (const b of bs) {
          const run = standIn(ctx);
          const out = nodesToHtml(run.ctx.convert([{ ...b, innerBlocks: [] }]));
          const tags = (html: string): string =>
            [...html.matchAll(/<([a-z][a-z0-9-]*)\b/gi)].map((m) => m[1]!.toLowerCase()).join(" ");
          const saved = tags(resolveTokens(b.innerHTML, ctx, b, { where: "html" }));
          lists.push(`${site} ${b.attrs.classID}`);
          expect(tags(out)).toBe(saved);
          checked++;
        }
      }
    }
    // fineline 4 + ap 6 (the census), the saved ul/ol of each is in the output.
    expect(checked).toBe(10);
    expect(lists.filter((l) => l.startsWith("ap")).length).toBe(6);
  });

  test("a bare run of items is wrapped by listTag, and the ordered list's start and reversed are kept (hand-made block)", async () => {
    const b = block(
      "cwicly/list",
      {
        classID: "list-r",
        listTag: "ol",
        listStart: "3",
        listReversed: true,
        content: "<li>One</li><li>Two</li>",
      },
      '<div class="list-r"><ol start="3" reversed><li>One</li><li>Two</li></ol></div>',
    );
    const { nodes } = await convertBlock("fineline", POST_195, b);
    const ol = el(kids(nodes[0])[0]);
    expect(ol.tagName).toBe("ol");
    expect(ol.attributes).toMatchObject({ start: "3" });
    expect(ol.attributes).toHaveProperty("reversed");
    expect(kids(ol).map((li) => el(li).tagName)).toEqual(["li", "li"]);
    // A list that is not ordered has neither.
    const ul = block("cwicly/list", { classID: "list-ul", listStart: "3", content: "<li>x</li>" });
    expect(el(kids((await convertBlock("fineline", POST_195, ul)).nodes[0])[0]).attributes).toBe(
      undefined,
    );
    const plain = block("cwicly/list", { classID: "list-u", content: "<li>One</li>" });
    expect(htmlOf((await convertBlock("fineline", POST_195, plain)).nodes)).toContain(
      "<ul><li>One</li></ul>",
    );
  });

  test("content that already starts with its list is not wrapped twice, and a list with no content stays empty", async () => {
    const own = block("cwicly/list", { classID: "list-w", content: "<ul><li>One</li></ul>" });
    expect(htmlOf((await convertBlock("fineline", POST_195, own)).nodes)).not.toContain("<ul><ul>");
    const none = block("cwicly/list", { classID: "list-e" });
    const run = await convertBlock("fineline", POST_195, none);
    expect(htmlOf(run.nodes)).not.toMatch(/<ul|<ol/);
  });

  test("a list in a Markdown entry stays structured", async () => {
    const subject: Subject = { kind: "post", id: 5260 };
    const b = await realBlock("fineline", subject, "list-c69ba8f");
    const { nodes } = await convertBlock("fineline", subject, b, { target: "markdown" });
    expect([...elements(nodes)].some((e) => e.innerHTML !== undefined)).toBe(false);
  });
});

describe("button", () => {
  test("a button that links is an anchor with its label", async () => {
    const b = await realBlock("fineline", HEADER, "button-c943e00");
    const { nodes } = await convertBlock("fineline", HEADER, b);
    const node = el(nodes[0]);
    expect(node.tagName).toBe("a");
    expect(node.textContent).toBe("Quote");
    expect(attrsOf(node)).toMatchObject({ href: "/quote/" });
  });

  test("a phone number is a tel: link, kept as it is", async () => {
    const b = await realBlock("fineline", HEADER, "button-c01e7f6");
    const { nodes } = await convertBlock("fineline", HEADER, b);
    expect(attrsOf(nodes[0])).toMatchObject({ href: "tel:7172286606" });
  });

  test("a button that links nowhere is a div; one that asks for a button tag is a button without a destination", async () => {
    const plain = await realBlock("fineline", POST_195, "button-ccd6000");
    expect(el((await convertBlock("fineline", POST_195, plain)).nodes[0]).tagName).toBe("div");
    const archive: Subject = { kind: "template", slug: "archive-project" };
    const pager = await realBlock("fineline", archive, "button-c7de396");
    const run = await convertBlock("fineline", archive, pager);
    expect(el(run.nodes[0]).tagName).toBe("button");
    expect(attrsOf(run.nodes[0])).not.toHaveProperty("href");
    expect(codesOf(run)).toContain("link.unsupported");
  });

  test("an icon in a button comes before the label unless the button says after", async () => {
    const subject: Subject = { kind: "part", slug: "comments" };
    const b = await realBlock("ap", subject, "button-reply");
    const { nodes } = await convertBlock("ap", subject, b);
    const html = htmlOf(nodes);
    expect(html.indexOf("<svg")).toBeGreaterThan(-1);
    // The icon and the label are one piece of markup: nothing is put between them.
    expect(html).toContain("</svg>reply</a>");
    const after = block(
      "cwicly/button",
      {
        classID: "b-after",
        content: "Next",
        buttonPosition: "after",
        buttonIconActive: true,
        buttonIcon: b.attrs.buttonIcon,
      },
      '<a class="b-after" href="/x/">Next</a>',
    );
    const out = await convertBlock("ap", subject, after);
    const afterHtml = htmlOf(out.nodes);
    expect(afterHtml.indexOf("Next")).toBeLessThan(afterHtml.indexOf("<svg"));
  });

  test("the icon of a block whose markup has none comes from its attribute, and only when the button shows one", async () => {
    const subject: Subject = { kind: "part", slug: "comments" };
    const reply = await realBlock("ap", subject, "button-reply");
    const withIcon = block(
      "cwicly/button",
      { classID: "b-i", content: "Go", buttonIconActive: true, buttonIcon: reply.attrs.buttonIcon },
      "",
    );
    const off = block(
      "cwicly/button",
      {
        classID: "b-n",
        content: "Go",
        buttonIconActive: false,
        buttonIcon: reply.attrs.buttonIcon,
      },
      "",
    );
    const run = await runFor("ap", subject);
    expect(htmlOf(run.ctx.convert([withIcon]))).toContain("<svg");
    expect(htmlOf(run.ctx.convert([off]))).not.toContain("<svg");
  });

  test("the SVG the page printed is kept even where the attribute says the icon is off (the page is the truth)", async () => {
    const b = block(
      "cwicly/button",
      {
        classID: "b-s",
        content: "Go",
        buttonIconActive: false,
        buttonIcon: { viewBox: "0 0 1 1", paths: [null, { d: "M9 9" }] },
      },
      '<a class="b-s" href="/x/"><svg viewBox="0 0 2 2"><path d="M1 1"></path></svg>Go</a>',
    );
    const run = await runFor("fineline", POST_195);
    const html = htmlOf(run.ctx.convert([b]));
    expect(html).toContain('<svg viewBox="0 0 2 2"><path d="M1 1"></path></svg>Go');
    expect(html).not.toContain("M9 9");
  });

  test("a button that is only an icon has no label", async () => {
    const subject: Subject = { kind: "part", slug: "comments" };
    const reply = await realBlock("ap", subject, "button-reply");
    const b = block(
      "cwicly/button",
      { classID: "b-o", buttonIconActive: true, buttonIcon: reply.attrs.buttonIcon },
      "",
    );
    const run = await runFor("ap", subject);
    const node = el(run.ctx.convert([b])[0]);
    expect(htmlOf([node])).toContain("<svg");
    expect(htmlOf([node])).not.toContain("</svg>reply");
  });

  test("an unlinked button in a Markdown entry has no innerHTML", async () => {
    const subject: Subject = { kind: "part", slug: "comments" };
    const reply = await realBlock("ap", subject, "button-reply");
    const run = await runFor("ap", subject, { target: "markdown" });
    const nodes = run.ctx.convert([reply]);
    expect([...elements(nodes)].some((e) => e.innerHTML !== undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1c. Icons and SVG
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("icon", () => {
  test("an icon is a box around the SVG the page printed", async () => {
    const subject: Subject = { kind: "post", id: 195 };
    const b = await findBlock("fineline", subject, (x) => x.name === "cwicly/icon");
    const { nodes } = await convertBlock("fineline", subject, b);
    const node = el(nodes[0]);
    expect(node.tagName).toBe("div");
    const svg = el(kids(node)[0]);
    expect(svg.tagName).toBe("svg");
    expect(svg.attributes).toMatchObject({
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 32 32",
    });
    // The path data is the page's, not the editor's preview (`fill="unset"`).
    expect(svg.innerHTML).toContain("<path d=");
    expect(svg.innerHTML).not.toContain("unset");
    expect(node.className?.split(" ")[0]).toBe(b.attrs.classID as string);
  });

  test("an icon that links is the anchor around the SVG", async () => {
    const subject: Subject = { kind: "part", slug: "mobile-menu" };
    const b = await realBlock("ap", subject, "icon-mobilemenu-instagram");
    const { nodes } = await convertBlock("ap", subject, b);
    expect(el(nodes[0]).tagName).toBe("a");
    expect(attrsOf(nodes[0]).href).toBe("https://www.instagram.com/anabaptist_perspectives/");
    expect(kids(nodes[0]).map((n) => el(n).tagName)).toEqual(["svg"]);
  });

  test("a modal's opener icon is a button, and the SVG stays inside", async () => {
    const b = await realBlock("ap", HEADER, "icon-toggle");
    const run = await convertBlock("ap", HEADER, b);
    const node = el(run.nodes[0]);
    expect(node.tagName).toBe("button");
    expect(node.attributes).toMatchObject({
      popovertarget: "modal-overlay-menu",
      popovertargetaction: "show",
      type: "button",
    });
    expect(kids(node).map((n) => el(n).tagName)).toEqual(["svg"]);
    expect(codesOf(run)).toContain("link.approximated");
  });

  test("an icon in a Markdown entry has its SVG as elements, never innerHTML", async () => {
    const subject: Subject = { kind: "post", id: 195 };
    const b = await findBlock("fineline", subject, (x) => x.name === "cwicly/icon");
    const { nodes } = await convertBlock("fineline", subject, b, { target: "markdown" });
    const svg = [...elements(nodes)].find((e) => e.tagName === "svg")!;
    expect(svg.innerHTML).toBeUndefined();
    expect(kids(svg).map((n) => el(n).tagName)).toEqual(["path"]);
    expect(attrsOf(kids(svg)[0])).toHaveProperty("d");
  });

  test("a block copied into a component keeps its attribute and loses its markup: the SVG is rebuilt from it", async () => {
    const real = await findBlock("fineline", POST_195, (x) => x.name === "cwicly/icon");
    const b = block("cwicly/icon", { classID: "icon-nomarkup", iconIcon: real.attrs.iconIcon }, "");
    const { nodes } = await convertBlock("fineline", POST_195, b);
    expect(htmlOf(nodes)).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M23 15',
    );
  });

  test("an icon's unicode (the SVG the editor kept) is the last resort", async () => {
    const b = block(
      "cwicly/icon",
      { classID: "icon-u", iconUnicode: '<svg viewBox="0 0 4 4"><circle r="2"></circle></svg>' },
      "",
    );
    const { nodes } = await convertBlock("fineline", POST_195, b);
    expect(htmlOf(nodes)).toContain('<svg viewBox="0 0 4 4"><circle r="2"></circle></svg>');
  });

  test("an icon with nothing to draw is an empty box", async () => {
    const { nodes } = await convertBlock(
      "fineline",
      POST_195,
      block("cwicly/icon", { classID: "icon-n" }, ""),
    );
    expect(el(nodes[0])).toMatchObject({ tagName: "div" });
    expect(el(nodes[0])).not.toHaveProperty("children");
    expect(el(nodes[0])).not.toHaveProperty("innerHTML");
  });

  test("a connected icon is the SVG markup the component's instance passes in", async () => {
    const subject: Subject = { kind: "component", ref: "82c1bb8740" };
    const b = await realBlock("ap", subject, "icon-cbbe342");
    const props = new Map([["oSxyV", "icon"]]);
    const { nodes } = await convertBlock("ap", subject, b, { props });
    expect(el(nodes[0]).innerHTML).toBe("${state.icon ?? ''}");
    expect(el(nodes[0]).className).toBe("icon-cbbe342 icon-large cc-icn");
    // Built into the component's instance the markup is an SVG.
    const comp = { tagName: "wp-ic", state: { icon: "" }, children: nodes };
    const site = await buildJxProject({
      "project.json": PROJECT(),
      "layouts/base.json": LAYOUT,
      "components/wp-ic.json": comp as ProjectFile,
      "pages/index.json": {
        $elements: [{ $ref: "../components/wp-ic.json" }],
        children: [
          {
            tagName: "wp-ic",
            $props: { icon: '<svg viewBox="0 0 1 1"><path d="M0 0"></path></svg>' },
          },
        ],
      },
    });
    expect(site.html("/")).toContain('<svg viewBox="0 0 1 1"><path d="M0 0"></path></svg>');
  });

  test("a connector the component does not have is reported and the icon is empty", async () => {
    const subject: Subject = { kind: "component", ref: "82c1bb8740" };
    const b = await realBlock("ap", subject, "icon-cbbe342");
    const run = await convertBlock("ap", subject, b, { props: new Map() });
    expect(el(run.nodes[0])).not.toHaveProperty("innerHTML");
    expect(reportsOf(run).find((e) => e.code === "block.icon-connector")?.severity).toBe("warn");
  });
});

describe("svg", () => {
  const svgSource =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></svg>';

  test("an inline SVG written into the block is a box around it (hand-made block)", async () => {
    const b = block(
      "cwicly/svg",
      { classID: "svg-i", svgType: "inline", inlineSvg: svgSource },
      '<div class="svg-i"></div>',
    );
    const { nodes } = await convertBlock("fineline", POST_195, b);
    expect(el(nodes[0]).tagName).toBe("div");
    expect(htmlOf(nodes)).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></svg>',
    );
  });

  test("a block whose saved element IS the svg gets its content from the saved tags, tokens resolved", async () => {
    const b = block(
      "cwicly/svg",
      { classID: "svg-r", svgType: "inline", inlineSvg: svgSource },
      '<svg class="svg-r" viewBox="{viewbox=inline}">{svginline}</svg>',
    );
    const { nodes } = await convertBlock("fineline", POST_195, b);
    const node = el(nodes[0]);
    expect(node.tagName).toBe("svg");
    expect(node.className).toBe("svg-r");
    expect(node.attributes).toMatchObject({ viewBox: "0 0 10 10" });
    expect(node.innerHTML).toBe('<circle cx="5" cy="5" r="4"></circle>');
  });

  test("an SVG file of the media library is an image, and the loss is said", async () => {
    const b = block(
      "cwicly/svg",
      {
        classID: "svg-f",
        svgType: "image",
        imageID: 785,
        imageURL: "https://finelinepainting.pro/wp-content/uploads/Fine-Line-Painting.svg",
      },
      '<div class="svg-f">{svg=785}</div>',
    );
    const run = await convertBlock("fineline", POST_195, b);
    const node = el(run.nodes[0]);
    expect(node.tagName).toBe("img");
    expect(node.attributes).toMatchObject({ src: "/media/Fine-Line-Painting.svg" });
    expect(reportsOf(run).find((e) => e.code === "block.svg-image")?.severity).toBe("info");
  });

  test("an SVG file shown as an image keeps its alt text and the size the media plan knows", async () => {
    const b = block(
      "cwicly/svg",
      { classID: "svg-fa", svgType: "image", imageID: 785 },
      '<div class="svg-fa">{svg=785}</div>',
    );
    const run = await convertBlock("fineline", POST_195, b, {
      mediaFor: () => ({ src: "/media/logo.svg", alt: "The logo", width: 120, height: 40 }),
    });
    const node = el(run.nodes[0]);
    expect(node.tagName).toBe("img");
    expect(node.attributes).toEqual({
      src: "/media/logo.svg",
      alt: "The logo",
      width: 120,
      height: 40,
    });
  });

  test("a block whose saved element is the svg keeps everything between the saved tags, whitespace and nesting included", async () => {
    const b = block(
      "cwicly/svg",
      { classID: "svg-r3", svgType: "inline", inlineSvg: svgSource },
      '<svg class="svg-r3" viewBox="0 0 4 4">\n<path d="M0 0h4"/>\n<g><circle r="1"/></g></svg>',
    );
    const { nodes } = await convertBlock("fineline", POST_195, b);
    const node = el(nodes[0]);
    expect(node.tagName).toBe("svg");
    expect(node.innerHTML).toBe('\n<path d="M0 0h4"/>\n<g><circle r="1"/></g>');
  });

  test("an icon-type svg block draws its icon", async () => {
    const real = await findBlock("fineline", POST_195, (x) => x.name === "cwicly/icon");
    const b = block(
      "cwicly/svg",
      { classID: "svg-ic", svgType: "icon", iconIcon: real.attrs.iconIcon },
      "",
    );
    const { nodes } = await convertBlock("fineline", POST_195, b);
    expect(htmlOf(nodes)).toContain('viewBox="0 0 32 32"');
  });

  test("an svg block with nothing in it is an empty box, and a hidden one is gone", async () => {
    const run = await runFor("fineline", POST_195);
    expect(el(run.ctx.convert([block("cwicly/svg", { classID: "svg-e" }, "")])[0])).toMatchObject({
      tagName: "div",
    });
    expect(
      run.ctx.convert([block("cwicly/svg", { classID: "svg-h", hideGuest: true }, "")]),
    ).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1d. Images
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("image", () => {
  test("an image is an img with the one original of its family, its alt and its size", async () => {
    const subject: Subject = { kind: "post", id: 1716 };
    const b = await realBlock("fineline", subject, "image-c6194e7");
    const { nodes } = await convertBlock("fineline", subject, b);
    const wrapper = el(nodes[0]);
    const img = el(kids(wrapper)[0]);
    expect(img.tagName).toBe("img");
    expect(img.attributes).toEqual({
      src: "/media/About-fine-line-painting-family-picture-1.png",
      alt: "",
      width: 1400,
      height: 1000,
    });
    expect(img.className).toBe("image-c6194e7 image-cover");
    // srcset and sizes are the Jx build's.
    expect(JSON.stringify(nodes)).not.toContain("srcset");
  });

  test("a lightbox is the link the page wraps around the image, to the file", async () => {
    const subject: Subject = { kind: "post", id: 1716 };
    const b = await realBlock("fineline", subject, "image-c6194e7");
    const { nodes } = await convertBlock("fineline", subject, b);
    expect(nodes).toHaveLength(1);
    expect(el(nodes[0])).toMatchObject({
      tagName: "a",
      className: "cc-lightbox",
      attributes: { href: "/media/About-fine-line-painting-family-picture-1.png" },
    });
  });

  test("the width and height are the size the saved tag names, not the original's (the live page prints medium_large's 768x599 where the file is 2560x1996)", async () => {
    const subject: Subject = { kind: "post", id: 5270 };
    const b = await realBlock("fineline", subject, "image-c0968a7");
    expect(b.attrs.imageThumbnailSize).toBe("medium_large");
    expect(b.innerHTML).toContain("{imagewidth=6531=medium_large}");
    const loaded = await loadSite("fineline");
    const medium = loaded.model.attachments
      .get(6531)!
      .sizes.find((s) => s.name === "medium_large")!;
    expect([medium.width, medium.height]).toEqual([768, 599]);
    const { nodes } = await convertBlock("fineline", subject, b);
    const img = el(nodes[0]);
    expect(img.attributes).toMatchObject({ width: 768, height: 599 });
    // The file is still the one original of its family: Jx regenerates the sizes.
    expect(String(attrsOf(img).src)).toMatch(/-scaled\.png$/);
    // An image edited in WordPress (a `-e<time>` file) names its own sizes.
    const edited = await realBlock("fineline", { kind: "post", id: 5282 }, "image-c0968a7");
    const e = el((await convertBlock("fineline", { kind: "post", id: 5282 }, edited)).nodes[0]);
    expect(e.attributes).toMatchObject({ width: 768, height: 507 });
  });

  test("a size the attachment does not have (or `full`) is the original's size; a block whose markup is gone follows imageThumbnailSize (hand-made blocks)", async () => {
    const loaded = await loadSite("fineline");
    const att = loaded.model.attachments.get(6531)!;
    const run = await runFor("fineline", POST_195);
    const make = (classID: string, size: string, attrs: Record<string, unknown> = {}) =>
      block(
        "cwicly/image",
        { classID, imageID: 6531, ...attrs },
        `<img class="${classID}" src="{imagesrc=6531${size}}" width="{imagewidth=6531${size}}" height="{imageheight=6531${size}}" alt=""/>`,
      );
    const dims = (b: WpBlock) => attrsOf(run.ctx.convert([b])[0]);
    expect(dims(make("i-full", "=full"))).toMatchObject({ width: att.width, height: att.height });
    expect(dims(make("i-none", ""))).toMatchObject({ width: att.width, height: att.height });
    expect(dims(make("i-gone", "=nosuchsize"))).toMatchObject({
      width: att.width,
      height: att.height,
    });
    expect(dims(make("i-large", "=large"))).toMatchObject({ width: 1024, height: 798 });
    expect(dims(make("i-thumb", "=thumbnail"))).toMatchObject({ width: 150, height: 117 });
    // The saved tag decides: a block whose attribute says medium_large but whose tag prints the full size is the full size.
    expect(dims(make("i-attr", "", { imageThumbnailSize: "medium_large" }))).toMatchObject({
      width: att.width,
    });
    // A tag that names another attachment (a stale id) says nothing about this file's sizes.
    const stale = block(
      "cwicly/image",
      { classID: "i-stale", imageID: 6531 },
      '<img class="i-stale" src="{imagesrc=1407=large}" width="{imagewidth=1407=large}" height="{imageheight=1407=large}" alt=""/>',
    );
    expect(dims(stale)).toMatchObject({ width: att.width, height: att.height });
    // No saved markup: the block's own size attribute stands in.
    const bare = block("cwicly/image", {
      classID: "i-bare",
      imageID: 6531,
      imageThumbnailSize: "medium_large",
    });
    expect(dims(bare)).toMatchObject({ width: 768, height: 599 });
  });

  test("the element is an img whatever tag the saved markup names (a block copied into a component keeps a div)", async () => {
    const run = await runFor("fineline", POST_195);
    for (const saved of ['<div class="image-ft"></div>', '<span class="image-ft"></span>', ""]) {
      const out = run.ctx.convert([
        block("cwicly/image", { classID: "image-ft", imageID: 1657 }, saved),
      ]);
      expect(el(out[0]).tagName).toBe("img");
    }
  });

  test("an image with no attachment id has neither width nor height, as the page printed it", async () => {
    const subject: Subject = { kind: "post", id: 195 };
    const b = await realBlock("fineline", subject, "image-cc23dbb");
    expect(b.attrs.imageID).toBeUndefined();
    const { nodes } = await convertBlock("fineline", subject, b);
    const img = el(nodes[0]);
    expect(img.attributes).toEqual({ src: expect.stringMatching(/^\/media\//), alt: "" });
  });

  test("an SVG has no size to give: the logo has neither width nor height", async () => {
    const b = await realBlock("fineline", HEADER, "image-cb08483");
    const { nodes } = await convertBlock("fineline", HEADER, b);
    expect(attrsOf(nodes[0])).toEqual({ src: "/media/Fine-Line-Painting.svg", alt: "" });
  });

  test("the loading hint is the block's: lazy, eager, or the Jx default", async () => {
    const base = {
      classID: "image-l",
      imageURL: "https://finelinepainting.pro/wp-content/uploads/swash.svg",
    };
    const run = await runFor("fineline", POST_195);
    const lazy = run.ctx.convert([
      block("cwicly/image", { ...base, lazyLoad: true }, '<img class="image-l"/>'),
    ]);
    const eager = run.ctx.convert([
      block("cwicly/image", { ...base, lazyLoad: false }, '<img class="image-l"/>'),
    ]);
    const none = run.ctx.convert([block("cwicly/image", base, '<img class="image-l"/>')]);
    expect(attrsOf(lazy[0]).loading).toBe("lazy");
    expect(attrsOf(eager[0]).loading).toBe("eager");
    expect(attrsOf(none[0])).not.toHaveProperty("loading");
  });

  test("an image the plan has no file for is left out, and the report says which", async () => {
    const b = block(
      "cwicly/image",
      { classID: "image-x", imageID: 99999999 },
      '<img class="image-x"/>',
    );
    const run = await convertBlock("fineline", POST_195, b);
    expect(run.nodes).toEqual([]);
    expect(reportsOf(run).find((e) => e.code === "dynamic.missing-image")?.severity).toBe("warn");
  });

  test("an image block that names no file prints an image with no source, in its place, and says so", async () => {
    const subject: Subject = { kind: "component", ref: "0a275b695a" };
    const b = await realBlock("fineline", subject, "image-cf6348e");
    const run = await convertBlock("fineline", subject, b);
    // what the live page prints for the icon card is `<img class="image-cf6348e …"/>`: no source, so
    // it shows nothing, but it is a box of the flex column and the row gap sits around it
    expect(run.nodes).toHaveLength(1);
    const img = el(run.nodes[0]);
    expect(img.tagName).toBe("img");
    expect(String(img.className)).toContain("image-cf6348e");
    expect(attrsOf(img)).toEqual({ alt: "" });
    expect(reportsOf(run).find((e) => e.code === "block.image-empty")).toMatchObject({
      severity: "info",
      data: { block: "cwicly/image", classID: "image-cf6348e" },
    });
  });

  test("an image of an entry is its featured image: the attribute disappears when the entry has none", async () => {
    const subject: Subject = { kind: "template", slug: "single-project" };
    const b = await findBlock(
      "fineline",
      subject,
      (x) => x.name === "cwicly/image" && x.attrs.imageType === "dynamic",
    );
    const { nodes } = await convertBlock("fineline", subject, b, {
      mode: "entry",
      entryType: "project",
    });
    const img = el(nodes[0]);
    expect(String(attrsOf(img).src)).toMatch(/^\$\{\(.*\) \|\| false\}$/);
    expect(String(attrsOf(img).alt)).toContain("state.entry.data");
  });

  test("a featured image the conversion knows is printed with the size WordPress prints (the saved tag has none)", async () => {
    const loaded = await loadSite("fineline");
    const b = await realBlock("fineline", { kind: "template", slug: "index" }, "image-c110644");
    expect(b.innerHTML).not.toContain("width=");
    const { nodes } = await convertBlock("fineline", { kind: "post", id: 1078 }, b);
    const thumbnail = Number(loaded.model.postMeta.get(1078)?._thumbnail_id?.[0]);
    const size = loaded.model.attachments
      .get(thumbnail)!
      .sizes.find((x) => x.name === "medium_large")!;
    expect(attrsOf(nodes[0])).toMatchObject({ width: size.width, height: size.height });
    // an entry's image is bound, so the entry's own data is all there is: no dimensions are written
    const bound = await convertBlock("fineline", { kind: "template", slug: "index" }, b, {
      mode: "entry",
      entryType: "project",
    });
    expect(attrsOf(bound.nodes[0])).not.toHaveProperty("width");
  });

  test("an image of a component is its property: the build leaves src out when the instance passes none", async () => {
    const b = block(
      "cwicly/image",
      { classID: "image-c", componentConnectors: { image: { ref: "imgP" } } },
      '<img class="image-c" src="{component=image=imgP}"/>',
    );
    const { nodes } = await convertBlock("fineline", { kind: "component", ref: "0a275b695a" }, b, {
      props: new Map([["imgP", "photo"]]),
    });
    expect(attrsOf(nodes[0])).toMatchObject({
      src: "${state.photo?.src || false}",
      alt: "${state.photo?.alt ?? ''}",
      // printed with the instance's own size, as the plugin prints it
      width: "${state.photo?.width || false}",
      height: "${state.photo?.height || false}",
      sizes: expect.stringContaining("auto, (max-width: "),
    });
    const site = await buildJxProject({
      "project.json": PROJECT(),
      "layouts/base.json": LAYOUT,
      "components/wp-im.json": {
        tagName: "wp-im",
        state: { photo: { src: "", alt: "" } },
        children: nodes,
      } as ProjectFile,
      "pages/index.json": {
        $elements: [{ $ref: "../components/wp-im.json" }],
        children: [{ tagName: "wp-im" }],
      },
    });
    expect(site.html("/")).not.toContain(" src=");
  });

  test("a hidden image is not converted at all", async () => {
    const b = block(
      "cwicly/image",
      {
        classID: "image-h",
        imageURL: "https://finelinepainting.pro/wp-content/uploads/swash.svg",
        hideGuest: true,
      },
      "",
    );
    expect((await convertBlock("fineline", POST_195, b)).nodes).toEqual([]);
  });

  test("an image in a Markdown entry is the same img", async () => {
    const subject: Subject = { kind: "post", id: 1716 };
    const b = await realBlock("fineline", subject, "image-c6194e7");
    const { nodes } = await convertBlock("fineline", subject, b, { target: "markdown" });
    const md = serializeJxMarkdown({ children: nodes } as never, { mode: "roundtrip" });
    expect(md).toContain(':img{className="image-c6194e7 image-cover"');
    expect(md).toContain("/media/About-fine-line-painting-family-picture-1.png");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1e. Video
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** The expression inside a whole-string binding. */
const exprOf = (binding: unknown): string => {
  const m = /^\$\{([\s\S]*)\}$/.exec(String(binding));
  if (!m) throw new Error(`not a binding: ${String(binding)}`);
  return m[1]!;
};

const evaluate = (expr: string, state: unknown): unknown =>
  (new Function("state", `return (${expr});`) as (s: unknown) => unknown)(state);

describe("video", () => {
  test("a YouTube video is the iframe the page printed in its cc-iframe-container, inside the cc-vid box", async () => {
    const subject: Subject = { kind: "post", id: 819 };
    const b = await realBlock("ap", subject, "video-c018567");
    const { nodes } = await convertBlock("ap", subject, b);
    const root = el(nodes[0]);
    expect(root.tagName).toBe("div");
    expect(root.className).toBe("video-c018567 cc-vid");
    // The box has an id (a target for the player's script), as an attribute: its style is scoped to the class.
    expect(root.attributes).toEqual({ id: "video-c78b8bf" });
    expect(root).not.toHaveProperty("id");
    const container = el(kids(root)[0]);
    expect(container.className).toBe("cc-iframe-container");
    const iframe = el(kids(container)[0]);
    expect(iframe.tagName).toBe("iframe");
    expect(iframe.attributes).toMatchObject({
      src: "https://www.youtube.com/embed/EWVXsq-gUQ4?modestbranding=0&enablejsapi=1",
      width: "560",
      height: "315",
    });
    // The plugin's poster placeholder is a script's, not content.
    expect(JSON.stringify(nodes)).not.toContain("ccdyn");
    expect(JSON.stringify(nodes)).not.toContain("cc-video-placeholder");
  });

  test("the player's size comes from the block's own rules (the ratio of its container)", async () => {
    const subject: Subject = { kind: "post", id: 819 };
    const b = await realBlock("ap", subject, "video-c018567");
    const { nodes } = await convertBlock("ap", subject, b);
    expect(el(nodes[0]).style).toMatchObject({
      maxWidth: "75%",
      "& .cc-iframe-container": { paddingTop: "56.25%" },
    });
  });

  test("the video builds: one iframe, the box's rule on its class", async () => {
    const subject: Subject = { kind: "post", id: 819 };
    const b = await realBlock("ap", subject, "video-c018567");
    const { nodes } = await convertBlock("ap", subject, b);
    const site = await buildPage(nodes);
    const html = site.html("/");
    expect(html.match(/<iframe/g)).toHaveLength(1);
    expect(html).toContain(".video-c018567 {");
    expect(html).toContain(
      'src="https://www.youtube.com/embed/EWVXsq-gUQ4?modestbranding=0&amp;enablejsapi=1"',
    );
  });

  test("a video without saved markup is built from the player options (hand-made block)", async () => {
    const run = await runFor("fineline", POST_195);
    const yt = run.ctx.convert([
      block("cwicly/video", {
        classID: "v-yt",
        videoStaticURL: "https://www.youtube.com/watch?v=abcDEF12345",
        videoStart: 5,
        videoEnd: 9,
        videoPrivacy: true,
        videoAutoplay: true,
        videoMute: true,
        videoLoop: true,
        videoControls: false,
        videoRelated: true,
        videoBranding: true,
      }),
    ]);
    const iframe = [...elements(yt)].find((e) => e.tagName === "iframe")!;
    expect(attrsOf(iframe).src).toBe(
      "https://www.youtube-nocookie.com/embed/abcDEF12345?modestbranding=1&start=5&end=9&autoplay=1&mute=1&loop=1&controls=0&rel=1",
    );
    const vm = run.ctx.convert([
      block("cwicly/video", {
        classID: "v-vm",
        videoStaticURL: "https://vimeo.com/123456789",
        videoStart: 7,
        videoAutoplay: true,
        videoMute: true,
        videoLoop: true,
        videoPrivacy: true,
      }),
    ]);
    const vimeo = [...elements(vm)].find((e) => e.tagName === "iframe")!;
    expect(attrsOf(vimeo).src).toBe(
      "https://player.vimeo.com/video/123456789?transparent=1&#t=7&autoplay=true&muted=1&loop=1&dnt=1",
    );
    expect(attrsOf(iframe).allow).toContain("picture-in-picture");
  });

  test("a video file is a video element with the player's flags", async () => {
    const run = await runFor("fineline", POST_195);
    const out = run.ctx.convert([
      block("cwicly/video", {
        classID: "v-f",
        videoStaticURL: "https://finelinepainting.pro/wp-content/uploads/clip.mp4",
        videoAutoplay: true,
        videoLoop: true,
        videoMute: true,
      }),
    ]);
    const video = [...elements(out)].find((e) => e.tagName === "video")!;
    expect(video.attributes).toMatchObject({
      autoplay: "",
      loop: "",
      muted: "",
      controls: "",
      controlslist: "nodownload",
      playsinline: "",
    });
    expect(String(attrsOf(video).src)).toContain("clip.mp4");
    const noControls = run.ctx.convert([
      block("cwicly/video", {
        classID: "v-f2",
        videoStaticURL: "https://example.com/a.webm",
        videoControls: false,
      }),
    ]);
    expect(
      [...elements(noControls)].find((e) => e.tagName === "video")!.attributes,
    ).not.toHaveProperty("controls");
  });

  test("the cover image is a script's: the player is shown, and the loss is said", async () => {
    const run = await runFor("fineline", POST_195);
    run.ctx.convert([
      block("cwicly/video", {
        classID: "v-o",
        videoImageOverlay: true,
        videoStaticURL: "https://www.youtube.com/watch?v=abcDEF12345",
      }),
    ]);
    expect(codesOf(run)).toContain("block.video-overlay");
  });

  test("a video with no address is an empty box and is reported", async () => {
    const run = await runFor("fineline", POST_195);
    const out = run.ctx.convert([block("cwicly/video", { classID: "v-n", videoStaticURL: "" })]);
    expect(el(out[0])).toMatchObject({ tagName: "div" });
    expect(el(out[0])).not.toHaveProperty("children");
    expect(codesOf(run)).toContain("block.video-unresolved");
    const dyn = run.ctx.convert([block("cwicly/video", { classID: "v-d", videoType: "dynamic" })]);
    expect(el(dyn[0])).not.toHaveProperty("children");
    expect(reportsOf(run).filter((e) => e.code === "block.video-unresolved")).toHaveLength(2);
  });

  test("the video of an ACF field of the post is built from the field's value now", async () => {
    const loaded = await loadSite("fineline");
    const postMeta = new Map(loaded.model.postMeta);
    postMeta.set(3371, {
      ...postMeta.get(3371),
      cta_button_1_link: ["https://youtu.be/QWERTY12345"],
    });
    const subject: Subject = { kind: "post", id: 3371 };
    const run = await runFor("fineline", subject, { model: { ...loaded.model, postMeta } });
    const out = run.ctx.convert([
      block("cwicly/video", {
        classID: "v-a",
        videoType: "dynamic",
        videoDynamicType: "acf",
        videoDynamicAcfGroup: "g",
        videoDynamicAcfField: "field_66a3e112965de",
      }),
    ]);
    const iframe = [...elements(out)].find((e) => e.tagName === "iframe")!;
    expect(attrsOf(iframe).src).toBe("https://www.youtube.com/embed/QWERTY12345?modestbranding=0");
    // A field that holds an address of the site (a file) is a video element.
    const file = await runFor("fineline", subject);
    const fileOut = file.ctx.convert([
      block("cwicly/video", {
        classID: "v-a2",
        videoType: "dynamic",
        videoDynamicType: "acf",
        videoDynamicAcfGroup: "g",
        videoDynamicAcfField: "field_66a3e112965de",
      }),
    ]);
    expect([...elements(fileOut)].some((e) => e.tagName === "video")).toBe(true);
  });

  test("an empty ACF field leaves an empty box", async () => {
    const subject: Subject = { kind: "post", id: 195 };
    const run = await runFor("fineline", subject);
    const out = run.ctx.convert([
      block("cwicly/video", {
        classID: "v-e",
        videoType: "dynamic",
        videoDynamicType: "acf",
        videoDynamicAcfGroup: "g",
        videoDynamicAcfField: "field_66a3e112965de",
      }),
    ]);
    expect(el(out[0])).not.toHaveProperty("children");
    expect(codesOf(run)).toContain("block.video-unresolved");
  });

  test("in an entry the embed address is an expression over the field, and it means what the static rule means", async () => {
    const subject: Subject = { kind: "template", slug: "single-project" };
    const run = await runFor("fineline", subject, { mode: "entry", entryType: "project" });
    const out = run.ctx.convert([
      block("cwicly/video", {
        classID: "v-x",
        videoType: "dynamic",
        videoDynamicType: "acf",
        videoDynamicAcfGroup: "g",
        videoDynamicAcfField: "field_66a3e112965de",
        videoStart: 5,
      }),
    ]);
    const iframe = [...elements(out)].find((e) => e.tagName === "iframe")!;
    const expr = exprOf(attrsOf(iframe).src);
    const at = (value: unknown): unknown =>
      evaluate(expr, { entry: { data: { cta_button_1_link: value } } });
    expect(at("https://www.youtube.com/watch?v=abcDEF12345")).toBe(
      "https://www.youtube.com/embed/abcDEF12345?modestbranding=0&start=5",
    );
    expect(at("https://youtu.be/abcDEF12345")).toBe(
      "https://www.youtube.com/embed/abcDEF12345?modestbranding=0&start=5",
    );
    expect(at("https://vimeo.com/123456789")).toBe(
      "https://player.vimeo.com/video/123456789?transparent=1&#t=5",
    );
    // A file is not an embed: the iframe has no address (the video element below it is shown for a file, see the next test).
    expect(at("https://example.com/v.mp4")).toBe(false);
    // No value: the attribute is left out (false), not an iframe with an empty src.
    expect(at("")).toBe(false);
    expect(at(undefined)).toBe(false);
  });

  /** The entry-mode video of a dynamic ACF field, converted in the single-project template. */
  async function entryVideo(extra: Record<string, unknown> = {}): Promise<JxNode[]> {
    const run = await runFor(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryType: "project" },
    );
    return run.ctx.convert([
      block("cwicly/video", {
        classID: "v-ev",
        videoType: "dynamic",
        videoDynamicType: "acf",
        videoDynamicAcfGroup: "g",
        videoDynamicAcfField: "field_66a3e112965de",
        ...extra,
      }),
    ]);
  }

  test("in an entry a self-hosted file is a video element, as the plugin's cc_video_final_maker prints it: the embed is hidden and the video is shown, and the other way round for a YouTube or Vimeo address", async () => {
    const out = await entryVideo({ videoAutoplay: true, videoLoop: true, videoMute: true });
    const root = el(out[0]);
    const container = kids(root)
      .map(el)
      .find((e) => e.className === "cc-iframe-container")!;
    const iframe = el(kids(container)[0]);
    const video = kids(root)
      .map(el)
      .find((e) => e.tagName === "video")!;
    expect(video).toBeDefined();
    // The static flags the plugin writes for a file: autoplay, loop and muted when set, no controls unless the block asks for them.
    expect(video.attributes).toMatchObject({
      autoplay: true,
      loop: true,
      muted: true,
      controlslist: "nodownload",
      playsinline: true,
    });
    expect(video.attributes).not.toHaveProperty("controls");
    const evalOf = (binding: unknown, value: unknown): unknown =>
      evaluate(exprOf(binding), { entry: { data: { cta_button_1_link: value } } });
    const shown = (value: unknown) => ({
      iframeSrc: evalOf(attrsOf(iframe).src, value),
      containerHidden: evalOf(attrsOf(container).hidden, value),
      videoSrc: evalOf(attrsOf(video).src, value),
      videoHidden: evalOf(attrsOf(video).hidden, value),
    });
    expect(shown("https://example.com/v.mp4")).toEqual({
      iframeSrc: false,
      containerHidden: true,
      videoSrc: "https://example.com/v.mp4",
      videoHidden: false,
    });
    expect(shown("https://youtu.be/abcDEF12345")).toMatchObject({
      iframeSrc:
        "https://www.youtube.com/embed/abcDEF12345?modestbranding=0&autoplay=1&mute=1&loop=1",
      containerHidden: false,
      videoSrc: false,
      videoHidden: true,
    });
    expect(shown("https://vimeo.com/123456789")).toMatchObject({
      containerHidden: false,
      videoSrc: false,
      videoHidden: true,
    });
    // No value: neither is shown.
    expect(shown("")).toEqual({
      iframeSrc: false,
      containerHidden: true,
      videoSrc: false,
      videoHidden: true,
    });
    expect(shown(undefined)).toMatchObject({ containerHidden: true, videoHidden: true });
  });

  test("the plugin's dynamic branch always prints www.youtube.com (the privacy flag only reaches Vimeo's dnt), and shows controls only when the block asks for them", async () => {
    const out = await entryVideo({ videoPrivacy: true, videoControls: true });
    const root = el(out[0]);
    const iframe = [...elements([root])].find((e) => e.tagName === "iframe")!;
    const video = [...elements([root])].find((e) => e.tagName === "video")!;
    const at = (binding: unknown, value: unknown): unknown =>
      evaluate(exprOf(binding), { entry: { data: { cta_button_1_link: value } } });
    expect(at(attrsOf(iframe).src, "https://youtu.be/abcDEF12345")).toBe(
      "https://www.youtube.com/embed/abcDEF12345?modestbranding=0",
    );
    expect(at(attrsOf(iframe).src, "https://vimeo.com/123456789")).toBe(
      "https://player.vimeo.com/video/123456789?transparent=1&dnt=1",
    );
    expect(video.attributes).toMatchObject({ controls: true });
    // The same, for a value that is known now (a field of the post).
    const loaded = await loadSite("fineline");
    const postMeta = new Map(loaded.model.postMeta);
    postMeta.set(3371, {
      ...postMeta.get(3371),
      cta_button_1_link: ["https://youtu.be/QWERTY12345"],
    });
    const run = await runFor(
      "fineline",
      { kind: "post", id: 3371 },
      { model: { ...loaded.model, postMeta } },
    );
    const now = run.ctx.convert([
      block("cwicly/video", {
        classID: "v-pn",
        videoType: "dynamic",
        videoDynamicType: "acf",
        videoDynamicAcfGroup: "g",
        videoDynamicAcfField: "field_66a3e112965de",
        videoPrivacy: true,
      }),
    ]);
    expect(attrsOf([...elements(now)].find((e) => e.tagName === "iframe")).src).toBe(
      "https://www.youtube.com/embed/QWERTY12345?modestbranding=0",
    );
  });

  test("an entry's video builds as the iframe for a YouTube address, the video element for a file, and neither for no value", async () => {
    const out = await entryVideo();
    const entry = (name: string, link: string): string =>
      `---\ntitle: "T"\nslug: "${name}"\ncta_button_1_link: ${JSON.stringify(link)}\n---\n\nbody\n`;
    const site = await buildJxProject({
      "project.json": PROJECT({
        extensions: ["@jxsuite/parser"],
        content: {
          items: {
            source: "content/items",
            format: "Markdown",
            schema: {
              type: "object",
              properties: { title: { type: "string" }, slug: { type: "string" } },
              required: ["title"],
            },
          },
        },
      }),
      "layouts/base.json": LAYOUT,
      "content/items/yt.md": entry("yt", "https://youtu.be/QWERTY12345"),
      "content/items/file.md": entry("file", "https://example.com/clip.mp4"),
      "content/items/none.md": entry("none", ""),
      "pages/e/[slug].json": {
        $paths: { contentType: "items", param: "slug", field: "slug" },
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
        children: out,
      },
    });
    const yt = site.html("/e/yt/");
    expect(yt).toContain('src="https://www.youtube.com/embed/QWERTY12345?modestbranding=0"');
    expect(yt).toMatch(/<video[^>]* hidden/);
    expect(yt).not.toMatch(/<div class="cc-iframe-container"[^>]* hidden/);
    const file = site.html("/e/file/");
    expect(file).toMatch(/<video[^>]* src="https:\/\/example.com\/clip.mp4"/);
    expect(file).not.toMatch(/<video[^>]* hidden/);
    expect(file).toMatch(/<div class="cc-iframe-container"[^>]* hidden/);
    expect(file).not.toMatch(/<iframe[^>]* src=/);
    const none = site.html("/e/none/");
    expect(none).toMatch(/<video[^>]* hidden/);
    expect(none).toMatch(/<div class="cc-iframe-container"[^>]* hidden/);
    expect(none).not.toMatch(/<video[^>]* src=/);
  });

  test("an entry's video builds with the embed address of its field, and without an iframe src when it has none", async () => {
    const subject: Subject = { kind: "template", slug: "single-project" };
    const run = await runFor("fineline", subject, { mode: "entry", entryType: "project" });
    const out = run.ctx.convert([
      block("cwicly/video", {
        classID: "v-b",
        videoType: "dynamic",
        videoDynamicType: "acf",
        videoDynamicAcfGroup: "g",
        videoDynamicAcfField: "field_66a3e112965de",
      }),
    ]);
    const entry = (link: string): string =>
      `---\ntitle: "T"\nslug: "t"\ncta_button_1_link: ${JSON.stringify(link)}\n---\n\nbody\n`;
    const site = await buildJxProject({
      "project.json": PROJECT({
        extensions: ["@jxsuite/parser"],
        content: {
          items: {
            source: "content/items",
            format: "Markdown",
            schema: {
              type: "object",
              properties: { title: { type: "string" }, slug: { type: "string" } },
              required: ["title"],
            },
          },
        },
      }),
      "layouts/base.json": LAYOUT,
      "content/items/yes.md": entry("https://youtu.be/QWERTY12345").replace(
        'slug: "t"',
        'slug: "yes"',
      ),
      "content/items/no.md": entry("").replace('slug: "t"', 'slug: "no"'),
      "pages/e/[slug].json": {
        $paths: { contentType: "items", param: "slug", field: "slug" },
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
        children: out,
      },
    });
    expect(site.html("/e/yes/")).toContain(
      'src="https://www.youtube.com/embed/QWERTY12345?modestbranding=0"',
    );
    expect(site.html("/e/no/")).toContain("<iframe");
    expect(site.html("/e/no/")).not.toMatch(/<iframe[^>]* src=/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1f. Gallery
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("gallery", () => {
  test("a gallery keeps the structure the plugin's stylesheets target: grid box, cc-gallery, one figure per image", async () => {
    const subject: Subject = { kind: "post", id: 1669 };
    const b = await realBlock("fineline", subject, "gallery-c29cbd8");
    const { nodes } = await convertBlock("fineline", subject, b);
    const root = el(nodes[0]);
    expect(root.tagName).toBe("div");
    // A project entry is Markdown: the grid rule that cannot stay on the element is the project's, and the second class makes its selector this entry's.
    expect(root.className).toMatch(/^gallery-c29cbd8 jx-[0-9a-f]{10} gallery-default cc-grid$/);
    expect(root.attributes).toEqual({ "data-ccgallery": "" });
    expect(kids(root)).toHaveLength(1);
    const grid = el(kids(root)[0]);
    expect(grid.className).toBe("cc-gallery");
    const figures = kids(grid).map(el);
    expect(figures).toHaveLength(2);
    for (const f of figures) {
      expect(f.tagName).toBe("figure");
      expect(f.className).toMatch(/(^| )cc-gallery-card gallery-1$/);
      expect(f.attributes).toEqual({ "data-ccgalleryname": "gallery-1" });
    }
  });

  test("the images are the media plan's originals, in the order of the saved markup", async () => {
    const subject: Subject = { kind: "post", id: 1669 };
    const b = await realBlock("fineline", subject, "gallery-c29cbd8");
    const ids = [...b.innerHTML.matchAll(/src="\{image=(\d+)\}"/g)].map((m) => Number(m[1]));
    expect(ids).toEqual([1657, 1658]);
    const loaded = await loadSite("fineline");
    const { nodes } = await convertBlock("fineline", subject, b);
    const imgs = [...elements(nodes)].filter((e) => e.tagName === "img");
    expect(imgs.map((i) => attrsOf(i).src)).toEqual(
      ids.map((id) => loaded.media.mediaFor(id)!.src),
    );
    for (const img of imgs) {
      expect(img.attributes).toHaveProperty("alt");
      expect(img.attributes).toHaveProperty("width");
      expect(img.attributes).not.toHaveProperty("srcset");
    }
  });

  test("without a lightbox each image sits in a plain box; with one it is a link to its file", async () => {
    const plainSubject: Subject = { kind: "post", id: 1669 };
    const plain = await convertBlock(
      "fineline",
      plainSubject,
      await realBlock("fineline", plainSubject, "gallery-c29cbd8"),
    );
    expect([...elements(plain.nodes)].filter((e) => e.tagName === "a")).toHaveLength(0);
    expect(
      [...elements(plain.nodes)].filter((e) => e.className === "cc-gallery-lightbox"),
    ).toHaveLength(2);

    const lightSubject: Subject = { kind: "post", id: 1528 };
    const b = await realBlock("fineline", lightSubject, "gallery-c6ec93c");
    const light = await convertBlock("fineline", lightSubject, b);
    const links = [...elements(light.nodes)].filter((e) => e.tagName === "a");
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.className).toBe("cc-lightbox cc-gallery-lightbox");
      const img = [...elements([a])].find((e) => e.tagName === "img")!;
      expect(attrsOf(a).href).toBe(attrsOf(img).src);
      expect(attrsOf(a)["data-gallery"]).toBe(b.attrs.id as string);
    }
    expect(codesOf(light)).toContain("link.approximated");
  });

  test("the images' inline styles are rules scoped to their own classes, never to every figure of the site", async () => {
    const subject: Subject = { kind: "post", id: 1669 };
    const { nodes } = await convertBlock(
      "fineline",
      subject,
      await realBlock("fineline", subject, "gallery-c29cbd8"),
    );
    const site = await buildPage(nodes);
    const html = site.html("/");
    expect(html).not.toMatch(/(^|\n)\.cc-gallery-card\s*\{/);
    expect(html).toMatch(/\.jx-[0-9a-f]{10}\s*\{\s*position: relative/);
    expect(html.match(/<figure/g)).toHaveLength(2);
    expect(html.match(/<img/g)).toHaveLength(2);
  });

  test("the grid's own rule is the block's (`.gallery-… .cc-gallery`): a nested rule of a page, a rule of the project in a Markdown entry", async () => {
    const subject: Subject = { kind: "post", id: 1669 };
    const b = await realBlock("fineline", subject, "gallery-c29cbd8");
    const page = await convertBlock("fineline", subject, b, { target: "page" });
    expect(el(page.nodes[0]).style).toMatchObject({
      "& .cc-gallery": { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" },
    });
    expect(page.hoisted).toEqual([]);
    const entry = await convertBlock("fineline", subject, b, { target: "markdown" });
    expect(Object.keys(el(entry.nodes[0]).style ?? {})).not.toContain("& .cc-gallery");
    const mark = (el(entry.nodes[0]).className ?? "").split(" ")[1];
    expect(mark).toMatch(/^jx-[0-9a-f]{10}$/);
    expect(
      entry.hoisted.find((h) => h.selector === `.gallery-c29cbd8:where(.${mark}) .cc-gallery`)
        ?.style,
    ).toMatchObject({
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
      columnGap: "10px",
      rowGap: "10px",
    });
  });

  test("a lightbox link holds the image's address exactly: an ampersand or a quote in a file name is escaped in the markup and comes back as itself", async () => {
    const odd = '/media/A & B "c" <d>\'s.jpg';
    const b = block(
      "cwicly/gallery",
      {
        classID: "gallery-esc",
        linkWrapperActive: true,
        linkWrapperType: "lightbox",
        galleries: [{ images: [1657] }],
      },
      "",
    );
    const run = await convertBlock("fineline", POST_195, b, {
      mediaFor: () => ({ src: odd, alt: 'Alt "text" & more', width: 10, height: 8 }),
    });
    const anchor = [...elements(run.nodes)].find((e) => e.tagName === "a")!;
    expect(attrsOf(anchor).href).toBe(odd);
    const img = [...elements(run.nodes)].find((e) => e.tagName === "img")!;
    expect(attrsOf(img).src).toBe(odd);
    expect(attrsOf(img).alt).toBe('Alt "text" & more');
  });

  test("a masonry gallery's packing is a script's, and the loss is reported (fineline's one masonry gallery, and a block whose saved root says so)", async () => {
    const subject: Subject = { kind: "post", id: 3871 };
    const b = await realBlock("fineline", subject, "gallery-c9af172");
    const run = await convertBlock("fineline", subject, b);
    expect(reportsOf(run).find((e) => e.code === "block.gallery-masonry")).toMatchObject({
      severity: "info",
      data: { classID: "gallery-c9af172" },
    });
    const saved = block(
      "cwicly/gallery",
      { classID: "gallery-m2" },
      '<div class="gallery-m2 cc-masonry" data-ccgallerymason="masonry" data-ccgallery=""></div>',
    );
    expect(codesOf(await convertBlock("fineline", POST_195, saved))).toContain(
      "block.gallery-masonry",
    );
    // A grid gallery is not reported.
    const grid = await realBlock("fineline", { kind: "post", id: 1669 }, "gallery-c29cbd8");
    expect(codesOf(await convertBlock("fineline", { kind: "post", id: 1669 }, grid))).not.toContain(
      "block.gallery-masonry",
    );
  });

  test("a masonry gallery with no saved markup does not crop its images (hand-made block)", async () => {
    const masonry = block("cwicly/gallery", {
      classID: "gallery-m3",
      galleryType: "masonry",
      galleries: [{ images: [1657] }],
    });
    const run = await convertBlock("fineline", POST_195, masonry);
    const img = [...elements(run.nodes)].find((e) => e.tagName === "img")!;
    expect(img.style).toEqual({ width: "100%", height: "100%" });
    expect(el(run.nodes[0]).className).toContain("cc-masonry");
    // A grid gallery covers its cell.
    const grid = block("cwicly/gallery", {
      classID: "gallery-m4",
      galleries: [{ images: [1657] }],
    });
    const gridImg = [...elements((await convertBlock("fineline", POST_195, grid)).nodes)].find(
      (e) => e.tagName === "img",
    )!;
    expect(gridImg.style).toEqual({ width: "100%", height: "100%", objectFit: "cover" });
  });

  test("a gallery in a Markdown entry has no innerHTML", async () => {
    const subject: Subject = { kind: "post", id: 1528 };
    const { nodes } = await convertBlock(
      "fineline",
      subject,
      await realBlock("fineline", subject, "gallery-c6ec93c"),
      { target: "markdown" },
    );
    expect([...elements(nodes)].some((e) => e.innerHTML !== undefined)).toBe(false);
    expect([...elements(nodes)].filter((e) => e.tagName === "figure")).toHaveLength(2);
  });

  test("a gallery that belongs to the entry is one expression over its images, in a cc-gallery box", async () => {
    const subject: Subject = { kind: "template", slug: "single-project" };
    const b = await realBlock("fineline", subject, "gallery-cea09b2");
    const { nodes } = await convertBlock("fineline", subject, b, {
      mode: "entry",
      entryType: "project",
    });
    const grid = el(kids(nodes[0])[0]);
    expect(grid.className).toBe("cc-gallery");
    expect(grid).not.toHaveProperty("children");
    const expr = exprOf(grid.innerHTML);
    const rows = [
      { src: "/media/a.jpg", alt: 'A "quoted" & <b>', width: 100, height: 50 },
      { src: "/media/b.jpg", alt: "B" },
    ];
    const out = evaluate(expr, { entry: { data: { gallery: rows } } }) as string;
    expect(out.match(/<figure/g)).toHaveLength(2);
    expect(out).toContain('<a class="cc-lightbox cc-gallery-lightbox" href="/media/a.jpg"');
    expect(out).toContain('alt="A &quot;quoted&quot; &amp; &lt;b&gt;"');
    expect(out).toContain('width="100" height="50"');
    expect(evaluate(expr, { entry: { data: {} } })).toBe("");
  });

  test("a gallery whose source is not carried over is an empty grid, and the report says which", async () => {
    const b = block(
      "cwicly/gallery",
      {
        classID: "gallery-p",
        id: "gallery-p",
        galleryDynamic: "dynamic",
        galleryDynamicType: "wordpress",
      },
      '<div class="gallery-p cc-grid"></div>',
    );
    const run = await convertBlock("fineline", POST_195, b);
    const grid = el(kids(run.nodes[0])[0]);
    expect(grid.className).toBe("cc-gallery");
    expect(kids(grid)).toEqual([]);
    expect(reportsOf(run).find((e) => e.code === "dynamic.unsupported")?.severity).toBe("warn");
  });

  test("filter buttons and captions are a script's, and the loss is said", async () => {
    const b = block(
      "cwicly/gallery",
      {
        classID: "gallery-f",
        id: "gallery-f",
        galleryFilter: true,
        galleries: [{ images: [1657], titles: ["A title"], descriptions: [] }],
      },
      '<div class="gallery-f cc-grid"><div class="cc-gallery"><figure><img src="{image=1657}"/></figure></div></div>',
    );
    const run = await convertBlock("fineline", POST_195, b);
    expect(codesOf(run)).toContain("block.gallery-filter");
    expect(codesOf(run)).toContain("block.gallery-captions");
  });

  test("an image the plan has no file for is left out of the grid and reported", async () => {
    const b = block(
      "cwicly/gallery",
      { classID: "gallery-m", id: "gallery-m" },
      '<div class="gallery-m cc-grid"><div class="cc-gallery"><figure><div><div class="cc-gallery-lightbox"><img src="{image=99999999}"/></div></div></figure></div></div>',
    );
    const run = await convertBlock("fineline", POST_195, b);
    expect([...elements(run.nodes)].filter((e) => e.tagName === "figure")).toHaveLength(0);
    expect(codesOf(run)).toContain("dynamic.missing-image");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1g. Code, hooks, fragments, the entry body, maps
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("code", () => {
  test("a code block with no PHP is its HTML, with its stylesheet's rules kept", async () => {
    const subject: Subject = { kind: "part", slug: "header" };
    const b = await findBlock("ap", subject, (x) => x.name === "cwicly/code");
    const run = await convertBlock("ap", subject, b);
    const root = el(run.nodes[0]);
    expect(root.className).toBe("ap-campaign-bar");
    const link = el(kids(root)[0]);
    expect(link.tagName).toBe("a");
    expect(attrsOf(link).href).toBe(
      "https://secure.lglforms.com/form_engine/s/6OEY4EH6_5N1JA8-s8lHtw",
    );
    expect(codesOf(run)).not.toContain("block.unsupported");
    // The <style> the code holds is an element with its text kept raw.
    const style = [...elements(run.nodes)].find((e) => e.tagName === "style")!;
    expect(String(style.innerHTML ?? style.textContent)).toContain(
      ".ap-campaign-bar{background:#822525",
    );
  });

  test("PHP in the code is not run: the saved output stays, and the loss is said", async () => {
    const b = block("cwicly/code", {
      code: "<p>Hi</p><?php echo date('Y'); ?>",
      codeRender: "<p>Hi</p>2026",
    });
    const run = await convertBlock("fineline", POST_195, b);
    expect(htmlOf(run.nodes)).toBe("<p>Hi</p>2026");
    const entry = reportsOf(run).find((e) => e.code === "block.unsupported");
    expect(entry).toMatchObject({ severity: "warn", where: "post:195", data: { feature: "php" } });
    expect(String(entry?.data?.excerpt)).toContain("<?php echo date");
  });

  test("PHP with no saved output leaves nothing, and says so", async () => {
    const run = await convertBlock(
      "fineline",
      POST_195,
      block("cwicly/code", { code: "<?php echo 1; ?>" }),
    );
    expect(run.nodes).toEqual([]);
    expect(reportsOf(run).find((e) => e.code === "block.unsupported")?.message).toContain(
      "no rendered output",
    );
  });

  test("the code is its own HTML when it holds no PHP and nothing was rendered", async () => {
    const run = await convertBlock(
      "fineline",
      POST_195,
      block("cwicly/code", { code: '<div class="x">y</div>' }),
    );
    expect(htmlOf(run.nodes)).toBe('<div class="x">y</div>');
  });

  test("the code's stylesheet is hoisted rule by rule, and its JavaScript is reported", async () => {
    const b = block("cwicly/code", {
      classID: "code-1",
      code: "<p>x</p>",
      codeRender: "<p>x</p>",
      codeCSS:
        ".foo{color:red}\n.foo:hover{color:blue}\n@keyframes k{from{opacity:0}to{opacity:1}}\nbody .bar{margin:0}",
      codeJS: "document.title = 'x'",
    });
    const run = await convertBlock("fineline", POST_195, b);
    expect(run.hoisted.map((h) => h.selector).sort()).toEqual([
      ".foo",
      "@keyframes k",
      "body .bar",
    ]);
    expect(run.hoisted.find((h) => h.selector === ".foo")?.style).toMatchObject({
      color: "red",
      ":hover": { color: "blue" },
    });
    expect(reportsOf(run).find((e) => e.code === "block.code-js")).toMatchObject({
      severity: "warn",
      data: { excerpt: "document.title = 'x'" },
    });
    expect(reportsOf(run).find((e) => e.code === "block.code-css")?.severity).toBe("info");
  });

  test("a statement at-rule (@import) cannot be hoisted as a rule with no body: it is reported and not hoisted, and an @media the author wrote is kept without a report", async () => {
    const b = block("cwicly/code", {
      classID: "code-i",
      code: "<p>x</p>",
      codeCSS:
        '@import url("https://fonts.googleapis.com/css2?family=Lato"); .code-i p{color:red} @media (min-width: 1000px){.code-i p{color:blue}}',
    });
    const run = await convertBlock("fineline", POST_195, b);
    // Nothing is hoisted with an empty style (a build would drop it while the report said the sheet was kept).
    expect(run.hoisted.filter((h) => Object.keys(h.style).length === 0)).toEqual([]);
    expect(run.hoisted.map((h) => h.selector)).not.toContain(
      '@import url("https://fonts.googleapis.com/css2?family=Lato")',
    );
    const statement = reportsOf(run).find((e) => e.code === "block.code-css-statement");
    expect(statement).toMatchObject({
      severity: "warn",
      data: { rule: '@import url("https://fonts.googleapis.com/css2?family=Lato")' },
    });
    // The author's query is a valid query, not an artifact of Cwicly's generator, and its rule is kept.
    expect(codesOf(run)).not.toContain("css.artifact");
    const rule = run.hoisted.find((h) => h.selector === ".code-i")!;
    expect(rule.style).toMatchObject({
      "& p": { color: "red" },
      "@(min-width: 1000px)": { "& p": { color: "blue" } },
    });
    // The statement is the only thing lost, and a block at-rule is still hoisted.
    const font = block("cwicly/code", {
      classID: "code-f",
      code: "<p>x</p>",
      codeCSS: "@font-face{font-family:A;src:url(a.woff2)}",
    });
    const fontRun = await convertBlock("fineline", POST_195, font);
    expect(fontRun.hoisted.map((h) => h.selector)).toEqual(["@font-face"]);
    expect(codesOf(fontRun)).not.toContain("block.code-css-statement");
  });

  test("css the reader cannot read is reported as an artifact", async () => {
    const run = await convertBlock(
      "fineline",
      POST_195,
      block("cwicly/code", { classID: "code-a", code: "<p>x</p>", codeCSS: ".undefined{}" }),
    );
    expect(codesOf(run)).toContain("css.artifact");
  });

  test("a code block that is hidden for some visitors is a box with the hide; one that is hidden for all is gone", async () => {
    const hidden = block("cwicly/code", { classID: "code-h", code: "<p>x</p>", hideGuest: true });
    expect((await convertBlock("fineline", POST_195, hidden)).nodes).toEqual([]);
    const device = block("cwicly/code", {
      classID: "code-d",
      code: "<p>x</p>",
      hideConditions: [{ condition: "device", operator: "===", data: "desktop" }],
    });
    const run = await convertBlock("fineline", POST_195, device);
    const box = el(run.nodes[0]);
    expect(box.tagName).toBe("div");
    expect(box.style).toMatchObject({ "@--md": { display: "none" } });
    expect(kids(box)).toHaveLength(1);
  });

  test("the addresses in the code's HTML move to where the Jx site has them", async () => {
    const b = block("cwicly/code", {
      code: '<a href="https://finelinepainting.pro/residential/">R</a><img src="https://finelinepainting.pro/wp-content/uploads/swash.svg" alt="">',
    });
    const html = htmlOf((await convertBlock("fineline", POST_195, b)).nodes);
    expect(html).toContain('href="/residential/"');
    expect(html).toContain('src="/media/swash.svg"');
  });

  test("code in a Markdown entry is structured too", async () => {
    const b = block("cwicly/code", { code: '<div class="a"><p>x <b>y</b></p></div>' });
    const run = await convertBlock("fineline", POST_195, b, { target: "markdown" });
    expect([...elements(run.nodes)].some((e) => e.innerHTML !== undefined)).toBe(false);
  });
});

describe("hook and fragment", () => {
  test("a hook prints what PHP hung on it: nothing is carried, and the hook is named", async () => {
    const run = await convertBlock(
      "fineline",
      POST_195,
      block("cwicly/hook", { classID: "hook-1", hook: "wp_footer" }),
    );
    expect(run.nodes).toEqual([]);
    expect(reportsOf(run).find((e) => e.code === "block.unsupported")).toMatchObject({
      severity: "warn",
      where: "post:195",
      data: { hook: "wp_footer", block: "cwicly/hook" },
    });
  });

  test("a hook with no name is reported with none", async () => {
    const run = await convertBlock("fineline", POST_195, block("cwicly/hook", {}));
    expect(reportsOf(run).find((e) => e.code === "block.unsupported")?.data).toMatchObject({
      hook: null,
    });
  });

  test("a hidden hook is not reported", async () => {
    const run = await convertBlock(
      "fineline",
      POST_195,
      block("cwicly/hook", { hook: "x", hideGuest: true }),
    );
    expect(codesOf(run)).not.toContain("block.unsupported");
  });

  async function fragmentRun(fragments: unknown, attrs: Record<string, unknown>) {
    const loaded = await loadSite("fineline");
    const base = await makeCtx("fineline", POST_195, {
      cwicly: { ...loaded.options, globalParts: { fragments } },
    });
    baseline.set(base.report, base.report.entries().length);
    const run = standIn(base);
    baseline.set(run.ctx.report, base.report.entries().length);
    return { run, nodes: run.ctx.convert([block("cwicly/fragment", attrs)]) };
  }

  test("a fragment prints the template parts its conditions show everywhere, as template-part placeholders", async () => {
    const { run, nodes } = await fragmentRun(
      {
        globalfooter: {
          conditions: {
            include: {
              footer: {
                all: "true",
                includeCondition: "and",
                singular: [],
                archive: [],
                author: [],
                acf: [],
                custom: [],
              },
              extra: { all: "true", includeCondition: "and" },
            },
            exclude: { extra: { all: "true" } },
          },
        },
      },
      { fragment: "globalfooter" },
    );
    expect(nodes).toHaveLength(1);
    expect(el(nodes[0])).toEqual({
      tagName: "wp2jx-template-part",
      className: "wp-block-template-part",
      attributes: {
        "data-block": "cwicly/fragment",
        "data-attrs": '{"fragment":"globalfooter"}',
        slug: "footer",
        theme: "cwicly",
        "data-fragment": "globalfooter",
      },
    });
    expect(codesOf(run)).toEqual([]);
  });

  test("a part is printed only when cc_condition_checker would include it: the string \"true\", and an includeCondition of 'and' or 'or'", async () => {
    const parts = async (
      include: Record<string, unknown>,
      exclude: Record<string, unknown> = {},
    ) => {
      const { run, nodes } = await fragmentRun(
        { f: { conditions: { include, exclude } } },
        { fragment: "f" },
      );
      return {
        shown: nodes.map((n) => attrsOf(n).slug),
        conditional: reportsOf(run)
          .filter((e) => e.code === "block.fragment-conditional")
          .map((e) => e.data?.part),
        codes: codesOf(run),
      };
    };
    // No includeCondition: the plugin includes nothing.
    expect(await parts({ a: { all: "true", singular: [] } })).toMatchObject({ shown: [] });
    // The boolean true is not the string 'true' (`'true' === $value->all` in PHP).
    expect(await parts({ a: { all: true, includeCondition: "and", singular: [] } })).toMatchObject({
      shown: [],
    });
    // Any other includeCondition is not 'and' or 'or' either.
    expect(
      await parts({ a: { all: "true", includeCondition: "xor", singular: [] } }),
    ).toMatchObject({ shown: [] });
    // 'and' or 'or' with all: the part is on every page.
    expect(
      await parts({
        a: { all: "true", includeCondition: "and", singular: [] },
        b: { all: "true", includeCondition: "or", singular: [] },
      }),
    ).toMatchObject({ shown: ["a", "b"] });
    // `and` with a condition of the page as well is on the pages that satisfy it: the page decides, not the converter.
    const keyed = await parts({
      c: { all: "true", includeCondition: "and", singular: [{ target: "post" }] },
    });
    expect(keyed).toMatchObject({ shown: [], conditional: ["c"] });
    // `or` with all is on every page whatever else is listed.
    expect(
      await parts({ d: { all: "true", includeCondition: "or", singular: [{ target: "post" }] } }),
    ).toMatchObject({ shown: ["d"], conditional: [] });
    // `or` with conditions alone is the page's to decide.
    expect(
      await parts({ e: { all: "false", includeCondition: "or", singular: [{ target: "post" }] } }),
    ).toMatchObject({ shown: [], conditional: ["e"] });
    // Excluded everywhere ('true' string): gone; an excluded boolean true is not an exclusion.
    expect(
      await parts(
        { f: { all: "true", includeCondition: "and", singular: [] } },
        { f: { all: "true" } },
      ),
    ).toMatchObject({ shown: [] });
    expect(
      await parts(
        { g: { all: "true", includeCondition: "and", singular: [] } },
        { g: { all: true } },
      ),
    ).toMatchObject({ shown: ["g"] });
    // An exclusion that depends on the page makes an everywhere part depend on the page.
    expect(
      await parts(
        { h: { all: "true", includeCondition: "and", singular: [] } },
        { h: { all: "false", excludeCondition: "or", singular: [{ target: "404" }] } },
      ),
    ).toMatchObject({ shown: [], conditional: ["h"] });
    // An exclusion of everything is gone, unless it is an 'and' with conditions of the page too.
    expect(
      await parts(
        { i: { all: "true", includeCondition: "and", singular: [] } },
        { i: { all: "true", excludeCondition: "and", singular: [{ target: "404" }] } },
      ),
    ).toMatchObject({ shown: [], conditional: ["i"] });
  });

  test("a part that depends on the page is left out, and the report names it", async () => {
    const { run, nodes } = await fragmentRun(
      {
        f: {
          conditions: {
            include: {
              shop: { all: "false", includeCondition: "or", singular: ["post"], archive: [] },
            },
          },
        },
      },
      { fragment: "f" },
    );
    expect(nodes).toEqual([]);
    expect(reportsOf(run).find((e) => e.code === "block.fragment-conditional")).toMatchObject({
      severity: "warn",
      data: { part: "shop" },
    });
  });

  test("a fragment that shows nothing anywhere says so; a name the site does not have is reported", async () => {
    const empty = await fragmentRun(
      { g: { conditions: { include: { footer: { all: "false", singular: [] } } } } },
      { fragment: "g" },
    );
    expect(empty.nodes).toEqual([]);
    expect(codesOf(empty.run)).toEqual(["block.fragment-empty"]);
    const missing = await fragmentRun({}, { fragment: "nope" });
    expect(missing.nodes).toEqual([]);
    expect(codesOf(missing.run)).toEqual(["block.fragment-missing"]);
    const nameless = await fragmentRun({}, {});
    expect(nameless.nodes).toEqual([]);
  });

  test("a hidden fragment is not looked up", async () => {
    const { run, nodes } = await fragmentRun({}, { fragment: "nope", hideGuest: true });
    expect(nodes).toEqual([]);
    expect(codesOf(run)).not.toContain("block.fragment-missing");
  });

  test("the real fragments of the fixtures: fineline's global header shows the footer part nowhere, ap's has none", async () => {
    const fl = await convertBlock(
      "fineline",
      POST_195,
      block("cwicly/fragment", { fragment: "globalheader" }),
    );
    expect(fl.nodes).toEqual([]);
    expect(codesOf(fl)).toEqual(["block.fragment-empty"]);
    const ap = await convertBlock(
      "ap",
      { kind: "post", id: 819 },
      block("cwicly/fragment", { fragment: "globalheader" }),
    );
    expect(codesOf(ap)).toEqual(["block.fragment-empty"]);
  });
});

describe("content", () => {
  test("in an entry template the body is the entry's, as one string of children", async () => {
    const subject: Subject = { kind: "template", slug: "single" };
    const b = await realBlock("fineline", subject, "content-post");
    const { nodes } = await convertBlock("fineline", subject, b, {
      mode: "entry",
      entryType: "post",
    });
    const node = el(nodes[0]);
    expect(node.tagName).toBe("article");
    expect(node.className?.split(" ")[0]).toBe("content-post");
    expect(node.children as unknown).toBe("${state.entry.$children ?? []}");
    expect(JSON.stringify(node.style)).toContain("padding");
  });

  test("in a query loop the body is the loop item's", async () => {
    const subject: Subject = { kind: "template", slug: "single" };
    const b = await realBlock("fineline", subject, "content-post");
    const { nodes } = await convertBlock("fineline", subject, b, {
      mode: "entry",
      entryType: "post",
      entryExpr: "$map.item",
    });
    expect(el(nodes[0]).children as unknown).toBe("${$map.item.$children ?? []}");
  });

  test("in a template the layout's slot is where the page's body goes", async () => {
    const subject: Subject = { kind: "template", slug: "page" };
    const b = await realBlock("fineline", subject, "content-cd27ea0");
    const { nodes } = await convertBlock("fineline", subject, b);
    const node = el(nodes[0]);
    expect(node.tagName).toBe("div");
    expect(node.children).toEqual([{ tagName: "slot" }]);
  });

  test("a subject that has its own blocks prints them (a page that includes its own content)", async () => {
    const holder = block(
      "cwicly/content",
      { classID: "content-own" },
      '<div class="content-own">{postcontent}</div>',
    );
    const run = await runFor("fineline", POST_195);
    const nodes = run.ctx.convert([holder]);
    const post = subjectPost(await loadSite("fineline"), POST_195)!;
    // The page's blocks are converted inside the box: the first of them is its first section.
    const inner = kids(nodes[0]);
    expect(inner.length).toBeGreaterThan(3);
    expect(el(inner[0]).tagName).toBe("section");
    expect(parseBlocks(post.content).length).toBe(inner.length);
  });

  test("a body that holds its own content block again is not expanded twice", async () => {
    const loaded = await loadSite("fineline");
    const self = block(
      "cwicly/content",
      { classID: "content-self" },
      '<div class="content-self">{postcontent}</div>',
    );
    const post = {
      ...subjectPost(loaded, POST_195)!,
      content: `<!-- wp:cwicly/content {"classID":"content-self"} --><div class="content-self">{postcontent}</div><!-- /wp:cwicly/content -->`,
    };
    const run = await runFor("fineline", POST_195, { subject: { kind: "post", id: "195", post } });
    const nodes = run.ctx.convert([self]);
    expect(codesOf(run)).toContain("block.content-recursion");
    expect(el(nodes[0])).toMatchObject({ tagName: "div" });
    // The inner one is the empty box, so the recursion stops there.
    expect(kids(nodes[0])).toHaveLength(1);
    expect(kids(kids(nodes[0])[0])).toEqual([]);
  });

  test("the entry body builds: a Markdown entry's content is inside the article, and the page ships no script", async () => {
    const subject: Subject = { kind: "template", slug: "single" };
    const b = await realBlock("fineline", subject, "content-post");
    const { nodes } = await convertBlock("fineline", subject, b, {
      mode: "entry",
      entryType: "post",
    });
    const site = await buildJxProject({
      "project.json": PROJECT({
        extensions: ["@jxsuite/parser"],
        content: {
          items: {
            source: "content/items",
            format: "Markdown",
            schema: {
              type: "object",
              properties: { title: { type: "string" }, slug: { type: "string" } },
              required: ["title"],
            },
          },
        },
      }),
      "layouts/base.json": LAYOUT,
      "content/items/foo.md": '---\ntitle: "Foo"\nslug: "foo"\n---\n\nBody text here.\n',
      "pages/e/[slug].json": {
        $paths: { contentType: "items", param: "slug", field: "slug" },
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
        children: nodes,
      },
    });
    const html = site.html("/e/foo/");
    expect(html).toMatch(/<article class="content-post"><p>Body text here\.<\/p><\/article>/);
    expect(site.exists("e/foo/app.js")).toBe(false);
  });
});

describe("maps", () => {
  test("a map is Google's embedded map of its address, at its zoom, with its name", async () => {
    const b = block(
      "cwicly/maps",
      {
        classID: "maps-a",
        gmapAddress: "550 E Kercher Ave, Lebanon, PA",
        gmapZoom: 14,
        gmapName: "Shop",
      },
      '<div class="maps-a"></div>',
    );
    const run = await convertBlock("fineline", POST_195, b);
    const root = el(run.nodes[0]);
    expect(root.className).toBe("maps-a");
    const iframe = el(kids(root)[0]);
    expect(iframe.tagName).toBe("iframe");
    expect(iframe.attributes).toMatchObject({
      src: "https://maps.google.com/maps?q=550%20E%20Kercher%20Ave%2C%20Lebanon%2C%20PA&z=14&output=embed",
      title: "Shop",
      loading: "lazy",
    });
    expect(reportsOf(run).find((e) => e.code === "block.maps-approximated")).toMatchObject({
      severity: "warn",
      data: { block: "cwicly/maps" },
    });
  });

  test("coordinates stand in for an address, and the zoom may be a string or absent", async () => {
    const run = await runFor("fineline", POST_195);
    const a = run.ctx.convert([
      block("cwicly/maps", {
        classID: "m1",
        gmapLatitude: "40.37",
        gmapLongitude: "-76.38",
        gmapZoom: "9",
      }),
    ]);
    expect(attrsOf(kids(a[0])[0]).src).toBe(
      "https://maps.google.com/maps?q=40.37%2C-76.38&z=9&output=embed",
    );
    const b = run.ctx.convert([block("cwicly/maps", { classID: "m2", gmapAddress: "X" })]);
    // The block's default zoom (block.json) is 14.
    expect(attrsOf(kids(b[0])[0])).toMatchObject({
      src: "https://maps.google.com/maps?q=X&z=14&output=embed",
      title: "X",
    });
    const c = run.ctx.convert([
      block("cwicly/maps", { classID: "m3", gmapAddress: "Y", gmapZoom: "far" }),
    ]);
    expect(String(attrsOf(kids(c[0])[0]).src)).toContain("&z=14&");
  });

  test("the plugin centres the map on the coordinates and prints the address only in the marker's window: with both, the embed is of the coordinates and the address is the title", async () => {
    const run = await runFor("fineline", POST_195);
    const [map] = run.ctx.convert([
      block("cwicly/maps", {
        classID: "m5",
        gmapAddress: "550 E Kercher Ave, Lebanon, PA",
        gmapLatitude: 40.3,
        gmapLongitude: "-76.4",
        gmapZoom: 12,
      }),
    ]);
    expect(attrsOf(kids(map)[0])).toMatchObject({
      src: "https://maps.google.com/maps?q=40.3%2C-76.4&z=12&output=embed",
      title: "550 E Kercher Ave, Lebanon, PA",
    });
    // One coordinate alone is no place: the address is.
    const [half] = run.ctx.convert([
      block("cwicly/maps", { classID: "m6", gmapAddress: "Lebanon", gmapLatitude: 40.3 }),
    ]);
    expect(String(attrsOf(kids(half)[0]).src)).toContain("q=Lebanon&");
    // A coordinate of 0 is a coordinate.
    const [zero] = run.ctx.convert([
      block("cwicly/maps", { classID: "m7", gmapLatitude: 0, gmapLongitude: 0 }),
    ]);
    expect(String(attrsOf(kids(zero)[0]).src)).toContain("q=0%2C0&");
  });

  test("a map with no place is an empty box", async () => {
    const run = await convertBlock("fineline", POST_195, block("cwicly/maps", { classID: "m4" }));
    expect(el(run.nodes[0])).not.toHaveProperty("children");
    expect(reportsOf(run).find((e) => e.code === "block.maps-approximated")?.message).toContain(
      "no address",
    );
  });

  test("the map builds into one iframe", async () => {
    const b = block(
      "cwicly/maps",
      { classID: "maps-b", gmapAddress: "Lebanon, PA" },
      '<div class="maps-b"></div>',
    );
    const run = await convertBlock("fineline", POST_195, b);
    const html = (await buildPage(run.nodes)).html("/");
    expect(html.match(/<iframe/g)).toHaveLength(1);
    expect(html).toContain("output=embed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. The census
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** What `count` of each layout block the fixtures hold, subjects of every kind (posts, templates, parts, components, reusable blocks). */
const CENSUS: Record<SiteName, Record<string, number>> = {
  fineline: {
    "cwicly/heading": 966,
    "cwicly/div": 845,
    "cwicly/container": 548,
    "cwicly/section": 527,
    "cwicly/paragraph": 474,
    "cwicly/image": 425,
    "cwicly/column": 278,
    "cwicly/columns": 193,
    "cwicly/button": 121,
    "cwicly/icon": 70,
    "cwicly/gallery": 64,
    "cwicly/content": 4,
    "cwicly/list": 4,
  },
  ap: {
    "cwicly/div": 183,
    "cwicly/paragraph": 179,
    "cwicly/column": 102,
    "cwicly/heading": 87,
    "cwicly/icon": 73,
    "cwicly/section": 65,
    "cwicly/image": 57,
    "cwicly/columns": 49,
    "cwicly/button": 41,
    "cwicly/content": 7,
    "cwicly/list": 6,
    "cwicly/code": 1,
    "cwicly/video": 1,
  },
};

/** The Cwicly blocks of the fixtures this module does not own (the interactive and data modules do). */
const NOT_MINE = {
  fineline: [
    "cwicly/component",
    "cwicly/query",
    "cwicly/query-template",
    "cwicly/navlink",
    "cwicly/nav",
    "cwicly/menu",
    "cwicly/navitems",
    "cwicly/filter",
    "cwicly/query-pagination",
    "cwicly/query-pagination-numbers",
    "cwicly/taxonomyterms",
  ],
  ap: [
    "cwicly/query",
    "cwicly/query-template",
    "cwicly/filter",
    "cwicly/input",
    "cwicly/component",
    "cwicly/modal",
    "cwicly/menu",
    "cwicly/taxonomyterms",
    "cwicly/popover",
    "cwicly/query-pagination",
    "cwicly/query-pagination-numbers",
  ],
};

function countNames(blocks: readonly WpBlock[], into: Map<string, number>): void {
  walkBlocks(blocks, (b) => {
    if (b.name?.startsWith("cwicly/")) into.set(b.name, (into.get(b.name) ?? 0) + 1);
  });
}

describe("the census", () => {
  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: the Cwicly blocks are the ones the module covers or the others own, with these counts`, async () => {
      const loaded = await loadSite(site);
      const counts = new Map<string, number>();
      for (const subject of allSubjects(loaded)) countNames(subjectBlocks(loaded, subject), counts);
      const mine: Record<string, number> = {};
      const others: string[] = [];
      for (const [name, n] of counts) {
        if (MINE.has(name)) mine[name] = n;
        else others.push(name);
      }
      expect(mine).toEqual(CENSUS[site]);
      expect(others.sort()).toEqual([...NOT_MINE[site]].sort());
    });
  }

  test("the module covers every block name of the assignment", () => {
    expect([...MINE].sort()).toEqual([
      "cwicly/button",
      "cwicly/code",
      "cwicly/column",
      "cwicly/columns",
      "cwicly/container",
      "cwicly/content",
      "cwicly/div",
      "cwicly/fragment",
      "cwicly/gallery",
      "cwicly/heading",
      "cwicly/hook",
      "cwicly/icon",
      "cwicly/image",
      "cwicly/list",
      "cwicly/maps",
      "cwicly/paragraph",
      "cwicly/section",
      "cwicly/styler",
      "cwicly/svg",
      "cwicly/video",
    ]);
  });

  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: every subject converts without throwing, and the converters were called as many times as the blocks they could reach`, async () => {
      const loaded = await loadSite(site);
      const reached = new Map<string, number>();
      const empty = new Map<string, number>();
      let subjects = 0;
      for (const subject of allSubjects(loaded)) {
        const blocks = subjectBlocks(loaded, subject);
        if (blocks.length === 0) continue;
        const run = await convertSubject(site, subject);
        subjects++;
        for (const call of run.calls) {
          const name = call.block.name!;
          reached.set(name, (reached.get(name) ?? 0) + 1);
          if (call.nodes.length === 0) empty.set(name, (empty.get(name) ?? 0) + 1);
        }
      }
      expect(subjects).toBe(site === "fineline" ? 126 : 278);
      expect(Object.fromEntries([...reached].sort())).toEqual(REACHED[site]);
      expect(Object.fromEntries([...empty].sort())).toEqual(EMPTY[site]);
    });
  }
});

/** How many times each converter was called (a block under a query or a component is reached by the data module, not here; a reusable block is reached once per place that uses it). */
const REACHED: Record<SiteName, Record<string, number>> = {
  fineline: {
    "cwicly/button": 113,
    "cwicly/column": 263,
    "cwicly/columns": 186,
    "cwicly/container": 541,
    "cwicly/content": 4,
    "cwicly/div": 715,
    "cwicly/gallery": 64,
    "cwicly/heading": 868,
    "cwicly/icon": 70,
    "cwicly/image": 367,
    "cwicly/list": 4,
    "cwicly/paragraph": 467,
    "cwicly/section": 527,
  },
  ap: {
    "cwicly/button": 19,
    "cwicly/code": 1,
    "cwicly/column": 82,
    "cwicly/columns": 39,
    "cwicly/content": 7,
    "cwicly/div": 123,
    "cwicly/heading": 61,
    "cwicly/icon": 28,
    "cwicly/image": 61,
    "cwicly/list": 4,
    "cwicly/paragraph": 87,
    "cwicly/section": 69,
    "cwicly/video": 1,
  },
};

/** The calls that returned no nodes: a block no visitor sees, an image with no file. */
const EMPTY: Record<SiteName, Record<string, number>> = {
  fineline: { "cwicly/image": 5, "cwicly/section": 1 },
  ap: {
    "cwicly/button": 4,
    "cwicly/div": 2,
    "cwicly/image": 2,
    "cwicly/paragraph": 1,
    "cwicly/section": 1,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. The live pages
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// A live page (tests/fixtures/<site>/html) is what the site printed, so it is the oracle for what the
// converted blocks must look like. A page is made of subjects (its template, its parts, its post,
// reusable blocks): the stylesheets it links name them. Each subject's layout blocks are converted
// with the stand-in driver, every subject is built into a page of one Jx project, and the built
// elements are matched to the live ones by classID (every block's element has its classID in its class
// list, and a classID is unique to a block).
//
// Two things stand between a live page and the converted one that are not the converter's:
//
// - **The dump is not the live site.** The database rows and the live pages were fetched at different
//   moments, and the live pages are the newer (docs/design.md). So an element is judged against a
//   third thing, the block's own saved markup (what the editor wrote into the dump, resolved by the
//   same tokens): when the converted element says exactly what the saved markup says, the dump is what
//   differs from the live page, and the element is `drift`, not a mistake. A converted element that
//   differs from the live page AND from its saved markup is `unexplained`, and there must be none.
// - **Templates show the page's own data.** A template converted for a static page has no post, so a
//   dynamic block of it cannot match its page; those blocks are the entry tests' (section 4).

type Dom = { tag: string; attrs: Record<string, string>; children: (Dom | string)[]; parent?: Dom };

type P5 = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5[];
  content?: P5;
};

function toDom(node: P5, parent?: Dom): Dom | string | undefined {
  if (node.nodeName === "#text") return node.value ?? "";
  if (node.tagName === undefined) return undefined;
  const out: Dom = {
    tag: node.tagName,
    attrs: Object.fromEntries((node.attrs ?? []).map((a) => [a.name, a.value])),
    children: [],
    ...(parent ? { parent } : {}),
  };
  for (const child of (node.tagName === "template" ? node.content : node)?.childNodes ?? []) {
    const c = toDom(child, out);
    if (c !== undefined) out.children.push(c);
  }
  return out;
}

function* walkDom(el: Dom): Generator<Dom> {
  yield el;
  for (const c of el.children) if (typeof c !== "string") yield* walkDom(c);
}

/** The text a reader sees: a line break is a space (whitespace before it collapses in the browser, so `the <br>same` and `the<br>same` read alike). */
const textOfDom = (el: Dom): string =>
  el.tag === "br"
    ? " "
    : el.tag === "style" || el.tag === "script" || el.tag === "svg"
      ? ""
      : el.children.map((c) => (typeof c === "string" ? c : textOfDom(c))).join("");

const collapse = (s: string): string => s.replaceAll(/\s+/g, " ").trim();

/** The class an element's own style is written to: its first, not counting the converter's scope class. A global class can carry the name of another block's classID, so a classID is looked for here. */
const firstClass = (el: Dom): string =>
  (el.attrs.class ?? "").split(/\s+/).find((c) => c !== "" && !/^jx-[0-9a-f]{10}$/.test(c)) ?? "";

/** Whether the element or any element around it carries `hidden`. */
const isHidden = (el: Dom): boolean => {
  for (let e: Dom | undefined = el; e; e = e.parent) if (e.attrs.hidden !== undefined) return true;
  return false;
};

function pageDom(html: string): Dom {
  const doc = parse(html) as unknown as P5;
  const root = doc.childNodes?.find((n) => n.tagName === "html");
  return toDom(root!) as Dom;
}

function fragmentDom(html: string): Dom[] {
  const body = pageDom(`<body>${html}</body>`);
  const b = body.children.find((c): c is Dom => typeof c !== "string" && c.tag === "body");
  return (b?.children ?? []).filter((c): c is Dom => typeof c !== "string");
}

interface Sig {
  tag: string;
  classes: string;
  attrs: Record<string, string>;
  text: string;
  anchors: string;
  svgs: number;
}

const SIG_ATTRS = [
  "href",
  "src",
  "alt",
  "width",
  "height",
  "target",
  "rel",
  "title",
  "aria-label",
  "hidden",
  "type",
];
const TEXT_BLOCKS = new Set([
  "cwicly/heading",
  "cwicly/paragraph",
  "cwicly/button",
  "cwicly/list",
  "cwicly/icon",
]);

function sigOf(el: Dom, rw: (url: string) => string, withText: boolean): Sig {
  const attrs: Record<string, string> = {};
  for (const name of SIG_ATTRS) {
    let v = el.attrs[name];
    if (name === "hidden") v = v === undefined ? undefined : "true";
    if (name === "alt") v = v ?? "";
    if (v === undefined || (v === "" && name !== "alt")) continue;
    if ((name === "width" || name === "height") && v === "0") continue;
    if (name === "href" || name === "src") v = rw(v);
    if (name === "rel") v = v.split(/\s+/).sort().join(" ");
    attrs[name] = v;
  }
  // `jx-<hash>` is the scope class the converter gives an element that has an inline style and no class of its own.
  const classes = [
    ...new Set(
      (el.attrs.class ?? "")
        .split(/\s+/)
        .filter(
          (c) => c !== "" && c !== "current" && !c.startsWith("{") && !/^jx-[0-9a-f]{10}$/.test(c),
        ),
    ),
  ]
    .sort()
    .join(" ");
  const inside = [...walkDom(el)].filter((x) => x !== el);
  return {
    tag: el.tag,
    classes,
    attrs,
    text: withText ? collapse(textOfDom(el)) : "",
    anchors: inside
      .filter((x) => x.tag === "a")
      .map(
        (a) =>
          `${rw(a.attrs.href ?? "")}|${a.attrs.target ?? ""}|${(a.attrs.rel ?? "").split(/\s+/).sort().join(" ")}`,
      )
      .join(" ; "),
    svgs: inside.filter((x) => x.tag === "svg").length,
  };
}

/** The fields in which two signatures differ. A width and height that agree in proportion agree: the live page prints the size of the variant it showed, the build the original's. */
function diffSig(a: Sig, b: Sig): string[] {
  const out: string[] = [];
  if (a.tag !== b.tag) out.push("tag");
  if (a.classes !== b.classes) out.push("class");
  if (a.text !== b.text) out.push("text");
  if (a.anchors !== b.anchors) out.push("anchors");
  if (a.svgs !== b.svgs) out.push("svgs");
  for (const name of SIG_ATTRS) {
    const x = a.attrs[name];
    const y = b.attrs[name];
    if (x === y) continue;
    out.push(`@${name}`);
  }
  const ratio = (s: Sig): number | undefined =>
    s.attrs.width && s.attrs.height ? Number(s.attrs.width) / Number(s.attrs.height) : undefined;
  // A dynamic image of a static page is printed with the size WordPress prints; the entry's is bound to
  // the entry's data, which holds the original's dimensions only, so it writes none (the build then
  // takes them from the file).
  if (a.tag === "img" && a.attrs.width === undefined && b.attrs.width !== undefined) {
    for (const name of ["@width", "@height"]) {
      const at = out.indexOf(name);
      if (at >= 0) out.splice(at, 1);
    }
  }
  const wa = out.indexOf("@width");
  const ha = out.indexOf("@height");
  const ra = ratio(a);
  const rb = ratio(b);
  if (wa >= 0 && ha >= 0 && ra !== undefined && rb !== undefined && Math.abs(ra / rb - 1) < 0.02) {
    out.splice(Math.max(wa, ha), 1);
    out.splice(Math.min(wa, ha), 1);
  }
  return out;
}

/** A block of a template, part or reusable block that shows its page's own data (or a query item's): a static conversion of it has no post to read the data from. */
function dynamicInTemplate(subject: Subject, b: Record<string, unknown>): boolean {
  return (
    subject.kind !== "post" &&
    Boolean(
      b.dynamic ||
      b.linkWrapperSourceType === "dynamic" ||
      b.imageType === "dynamic" ||
      // a hide condition on the address of the page (`get_current_slug()`) is the page's own data
      (Array.isArray(b.hideConditions) &&
        b.hideConditions.some((c) =>
          String((c as { function?: unknown } | null)?.function ?? "").includes("get_current_slug"),
        )) ||
      b.backgroundImageType === "dynamic" ||
      String(b.content ?? "").includes("{") ||
      b.galleryDynamic === "dynamic",
    )
  );
}

const LIVE_PAGES: Record<SiteName, string[]> = {
  fineline: [
    "home",
    "about-us",
    "blog",
    "choosing-the-best-log-home-stain",
    "privacy-policy",
    "residential",
  ],
  ap: [
    "essays",
    "essays__get-in-the-way-of-evil",
    "essays__keeshons-story-a-knock-heard-round-the-hood-part-3",
    "essays__the-cultural-captivity-of-the-gospel",
    "essays__the-essence-of-anabaptism-dean-taylor",
    "essays__the-way-we-live-is-the-way-we-educate",
  ],
};

/** The subjects a live page was made of: the stylesheets it links say so (`cc-tp-…` a template or a part, `cc-post-…` a post, `cc-rb-…` a reusable block). */
function liveSubjects(loaded: LoadedSite, html: string): Subject[] {
  const out: Subject[] = [];
  for (const m of html.matchAll(/uploads\/cwicly\/css\/(cc-[a-z]+-[^"'?]+)\.css/g)) {
    const name = m[1]!;
    let hit: RegExpExecArray | null;
    if ((hit = /^cc-post-(\d+)$/.exec(name))) out.push({ kind: "post", id: Number(hit[1]) });
    else if ((hit = /^cc-rb-(\d+)$/.exec(name))) out.push({ kind: "reusable", id: Number(hit[1]) });
    else if ((hit = /^cc-tp-[^_]+_(.+)$/.exec(name))) {
      const slug = hit[1]!;
      out.push(
        subjectPost(loaded, { kind: "part", slug })
          ? { kind: "part", slug }
          : { kind: "template", slug },
      );
    }
    // A component's blocks print once per instance, with the instance's values: the data module's.
  }
  return out;
}

/** What a block's own saved markup says its element is: the element that carries the classID, tokens resolved (a static subject, so no bindings), the class list as the style module resolves it. */
function savedSig(
  b: WpBlock,
  ctx: ConvertCtx,
  rw: (url: string) => string,
  leaf: boolean,
): Sig | undefined {
  const html = resolveTokens(b.innerHTML, ctx, b, { where: "html" });
  const roots = fragmentDom(html);
  const classID = typeof b.attrs.classID === "string" ? b.attrs.classID : undefined;
  let found: Dom | undefined;
  for (const root of roots) {
    for (const el of walkDom(root)) {
      if (
        found === undefined &&
        (classID === undefined || (el.attrs.class ?? "").split(/\s+/).includes(classID))
      )
        found = el;
    }
  }
  found ??= roots[0];
  if (!found) return undefined;
  const sig = sigOf(found, rw, leaf);
  const styled = styleBlock(b, ctx);
  return {
    ...sig,
    classes: [...new Set(styled.className.split(/\s+/).filter(Boolean))].sort().join(" "),
  };
}

interface Verdict {
  block: string;
  classID: string;
  subject: string;
  verdict: "match" | "drift" | "deviation" | "reused" | "unexplained";
  fields: string[];
  note?: string;
}

interface LiveResult {
  verdicts: Verdict[];
  /** Blocks left out of the comparison, by why. */
  skipped: Record<string, number>;
  /** classIDs whose live element count differed from the converted one, by kind. */
  counts: Record<string, number>;
}

const POPOVER_FIELDS = new Set(["tag", "@type", "@href", "@target", "@rel"]);

async function compareLive(site: SiteName, file: string): Promise<LiveResult> {
  const loaded = await loadSite(site);
  const liveHtml = readFileSync(`tests/fixtures/${site}/html/${file}.html`, "utf8");
  const live = pageDom(liveHtml);
  const subjects = liveSubjects(loaded, liveHtml);
  const probe = await makeCtx(site, subjects.find((s) => s.kind === "post") ?? subjects[0]!);
  const rw = (url: string): string => probe.mediaForUrl(url)?.src ?? probe.rewriteUrl(url);

  const skipped: Record<string, number> = {};
  const skip = (why: string): void => void (skipped[why] = (skipped[why] ?? 0) + 1);
  const pages: Record<string, ProjectFile> = {};
  const groups = new Map<
    string,
    { block: WpBlock; run: Run; subject: Subject; page: number; nodes: JxNode[]; key: string }[]
  >();
  for (const [i, subject] of subjects.entries()) {
    const run = await convertSubject(site, subject, {}, true);
    pages[`pages/p${i}.json`] = { children: run.nodes };
    for (const call of run.calls) {
      const id = call.block.attrs.classID;
      if (typeof id !== "string" || id === "") {
        skip("no classID");
        continue;
      }
      // A template shows its page's own data, which a static conversion of the template does not have.
      const dynamic = dynamicInTemplate(subject, call.block.attrs);
      if (dynamic) {
        skip("dynamic in a template");
        continue;
      }
      const list = groups.get(id) ?? [];
      list.push({
        block: call.block,
        run,
        subject,
        page: i,
        nodes: call.nodes,
        key: `${i}:${run.keyOf(call.block)}`,
      });
      groups.set(id, list);
    }
  }
  const project = await buildJxProject({
    "project.json": PROJECT(),
    "layouts/base.json": LAYOUT,
    ...pages,
  });
  const built = subjects.map((_, i) => pageDom(project.html(`/p${i}/`)));
  const uidClass = new Map<string, string>();
  for (const [classID, group] of groups) for (const g of group) uidClass.set(g.key, classID);
  /** The live page's elements by classID (their first class), the built pages' by the mark the stand-in put on the block's own element. */
  const index = (roots: Dom[], by: "class" | "mark"): Map<string, Dom[]> => {
    const map = new Map<string, Dom[]>();
    for (const [page, root] of roots.entries()) {
      for (const el of walkDom(root)) {
        const token =
          by === "class" ? firstClass(el) : (uidClass.get(`${page}:${el.attrs[MARK] ?? ""}`) ?? "");
        if (groups.has(token)) map.set(token, [...(map.get(token) ?? []), el]);
      }
    }
    return map;
  };
  const liveIndex = index([live], "class");
  const builtIndex = index(built, "mark");

  const verdicts: Verdict[] = [];
  const counts: Record<string, number> = {};
  const count = (k: string): void => void (counts[k] = (counts[k] ?? 0) + 1);
  for (const [classID, group] of groups) {
    const first = group[0]!;
    const name = first.block.name!;
    const leaf = TEXT_BLOCKS.has(name);
    const where = JSON.stringify(first.subject);
    const verdict = (v: Verdict["verdict"], fields: string[] = [], note?: string): void =>
      void verdicts.push({
        block: name,
        classID,
        subject: where,
        verdict: v,
        fields,
        ...(note ? { note } : {}),
      });
    const hasConditions =
      group.some(
        (g) =>
          Array.isArray(g.block.attrs.hideConditions) && g.block.attrs.hideConditions.length > 0,
      ) ||
      group.some((g) => g.block.attrs.hideLoggedIn === true || g.block.attrs.hideGuest === true);
    const L = liveIndex.get(classID) ?? [];
    const B = builtIndex.get(classID) ?? [];
    if (L.length === 0 && B.length === 0) {
      if (process.env.WP2JX_DEBUG && name === "cwicly/div") {
        const loose = (roots: Dom[]): string[] =>
          roots
            .flatMap((r) => [...walkDom(r)])
            .filter((el) => (el.attrs.class ?? "").split(/\s+/).includes(classID))
            .map((el) => `${el.tag}.${el.attrs.class}`);
        console.log(
          "NEITHER",
          file,
          classID,
          JSON.stringify(loose([live])),
          JSON.stringify(loose(built)),
        );
      }
      skip("in neither");
      continue;
    }
    if (L.length === 0) {
      // The live stylesheets are independent evidence that the block is gone from the live page: the plugin writes a rule for every
      // styled block it renders, and the live stylesheet has none for this one.
      const ruled = group.some((g) => g.run.ctx.css.classes.has(classID));
      const styled = group.some((g) => g.block.attrs.isStyling === true);
      verdict(
        hasConditions ? "deviation" : "drift",
        ["absent-live"],
        hasConditions
          ? "a condition only the page can decide"
          : ruled
            ? "styled in the live stylesheet"
            : styled
              ? "the live stylesheet has no rule for it"
              : "never had a rule",
      );
      continue;
    }
    if (B.length === 0) {
      verdict("unexplained", ["absent-built"]);
      continue;
    }
    if (L.length > B.length) count("live repeats it");
    if (L.length < B.length) count("built has more");
    const ctx = first.run.ctx;
    const saved = savedSig(first.block, ctx, rw, leaf);
    const action = blockLinkAction(first.block, ctx);
    for (let k = 0; k < Math.min(L.length, B.length); k++) {
      const a = sigOf(L[k]!, rw, leaf);
      const b = sigOf(B[k]!, rw, leaf);
      if (!leaf) {
        a.anchors = b.anchors = "";
        a.svgs = b.svgs = 0;
      }
      const against = diffSig(a, b);
      if (against.length === 0) {
        verdict("match");
        continue;
      }
      if (name === "cwicly/image" && against.every((f) => f === "@width" || f === "@height")) {
        verdict(
          "reused",
          against,
          "the live element with this classID is another image (a comment's avatar)",
        );
        continue;
      }
      const inSaved = saved
        ? diffSig(saved, b).filter((f) => leaf || (f !== "anchors" && f !== "svgs"))
        : ["no-saved"];
      if (inSaved.every((f) => f === "@width" || f === "@height")) {
        verdict("drift", against, "the dump's saved markup says what was converted");
      } else if (action && against.every((f) => POPOVER_FIELDS.has(f))) {
        verdict("deviation", against, "a modal opener is a button");
      } else {
        verdict("unexplained", against, `saved differs in ${inSaved.join(",")}`);
      }
    }
  }
  return { verdicts, skipped, counts };
}

function blockLinkAction(b: WpBlock, ctx: ConvertCtx): boolean {
  const a = b.attrs;
  return (
    a.linkWrapperActive === true &&
    a.linkWrapperType === "action" &&
    (a.linkWrapperAction === "modal" ||
      a.linkWrapperAction === "showPopover" ||
      a.linkWrapperAction === "hidePopover" ||
      a.linkWrapperAction === "togglePopover" ||
      a.linkWrapperAction === "showHidePopover") &&
    ctx !== undefined
  );
}

/** Match rates by block type, summed over the six live pages of each site: [match, drift, deviation, reused]. */
const LIVE_TABLE: Record<SiteName, Record<string, [number, number, number, number]>> = {
  fineline: {
    "cwicly/button": [25, 2, 0, 0],
    "cwicly/column": [0, 3, 0, 0],
    "cwicly/columns": [0, 1, 0, 0],
    "cwicly/container": [44, 5, 0, 0],
    "cwicly/content": [5, 0, 0, 0],
    "cwicly/div": [121, 5, 0, 0],
    "cwicly/heading": [46, 7, 0, 0],
    "cwicly/icon": [16, 4, 0, 0],
    "cwicly/image": [25, 1, 0, 0],
    "cwicly/paragraph": [174, 5, 0, 0],
    "cwicly/section": [42, 4, 0, 0],
  },
  ap: {
    "cwicly/column": [29, 0, 0, 0],
    "cwicly/columns": [17, 0, 0, 0],
    "cwicly/content": [5, 0, 0, 0],
    "cwicly/div": [69, 0, 1, 0],
    "cwicly/icon": [12, 0, 6, 0],
    "cwicly/image": [7, 0, 0, 5],
    "cwicly/paragraph": [24, 0, 0, 0],
    "cwicly/section": [27, 0, 0, 0],
  },
};

describe("the live pages", () => {
  const results = new Map<SiteName, Promise<{ file: string; result: LiveResult }[]>>();
  const resultsOf = (site: SiteName): Promise<{ file: string; result: LiveResult }[]> => {
    let r = results.get(site);
    if (!r) {
      r = (async () => {
        const out: { file: string; result: LiveResult }[] = [];
        for (const file of LIVE_PAGES[site])
          out.push({ file, result: await compareLive(site, file) });
        return out;
      })();
      results.set(site, r);
    }
    return r;
  };

  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: every converted element says what the live page says, or what the dump says where the dump is older: nothing is unexplained`, async () => {
      const all = (await resultsOf(site)).flatMap((r) => r.result.verdicts);
      if (process.env.WP2JX_DEBUG)
        for (const v of all.filter((x) => x.verdict === "drift" || x.verdict === "deviation"))
          console.log(
            "V",
            site,
            v.verdict,
            v.block,
            v.classID,
            v.subject,
            v.fields.join(","),
            v.note,
          );
      if (process.env.WP2JX_DEBUG)
        for (const v of all.filter((x) => x.verdict === "unexplained"))
          console.log("UNEXPLAINED", site, JSON.stringify(v));
      expect(all.filter((v) => v.verdict === "unexplained")).toEqual([]);
      expect(all.length).toBe(site === "fineline" ? 535 : 202);
    });

    test(`${site}: the match rate of each block type, over its six pages`, async () => {
      const table: Record<string, [number, number, number, number]> = {};
      for (const v of (await resultsOf(site)).flatMap((r) => r.result.verdicts)) {
        const row = (table[v.block] ??= [0, 0, 0, 0]);
        const column = { match: 0, drift: 1, deviation: 2, reused: 3, unexplained: -1 }[v.verdict];
        if (column >= 0) row[column] = (row[column] ?? 0) + 1;
      }
      if (process.env.WP2JX_DEBUG)
        console.log(
          "TABLE",
          site,
          JSON.stringify(Object.fromEntries(Object.entries(table).sort())),
        );
      expect(Object.fromEntries(Object.entries(table).sort())).toEqual(LIVE_TABLE[site]);
    });
  }

  test("fineline: the drift is the dump being older than the live pages, and the live stylesheets say so", async () => {
    const drift = (await resultsOf("fineline"))
      .flatMap((r) => r.result.verdicts)
      .filter((v) => v.verdict === "drift");
    const kinds = new Map<string, number>();
    for (const v of drift) kinds.set(v.fields.join(","), (kinds.get(v.fields.join(",")) ?? 0) + 1);
    expect(Object.fromEntries([...kinds].sort())).toEqual({ "absent-live": 33, class: 3, text: 1 });
    // A block the live page lacks is styled in the dump and has no rule in the live stylesheet.
    for (const v of drift.filter((d) => d.fields[0] === "absent-live")) {
      expect(v.note).toBe("the live stylesheet has no rule for it");
    }
    // The four elements that are there but say something else are all on the one page that was edited after the dump.
    const changed = (await resultsOf("fineline")).filter((r) =>
      r.result.verdicts.some((v) => v.verdict === "drift" && v.fields[0] !== "absent-live"),
    );
    expect(changed.map((r) => r.file)).toEqual(["about-us"]);
  });

  test("anabaptistperspectives: a modal's opener is a button where the page had an anchor; a condition only the page can decide keeps its block", async () => {
    const rows = (await resultsOf("ap"))
      .flatMap((r) => r.result.verdicts)
      .filter((v) => v.verdict === "deviation");
    expect(
      rows
        .filter((v) => v.fields.join(",") === "tag,@type")
        .map((v) => v.classID)
        .sort(),
    ).toEqual([
      "icon-toggle",
      "icon-toggle-light",
      "icon-toggle-light",
      "icon-toggle-light",
      "icon-toggle-light",
      "icon-toggle-light",
    ]);
    expect(rows.filter((v) => v.fields[0] === "absent-live").map((v) => v.classID)).toEqual([
      "div-c437eab",
    ]);
  });

  test("anabaptistperspectives: the comment avatars share the logo's classID, and are not the logo", async () => {
    const reused = (await resultsOf("ap"))
      .flatMap((r) => r.result.verdicts)
      .filter((v) => v.verdict === "reused");
    expect(new Set(reused.map((v) => v.classID))).toEqual(new Set(["image-c260437"]));
  });

  test("a page's template is repeated or its parts included twice: the live page has more elements than the conversion, never fewer", async () => {
    for (const site of ["fineline", "ap"] as const) {
      for (const r of await resultsOf(site))
        expect(r.result.counts["built has more"] ?? 0).toBeLessThanOrEqual(1);
    }
    const about = (await resultsOf("fineline")).find((r) => r.file === "about-us")!;
    expect(about.result.counts["built has more"]).toBe(1);
    const essays = (await resultsOf("ap")).find((r) => r.file === "essays")!;
    expect(essays.result.counts["live repeats it"]).toBe(9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3b. The saved markup
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// The dump's own saved markup is the other oracle: it is what the editor wrote and, with its tokens
// resolved, what the site printed when the dump was made. Every block of both sites that has a classID
// is converted in its own subject and the element is compared with the saved one: tag, class list,
// attributes, text, links, icons. The only differences are the three the converter makes on purpose.

describe("the saved markup", () => {
  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: every converted element is what the saved markup says, bar the named deviations`, async () => {
      const loaded = await loadSite(site);
      const probe = await makeCtx(site, FOOTER);
      const rw = (url: string): string => probe.mediaForUrl(url)?.src ?? probe.rewriteUrl(url);
      const components = componentsOf(loaded.model);
      const tally: Record<string, number> = {};
      const count = (k: string): void => void (tally[k] = (tally[k] ?? 0) + 1);
      const unexplained: string[] = [];
      for (const subject of allSubjects(loaded)) {
        if (subjectBlocks(loaded, subject).length === 0) continue;
        const info = subject.kind === "component" ? components.get(subject.ref) : undefined;
        const run = await convertSubject(
          site,
          subject,
          info ? { props: new Map(info.props.map((p) => [p.id, p.key])) } : {},
          true,
        );
        for (const call of run.calls) {
          const classID = call.block.attrs.classID;
          if (typeof classID !== "string" || classID === "" || call.nodes.length === 0) {
            count("no classID or no nodes");
            continue;
          }
          if (dynamicInTemplate(subject, call.block.attrs)) {
            count("dynamic in a template");
            continue;
          }
          const leaf = TEXT_BLOCKS.has(call.block.name!);
          let ours: Dom | undefined;
          for (const root of fragmentDom(htmlOf(call.nodes)))
            for (const e of walkDom(root))
              if (ours === undefined && e.attrs[MARK] === run.keyOf(call.block)) ours = e;
          const saved = savedSig(call.block, run.ctx, rw, leaf);
          if (!saved) continue;
          if (!ours) {
            // A block with no style of its own prints no classID (the editor's `isStyling` rule), so there is no element to find by it.
            if (saved.classes.split(" ").includes(classID)) {
              unexplained.push(
                `${site} ${JSON.stringify(subject)} ${call.block.name} ${classID}: no element`,
              );
              count("unexplained");
            } else count("classID not printed (an unstyled block)");
            continue;
          }
          const mine = sigOf(ours, rw, leaf);
          if (JSON.stringify([saved, mine]).includes("${")) {
            count("a binding (the entry and component tests build them)");
            continue;
          }
          if (!leaf) {
            mine.anchors = saved.anchors = "";
            mine.svgs = saved.svgs = 0;
          }
          const diff = diffSig(saved, mine);
          const a = call.block.attrs;
          const opener =
            a.linkWrapperActive === true &&
            a.linkWrapperType === "action" &&
            ["modal", "showPopover", "hidePopover", "togglePopover", "showHidePopover"].includes(
              String(a.linkWrapperAction),
            );
          let kind = "same";
          if (diff.length > 0) {
            if (opener && diff.every((f) => POPOVER_FIELDS.has(f)))
              kind = "modal opener is a button";
            else if (
              (subject.kind === "post" || subject.kind === "reusable") &&
              diff.every((f) => f === "@target" || f === "@rel" || f === "anchors")
            )
              kind = "rank math opens external links in a new window";
            else if (
              diff.every((f) => f === "@width" || f === "@height") &&
              a.imageID !== undefined
            )
              kind = "stale attachment id: the page prints the size of another file";
            else if (
              diff.join() === "@href" &&
              saved.attrs.href === undefined &&
              mine.attrs.href !== undefined &&
              (a.linkWrapperStaticObject !== undefined || a.linkWrapperUrl !== undefined)
            )
              kind = "link repaired from the stored address";
            else {
              kind = "unexplained";
              unexplained.push(
                `${site} ${JSON.stringify(subject)} ${call.block.name} ${classID}: ${diff.join(",")}`,
              );
              if (process.env.WP2JX_DEBUG)
                console.log(
                  "DEBUG",
                  classID,
                  diff.join(","),
                  "\n  saved",
                  JSON.stringify(saved).slice(0, 500),
                  "\n  ours ",
                  JSON.stringify(mine).slice(0, 500),
                );
            }
          }
          count(kind);
        }
      }
      expect(unexplained).toEqual([]);
      expect(tally).toEqual(SAVED_TALLY[site]);
    });
  }
});

const SAVED_TALLY: Record<SiteName, Record<string, number>> = {
  fineline: {
    "a binding (the entry and component tests build them)": 8,
    "classID not printed (an unstyled block)": 13,
    "dynamic in a template": 67,
    "link repaired from the stored address": 14,
    "no classID or no nodes": 9,
    "rank math opens external links in a new window": 7,
    same: 4070,
    "stale attachment id: the page prints the size of another file": 1,
  },
  ap: {
    "a binding (the entry and component tests build them)": 6,
    "classID not printed (an unstyled block)": 181,
    "dynamic in a template": 43,
    "modal opener is a button": 4,
    "no classID or no nodes": 11,
    "rank math opens external links in a new window": 34,
    same: 302,
    "stale attachment id: the page prints the size of another file": 1,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. Entry templates
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// A template is converted twice: for a static page of one real post (every value known: the post is
// the subject) and for an entry template (every value a binding on the entry). The entry template is
// built over the real entries of those posts (frontmatter written by `postData`, the entry as the
// data contract writes it) and the static pages are built beside them. Each block of the template is
// then the same element on both pages: a block the static page leaves out (its condition is false, it
// has no image) is hidden on the entry page, and a block it shows is shown, with the same tag, class
// list, attributes and text. That is the proof that the bindings the converters write mean what the
// values they write for a static page mean, through the whole path (`buildBlock`, `assemble`, the
// text, link, image and gallery wiring), and that the page ships no JavaScript.

const yamlLine = (k: string, v: unknown): string => `${JSON.stringify(k)}: ${JSON.stringify(v)}`;

interface EntryCase {
  site: SiteName;
  template: string;
  type: string;
  posts: number;
}

const ENTRY_CASES: EntryCase[] = [
  { site: "fineline", template: "single-project", type: "project", posts: 3 },
  { site: "fineline", template: "single-service", type: "service", posts: 2 },
  { site: "fineline", template: "single", type: "post", posts: 2 },
  { site: "ap", template: "single-post", type: "post", posts: 2 },
  { site: "ap", template: "single-episode", type: "episode", posts: 2 },
];

/** What the compared blocks add up to, per case: [compared, hidden on the entry page, with text, with an href, with a src]. A pass cannot be an empty one. */
const ENTRY_TALLY: Record<string, number[]> = {
  "fineline single-project": [154, 68, 67, 18, 10],
  "fineline single-service": [108, 74, 47, 4, 6],
  "fineline single": [28, 0, 9, 4, 2],
  "ap single-post": [42, 2, 4, 0, 4],
  "ap single-episode": [34, 12, 2, 0, 0],
};

describe("an entry template and the static pages of its posts say the same thing", () => {
  for (const c of ENTRY_CASES) {
    test(`${c.site} ${c.template}`, async () => {
      const loaded = await loadSite(c.site);
      const template: Subject = { kind: "template", slug: c.template };
      const probe = await makeCtx(c.site, { kind: "post", id: 0 }).catch(() =>
        makeCtx(c.site, template),
      );
      const ranked = [...loaded.model.posts.values()]
        .filter((p) => p.type === c.type && p.status === "publish")
        .map((p) => ({ p, size: JSON.stringify(postFacts(probe, p)).length }))
        .sort((a, b) => b.size - a.size || a.p.id - b.p.id);
      // The fullest posts, and the emptiest one: its conditions are false where theirs are true.
      const posts = [...ranked.slice(0, c.posts - 1), ranked.at(-1)!].map((x) => x.p);
      expect(posts).toHaveLength(c.posts);

      const entry = await convertSubject(
        c.site,
        template,
        { mode: "entry", entryType: c.type },
        true,
      );
      if (process.env.WP2JX_DEBUG)
        console.log(
          "REACHED",
          c.template,
          entry.calls.filter((x) => x.block.attrs.classID === "div-ccc2fcf").length,
          entry.calls.length,
        );
      const reached = entry.calls
        .map((x) => x.block)
        .filter((b) => typeof b.attrs.classID === "string" && b.attrs.classID !== "");

      const files: Record<string, ProjectFile> = {
        "project.json": PROJECT({
          extensions: ["@jxsuite/parser"],
          content: {
            items: {
              source: "content/items",
              format: "Markdown",
              schema: {
                type: "object",
                properties: { title: { type: "string" }, slug: { type: "string" } },
                required: ["title"],
              },
            },
          },
        }),
        "layouts/base.json": LAYOUT,
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
          children: entry.nodes,
        },
      };
      for (const post of posts) {
        const data: Record<string, unknown> = { ...postData(probe, post) };
        const authorUrl = probe.urlForAuthor?.(post.authorId);
        if (authorUrl !== undefined) data.authorUrl = authorUrl;
        const lines = Object.entries({ ...data, slug: `p${post.id}` }).map(([k, v]) =>
          yamlLine(k, v),
        );
        files[`content/items/p${post.id}.md`] =
          `---\n${lines.join("\n")}\n---\n\n${post.content.trim() === "" ? "" : "Body of the entry."}\n`;
        const stat = await convertSubject(
          c.site,
          template,
          { mode: "static", target: "page", subject: { kind: "post", id: String(post.id), post } },
          true,
        );
        files[`pages/s${post.id}.json`] = { children: stat.nodes };
      }
      const site = await buildJxProject(files, { name: "entry" });

      let compared = 0;
      let hidden = 0;
      let withText = 0;
      let withHref = 0;
      let withSrc = 0;
      const problems: string[] = [];
      const rw = (url: string): string => probe.mediaForUrl(url)?.src ?? probe.rewriteUrl(url);
      for (const post of posts) {
        const entryPage = site.html(`/e/p${post.id}/`);
        expect(site.exists(`e/p${post.id}/app.js`)).toBe(false);
        expect(entryPage).not.toContain("data-bind");
        const eDom = pageDom(entryPage);
        const sDom = pageDom(site.html(`/s${post.id}/`));
        const find = (root: Dom, b: WpBlock): Dom | undefined => {
          const key = entry.keyOf(b);
          for (const e of walkDom(root)) if (e.attrs[MARK] === key) return e;
          return undefined;
        };
        for (const b of reached) {
          const classID = b.attrs.classID as string;
          const leaf = TEXT_BLOCKS.has(b.name!);
          const e = find(eDom, b);
          const s = find(sDom, b);
          if (!e && !s) continue;
          if (!e) {
            problems.push(`${post.id} ${classID}: not on the entry page`);
            continue;
          }
          if (!s) {
            // The static page decided the block is not shown: the entry page hides it (or an element around it), or it prints nothing.
            const empty =
              collapse(textOfDom(e)) === "" &&
              e.attrs.src === undefined &&
              e.attrs.href === undefined;
            if (!isHidden(e) && !empty)
              problems.push(
                `${post.id} ${classID}: shown on the entry page, left out of the static one`,
              );
            hidden++;
            continue;
          }
          if (isHidden(e)) {
            if (process.env.WP2JX_DEBUG) {
              const chain: string[] = [];
              for (let up: Dom | undefined = e; up; up = up.parent)
                chain.push(
                  `${up.tag}.${up.attrs.class ?? ""}${up.attrs.hidden !== undefined ? "[hidden]" : ""}`,
                );
              console.log("CHAIN", chain.join(" < "));
            }
            problems.push(
              `${post.id} ${classID}: hidden on the entry page, shown on the static one`,
            );
            continue;
          }
          const es = sigOf(e, rw, leaf);
          const ss = sigOf(s, rw, leaf);
          if (!leaf) {
            es.anchors = ss.anchors = "";
            es.svgs = ss.svgs = 0;
          }
          // The static page and the entry both read the same sources; the cases below are conversions that differ on purpose.
          const diff = diffSig(es, ss);
          if (diff.length > 0)
            problems.push(
              `${post.id} ${classID} ${b.name}: ${diff.join(",")} entry=${JSON.stringify(es).slice(0, 200)} static=${JSON.stringify(ss).slice(0, 200)}`,
            );
          compared++;
          if (es.text !== "") withText++;
          if (es.attrs.href !== undefined) withHref++;
          if (es.attrs.src !== undefined) withSrc++;
        }
      }
      if (process.env.WP2JX_DEBUG && problems.length > 0)
        console.log("PAGE", site.html(`/e/p${posts[0]!.id}/`).slice(0, 3000));
      if (process.env.WP2JX_DEBUG)
        console.log(
          "ENTRY",
          c.site,
          c.template,
          JSON.stringify([compared, hidden, withText, withHref, withSrc]),
          problems.slice(0, 12).join("\n"),
        );
      expect(problems).toEqual([]);
      expect([compared, hidden, withText, withHref, withSrc]).toEqual(
        ENTRY_TALLY[`${c.site} ${c.template}`]!,
      );
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5. Markdown entries, the galleries' structure, and building everything
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const holdsInnerHtml = (nodes: readonly JxNode[]): boolean =>
  [...elements(nodes)].some((e) => e.innerHTML !== undefined);

describe("the Markdown entries", () => {
  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: every layout block of an entry survives serializeJxMarkdown and the parse back, and holds no innerHTML`, async () => {
      const loaded = await loadSite(site);
      let subjects = 0;
      let marked = 0;
      let hoisted = 0;
      const lost: string[] = [];
      for (const subject of allSubjects(loaded)) {
        const post = subjectPost(loaded, subject);
        if (subject.kind !== "post" || !post || post.type === "page") continue;
        const blocks = subjectBlocks(loaded, subject);
        if (
          !blocks.some(function has(b: WpBlock): boolean {
            return b.name?.startsWith("cwicly/") === true || b.innerBlocks.some(has);
          })
        )
          continue;
        const run = await convertSubject(site, subject, {}, true);
        subjects++;
        expect(holdsInnerHtml(run.nodes)).toBe(false);
        hoisted += run.hoisted.length;
        const md = serializeJxMarkdown({ children: run.nodes } as never, { mode: "roundtrip" });
        const back = (transpileJxMarkdown(md).children ?? []) as JxNode[];
        const backMarks = new Map<string, JxElement>();
        for (const e of elements(back)) {
          const mark = (e.attributes as Record<string, unknown> | undefined)?.[MARK];
          if (typeof mark === "string") backMarks.set(mark, e);
        }
        for (const e of elements(run.nodes)) {
          const mark = (e.attributes as Record<string, unknown> | undefined)?.[MARK];
          if (typeof mark !== "string") continue;
          marked++;
          const again = backMarks.get(mark);
          if (
            !again ||
            again.tagName !== e.tagName ||
            (again.className ?? "").split(" ")[0] !== (e.className ?? "").split(" ")[0]
          ) {
            lost.push(`${JSON.stringify(subject)} ${mark} ${e.tagName} ${e.className}`);
          }
        }
      }
      expect(lost).toEqual([]);
      expect([subjects, marked, hoisted]).toEqual(MARKDOWN_TALLY[site]);
    });
  }

  test("a Markdown entry's heading link: the text and the address are in the directive, the descendant rule is the project's", async () => {
    const subject: Subject = { kind: "post", id: 1078 };
    const b = await realBlock("fineline", subject, "heading-c235f2d");
    const run = await convertBlock("fineline", subject, b);
    const md = serializeJxMarkdown({ children: run.nodes } as never, { mode: "roundtrip" });
    expect(md).toMatch(/:::h3\{className="heading-c235f2d jx-[0-9a-f]{10}"/);
    expect(md).toContain(
      "[Log Cabin Staining In Fredericksburg PA](/project/log-cabin-staining-in-fredericksburg-pa/)",
    );
    expect(md).not.toContain("style.&");
    const mark = /className="heading-c235f2d (jx-[0-9a-f]{10})"/.exec(md)?.[1];
    expect(run.hoisted.map((h) => h.selector)).toContain(`.heading-c235f2d:where(.${mark}) a`);
  });
});

/** [entries converted, elements of the converters in them, rules hoisted]. */
const MARKDOWN_TALLY: Record<SiteName, number[]> = {
  fineline: [83, 3089, 276],
  ap: [3, 1, 2],
};

describe("the galleries' structure against the saved markup", () => {
  /** The shape of a gallery's inner markup: tags and classes, with the images' addresses and the links. */
  function shapeOfGallery(root: Dom, rw: (u: string) => string): string[] {
    const out: string[] = [];
    const visit = (e: Dom, depth: number): void => {
      // The root's own classes are the style module's (the global classes are resolved in ours); the inner ones are the gallery's.
      const classes =
        depth === 0
          ? ""
          : (e.attrs.class ?? "")
              .split(/\s+/)
              .filter((c) => c && !/^jx-[0-9a-f]{10}$/.test(c))
              .join(".");
      const extra =
        e.tag === "img"
          ? ` src=${rw(e.attrs.src ?? "")} alt=${e.attrs.alt ?? ""}`
          : e.tag === "a"
            ? ` href=${rw(e.attrs.href ?? "")} data-gallery=${e.attrs["data-gallery"] ?? ""}`
            : "";
      out.push(`${"  ".repeat(depth)}${e.tag}${classes ? `.${classes}` : ""}${extra}`);
      for (const c of e.children) if (typeof c !== "string") visit(c, depth + 1);
    };
    visit(root, 0);
    return out;
  }

  test("fineline: every fixed gallery has the same elements, classes, images and links as the page's own markup", async () => {
    const loaded = await loadSite("fineline");
    const probe = await makeCtx("fineline", FOOTER);
    const rw = (u: string): string => probe.mediaForUrl(u)?.src ?? probe.rewriteUrl(u);
    let galleries = 0;
    let figures = 0;
    const diffs: string[] = [];
    for (const subject of allSubjects(loaded)) {
      const blocks = subjectBlocks(loaded, subject);
      if (blocks.length === 0) continue;
      const run = await convertSubject("fineline", subject, {}, true);
      for (const call of run.calls) {
        if (
          call.block.name !== "cwicly/gallery" ||
          call.block.attrs.galleryDynamic === "dynamic" ||
          call.nodes.length === 0
        )
          continue;
        galleries++;
        const saved = fragmentDom(
          resolveTokens(call.block.innerHTML, run.ctx, call.block, { where: "html" }),
        )[0]!;
        const ours = fragmentDom(htmlOf(call.nodes))[0]!;
        const a = shapeOfGallery(saved, rw);
        const b = shapeOfGallery(ours, rw);
        figures += a.filter((l) => l.trim().startsWith("figure")).length;
        // The saved markup's `srcset`, `sizes` and `decoding` are the Jx build's; the image's class and the `jx-` scopes are not shapes.
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          diffs.push(`${JSON.stringify(subject)} ${call.block.attrs.classID}`);
          if (process.env.WP2JX_DEBUG && diffs.length === 1)
            console.log("SAVED", a.slice(0, 8).join("\n"), "\nOURS", b.slice(0, 8).join("\n"));
        }
      }
    }
    expect(diffs).toEqual([]);
    expect([galleries, figures]).toEqual([63, 378]);
  });
});

describe("everything builds", () => {
  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: the converted subjects are valid Jx pages and build into a site`, async () => {
      const loaded = await loadSite(site);
      const pages: Record<string, ProjectFile> = {};
      let n = 0;
      for (const subject of allSubjects(loaded)) {
        const blocks = subjectBlocks(loaded, subject);
        if (
          !blocks.some(function has(b: WpBlock): boolean {
            return b.name?.startsWith("cwicly/") === true || b.innerBlocks.some(has);
          })
        )
          continue;
        const info =
          subject.kind === "component" ? componentsOf(loaded.model).get(subject.ref) : undefined;
        const run = await convertSubject(site, subject, {
          target: "page",
          ...(info ? { props: new Map(info.props.map((p) => [p.id, p.key])) } : {}),
        });
        pages[`pages/p${n++}.json`] = { children: run.nodes };
      }
      const project = await buildJxProject(
        { "project.json": PROJECT(), "layouts/base.json": LAYOUT, ...pages },
        { timeoutMs: 280_000 },
      );
      expect(project.code).toBe(0);
      expect(project.list().filter((f) => f.endsWith("index.html"))).toHaveLength(n);
      const validated = await validateJxProject(project.dir);
      expect(validated.problems).toEqual([]);
      expect(validated.ok).toBe(true);
      expect(n).toBe(site === "fineline" ? 113 : 51);
    });
  }
});
