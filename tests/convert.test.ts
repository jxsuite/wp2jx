/**
 * The conversion driver over fakes (to pin each rule) and over every subject of both fixture sites
 * (to hold it to the data): dispatch and fallback, override merging, the final passes, determinism,
 * and a real `jx build` of converted pages checked against the rendered live pages.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromHtml } from "hast-util-from-html";
import type { Nodes as HastNodes } from "hast";
import {
  convertBlocks,
  convertSubject,
  converters,
  dedupeRules,
  ensureConverters,
  loadConverterModule,
  registerConverters,
  reportRegistry,
  texturizeNodes,
  withOverrides,
  withRegistry,
  type Converted,
  type RegistryStatus,
} from "../src/convert.ts";
import { coreConverters } from "../src/core/blocks.ts";
import { texturize } from "../src/cwicly/tokens.ts";
import { bindingMarker, finishNodes } from "../src/jx-util.ts";
import {
  collectPlaceholders,
  readPlaceholder,
  replacePlaceholders,
  walkElements,
} from "../src/placeholders.ts";
import { createReport } from "../src/report.ts";
import {
  allSubjects,
  loadSiteContext,
  partTag,
  reusableTag,
  siteTags,
  subjectCtx,
  type SiteContext,
  type Subject,
} from "../src/site.ts";
import type {
  BlockConverter,
  ConvertCtx,
  JxElement,
  JxNode,
  WpBlock,
  WpPost,
} from "../src/types.ts";
import { parseBlocks } from "../src/wp/blocks.ts";
import { decodeEntities } from "../src/wp/model.ts";
import { loadSite, type SiteName } from "./helpers/ctx.ts";
import { FIXTURES, fixtureDb } from "./helpers/fixture-db.ts";
import {
  TMP_ROOT,
  buildJxProject,
  cleanupJxProjects,
  stubCollections,
  validateJxProject,
} from "./helpers/jx-build.ts";

setDefaultTimeout(180_000);
afterAll(cleanupJxProjects);

const el = (tagName: string, rest: Record<string, unknown> = {}): JxElement =>
  ({ tagName, ...rest }) as JxElement;
const block = (name: string | null, rest: Partial<WpBlock> = {}): WpBlock => ({
  name,
  attrs: {},
  innerBlocks: [],
  innerHTML: "",
  innerContent: [],
  ...rest,
});

/** A site with one more post in its model: the subject whose blocks a test controls. */
function withPost(
  site: SiteContext,
  id: number,
  content: string,
  patch: Partial<WpPost> = {},
): SiteContext {
  const posts = new Map(site.model.posts);
  posts.set(id, {
    id,
    type: "page",
    status: "publish",
    slug: `probe-${id}`,
    title: "Probe",
    content,
    excerpt: "",
    date: "2024-01-01T00:00:00Z",
    modified: "2024-01-01T00:00:00Z",
    parent: 0,
    menuOrder: 0,
    authorId: 1,
    guid: "",
    passwordProtected: false,
    ...patch,
  });
  return { ...site, model: { ...site.model, posts } };
}

const PROBE = 990001;
const blocksOf = (...names: string[]): string => names.map((n) => `<!-- wp:${n} /-->`).join("\n");

// ── The registry ─────────────────────────────────────────────────────────────────────────────────

