/**
 * emit/pages.ts against the real fixture sites: every published page of fineline and anabaptistperspectives
 * becomes a Jx page, the pages are validated and built with the installed `jx`, and the built content is
 * held against the rendered live pages in tests/fixtures/<site>/html (the ground truth).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromHtml } from "hast-util-from-html";
import type { Converted } from "../../src/convert.ts";
import {
  buildPages,
  componentFile,
  ENTRY_STATE_KEY,
  hierarchyLayout,
  headEntries,
  hoistedStyle,
  isWholeExpression,
  layoutPath,
  literalText,
  misplacedBindings,
  relativeRef,
  templateHierarchy,
  type PageOptions,
  type PagesOutput,
} from "../../src/emit/pages.ts";
import { emptyCssIndex } from "../../src/cwicly/css.ts";
import { readCwiclyOptions } from "../../src/cwicly/options.ts";
import { createReport } from "../../src/report.ts";
import { buildRoutes, createUrlTools } from "../../src/routes.ts";
import type { SiteContext } from "../../src/site.ts";
import type { JxDocument, JxElement, JxNode, WpPost } from "../../src/types.ts";
import { seoFor } from "../../src/wp/seo.ts";
import { loadSite, type LoadedSite } from "../helpers/ctx.ts";
import { pilotForms } from "../helpers/fluentform-db.ts";
import {
  buildJxProject,
  cleanupJxProjects,
  validateJxProject,
  TMP_ROOT,
  type BuiltProject,
  type ProjectFile,
} from "../helpers/jx-build.ts";

setDefaultTimeout(180_000);
afterAll(cleanupJxProjects);

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

type Hast = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Hast[];
};

function walkHast(node: Hast, visit: (element: Hast) => boolean | void): void {
  if (node.type === "element" && visit(node) === false) return;
  for (const child of node.children ?? []) walkHast(child, visit);
}

function findHast(node: Hast, test: (element: Hast) => boolean): Hast | undefined {
  let found: Hast | undefined;
  walkHast(node, (element) => {
    if (found) return false;
    if (test(element)) {
      found = element;
      return false;
    }
    return undefined;
  });
  return found;
}

const NOT_TEXT = new Set(["script", "style", "noscript", "template"]);

/** The words a visitor reads under `root`, in order. */
function wordsOf(root: Hast): string[] {
  const out: string[] = [];
  const visit = (node: Hast): void => {
    if (node.type === "text") out.push(...(node.value ?? "").split(/\s+/).filter(Boolean));
    else if (node.type === "root" || (node.type === "element" && !NOT_TEXT.has(node.tagName!))) {
      node.children?.forEach(visit);
    }
  };
  visit(root);
  return out;
}

function collect(root: Hast, tag: RegExp, pick: (element: Hast) => string | undefined): string[] {
  const out: string[] = [];
  walkHast(root, (element) => {
    if (NOT_TEXT.has(element.tagName!)) return false;
    if (tag.test(element.tagName!)) {
      const value = pick(element);
      if (value !== undefined) out.push(value);
    }
    return undefined;
  });
  return out;
}

/** 2 * LCS / (|a| + |b|): 1 for the same sequence, 0 for nothing in common. */
function sequenceRatio(a: string[], b: string[]): number {
  if (a.length + b.length === 0) return 1;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] =
        a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
  }
  return (2 * previous[b.length]!) / (a.length + b.length);
}

