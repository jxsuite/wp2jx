/**
 * The placeholder catalogue and the walker that replaces them, against the placeholders the
 * converters really emit. Source is read as text to hold the catalogue to what `src/` makes, the two
 * fixture sites are converted to hold it to what the data produces, and the walker is exercised on
 * every shape a Jx tree keeps elements in.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertSubject } from "../src/convert.ts";
import {
  BLOCK,
  INTERNAL_MARKERS,
  MENU,
  NAVIGATION,
  PLACEHOLDERS,
  PLACEHOLDER_PREFIX,
  POST_CONTENT,
  SHORTCODE,
  TEMPLATE_PART,
  childNodes,
  collectPlaceholders,
  encodeBlockAttrs,
  isPlaceholder,
  placeholderAttrs,
  placeholderElement,
  readPlaceholder,
  replacePlaceholders,
  tagOf,
  walkElements,
  type Placeholder,
  type ResolverMap,
} from "../src/placeholders.ts";
import { createReport } from "../src/report.ts";
import { allSubjects, subjectBlocks } from "../src/site.ts";
import type { JxElement, JxNode } from "../src/types.ts";
import { walkBlocks } from "../src/wp/blocks.ts";
import { loadSite, makeCtx } from "./helpers/ctx.ts";

const SRC = resolve(import.meta.dir, "../src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/**
 * Only a tag position counts: a quoted literal that IS the tag (`"wp2jx-inner"`, a code span in a
 * comment) or an element written as markup (`<wp2jx-shortcode`). A class list (`wp2jx-unconverted
 * wp2jx-${kind}`), an attribute (`data-wp2jx-innerhtml`) or a sentence about a placeholder is not an element.
 */