describe("the registry", () => {
  test("it starts as the core converters and ensureConverters adds each Cwicly module that exists", async () => {
    const status = await ensureConverters();
    expect(status.map((s) => s.module)).toEqual(["layout", "interactive", "data"]);
    for (const name of Object.keys(coreConverters))
      expect(converters[name]).toBe(coreConverters[name]!);
    for (const entry of status) {
      if (entry.loaded) {
        expect(entry.blocks).toBeGreaterThan(0);
        expect(entry.error).toBeUndefined();
      } else {
        expect(entry.blocks).toBe(0);
        expect(entry.error).toBeDefined();
      }
    }
    // a loaded module's blocks are registered under their own names
    const loaded = status.filter((s) => s.loaded).reduce((sum, s) => sum + s.blocks, 0);
    const cwicly = Object.keys(converters).filter((n) => n.startsWith("cwicly/"));
    expect(cwicly.length).toBeGreaterThanOrEqual(loaded === 0 ? 0 : 1);
    // idempotent: the same answer, the same promise
    expect(await ensureConverters()).toBe(status);
    expect(ensureConverters()).toBe(ensureConverters());
  });

  test("a converter module loads into the registry, or is a status that says why not", async () => {
    const dir = join(TMP_ROOT, `registry-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    try {
      const write = (name: string, text: string): string => {
        const path = join(dir, name);
        writeFileSync(path, text);
        return path;
      };
      const good = write(
        "good.ts",
        `export const fakeConverters = {
          "fake/one": () => ["one"],
          "fake/two": () => ["two"],
          notAConverter: 42,
        };`,
      );
      const loaded = await loadConverterModule({
        name: "fake",
        path: good,
        export: "fakeConverters",
      });
      expect(loaded).toEqual({ module: "fake", loaded: true, blocks: 2 });
      expect(converters["fake/one"]!(block("fake/one"), undefined as never)).toEqual(["one"]);
      expect("notAConverter" in converters).toBe(false);

      const noExport = await loadConverterModule({
        name: "bare",
        path: good,
        export: "missingTable",
      });
      expect(noExport).toMatchObject({ module: "bare", loaded: false, blocks: 0 });
      expect(noExport.error).toContain("does not export missingTable");

      const broken = write("broken.ts", "export const brokenConverters = {{{");
      const syntax = await loadConverterModule({
        name: "broken",
        path: broken,
        export: "brokenConverters",
      });
      expect(syntax).toMatchObject({ module: "broken", loaded: false, blocks: 0 });
      expect(syntax.error).toBeTruthy();

      const throws = write("throws.ts", `throw new Error("boom at import"); export const x = {};`);
      expect(
        (await loadConverterModule({ name: "throws", path: throws, export: "x" })).error,
      ).toContain("boom at import");

      const missing = await loadConverterModule({
        name: "gone",
        path: join(dir, "nope.ts"),
        export: "x",
      });
      expect(missing).toMatchObject({ module: "gone", loaded: false, blocks: 0 });
      expect(missing.error).toContain("nope.ts");
      expect(Object.keys(converters).some((name) => name.startsWith("broken"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a module that is missing is an error in the site's report, once, and nothing else is", () => {
    const status: RegistryStatus[] = [
      { module: "layout", loaded: true, blocks: 5 },
      { module: "data", loaded: false, blocks: 0, error: "Cannot find module" },
    ];
    const report = createReport();
    reportRegistry(report, status);
    reportRegistry(report, status);
    expect(report.entries()).toHaveLength(1);
    expect(report.entries()[0]).toMatchObject({
      severity: "error",
      code: "site.registry-incomplete",
      where: "site",
      data: { module: "data", error: "Cannot find module" },
    });
    const clean = createReport();
    reportRegistry(clean, [{ module: "layout", loaded: true, blocks: 1 }]);
    expect(clean.entries()).toEqual([]);
  });

  test("registerConverters adds and replaces", () => {
    const a: BlockConverter = () => ["a"];
    const b: BlockConverter = () => ["b"];
    registerConverters({ "test/reg": a });
    expect(converters["test/reg"]).toBe(a);
    registerConverters({ "test/reg": b });
    expect(converters["test/reg"]).toBe(b);
  });
});

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────────

describe("convertBlocks", () => {
  const siteOf = async (name: SiteName): Promise<SiteContext> => loadSite(name);

  test("each block goes to the converter registered under its name, in order, and freeform to core/freeform", async () => {
    const ctx = await subjectCtx(await siteOf("fineline"), { kind: "post", id: 5246 });
    const calls: string[] = [];
    const registry = {
      "x/one": (b: WpBlock) => (calls.push(`one:${b.attrs.n}`), ["1"]),
      "x/two": () => (calls.push("two"), ["2", "2b"]),
      "core/freeform": () => (calls.push("freeform"), ["classic"]),
    };
    const out = convertBlocks(
      [
        block("x/two"),
        block("x/one", { attrs: { n: 1 } }),
        block(null, { innerHTML: "<p>x</p>" }),
        block("x/one", { attrs: { n: 2 } }),
      ],
      ctx,
      registry,
    );
    expect(out).toEqual(["2", "2b", "1", "classic", "1"]);
    expect(calls).toEqual(["two", "one:1", "freeform", "one:2"]);
  });

  test("a registry name that is also an Object.prototype name is not looked up through the prototype", async () => {
    const ctx = await subjectCtx(await siteOf("fineline"), { kind: "post", id: 5246 });
    const report = ctx.report;
    const out = convertBlocks(
      [block("constructor", { innerHTML: "<p>kept</p>", innerContent: ["<p>kept</p>"] })],
      ctx,
      {},
    );
    expect(JSON.stringify(out)).toContain("kept");
    expect(report.entries().some((e) => e.code === "block.unsupported")).toBe(true);
  });

  test("a legacy embed goes to core/embed", async () => {
    const ctx = await subjectCtx(await siteOf("ap"), { kind: "post", id: 1 });
    const seen: (string | null)[] = [];
    const out = convertBlocks([block("core-embed/youtube")], ctx, {
      "core/embed": (b) => (seen.push(b.name), ["embedded"]),
    });
    expect(out).toEqual(["embedded"]);
    expect(seen).toEqual(["core-embed/youtube"]);
  });

  test("an unknown block keeps its saved markup and its inner blocks, and is reported", async () => {
    const site = await siteOf("ap");
    const ctx = await subjectCtx(site, { kind: "post", id: 2 });
    const inner = block("x/inner", { innerHTML: "<p>inside</p>", innerContent: ["<p>inside</p>"] });
    const outer = block("x/outer", {
      innerHTML: '<section class="wrap"></section>',
      innerContent: ['<section class="wrap">', null, "</section>"],
      innerBlocks: [inner],
    });
    const registry = { "x/inner": () => [el("p", { textContent: "inside-converted" })] };
    const out = convertBlocks([outer], withRegistry(ctx, registry), registry);
    const text = JSON.stringify(out);
    expect(text).toContain("wrap");
    expect(text).toContain("inside-converted");
    expect(ctx.report.entries().filter((e) => e.code === "block.unsupported")).toHaveLength(1);
    expect(ctx.report.entries()).toContainEqual(
      expect.objectContaining({
        severity: "warn",
        code: "block.unsupported",
        where: "post:2",
        data: { block: "x/outer", kept: true },
      }),
    );
  });

  test("an unknown block that saved nothing becomes a wp2jx-block placeholder with its name and attributes", async () => {
    const ctx = await subjectCtx(await siteOf("ap"), { kind: "post", id: 3 });
    const out = convertBlocks(
      [block("vendor/dynamic", { attrs: { id: 7, note: "a${b}" } })],
      ctx,
      {},
    );
    expect(out).toHaveLength(1);
    const read = readPlaceholder(out[0]!)!;
    expect(read.tag).toBe("wp2jx-block");
    expect(read.block).toBe("vendor/dynamic");
    expect(read.blockAttrs).toEqual({ id: 7, note: "a${b}" });
    expect(JSON.stringify(out).includes("a${b}")).toBe(false);
    expect(ctx.report.entries().find((e) => e.code === "block.unsupported")).toMatchObject({
      severity: "warn",
      data: { block: "vendor/dynamic", kept: false },
    });
  });

  test("a converter that throws is reported and the block takes the fallback; its siblings are unaffected", async () => {
    const ctx = await subjectCtx(await siteOf("ap"), { kind: "post", id: 4 });
    const registry = {
      "x/boom": () => {
        throw new Error("kaput");
      },
      "x/fine": () => ["fine"],
      "x/string": () => {
        throw "plain string";
      },
    };
    const out = convertBlocks(
      [
        block("x/fine"),
        block("x/boom", { innerHTML: "<p>saved</p>", innerContent: ["<p>saved</p>"] }),
        block("x/string"),
        block("x/fine"),
      ],
      ctx,
      registry,
    );
    expect(out[0]).toBe("fine");
    expect(out.at(-1)).toBe("fine");
    expect(JSON.stringify(out)).toContain("saved");
    const entries = ctx.report.entries();
    expect(
      entries
        .filter((e) => e.code === "block.converter-error")
        .map((e) => (e.data as { error: string }).error),
    ).toEqual(["kaput", "plain string"]);
    expect(entries.find((e) => e.code === "block.converter-error")).toMatchObject({
      severity: "error",
      where: "post:4",
    });
    expect(entries.filter((e) => e.code === "block.unsupported")).toHaveLength(2);
  });

  test("a converter that recurses without end is cut, reported, and the depth counter recovers", async () => {
    const ctx = await subjectCtx(await siteOf("ap"), { kind: "post", id: 5 });
    const registry: Record<string, BlockConverter> = {
      "x/loop": (b, c) => c.convert([b]),
      "x/ok": () => ["ok"],
    };
    const bound = withRegistry(ctx, registry);
    expect(bound.convert([block("x/loop")])).toEqual([]);
    const errors = ctx.report.entries().filter((e) => e.code === "block.too-deep");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toMatchObject({ severity: "error" });
    // the counter went back down: an ordinary conversion afterwards works
    expect(bound.convert([block("x/ok")])).toEqual(["ok"]);
  });

  test("withRegistry binds a context's convert to a registry, overrides included", async () => {
    const ctx = await subjectCtx(await siteOf("fineline"), { kind: "post", id: 5246 });
    const registry: Record<string, BlockConverter> = {
      "x/parent": (b, c) => c.convert(b.innerBlocks, { entryExpr: "$map.item" }),
      "x/leaf": (_b, c) => [c.entryExpr],
    };
    const bound = withRegistry(ctx, registry);
    expect(
      bound.convert([block("x/leaf"), block("x/parent", { innerBlocks: [block("x/leaf")] })]),
    ).toEqual(["state.entry", "$map.item"]);
    expect(ctx.entryExpr).toBe("state.entry");
    expect(bound).not.toBe(ctx);
  });

  test("withOverrides lays overrides over the context and carries them down; an overridden convert is the caller's", async () => {
    const ctx = await subjectCtx(await siteOf("fineline"), { kind: "post", id: 5246 });
    const next = withOverrides(ctx, { mode: "entry", rowExpr: "$map.row" });
    expect(next).toMatchObject({ mode: "entry", rowExpr: "$map.row", entryExpr: "state.entry" });
    expect(ctx.mode).toBe("static");
    const mine = withOverrides(ctx, { convert: () => ["mine"] });
    expect(mine.convert([])).toEqual(["mine"]);
  });
});

// ── Texturize ────────────────────────────────────────────────────────────────────────────────────

describe("texturizeNodes", () => {
  const one = (node: JxElement): JxElement => texturizeNodes([node])[0] as JxElement;

  test("text, children strings and the text between the tags of an innerHTML are texturized", () => {
    const out = one(
      el("div", {
        textContent: 'Don\'t "quote" me - ever...',
        children: [el("p", { textContent: "It's 9x9" }), "He said 'hi'"],
        innerHTML: '<p class="x" data-q="it\'s">It\'s <b>5 - 6</b></p>',
      }),
    );
    expect(out.textContent).toBe("Don’t “quote” me – ever…");
    expect(((out.children as JxNode[])[0] as JxElement).textContent).toBe("It’s 9×9");
    expect((out.children as JxNode[])[1]).toBe("He said ‘hi’");
    // attributes inside the markup are untouched, the text around them is not
    expect(out.innerHTML).toBe('<p class="x" data-q="it\'s">It’s <b>5 – 6</b></p>');
  });

  test("attributes, style, ids and class names are never touched", () => {
    const node = el("a", {
      textContent: "plain",
      className: "it's-a-class",
      id: "don't",
      attributes: {
        title: 'Don\'t "go"',
        "aria-label": "5 - 6...",
        href: "/it's-a-path?x=1&y='2'",
      },
      style: { "--q": "'it's'", content: '"don\'t"' },
    });
    expect(one(node)).toBe(node);
  });

  test("pre, code, kbd, tt, script, style and textarea are skipped, with everything inside them", () => {
    for (const tag of ["pre", "code", "kbd", "tt", "script", "style", "textarea"]) {
      const node = el(tag, {
        textContent: 'it\'s "x" - y...',
        children: [el("span", { textContent: "don't" })],
        innerHTML: "it's <i>a</i>",
      });
      expect(one(node)).toBe(node);
      const wrapped = el("div", { children: [node, el("p", { textContent: "it's" })] });
      const out = one(wrapped);
      expect((out.children as JxNode[])[0]).toBe(node);
      expect(((out.children as JxNode[])[1] as JxElement).textContent).toBe("it’s");
    }
    // inside an innerHTML string the markup rule skips them, too
    const out = one(
      el("div", { innerHTML: "<p>it's</p><pre>it's</pre><code>it's</code><p>it's</p>" }),
    );
    expect(out.innerHTML).toBe("<p>it’s</p><pre>it's</pre><code>it's</code><p>it’s</p>");
  });

  test("a binding is held out of the way: its own quotes and operators are untouched, the text around it is texturized", () => {
    const out = one(
      el("p", {
        textContent: "Don't ${state.entry.data.title ?? ''} - it's 'x' ${a ? \"b's\" : `c`}...",
        innerHTML: "<b>It's</b> ${state.entry.data.html ?? ''} - done",
        children: ["won't ${x ?? 'y'}"],
      }),
    );
    expect(out.textContent).toBe(
      "Don’t ${state.entry.data.title ?? ''} – it’s ‘x’ ${a ? \"b's\" : `c`}…",
    );
    expect(out.innerHTML).toBe("<b>It’s</b> ${state.entry.data.html ?? ''} – done");
    expect((out.children as JxNode[])[0]).toBe("won’t ${x ?? 'y'}");
    // a binding whose braces nest and a template literal inside one are one binding
    expect(one(el("p", { textContent: "'${({a: {b: 1}}).a.b}' it's" })).textContent).toBe(
      "‘${({a: {b: 1}}).a.b}’ it’s",
    );
    // an unbalanced one runs to the end and is left alone rather than damaged
    expect(one(el("p", { textContent: "x's ${oops 'y" })).textContent).toBe("x’s ${oops 'y");
  });

  test("a text wptexturize already wrote is left as it is, because a second pass is not the first", () => {
    // `'"` closes a quotation inside a quotation: the real function keeps the straight single quote, and
    // read again beside the curly one it would become an apostrophe (anabaptistperspectives post 11976)
    const written = texturize("He said: ‘Worship the Lord your God, and serve him only.'\"");
    expect(written).toBe("He said: ‘Worship the Lord your God, and serve him only.'”");
    expect(texturize(written)).not.toBe(written);
    expect(one(el("em", { textContent: written })).textContent).toBe(written);
    expect(one(el("em", { innerHTML: `<b>${written}</b>` })).innerHTML).toBe(`<b>${written}</b>`);
    // the same raw text, never texturized, is texturized
    expect(one(el("em", { textContent: "He said: 'Worship'" })).textContent).toBe(
      "He said: ‘Worship’",
    );
  });

  test("it is a copy: the input is not modified and an unchanged subtree is shared", () => {
    const stable = el("footer", { children: [el("p", { textContent: "nothing to do" })] });
    const changed = el("p", { textContent: "it's" });
    const input = [stable, el("div", { children: [changed] }), "x"];
    const out = texturizeNodes(input);
    expect(out[0]).toBe(stable);
    expect(out[2]).toBe("x");
    expect(changed.textContent).toBe("it's");
    expect(((out[1] as JxElement).children as JxElement[])[0]!.textContent).toBe("it’s");
    expect(texturizeNodes(out)[0]).toBe(stable);
  });

  test("a repeater's template, an element's own map and the cases of a switch are texturized", () => {
    const repeater = el("ul", {
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/x" },
        map: el("li", { textContent: "it's ${$map.item.name}" }),
      },
    });
    const out = one(repeater);
    expect((out.children as unknown as { map: JxElement }).map.textContent).toBe(
      "it’s ${$map.item.name}",
    );
    expect((out.children as unknown as { items: unknown }).items).toEqual({ $ref: "#/state/x" });
    const own = one({
      tagName: "ul",
      map: el("li", { textContent: "it's" }),
    } as unknown as JxElement);
    expect((own as unknown as { map: JxElement }).map.textContent).toBe("it’s");
    const cases = one(
      el("div", {
        cases: { a: el("p", { textContent: "it's" }), b: el("p", { textContent: "plain" }) },
      }),
    );
    expect((cases.cases as Record<string, JxElement>).a!.textContent).toBe("it’s");
  });

  test("text with nothing to do is the same string, and every kind of markup character is kept", () => {
    const node = el("p", {
      textContent: "plain text, 100% fine & <b> not markup",
      innerHTML: "a &amp; b &lt;i&gt; <br/>",
    });
    expect(one(node)).toBe(node);
  });

  test("real paragraphs that were never texturized come out as the live page printed them", () => {
    // The saved markup of every paragraph the rendered pages show, with its curly quotes made straight
    // again (the form a converter that forgot to texturize would hand over), through the innerHTML path:
    // inline tags, entities and no-break spaces included. Compared with what WordPress printed.
    const straight = (t: string): string =>
      t.replaceAll(/[\u2018\u2019]/g, "'").replaceAll(/[\u201C\u201D]/g, '"');
    const plain = (html: string): string =>
      decodeEntities(html.replaceAll(/<br\s*\/?>/gi, " ").replaceAll(/<[^>]*>/g, ""))
        .replaceAll(/[\s\u00a0]+/g, " ")
        .trim();
    const lookup = (t: string): string =>
      t.replaceAll(/[\u2018\u2019\u201C\u201D]/g, "").replaceAll(/[^A-Za-z0-9]/g, "");
    const checked = { agree: 0, total: 0, wrong: [] as string[] };
    for (const site of ["ap", "fineline"] as const) {
      const rows = JSON.parse(readFileSync(join(FIXTURES, site, "rows/posts.json"), "utf8")) as {
        post_content: string;
      }[];
      const live = new Map<string, string>();
      for (const f of readdirSync(join(FIXTURES, site, "html"))) {
        for (const p of paragraphs(readFileSync(join(FIXTURES, site, "html", f), "utf8")))
          live.set(lookup(p), p);
      }
      for (const row of rows) {
        for (const b of parseBlocks(row.post_content)) {
          if (b.name !== "core/paragraph" && b.name !== "cwicly/paragraph") continue;
          const m = /^\s*<p[^>]*>([\s\S]*)<\/p>\s*$/.exec(b.innerHTML);
          if (!m || plain(m[1]!).length < 40) continue;
          const printed = live.get(lookup(plain(m[1]!)));
          if (printed === undefined) continue;
          checked.total++;
          const out = texturizeNodes([
            el("p", { innerHTML: straight(m[1]!.trim()) }),
          ])[0] as JxElement;
          const ours = plain(out.innerHTML as string);
          if (ours === printed) checked.agree++;
          else checked.wrong.push(`${printed}\n  ours ${ours}`);
        }
      }
    }
    console.log(
      `texturize against the live pages: ${checked.agree} of ${checked.total} paragraphs agree`,
    );
    expect(checked.total).toBeGreaterThan(100);
    expect(checked.wrong).toEqual([]);
  });
});