/** 2 * |a intersect b| / (|a| + |b|) over multisets: order does not matter. */
function bagRatio(a: string[], b: string[]): number {
  if (a.length + b.length === 0) return 1;
  const left = new Map<string, number>();
  for (const item of a) left.set(item, (left.get(item) ?? 0) + 1);
  let shared = 0;
  for (const item of b) {
    const count = left.get(item) ?? 0;
    if (count > 0) {
      shared++;
      left.set(item, count - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

const textOf = (node: Hast): string => wordsOf(node).join(" ");

const classOf = (element: Hast): string => {
  const value = element.properties?.className;
  return Array.isArray(value) ? value.join(" ") : String(value ?? "");
};

/** The project a site's pages build in: trivial layouts (a `<main>` and the slot) and stub components. */
function projectOf(
  site: SiteContext,
  out: PagesOutput,
  extra: Record<string, ProjectFile> = {},
): Record<string, ProjectFile> {
  const files: Record<string, ProjectFile> = {
    "project.json": { name: "pages-test", url: site.model.site.home, $media: site.options.media },
  };
  for (const file of out.files) files[file.path] = file.content;
  // A page whose conversion holds a query loop points at a content collection of the project: the
  // project that builds it has one (a single stub entry; the pages' own content is what is judged).
  const types = new Set<string>();
  for (const file of out.files) {
    const state = (JSON.parse(file.content) as { state?: Record<string, { contentType?: string }> })
      .state;
    for (const entry of Object.values(state ?? {})) {
      if (typeof entry?.contentType === "string") types.add(entry.contentType);
    }
  }
  if (types.size > 0) {
    files["project.json"] = {
      ...(files["project.json"] as object),
      extensions: ["@jxsuite/parser"],
      content: Object.fromEntries(
        [...types].map((type) => [
          type,
          {
            source: `content/${type}`,
            format: "Markdown",
            schema: {
              type: "object",
              properties: { title: { type: "string" }, slug: { type: "string" } },
              required: ["title"],
            },
          },
        ]),
      ),
    };
    for (const type of types)
      files[`content/${type}/stub.md`] = "---\ntitle: Stub\nslug: stub\n---\n\nBody.\n";
  }
  for (const layout of new Set(out.pages.map((page) => page.layout))) {
    if (layout !== null) {
      files[layout.replace(/^\.\//, "")] = {
        children: [{ tagName: "main", children: [{ tagName: "slot" }] }],
      };
    }
  }
  for (const tag of out.used.components) {
    files[componentFile(tag)] = {
      tagName: tag,
      children: [{ tagName: "div", children: [{ tagName: "slot" }] }],
    };
  }
  return { ...files, ...extra };
}

/** A copy of the site whose model has these changes laid over it (the routes are not rebuilt). */
type MutableModel = Omit<LoadedSite["model"], "posts" | "postMeta"> & {
  posts: Map<number, WpPost>;
  postMeta: Map<number, Record<string, unknown[]>>;
};

function withModel(site: LoadedSite, change: (model: MutableModel) => void): LoadedSite {
  const model = {
    ...site.model,
    posts: new Map(site.model.posts),
    postMeta: new Map(site.model.postMeta),
  };
  change(model as MutableModel);
  return { ...site, model };
}

const setMeta = (model: MutableModel, id: number, key: string, value: unknown): void => {
  model.postMeta.set(id, { ...model.postMeta.get(id), [key]: [value] });
};

const parse = (file: { content: string }): JxDocument => JSON.parse(file.content) as JxDocument;

const fileOf = (out: PagesOutput, path: string): { path: string; content: string } => {
  const found = out.files.find((file) => file.path === path);
  if (!found) throw new Error(`no ${path} in ${out.files.map((f) => f.path).join(", ")}`);
  return found;
};

const codes = (out: PagesOutput): string[] => out.report.entries().map((entry) => entry.code);

/** An element tree walker over a finished page document. */
function* elementsOf(nodes: readonly JxNode[]): Generator<JxElement> {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    yield node;
    if (Array.isArray(node.children)) yield* elementsOf(node.children);
  }
}

// ── The pure parts ───────────────────────────────────────────────────────────────────────────────

describe("relativeRef and componentFile", () => {
  test("a component is flat in components/, named by its tag", () => {
    expect(componentFile("fp-icon-card")).toBe("components/fp-icon-card.json");
  });

  test("the ref climbs out of every directory the page file sits in", () => {
    expect(relativeRef("pages/index.json", "components/x.json")).toBe("../components/x.json");
    expect(relativeRef("pages/about/team.json", "components/x.json")).toBe(
      "../../components/x.json",
    );
    expect(relativeRef("pages/a/b/c/index.json", "components/x.json")).toBe(
      "../../../../components/x.json",
    );
  });
});

describe("literalText", () => {
  test("a dollar-brace is split so no binding can be read in it", () => {
    expect(literalText("Cost ${amount}")).toBe("Cost $​{amount}");
    expect(literalText("$5 {x}")).toBe("$5 {x}");
  });
});

describe("hoistedStyle", () => {
  test("an at-rule keeps its key and its body", () => {
    const placed = hoistedStyle([
      { selector: "@keyframes fade-in", style: { from: { opacity: "0" }, to: { opacity: "1" } } },
    ]);
    expect(placed.style).toEqual({
      "@keyframes fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
    });
    expect(placed.nested).toBe(0);
  });

  test("a selector is written as a descendant of the layout's root", () => {
    const placed = hoistedStyle([
      { selector: ".icon-white", style: { color: "#fff", ":hover": { color: "red" } } },
      { selector: ":where(.a .b)", style: { margin: "0" } },
      { selector: ".x.y", style: { padding: "1px" } },
    ]);
    expect(Object.keys(placed.style)).toEqual(["& .icon-white", "& :where(.a .b)", "& .x.y"]);
    expect(placed.style["& .icon-white"]).toEqual({ color: "#fff", ":hover": { color: "red" } });
    expect(placed.nested).toBe(3);
  });

  test("a selector list becomes one key per member, and commas inside a function do not split", () => {
    const placed = hoistedStyle([
      { selector: ".a, .b > i", style: { color: "red" } },
      { selector: ".c:is(.d, .e)", style: { color: "blue" } },
      { selector: '[data-x="a,b"]', style: { color: "green" } },
    ]);
    expect(Object.keys(placed.style)).toEqual([
      "& .a",
      "& .b > i",
      "& .c:is(.d, .e)",
      '& [data-x="a,b"]',
    ]);
  });

  test("a rule about the document itself has no spelling and is returned, not written", () => {
    const rules = [
      { selector: "body.home", style: { margin: "0" } },
      { selector: "html", style: { margin: "0" } },
      { selector: ":root", style: { "--x": "1" } },
      { selector: ".ok, body", style: { margin: "0" } },
    ];
    const placed = hoistedStyle(rules);
    expect(placed.style).toEqual({});
    expect(placed.unplaced).toEqual(rules);
  });

  test("a tag whose name starts like `body` is not the document", () => {
    const placed = hoistedStyle([{ selector: "bodyguard", style: { color: "red" } }]);
    expect(Object.keys(placed.style)).toEqual(["& bodyguard"]);
  });

  test("two rules that define one key differently collide, the later one wins; the same body twice does not", () => {
    const same = hoistedStyle([
      { selector: "@keyframes spin", style: { to: { rotate: "1turn" } } },
      { selector: "@keyframes spin", style: { to: { rotate: "1turn" } } },
    ]);
    expect(same.collisions).toEqual([]);
    const differ = hoistedStyle([
      { selector: "@keyframes spin", style: { to: { rotate: "1turn" } } },
      { selector: "@keyframes spin", style: { to: { rotate: "2turn" } } },
    ]);
    expect(differ.collisions).toEqual(["@keyframes spin"]);
    expect(differ.style["@keyframes spin"]).toEqual({ to: { rotate: "2turn" } });
  });

  test("the rules are copied, never shared with the converter's", () => {
    const rule = { selector: ".a", style: { color: "red" } };
    const placed = hoistedStyle([rule]);
    (placed.style["& .a"] as Record<string, string>).color = "blue";
    expect(rule.style.color).toBe("red");
  });
});

describe("misplacedBindings", () => {
  const page = (children: JxNode[], extra: Record<string, unknown> = {}): JxDocument =>
    ({ title: "T", children, ...extra }) as unknown as JxDocument;

  test("bindings in textContent, innerHTML, attributes and flat style values are fine", () => {
    const doc = page([
      {
        tagName: "p",
        textContent: "${new Date().getFullYear()}",
        attributes: { href: "${x}", "data-y": "a${y}" },
        style: { color: "${c}" },
      },
      { tagName: "div", innerHTML: "<b>${x}</b>" },
    ]);
    expect(misplacedBindings(doc)).toEqual([]);
  });

  test("className, id, the unbound top-level properties and text children are found, with where", () => {
    const doc = page([
      { tagName: "div", className: "a ${x}" },
      { tagName: "div", children: [{ tagName: "p", id: "x-${y}" }] },
      { tagName: "p", hidden: "${z}" as unknown as boolean },
      { tagName: "p", title: "${t}" },
      { tagName: "div", children: ["a ${x} b"] },
    ]);
    expect(misplacedBindings(doc)).toEqual([
      { path: "children/0", position: "className" },
      { path: "children/1/children/0", position: "id" },
      { path: "children/2", position: "hidden" },
      { path: "children/3", position: "title" },
      { path: "children/4/children/0", position: "children" },
    ]);
  });

  test("a child that is exactly one expression is evaluated by the build, however many braces it holds [K2]", () => {
    const list =
      "${((() => { const by = (f) => (a, b) => (a.data[f] < b.data[f] ? -1 : 1); return [...state.rows].sort(by('n')).map((e) => ({ tagName: 'li', textContent: e.data.n })); })())}";
    const doc = page([
      { tagName: "ul", children: [list] },
      { tagName: "div", children: ["x", "${state.on ? [{ tagName: 'b' }] : []}", "y"] },
    ]);
    expect(misplacedBindings(doc)).toEqual([]);
  });

  test("a child that mixes text with a binding is still found: only a whole expression is evaluated [K1]", () => {
    const doc = page([
      { tagName: "div", children: ["a ${x} b"] },
      { tagName: "div", children: ["${x} b"] },
      { tagName: "div", children: ["a ${x}"] },
      { tagName: "div", children: ["${a}${b}"] },
      { tagName: "div", children: [" ${a}"] },
      { tagName: "div", children: ["${a} "] },
      { tagName: "div", children: ["${a} and ${b}"] },
      { tagName: "div", children: ["${(() => { return 1; })()} tail"] },
    ]);
    expect(misplacedBindings(doc).map((m) => `${m.path} ${m.position}`)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `children/${i}/children/0 children`),
    );
  });

  test("a whole expression that yields a scalar is still found: only a node list is evaluated as a child [K2]", () => {
    const doc = page([
      { tagName: "div", children: ["${state.entry.data.title}"] },
      { tagName: "div", children: ["${state.entry.data.n}"] },
      { tagName: "div", children: ["${state.x.map((v) => v.name).join(', ')}"] },
      { tagName: "div", children: ["${state.x}"] },
      { tagName: "div", children: ["${state.on ? [{ tagName: 'b' }] : []}"] },
      {
        tagName: "ul",
        children: [
          "${(state.rows).map(($i0, $x0) => ({'tagName': 'li', 'textContent': ($i0.data.n)}))}",
        ],
      },
    ]);
    expect(misplacedBindings(doc).map((m) => `${m.path} ${m.position}`)).toEqual([
      "children/0/children/0 children",
      "children/1/children/0 children",
      "children/2/children/0 children",
      "children/3/children/0 children",
    ]);
  });

  test("isWholeExpression counts braces the way the build does", () => {
    expect(isWholeExpression("${x}")).toBe(true);
    expect(isWholeExpression("${{ a: 1 }.a}")).toBe(true);
    expect(isWholeExpression("${f(() => { return [{}]; })}")).toBe(true);
    expect(isWholeExpression("${x}${y}")).toBe(false);
    expect(isWholeExpression("${x")).toBe(false);
    expect(isWholeExpression("${{x}")).toBe(false);
    expect(isWholeExpression("x ${y}")).toBe(false);
    expect(isWholeExpression("")).toBe(false);
  });

  test("a binding inside a nested style block is found, a flat one is not", () => {
    const doc = page([
      { tagName: "div", style: { color: "${a}", ":hover": { color: "${b}" } } },
      { tagName: "div", style: { "@--md": { "& a": { color: "${b}" } } } },
    ]);
    expect(misplacedBindings(doc)).toEqual([
      { path: "children/0", position: "style" },
      { path: "children/1", position: "style" },
    ]);
  });

  test("the page's own title and head are written literally: a binding there is a bug", () => {
    const doc = page([], {
      title: "A ${b}",
      $head: [
        { tagName: "meta", attributes: { name: "description", content: "ok" } },
        { tagName: "meta", attributes: { name: "x", content: "${y}" } },
      ],
    });
    expect(misplacedBindings(doc)).toEqual([
      { path: "title", position: "title" },
      { path: "$head/1", position: "$head" },
    ]);
  });

  test("a repeater's template and the children of a mapped array are walked", () => {
    const doc = page([
      {
        tagName: "ul",
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/rows" },
          map: { tagName: "li", className: "r-${$map.item.id}" },
        } as unknown as JxElement["children"],
      } as JxElement,
    ]);
    expect(misplacedBindings(doc).map((m) => m.position)).toEqual(["className"]);
  });
});

// ── Layouts ──────────────────────────────────────────────────────────────────────────────────────

describe("the template hierarchy of a page", () => {
  let fineline: LoadedSite;
  let ap: LoadedSite;
  beforeAll(async () => {
    [fineline, ap] = await Promise.all([loadSite("fineline"), loadSite("ap")]);
  });

  const post = (site: LoadedSite, id: number): WpPost => site.model.posts.get(id)!;

  test("a page tries its own template, page-<slug>, page-<id>, then page, singular and index", () => {
    expect(templateHierarchy(fineline, post(fineline, 1714))).toEqual([
      "page-contact-us",
      "page-1714",
      "page",
      "singular",
      "index",
    ]);
    // `default` is WordPress's name for "no custom template".
    expect(templateHierarchy(ap, post(ap, 822))).toEqual([
      "page-about-backup",
      "page-822",
      "page",
      "singular",
      "index",
    ]);
    expect(templateHierarchy(ap, post(ap, 1417))[0]).toBe("wp-custom-template-about-us");
  });

  test("front-page outranks the page's own template, which outranks page-<slug>", () => {
    const edited = withModel(ap, (model) =>
      setMeta(model, 819, "_wp_page_template", "wp-custom-template-wide"),
    );
    expect(templateHierarchy(edited, post(edited, 819)).slice(0, 3)).toEqual([
      "front-page",
      "wp-custom-template-wide",
      "page-welcome",
    ]);
  });

  test("the front page tries front-page first, but only when the site shows a static page", () => {
    expect(templateHierarchy(ap, post(ap, 819))[0]).toBe("front-page");
    const posts = withModel(ap, (model) => {
      model.site = { ...model.site, showOnFront: "posts" };
    });
    expect(templateHierarchy(posts, post(posts, 819))).not.toContain("front-page");
  });

  test("the layout is the first template of the hierarchy the site has", () => {
    // fineline has no front-page template, so its front page falls through to `page`.
    expect(hierarchyLayout(fineline, { kind: "post", id: 5246 })).toEqual({
      path: "./layouts/page.json",
      template: "page",
    });
    expect(hierarchyLayout(ap, { kind: "post", id: 819 })).toEqual({
      path: "./layouts/front-page.json",
      template: "front-page",
    });
    expect(hierarchyLayout(ap, { kind: "post", id: 1417 })).toEqual({
      path: "./layouts/wp-custom-template-about-us.json",
      template: "wp-custom-template-about-us",
    });
    expect(hierarchyLayout(ap, { kind: "post", id: 835 })?.template).toBe(
      "wp-custom-template-full-width",
    );
  });

  test("a page template that is a classic theme's file is no wp_template and falls through", () => {
    const site = withModel(fineline, (model) =>
      setMeta(model, 1714, "_wp_page_template", "page-templates/wide.php"),
    );
    expect(hierarchyLayout(site, { kind: "post", id: 1714 })).toMatchObject({ template: "page" });
  });

  test("a page-<slug> template beats page, and the page's own template beats page-<slug>", () => {
    const withSlugTemplate = withModel(fineline, (model) => {
      const base = [...model.posts.values()].find((p) => p.type === "wp_template")!;
      model.posts.set(90001, { ...base, id: 90001, slug: "page-contact-us" });
      model.posts.set(90002, { ...base, id: 90002, slug: "mine" });
    });
    expect(hierarchyLayout(withSlugTemplate, { kind: "post", id: 1714 })).toMatchObject({
      template: "page-contact-us",
    });
    setMeta(withSlugTemplate.model as MutableModel, 1714, "_wp_page_template", "mine");
    expect(hierarchyLayout(withSlugTemplate, { kind: "post", id: 1714 })).toMatchObject({
      template: "mine",
    });
  });

  test("an unpublished template does not count; nothing to choose from is undefined", () => {
    const none = withModel(fineline, (model) => {
      for (const [id, p] of model.posts) {
        if (p.type === "wp_template") model.posts.set(id, { ...p, status: "draft" });
      }
    });
    expect(hierarchyLayout(none, { kind: "post", id: 1714 })).toBeUndefined();
  });

  test("only a post has a page layout", () => {
    expect(hierarchyLayout(fineline, { kind: "template", slug: "page" })).toBeUndefined();
    expect(hierarchyLayout(fineline, { kind: "post", id: 99999999 })).toBeUndefined();
  });

  test("the layout path convention", () => {
    expect(layoutPath("page")).toBe("./layouts/page.json");
  });
});

// ── Head ─────────────────────────────────────────────────────────────────────────────────────────

/** `<meta>` and `<link>` entries of a rendered page's head as `name or property -> content`. */
function liveHead(file: string): Map<string, string> {
  const root = fromHtml(readFileSync(`tests/fixtures/fineline/html/${file}`, "utf8")) as Hast;
  const head = findHast(root, (e) => e.tagName === "head")!;
  const out = new Map<string, string>();
  walkHast(head, (element) => {
    const p = element.properties ?? {};
    if (element.tagName === "meta" && (p.name !== undefined || p.property !== undefined)) {
      const key = String(p.name ?? p.property);
      if (!out.has(key)) out.set(key, String(p.content ?? ""));
    } else if (element.tagName === "link" && p.rel !== undefined && String(p.rel) === "canonical") {
      out.set("canonical", String(p.href));
    } else if (element.tagName === "title") out.set("title", textOf(element));
    return undefined;
  });
  return out;
}

describe("headEntries", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  const options = (siteUrl = "https://finelinepainting.pro") => ({
    siteUrl,
    mediaForUrl: (url: string) => site.media.mediaForUrl(url),
    text: (value: string) => value,
  });
  const attrs = (entries: ReturnType<typeof headEntries>): Record<string, string> =>
    Object.fromEntries(
      entries.map((entry) => [
        entry.attributes.name ?? entry.attributes.property ?? entry.attributes.rel!,
        entry.attributes.content ?? entry.attributes.href!,
      ]),
    );

  test("every entry is a meta or a link in the attributes form, which is the form the build reads", () => {
    const seo = seoFor(site.model, { kind: "post", post: site.model.posts.get(1716)! });
    const entries = headEntries(seo, options());
    for (const entry of entries) {
      expect(["meta", "link"]).toContain(entry.tagName);
      expect(Object.keys(entry).sort()).toEqual(["attributes", "tagName"]);
      expect(entry.attributes.content ?? entry.attributes.href).toBeString();
    }
  });

  test("the about page's head says what the live page's head says", () => {
    const seo = seoFor(site.model, { kind: "post", post: site.model.posts.get(1716)! });
    const mine = attrs(headEntries(seo, options()));
    const live = liveHead("about-us.html");
    for (const key of [
      "description",
      "robots",
      "og:locale",
      "og:type",
      "og:title",
      "og:description",
      "og:site_name",
      "og:image:alt",
      "og:image:type",
      "twitter:card",
      "twitter:title",
      "twitter:description",
    ]) {
      expect(mine[key], key).toBe(live.get(key)!);
    }
    expect(live.get("title")).toBe(seo.title);
  });

  test("the og:image is the project's own copy, absolute, with that copy's size", () => {
    const seo = seoFor(site.model, { kind: "post", post: site.model.posts.get(1716)! });
    const mine = attrs(headEntries(seo, options()));
    // The live page prints the 1024x559 size; the project keeps the family's original.
    expect(mine["og:image"]).toBe(
      "https://finelinepainting.pro/media/About-fine-line-painting-header.png",
    );
    expect(mine["twitter:image"]).toBe(mine["og:image"]!);
    expect(mine["og:image:width"]).toBe("2200");
    expect(mine["og:image:height"]).toBe("1200");
    expect(attrs(headEntries(seo, options("https://new.example.com/")))["og:image"]).toBe(
      "https://new.example.com/media/About-fine-line-painting-header.png",
    );
  });

  test("an image that is not an upload we ship keeps its own address", () => {
    const seo = seoFor(site.model, { kind: "post", post: site.model.posts.get(1716)! });
    const external = { ...seo, image: { url: "https://cdn.example.net/x.png" } };
    const entries = headEntries(
      { ...external, openGraph: { ...seo.openGraph, image: external.image } },
      options(),
    );
    expect(attrs(entries)["og:image"]).toBe("https://cdn.example.net/x.png");
    expect(attrs(entries)["og:image:width"]).toBeUndefined();
  });

  test("a canonical is written only when the answer holds one, and the order is Rank Math's", () => {
    const seo = seoFor(site.model, { kind: "post", post: site.model.posts.get(1716)! });
    expect(headEntries(seo, options()).some((e) => e.attributes.rel === "canonical")).toBe(false);
    const entries = headEntries(
      {
        ...seo,
        canonical: "https://elsewhere.example/x/",
        openGraph: { ...seo.openGraph, url: "https://elsewhere.example/x/" },
      },
      options(),
    );
    const names = entries.map(
      (e) => e.attributes.name ?? e.attributes.property ?? e.attributes.rel,
    );
    expect(names.indexOf("canonical")).toBe(names.indexOf("robots") + 1);
    expect(names.indexOf("og:url")).toBe(names.indexOf("og:description") + 1);
    expect(attrs(entries).canonical).toBe("https://elsewhere.example/x/");
  });

  test("an empty value is not written", () => {
    const seo = seoFor(site.model, { kind: "post", post: site.model.posts.get(1716)! });
    const entries = headEntries({ ...seo, description: "", robots: "" }, options());
    const names = entries.map((e) => e.attributes.name);
    expect(names).not.toContain("description");
    expect(names).not.toContain("robots");
  });

  test("text goes through the caller's escape for every value", () => {
    const seo = seoFor(site.model, { kind: "post", post: site.model.posts.get(1716)! });
    const entries = headEntries(seo, { ...options(), text: (value) => value.toUpperCase() });
    expect(attrs(entries).description).toBe(seo.description.toUpperCase());
    expect(attrs(entries)["og:site_name"]).toBe(seo.openGraph.siteName.toUpperCase());
  });
});

// ── The corpus ───────────────────────────────────────────────────────────────────────────────────

/** Every `wp2jx-*` tag left in a page. */
function placeholderTags(doc: JxDocument): string[] {
  return [...elementsOf((doc.children ?? []) as JxNode[])]
    .map((element) => String(element.tagName))
    .filter((tag) => tag.startsWith("wp2jx-"));
}

interface Corpus {
  site: LoadedSite;
  out: PagesOutput;
}

const corpus = new Map<"fineline" | "ap", Corpus>();

beforeAll(async () => {
  for (const name of ["fineline", "ap"] as const) {
    const site = await loadSite(name);
    // The hierarchy answers: the corpus tests describe it, whatever the templates emitter later says.
    corpus.set(name, { site, out: await buildPages(site, { templates: false }) });
  }
});

const of = (name: "fineline" | "ap"): Corpus => corpus.get(name)!;

describe("buildPages: finelinepainting", () => {
  test("every published page with an address of its own is written at its route's file", () => {
    const { site, out } = of("fineline");
    const expected = [...site.model.posts.values()]
      .filter((p) => p.type === "page" && p.status === "publish")
      .map((p) => ({ post: p, route: site.routes.forPost(p.id)! }))
      .filter(({ post, route }) => route.id === post.id && route.kind !== "posts-page");
    expect(out.pages.map((p) => p.id).sort((a, b) => a - b)).toEqual(
      expected.map(({ post }) => post.id).sort((a, b) => a - b),
    );
    expect(out.pages).toHaveLength(9);
    for (const { post, route } of expected) {
      const info = out.pages.find((p) => p.id === post.id)!;
      expect(info.file).toBe(route.file);
      expect(info.route).toBe(route.jxRoute);
      expect(out.files.some((f) => f.path === route.file)).toBe(true);
    }
    // `pages` is in the order of `files` (by file), not the order the posts were read in.
    expect(out.pages.map((p) => p.file)).toEqual(out.files.map((f) => f.path));
    expect(out.files.map((f) => f.path)).toEqual([
      "pages/about-us.json",
      "pages/commercial.json",
      "pages/contact-us.json",
      "pages/financing.json",
      "pages/index.json",
      "pages/premium-paint.json",
      "pages/privacy-policy.json",
      "pages/quote.json",
      "pages/residential.json",
    ]);
  });

  test("the front page is pages/index.json at /", () => {
    const { out } = of("fineline");
    expect(out.pages.find((p) => p.id === 5246)).toMatchObject({
      route: "/",
      file: "pages/index.json",
    });
  });

  test("every file is a JSON document with a title, a layout, a head and children", () => {
    for (const file of of("fineline").out.files) {
      expect(file.content.endsWith("\n")).toBe(true);
      const doc = parse(file);
      expect(Object.keys(doc).slice(0, 3)).toEqual(["title", "$layout", "$head"]);
      expect(doc.title).toBeString();
      expect(doc.title!.length).toBeGreaterThan(0);
      expect(doc.$layout).toMatch(/^\.\/layouts\/[a-z0-9_-]+\.json$/);
      expect(Array.isArray(doc.$head)).toBe(true);
      expect(Array.isArray(doc.children)).toBe(true);
      expect((doc.children as unknown[]).length).toBeGreaterThan(0);
      expect(Object.keys(doc).at(-1)).toBe("children");
    }
  });

  test("drafts and private pages are not written, the posts page and the shadowed page are reported", () => {
    const { site, out } = of("fineline");
    const byCode = (code: string): number[] =>
      out.skipped.filter((s) => s.code === code).map((s) => s.id);
    const drafts = [...site.model.posts.values()].filter(
      (p) => p.type === "page" && p.status !== "publish",
    );
    expect(drafts.length).toBeGreaterThan(20);
    expect(byCode("page.unpublished").sort((a, b) => a - b)).toEqual(
      drafts.map((p) => p.id).sort((a, b) => a - b),
    );
    expect(byCode("page.posts-page")).toEqual([2588]);
    expect(byCode("page.shadowed")).toEqual([5260]);
    expect(out.pages.some((p) => p.id === 4775 || p.id === 5260 || p.id === 2588)).toBe(false);
    const shadowed = out.report.entries().find((e) => e.code === "page.shadowed")!;
    expect(shadowed).toMatchObject({
      severity: "warn",
      where: "post:5260",
      url: "https://finelinepainting.pro/services/",
    });
    expect(shadowed.data).toMatchObject({ winner: "post-archive", route: "/services/" });
  });

  test("unpublished pages are one report line per status, with the ids", () => {
    const lines = of("fineline")
      .out.report.entries()
      .filter((e) => e.code === "page.unpublished");
    expect(lines.map((e) => (e.data as { status: string }).status)).toEqual(["draft", "private"]);
    expect((lines[1]!.data as { ids: number[] }).ids).toEqual([4775, 6027]);
  });

  test("unpublished lines are in status order, whatever order the pages were met in", async () => {
    const { site } = of("fineline");
    const edited = withModel(site, (model) => {
      model.posts.set(22, { ...model.posts.get(22)!, status: "pending" });
      model.posts.set(189, { ...model.posts.get(189)!, status: "future" });
    });
    const out = await buildPages(edited, { layoutFor: hierarchyLayout });
    const lines = out.report.entries().filter((e) => e.code === "page.unpublished");
    expect(lines.map((e) => (e.data as { status: string }).status)).toEqual([
      "draft",
      "future",
      "pending",
      "private",
    ]);
    expect(lines[2]!.message).toBe(
      "1 pending page is not published on the source site and is not written.",
    );
  });

  test("every page-located report entry names the page and carries its public URL", () => {
    const { site, out } = of("fineline");
    for (const entry of out.report.entries()) {
      const m = /^post:(\d+)$/.exec(entry.where ?? "");
      if (m === null) continue;
      const route = site.routes.forPost(Number(m[1]));
      if (route === undefined || entry.code === "page.unpublished") continue;
      // A reader's entry may carry the address it is about (`url.unresolved` names the dead link), or
      // WordPress's short form (`/?p=195`); every entry has one, and the emitter's own is the route's.
      expect(entry.url, `${entry.code} ${entry.where}`).toBeString();
      if (entry.code.startsWith("page.")) {
        expect(entry.url).toBe(`${site.model.site.home}${route.wpPath}`);
      }
    }
  });

  test("nothing the emitter itself can get wrong is wrong: no page.* error, no misplaced binding, no missing state", () => {
    const { out } = of("fineline");
    expect(
      out.report
        .entries()
        .filter((e) => e.severity === "error" && e.code.startsWith("page."))
        .map((e) => `${e.code} ${e.where}`),
    ).toEqual([]);
    expect(codes(out)).not.toContain("page.binding-misplaced");
    expect(codes(out)).not.toContain("page.state-missing");
  });

  test("no placeholder is left in a page without a report entry saying so", () => {
    const { out } = of("fineline");
    const left = out.files.flatMap((f) =>
      placeholderTags(parse(f)).map((tag) => `${f.path} ${tag}`),
    );
    const reported = out.report.entries().filter((e) => e.code === "placeholder.unresolved");
    expect(left.length).toBe(reported.length);
  });

  test("the front page's layout, head and a title that is Rank Math's, not the post's", () => {
    const { site, out } = of("fineline");
    const doc = parse(fileOf(out, "pages/index.json"));
    expect(doc.$layout).toBe("./layouts/page.json");
    expect(doc.title).toBe("Professional Painting Services In South Central PA");
    expect(doc.title).not.toBe(site.model.posts.get(5246)!.title);
    const head = Object.fromEntries(
      doc.$head!.map((e) => [e.attributes!.name ?? e.attributes!.property, e.attributes!.content]),
    );
    const live = liveHead("home.html");
    for (const key of [
      "description",
      "robots",
      "og:type",
      "og:title",
      "og:site_name",
      "twitter:card",
    ]) {
      expect(head[key], key).toBe(live.get(key)!);
    }
  });

  test("the classes the pages carry are collected for the compatibility stylesheet", () => {
    const { used } = of("fineline").out;
    expect(used.wpClasses.has("cc-sct")).toBe(true);
    expect(used.wpClasses.has("cc-cntr")).toBe(true);
    expect(used.wpClasses.has("section-c93760b")).toBe(true);
    for (const name of used.wpClasses) expect(name).not.toContain("${");
  });

  test("a page's components, states and hoisted rules are accounted for", () => {
    const { out } = of("fineline");
    for (const file of out.files) {
      const doc = parse(file);
      const refs = (doc.$elements ?? []).map((e) => (e as unknown as { $ref: string }).$ref);
      for (const ref of refs) expect(ref).toMatch(/^\.\.\/components\/[a-z0-9-]+\.json$/);
      // The page's own post (`state.entry`) is the layout's to point at, not a conversion's.
      const stateKeys = Object.keys(doc.state ?? {}).filter((key) => key !== ENTRY_STATE_KEY);
      for (const key of stateKeys) expect(out.used.states.has(key)).toBe(true);
    }
    expect(out.used.hoisted).toEqual(
      out.used.hoisted.filter(
        (rule, i, all) => all.findIndex((r) => r.selector === rule.selector) === i,
      ),
    );
  });
});

describe("buildPages: anabaptistperspectives", () => {
  test("the published pages are written; drafts, the posts page and the protected page are not", () => {
    const { out } = of("ap");
    expect(out.pages).toHaveLength(28);
    const byCode = (code: string): number[] =>
      out.skipped.filter((s) => s.code === code).map((s) => s.id);
    expect(byCode("page.posts-page")).toEqual([830]);
    expect(byCode("page.password-protected")).toEqual([10457]);
    expect(byCode("page.unpublished")).toEqual([837, 10455, 15578]);
    for (const id of [830, 10457, 837, 10455, 15578]) {
      expect(out.pages.some((p) => p.id === id)).toBe(false);
    }
  });

  test("the protected page is reported with its public URL, and written when asked for", async () => {
    const { site, out } = of("ap");
    const entry = out.report.entries().find((e) => e.code === "page.password-protected")!;
    expect(entry).toMatchObject({
      severity: "warn",
      where: "post:10457",
      url: "https://anabaptistperspectives.org/dashboard/",
    });
    const included = await buildPages(site, {
      only: [10457],
      passwordProtected: "include",
      templates: false,
    });
    expect(included.pages.map((p) => p.file)).toEqual(["pages/dashboard.json"]);
    expect(codes(included)).not.toContain("page.password-protected");
  });

  test("the page's own template decides its layout; the front page has the front-page one", () => {
    const { out } = of("ap");
    const layout = (id: number): string | null => out.pages.find((p) => p.id === id)!.layout;
    expect(layout(819)).toBe("./layouts/front-page.json");
    expect(layout(1417)).toBe("./layouts/wp-custom-template-about-us.json");
    expect(layout(1894)).toBe("./layouts/wp-custom-template-full-width.json");
    expect(layout(834)).toBe("./layouts/wp-custom-template-filter-page.json");
    expect(layout(822)).toBe("./layouts/page.json");
    expect(layout(840)).toBe("./layouts/page.json");
    // A page whose template meta names a template the site does not have falls back to `page`.
    for (const page of out.pages) expect(page.layout).toMatch(/^\.\/layouts\/[a-z0-9_-]+\.json$/);
  });

  test("a shortcode becomes a visible neutral element holding its text, and is reported", () => {
    const { out } = of("ap");
    const doc = parse(fileOf(out, "pages/4272-2.json"));
    const neutral = [...elementsOf(doc.children as JxNode[])].filter(
      (e) => typeof e.className === "string" && e.className.includes("wp2jx-unconverted"),
    );
    expect(neutral.length).toBeGreaterThan(0);
    const shortcode = neutral.find((e) => e.attributes?.["data-wp2jx"] === "shortcode:give_form")!;
    expect(shortcode.textContent).toBe('[give_form id="10443"]');
    expect(shortcode.className).toBe("wp2jx-unconverted wp2jx-shortcode");
    const entry = out.report
      .entries()
      .find((e) => e.code === "page.placeholder-neutral" && e.where === "post:4272")!;
    expect(entry).toMatchObject({
      severity: "warn",
      url: "https://anabaptistperspectives.org/4272-2/",
    });
  });

  test("no placeholder is left without a report entry saying so", () => {
    const { out } = of("ap");
    const left = out.files.flatMap((f) =>
      placeholderTags(parse(f)).map((tag) => `${f.path} ${tag}`),
    );
    const reported = out.report.entries().filter((e) => e.code === "placeholder.unresolved");
    expect(left.length).toBe(reported.length);
  });

  test("no page.* error, no misplaced binding", () => {
    const { out } = of("ap");
    expect(
      out.report
        .entries()
        .filter((e) => e.severity === "error" && e.code.startsWith("page."))
        .map((e) => `${e.code} ${e.where}`),
    ).toEqual([]);
  });

  test("the SEO read says one thing once: the site-wide schema note is not repeated per page", () => {
    const { out } = of("ap");
    const notes = out.report.entries().filter((e) => e.code === "seo.schema-not-migrated");
    expect(notes).toHaveLength(1);
    // It is about the site's settings, not about a page, so no page's address is put on it.
    expect(notes[0]!.where).toBe("option:rank-math-options-titles");
    expect(notes[0]!.url).toBeUndefined();
  });

  test("an unreadable (empty) page title is Rank Math's own answer, kept", () => {
    const { out } = of("ap");
    expect(parse(fileOf(out, "pages/4272-2.json")).title).toBe("- Anabaptist Perspectives");
  });
});

describe("buildPages: determinism and options", () => {
  test("two runs write the same bytes and the same report", async () => {
    const { site, out } = of("fineline");
    const again = await buildPages(site, { templates: false });
    expect(again.files).toEqual(out.files);
    expect(again.pages).toEqual(out.pages);
    expect(again.skipped).toEqual(out.skipped);
    expect(again.report.entries()).toEqual(out.report.entries());
    expect([...again.used.wpClasses]).toEqual([...out.used.wpClasses]);
  });

  test("`only` restricts the run to those pages", async () => {
    const { site } = of("fineline");
    const part = await buildPages(site, { only: [1716, 3483], templates: false });
    expect(part.files.map((f) => f.path)).toEqual([
      "pages/about-us.json",
      "pages/privacy-policy.json",
    ]);
    expect(part.skipped).toEqual([]);
  });

  test("findings go to the report the caller gives, and the same one is returned", async () => {
    const { site } = of("fineline");
    const report = createReport();
    const out = await buildPages(site, { only: [5260], report, templates: false });
    expect(out.report).toBe(report);
    expect(report.entries().map((e) => e.code)).toContain("page.shadowed");
  });
});

// ── Validated and built ──────────────────────────────────────────────────────────────────────────

const builtSites = new Map<"fineline" | "ap", BuiltProject>();

const decode = (text: string): string =>
  text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'");

beforeAll(async () => {
  for (const name of ["fineline", "ap"] as const) {
    const { site, out } = of(name);
    builtSites.set(name, await buildJxProject(projectOf(site, out), { name: `pages-${name}` }));
  }
});

describe.each(["fineline", "ap"] as const)("%s: jx validate and jx build", (name) => {
  // Built once for the whole file (above), so a filtered run still has its projects.
  const built = new Proxy({} as BuiltProject, {
    get: (_target, key) =>
      (builtSites.get(name) as unknown as Record<string | symbol, unknown>)[key],
  });

  test("the project validates", async () => {
    const result = await validateJxProject(built.dir);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("every page builds at its route, and no page is dynamic", () => {
    const { out } = of(name);
    expect(built.stdout).toContain(`${out.pages.length} routes`);
    for (const page of out.pages) {
      const html = built.html(page.route);
      expect(html, page.route).toContain("<main>");
      expect(html, page.route).not.toContain("data-bind");
      expect(html, page.route).not.toContain("${");
      // A dynamic page loads its `app.js` and the reactivity runtime from a script tag (the
      // widgets some pages embed, a review loader or a donation form, are the site's own content).
      expect(html, page.route).not.toMatch(/<script\b[^>]*\bsrc="[^"]*(?:app\.js|\/assets\/)/);
    }
    // The build writes a class file per component, which no static page loads; a page's own
    // `app.js` or the client runtime (`assets/`) would be a page that is dynamic.
    expect(
      built.list().filter((file) => file.endsWith(".js") && !file.startsWith("components/")),
    ).toEqual([]);
  });

  test("the title is the document's title, once, and does not leak onto the root as a tooltip", () => {
    const { out } = of(name);
    for (const file of out.files) {
      const doc = parse(file);
      const page = out.pages.find((p) => p.file === file.path)!;
      const html = built.html(page.route);
      expect(html.match(/<title>/g), page.route).toHaveLength(1);
      expect(decode(/<title>([^<]*)<\/title>/.exec(html)![1]!), page.route).toBe(
        doc.title!.replaceAll("​", ""),
      );
      const body = html.slice(html.indexOf("<body>"));
      expect(/^<body>\s*<[a-z0-9-]+[^>]*\stitle=/.test(body), page.route).toBe(false);
    }
  });

  test("the canonical and og:url are the page's own address, with the route's trailing slash, once each", () => {
    const { site, out } = of(name);
    for (const page of out.pages) {
      const html = built.html(page.route);
      expect(html.match(/rel="canonical"/g), page.route).toHaveLength(1);
      expect(html.match(/property="og:url"/g), page.route).toHaveLength(1);
      // Authored by the page: Jx's own would leave the slash off, and WordPress's canonical has it.
      const canonical = /<link rel="canonical" href="([^"]*)">/.exec(html)![1]!;
      expect(canonical, page.route).toBe(`${site.model.site.home}${page.route}`);
      expect(/<meta property="og:url" content="([^"]*)">/.exec(html)![1], page.route).toBe(
        canonical,
      );
    }
  });

  test("the head carries the description, robots, Open Graph and Twitter tags of the document", () => {
    const { out } = of(name);
    for (const file of out.files) {
      const doc = parse(file);
      const page = out.pages.find((p) => p.file === file.path)!;
      const root = fromHtml(built.html(page.route)) as Hast;
      const head = findHast(root, (e) => e.tagName === "head")!;
      const tags = new Map<string, string>();
      walkHast(head, (e) => {
        const p = e.properties ?? {};
        if (e.tagName === "meta" && (p.name ?? p.property) !== undefined) {
          tags.set(String(p.name ?? p.property), String(p.content));
        }
      });
      for (const entry of doc.$head!) {
        const key = entry.attributes!.name ?? entry.attributes!.property;
        if (key === undefined) continue;
        expect(tags.get(String(key)), `${page.route} ${String(key)}`).toBe(
          String(entry.attributes!.content).replaceAll("​", ""),
        );
      }
    }
  });
});