const TAG_POSITION = /(["'`])wp2jx-([a-z][a-z0-9-]*)\1|<\/?wp2jx-([a-z][a-z0-9-]*)/g;

const el = (tagName: string, rest: Record<string, unknown> = {}): JxElement =>
  ({ tagName, ...rest }) as JxElement;

describe("the catalogue holds every placeholder src/ makes", () => {
  const files = sourceFiles(SRC).filter((f) => !f.endsWith("src/placeholders.ts"));
  const texts = files.map((f) => ({ f: f.slice(SRC.length + 1), text: readFileSync(f, "utf8") }));
  const known = new Set([...Object.values(PLACEHOLDERS).map((p) => p.tag), ...INTERNAL_MARKERS]);

  test("every literal wp2jx-<name> in the source is a catalogued tag or an internal marker", () => {
    const seen = new Map<string, string>();
    for (const { f, text } of texts) {
      for (const m of text.matchAll(TAG_POSITION)) {
        seen.set(`wp2jx-${m[2] ?? m[3]}`, f);
      }
    }
    const unknown = [...seen].filter(([tag]) => !known.has(tag));
    expect(unknown).toEqual([]);
    // and the sweep is not vacuous: the catalogue's tags that are built by name appear
    for (const tag of ["wp2jx-menu", "wp2jx-post-content", "wp2jx-shortcode", "wp2jx-inner"]) {
      expect(seen.has(tag)).toBe(true);
    }
  });

  test("the sweep reads tag positions only: a class list, an attribute or a sentence is not a tag", () => {
    const tags = (text: string): string[] =>
      [...text.matchAll(TAG_POSITION)].map((m) => `wp2jx-${m[2] ?? m[3]}`);
    expect(tags("const MARKER = \"wp2jx-inner\"; tagName: 'wp2jx-menu'")).toEqual([
      "wp2jx-inner",
      "wp2jx-menu",
    ]);
    expect(tags("`<wp2jx-shortcode data-x=1></wp2jx-shortcode>`")).toEqual([
      "wp2jx-shortcode",
      "wp2jx-shortcode",
    ]);
    expect(tags("see the `wp2jx-block` placeholder")).toEqual(["wp2jx-block"]);
    expect(tags("className: `wp2jx-unconverted wp2jx-${kind}`")).toEqual([]);
    expect(tags('const KEY = "data-wp2jx-innerhtml";')).toEqual([]);
    expect(tags("a wp2jx-block placeholder marks its place")).toEqual([]);
    expect(tags('"wp2jx-bogus"')).toEqual(["wp2jx-bogus"]);
  });

  test("every `what` a converter passes to placeholder() or unresolved() is a catalogued kind", () => {
    const whats = new Set<string>();
    const patterns = [
      /\bplaceholder\(\s*(?:ctx,\s*)?block,\s*"([a-z][a-z-]*)"/g,
      /\bunresolved\(\s*block,\s*ctx,\s*"([a-z][a-z-]*)"/g,
    ];
    for (const { text } of texts) {
      for (const re of patterns) for (const m of text.matchAll(re)) whats.add(m[1]!);
    }
    expect(whats.size).toBeGreaterThanOrEqual(8);
    const missing = [...whats].filter((what) => !Object.hasOwn(PLACEHOLDERS, what));
    expect(missing).toEqual([]);
  });

  test("every spec names its own tag, an owner and a resolver", () => {
    for (const [kind, spec] of Object.entries(PLACEHOLDERS)) {
      expect(spec.kind).toBe(kind as typeof spec.kind);
      expect(spec.tag).toBe(`${PLACEHOLDER_PREFIX}${kind}`);
      expect(spec.meaning.length).toBeGreaterThan(20);
      expect(spec.madeBy.length).toBeGreaterThan(0);
      expect(spec.resolvedBy.length).toBeGreaterThan(0);
    }
    expect(tagOf(MENU)).toBe("wp2jx-menu");
    expect([POST_CONTENT, TEMPLATE_PART, NAVIGATION, SHORTCODE, BLOCK].map(tagOf)).toEqual([
      "wp2jx-post-content",
      "wp2jx-template-part",
      "wp2jx-navigation",
      "wp2jx-shortcode",
      "wp2jx-block",
    ]);
  });
});

describe("reading and building", () => {
  test("an element is a placeholder when its tag has the prefix, and an internal marker is not one", () => {
    expect(isPlaceholder(el("wp2jx-menu"))).toBe(true);
    expect(isPlaceholder(el("div"))).toBe(false);
    expect(isPlaceholder("wp2jx-menu")).toBe(false);
    expect(isPlaceholder(el("wp2jx-inner"))).toBe(false);
    expect(readPlaceholder(el("wp2jx-inner"))).toBeUndefined();
    expect(readPlaceholder(el("section"))).toBeUndefined();
  });

  test("a placeholder reads back its kind, attributes, block and block attributes", () => {
    const node = el("wp2jx-template-part", {
      className: "wp-block-template-part",
      attributes: {
        "data-block": "core/template-part",
        "data-attrs": '{"slug":"header","note":"a\\u0024{b}"}',
        slug: "header",
        theme: "cwicly",
      },
    });
    const read = readPlaceholder(node)!;
    expect(read.tag).toBe("wp2jx-template-part");
    expect(read.kind).toBe("template-part");
    expect(read.block).toBe("core/template-part");
    // the escaped dollar sign reads back as the real one
    expect(read.blockAttrs).toEqual({ slug: "header", note: "a${b}" });
    expect(placeholderAttrs(node, "template-part")?.slug).toBe("header");
    expect(placeholderAttrs(node, "menu")).toBeUndefined();
  });

  test("unreadable data-attrs are an empty object, not a throw", () => {
    for (const bad of ["{oops", "[1,2]", "", "null"]) {
      const read = readPlaceholder(el("wp2jx-block", { attributes: { "data-attrs": bad } }))!;
      expect(read.blockAttrs).toEqual({});
    }
  });

  test("encodeBlockAttrs never writes a literal dollar-brace", () => {
    const text = encodeBlockAttrs({ a: "x${y}", b: ["${z}"] });
    expect(text.includes("${")).toBe(false);
    expect(JSON.parse(text)).toEqual({ a: "x${y}", b: ["${z}"] });
  });

  test("placeholderElement writes the block's name and attributes first, then its own", () => {
    const made = placeholderElement(
      "template-part",
      { slug: "footer", theme: "cwicly" },
      {
        block: { name: "core/template-part", attrs: { slug: "footer" } },
        className: "wp-block-template-part",
      },
    );
    expect(made).toEqual({
      tagName: "wp2jx-template-part",
      className: "wp-block-template-part",
      attributes: {
        "data-block": "core/template-part",
        "data-attrs": '{"slug":"footer"}',
        slug: "footer",
        theme: "cwicly",
      },
    });
    // a block with no attributes writes no data-attrs; a freeform block is named so
    expect(placeholderElement("block", {}, { block: { name: null, attrs: {} } })).toEqual({
      tagName: "wp2jx-block",
      attributes: { "data-block": "freeform" },
    });
    expect(placeholderElement("post-content")).toEqual({ tagName: "wp2jx-post-content" });
    const withChildren = placeholderElement(
      "shortcode",
      { "data-shortcode": "x", "data-source": "[x]" },
      { children: ["a"] },
    );
    expect(withChildren.children).toEqual(["a"]);
  });
});

describe("the real converters' placeholders have the shape placeholderElement writes", () => {
  test("a core template-part block, built by core/blocks.ts, equals placeholderElement's", async () => {
    const site = await loadSite("fineline");
    let block: Parameters<typeof walkBlocks>[0][number] | undefined;
    walkBlocks(subjectBlocks(site, { kind: "template", slug: "single-project" }), (b) => {
      if (b.name === "core/template-part" && block === undefined) block = b;
    });
    expect(block).toBeDefined();
    const ctx = await makeCtx("fineline", { kind: "template", slug: "single-project" });
    const [built] = ctx.convert([block!]);
    const attrs = block!.attrs as Record<string, string>;
    const made = placeholderElement(
      "template-part",
      {
        ...(attrs.slug ? { slug: attrs.slug } : {}),
        theme: attrs.theme ?? ctx.model.site.theme,
        ...(attrs.area ? { area: attrs.area } : {}),
        ...(attrs.tagName ? { tag: attrs.tagName } : {}),
      },
      { block: block!, className: "wp-block-template-part" },
    );
    expect(built).toEqual(made);
  });

  test("the driver's fallback for a block with no markup is core's own wp2jx-block", async () => {
    const site = await loadSite("ap");
    const converted = await convertSubject(site, {
      kind: "post",
      id: Number(
        [...site.model.posts.values()].find((p) =>
          p.content.includes("drupalblock/views-block-team-block-1"),
        )?.id,
      ),
    });
    const blocks = [...walkElements(converted.nodes)].filter((e) => e.tagName === "wp2jx-block");
    expect(blocks.length).toBeGreaterThan(0);
    const read = readPlaceholder(blocks[0]!)!;
    expect(read.block).toMatch(/^drupalblock\//);
    expect(Object.keys(read.attrs).sort()).toEqual(
      ["data-attrs", "data-block"].filter((k) => k in read.attrs).sort(),
    );
    expect(blocks[0]).toEqual(
      placeholderElement("block", {}, { block: { name: read.block!, attrs: read.blockAttrs } }),
    );
  });
});

const tree: JxNode[] = [
  el("div", {
    children: [
      el("p", { textContent: "a" }),
      el("ul", {
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/x" },
          map: el("li", { children: [el("wp2jx-menu")] }),
        } as unknown as JxElement["children"],
      }),
      el("section", {
        cases: { one: el("wp2jx-block"), two: el("span") } as unknown as JxElement["cases"],
      }),
    ],
  }),
  "text",
];

describe("walking trees", () => {
  test("walkElements visits parents before children, repeaters and cases included", () => {
    const tags = [...walkElements(tree)].map((e) => e.tagName);
    expect(tags).toEqual(["div", "p", "ul", "li", "wp2jx-menu", "section", "wp2jx-block", "span"]);
  });

  test("childNodes lists lists, mapped templates, own maps and cases", () => {
    expect(childNodes(el("a"))).toEqual([]);
    const own = el("b");
    expect(childNodes({ tagName: "x", map: own } as unknown as JxElement)).toEqual([own]);
  });

  test("collectPlaceholders counts elements and the ones inside innerHTML, markers too", () => {
    const counts = collectPlaceholders([
      el("wp2jx-menu"),
      el("div", {
        children: [el("wp2jx-menu"), el("wp2jx-inner")],
        innerHTML: "<wp2jx-block></wp2jx-block><b>x</b>",
      }),
    ]);
    expect(Object.fromEntries(counts)).toEqual({
      "wp2jx-menu": 2,
      "wp2jx-inner": 1,
      "wp2jx-block": 1,
    });
  });
});

describe("replacePlaceholders", () => {
  const standIn =
    (label: string) =>
    (p: Placeholder): JxNode =>
      el("div", { attributes: { "data-was": p.tag, "data-label": label } });

  test("resolvers are found by tag, then kind, then *", () => {
    const resolver: ResolverMap = {
      "wp2jx-menu": standIn("by-tag"),
      menu: standIn("by-kind"),
      block: standIn("block-kind"),
      "*": standIn("rest"),
    };
    const out = replacePlaceholders(
      [el("wp2jx-menu"), el("wp2jx-block"), el("wp2jx-post-content")],
      resolver,
    );
    expect(out.map((n) => (n as JxElement).attributes?.["data-label"])).toEqual([
      "by-tag",
      "block-kind",
      "rest",
    ]);
  });

  test("null removes the placeholder, an array splices, undefined leaves it and reports it", () => {
    const report = createReport();
    const input: JxNode[] = [
      el("div", {
        children: [
          el("wp2jx-menu"),
          el("wp2jx-block"),
          el("wp2jx-post-content", { attributes: { "data-x": "1" } }),
        ],
      }),
    ];
    const stats = { replaced: new Map<string, number>(), left: new Map<string, number>() };
    const out = replacePlaceholders(
      input,
      { menu: () => null, block: () => ["a", el("i")] },
      { report, where: "post:1", url: "https://example.test/x/", stats },
    );
    const div = out[0] as JxElement;
    expect(div.children).toEqual([
      "a",
      el("i"),
      el("wp2jx-post-content", { attributes: { "data-x": "1" } }),
    ]);
    expect(Object.fromEntries(stats.replaced)).toEqual({ "wp2jx-menu": 1, "wp2jx-block": 1 });
    expect(Object.fromEntries(stats.left)).toEqual({ "wp2jx-post-content": 1 });
    const entries = report.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: "error",
      code: "placeholder.unresolved",
      where: "post:1",
      url: "https://example.test/x/",
      data: { tag: "wp2jx-post-content", attributes: { "data-x": "1" } },
    });
    // the input is untouched
    expect((input[0] as JxElement).children).toHaveLength(3);
  });

  test("children are replaced before their parent is resolved, and the parent sees them", () => {
    let seen: unknown;
    const out = replacePlaceholders([el("wp2jx-shortcode", { children: [el("wp2jx-menu")] })], {
      menu: () => el("nav"),
      shortcode: (p) => {
        seen = p.element.children;
        return el("section", { children: p.element.children as JxNode[] });
      },
    });
    expect(seen).toEqual([el("nav")]);
    expect(out).toEqual([el("section", { children: [el("nav")] })]);
  });

  test("what a resolver returns is walked again, to a depth, and a self-containing part is cut and reported", () => {
    const report = createReport();
    const out = replacePlaceholders(
      [el("wp2jx-template-part", { attributes: { slug: "a" } })],
      {
        "template-part": (p) =>
          p.attrs.slug === "a"
            ? el("div", { children: [el("wp2jx-template-part", { attributes: { slug: "b" } })] })
            : el("b"),
      },
      { report },
    );
    expect(out).toEqual([el("div", { children: [el("b")] })]);
    expect(report.entries()).toHaveLength(0);

    const loop = createReport();
    replacePlaceholders(
      [el("wp2jx-template-part")],
      { "template-part": () => el("div", { children: [el("wp2jx-template-part")] }) },
      { report: loop, maxDepth: 4 },
    );
    const codes = loop.entries().map((e) => e.code);
    expect(codes).toContain("placeholder.cycle");
  });

  test("a resolver's own children are not walked or reported twice", () => {
    const report = createReport();
    replacePlaceholders(
      [el("wp2jx-shortcode", { children: [el("wp2jx-block")] })],
      { shortcode: (p) => p.element.children as JxNode[] },
      { report },
    );
    expect(report.entries().filter((e) => e.code === "placeholder.unresolved")).toHaveLength(1);
  });

  test("placeholders inside a repeater's template, an own map and the cases of a switch are replaced", () => {
    const out = replacePlaceholders(tree, { "*": () => el("hr") }) as JxElement[];
    const tags = [...walkElements(out)].map((e) => e.tagName);
    expect(tags).toEqual(["div", "p", "ul", "li", "hr", "section", "hr", "span"]);
    // a template position holds exactly one element: several replacements are wrapped, none leaves an empty wrapper
    const many = replacePlaceholders(
      [{ tagName: "ul", map: el("wp2jx-menu") } as unknown as JxElement],
      { menu: () => [el("a"), el("b")] },
    );
    expect((many[0] as unknown as { map: JxElement }).map.children).toEqual([el("a"), el("b")]);
    const none = replacePlaceholders(
      [{ tagName: "ul", map: el("wp2jx-menu") } as unknown as JxElement],
      { menu: () => null },
    );
    expect((none[0] as unknown as { map: JxElement }).map.children).toEqual([]);
  });

  test("unchanged subtrees are shared, changed ones are copies", () => {
    const stable = el("footer", { children: [el("p", { textContent: "x" })] });
    const changed = el("header", { children: [el("wp2jx-menu")] });
    const out = replacePlaceholders([stable, changed], { menu: () => el("nav") });
    expect(out[0]).toBe(stable);
    expect(out[1]).not.toBe(changed);
    expect(changed.children).toEqual([el("wp2jx-menu")]);
  });

  test("a placeholder in an innerHTML string cannot be replaced and is reported; so is a leaked marker", () => {
    const report = createReport();
    const out = replacePlaceholders(
      [
        el("div", { innerHTML: "<p>x</p><wp2jx-menu></wp2jx-menu>" }),
        el("p", { children: [el("wp2jx-inner")] }),
      ],
      { "*": () => el("nav") },
      { report },
    );
    expect((out[0] as JxElement).innerHTML).toContain("<wp2jx-menu>");
    expect(report.entries().map((e) => [e.code, (e.data as { tag: string }).tag])).toEqual([
      ["placeholder.unresolved", "wp2jx-menu"],
      ["placeholder.marker-leaked", "wp2jx-inner"],
    ]);
    expect((report.entries()[0]!.data as { inMarkup: boolean }).inMarkup).toBe(true);
  });

  test("without a report nothing is reported and nothing throws", () => {
    const out = replacePlaceholders([el("wp2jx-block")], {});
    expect(out).toEqual([el("wp2jx-block")]);
  });
});

describe("over the two sites", () => {
  for (const name of ["fineline", "ap"] as const) {
    test(`${name}: every placeholder every subject produces is catalogued, readable and replaceable`, async () => {
      const site = await loadSite(name);
      const kinds = new Map<string, number>();
      let total = 0;
      for (const subject of allSubjects(site)) {
        const { nodes, used } = await convertSubject(site, subject);
        // the census the driver reports is the census of the nodes
        expect(Object.fromEntries(used.placeholderCounts)).toEqual(
          Object.fromEntries(collectPlaceholders(nodes)),
        );
        const report = createReport();
        const stats = { replaced: new Map<string, number>(), left: new Map<string, number>() };
        const out = replacePlaceholders(
          nodes,
          { "*": (p) => el("div", { attributes: { "data-stand-in": p.kind } }) },
          { report, stats },
        );
        // elements are all replaced; what is left can only be inside markup, and then it is said
        for (const e of report.entries()) expect(e.code).toBe("placeholder.unresolved");
        expect([...collectPlaceholders(out).keys()].filter((t) => !t.startsWith("wp2jx-"))).toEqual(
          [],
        );
        for (const [tag, count] of used.placeholderCounts) {
          expect(Object.hasOwn(PLACEHOLDERS, tag.slice(PLACEHOLDER_PREFIX.length))).toBe(true);
          kinds.set(tag, (kinds.get(tag) ?? 0) + count);
          total += count;
        }
        for (const element of walkElements(nodes)) {
          const read = readPlaceholder(element);
          if (read?.block !== undefined) expect(typeof read.block).toBe("string");
        }
      }
      console.log(`placeholders ${name}: ${total}`, Object.fromEntries(kinds));
      expect(total).toBeGreaterThan(0);
    });
  }
});

// ── Findings of the driver review ────────────────────────────────────────────────────────────────

describe("replacePlaceholders counts and reports every occurrence", () => {
  const stats = () => ({ replaced: new Map<string, number>(), left: new Map<string, number>() });
  const unresolved = (report: ReturnType<typeof createReport>) =>
    report.entries().filter((e) => e.code === "placeholder.unresolved");

  test("the same node object in two places of the input is two placeholders, and both are reported", () => {
    const shortcode = el("wp2jx-shortcode", { attributes: { "data-shortcode": "x" } });
    const report = createReport();
    const s = stats();
    const out = replacePlaceholders(
      [el("div", { children: [shortcode, el("p"), shortcode] })],
      {},
      { report, stats: s },
    );
    expect(collectPlaceholders(out).get("wp2jx-shortcode")).toBe(2);
    expect(s.left.get("wp2jx-shortcode")).toBe(2);
    expect(unresolved(report)).toHaveLength(2);
  });

  test("a resolver that answers with one cached node for two placeholders leaves, counts and reports two of what it holds", () => {
    const shared = el("nav", { children: [el("wp2jx-shortcode")] });
    const report = createReport();
    const s = stats();
    const out = replacePlaceholders(
      [el("wp2jx-menu"), el("wp2jx-menu")],
      { menu: () => shared },
      { report, stats: s },
    );
    expect(collectPlaceholders(out).get("wp2jx-shortcode")).toBe(2);
    expect(s.replaced.get("wp2jx-menu")).toBe(2);
    expect(s.left.get("wp2jx-shortcode")).toBe(2);
    expect(unresolved(report)).toHaveLength(2);
    // the cache is not modified
    expect(shared.children).toEqual([el("wp2jx-shortcode")]);
  });

  test("one node twice in a single answer is walked twice", () => {
    const shared = el("wp2jx-block");
    const report = createReport();
    const s = stats();
    replacePlaceholders([el("wp2jx-menu")], { menu: () => [shared, shared] }, { report, stats: s });
    expect(s.left.get("wp2jx-block")).toBe(2);
    expect(unresolved(report)).toHaveLength(2);
  });

  test("what a resolver hands back from its own children is still not walked twice, at any depth of them", () => {
    const report = createReport();
    const s = stats();
    replacePlaceholders(
      [el("wp2jx-shortcode", { children: [el("section", { children: [el("wp2jx-block")] })] })],
      {
        // the grandchild comes back inside a new wrapper
        shortcode: (p) => el("div", { children: p.element.children as JxNode[] }),
      },
      { report, stats: s },
    );
    expect(unresolved(report)).toHaveLength(1);
    expect(s.left.get("wp2jx-block")).toBe(1);
  });
});

describe("replacePlaceholders cuts a part that contains itself at the first repeat", () => {
  const part = (slug: string): JxElement =>
    el("wp2jx-template-part", { attributes: { slug, theme: "t" } });
  const cycles = (report: ReturnType<typeof createReport>) =>
    report.entries().filter((e) => e.code === "placeholder.cycle");

  test("a part that embeds itself twice costs one resolution and one report, not 2^maxDepth of each", () => {
    let calls = 0;
    const report = createReport();
    const left = new Map<string, number>();
    const replaced = new Map<string, number>();
    const out = replacePlaceholders(
      [part("a")],
      {
        "template-part": (p) => (
          calls++,
          el("div", { children: [part(p.attrs.slug!), part(p.attrs.slug!)] })
        ),
      },
      { report, stats: { replaced, left } },
    );
    expect(calls).toBe(1);
    expect(cycles(report)).toHaveLength(1);
    expect(cycles(report)[0]).toMatchObject({
      severity: "error",
      data: { tag: "wp2jx-template-part", attributes: { slug: "a" } },
    });
    expect(replaced.get("wp2jx-template-part")).toBe(1);
    // both copies are cut and left in place for the report to account for
    expect(left.get("wp2jx-template-part")).toBe(2);
    expect(collectPlaceholders(out).get("wp2jx-template-part")).toBe(2);
  });

  test("with a branching factor of four and the default depth it still returns at once", () => {
    let calls = 0;
    const report = createReport();
    const started = performance.now();
    replacePlaceholders(
      [part("a")],
      {
        "template-part": (p) => (
          calls++,
          el("div", { children: [1, 2, 3, 4].map(() => part(p.attrs.slug!)) })
        ),
      },
      { report },
    );
    expect(calls).toBe(1);
    expect(cycles(report)).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("two parts that embed each other are cut when the first comes round again", () => {
    const calls: string[] = [];
    const report = createReport();
    const out = replacePlaceholders(
      [part("a")],
      {
        "template-part": (p) => {
          calls.push(p.attrs.slug!);
          return el("div", { children: [part(p.attrs.slug === "a" ? "b" : "a")] });
        },
      },
      { report },
    );
    expect(calls).toEqual(["a", "b"]);
    expect(cycles(report)).toHaveLength(1);
    expect(cycles(report)[0]).toMatchObject({ data: { attributes: { slug: "a" } } });
    expect(collectPlaceholders(out).get("wp2jx-template-part")).toBe(1);
  });

  test("a placeholder is the same one however its attributes are ordered", () => {
    const report = createReport();
    let calls = 0;
    replacePlaceholders(
      [el("wp2jx-template-part", { attributes: { slug: "a", theme: "t" } })],
      {
        "template-part": () => (
          calls++,
          el("div", {
            children: [el("wp2jx-template-part", { attributes: { theme: "t", slug: "a" } })],
          })
        ),
      },
      { report },
    );
    expect(calls).toBe(1);
    expect(cycles(report)).toHaveLength(1);
  });

  test("the same placeholder side by side, or one after another, is not a cycle", () => {
    const report = createReport();
    const s = { replaced: new Map<string, number>(), left: new Map<string, number>() };
    const out = replacePlaceholders(
      [part("a"), part("a"), el("div", { children: [part("a"), part("b"), part("a")] })],
      { "template-part": (p) => el("b", { textContent: p.attrs.slug! }) },
      { report, stats: s },
    );
    expect(report.entries()).toEqual([]);
    expect(s.replaced.get("wp2jx-template-part")).toBe(5);
    expect(collectPlaceholders(out).size).toBe(0);
  });

  test("a placeholder that differs in any attribute is another thing: a chain of distinct parts is not cut", () => {
    const report = createReport();
    const out = replacePlaceholders(
      [part("p0")],
      {
        "template-part": (p) => {
          const n = Number(p.attrs.slug!.slice(1));
          return n < 5 ? el("div", { children: [part(`p${n + 1}`)] }) : el("end");
        },
      },
      { report },
    );
    expect(report.entries()).toEqual([]);
    expect([...walkElements(out)].map((e) => e.tagName).at(-1)).toBe("end");
  });

  test("maxDepth stays the backstop, and is exact: a chain exactly that deep is whole, one more is cut", () => {
    const chain = (length: number) => (p: Placeholder) => {
      const n = Number(p.attrs.slug!.slice(1));
      return n < length ? el("div", { children: [part(`p${n + 1}`)] }) : el("end");
    };
    // p0 resolves at depth 0, p1 at 1, p2 at 2: with maxDepth 2 the answer of p2 is the last that is not walked
    const whole = createReport();
    const a = replacePlaceholders(
      [part("p0")],
      { "template-part": chain(2) },
      { report: whole, maxDepth: 2 },
    );
    expect(whole.entries()).toEqual([]);
    expect([...walkElements(a)].map((e) => e.tagName).at(-1)).toBe("end");

    const cut = createReport();
    const s = { replaced: new Map<string, number>(), left: new Map<string, number>() };
    const b = replacePlaceholders(
      [part("p0")],
      { "template-part": chain(3) },
      { report: cut, maxDepth: 2, stats: s },
    );
    expect(cycles(cut)).toHaveLength(1);
    expect(cycles(cut)[0]).toMatchObject({ data: { tag: "wp2jx-template-part", depth: 2 } });
    expect(s.replaced.get("wp2jx-template-part")).toBe(3);
    expect(s.left.get("wp2jx-template-part")).toBe(1);
    expect(collectPlaceholders(b).get("wp2jx-template-part")).toBe(1);
    expect(String(cycles(cut)[0]!.message)).toContain("2 levels deep");
  });
});