/** The paragraphs of a rendered page, whitespace and no-break spaces normalised. */
function paragraphs(html: string): string[] {
  const out: string[] = [];
  const text = (node: HastNodes): string =>
    node.type === "text"
      ? node.value
      : node.type === "element" && node.tagName === "br"
        ? " "
        : "children" in node
          ? node.children.map(text).join("")
          : "";
  const walk = (node: HastNodes): void => {
    if (node.type === "element") {
      if (["script", "style", "noscript"].includes(node.tagName)) return;
      if (node.tagName === "p")
        out.push(
          text(node)
            .replaceAll(/[\s ]+/g, " ")
            .trim(),
        );
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(fromHtml(html));
  return out.filter((p) => p.length > 0);
}

// ── What a tree uses ─────────────────────────────────────────────────────────────────────────────

describe("dedupeRules", () => {
  /** The colour a later-wins cascade gives `.x`: the last rule of the list that sets it. */
  const winner = (
    rules: readonly { selector: string; style: Record<string, unknown> }[],
  ): unknown => rules.filter((r) => r.selector === ".x").at(-1)?.style.color;

  test("the same selector with the same declarations once, the last of them kept; a different style is kept", () => {
    const a = { selector: ".a", style: { color: "red" } };
    const rules = [
      a,
      { selector: ".b", style: { color: "red" } },
      { selector: ".a", style: { color: "red" } },
      { selector: ".a", style: { color: "blue" } },
      a,
    ];
    // .a red appears three times; its last occurrence (the last entry) is the one that stays
    expect(dedupeRules(rules)).toEqual([rules[1]!, rules[3]!, a]);
    expect(dedupeRules([])).toEqual([]);
    // adjacent and distinct rules keep their order
    const x = { selector: ".x", style: { color: "red" } };
    const y = { selector: ".y", style: { color: "red" } };
    expect(dedupeRules([x, x, y])).toEqual([x, y]);
    expect(dedupeRules([x, y])).toEqual([x, y]);
  });

  test("A, B, A keeps the cascade: dropping the later A would hand the win to B", () => {
    const red = { selector: ".x", style: { color: "red" } };
    const blue = { selector: ".x", style: { color: "blue" } };
    const rules = [red, blue, { selector: ".x", style: { color: "red" } }];
    expect(winner(rules)).toBe("red");
    const out = dedupeRules(rules);
    expect(out).toEqual([blue, red]);
    expect(winner(out)).toBe("red");
    // it is a fixed point: the emitters dedupe the result again
    expect(dedupeRules(out)).toEqual(out);
  });
});

// ── convertSubject over a subject the test controls ──────────────────────────────────────────────

describe("convertSubject", () => {
  test("it converts the subject's blocks and applies the final passes in order", async () => {
    const site = withPost(
      await loadSite("fineline"),
      PROBE,
      blocksOf(
        "test/finish",
        "test/state",
        "test/hoist",
        "test/hoist",
        "test/uses",
        "test/classes",
        "test/plain",
      ),
    );
    registerConverters({
      // a binding that crossed an HTML conversion as a marker, in text that wptexturize would curl
      "test/finish": () => [
        {
          tagName: "p",
          textContent: `Don't ${bindingMarker("state.entry.data.title ?? ''")} - it's`,
          children: [`plain ${bindingMarker("state.x ?? ''")}`],
        } as JxElement,
      ],
      "test/state": (_b, ctx) => {
        const key = (ctx as unknown as { defineState(k: string, d: unknown): string }).defineState(
          "rows",
          { $prototype: "ContentCollection", contentType: "project" },
        );
        return [
          {
            tagName: "ul",
            children: {
              $prototype: "Array",
              items: { $ref: `#/state/${key}` },
              map: { tagName: "li", textContent: "x" },
            },
          } as unknown as JxElement,
        ];
      },
      "test/hoist": (_b, ctx) => {
        ctx.hoist?.({
          selector: "@keyframes spin",
          style: { from: { transform: "rotate(0)" } } as never,
        });
        ctx.hoist?.({ selector: ".x", style: { color: "red" } });
        return [];
      },
      "test/uses": (_b, ctx) => {
        const info = [...ctx.components.values()][0]!;
        return [
          el(info.tagName, { $props: { label: "x" } }),
          el(info.tagName),
          el("fp-unknown"),
          el(partTag(site, "header")),
          el(reusableTag(site, 63)),
        ];
      },
      "test/classes": () => [
        el("div", {
          className: "a b",
          innerHTML: '<i class="c d"></i>',
          children: [el("span", { attributes: { class: "e" } })],
        }),
      ],
      "test/plain": () => [el("wp2jx-menu", { attributes: { "data-menu": "3" } })],
    });
    const out: Converted = await convertSubject(site, { kind: "post", id: PROBE });
    const [paragraph, list] = out.nodes as JxElement[];
    // bindings finished (and the text around them curled), once
    expect(paragraph!.textContent).toBe("Don’t ${state.entry.data.title ?? ''} – it’s");
    expect(((paragraph!.children as JxNode[])[0] as JxElement).textContent).toBe(
      "plain ${state.x ?? ''}",
    );
    expect(JSON.stringify(out.nodes).includes("\uE000")).toBe(false);
    // the post and the subject are on the result
    expect(out.subject).toEqual({ kind: "post", id: PROBE });
    expect(out.post?.id).toBe(PROBE);
    // what the tree uses
    // a component, a part and a reusable block; a tag nobody allocated is not one
    expect([...out.used.components]).toEqual([
      [...site.components.values()][0]!.tagName,
      "wp-header",
      "wp-block-63",
    ]);
    expect([...out.used.wpClasses].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect([...out.used.placeholders]).toEqual(["wp2jx-menu"]);
    expect(Object.fromEntries(out.used.placeholderCounts)).toEqual({ "wp2jx-menu": 1 });
    expect([...out.used.states]).toEqual(["rows"]);
    expect(out.state).toEqual({
      rows: { $prototype: "ContentCollection", contentType: "project" },
    });
    expect([...out.used.cssFiles]).toEqual([
      "cc-global-stylesheets.css",
      "cc-global-classes.css",
      `cc-post-${PROBE}.css`,
    ]);
    // hoisted rules, duplicates removed, in order
    expect(out.hoisted.map((r) => r.selector)).toEqual(["@keyframes spin", ".x"]);
    expect(list).toBeDefined();
    expect(out.css.classes.size).toBeGreaterThan(10);
    expect(out.report.entries().some((e) => e.where === `post:${PROBE}`)).toBe(true);
  });

  test("a state entry a converter registers is used even when no node points at it yet", async () => {
    const site = withPost(await loadSite("ap"), PROBE, blocksOf("test/lonely"));
    registerConverters({
      "test/lonely": (_b, ctx) => {
        (ctx as unknown as { defineState(k: string, d: unknown): string }).defineState("lonely", {
          $prototype: "Array",
          items: [],
        });
        return [];
      },
    });
    const out = await convertSubject(site, { kind: "post", id: PROBE });
    expect([...out.used.states]).toEqual(["lonely"]);
    expect(Object.keys(out.state)).toEqual(["lonely"]);
  });

  test("a state a node points at is used, whoever defined it, and only the key is named", async () => {
    const site = withPost(await loadSite("ap"), PROBE, blocksOf("test/pointer"));
    registerConverters({
      "test/pointer": () => [
        el("ul", {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/hand/rows" },
            map: el("li", {
              attributes: { "data-x": "#/elsewhere/not-state" },
              children: [el("b", { $props: { rows: { $ref: "#/state/other" } } })],
            }),
          },
        }),
      ],
    });
    const out = await convertSubject(site, { kind: "post", id: PROBE });
    expect([...out.used.states].sort()).toEqual(["hand", "other"]);
    expect(out.state).toEqual({});
  });

  test("a literal dollar-brace left marked is reported and split, once", async () => {
    const site = withPost(await loadSite("ap"), PROBE, blocksOf("test/literal"));
    registerConverters({
      "test/literal": () => [
        { tagName: "p", textContent: `cost ${"$"}{5} ${bindingMarker("x")}` } as JxElement,
      ],
    });
    const out = await convertSubject(site, { kind: "post", id: PROBE });
    expect(((out.nodes[0] as JxElement).textContent as string).startsWith("cost $​{5} ${x}")).toBe(
      true,
    );
    expect(out.report.entries().filter((e) => e.code === "token.literal-template")).toHaveLength(1);
  });

  test("an internal marker that survived a conversion is reported, and not counted as a placeholder", async () => {
    const site = withPost(await loadSite("ap"), PROBE, blocksOf("test/leak"));
    registerConverters({ "test/leak": () => [el("div", { children: [el("wp2jx-inner")] })] });
    const out = await convertSubject(site, { kind: "post", id: PROBE });
    expect(out.used.placeholders.size).toBe(0);
    expect(out.used.placeholderCounts.size).toBe(0);
    expect(out.report.entries().find((e) => e.code === "convert.marker-leaked")).toMatchObject({
      severity: "error",
      where: `post:${PROBE}`,
      data: { marker: "wp2jx-inner", count: 1 },
    });
  });

  test("a subject nothing stands for is reported and converts to nothing", async () => {
    const site = await loadSite("fineline");
    const out = await convertSubject(site, { kind: "template", slug: "no-such-template" });
    expect(out.nodes).toEqual([]);
    expect(out.post).toBeUndefined();
    expect(out.hoisted).toEqual([]);
    expect(out.report.entries().map((e) => [e.severity, e.code, e.where])).toContainEqual([
      "error",
      "subject.missing",
      "template:cwicly//no-such-template",
    ]);
    expect(out.used.cssFiles.has("cc-tp-cwicly_no-such-template.css")).toBe(true);
  });

  test("options replace the defaults of the subject's kind", async () => {
    const site = withPost(await loadSite("fineline"), PROBE, blocksOf("test/echo"), {
      type: "project",
    });
    const seen: Partial<ConvertCtx>[] = [];
    registerConverters({
      "test/echo": (_b, ctx) => {
        seen.push({
          mode: ctx.mode,
          entryExpr: ctx.entryExpr,
          entryType: ctx.entryType as string,
          termExpr: ctx.termExpr as string,
          target: ctx.target as "page",
        });
        return [];
      },
    });
    await convertSubject(site, { kind: "post", id: PROBE });
    await convertSubject(
      site,
      { kind: "post", id: PROBE },
      {
        mode: "entry",
        entryExpr: "$map.item",
        entryType: "service",
        termExpr: "state.term",
        target: "page",
      },
    );
    expect(seen[0]).toEqual({
      mode: "static",
      entryExpr: "state.entry",
      entryType: "project",
      target: "markdown",
    });
    expect(seen[1]).toEqual({
      mode: "entry",
      entryExpr: "$map.item",
      entryType: "service",
      termExpr: "state.term",
      target: "page",
    });
  });

  test("a registry that did not load is reported once in the site's report", async () => {
    const status = await ensureConverters();
    const site = { ...(await loadSite("fineline")), report: createReport() };
    await convertSubject(site, { kind: "part", slug: "header" });
    await convertSubject(site, { kind: "part", slug: "footer" });
    const missing = status.filter((s) => !s.loaded);
    expect(site.report.entries().filter((e) => e.code === "site.registry-incomplete")).toHaveLength(
      missing.length,
    );
  });
});

// ── Both sites, every subject ────────────────────────────────────────────────────────────────────

interface Sweep {
  site: SiteName;
  subjects: Subject[];
  results: Converted[];
  ms: number;
}

const sweeps = new Map<SiteName, Promise<Sweep>>();

function sweep(name: SiteName): Promise<Sweep> {
  let found = sweeps.get(name);
  if (!found) {
    found = (async () => {
      const site = await loadSite(name);
      const subjects = allSubjects(site);
      const start = performance.now();
      const results: Converted[] = [];
      for (const subject of subjects) results.push(await convertSubject(site, subject));
      return { site: name, subjects, results, ms: performance.now() - start };
    })();
    sweeps.set(name, found);
  }
  return found;
}

const elementCount = (nodes: readonly JxNode[]): number => [...walkElements(nodes)].length;

/** Everything a conversion returns, as text: two conversions are the same when this is. */
function digest(r: Converted): string {
  return JSON.stringify({
    nodes: r.nodes,
    hoisted: r.hoisted,
    report: r.report.entries(),
    components: [...r.used.components],
    classes: [...r.used.wpClasses],
    css: [...r.used.cssFiles],
    placeholders: [...r.used.placeholderCounts],
    states: [...r.used.states],
    state: r.state,
  });
}

describe("every subject of both sites", () => {
  for (const name of ["fineline", "ap"] as const) {
    test(`${name}: every subject converts, with totals`, async () => {
      const { subjects, results, ms } = await sweep(name);
      expect(results).toHaveLength(subjects.length);
      const codes = new Map<string, number>();
      let nodes = 0;
      let hoisted = 0;
      let placeholders = 0;
      const placeholderTags = new Map<string, number>();
      for (const r of results) {
        nodes += elementCount(r.nodes);
        hoisted += r.hoisted.length;
        for (const [tag, n] of r.used.placeholderCounts) {
          placeholders += n;
          placeholderTags.set(tag, (placeholderTags.get(tag) ?? 0) + n);
        }
        for (const e of r.report.entries())
          codes.set(`${e.severity} ${e.code}`, (codes.get(`${e.severity} ${e.code}`) ?? 0) + 1);
      }
      const byCode = Object.fromEntries([...codes].sort((a, b) => b[1] - a[1]));
      console.log(
        `convert ${name}: ${subjects.length} subjects, ${nodes} elements, ${hoisted} hoisted rules, ${placeholders} placeholders, ${Math.round(ms)} ms\n  placeholders ${JSON.stringify(Object.fromEntries(placeholderTags))}\n  reports ${JSON.stringify(byCode)}`,
      );
      expect(nodes).toBeGreaterThan(3000);
      // the whole of a site converts in seconds, not minutes (generous: a busy shared machine)
      expect(ms).toBeLessThan(30_000);
    });

    test(`${name}: nothing broke on the way, and nothing leaked`, async () => {
      const { subjects, results } = await sweep(name);
      const bad: string[] = [];
      results.forEach((r, i) => {
        for (const e of r.report.entries()) {
          if (
            [
              "block.converter-error",
              "block.too-deep",
              "convert.marker-leaked",
              "subject.missing",
              "placeholder.unresolved",
            ].includes(e.code)
          ) {
            bad.push(`${JSON.stringify(subjects[i])} ${e.code}: ${e.message}`);
          }
        }
        for (const e of r.report.entries()) {
          expect(["info", "warn", "error"]).toContain(e.severity);
          expect(e.code).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/);
          expect(typeof e.where).toBe("string");
        }
      });
      expect(bad).toEqual([]);
    });

    test(`${name}: the nodes are plain JSON, finished, with no private-use marker, no template in a class or id, no double class`, async () => {
      const { subjects, results } = await sweep(name);
      results.forEach((r, i) => {
        const json = JSON.stringify(r.nodes);
        expect(JSON.parse(json)).toEqual(r.nodes);
        expect(Bun.deepEquals(JSON.parse(json), r.nodes, true)).toBe(true);
        expect(/[\uE000\uE001\uE010\uE011]/.test(json)).toBe(false);
        for (const e of walkElements(r.nodes)) {
          const where = `${JSON.stringify(subjects[i])} <${e.tagName}>`;
          if (typeof e.className === "string" && e.className.includes("${"))
            throw new Error(`${where} templated className`);
          if (typeof e.id === "string" && e.id.includes("${"))
            throw new Error(`${where} templated id`);
          if (e.className !== undefined && e.attributes?.class !== undefined)
            throw new Error(`${where} class twice`);
        }
      });
    });

    test(`${name}: converting again gives the same result, and so does a freshly loaded site`, async () => {
      const first = await sweep(name);
      const site = await loadSite(name);
      const { url, prefix } = await fixtureDb(name);
      const fresh = await loadSiteContext({
        db: url,
        prefix,
        cssFrom: { dir: join(FIXTURES, name, "css") },
        componentPrefix: "wp",
        postTypes: [...new Set([...site.model.posts.values()].map((p) => p.type))],
      });
      let compared = 0;
      for (let i = 0; i < first.subjects.length; i += 3) {
        const subject = first.subjects[i]!;
        const again = await convertSubject(site, subject);
        const other = await convertSubject(fresh, subject);
        expect(digest(again)).toBe(digest(first.results[i]!));
        expect(digest(other)).toBe(digest(first.results[i]!));
        compared++;
      }
      expect(compared).toBeGreaterThan(40);
    });

    test(`${name}: the final passes are fixed points on what the converters made`, async () => {
      const { subjects, results } = await sweep(name);
      results.forEach((r, i) => {
        // texturizing, finishing and de-duplicating a finished conversion change nothing
        expect(texturizeNodes(r.nodes), JSON.stringify(subjects[i])).toEqual(r.nodes);
        expect(finishNodes(r.nodes)).toEqual(r.nodes);
        expect(dedupeRules(r.hoisted)).toEqual(r.hoisted);
      });
    });

    test(`${name}: what a conversion says it used is what its nodes hold`, async () => {
      const site = await loadSite(name);
      const { results } = await sweep(name);
      const tags = siteTags(site);
      for (const r of results) {
        expect(Object.fromEntries(r.used.placeholderCounts)).toEqual(
          Object.fromEntries(collectPlaceholders(r.nodes)),
        );
        expect([...r.used.placeholders]).toEqual([...collectPlaceholders(r.nodes).keys()]);
        const present = new Set(
          [...walkElements(r.nodes)].map((e) => e.tagName as string).filter((t) => tags.has(t)),
        );
        expect([...r.used.components].sort()).toEqual([...present].sort());
        expect([...r.used.cssFiles].slice(0, 2)).toEqual([
          "cc-global-stylesheets.css",
          "cc-global-classes.css",
        ]);
        for (const key of Object.keys(r.state)) expect(r.used.states.has(key)).toBe(true);
      }
    });
  }

  test("the whole of both sites converts in seconds", async () => {
    const a = await sweep("fineline");
    const b = await sweep("ap");
    console.log(
      `both sites: ${a.results.length + b.results.length} subjects in ${Math.round(a.ms + b.ms)} ms`,
    );
    expect(a.ms + b.ms).toBeLessThan(40_000);
  });

  test("the text of a Cwicly-free essay is texturized exactly as the live page prints it", async () => {
    // the first paragraph of an essay, converted whole and compared with the rendered page
    const site = await loadSite("ap");
    const essay = [...site.model.posts.values()].find(
      (p) => p.slug === "the-cultural-captivity-of-the-gospel" && p.type === "post",
    )!;
    const out = await convertSubject(site, { kind: "post", id: essay.id });
    const ours = new Set(paragraphsOf(out.nodes));
    const live = paragraphs(
      readFileSync(
        join(FIXTURES, "ap/html/essays__the-cultural-captivity-of-the-gospel.html"),
        "utf8",
      ),
    ).filter((p) => p.length > 60);
    const missing = live.filter((p) => !ours.has(p) && !essayExtras(p));
    console.log(
      `essay: ${live.length} live paragraphs, ${live.length - missing.length} found verbatim in the conversion`,
    );
    expect(live.length).toBeGreaterThan(10);
    expect(missing.length / live.length).toBeLessThan(0.15);
  });
});

/** Paragraph-ish text of converted nodes, normalised the way `paragraphs` normalises a page. */
function paragraphsOf(nodes: readonly JxNode[]): string[] {
  const out: string[] = [];
  const text = (n: JxNode): string => {
    if (typeof n === "string") return n;
    const own =
      typeof n.textContent === "string"
        ? n.textContent
        : typeof n.innerHTML === "string"
          ? decodeEntities(n.innerHTML.replaceAll(/<br\s*\/?>/gi, " ").replaceAll(/<[^>]*>/g, ""))
          : "";
    return (
      own +
      (n.tagName === "br" ? " " : "") +
      (Array.isArray(n.children) ? n.children.map(text).join("") : "")
    );
  };
  for (const e of walkElements(nodes))
    if (e.tagName === "p")
      out.push(
        text(e)
          .replaceAll(/[\s ]+/g, " ")
          .trim(),
      );
  return out;
}

/** Paragraphs a live essay page prints that no block of the essay holds (author box, share links, comments). */
const essayExtras = (p: string): boolean =>
  /\b(subscribe|donate|comment|share|follow)\b/i.test(p) && p.length < 200;

// ── A real build ─────────────────────────────────────────────────────────────────────────────────

describe("real Jx builds of converted pages", () => {
  /** What a build needs of a page: the converted nodes with every placeholder replaced by a stand-in. */
  async function pageOf(
    name: SiteName,
    id: number,
  ): Promise<{ title: string; children: JxNode[]; converted: Converted }> {
    const site = await loadSite(name);
    const converted = await convertSubject(site, { kind: "post", id }, { target: "page" });
    const children = replacePlaceholders(converted.nodes, {
      "*": (p) => ({ tagName: "div", attributes: { "data-stand-in": p.kind } }),
    });
    return { title: converted.post?.title ?? "page", children, converted };
  }

  const cases: { site: SiteName; slug: string; type: string; live: string }[] = [
    { site: "fineline", slug: "about-us", type: "page", live: "about-us" },
    { site: "fineline", slug: "privacy-policy", type: "page", live: "privacy-policy" },
    { site: "fineline", slug: "residential", type: "page", live: "residential" },
    {
      site: "fineline",
      slug: "choosing-the-best-log-home-stain",
      type: "post",
      live: "choosing-the-best-log-home-stain",
    },
    {
      site: "ap",
      slug: "the-cultural-captivity-of-the-gospel",
      type: "post",
      live: "essays__the-cultural-captivity-of-the-gospel",
    },
    {
      site: "ap",
      slug: "the-way-we-live-is-the-way-we-educate",
      type: "post",
      live: "essays__the-way-we-live-is-the-way-we-educate",
    },
  ];

  for (const c of cases) {
    test(`${c.site}/${c.slug}: validates, builds, and prints what the live page prints`, async () => {
      const site = await loadSite(c.site);
      const post = [...site.model.posts.values()].find(
        (p) => p.slug === c.slug && p.type === c.type && p.status === "publish",
      )!;
      expect(post).toBeDefined();
      const { title, children, converted } = await pageOf(c.site, post.id);
      const style: Record<string, unknown> = {};
      for (const rule of converted.hoisted) style[rule.selector] = rule.style;
      // A page that holds a query loop points at a content collection of its own `state`: the
      // project that builds it has the state and a collection to read.
      const collections = stubCollections([converted.state]);
      const project = await buildJxProject(
        {
          "project.json": {
            name: "convert",
            url: "https://example.com",
            defaults: { layout: "./layouts/base.json" },
            ...collections.config,
            ...(Object.keys(style).length > 0 ? { style } : {}),
          },
          "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
          "pages/index.json": {
            title,
            ...(Object.keys(converted.state).length > 0 ? { state: converted.state } : {}),
            children,
          },
          ...collections.files,
        },
        { name: "convert", timeoutMs: 170_000 },
      );
      const validation = await validateJxProject(project.dir);
      expect(validation.problems).toEqual([]);
      expect(validation.ok).toBe(true);
      const html = project.html("/");
      expect(html).not.toMatch(/<wp2jx-/);
      expect(html).not.toContain("${");
      const built = paragraphs(html).filter((p) => p.length > 40);
      const live = new Set(
        paragraphs(readFileSync(join(FIXTURES, c.site, `html/${c.live}.html`), "utf8")),
      );
      // precision: every paragraph the build prints is on the live page, character for character
      const invented = built.filter((p) => !live.has(p));
      console.log(
        `build ${c.site}/${c.slug}: ${built.length} paragraphs, ${built.length - invented.length} on the live page`,
      );
      expect(built.length).toBeGreaterThan(2);
      expect(invented).toEqual([]);
    });
  }
  test("fineline's components convert to documents whose props flow through a built page", async () => {
    const site = await loadSite("fineline");
    const files: Record<string, unknown> = {
      "project.json": {
        name: "components",
        url: "https://example.com",
        $media: site.options.media,
        defaults: { layout: "./layouts/base.json" },
      },
      "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
    };
    const instances: JxNode[] = [];
    const elements: { $ref: string }[] = [];
    for (const [ref, info] of site.components) {
      const converted = await convertSubject(site, { kind: "component", ref });
      expect(converted.report.entries().filter((e) => e.severity === "error")).toEqual([]);
      const state = Object.fromEntries(info.props.map((p) => [p.key, p.default ?? ""]));
      const children = replacePlaceholders(converted.nodes, { "*": () => null });
      // every state read in the body is a prop the component declares
      const reads = new Set(
        [...JSON.stringify(children).matchAll(/state\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(
          (m) => m[1]!,
        ),
      );
      expect(reads.size).toBeGreaterThan(0);
      for (const read of reads) expect(Object.keys(state)).toContain(read);
      files[`components/${info.tagName}.json`] = { tagName: info.tagName, state, children };
      elements.push({ $ref: `../components/${info.tagName}.json` });
      instances.push({
        tagName: info.tagName,
        $props: { heading: `Hello from ${ref}` },
      } as JxElement);
    }
    files["pages/index.json"] = { title: "components", $elements: elements, children: instances };
    const project = await buildJxProject(files as never, {
      name: "components",
      timeoutMs: 170_000,
    });
    const validation = await validateJxProject(project.dir);
    expect(validation.problems).toEqual([]);
    const html = project.html("/");
    for (const ref of site.components.keys()) expect(html).toContain(`Hello from ${ref}`);
    expect(html).not.toContain("${");
    expect(html).not.toMatch(/<wp2jx-/);
  });
});

// ── Findings of the driver review: each one reproduced on real data first ───────────────────────

describe("a converter that answers with something that is not a list of nodes", () => {
  const bad: [string, () => unknown][] = [
    ["undefined", () => undefined],
    ["null", () => null],
    ["a single element object", () => el("p", { textContent: "alone" })],
    ["a string", () => "alone"],
    ["a number", () => 42],
    ["a list with an undefined in it", () => [undefined, el("p", { textContent: "x" })]],
    ["a list with a null in it", () => ["ok", null]],
    ["a list with a list in it", () => [[el("p")]]],
    ["a list with a number in it", () => [1]],
  ];

  for (const [what, answer] of bad) {
    test(`${what}: the block is reported and takes the fallback, and the page around it converts`, async () => {
      const ctx = await subjectCtx(await loadSite("ap"), { kind: "post", id: 6 });
      const registry = {
        "x/bad": () => answer() as JxNode[],
        "x/fine": () => ["fine"],
      };
      const out = convertBlocks(
        [
          block("x/fine"),
          block("x/bad", { innerHTML: "<p>saved</p>", innerContent: ["<p>saved</p>"] }),
          block("x/fine"),
        ],
        ctx,
        registry,
      );
      expect(out[0]).toBe("fine");
      expect(out.at(-1)).toBe("fine");
      expect(JSON.stringify(out)).toContain("saved");
      const entries = ctx.report.entries();
      expect(entries.find((e) => e.code === "block.converter-error")).toMatchObject({
        severity: "error",
        where: "post:6",
        data: { block: "x/bad", error: "not a list of nodes" },
      });
      expect(entries.filter((e) => e.code === "block.unsupported")).toHaveLength(1);
    });
  }

  test("an empty list is an answer (the block has nothing to show), not an error", async () => {
    const ctx = await subjectCtx(await loadSite("ap"), { kind: "post", id: 6 });
    expect(convertBlocks([block("x/none")], ctx, { "x/none": () => [] })).toEqual([]);
    expect(ctx.report.entries()).toEqual([]);
  });

  test("convertSubject resolves with the damage reported instead of rejecting after the converter's guard", async () => {
    const site = withPost(
      await loadSite("ap"),
      PROBE,
      [
        `<!-- wp:paragraph --><p>before</p><!-- /wp:paragraph -->`,
        blocksOf("test/returns-undefined", "test/returns-hole", "test/returns-one"),
        `<!-- wp:paragraph --><p>after</p><!-- /wp:paragraph -->`,
      ].join("\n"),
    );
    registerConverters({
      "test/returns-undefined": () => undefined as unknown as JxNode[],
      "test/returns-hole": () => [undefined, el("p", { textContent: "x" })] as unknown as JxNode[],
      "test/returns-one": () => el("p", { textContent: "one" }) as unknown as JxNode[],
    });
    const out = await convertSubject(site, { kind: "post", id: PROBE });
    const text = JSON.stringify(out.nodes);
    expect(text).toContain("before");
    expect(text).toContain("after");
    expect(out.report.entries().filter((e) => e.code === "block.converter-error")).toHaveLength(3);
  });
});

describe("what a tree uses is read from its $ref pointers, and only from them", () => {
  test("a paragraph that reads like a pointer is text: no throw on a stray percent sign, no invented state key", async () => {
    const site = withPost(
      await loadSite("fineline"),
      PROBE,
      [
        `<!-- wp:paragraph --><p>#/state/100%</p><!-- /wp:paragraph -->`,
        `<!-- wp:paragraph --><p>#/state/foo bar</p><!-- /wp:paragraph -->`,
        `<!-- wp:paragraph --><p>#/state/entry/data/title</p><!-- /wp:paragraph -->`,
      ].join("\n"),
    );
    const out = await convertSubject(site, { kind: "post", id: PROBE });
    expect(JSON.stringify(out.nodes)).toContain("#/state/100%");
    expect([...out.used.states]).toEqual([]);
  });

  test("a $ref key is decoded the way a JSON pointer in a URI fragment is, and a stray percent is read as written", async () => {
    const site = withPost(await loadSite("ap"), PROBE, blocksOf("test/pointers"));
    registerConverters({
      "test/pointers": () => [
        el("div", {
          children: [
            el("b", { $props: { a: { $ref: "#/state/100%" } } }),
            el("b", { $props: { a: { $ref: "#/state/x~1y" } } }),
            el("b", { $props: { a: { $ref: "#/state/r%20ow/inner" } } }),
            el("b", { $props: { a: { $ref: "#/state/t~0x" } } }),
            el("b", { $props: { a: { $ref: "#/props/not-state" } } }),
            el("b", { $props: { a: { $ref: 5 } } }),
          ],
        }),
      ],
    });
    const out = await convertSubject(site, { kind: "post", id: PROBE });
    expect([...out.used.states].sort()).toEqual(["100%", "r ow", "t~x", "x/y"]);
  });
});

describe("a Cwicly block nothing converts keeps its saved markup, with the tokens of its id and classes settled", () => {
  const BLOCK = "cwicly/never-converted";

  async function settle(markup: string, attrs: Record<string, unknown> = {}) {
    const site = await loadSite("fineline");
    const ctx = await subjectCtx(site, { kind: "post", id: 5246 });
    const out = convertBlocks(
      [block(BLOCK, { attrs, innerHTML: markup, innerContent: [markup] })],
      ctx,
      {},
    );
    return { site, ctx, out, root: out[0] as JxElement };
  }

  test("the bookkeeping token leaves the id, {gcl} becomes the global class names, the page-class token goes with an info", async () => {
    const site = await loadSite("fineline");
    const [gid, gname] = [...site.options.globalClassNames][0]!;
    const { root, ctx } = await settle(
      `<nav class="nav-c0498d1 {gcl} cc-nav" id="nav-c05ccc2{idadd}"><a class="navlink-c677a96 cc-nav-link {currentpageclass=static=https://finelinepainting.pro/projects/}" href="/projects/">Projects</a></nav>`,
      { globalClass: [gid] },
    );
    expect(root.tagName).toBe("nav");
    expect(root.id).toBe("nav-c05ccc2");
    expect(root.className).toBe(`nav-c0498d1 ${gname} cc-nav`);
    const link = (root.children as JxElement[])[0]!;
    expect(link.className).toBe("navlink-c677a96 cc-nav-link");
    const entries = ctx.report.entries();
    expect(entries.find((e) => e.code === "class.current-page")).toMatchObject({
      severity: "info",
    });
    expect(entries.find((e) => e.code === "block.unsupported")).toBeDefined();
  });

  test("a global class that no longer exists is reported and prints nothing; a token nobody can resolve is dropped and reported", async () => {
    const { root, ctx } = await settle(
      `<div class="a {gcl} b {darkmode_force=dark}" id="x-{loop-id}{what}">t</div>`,
      { globalClass: ["3yEPq5XEDBJoOaj"] },
    );
    expect(root.className).toBe("a b");
    expect(root.id).toBe("x-");
    const entries = ctx.report.entries();
    expect(entries.find((e) => e.code === "class.dangling-global")).toMatchObject({
      severity: "warn",
      data: { globalClass: "3yEPq5XEDBJoOaj" },
    });
    const unresolved = entries.filter((e) => e.code === "token.unresolved");
    expect(unresolved.map((e) => (e.data as { token: string }).token).sort()).toEqual([
      "{darkmode_force=dark}",
      "{what}",
    ]);
    expect(unresolved[0]).toMatchObject({ severity: "warn", where: "post:5246" });
  });

  test("only the class and id attributes are settled: a data attribute and a binding are left as written, and a block of another namespace is not touched", async () => {
    const markup = `<div class="a{idadd}" data-class="{keep}" title="{keep}">\${state.x}</div>`;
    const cwicly = await settle(markup);
    expect(cwicly.root.className).toBe("a");
    expect((cwicly.root.attributes as Record<string, string>)["data-class"]).toBe("{keep}");
    expect((cwicly.root.attributes as Record<string, string>).title).toBe("{keep}");
    const site = await loadSite("fineline");
    const ctx = await subjectCtx(site, { kind: "post", id: 5246 });
    const other = convertBlocks(
      [block("x/other", { innerHTML: markup, innerContent: [markup] })],
      ctx,
      {},
    );
    expect((other[0] as JxElement).className).toBe("a{idadd}");
  });

  test("a block with no tokens in its class or id is the very block it was (nothing is rewritten)", async () => {
    const { root } = await settle(`<div class="plain" id="p1">t</div>`);
    expect(root.className).toBe("plain");
    expect(root.id).toBe("p1");
  });

  for (const name of ["fineline", "ap"] as const) {
    test(`${name}: no converted element of any subject keeps a render-time token in its id or class`, async () => {
      const site = await loadSite(name);
      const leaked: string[] = [];
      for (const subject of allSubjects(site)) {
        const converted = await convertSubject(site, subject);
        for (const element of walkElements(converted.nodes)) {
          for (const key of ["id", "className"] as const) {
            const value = element[key];
            if (typeof value === "string" && /\{[a-z]/.test(value) && !value.includes("${"))
              leaked.push(`${JSON.stringify(subject)} ${key}=${value}`);
          }
        }
      }
      expect(leaked.slice(0, 5)).toEqual([]);
    });
  }
});

describe("how deep blocks may nest", () => {
  /** `levels` blocks, each inside the one before, converted through a registry whose only converter recurses. */
  async function nested(levels: number) {
    const ctx = await subjectCtx(await loadSite("ap"), { kind: "post", id: 7 });
    let chain: WpBlock | undefined;
    for (let i = 0; i < levels; i++) chain = block("x/box", { innerBlocks: chain ? [chain] : [] });
    const registry: Record<string, BlockConverter> = {
      "x/box": (b, c) => [el("div", { children: c.convert(b.innerBlocks) })],
    };
    const out = withRegistry(ctx, registry).convert([chain!]);
    const depth = [...walkElements(out)].length;
    return { depth, errors: ctx.report.entries().filter((e) => e.code === "block.too-deep") };
  }

  test("two hundred levels of conversion are fine; the two hundred and first is cut and reported once", async () => {
    // a chain of N boxes makes N + 1 nested `convertBlocks` calls (the innermost box converts its empty list)
    const ok = await nested(199);
    expect(ok.errors).toEqual([]);
    expect(ok.depth).toBe(199);
    const over = await nested(200);
    expect(over.errors).toHaveLength(1);
    expect(over.errors[0]).toMatchObject({ severity: "error", data: { blocks: 0 } });
    expect(over.depth).toBe(200);
  });
});