// ── Against the live pages ───────────────────────────────────────────────────────────────────────

const ORIGIN = "https://finelinepainting.pro";

/** An address as the migrated site spells it: the origin dropped, uploads under /media/, derivatives collapsed. */
const normaliseAddress = (url: string): string =>
  url
    .replace(ORIGIN, "")
    .replace(/^\/wp-content\/uploads\//, "/media/")
    .replace(/-\d+x\d+(?=\.\w+$)/, "")
    .replace(/-scaled(?=\.\w+$)/, "");

const normaliseHref = (url: string): string => {
  const href = normaliseAddress(url);
  if (href === "") return "/";
  return href.startsWith("/") && !/[?#]/.test(href) && !href.endsWith("/") ? `${href}/` : href;
};

/**
 * What a visitor can read and follow in the content region of a page. Cloudflare's address
 * obfuscation (`[email protected]`) and the review widget's own images are not the page's content: the
 * migration prints the address and reports the widget.
 */
function contentOf(root: Hast, region: (e: Hast) => boolean) {
  const found = findHast(root, region)!;
  expect(found, "content region").toBeDefined();
  const words = wordsOf(found).filter(
    (word) => word !== "[email" && word !== "protected]" && !word.includes("@"),
  );
  return {
    words,
    headings: collect(found, /^h[1-6]$/, (e) => `${e.tagName}:${textOf(e)}`),
    links: collect(found, /^a$/, (e) =>
      typeof e.properties?.href === "string" && !e.properties.href.includes("/cdn-cgi/")
        ? normaliseHref(e.properties.href)
        : undefined,
    ),
    images: collect(found, /^img$/, (e) =>
      typeof e.properties?.src === "string" &&
      (e.properties.src.startsWith("/") || e.properties.src.startsWith(ORIGIN))
        ? normaliseAddress(e.properties.src)
        : undefined,
    ),
  };
}

interface LiveCase {
  file: string;
  id: number;
  /** Floors for the four rates: the words in order, the headings, the links and the images. */
  floor: { words: number; headings: number; links: number; images: number };
}

const LIVE: LiveCase[] = [
  {
    file: "about-us.html",
    id: 1716,
    floor: { words: 0.93, headings: 0.8, links: 0.6, images: 0.2 },
  },
  { file: "home.html", id: 5246, floor: { words: 0.85, headings: 0.8, links: 0.6, images: 0.6 } },
  {
    file: "privacy-policy.html",
    id: 3483,
    floor: { words: 0.99, headings: 0.99, links: 0.99, images: 0.99 },
  },
  {
    file: "residential.html",
    id: 195,
    floor: { words: 0.8, headings: 0.8, links: 0.6, images: 0.1 },
  },
];

describe("finelinepainting pages against the rendered live pages", () => {
  const rates = new Map<string, Record<string, number>>();

  test.each(LIVE)("$file: the content region reads like the live page's", ({ file, id, floor }) => {
    const { out } = of("fineline");
    const page = out.pages.find((p) => p.id === id)!;
    const live = fromHtml(readFileSync(`tests/fixtures/fineline/html/${file}`, "utf8")) as Hast;
    const mine = fromHtml(builtSites.get("fineline")!.html(page.route)) as Hast;
    // The page template's content block is `div.content-<id>` between the header and the footer; the
    // test layout wraps the slot in `<main>`.
    const a = contentOf(
      live,
      (e) => e.tagName === "div" && /(^| )content-c[0-9a-f]+( |$)/.test(classOf(e)),
    );
    const b = contentOf(mine, (e) => e.tagName === "main");
    const measured = {
      words: sequenceRatio(a.words, b.words),
      headings: bagRatio(a.headings, b.headings),
      links: bagRatio(a.links, b.links),
      images: bagRatio(a.images, b.images),
    };
    rates.set(file, measured);
    for (const key of ["words", "headings", "links", "images"] as const) {
      expect(measured[key], `${file} ${key}`).toBeGreaterThanOrEqual(floor[key]);
    }
  });

  test("the four pages together match on 9 words in 10", () => {
    const words = LIVE.map(({ file }) => rates.get(file)!.words);
    expect(words.length).toBe(4);
    const mean = words.reduce((sum: number, rate) => sum + (rate ?? 0), 0) / words.length;
    console.log(
      `match rates (words / headings / links / images)\n${LIVE.map(({ file }) => {
        const r = rates.get(file)!;
        return `  ${file.padEnd(22)} ${[r.words, r.headings, r.links, r.images].map((x) => x!.toFixed(3)).join(" / ")}`;
      }).join("\n")}\n  mean words ${mean.toFixed(3)}`,
    );
    expect(mean).toBeGreaterThanOrEqual(0.9);
  });

  test("the privacy policy is the same text word for word, but for the e-mail address Cloudflare hid", () => {
    const live = fromHtml(
      readFileSync("tests/fixtures/fineline/html/privacy-policy.html", "utf8"),
    ) as Hast;
    const page = of("fineline").out.pages.find((p) => p.id === 3483)!;
    const mine = fromHtml(builtSites.get("fineline")!.html(page.route)) as Hast;
    const a = contentOf(
      live,
      (e) => e.tagName === "div" && /(^| )content-c[0-9a-f]+( |$)/.test(classOf(e)),
    );
    const b = contentOf(mine, (e) => e.tagName === "main");
    expect(b.words).toEqual(a.words);
    expect(b.headings).toEqual(a.headings);
  });

  test("the head of each page says what the live head says (description, robots, og:*, twitter:*)", () => {
    const { out } = of("fineline");
    for (const { file, id } of LIVE) {
      const live = liveHead(file);
      const doc = parse(fileOf(out, out.pages.find((p) => p.id === id)!.file));
      const head = Object.fromEntries(
        doc.$head!.map((e) => [
          e.attributes!.name ?? e.attributes!.property,
          e.attributes!.content,
        ]),
      );
      expect(doc.title, `${file} title`).toBe(live.get("title")!);
      for (const key of [
        "description",
        "robots",
        "og:locale",
        "og:type",
        "og:title",
        "og:description",
        "og:site_name",
        "twitter:card",
        "twitter:title",
        "twitter:description",
      ]) {
        expect(head[key], `${file} ${key}`).toBe(live.get(key));
      }
      expect(head["og:image"] !== undefined, `${file} og:image`).toBe(live.has("og:image"));
    }
  });
});

// ── What converters hand over: placeholders, components, state, hoisted rules ────────────────────

/** A conversion result for page 1716 holding these nodes: the seam `buildPages` converts through. */
function fakeConversion(
  nodes: JxNode[],
  extra: Partial<Pick<Converted, "hoisted" | "state">> & {
    states?: string[];
    components?: string[];
  } = {},
): NonNullable<PageOptions["convert"]> {
  return async (site, subject) => {
    const post = site.model.posts.get((subject as { id: number }).id)!;
    return {
      subject,
      post,
      nodes: structuredClone(nodes),
      hoisted: extra.hoisted ?? [],
      used: {
        components: new Set(extra.components ?? []),
        wpClasses: new Set(),
        cssFiles: new Set(),
        placeholders: new Set(),
        placeholderCounts: new Map(),
        states: new Set(extra.states ?? []),
      },
      state: extra.state ?? {},
      report: createReport(),
      css: emptyCssIndex(),
    };
  };
}

const ABOUT = 1716;
const placeholder = (
  tag: string,
  attributes: Record<string, string> = {},
  more: Partial<JxElement> = {},
): JxElement => ({ tagName: tag, attributes, ...more }) as JxElement;

describe("placeholders in a page", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  const run = async (nodes: JxNode[], opts: PageOptions = {}) => {
    const out = await buildPages(site, {
      only: [ABOUT],
      layoutFor: hierarchyLayout,
      convert: fakeConversion(nodes),
      ...opts,
    });
    return { out, doc: parse(out.files[0]!) };
  };

  test("a template part becomes an instance of its component, which `$elements` registers", async () => {
    const { out, doc } = await run([
      placeholder(
        "wp2jx-template-part",
        { slug: "header", theme: "cwicly", "data-block": "core/template-part" },
        { className: "wp-block-template-part" },
      ),
      { tagName: "p", textContent: "x" },
      placeholder("wp2jx-template-part", { slug: "footer", theme: "cwicly" }),
    ]);
    expect(doc.children).toEqual([
      { tagName: "wp-header", className: "wp-block-template-part" },
      { tagName: "p", textContent: "x" },
      { tagName: "wp-footer" },
    ]);
    expect(doc.$elements).toEqual([
      { $ref: "../components/wp-footer.json" },
      { $ref: "../components/wp-header.json" },
    ]);
    expect([...out.used.components].sort()).toEqual(["wp-footer", "wp-header"]);
    expect(codes(out)).not.toContain("placeholder.unresolved");
  });

  test("a part nobody published stays, and is reported as unresolved", async () => {
    const { out, doc } = await run([
      placeholder("wp2jx-template-part", { slug: "nonesuch", theme: "cwicly" }),
      placeholder("wp2jx-template-part", {}),
    ]);
    expect((doc.children as JxElement[]).map((e) => e.tagName)).toEqual([
      "wp2jx-template-part",
      "wp2jx-template-part",
    ]);
    const unresolved = out.report.entries().filter((e) => e.code === "placeholder.unresolved");
    expect(unresolved).toHaveLength(2);
    expect(unresolved[0]).toMatchObject({
      severity: "error",
      where: `post:${ABOUT}`,
      url: "https://finelinepainting.pro/about-us/",
    });
    expect(doc.$elements).toBeUndefined();
  });

  test("a shortcode is a visible neutral element holding its source, and says so in the report", async () => {
    const { out, doc } = await run([
      placeholder("wp2jx-shortcode", {
        "data-shortcode": "trustindex",
        "data-source": "[trustindex no-registration=google]",
      }),
    ]);
    expect(doc.children).toEqual([
      {
        tagName: "div",
        className: "wp2jx-unconverted wp2jx-shortcode",
        attributes: { "data-wp2jx": "shortcode:trustindex" },
        textContent: "[trustindex no-registration=google]",
      },
    ]);
    expect(out.report.entries().filter((e) => e.code === "page.placeholder-neutral")).toEqual([
      expect.objectContaining({
        severity: "warn",
        where: `post:${ABOUT}`,
        data: { kind: "shortcode", shortcode: "trustindex" },
      }),
    ]);
  });

  test("an enclosing shortcode keeps what it encloses instead of its own text", async () => {
    const { doc } = await run([
      placeholder(
        "wp2jx-shortcode",
        { "data-shortcode": "su_box", "data-source": "[su_box]hi[/su_box]" },
        { children: [{ tagName: "p", textContent: "hi" }] },
      ),
    ]);
    expect(doc.children).toEqual([
      {
        tagName: "div",
        className: "wp2jx-unconverted wp2jx-shortcode",
        attributes: { "data-wp2jx": "shortcode:su_box" },
        children: [{ tagName: "p", textContent: "hi" }],
      },
    ]);
  });

  test("text a neutral element prints cannot read as a binding", async () => {
    const { doc } = await run([
      placeholder("wp2jx-shortcode", { "data-shortcode": "x", "data-source": "[x a=${b}]" }),
    ]);
    expect((doc.children as JxElement[])[0]!.textContent).toBe("[x a=$​{b}]");
    expect(JSON.stringify(doc)).not.toContain("${");
  });

  test("a block that saved no markup is a neutral element naming it", async () => {
    const { out, doc } = await run([
      placeholder("wp2jx-block", {
        "data-block": "fluentfom/guten-block",
        "data-attrs": '{"formId":"1"}',
      }),
    ]);
    expect((doc.children as JxElement[])[0]).toEqual({
      tagName: "div",
      className: "wp2jx-unconverted wp2jx-block",
      attributes: { "data-wp2jx": "block:fluentfom/guten-block" },
      textContent: "[fluentfom/guten-block]",
    });
    expect(out.report.entries().find((e) => e.code === "page.placeholder-neutral")?.data).toEqual({
      kind: "block",
      block: "fluentfom/guten-block",
    });
  });

  test("the caller's resolvers answer for menus; a tag outranks a kind, a kind outranks `*`, and they outrank the defaults", async () => {
    const { out, doc } = await run(
      [
        placeholder("wp2jx-menu", { "data-menu": "7" }),
        placeholder("wp2jx-navigation", { "data-ref": "3" }),
        placeholder("wp2jx-shortcode", { "data-shortcode": "x", "data-source": "[x]" }),
        placeholder("wp2jx-template-part", { slug: "header", theme: "cwicly" }),
      ],
      {
        resolvers: {
          "wp2jx-menu": (p) => ({
            tagName: "nav",
            attributes: { "data-from": `tag ${p.attrs["data-menu"]}` },
          }),
          menu: () => ({ tagName: "nav", attributes: { "data-from": "kind" } }),
          navigation: () => ({ tagName: "nav", attributes: { "data-from": "kind" } }),
          shortcode: () => null,
          "*": () => ({ tagName: "aside" }),
        },
      },
    );
    expect(doc.children).toEqual([
      { tagName: "nav", attributes: { "data-from": "tag 7" } },
      { tagName: "nav", attributes: { "data-from": "kind" } },
      // `null` removes it; the part falls to the default (a kind) before `*`.
      { tagName: "wp-header" },
    ]);
    expect(codes(out)).not.toContain("page.placeholder-neutral");
  });

  test("a search form is a visible neutral element too", async () => {
    const { out, doc } = await run([placeholder("wp2jx-search", { "data-block": "core/search" })]);
    expect((doc.children as JxElement[])[0]).toEqual({
      tagName: "div",
      className: "wp2jx-unconverted wp2jx-search",
      attributes: { "data-wp2jx": "search" },
      textContent: "[search]",
    });
    expect(out.report.entries().find((e) => e.code === "page.placeholder-neutral")?.data).toEqual({
      kind: "search",
    });
  });

  test("a placeholder nobody answers for (a menu, until the menus emitter does) stays and is an error", async () => {
    const { out, doc } = await run([
      placeholder("wp2jx-menu", { "data-menu": "7" }),
      placeholder("wp2jx-post-content"),
    ]);
    expect((doc.children as JxElement[]).map((e) => e.tagName)).toEqual([
      "wp2jx-menu",
      "wp2jx-post-content",
    ]);
    const unresolved = out.report.entries().filter((e) => e.code === "placeholder.unresolved");
    expect(unresolved).toHaveLength(2);
    expect(unresolved[0]).toMatchObject({
      severity: "error",
      where: `post:${ABOUT}`,
      data: { tag: "wp2jx-menu", attributes: { "data-menu": "7" } },
    });
  });

  test("a replacement that holds more placeholders is resolved in turn", async () => {
    const { doc } = await run([placeholder("wp2jx-menu")], {
      resolvers: {
        menu: () => ({
          tagName: "nav",
          children: [
            placeholder("wp2jx-shortcode", { "data-shortcode": "y", "data-source": "[y]" }),
          ],
        }),
      },
    });
    const nav = (doc.children as JxElement[])[0]!;
    expect((nav.children as JxElement[])[0]!.className).toBe("wp2jx-unconverted wp2jx-shortcode");
  });
});

describe("what a page's conversion registers", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  const run = async (
    nodes: JxNode[],
    extra: Parameters<typeof fakeConversion>[1] = {},
    opts: PageOptions = {},
  ) => {
    const out = await buildPages(site, {
      only: [ABOUT],
      layoutFor: hierarchyLayout,
      convert: fakeConversion(nodes, extra),
      ...opts,
    });
    return { out, doc: parse(out.files[0]!) };
  };

  test("a component the nodes instantiate is registered once, sorted, whatever the conversion claimed", async () => {
    const { out, doc } = await run(
      [
        { tagName: "wp-icon-card", $props: { label: "a" } } as unknown as JxElement,
        { tagName: "div", children: [{ tagName: "wp-image-card" }, { tagName: "wp-icon-card" }] },
        { tagName: "not-a-component" },
      ],
      { components: ["wp-never-used"] },
    );
    expect(doc.$elements).toEqual([
      { $ref: "../components/wp-icon-card.json" },
      { $ref: "../components/wp-image-card.json" },
    ]);
    expect([...out.used.components]).toEqual(["wp-icon-card", "wp-image-card"]);
  });

  test("state entries are written, and the pointers to them are accounted for", async () => {
    const entry = { $prototype: "ContentCollection", contentType: "project", timing: "compiler" };
    const { out, doc } = await run(
      [
        {
          tagName: "ul",
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/projects" },
            map: { tagName: "li" },
          },
        } as unknown as JxElement,
      ],
      { state: { projects: entry }, states: ["projects"] },
    );
    expect(doc.state).toMatchObject({ projects: entry });
    expect(Object.keys(doc.state!)).toEqual(["projects", ENTRY_STATE_KEY]);
    expect([...out.used.states]).toEqual(["projects"]);
    expect(codes(out)).not.toContain("page.state-missing");
    // `state` sits after `$elements` and before `children`, where the build reads it.
    expect(Object.keys(doc)).toEqual(["title", "$layout", "$head", "state", "children"]);
  });

  test("a pointer to a state entry nobody registered is an error naming the key", async () => {
    const { out, doc } = await run(
      [
        {
          tagName: "ul",
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/gone" },
            map: { tagName: "li" },
          },
        } as unknown as JxElement,
      ],
      { states: ["also-gone"] },
    );
    expect(Object.keys(doc.state ?? {})).toEqual([ENTRY_STATE_KEY]);
    const missing = out.report.entries().filter((e) => e.code === "page.state-missing");
    expect(missing.map((e) => (e.data as { key: string }).key)).toEqual(["also-gone", "gone"]);
    expect(missing[0]).toMatchObject({ severity: "error", where: `post:${ABOUT}` });
  });

  test("hoisted rules become the page's own style, and the report says how they were written", async () => {
    const { out, doc } = await run([{ tagName: "p", textContent: "x" }], {
      hoisted: [
        { selector: "@keyframes fade-in", style: { from: { opacity: "0" } } },
        { selector: ".a, .b", style: { color: "red" } },
        { selector: ".a, .b", style: { color: "red" } },
        { selector: "body.x", style: { margin: "0" } },
        { selector: "@keyframes fade-in", style: { from: { opacity: "1" } } },
      ],
    });
    expect(doc.style).toEqual({
      "@keyframes fade-in": { from: { opacity: "1" } },
      "& .a": { color: "red" },
      "& .b": { color: "red" },
    });
    const entries = out.report.entries();
    expect(entries.find((e) => e.code === "page.hoisted-nested")).toMatchObject({
      severity: "info",
      where: `post:${ABOUT}`,
    });
    // `.a, .b` twice is two keys, not four.
    expect(entries.find((e) => e.code === "page.hoisted-nested")!.message).toStartWith(
      "2 hoisted rules are scoped",
    );
    // Nothing is lost: the rule is handed back for the project's style, and the report says so.
    expect(entries.find((e) => e.code === "page.hoisted-unplaced")).toMatchObject({
      severity: "info",
      data: { selector: "body.x" },
    });
    expect(out.used.documentRules).toEqual([{ selector: "body.x", style: { margin: "0" } }]);
    expect(entries.find((e) => e.code === "page.hoisted-collision")).toMatchObject({
      severity: "warn",
      data: { key: "@keyframes fade-in" },
    });
    // `used.hoisted` is what was written into pages: the rule about `body` was not (it is a document rule).
    expect(out.used.hoisted.map((r) => r.selector)).toEqual([
      "@keyframes fade-in",
      ".a, .b",
      "@keyframes fade-in",
    ]);
  });

  test("a page with no rules to hoist has no `style`", async () => {
    const { doc } = await run([{ tagName: "p", textContent: "x" }]);
    expect(doc.style).toBeUndefined();
  });

  test("a url() in a style that names an upload becomes the project's own copy; bindings and relative urls are left alone", async () => {
    const original: JxNode[] = [
      {
        tagName: "section",
        style: {
          backgroundImage:
            "url(https://finelinepainting.pro/wp-content/uploads/Dining-room-2-scaled.jpg)",
          "@--md": {
            backgroundImage:
              'url("//finelinepainting.pro/wp-content/uploads/Dining-room-2-scaled.jpg")',
          },
          maskImage: "url(https://finelinepainting.pro/wp-content/uploads/${state.x}.jpg)",
          borderImage: "url(/media/already.png)",
          content: "url(data:image/png;base64,AAAA)",
        },
      } as unknown as JxElement,
    ];
    const { out, doc } = await run(original);
    const style = (doc.children as JxElement[])[0]!.style as Record<string, unknown>;
    // Only an absolute address is asked about (and so only it can be reported as one nothing accounts for).
    expect(codes(out)).not.toContain("url.unresolved");
    const own = site.media.mediaForUrl(
      "https://finelinepainting.pro/wp-content/uploads/Dining-room-2-scaled.jpg",
    )!.src;
    expect(own).toStartWith("/media/Dining-room-2");
    expect(style.backgroundImage).toBe(`url(${own})`);
    expect((style["@--md"] as Record<string, string>).backgroundImage).toBe(`url("${own}")`);
    expect(style.maskImage).toBe(
      "url(https://finelinepainting.pro/wp-content/uploads/${state.x}.jpg)",
    );
    expect(style.borderImage).toBe("url(/media/already.png)");
    expect(style.content).toBe("url(data:image/png;base64,AAAA)");
  });

  test("the converter's own nodes are not edited", async () => {
    const node = {
      tagName: "section",
      style: {
        backgroundImage:
          "url(https://finelinepainting.pro/wp-content/uploads/Dining-room-2-scaled.jpg)",
      },
    } as unknown as JxElement;
    const shared = fakeConversion([node]);
    await buildPages(site, {
      only: [ABOUT],
      layoutFor: hierarchyLayout,
      convert: async (s, subject, o) => {
        const converted = await shared!(s, subject, o);
        converted.nodes = [node];
        return converted;
      },
    });
    expect((node.style as Record<string, string>).backgroundImage).toContain("wp-content/uploads");
  });

  test("an empty page is written with no children, and reported", async () => {
    const { out, doc } = await run([]);
    expect(doc.children).toEqual([]);
    expect(out.report.entries().find((e) => e.code === "page.empty")).toMatchObject({
      severity: "info",
      where: `post:${ABOUT}`,
    });
  });

  test("a binding where the build never evaluates it is an error naming where", async () => {
    const { out } = await run([
      { tagName: "div", children: [{ tagName: "p", className: "a ${x}" }] },
    ]);
    expect(out.report.entries().find((e) => e.code === "page.binding-misplaced")).toMatchObject({
      severity: "error",
      where: `post:${ABOUT}`,
      data: { path: "children/0/children/0", position: "className" },
    });
  });

  test("a conversion that throws skips the page and is an error", async () => {
    const out = await buildPages(site, {
      only: [ABOUT, 3483],
      layoutFor: hierarchyLayout,
      convert: async (s, subject, o) => {
        if ((subject as { id: number }).id === ABOUT) throw new Error("boom");
        return fakeConversion([{ tagName: "p", textContent: "ok" }])!(s, subject, o);
      },
    });
    expect(out.files.map((f) => f.path)).toEqual(["pages/privacy-policy.json"]);
    expect(out.skipped).toEqual([
      expect.objectContaining({ id: ABOUT, code: "page.convert-failed" }),
    ]);
    expect(out.report.entries().find((e) => e.code === "page.convert-failed")).toMatchObject({
      severity: "error",
      where: `post:${ABOUT}`,
      url: "https://finelinepainting.pro/about-us/",
    });
    expect(out.report.entries().find((e) => e.code === "page.convert-failed")!.message).toContain(
      "boom",
    );
  });
});

// ── The layout the templates emitter chooses ─────────────────────────────────────────────────────

describe("the layout of a page", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  const only = (opts: PageOptions = {}) =>
    buildPages(site, { only: [3483], templates: false, ...opts });

  test("a layoutFor that answers a path or a path with its template is used as it comes", async () => {
    const asString = await only({ layoutFor: () => "./layouts/mine.json" });
    expect(asString.pages[0]!.layout).toBe("./layouts/mine.json");
    expect(parse(asString.files[0]!).$layout).toBe("./layouts/mine.json");
    const asObject = await only({
      layoutFor: async () => ({ path: "./layouts/other.json", template: "other" }),
    });
    expect(asObject.pages[0]!.layout).toBe("./layouts/other.json");
    expect(codes(asObject)).not.toContain("page.layout-hierarchy");
  });

  test("it is asked about the page as a post subject", async () => {
    const asked: unknown[] = [];
    await only({
      layoutFor: (_site, subject) => {
        asked.push(subject);
        return "./layouts/page.json";
      },
    });
    expect(asked).toEqual([{ kind: "post", id: 3483 }]);
  });

  test("without the templates emitter the hierarchy answers, and the report says so once", async () => {
    const out = await buildPages(site, { only: [3483, 1716], templates: false });
    expect(out.pages.map((p) => p.layout)).toEqual(["./layouts/page.json", "./layouts/page.json"]);
    expect(codes(out).filter((c) => c === "page.layout-hierarchy")).toHaveLength(1);
  });

  test("no template to choose from: the page is written with no $layout, and that is an error", async () => {
    const out = await only({ layoutFor: () => undefined });
    const doc = parse(out.files[0]!);
    expect(doc.$layout).toBeUndefined();
    expect(Object.keys(doc)).toEqual(["title", "$head", "state", "children"]);
    expect(out.pages[0]!.layout).toBeNull();
    expect(out.report.entries().filter((e) => e.code === "page.no-layout")).toEqual([
      expect.objectContaining({ severity: "error", where: "post:3483" }),
    ]);
  });

  test("without a layout the title does leak onto the root as a tooltip: the check that says it does not has teeth", async () => {
    const out = await only({ layoutFor: () => undefined });
    const built = await buildJxProject(
      {
        "project.json": { name: "t", url: "https://example.com" },
        [out.files[0]!.path]: out.files[0]!.content,
      },
      { name: "pages-nolayout" },
    );
    const body = built.html("/privacy-policy/");
    const body2 = body.slice(body.indexOf("<body>"));
    expect(/^<body>\s*<[a-z0-9-]+[^>]*\stitle=/.test(body2)).toBe(true);
  });

  test("a layoutFor that throws is reported as no layout, and the page is still written", async () => {
    const out = await only({
      layoutFor: () => {
        throw new Error("no template");
      },
    });
    expect(out.files).toHaveLength(1);
    const entry = out.report.entries().find((e) => e.code === "page.no-layout")!;
    expect(entry.message).toContain("no template");
    expect(entry.severity).toBe("error");
  });

  describe("the templates module", () => {
    const dir = join(TMP_ROOT, `pages-templates-${process.pid}`);
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const write = (name: string, source: string): string => {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, name);
      writeFileSync(file, source);
      return file;
    };

    test("its layoutFor is the one used", async () => {
      const file = write(
        "good.ts",
        `export const layoutFor = (_site: unknown, subject: { id: number }) => ({ path: "./layouts/from-module-" + subject.id + ".json" });`,
      );
      const out = await buildPages(site, { only: [3483], templates: file });
      expect(out.pages[0]!.layout).toBe("./layouts/from-module-3483.json");
      expect(codes(out)).not.toContain("page.layout-hierarchy");
      expect(codes(out)).not.toContain("page.layout-module-failed");
    });

    test("a module that fails to load is a warning, and the hierarchy answers", async () => {
      const file = write("broken.ts", `throw new Error("templates exploded");`);
      const out = await buildPages(site, { only: [3483], templates: file });
      expect(out.pages[0]!.layout).toBe("./layouts/page.json");
      const warning = out.report.entries().find((e) => e.code === "page.layout-module-failed")!;
      expect(warning).toMatchObject({ severity: "warn", where: "site" });
      expect(warning.message).toContain("templates exploded");
    });

    test("a module with no layoutFor, and a module that is not there, fall back to the hierarchy", async () => {
      const bare = write("bare.ts", `export const other = 1;`);
      const a = await buildPages(site, { only: [3483], templates: bare });
      expect(a.pages[0]!.layout).toBe("./layouts/page.json");
      expect(codes(a)).toContain("page.layout-hierarchy");
      const b = await buildPages(site, { only: [3483], templates: join(dir, "absent.ts") });
      expect(b.pages[0]!.layout).toBe("./layouts/page.json");
      expect(codes(b)).not.toContain("page.layout-module-failed");
    });
  });

  test.skipIf(!existsSync(join(import.meta.dir, "../../src/emit/templates.ts")))(
    "with emit/templates.ts beside it, every page of both sites gets a layout from the default run",
    async () => {
      for (const name of ["fineline", "ap"] as const) {
        const out = await buildPages(of(name).site);
        expect(codes(out), name).not.toContain("page.no-layout");
        expect(codes(out), name).not.toContain("page.layout-module-failed");
        for (const page of out.pages) {
          expect(page.layout, `${name} ${page.route}`).toMatch(/^\.\/layouts\/[a-z0-9_-]+\.json$/);
        }
      }
    },
  );

  test("Cwicly's own assignment rules are not evaluated by the fallback, and the report says so", async () => {
    // The rules as the options reader normalises them, from `cwicly_conditions` as the plugin stores it.
    const optionsWith = (include: Record<string, unknown>): LoadedSite["options"] => {
      const raw = JSON.stringify({ include });
      return {
        ...site.options,
        conditions: JSON.parse(raw),
        templateRules: readCwiclyOptions(new Map([["cwicly_conditions", raw]])).templateRules,
      };
    };
    const withRules = {
      ...site,
      options: optionsWith({
        "archive-project": {
          all: "false",
          singular: [],
          archive: [],
          author: [],
          acf: [],
          custom: [],
        },
      }),
    } as LoadedSite;
    expect(codes(await buildPages(withRules, { only: [3483], templates: false }))).not.toContain(
      "page.template-conditions",
    );
    const applying = {
      ...site,
      options: optionsWith({ "wp-custom-template-x": { all: "true", singular: [], archive: [] } }),
    } as LoadedSite;
    const out = await buildPages(applying, { only: [3483], templates: false });
    expect(out.report.entries().find((e) => e.code === "page.template-conditions")).toMatchObject({
      severity: "warn",
      where: "post:3483",
    });
    // A layoutFor of the caller's own (the templates emitter) evaluates them itself.
    expect(
      codes(await buildPages(applying, { only: [3483], layoutFor: hierarchyLayout })),
    ).not.toContain("page.template-conditions");
  });
});

// ── Head edge cases, through the whole pipeline ──────────────────────────────────────────────────

describe("a page's head from Rank Math, end to end", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  test("a literal dollar-brace in the title is degraded, in the title and the head alike, and reported", async () => {
    const edited = withModel(site, (model) =>
      setMeta(model, 3483, "rank_math_title", "Cost ${amount} now"),
    );
    const out = await buildPages(edited, { only: [3483], layoutFor: hierarchyLayout });
    const doc = parse(out.files[0]!);
    expect(doc.title).toBe("Cost $​{amount} now");
    const head = Object.fromEntries(
      doc.$head!.map((e) => [e.attributes!.name ?? e.attributes!.property, e.attributes!.content]),
    );
    expect(head["og:title"]).toBe("Cost $​{amount} now");
    expect(head["twitter:title"]).toBe("Cost $​{amount} now");
    expect(misplacedBindings(doc)).toEqual([]);
    expect(out.report.entries().find((e) => e.code === "page.literal-template")).toMatchObject({
      severity: "warn",
      where: "post:3483",
    });
    // ... and the build prints it as text instead of evaluating it.
    const built = await buildJxProject(projectOf(edited, out), { name: "pages-literal" });
    expect(built.html("/privacy-policy/")).toContain("<title>Cost $​{amount} now</title>");
  });

  test("a canonical a person set is written once, and Jx adds neither a second canonical nor a second og:url", async () => {
    const edited = withModel(site, (model) =>
      setMeta(model, 3483, "rank_math_canonical_url", "https://elsewhere.example/privacy/"),
    );
    const out = await buildPages(edited, { only: [3483], layoutFor: hierarchyLayout });
    const doc = parse(out.files[0]!);
    expect(doc.$head!.filter((e) => e.attributes!.rel === "canonical")).toEqual([
      {
        tagName: "link",
        attributes: { rel: "canonical", href: "https://elsewhere.example/privacy/" },
      },
    ]);
    const built = await buildJxProject(projectOf(edited, out), { name: "pages-canonical" });
    const html = built.html("/privacy-policy/");
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain('<link rel="canonical" href="https://elsewhere.example/privacy/">');
    expect(html.match(/property="og:url"/g)).toHaveLength(1);
    expect(html).toContain('<meta property="og:url" content="https://elsewhere.example/privacy/">');
  });

  test("the site address og:image is made absolute against can be set", async () => {
    const out = await buildPages(site, {
      only: [1716],
      layoutFor: hierarchyLayout,
      siteUrl: "https://new.example.com/",
    });
    const image = parse(out.files[0]!).$head!.find((e) => e.attributes!.property === "og:image")!;
    expect(image.attributes!.content).toBe(
      "https://new.example.com/media/About-fine-line-painting-header.png",
    );
  });
});

// ── Pages the route table does not give a file of their own ──────────────────────────────────────

describe("pages without an address of their own", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  test("a published page nobody can reach is skipped and reported", async () => {
    const edited = withModel(site, (model) => {
      model.posts.set(90010, { ...model.posts.get(3483)!, id: 90010, slug: "", title: "Nameless" });
    });
    const out = await buildPages(edited, { only: [90010], layoutFor: hierarchyLayout });
    expect(out.files).toEqual([]);
    expect(out.skipped).toEqual([expect.objectContaining({ id: 90010, code: "page.no-route" })]);
    expect(out.report.entries()[0]).toMatchObject({
      severity: "warn",
      code: "page.no-route",
      where: "post:90010",
    });
  });

  test("a route that is not a page's is skipped and reported, not written over something else", async () => {
    const odd = {
      ...site,
      routes: {
        ...site.routes,
        forPost: (id: number) => ({ ...site.routes.forPost(id)!, kind: "entry" as const }),
      },
    } as LoadedSite;
    const out = await buildPages(odd, { only: [3483], layoutFor: hierarchyLayout });
    expect(out.files).toEqual([]);
    expect(out.skipped[0]).toMatchObject({ id: 3483, code: "page.no-route" });
  });

  test("a nested page is written under its parent's directory and reaches components through the right number of ..", async () => {
    // Fineline's child pages are drafts; published, `interior-painting` is /residential/interior-painting/.
    const edited = withModel(site, (model) => {
      model.posts.set(1110, { ...model.posts.get(1110)!, status: "publish" });
    });
    const routes = buildRoutes(edited.model, edited.acf, { media: edited.media });
    const nested: LoadedSite = {
      ...edited,
      routes,
      urls: createUrlTools(edited.model, routes, edited.media),
    };
    const out = await buildPages(nested, {
      only: [1110],
      layoutFor: hierarchyLayout,
      convert: fakeConversion([{ tagName: "wp-icon-card" }]),
    });
    expect(out.pages).toEqual([
      {
        id: 1110,
        route: "/residential/interior-painting/",
        file: "pages/residential/interior-painting.json",
        layout: "./layouts/page.json",
      },
    ]);
    expect(parse(out.files[0]!).$elements).toEqual([
      { $ref: "../../components/wp-icon-card.json" },
    ]);
    const built = await buildJxProject(projectOf(nested, out), { name: "pages-nested" });
    const html = built.html("/residential/interior-painting/");
    expect(html).toContain("<main>");
    expect(html).toContain("wp-icon-card");
    const result = await validateJxProject(built.dir);
    expect(result.problems).toEqual([]);
  });
});

// ── The social image, through the attachment ─────────────────────────────────────────────────────

describe("the social image of a page", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  const headOf = async (id: number, siteUrl?: string) => {
    const out = await buildPages(site, {
      only: [id],
      layoutFor: hierarchyLayout,
      ...(siteUrl === undefined ? {} : { siteUrl }),
    });
    const head = parse(out.files[0]!).$head!;
    return {
      out,
      byName: Object.fromEntries(
        head.map((e) => [e.attributes!.name ?? e.attributes!.property, e.attributes!.content]),
      ),
      head,
    };
  };

  test("an attachment whose guid is a page address still resolves through its id", async () => {
    // The live /commercial/ prints https://finelinepainting.pro/wp-content/uploads/ehd8y1znfpk.jpg;
    // attachment 988's guid is the page address /photo-by-nastuh-abootalebi/, so the address Rank Math
    // is guessed to print names nothing and only the id finds the file.
    const { out, byName } = await headOf(960);
    expect(byName["og:image"]).toBe("https://finelinepainting.pro/media/ehd8y1znfpk.jpg");
    expect(byName["twitter:image"]).toBe(byName["og:image"]!);
    expect(byName["og:image:width"]).toBe("1600");
    expect(byName["og:image:height"]).toBe("1068");
    expect(codes(out)).not.toContain("page.og-image-unresolved");
  });

  test("the og:image of every page is the project's own copy, whatever the guid says", async () => {
    const { out } = of("fineline");
    for (const file of out.files) {
      const images = parse(file).$head!.filter(
        (e) => e.attributes!.property === "og:image" || e.attributes!.name === "twitter:image",
      );
      for (const image of images) {
        expect(image.attributes!.content, file.path).toMatch(
          /^https:\/\/finelinepainting\.pro\/media\//,
        );
      }
    }
  });

  test("an id the media plan does not know falls back to the address, and says so", () => {
    const asked: unknown[] = [];
    const seo = seoFor(site.model, { kind: "post", post: site.model.posts.get(1716)! });
    const image = { id: 99999999, url: "https://cdn.example.net/x.png" };
    const { image: _own, ...twitter } = seo.twitter;
    const entries = headEntries(
      { ...seo, twitter, openGraph: { ...seo.openGraph, image } },
      {
        siteUrl: "https://finelinepainting.pro",
        mediaForUrl: () => undefined,
        mediaFor: () => undefined,
        text: (value) => value,
        unresolvedImage: (unknown) => asked.push(unknown),
      },
    );
    expect(asked).toEqual([image]);
    expect(entries.find((e) => e.attributes.property === "og:image")!.attributes.content).toBe(
      "https://cdn.example.net/x.png",
    );
    // An image with no attachment is simply an address; nothing is unresolved about it.
    asked.length = 0;
    headEntries(
      { ...seo, twitter, openGraph: { ...seo.openGraph, image: { url: image.url } } },
      {
        siteUrl: "https://finelinepainting.pro",
        mediaForUrl: () => undefined,
        mediaFor: () => undefined,
        text: (value) => value,
        unresolvedImage: (unknown) => asked.push(unknown),
      },
    );
    expect(asked).toEqual([]);
  });

  test("a protocol-relative address is already absolute and is left as it is", () => {
    const seo = seoFor(site.model, { kind: "post", post: site.model.posts.get(1716)! });
    const entries = headEntries(
      { ...seo, openGraph: { ...seo.openGraph, image: { url: "//cdn.example.net/x.png" } } },
      {
        siteUrl: "https://finelinepainting.pro",
        mediaForUrl: () => undefined,
        text: (value) => value,
      },
    );
    expect(entries.find((e) => e.attributes.property === "og:image")!.attributes.content).toBe(
      "//cdn.example.net/x.png",
    );
  });

  test("Open Graph tags are `property`, Twitter tags are `name`: that is what each reader looks for", async () => {
    const { head } = await headOf(1716);
    for (const entry of head.filter((e) => e.tagName === "meta")) {
      const name = String(entry.attributes!.name ?? entry.attributes!.property);
      const kind = entry.attributes!.name !== undefined ? "name" : "property";
      if (name.startsWith("og:")) expect(kind, name).toBe("property");
      if (name.startsWith("twitter:")) expect(kind, name).toBe("name");
    }
    expect(head.some((e) => e.attributes!.name === "twitter:image")).toBe(true);
    expect(head.some((e) => e.attributes!.property === "og:image")).toBe(true);
  });
});

// ── The page's own address ───────────────────────────────────────────────────────────────────────

describe("the canonical of a page", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  const headOf = async (edited: LoadedSite, id: number, siteUrl?: string) => {
    const out = await buildPages(edited, {
      only: [id],
      layoutFor: hierarchyLayout,
      ...(siteUrl === undefined ? {} : { siteUrl }),
    });
    return { out, head: parse(out.files[0]!).$head! };
  };
  const canonicalOf = (head: { attributes?: Record<string, unknown> }[]): string[] =>
    head.filter((e) => e.attributes!.rel === "canonical").map((e) => String(e.attributes!.href));
  const ogUrlOf = (head: { attributes?: Record<string, unknown> }[]): string[] =>
    head
      .filter((e) => e.attributes!.property === "og:url")
      .map((e) => String(e.attributes!.content));

  test("without one set by a person, the canonical and og:url are the page's own address with the route's slash", async () => {
    const { head } = await headOf(site, 1716);
    expect(canonicalOf(head)).toEqual(["https://finelinepainting.pro/about-us/"]);
    expect(ogUrlOf(head)).toEqual(["https://finelinepainting.pro/about-us/"]);
    const front = await headOf(site, 5246);
    expect(canonicalOf(front.head)).toEqual(["https://finelinepainting.pro/"]);
  });

  test("the address is the site's new one when the caller says so, and the order is Rank Math's", async () => {
    const { head } = await headOf(site, 1716, "https://new.example.com/");
    expect(canonicalOf(head)).toEqual(["https://new.example.com/about-us/"]);
    const names = head.map(
      (e) => e.attributes!.name ?? e.attributes!.property ?? e.attributes!.rel,
    );
    expect(names.indexOf("canonical")).toBe(names.indexOf("robots") + 1);
    expect(names.indexOf("og:url")).toBe(names.indexOf("og:description") + 1);
  });

  test("a canonical a person set for a page of the site names that page's route, not its old alias", async () => {
    // /home-2/ is an alias WordPress redirects to the front page, which is `/` here.
    const edited = withModel(site, (model) =>
      setMeta(model, 5246, "rank_math_canonical_url", "https://finelinepainting.pro/home-2/"),
    );
    const { head } = await headOf(edited, 5246);
    expect(canonicalOf(head)).toEqual(["https://finelinepainting.pro/"]);
    expect(ogUrlOf(head)).toEqual(["https://finelinepainting.pro/"]);
  });

  test("a canonical on another site is kept, and one the site cannot account for is reported", async () => {
    const away = withModel(site, (model) =>
      setMeta(model, 1716, "rank_math_canonical_url", "https://elsewhere.example/about/"),
    );
    expect(canonicalOf((await headOf(away, 1716)).head)).toEqual([
      "https://elsewhere.example/about/",
    ]);
    const gone = withModel(site, (model) =>
      setMeta(model, 1716, "rank_math_canonical_url", "https://finelinepainting.pro/no-such-page/"),
    );
    const { out } = await headOf(gone, 1716);
    expect(
      out.report.entries().find((e) => e.code === "url.unresolved" && e.where === "post:1716"),
    ).toBeDefined();
  });

  test("a noindex page keeps Rank Math's robots meta and is left out of the sitemap, which a built site honours", async () => {
    const edited = withModel(site, (model) =>
      setMeta(model, 3483, "rank_math_robots", ["noindex"]),
    );
    const out = await buildPages(edited, { only: [1716, 3483], layoutFor: hierarchyLayout });
    const hidden = parse(fileOf(out, "pages/privacy-policy.json"));
    const shown = parse(fileOf(out, "pages/about-us.json"));
    expect((hidden as Record<string, unknown>).$sitemap).toBe(false);
    expect("$sitemap" in shown).toBe(false);
    expect(
      hidden.$head!.find((e) => e.attributes!.name === "robots")!.attributes!.content,
    ).toContain("noindex");
    const built = await buildJxProject(projectOf(edited, out), { name: "pages-noindex" });
    const sitemap = built.read("sitemap.xml");
    // Jx's own sitemap writes the route without its trailing slash; what matters here is who is listed.
    expect(sitemap).toContain("/about-us<");
    expect(sitemap).not.toContain("privacy-policy");
    expect((await validateJxProject(built.dir)).problems).toEqual([]);
  });
});

// ── Hoisted rules: what CSS accumulates, what it replaces ────────────────────────────────────────

describe("hoistedStyle: two rules of one selector", () => {
  test("accumulate, as CSS does: the later value wins per property and nothing else is lost", () => {
    const placed = hoistedStyle([
      { selector: ".a", style: { color: "red", margin: "1px" } },
      { selector: ".a", style: { padding: "0" } },
      { selector: ".a", style: { color: "blue" } },
    ]);
    expect(placed.style).toEqual({ "& .a": { margin: "1px", padding: "0", color: "blue" } });
    expect(placed.collisions).toEqual([]);
  });

  test("keep the key where it first stood, and merge nested blocks the same way", () => {
    const placed = hoistedStyle([
      { selector: ".a", style: { color: "red", ":hover": { color: "red", top: "0" } } },
      { selector: ".b", style: { color: "green" } },
      { selector: ".a", style: { ":hover": { color: "blue" }, "@--md": { color: "pink" } } },
    ]);
    expect(Object.keys(placed.style)).toEqual(["& .a", "& .b"]);
    expect(placed.style["& .a"]).toEqual({
      color: "red",
      ":hover": { color: "blue", top: "0" },
      "@--md": { color: "pink" },
    });
  });

  test("a property written again moves to the end, so a shorthand after a longhand still wins", () => {
    const placed = hoistedStyle([
      { selector: ".a", style: { marginLeft: "1px", margin: "0" } },
      { selector: ".a", style: { marginLeft: "5px" } },
    ]);
    expect(Object.keys(placed.style["& .a"] as object)).toEqual(["margin", "marginLeft"]);
  });

  test("a media rule accumulates too; only a named definition (@keyframes, @property) replaces", () => {
    const placed = hoistedStyle([
      { selector: "@media (max-width: 1px)", style: { ".a": { color: "red" } } },
      { selector: "@media (max-width: 1px)", style: { ".b": { color: "blue" } } },
      { selector: "@property --x", style: { syntax: '"<length>"' } },
      { selector: "@property --x", style: { syntax: '"<color>"' } },
    ]);
    expect(placed.style["@media (max-width: 1px)"]).toEqual({
      ".a": { color: "red" },
      ".b": { color: "blue" },
    });
    expect(placed.collisions).toEqual(["@property --x"]);
    expect(placed.style["@property --x"]).toEqual({ syntax: '"<color>"' });
  });

  test("several @font-face rules share one key: they are a collision, never a silent overwrite", () => {
    const placed = hoistedStyle([
      { selector: "@font-face", style: { fontFamily: "A", src: "url(a.woff2)" } },
      { selector: "@font-face", style: { fontFamily: "B", src: "url(b.woff2)" } },
    ]);
    expect(placed.collisions).toEqual(["@font-face"]);
  });
});

describe("Fluent Forms in a page", () => {
  const QUOTE = 1013;
  const CONTACT = 1714;

  test("the quote and contact pages draw their forms where the block stood, in the style the block names", async () => {
    const site = { ...(await loadSite("fineline")), forms: await pilotForms() };
    const out = await buildPages(site, {
      only: [QUOTE, CONTACT],
      layoutFor: hierarchyLayout,
    });
    const quote = out.files.find((f) => f.path.endsWith("quote.json"))!.content;
    const contact = out.files.find((f) => f.path.endsWith("contact-us.json"))!.content;
    expect(quote).toContain("fluentform_wrapper_3");
    expect(quote).toContain("ffs_custom_wrap");
    expect(quote).not.toContain("[fluentfom/guten-block]");
    expect(contact).toContain("fluentform_wrapper_1");
    // the contact block says `themeStyle: ffs_classic`
    expect(contact).toContain("ffs_classic_wrap");
    expect(codes(out).filter((code) => code === "form.not-submittable")).toHaveLength(2);
    expect(codes(out)).not.toContain("page.placeholder-neutral");
    // the form is one element of the page: the plugin's wrapper, the form inside it as markup
    const wrapper = (JSON.parse(quote) as JxDocument).children as JxElement[];
    expect(JSON.stringify(wrapper)).toContain('"innerHTML":"<form data-form_id=\\"3\\"');
  });

  test("a site whose database holds no such form keeps the neutral stand-in and says so", async () => {
    const site = await loadSite("fineline");
    const out = await buildPages(site, { only: [QUOTE], layoutFor: hierarchyLayout });
    expect(out.files[0]!.content).toContain("[fluentfom/guten-block]");
    expect(codes(out)).toContain("page.placeholder-neutral");
    expect(codes(out)).toContain("form.missing");
  });
});

describe("hoisted rules in a page", () => {
  test("two rules of one selector from the converter are both in the page's style", async () => {
    const site = await loadSite("fineline");
    const out = await buildPages(site, {
      only: [ABOUT],
      layoutFor: hierarchyLayout,
      convert: fakeConversion([{ tagName: "p", textContent: "x" }], {
        hoisted: [
          { selector: ".a", style: { color: "red" } },
          { selector: ".a", style: { margin: "0" } },
        ],
      }),
    });
    expect(parse(out.files[0]!).style).toEqual({ "& .a": { color: "red", margin: "0" } });
    expect(codes(out)).not.toContain("page.hoisted-collision");
  });

  test("a font-face collision is said in its own words", async () => {
    const site = await loadSite("fineline");
    const out = await buildPages(site, {
      only: [ABOUT],
      layoutFor: hierarchyLayout,
      convert: fakeConversion([{ tagName: "p", textContent: "x" }], {
        hoisted: [
          { selector: "@font-face", style: { fontFamily: "A" } },
          { selector: "@font-face", style: { fontFamily: "B" } },
        ],
      }),
    });
    expect(
      out.report.entries().find((e) => e.code === "page.hoisted-collision")!.message,
    ).toContain("@font-face");
  });
});

describe("rules about the document, on the anabaptistperspectives pages", () => {
  test("the modal's scroll lock is not written into a page but is handed back for the project's style", () => {
    const { out } = of("ap");
    expect(out.used.documentRules.map((rule) => rule.selector)).toContain(
      "body:has(#modal-topics:popover-open)",
    );
    expect(out.used.documentRules.find((r) => r.selector.startsWith("body:has("))!.style).toEqual({
      overflow: "hidden",
    });
    expect(out.used.hoisted.some((rule) => rule.selector.startsWith("body"))).toBe(false);
    for (const file of out.files) {
      expect(Object.keys(parse(file).style ?? {}).some((key) => key.includes("body"))).toBe(false);
    }
    const unplaced = out.report.entries().filter((e) => e.code === "page.hoisted-unplaced");
    expect(unplaced.map((e) => e.where).sort()).toEqual(["post:10776", "post:1417"]);
    expect(unplaced.every((e) => e.severity === "info")).toBe(true);
  });

  test("a rule is handed back once, however many pages hold it", () => {
    const { out } = of("ap");
    const keys = out.used.documentRules.map(
      (rule) => `${rule.selector}${JSON.stringify(rule.style)}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the hoisted rules the pages write are accounted for in used.hoisted, and there are some", () => {
    const { out } = of("ap");
    let written = 0;
    for (const file of out.files) {
      const style = parse(file).style ?? {};
      for (const key of Object.keys(style)) {
        written++;
        const selector = key.startsWith("& ") ? key.slice(2) : key;
        expect(
          out.used.hoisted.some((rule) => rule.selector.includes(selector.split(",")[0]!)),
          key,
        ).toBe(true);
      }
    }
    expect(written).toBeGreaterThan(0);
  });
});

// ── Pointers: only a $ref is one ─────────────────────────────────────────────────────────────────

describe("the pointers a page holds to its state", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  const run = async (nodes: JxNode[], state: Record<string, unknown> = {}) => {
    const out = await buildPages(site, {
      only: [ABOUT],
      layoutFor: hierarchyLayout,
      convert: fakeConversion(nodes, { state }),
    });
    return { out, doc: parse(out.files[0]!) };
  };

  test("a paragraph that reads like a pointer is text, not a pointer", async () => {
    const { out } = await run([
      { tagName: "p", textContent: "#/state/foo is how a pointer reads" },
      { tagName: "p", attributes: { title: "#/state/bar" } },
    ]);
    expect(codes(out)).not.toContain("page.state-missing");
    expect([...out.used.states]).toEqual([]);
  });

  test("a stray percent sign in a text beginning like a pointer cannot abort the run", async () => {
    const { out, doc } = await run([{ tagName: "p", textContent: "#/state/100% sure" }]);
    expect(out.files).toHaveLength(1);
    expect(doc.children).toHaveLength(1);
    expect(codes(out)).not.toContain("page.convert-failed");
  });

  test("a real $ref is read the way convert.ts reads it: percent and tilde escapes decoded, a bad escape kept", async () => {
    const ref = (pointer: string): JxElement =>
      ({
        tagName: "ul",
        children: { $prototype: "Array", items: { $ref: pointer }, map: { tagName: "li" } },
      }) as unknown as JxElement;
    const { out } = await run([
      ref("#/state/a~1b/rows"),
      ref("#/state/100%"),
      ref("#/state/caf%C3%A9"),
    ]);
    const missing = out.report
      .entries()
      .filter((e) => e.code === "page.state-missing")
      .map((e) => (e.data as { key: string }).key);
    expect(missing).toEqual(["100%", "a/b", "café"]);
  });
});

// ── Templates of an inactive theme ───────────────────────────────────────────────────────────────

describe("the template hierarchy and the active theme", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  /** A published template `page-about-us` tagged with the theme `theme`'s wp_theme term. */
  const withTemplate = (theme: string | undefined): LoadedSite =>
    withModel(site, (model) => {
      const base = [...model.posts.values()].find((p) => p.type === "wp_template")!;
      model.posts.set(90100, { ...base, id: 90100, slug: "page-about-us" });
      if (theme !== undefined) {
        const terms = new Map(model.terms);
        terms.set(90101, {
          termId: 90101,
          taxonomyId: 90101,
          taxonomy: "wp_theme",
          slug: theme,
          name: theme,
          description: "",
          parent: 0,
          count: 1,
          meta: {},
        });
        const byPost = new Map(model.termsByPost);
        byPost.set(90100, [90101]);
        (model as { terms: unknown }).terms = terms;
        (model as { termsByPost: unknown }).termsByPost = byPost;
      }
    });

  test("a template of a theme that is no longer active is not a layout for the page", () => {
    expect(site.model.site.theme).toBe("cwicly");
    const edited = withTemplate("twentytwentyfour");
    expect(hierarchyLayout(edited, { kind: "post", id: 1716 })).toMatchObject({ template: "page" });
  });

  test("a template of the active theme, and a hand-made one with no theme at all, are", () => {
    expect(hierarchyLayout(withTemplate("cwicly"), { kind: "post", id: 1716 })).toMatchObject({
      template: "page-about-us",
    });
    expect(hierarchyLayout(withTemplate(undefined), { kind: "post", id: 1716 })).toMatchObject({
      template: "page-about-us",
    });
  });

  test("the same slug in an inactive theme and the active one counts once, for the active one", () => {
    const edited = withTemplate("twentytwentyfour");
    const model = edited.model as unknown as MutableModel & {
      termsByPost: Map<number, number[]>;
    };
    model.posts.set(90102, { ...model.posts.get(90100)!, id: 90102 });
    model.termsByPost = new Map(model.termsByPost).set(90102, []);
    expect(hierarchyLayout(edited, { kind: "post", id: 1716 })).toMatchObject({
      template: "page-about-us",
    });
  });
});

// ── Template rules, as the options reader normalised them ────────────────────────────────────────

describe("Cwicly's template-assignment rules", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  /** The site with `cwicly_conditions` as the plugin stores it, read the way the loader reads it. */
  const withConditions = (stored: unknown): LoadedSite => {
    const raw = JSON.stringify(stored);
    const read = readCwiclyOptions(new Map([["cwicly_conditions", raw]]));
    return {
      ...site,
      options: { ...site.options, conditions: read.conditions, templateRules: read.templateRules },
    } as LoadedSite;
  };
  const run = (edited: LoadedSite) => buildPages(edited, { only: [3483], templates: false });

  test("a malformed rule is the options reader's finding: it cannot abort the run", async () => {
    for (const stored of [{ include: { x: null } }, { include: [null] }, { include: { x: 3 } }]) {
      const out = await run(withConditions(stored));
      expect(out.files).toHaveLength(1);
      expect(codes(out)).not.toContain("page.template-conditions");
    }
  });

  test("a rule that assigns the template only through ACF conditions is a rule too", async () => {
    const out = await run(
      withConditions({
        include: { "only-acf": { all: "false", acf: [{ field: "x", value: "y" }] } },
      }),
    );
    const found = out.report.entries().find((e) => e.code === "page.template-conditions");
    expect(found).toMatchObject({ severity: "warn", where: "post:3483" });
    expect(found!.message).toContain("only-acf");
  });

  test("author and archive conditions assign a template as well; a rule that lists none does not", async () => {
    expect(
      codes(await run(withConditions({ include: { a: { all: "false", author: [{ id: 1 }] } } }))),
    ).toContain("page.template-conditions");
    expect(
      codes(await run(withConditions({ include: { b: { all: "false", archive: [{ id: 1 }] } } }))),
    ).toContain("page.template-conditions");
    expect(codes(await run(withConditions({ include: { c: { all: "false" } } })))).not.toContain(
      "page.template-conditions",
    );
  });

  test("an exclude rule alone assigns nothing", async () => {
    const out = await run(withConditions({ exclude: { d: { all: "true" } } }));
    expect(codes(out)).not.toContain("page.template-conditions");
  });
});

// ── One page's failure costs that page only ──────────────────────────────────────────────────────

describe("a page that cannot be built after its conversion", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  /** A conversion that holds a menu placeholder on the about page only. */
  const convert: NonNullable<PageOptions["convert"]> = async (s, subject) => {
    const nodes: JxNode[] =
      (subject as { id: number }).id === ABOUT
        ? [{ tagName: "wp2jx-menu", attributes: { "data-menu": "main" } } as unknown as JxElement]
        : [{ tagName: "p", textContent: "fine" }];
    const converted = await fakeConversion(nodes)(s, subject);
    // A finding of the conversion itself, which the page's own pass then has to keep.
    converted.report.add({ severity: "warn", code: "block.unsupported", message: "kept" });
    return converted;
  };

  test("a resolver that throws loses that page, reports it, and every other page is written", async () => {
    const out = await buildPages(site, {
      only: [ABOUT, 195],
      layoutFor: hierarchyLayout,
      convert,
      resolvers: {
        menu: () => {
          throw new Error("boom");
        },
      },
    });
    expect(out.files.map((f) => f.path)).toEqual(["pages/residential.json"]);
    expect(out.pages.map((p) => p.id)).toEqual([195]);
    expect(out.skipped).toEqual([
      expect.objectContaining({ id: ABOUT, code: "page.convert-failed" }),
    ]);
    const failed = out.report.entries().find((e) => e.code === "page.convert-failed")!;
    expect(failed).toMatchObject({
      severity: "error",
      where: `post:${ABOUT}`,
      url: "https://finelinepainting.pro/about-us/",
    });
    expect(failed.message).toContain("boom");
    // Nothing of the lost page is counted as written.
    expect([...out.used.components]).toEqual([]);
  });

  test("what the page's own pass found before it failed is kept in the report", async () => {
    const out = await buildPages(site, {
      only: [ABOUT],
      layoutFor: hierarchyLayout,
      convert,
      resolvers: {
        menu: () => {
          throw new Error("boom");
        },
      },
    });
    expect(out.files).toEqual([]);
    expect(codes(out)).toEqual(["block.unsupported", "page.convert-failed"]);
    expect(out.report.entries()[0]).toMatchObject({ where: `post:${ABOUT}` });
  });
});

// ── The post, for the layout ─────────────────────────────────────────────────────────────────────

describe("the page's own post as state.entry", () => {
  let site: LoadedSite;
  beforeAll(async () => {
    site = await loadSite("fineline");
  });

  const layout = {
    children: [
      { tagName: "h1", textContent: "${state.entry.data.title ?? ''}" },
      { tagName: "slot" },
    ],
  };

  test("carries the post's own fields, in the entry data contract's keys", async () => {
    const out = await buildPages(site, { only: [ABOUT], layoutFor: hierarchyLayout });
    const state = parse(out.files[0]!).state as unknown as {
      entry: { id: string; data: Record<string, unknown> };
    };
    expect(state.entry.id).toBe("/about-us/");
    expect(Object.keys(state.entry.data)).toEqual([
      "title",
      "slug",
      "date",
      "modified",
      "excerpt",
      "author",
      "url",
    ]);
    expect(state.entry.data.title).toBe("About Us");
    expect(state.entry.data.slug).toBe("about-us");
    expect(state.entry.data.url).toBe("/about-us/");
    expect(state.entry.data.date).toBe(new Date(state.entry.data.date as string).toISOString());
  });

  test("the title is the post's, not Rank Math's document title", async () => {
    const out = await buildPages(site, { only: [3483], layoutFor: hierarchyLayout });
    const doc = parse(out.files[0]!);
    const state = doc.state as unknown as { entry: { data: { title: string } } };
    expect(state.entry.data.title).toBe("Privacy Policy");
    expect(doc.title).not.toBe(state.entry.data.title);
  });

  test("a layout reads it, and the build prints the title in the H1 with no client runtime", async () => {
    const out = await buildPages(site, { only: [ABOUT], layoutFor: hierarchyLayout });
    const built = await buildJxProject(
      projectOf(site, out, { "layouts/page.json": { ...layout } }),
      { name: "pages-entry" },
    );
    const html = built.html("/about-us/");
    expect(html).toContain("<h1>About Us</h1>");
    expect(html).not.toContain("data-bind");
    expect((await validateJxProject(built.dir)).problems).toEqual([]);
  });

  test("a title that holds a dollar-brace is degraded like every other text, and still builds statically", async () => {
    const edited = withModel(site, (model) => {
      model.posts.set(ABOUT, { ...model.posts.get(ABOUT)!, title: "Cost ${amount} now" });
    });
    const out = await buildPages(edited, { only: [ABOUT], layoutFor: hierarchyLayout });
    const state = parse(out.files[0]!).state as unknown as { entry: { data: { title: string } } };
    expect(state.entry.data.title).toBe("Cost $​{amount} now");
    expect(codes(out)).toContain("page.literal-template");
    const built = await buildJxProject(
      projectOf(edited, out, { "layouts/page.json": { ...layout } }),
      { name: "pages-entry-literal" },
    );
    expect(built.html("/about-us/")).toContain("<h1>Cost $​{amount} now</h1>");
  });

  test("a conversion that registered `entry` itself keeps it, and the report says the post is not written", async () => {
    const own = { $prototype: "ContentEntry", contentType: "x", timing: "compiler" };
    const out = await buildPages(site, {
      only: [ABOUT],
      layoutFor: hierarchyLayout,
      convert: fakeConversion([{ tagName: "p", textContent: "x" }], { state: { entry: own } }),
    });
    expect(parse(out.files[0]!).state).toEqual({ entry: own });
    expect(out.report.entries().find((e) => e.code === "page.entry-state-taken")).toMatchObject({
      severity: "warn",
      where: `post:${ABOUT}`,
    });
  });

  test("a page whose entry cannot be read is still written, and the report says so", async () => {
    const broken = {
      ...site,
      urls: {
        ...site.urls,
        bind: (...args: Parameters<typeof site.urls.bind>) => ({
          ...site.urls.bind(...args),
          urlFor: () => {
            throw new Error("no address");
          },
        }),
      },
    } as unknown as LoadedSite;
    const out = await buildPages(broken, {
      only: [ABOUT],
      layoutFor: hierarchyLayout,
      convert: fakeConversion([{ tagName: "p", textContent: "x" }]),
    });
    expect(out.files).toHaveLength(1);
    expect(parse(out.files[0]!).state).toBeUndefined();
    expect(out.report.entries().find((e) => e.code === "page.entry-failed")).toMatchObject({
      severity: "warn",
      where: `post:${ABOUT}`,
    });
  });
});

// ── The corpus, held to what it must contain ─────────────────────────────────────────────────────

describe("what the corpora must contain", () => {
  test("skipped pages are listed in id order whatever order they were met in", () => {
    for (const name of ["fineline", "ap"] as const) {
      const { skipped } = of(name).out;
      expect(skipped.length, name).toBeGreaterThan(2);
      const ids = skipped.map((s) => s.id);
      expect(ids).toEqual(ids.toSorted((a, b) => a - b));
    }
    // Both ways a page is skipped are in the list: found while walking (shadowed) and counted after (unpublished).
    const codesSeen = new Set(of("fineline").out.skipped.map((s) => s.code));
    expect(codesSeen.has("page.unpublished")).toBe(true);
    expect(codesSeen.has("page.shadowed")).toBe(true);
  });

  test("no page's social image is left unresolved in either site", () => {
    for (const name of ["fineline", "ap"] as const) {
      expect(codes(of(name).out), name).not.toContain("page.og-image-unresolved");
    }
  });

  test("every written page carries its own post, and every state key is a conversion's or `entry`", () => {
    for (const name of ["fineline", "ap"] as const) {
      const { out } = of(name);
      for (const file of out.files) {
        const state = parse(file).state ?? {};
        expect(state[ENTRY_STATE_KEY], file.path).toBeDefined();
        for (const key of Object.keys(state)) {
          if (key !== ENTRY_STATE_KEY) expect(out.used.states.has(key), key).toBe(true);
        }
      }
    }
  });
});
