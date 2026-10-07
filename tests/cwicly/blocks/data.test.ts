/**
 * The data blocks (query, query-template, pagination, repeater, taxonomyterms, component instances,
 * innerblocks) against both fixture sites.
 *
 * Oracles, in the order they are trusted: the rendered live pages under `tests/fixtures/<site>/html`
 * (the items a query printed, the tags an essay printed, the categories of a footer), the plugin's own
 * PHP (the semantics of a tax query, a meta query, the variant classes), the model itself read
 * independently of the module under test (a post's terms from `termsByPost`), and the real Jx build
 * (`jx build` of a project made from the converted nodes and the entries of the model).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "parse5";
import { stringify } from "yaml";
import {
  allSubjects,
  loadSite,
  makeCtx,
  subjectBlocks,
  type LoadedSite,
  type SiteName,
  type Subject,
} from "../../helpers/ctx.ts";
import {
  buildJxProject,
  cleanupJxProjects,
  validateJxProject,
  type BuiltProject,
  type ProjectFile,
} from "../../helpers/jx-build.ts";
import {
  convertBlocks,
  convertSubject,
  registerConverters,
  withOverrides,
  type Converted,
} from "../../../src/convert.ts";
import { walkElements } from "../../../src/placeholders.ts";
import { createReport } from "../../../src/report.ts";
import { walkBlocks } from "../../../src/wp/blocks.ts";
import { decodeEntities, termsOf } from "../../../src/wp/model.ts";
import { postData } from "../../../src/cwicly/tokens.ts";
import { setUserProfiles } from "../../../src/wp/profiles.ts";
import type { ConvertCtx, JxElement, JxNode, WpBlock, WpPost, WpTerm } from "../../../src/types.ts";
import {
  collectedState,
  defineState,
  entryPosts,
  evaluatePosts,
  instanceProps,
  isPaginated,
  pagedByClick,
  planQuery,
  pointerOf,
  pointerOfExpr,
  srcOf,
  termRows,
  variantClasses,
  loopChildren,
  writtenOut,
  lengthOf,
  userList,
  usesInComputedLists,
  type ListSource,
  type PostPlan,
  type QueryPlan,
  type TermsPlan,
} from "../../../src/cwicly/blocks/data.ts";

setDefaultTimeout(180_000);
afterAll(cleanupJxProjects);

const FIXTURES = join(import.meta.dir, "../../fixtures");

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

/** A block as the serializer's parser would give it. */
function block(
  name: string,
  attrs: Record<string, unknown> = {},
  inner: WpBlock[] = [],
  html = "",
): WpBlock {
  return {
    name,
    attrs,
    innerBlocks: inner,
    innerHTML: html,
    innerContent: inner.length === 0 ? [html] : [html, ...inner.map(() => null)],
  };
}

/** `{source: "static", field}`: how the editor writes a value a person typed or picked. */
const st = (field: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: "static",
  type: "",
  group: "",
  field,
  ...extra,
});
const pick = (...values: (string | number)[]): Record<string, unknown> =>
  st(values.map((value) => ({ value, label: String(value) })));
const dyn = (group: string, field = "", type = "wordpress"): Record<string, unknown> => ({
  source: "dynamic",
  type,
  group,
  field,
});

/** One `queryTaxonomy` entry. */
function taxEntry(opts: {
  taxonomy: string | Record<string, unknown>;
  terms: Record<string, unknown>;
  field?: string;
  operator?: string;
  children?: boolean;
}): Record<string, unknown> {
  return {
    multiple: false,
    taxonomy: typeof opts.taxonomy === "string" ? st(opts.taxonomy) : opts.taxonomy,
    field: st(opts.field ?? ""),
    terms: opts.terms,
    include_children: opts.children ?? true,
    removeNoTerms: false,
    operator: st(opts.operator ?? ""),
    tax_query: [],
  };
}

/**
 * A `cwicly/query` block over the given attributes, with a query template of a heading inside. It is a
 * query of its own (`queryInherit: false`, as all but two of the real blocks say): block.json makes
 * inheriting the template's main query the default, and a test that wants it says `queryInherit: true`.
 */
const queryBlock = (attrs: Record<string, unknown>, inner: WpBlock[] = []): WpBlock =>
  block(
    "cwicly/query",
    {
      uniqueID: "q-uid",
      classID: "query-test",
      id: "query-test",
      queryId: 7,
      queryInherit: false,
      ...attrs,
    },
    inner,
    '<div id="query-test{idadd}" class="query-test" data-query_id="7"><ccdyn></ccdyn></div>',
  );

const titleHeading = (): WpBlock =>
  block(
    "cwicly/heading",
    {
      uniqueID: "h-uid",
      classID: "heading-test",
      headingTag: "h3",
      dynamic: "wordpress",
      dynamicWordPressType: "title",
    },
    [],
    '<h3 class="heading-test">{title}</h3>',
  );

const templateBlock = (inner: WpBlock[] = [titleHeading()]): WpBlock =>
  block(
    "cwicly/query-template",
    { uniqueID: "qt-uid", classID: "querytemplate-test", id: "querytemplate-test" },
    inner,
    '<div id="querytemplate-test{idadd}" class="querytemplate-test {gcl}" cc-query-template=""><ccdyn></ccdyn></div>',
  );

/** All blocks of a name in a tree. */
function blocksNamed(blocks: readonly WpBlock[], name: string): WpBlock[] {
  const out: WpBlock[] = [];
  walkBlocks(blocks, (b) => {
    if (b.name === name) out.push(b);
  });
  return out;
}

/** Every element of converted nodes matching a predicate, repeaters' templates included. */
function elementsWhere(nodes: readonly JxNode[], test: (e: JxElement) => boolean): JxElement[] {
  return [...walkElements(nodes)].filter(test);
}

const classes = (e: JxElement): string[] => (e.className ?? "").split(/\s+/).filter(Boolean);
const hasClass = (e: JxElement, name: string): boolean => classes(e).includes(name);

/** The pseudo-element a loop converts to. */
const isArray = (e: JxElement): boolean => e.$prototype === "Array";

interface LiveItem {
  href: string;
  text: string;
}

/** The items of every query in a live page: the `cc-query-item`s, each with its first link and its text. */
function liveItems(site: SiteName, file: string): LiveItem[] {
  const html = readFileSync(join(FIXTURES, site, "html", `${file}.html`), "utf8");
  const items: LiveItem[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (n: any): string =>
    n.nodeName === "#text" ? n.value : (n.childNodes ?? []).map(text).join("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const first = (n: any, tag: string): any => {
    if (n.nodeName === tag) return n;
    for (const c of n.childNodes ?? []) {
      const found = first(c, tag);
      if (found) return found;
    }
    return undefined;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any): void => {
    const cls = n.attrs?.find((a: { name: string }) => a.name === "class")?.value ?? "";
    if (/\bcc-query-item\b/.test(cls)) {
      const a = first(n, "a");
      items.push({
        href: a?.attrs.find((x: { name: string }) => x.name === "href")?.value ?? "",
        text: text(n).replaceAll(/\s+/g, " ").trim(),
      });
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(parse(html));
  return items;
}

const sitePath = (url: string, site: LoadedSite): string =>
  url.startsWith(site.model.site.url) ? url.slice(site.model.site.url.length) : url;

/** The ctx of a template converted as the driver converts it (an entry template reads page state). */
const templateCtx = (site: SiteName, slug: string): Promise<ConvertCtx> =>
  makeCtx(site, { kind: "template", slug }, { mode: "entry" });

/** The `cwicly/query` blocks of a subject, in document order. */
const queriesOf = (site: LoadedSite, subject: Subject): WpBlock[] =>
  blocksNamed(subjectBlocks(site, subject), "cwicly/query");

function planOf(
  b: WpBlock,
  ctx: ConvertCtx,
): { plan: QueryPlan; info: ReturnType<typeof planQuery>["info"] } {
  return planQuery(b, ctx);
}

function postPlan(b: WpBlock, ctx: ConvertCtx): PostPlan {
  const { plan } = planQuery(b, ctx);
  if (plan.kind !== "posts") throw new Error(`not a posts plan: ${plan.kind}`);
  return plan;
}

// ── A tiny Jx: what the build does with the state this module writes ─────────────────────────────

import { compileConditions, type EntryLike } from "../../../src/cwicly/blocks/data.ts";
import { postFacts } from "../../../src/cwicly/tokens.ts";

type StateMap = Record<string, unknown>;

const entryOf = (ctx: ConvertCtx, post: WpPost): EntryLike => ({
  id: ctx.urlFor("post", post.id) ?? String(post.id),
  data: postFacts(ctx, post),
});

/**
 * Resolve a state entry the way the static build does: a `ContentCollection` is the entries of its
 * type (filtered, sorted and cut by the parser's own `queryContentType` rules for `==` and `!=`), a
 * `Function` with `timing: "compiler"` runs its body with `state` holding every other entry. `extra`
 * is page state the converter does not write (`entry`, `term`).
 */
function resolveList(
  ctx: ConvertCtx,
  state: StateMap,
  key: string,
  extra: Record<string, unknown> = {},
): EntryLike[] {
  const cache = new Map<string, unknown>();
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_, name) => {
        const k = String(name);
        if (k in extra) return extra[k];
        if (cache.has(k)) return cache.get(k);
        const def = state[k] as Record<string, unknown> | undefined;
        if (def === undefined) throw new Error(`no state entry ${k}`);
        let value: unknown;
        if (def.$prototype === "ContentCollection") {
          let entries = entryPosts(ctx, String(def.contentType)).map((p) => entryOf(ctx, p));
          for (const rule of (def.filter as { field: string; op: string; value: unknown }[]) ??
            []) {
            entries = entries.filter((e) => {
              const actual = rule.field === "id" ? e.id : e.data[rule.field];
              return rule.op === "==" ? actual === rule.value : actual !== rule.value;
            });
          }
          for (const rule of [
            ...((def.sort as { field: string; order: string }[]) ?? []),
          ].reverse()) {
            // a stable sort applied from the last rule to the first is the multi-key sort
            entries = [...entries].sort((a, b) => {
              const x = (a.data[rule.field] ?? "") as string;
              const y = (b.data[rule.field] ?? "") as string;
              const c = x < y ? -1 : x > y ? 1 : 0;
              return rule.order === "asc" ? c : -c;
            });
          }
          if (typeof def.limit === "number") entries = entries.slice(0, def.limit);
          value = entries;
        } else if (def.$prototype === "Function") {
          value = new Function("state", String(def.body))(proxy);
        } else {
          value = def;
        }
        cache.set(k, value);
        return value;
      },
    },
  );
  return proxy[key] as EntryLike[];
}

/** A list source as the build reads it: a pointer into the state (a collection, rows, an entry's terms), or an expression evaluated with `state` in scope. */
function resolveSource(
  ctx: ConvertCtx,
  state: StateMap,
  source: ListSource,
  extra: Record<string, unknown> = {},
): EntryLike[] {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_, name) => {
        const k = String(name);
        if (k in extra) return extra[k];
        return resolveList(ctx, state, k, extra);
      },
    },
  );
  if ("expr" in source)
    return new Function("state", `return ${source.expr};`)(proxy) as EntryLike[];
  const [, , key, ...path] = source.pointer.split("/") as [string, string, string, ...string[]];
  let value: unknown = proxy[key];
  for (const segment of path) value = (value as Record<string, unknown>)[segment];
  return value as EntryLike[];
}

/** The list expression inside a computed `children` string `${(LIST).map(($i0, $x0) => (ITEM))}`. */
function inlineList(children: string): string {
  const end = children.lastIndexOf(").map(($i0, $x0) => (");
  return children.slice("${(".length, end);
}

/** Every element whose children are one computed string. */
const inlineLoops = (nodes: readonly JxNode[]): JxElement[] =>
  elementsWhere(
    nodes,
    (e) =>
      Array.isArray(e.children) &&
      e.children.length === 1 &&
      typeof e.children[0] === "string" &&
      e.children[0].startsWith("${("),
  );

/** The urls of a list, in order. */
const urlsOf = (list: readonly EntryLike[]): string[] => list.map((e) => String(e.data.url));
const urlsOfPosts = (ctx: ConvertCtx, posts: readonly WpPost[]): string[] =>
  posts.map((p) => ctx.urlFor("post", p.id) ?? "");

/** The oracle for tax tests: the model's own term relations, read without the module. */
function postsWith(
  ctx: ConvertCtx,
  type: string,
  taxonomy: string,
  slugs: string[],
  mode: "any" | "all" | "none" = "any",
): WpPost[] {
  return entryPosts(ctx, type)
    .filter((p) => {
      const mine = new Set(termsOf(ctx.model, p.id, taxonomy).map((t) => t.slug));
      if (mode === "all") return slugs.every((s) => mine.has(s));
      if (mode === "none") return !slugs.some((s) => mine.has(s));
      return slugs.some((s) => mine.has(s));
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * What the real plugin's `WP_Query` (WordPress 7.1 over the full databases, `orderby=title`,
 * `order=ASC`) put first, as the converted entries print their titles: fineline's projects, and
 * anabaptistperspectives' posts and episodes together (the entries the fixtures hold; the live
 * database has more, which are left out of the sequence).
 */
const REAL_ORDER_FINELINE = [
  "Barn Painting In Annville, PA",
  "Barn Painting in Lebanon, PA",
  "Barn Painting In Manheim, PA",
  "Barn Roof Painting Job In Lebanon, PA",
  "Bathroom Painting Project In Reinholds",
  "Board & Batten Staining in New Providence, PA",
  "Cabin Staining in Finksburg, PA",
  "Chicken House Painting In Watsontown, PA",
  "Commercial Painting Project in Morgantown, PA",
  "Drywall Repair And Painting In Lebanon, PA",
  "Exterior and Interior Painting In Fredericksburg, PA",
  "Exterior Barn Painting in York, PA",
];
const REAL_ORDER_AP = [
  '"End Those Muslims!" - A Response to Jerry Falwell Jr.',
  "\u201CBut You Will Just Die\u201D",
  "[short draft] The Forgotten Anabaptist Leader: Pilgram Marpeck - Episode 4",
  "28 Years as an Amish-Mennonite Pastor in Ireland",
  "40 Years Inside America\u2019s Military-Industrial Complex (I Had Above \u201CTop Secret\u201D Clearance)",
  "A COVID-19 Economy and Stewardship.",
];

// ── The lists the live pages printed ─────────────────────────────────────────────────────────────

describe("the lists the live pages printed", () => {
  test("fineline /residential/ (page 195): its six projects, in the live order, with the live titles", async () => {
    const site = await loadSite("fineline");
    const subject: Subject = { kind: "post", id: 195 };
    const ctx = await makeCtx("fineline", subject);
    const plan = postPlan(queriesOf(site, subject)[0]!, ctx);
    expect(plan.types).toEqual(["project"]);
    expect(plan.perPage).toBe(6);
    const posts = evaluatePosts(ctx, plan)!;
    const live = liveItems("fineline", "residential");
    expect(live).toHaveLength(6);
    expect(urlsOfPosts(ctx, posts)).toEqual(live.map((i) => sitePath(i.href, site)));
    expect(posts.map((p) => postData(ctx, p).title)).toEqual(live.map((i) => i.text));
  });

  test("fineline /choosing-the-best-log-home-stain/ (post 3371): the four posts that share its tag", async () => {
    const site = await loadSite("fineline");
    const subject: Subject = { kind: "post", id: 3371 };
    const ctx = await makeCtx("fineline", subject);
    const plan = postPlan(queriesOf(site, subject)[0]!, ctx);
    const posts = evaluatePosts(ctx, plan)!;
    const live = liveItems("fineline", "choosing-the-best-log-home-stain");
    expect(live).toHaveLength(4);
    expect(urlsOfPosts(ctx, posts)).toEqual(live.map((i) => sitePath(i.href, site)));
    expect(posts.map((p) => postData(ctx, p).title)).toEqual(live.map((i) => i.text));
  });

  test("fineline home (page 5246): six projects, newest first; the live page is a newer snapshot with three more", async () => {
    const site = await loadSite("fineline");
    const subject: Subject = { kind: "post", id: 5246 };
    const ctx = await makeCtx("fineline", subject);
    const plan = postPlan(queriesOf(site, subject)[0]!, ctx);
    const posts = evaluatePosts(ctx, plan)!;
    const live = liveItems("fineline", "home");
    expect(posts).toHaveLength(6);
    expect(live).toHaveLength(6);
    // The dump lacks the three newest projects the live page lists first (docs/design.md, field notes).
    expect(urlsOfPosts(ctx, posts).slice(0, 3)).toEqual(
      live.slice(3).map((i) => sitePath(i.href, site)),
    );
  });

  test("anabaptistperspectives /essays/ (the posts page, `index` template): the twenty latest, in the live order", async () => {
    const site = await loadSite("ap");
    const ctx = await templateCtx("ap", "index");
    const [q] = queriesOf(site, { kind: "template", slug: "index" });
    const plan = postPlan(q!, ctx);
    expect(plan.perPage).toBe(20);
    expect(plan.paginated).toBe(false);
    const posts = evaluatePosts(ctx, plan)!;
    const live = liveItems("ap", "essays").filter((i) => i.href.includes("/essays/"));
    expect(live).toHaveLength(20);
    expect(urlsOfPosts(ctx, posts)).toEqual(live.map((i) => sitePath(i.href, site)));
  });

  test("anabaptistperspectives footer: the eight categories a terms query printed, by name descending, with the first two ids left out", async () => {
    const site = await loadSite("ap");
    const ctx = await makeCtx("ap", { kind: "part", slug: "footer" });
    const [q] = queriesOf(site, { kind: "part", slug: "footer" });
    const { plan } = planOf(q!, ctx);
    expect(plan).toMatchObject({
      kind: "terms",
      taxonomies: ["category"],
      exclude: [1, 198],
      perPage: 8,
      order: "desc",
    });
    const rows = termRows(ctx, plan as TermsPlan);
    // The live page also lists the twenty essays above them: the last eight items are the categories.
    const live = liveItems("ap", "essays").slice(-8);
    expect(live).toHaveLength(8);
    expect(rows.map((r) => r.name)).toEqual(live.map((i) => i.text));
    expect(rows.map((r) => r.url)).toEqual(live.map((i) => sitePath(i.href, site)));
  });

  for (const slug of [
    "the-cultural-captivity-of-the-gospel",
    "the-way-we-live-is-the-way-we-educate",
    "keeshons-story-a-knock-heard-round-the-hood-part-3",
  ]) {
    test(`anabaptistperspectives essay ${slug}: the tags the live page printed are the entry's post_tag terms, by name`, async () => {
      const site = await loadSite("ap");
      const post = [...site.model.posts.values()].find(
        (p) => p.slug === slug && p.type === "post",
      )!;
      const ctx = await makeCtx("ap", { kind: "post", id: post.id });
      const html = readFileSync(join(FIXTURES, `ap/html/essays__${slug}.html`), "utf8");
      const block = /<div id="taxonomyterms-episodes"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/.exec(
        html,
      )![1]!;
      const live = [...block.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => ({
        href: m[1]!,
        text: decodeEntities(m[2]!),
      }));
      const terms = (postData(ctx, post).terms as Record<string, { name: string; url: string }[]>)
        .post_tag!;
      expect(live.length).toBeGreaterThan(0);
      expect(terms.map((t) => t.name)).toEqual(live.map((l) => l.text));
      expect(terms.map((t) => t.url)).toEqual(live.map((l) => sitePath(l.href, site)));
    });
  }
});

// ── A query's conditions, as the plugin reads them ───────────────────────────────────────────────

import { registerPostList } from "../../../src/cwicly/blocks/data.ts";

/** The same context with no state collector of its own, so what a converter registers is readable in `collectedState`. */
const bare = (ctx: ConvertCtx): ConvertCtx =>
  ({ ...ctx, report: createReport(), defineState: undefined }) as unknown as ConvertCtx;

describe("the plan of a posts query", () => {
  let ctx: ConvertCtx;
  let projects: WpPost[];
  const planOf2 = (attrs: Record<string, unknown>, c: ConvertCtx = ctx): PostPlan =>
    postPlan(queryBlock({ queryPostType: pick("project"), ...attrs }), c);
  const run = (attrs: Record<string, unknown>, c: ConvertCtx = ctx): WpPost[] =>
    evaluatePosts(c, planOf2({ queryPerPage: st("9999"), ...attrs }, c))!;
  const newestFirst = (posts: WpPost[]): WpPost[] =>
    [...posts].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  test("setup", async () => {
    ctx = await makeCtx("fineline", { kind: "post", id: 195 });
    projects = entryPosts(ctx, "project");
    expect(projects).toHaveLength(82);
  });

  test("the defaults are WP_Query's: post, the site's posts_per_page, newest first", () => {
    const plan = postPlan(queryBlock({}), ctx);
    expect(plan).toMatchObject({
      types: ["post"],
      perPage: Number(ctx.model.options.get("posts_per_page")),
      offset: 0,
      sort: [{ field: "date", order: "desc" }],
      conds: [],
      paginated: false,
      dropped: [],
    });
    const posts = evaluatePosts(ctx, plan)!;
    expect(urlsOfPosts(ctx, posts)).toEqual(
      urlsOfPosts(ctx, newestFirst(entryPosts(ctx, "post")).slice(0, 10)),
    );
  });

  test("only published, routed, unprotected posts are entries", () => {
    const all = [...ctx.model.posts.values()].filter((p) => p.type === "project");
    expect(all.length).toBeGreaterThan(projects.length); // drafts and privates are in the model
    expect(projects.every((p) => p.status === "publish" && !p.passwordProtected)).toBe(true);
    expect(new Set(run({}).map((p) => p.id))).toEqual(new Set(projects.map((p) => p.id)));
  });

  test("posts_per_page is an absint of a number, as the plugin passes it: -1 is 1, and 0, a word or nothing is the site's own", () => {
    const own = Number(ctx.model.options.get("posts_per_page"));
    expect(planOf2({ queryPerPage: st("3") }).perPage).toBe(3);
    expect(planOf2({ queryPerPage: st("-1") }).perPage).toBe(1);
    expect(planOf2({ queryPerPage: st("-4") }).perPage).toBe(4);
    expect(planOf2({ queryPerPage: st("0") }).perPage).toBe(own);
    expect(planOf2({ queryPerPage: st("abc") }).perPage).toBe(own);
    expect(planOf2({ queryPerPage: st("2.9") }).perPage).toBe(2);
    expect(planOf2({ queryPerPage: st("9999") }).perPage).toBe(9999);
    expect(run({ queryPerPage: st("3") })).toHaveLength(3);
    expect(evaluatePosts(ctx, planOf2({ queryPerPage: st("3") }))).toHaveLength(3);
  });

  test("an offset skips entries before the page size is taken", () => {
    const all = run({});
    const some = evaluatePosts(ctx, planOf2({ queryPerPage: st("4"), queryOffset: st("2") }))!;
    expect(urlsOfPosts(ctx, some)).toEqual(urlsOfPosts(ctx, all.slice(2, 6)));
  });

  test("order and orderby: date and modified, title and name by the entry's own fields; what an entry has no value for is date, and said", () => {
    const by = (orderby: string, order = "ASC"): PostPlan =>
      planOf2({ queryOrderBy: st(orderby), queryOrder: st(order) });
    expect(by("date", "DESC").sort).toEqual([{ field: "date", order: "desc" }]);
    expect(by("modified").sort).toEqual([{ field: "modified", order: "asc" }]);
    expect(by("title").sort).toEqual([{ field: "title", order: "asc" }]);
    expect(by("name", "DESC").sort).toEqual([{ field: "slug", order: "desc" }]);
    for (const unread of ["rand", "menu_order", "ID", "comment_count"]) {
      const plan = by(unread);
      expect(plan.sort).toEqual([{ field: "date", order: "asc" }]);
      expect(plan.dropped.some((d) => d.includes(unread))).toBe(true);
    }
    // relevance only means something with a search, and the page has none: no complaint
    expect(by("relevance").dropped).toEqual([]);
    // The titles in the order the real plugin's query gave them on WordPress (MySQL's case-insensitive collation): `In` and `in` are the same letter, so `Lebanon` sorts before `Manheim`
    const sorted = run({ queryOrderBy: st("title"), queryOrder: st("ASC") });
    const titles = sorted.map((p) => postData(ctx, p).title as string);
    expect(titles.slice(0, 12)).toEqual(REAL_ORDER_FINELINE.slice(0, 12));
    // descending is the same collation backwards (equal titles keep no order of their own in MySQL, so the titles are compared)
    expect(
      run({ queryOrderBy: st("title"), queryOrder: st("DESC") }).map((p) => postData(ctx, p).title),
    ).toEqual([...titles].reverse());
  });

  test("meta_value and meta_value_num order by the ACF field's key", () => {
    const plan = planOf2({
      queryOrderBy: st("meta_value_num"),
      queryMetaKey: st("gallery"),
      queryOrder: st("DESC"),
    });
    expect(plan.sort).toEqual([{ field: "gallery", order: "desc" }]);
    const none = planOf2({ queryOrderBy: st("meta_value") });
    expect(none.sort).toEqual([{ field: "date", order: "desc" }]);
    expect(none.dropped.join(" ")).toContain("meta key");
  });

  test("the post types: a list, or the current post's type for a dynamic one; a type with no entries is left out and said", async () => {
    expect(postPlan(queryBlock({ queryPostType: pick("project", "service") }), ctx).types).toEqual([
      "project",
      "service",
    ]);
    const { plan, info } = planOf(
      queryBlock({ queryPostType: pick("project", "no_such_type") }),
      ctx,
    );
    expect((plan as PostPlan).types).toEqual(["project"]);
    expect(info).toMatchObject([{ code: "query.type-unrouted", detail: "no_such_type" }]);
    // The dynamic source `posttype` is the type of the entry being rendered.
    const entry = await makeCtx("fineline", { kind: "post", id: projects[0]!.id });
    const dynamic = postPlan(queryBlock({ queryPostType: dyn("posttype") }), entry);
    expect(dynamic.types).toEqual(["project"]);
  });

  test("a pagination device decides whether a page size is a limit or a page", () => {
    const device = (inner: WpBlock[], attrs: Record<string, unknown> = {}): WpBlock =>
      queryBlock(attrs, inner);
    expect(isPaginated(device([]))).toBe(false);
    expect(isPaginated(device([], { infiniteLoad: true }))).toBe(true);
    expect(isPaginated(device([templateBlock([titleHeading()])]))).toBe(false);
    expect(isPaginated(device([block("cwicly/query-pagination")]))).toBe(true);
    expect(
      isPaginated(
        device([
          templateBlock([block("cwicly/div", {}, [block("cwicly/query-pagination-numbers")])]),
        ]),
      ),
    ).toBe(true);
    for (const action of ["prevQuery", "nextQuery", "infiniteButtonLoad"]) {
      expect(
        isPaginated(
          device([block("cwicly/button", { linkWrapperActive: true, linkWrapperAction: action })]),
        ),
      ).toBe(true);
    }
    expect(isPaginated(device([block("cwicly/button", { linkWrapperAction: "lightbox" })]))).toBe(
      false,
    );
    // and it shows all the entries
    const paged = postPlan(
      queryBlock({ queryPostType: pick("project"), queryPerPage: st("5"), infiniteLoad: true }),
      ctx,
    );
    expect(paged).toMatchObject({ perPage: 5, paginated: true });
    expect(evaluatePosts(ctx, paged)).toHaveLength(82);
    expect(evaluatePosts(ctx, { ...paged, paginated: false })).toHaveLength(5);
  });

  describe("tax_query", () => {
    const tax = (entry: Record<string, unknown>, attrs: Record<string, unknown> = {}): WpPost[] =>
      run({ queryTaxonomy: [entry], ...attrs });
    const ids = (posts: WpPost[]): number[] => posts.map((p) => p.id);

    test("IN, with the operator empty, is any of the terms (a term named by id)", () => {
      const got = tax(taxEntry({ taxonomy: "project_type", terms: pick(56, 60) }));
      const want = postsWith(ctx, "project", "project_type", [
        "interior-painting",
        "exterior-painting",
      ]);
      expect(want.length).toBeGreaterThan(0);
      expect(ids(got)).toEqual(ids(want));
    });

    test("AND is all of them, NOT IN none of them", () => {
      // two project types that one project carries both of
      const pair = projects.find((p) => termsOf(ctx.model, p.id, "project_type").length >= 2)!;
      const [a, b] = termsOf(ctx.model, pair.id, "project_type") as [WpTerm, WpTerm];
      const both = tax(
        taxEntry({ taxonomy: "project_type", terms: pick(a.termId, b.termId), operator: "AND" }),
      );
      expect(ids(both)).toEqual(
        ids(postsWith(ctx, "project", "project_type", [a.slug, b.slug], "all")),
      );
      expect(both.length).toBeGreaterThan(0);
      const either = tax(taxEntry({ taxonomy: "project_type", terms: pick(a.termId, b.termId) }));
      expect(both.length).toBeLessThan(either.length);
      const neither = tax(
        taxEntry({ taxonomy: "project_type", terms: pick(a.termId, b.termId), operator: "NOT IN" }),
      );
      expect(ids(neither)).toEqual(
        ids(postsWith(ctx, "project", "project_type", [a.slug, b.slug], "none")),
      );
      expect(neither.length + either.length).toBe(82);
    });

    test("EXISTS and NOT EXISTS ask about the taxonomy, not a term", () => {
      // the plugin gives a clause with no terms the operator XXX, which WordPress does not apply: it is the
      // clause WordPress applies once a term is named (and ignores the terms), that asks about the taxonomy
      const some = tax(
        taxEntry({ taxonomy: "project_type", terms: pick(124), operator: "EXISTS" }),
      );
      const none = tax(
        taxEntry({ taxonomy: "project_type", terms: pick(124), operator: "NOT EXISTS" }),
      );
      expect(some).toHaveLength(76);
      expect(none).toHaveLength(6);
      expect(ids(none).sort()).toEqual(
        projects
          .filter((p) => termsOf(ctx.model, p.id, "project_type").length === 0)
          .map((p) => p.id)
          .sort(),
      );
    });

    test("child terms are in by default and out when the clause says so", () => {
      const withKids = tax(taxEntry({ taxonomy: "location", terms: pick(50) }));
      const children = [...ctx.model.terms.values()].filter(
        (t) => t.taxonomy === "location" && t.parent === 50,
      );
      expect(children.length).toBeGreaterThan(10);
      expect(ids(withKids)).toEqual(
        ids(
          postsWith(ctx, "project", "location", ["pennsylvania", ...children.map((t) => t.slug)]),
        ),
      );
      const alone = tax(taxEntry({ taxonomy: "location", terms: pick(50), children: false }));
      expect(ids(alone)).toEqual(ids(postsWith(ctx, "project", "location", ["pennsylvania"])));
      expect(alone.length).toBeLessThan(withKids.length);
    });

    test("the field says how a term is named: id, slug, name, or the taxonomy id of the term", () => {
      const want = ids(postsWith(ctx, "project", "project_type", ["staining"]));
      expect(want).toHaveLength(23);
      expect(
        ids(tax(taxEntry({ taxonomy: "project_type", terms: pick(124), field: "term_id" }))),
      ).toEqual(want);
      expect(
        ids(tax(taxEntry({ taxonomy: "project_type", terms: pick("staining"), field: "slug" }))),
      ).toEqual(want);
      expect(
        ids(
          tax(
            taxEntry({
              taxonomy: "project_type",
              terms: pick("Log Cabin Staining"),
              field: "name",
            }),
          ),
        ),
      ).toEqual(want);
      // The export's term ids and taxonomy ids coincide, so make one differ: only `term_taxonomy_id` finds it.
      const terms = new Map(ctx.model.terms);
      terms.set(124, { ...terms.get(124)!, taxonomyId: 90_124 });
      const patched = { ...ctx, model: { ...ctx.model, terms } } as ConvertCtx;
      expect(
        ids(
          run(
            {
              queryTaxonomy: [
                taxEntry({
                  taxonomy: "project_type",
                  terms: pick(90_124),
                  field: "term_taxonomy_id",
                }),
              ],
            },
            patched,
          ),
        ),
      ).toEqual(want);
      expect(
        run(
          {
            queryTaxonomy: [
              taxEntry({ taxonomy: "project_type", terms: pick(90_124), field: "term_id" }),
            ],
          },
          patched,
        ),
      ).toEqual([]);
    });

    test("term_taxonomy_id is the term's own taxonomy, whatever the clause says (the editor leaves the wrong one behind)", () => {
      // fineline's pages name project_type and the id of a project_tag term: the plugin finds the tag's posts
      const got = tax(
        taxEntry({ taxonomy: "project_type", terms: pick(33), field: "term_taxonomy_id" }),
      );
      expect(ids(got)).toEqual(
        ids(postsWith(ctx, "project", "project_tag", ["residential-projects"])),
      );
      expect(got).toHaveLength(8);
    });

    test("by id, the term has to be in the clause's taxonomy: a tag's id under project_type matches nothing, and is said", () => {
      const { plan, info } = planOf(
        queryBlock({
          queryPostType: pick("project"),
          queryTaxonomy: [taxEntry({ taxonomy: "project_type", terms: pick(33) })],
        }),
        ctx,
      );
      expect(evaluatePosts(ctx, plan as PostPlan)).toEqual([]);
      expect(info.map((i) => i.code)).toEqual(["query.term-missing"]);
    });

    test("a term the export does not have matches nothing for IN, and everything for NOT IN", () => {
      const missing = pick(987_654);
      expect(tax(taxEntry({ taxonomy: "project_type", terms: missing }))).toEqual([]);
      expect(
        tax(taxEntry({ taxonomy: "project_type", terms: missing, operator: "NOT IN" })),
      ).toHaveLength(82);
    });

    test("no terms chosen is no clause (the plugin marks it XXX), and a URL parameter with no value is the same, said once", () => {
      expect(
        postPlan(
          queryBlock({
            queryPostType: pick("project"),
            queryTaxonomy: [taxEntry({ taxonomy: "project_type", terms: pick() })],
          }),
          ctx,
        ).conds,
      ).toEqual([]);
      const { plan, info } = planOf(
        queryBlock({
          queryPostType: pick("project"),
          queryTaxonomy: [
            taxEntry({
              taxonomy: "location",
              field: "slug",
              terms: dyn("urlparameter", "location"),
            }),
            taxEntry({
              taxonomy: "project_type",
              field: "slug",
              terms: dyn("urlparameter", "type"),
            }),
          ],
        }),
        ctx,
      );
      expect((plan as PostPlan).conds).toEqual([]);
      expect(info.map((i) => i.code)).toEqual(["query.url-parameter", "query.url-parameter"]);
      expect(info.map((i) => i.detail)).toEqual(["location", "type"]);
    });

    test("several clauses are ANDed unless the block says OR; a group has a relation of its own", () => {
      const a = taxEntry({ taxonomy: "project_type", terms: pick(124) }); // staining
      const b = taxEntry({ taxonomy: "location", terms: pick(79) }); // lancaster
      const wantStaining = postsWith(ctx, "project", "project_type", ["staining"]);
      const lancaster = new Set(
        ids(postsWith(ctx, "project", "location", ["lancaster-county-pa"])),
      );
      const and = tax(a, { queryTaxonomy: [a, b] });
      expect(ids(and)).toEqual(ids(wantStaining.filter((p) => lancaster.has(p.id))));
      expect(and.length).toBeGreaterThan(0);
      const or = tax(a, { queryTaxonomy: [a, b], queryTaxonomyRelation: "OR" });
      expect(new Set(ids(or))).toEqual(new Set([...ids(wantStaining), ...lancaster]));
      const group = { multiple: true, relation: "OR", tax_query: [a, b] };
      expect(new Set(ids(tax(group as never)))).toEqual(new Set(ids(or)));
    });

    test("an archive term needs an archive: with one the clause reads `state.term`, without one it is left out and said", async () => {
      const archive = await templateCtx("fineline", "taxonomy-location");
      const [q] = queriesOf(await loadSite("fineline"), {
        kind: "template",
        slug: "taxonomy-location",
      });
      const plan = postPlan(q!, archive);
      expect(plan.conds).toHaveLength(1);
      expect(plan.conds[0]).toMatchObject({ dynamic: true });
      expect(plan.conds[0]!.js).toContain("state.term.data.slug");
      expect(evaluatePosts(archive, plan)).toBeUndefined(); // page state: nothing to evaluate now
      const noArchive = postPlan(
        queryBlock({
          queryPostType: pick("project"),
          queryTaxonomy: [
            taxEntry({ taxonomy: "location", terms: dyn("currenttaxonomytermarchive") }),
          ],
        }),
        ctx,
      );
      expect(noArchive.conds).toEqual([]);
      expect(noArchive.dropped.join(" ")).toContain("archive");
    });

    test("the archive's term includes its children, from a map written into the condition", async () => {
      const archive = await templateCtx("fineline", "taxonomy-location");
      const plan = postPlan(
        queryBlock({
          queryPostType: pick("project"),
          queryTaxonomy: [
            taxEntry({
              taxonomy: "location",
              field: "term_id",
              terms: dyn("currenttaxonomytermarchive"),
            }),
          ],
        }),
        archive,
      );
      const fn = compileConditions(plan.conds);
      void fn;
      const state = { term: { data: { slug: "pennsylvania", taxonomy: "location" } } };
      const keep = new Function(
        "e",
        "state",
        `const has = (e, t, s) => (e.data.terms?.[t] ?? []).some((x) => s.includes(x.slug)); return ${plan.conds[0]!.js};`,
      );
      const lebanon = projects.find((p) =>
        termsOf(ctx.model, p.id, "location").some((t) => t.slug === "lebanon-county-pa"),
      )!;
      expect(keep(entryOf(ctx, lebanon), state)).toBe(true); // a child of Pennsylvania
      const none = projects.find((p) => termsOf(ctx.model, p.id, "location").length === 0)!;
      expect(keep(entryOf(ctx, none), state)).toBe(false);
      // with no term (a page that is not an archive) nothing is filtered
      expect(keep(entryOf(ctx, none), { term: { data: {} } })).toBe(true);
    });
  });
});

describe("the plan of a posts query: the current entry, exclusions, meta, search", () => {
  let fl: LoadedSite;
  let ctx: ConvertCtx;
  let exterior: WpPost;
  let noType: WpPost;
  const run = (attrs: Record<string, unknown>, c: ConvertCtx = ctx): WpPost[] =>
    evaluatePosts(
      c,
      postPlan(
        queryBlock({ queryPostType: pick("project"), queryPerPage: st("9999"), ...attrs }),
        c,
      ),
    )!;
  const firstTerm = (
    field: string,
    taxonomy: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => taxEntry({ taxonomy, terms: dyn("shortcode", field), ...extra });

  test("setup", async () => {
    fl = await loadSite("fineline");
    ctx = await makeCtx("fineline", { kind: "post", id: 195 });
    const bySlug = (slug: string): WpPost =>
      entryPosts(ctx, "project").find((p) => p.slug === slug)!;
    exterior = bySlug("exterior-fence-paint-project-in-lebanon");
    noType = bySlug("log-home-staining-in-bethel-pa");
    expect(termsOf(fl.model, exterior.id, "project_type").map((t) => t.slug)).toEqual([
      "exterior-painting",
    ]);
    expect(termsOf(fl.model, noType.id, "project_type")).toEqual([]);
  });

  test("`[project_type_id]` on a static page is the page's own first term, written into the condition", async () => {
    const page = await makeCtx("fineline", { kind: "post", id: exterior.id });
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryPerPage: st("9999"),
        queryTaxonomy: [firstTerm("project_type_id", "project_type")],
      }),
      page,
    );
    expect(plan.conds[0]).toMatchObject({ dynamic: false });
    expect(plan.conds[0]!.js).toContain("'exterior-painting'");
    expect(urlsOfPosts(page, evaluatePosts(page, plan)!)).toEqual(
      urlsOfPosts(page, postsWith(page, "project", "project_type", ["exterior-painting"])),
    );
  });

  test("`[project_type_id]` on a page of an entry with no such term is no clause, as the plugin's empty terms are", async () => {
    const page = await makeCtx("fineline", { kind: "post", id: noType.id });
    const got = run({ queryTaxonomy: [firstTerm("project_type_id", "project_type")] }, page);
    expect(got).toHaveLength(82);
  });

  test("`[<taxonomy>_id]` names a taxonomy the site has; any other shortcode is left out and said", () => {
    const unknown = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryTaxonomy: [firstTerm("no_such_id", "project_type")],
      }),
      ctx,
    );
    expect(unknown.conds).toEqual([]);
    expect(unknown.dropped.join(" ")).toContain("shortcode");
    const archiveOnly = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryTaxonomy: [firstTerm("object_id", "project_type")],
      }),
      ctx,
    );
    expect(archiveOnly.conds).toEqual([]);
    expect(archiveOnly.dropped.join(" ")).toContain("archive");
  });

  test("in an entry template `[project_type_id]` is read from `state.entry` when the list is built, and the build agrees with the model", async () => {
    const entryCtx = await makeCtx(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry" },
    );
    const c = bare(entryCtx);
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryPerPage: st("4"),
        queryExcludeCurrent: true,
        queryTaxonomy: [firstTerm("project_type_id", "project_type")],
      }),
      c,
    );
    expect(plan.conds.map((x) => x.dynamic)).toEqual([true, true]);
    expect(evaluatePosts(c, plan)).toBeUndefined();
    const source = registerPostList(c, plan, "single");
    const state = Object.fromEntries(collectedState(c));
    expect("expr" in source).toBe(true);
    const { expr } = source as { expr: string };
    // a collection filter cannot say it, so it is an expression over the unfiltered collection of the type
    expect(Object.keys(state)).toEqual(["project_entries"]);
    expect(expr).toContain("state.entry.data.terms?.['project_type']?.[0]?.slug");
    expect(expr).toContain("e.data.url !== state.entry.data.url");
    expect(expr).not.toContain("${");
    // the same list the model gives: this type, this project's first type, not itself, four, newest first
    const related = resolveSource(c, state, source, { entry: entryOf(c, exterior) });
    const want = postsWith(c, "project", "project_type", ["exterior-painting"])
      .filter((p) => p.id !== exterior.id)
      .slice(0, 4);
    expect(urlsOf(related)).toEqual(urlsOfPosts(c, want));
    expect(related).toHaveLength(4);
    // an entry with no type has no clause: the newest four of the others
    const others = resolveSource(c, state, source, { entry: entryOf(c, noType) });
    expect(urlsOf(others)).toEqual(
      urlsOfPosts(
        c,
        postsWith(c, "project", "project_type", [], "none")
          .filter((p) => p.id !== noType.id)
          .slice(0, 4),
      ),
    );
  });

  test("queryExclude names posts by id; their pages are the `url` the entries carry, so the collection can say it itself", () => {
    const services = entryPosts(ctx, "service");
    expect(services.map((s) => s.id)).toContain(5282);
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("service"),
        queryPerPage: st("25"),
        queryExclude: pick(5282, 5280, 999_999),
      }),
      ctx,
    );
    // an id that is not an entry cannot be in the list, so there is nothing to leave out
    expect(plan.conds.map((c) => c.native)).toEqual([
      { field: "url", op: "!=", value: ctx.urlFor("post", 5282)! },
      { field: "url", op: "!=", value: ctx.urlFor("post", 5280)! },
    ]);
    const got = evaluatePosts(ctx, plan)!;
    expect(got.map((p) => p.id)).not.toContain(5282);
    expect(got.map((p) => p.id)).not.toContain(5280);
    expect(got).toHaveLength(services.length - 2);
  });

  test("queryInclude is post__in: only those entries", () => {
    const plan = postPlan(
      queryBlock({ queryPostType: pick("service"), queryInclude: pick(5282, 5280) }),
      ctx,
    );
    expect(new Set(evaluatePosts(ctx, plan)!.map((p) => p.id))).toEqual(new Set([5282, 5280]));
    expect(plan.conds[0]!.native).toBeUndefined(); // an `or` is not a collection rule
    expect(postPlan(queryBlock({ queryInclude: dyn("postid") }), ctx).dropped.join(" ")).toContain(
      "posts read from",
    );
  });

  test("queryExcludeCurrent on a static page is the entry's own url, a rule the collection can say; with no current post it is left out and said", async () => {
    const page = await makeCtx("fineline", { kind: "post", id: exterior.id });
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryPerPage: st("9999"),
        queryExcludeCurrent: true,
      }),
      page,
    );
    expect(plan.conds).toMatchObject([
      {
        native: { field: "url", op: "!=", value: page.urlFor("post", exterior.id) },
        dynamic: false,
      },
    ]);
    expect(evaluatePosts(page, plan)!.map((p) => p.id)).not.toContain(exterior.id);
    const part = await makeCtx("fineline", { kind: "part", slug: "footer" });
    const none = postPlan(
      queryBlock({ queryPostType: pick("project"), queryExcludeCurrent: true }),
      part,
    );
    expect(none.conds).toEqual([]);
    expect(none.dropped.join(" ")).toContain("current post");
  });

  describe("meta_query, over anabaptistperspectives' episodes", () => {
    let ap: ConvertCtx;
    let episodes: WpPost[];
    const meta = (
      key: string,
      compare: string,
      value: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      multiple: false,
      key: st(key),
      value: st(value, extra.formatType === undefined ? {} : { formatType: extra.formatType }),
      compare: st(compare),
      type: st((extra.type as string | undefined) ?? ""),
      relation: "AND",
      meta_query: [],
    });
    const plan = (queryMeta: unknown[], attrs: Record<string, unknown> = {}): PostPlan =>
      postPlan(
        queryBlock({
          queryPostType: pick("episode"),
          queryPerPage: st("9999"),
          queryMeta,
          ...attrs,
        }),
        ap,
      );
    /** A condition's truth over entries made by hand: the semantics, apart from the data. */
    const truth = (
      queryMeta: unknown[],
      data: Record<string, unknown>,
      attrs: Record<string, unknown> = {},
    ): boolean => compileConditions(plan(queryMeta, attrs).conds)({ id: "x", data });

    test("setup", async () => {
      ap = await makeCtx("ap", { kind: "post", id: 819 });
      episodes = entryPosts(ap, "episode");
      expect(episodes).toHaveLength(98);
    });

    test("`premium != true` and `id REGEXP ^\\d`: the episodes the Episodes page lists, by the stored values", () => {
      const queryMeta = [
        meta("premium", "!=", "true", { formatType: "boolean", type: "BINARY" }),
        meta("id", "REGEXP", "^\\d", { formatType: "string", type: "CHAR" }),
      ];
      const got = evaluatePosts(ap, plan(queryMeta))!;
      const stored = (p: WpPost, key: string): string | undefined =>
        (ap.model.postMeta.get(p.id)?.[key]?.[0] as string | undefined) ?? undefined;
      const want = episodes.filter((p) => {
        const premium = stored(p, "premium");
        return premium !== undefined && premium !== "1" && /^\d/.test(stored(p, "id") ?? "");
      });
      expect(got.length).toBeGreaterThan(50);
      expect(got.length).toBeLessThan(episodes.length);
      expect(new Set(got.map((p) => p.id))).toEqual(new Set(want.map((p) => p.id)));
    });

    test("every comparison, with MySQL's reading of a value that is not there", () => {
      const on = { premium: true };
      const off = { premium: false };
      const gone = {};
      const t = (
        compare: string,
        value: string,
        data: Record<string, unknown>,
        extra: Record<string, unknown> = {},
      ): boolean => truth([meta("premium", compare, value, extra)], data);
      const bool = { formatType: "boolean" };
      expect([on, off, gone].map((d) => t("=", "true", d, bool))).toEqual([true, false, false]);
      expect([on, off, gone].map((d) => t("!=", "true", d, bool))).toEqual([false, true, false]);
      expect([on, off, gone].map((d) => t("EXISTS", "", d))).toEqual([true, true, false]);
      expect([on, off, gone].map((d) => t("NOT EXISTS", "", d))).toEqual([false, false, true]);
      expect([on, off, gone].map((d) => t("IN", "1,2", d))).toEqual([true, false, false]);
      expect([on, off, gone].map((d) => t("NOT IN", "1,2", d))).toEqual([false, true, false]);
      expect(
        [{ premium: "alpha" }, { premium: "beta" }, gone].map((d) => t("LIKE", "lph", d)),
      ).toEqual([true, false, false]);
      expect(
        [{ premium: "alpha" }, { premium: "beta" }, gone].map((d) => t("NOT LIKE", "lph", d)),
      ).toEqual([false, true, false]);
      expect(
        [{ premium: "alpha" }, { premium: "beta" }, gone].map((d) => t("REGEXP", "^a", d)),
      ).toEqual([true, false, false]);
      expect(
        [{ premium: "alpha" }, { premium: "beta" }, gone].map((d) => t("NOT REGEXP", "^a", d)),
      ).toEqual([false, true, false]);
      // strings compare as strings and NUMERIC as numbers: "10" > "5" is false the first way and true the second
      expect(t(">", "5", { premium: "10" })).toBe(false);
      expect(t(">", "5", { premium: "10" }, { type: "NUMERIC" })).toBe(true);
      expect(t("<=", "5", { premium: "5" }, { type: "NUMERIC" })).toBe(true);
      expect(t(">=", "6", { premium: "5" }, { type: "NUMERIC" })).toBe(false);
    });

    test("the relation between clauses is AND unless the block says OR, as the premium page's `!=` or NOT EXISTS needs", () => {
      const queryMeta = [
        meta("premium", "!=", "true", { formatType: "boolean" }),
        meta("premium", "NOT EXISTS", "true", { formatType: "boolean" }),
      ];
      const and = (data: Record<string, unknown>): boolean => truth(queryMeta, data);
      const or = (data: Record<string, unknown>): boolean =>
        truth(queryMeta, data, { queryMetaRelation: "OR" });
      expect([{ premium: true }, { premium: false }, {}].map(and)).toEqual([false, false, false]);
      expect([{ premium: true }, { premium: false }, {}].map(or)).toEqual([false, true, true]);
    });

    test("a comparison this tool has no reading for is left out, and said", () => {
      const p = plan([meta("premium", "BETWEEN", "1")]);
      expect(p.conds).toEqual([]);
      expect(p.dropped.join(" ")).toContain("BETWEEN");
    });
  });

  test("a static search is the entry's title and excerpt, and said; a URL parameter is no filter, and said", () => {
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryPerPage: st("9999"),
        querySearch: st("Barn"),
      }),
      ctx,
    );
    expect(plan.dropped.join(" ")).toContain("search");
    const got = evaluatePosts(ctx, plan)!;
    expect(got.length).toBeGreaterThan(0);
    expect(
      got.every((p) => /barn/i.test(`${postData(ctx, p).title} ${postData(ctx, p).excerpt}`)),
    ).toBe(true);
    const { plan: urlPlan, info } = planOf(
      queryBlock({ queryPostType: pick("project"), querySearch: dyn("urlparameter", "s") }),
      ctx,
    );
    expect((urlPlan as PostPlan).conds).toEqual([]);
    expect(info).toMatchObject([{ code: "query.url-parameter", detail: "s" }]);
  });

  test("an attribute nobody reads that holds a value is a condition left out; one that holds nothing, or that is read, is not", () => {
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryAuthor: st([]), // empty
        queryDate: [{ multiple: false }], // a date query: not read
        queryPostParent: st("12"),
        queryCommentCount: st("3"),
        queryHideEmpty: false,
        queryPostStatus: pick("publish"), // read (only published posts are entries)
      }),
      ctx,
    );
    expect(plan.dropped.sort()).toEqual(["queryCommentCount", "queryDate", "queryPostParent"]);
  });

  test("queryInherit is the template's own main query: its post type, and the archive's term", async () => {
    const archive = await templateCtx("fineline", "taxonomy-location");
    const plan = postPlan(queryBlock({ queryInherit: true }), {
      ...archive,
      entryType: "project",
    } as ConvertCtx);
    expect(plan.types).toEqual(["project"]);
    expect(plan.conds).toHaveLength(1);
    expect(plan.conds[0]!.js).toContain("state.term.data.slug");
  });

  test("queries that are not lists of entries are unsupported, with the reason", () => {
    for (const [queryType, what] of [
      ["comments", "comments"],
      ["products", "products"],
    ] as const) {
      const { plan } = planOf(queryBlock({ queryType }), ctx);
      expect(plan).toMatchObject({ kind: "unsupported", what });
    }
    expect(planOf(queryBlock({ queryType: "galaxies" }), ctx).plan).toMatchObject({
      kind: "unsupported",
      what: "galaxies",
    });
  });

  test("srcOf reads a value however the editor wrote it", () => {
    expect(srcOf(undefined)).toEqual({ kind: "none" });
    expect(srcOf("")).toEqual({ kind: "none" });
    expect(srcOf(st(""))).toEqual({ kind: "none" });
    expect(srcOf(st([]))).toEqual({ kind: "none" });
    expect(srcOf(st("6"))).toEqual({ kind: "static", values: ["6"] });
    expect(srcOf(st(6))).toEqual({ kind: "static", values: ["6"] });
    expect(srcOf(pick("a", 2))).toEqual({ kind: "static", values: ["a", "2"] });
    expect(srcOf(true)).toEqual({ kind: "static", values: [], flag: true });
    expect(srcOf(st(false))).toEqual({ kind: "static", values: [], flag: false });
    expect(srcOf(st("!ref=abc!"))).toEqual({ kind: "ref" });
    expect(srcOf(dyn("shortcode", "x"))).toEqual({
      kind: "dynamic",
      type: "wordpress",
      group: "shortcode",
      field: "x",
      fallback: undefined,
    });
  });
});

// ── State ────────────────────────────────────────────────────────────────────────────────────────

describe("the state a query registers", () => {
  test("a native list is one ContentCollection (fineline home: the six newest projects)", async () => {
    const out = await convertSubject(await loadSite("fineline"), { kind: "post", id: 5246 });
    expect(out.state).toEqual({
      project_q254: {
        $prototype: "ContentCollection",
        $src: "@jxsuite/parser/ContentCollection.class.json",
        contentType: "project",
        sort: [{ field: "date", order: "desc" }],
        limit: 6,
        timing: "compiler",
      },
    });
    expect(out.used.states.has("project_q254")).toBe(true);
  });

  test("exclusions alone are collection rules (`url !=`), the filter the collection can say itself", async () => {
    const ctx = bare(await makeCtx("fineline", { kind: "post", id: 195 }));
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("service"),
        queryPerPage: st("25"),
        queryExclude: pick(5282, 5307),
      }),
      ctx,
    );
    const source = registerPostList(ctx, plan, "9");
    expect(source).toEqual({ pointer: "#/state/service_q9" });
    expect(collectedState(ctx).get("service_q9")).toEqual({
      $prototype: "ContentCollection",
      $src: "@jxsuite/parser/ContentCollection.class.json",
      contentType: "service",
      filter: [
        { field: "url", op: "!=", value: "/service/interior-painting/" },
        { field: "url", op: "!=", value: "/service/municipal-painting/" },
      ],
      sort: [{ field: "date", order: "desc" }],
      limit: 25,
      timing: "compiler",
    });
    // and the collection rules do what the model says
    const list = resolveSource(ctx, Object.fromEntries(collectedState(ctx)), source);
    expect(urlsOf(list)).toEqual(urlsOfPosts(ctx, evaluatePosts(ctx, plan)!));
  });

  test("a taxonomy clause is computed children over unfiltered collections, one per post type, shared by every list of the page", async () => {
    const out = await convertSubject(await loadSite("fineline"), {
      kind: "template",
      slug: "archive-service",
    });
    // three lists of services, one source, and no Function state entry (jx validate refuses `timing` on one)
    expect(out.state).toEqual({
      service_entries: {
        $prototype: "ContentCollection",
        $src: "@jxsuite/parser/ContentCollection.class.json",
        contentType: "service",
        timing: "compiler",
      },
    });
    expect(JSON.stringify(out.state)).not.toContain("Function");
    const loops = inlineLoops(out.nodes);
    expect(loops).toHaveLength(3);
    const lists = loops.map((e) => inlineList((e.children as string[])[0]!));
    for (const list of lists) {
      expect(list).toContain("[...state.service_entries]");
      expect(list).toContain(".sort((a, b) => by('date', -1)(a, b))");
      expect(list).toContain(".slice(0, 25)");
      expect(list).not.toContain("${");
    }
    // each list is its own taxonomy clause, the exclusions written into it
    expect(lists[0]).toContain("has(e, 'service-type', ['interior'])");
    expect(lists[1]).toContain("has(e, 'service-type', ['exterior'])");
    expect(lists[2]).toContain("['agricultural', 'municipal', 'other']");
    expect(lists[2]).toContain("e.data.url !== '/service/interior-painting/'");
    expect(lists[2]).not.toContain("/service/municipal-painting/");
    // the lists are what the model says, in the order it says
    const ctx = await makeCtx(
      "fineline",
      { kind: "template", slug: "archive-service" },
      { mode: "static" },
    );
    const state = out.state as StateMap;
    const want = (slugs: string[], exclude: number[]): string[] =>
      urlsOfPosts(
        ctx,
        postsWith(ctx, "service", "service-type", slugs).filter((p) => !exclude.includes(p.id)),
      );
    const got = lists.map((expr) => urlsOf(resolveSource(ctx, state, { expr })));
    expect(got[0]).toEqual(want(["interior"], [5282, 5280, 5307]));
    expect(got[1]).toEqual(want(["exterior"], [5282, 5280, 5307]));
    expect(got[2]).toEqual(want(["agricultural", "municipal", "other"], [5282, 5280]));
    expect(got.every((g) => g.length > 0)).toBe(true);
  });

  test("several post types are one source each, merged and sorted again", async () => {
    const ctx = bare(await makeCtx("ap", { kind: "post", id: 819 }));
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("post", "episode"),
        queryPerPage: st("6"),
        queryOrderBy: st("title"),
        queryOrder: st("ASC"),
      }),
      ctx,
    );
    const source = registerPostList(ctx, plan, "m");
    const state = Object.fromEntries(collectedState(ctx));
    expect(Object.keys(state).sort()).toEqual(["episode_entries", "post_entries"]);
    const { expr } = source as { expr: string };
    expect(expr).toContain("[...state.post_entries, ...state.episode_entries]");
    expect(expr).toContain(".sort((a, b) => by('title', 1, 1)(a, b))");
    expect(expr).toContain(".slice(0, 6)");
    expect(expr).not.toContain(".filter"); // no condition
    // the merged list is the six first titles of the two types together, in the order the real plugin's query gave (the straight quote before the curly one, `[` before a digit)
    const list = resolveSource(ctx, state, source);
    expect(list.map((e) => e.data.title)).toEqual(REAL_ORDER_AP.slice(0, 6));
    // and the native collection, which cannot say a collation, is not used for a title
    const fl = bare(await makeCtx("fineline", { kind: "post", id: 195 }));
    const byTitle = registerPostList(
      fl,
      postPlan(queryBlock({ queryPostType: pick("project"), queryOrderBy: st("title") }), fl),
      "t",
    );
    expect(byTitle).toHaveProperty("expr");
  });

  test("a page size that is a page is no limit, and an offset is a slice", async () => {
    const ctx = bare(await makeCtx("fineline", { kind: "post", id: 195 }));
    const paged = postPlan(
      queryBlock({ queryPostType: pick("project"), queryPerPage: st("5"), infiniteLoad: true }),
      ctx,
    );
    const source = registerPostList(ctx, paged, "p") as { pointer: string };
    expect(collectedState(ctx).get(source.pointer.replace("#/state/", ""))).not.toHaveProperty(
      "limit",
    );
    const offset = postPlan(
      queryBlock({ queryPostType: pick("project"), queryPerPage: st("5"), queryOffset: st("2") }),
      ctx,
    );
    const sliced = registerPostList(ctx, offset, "o") as { expr: string };
    expect(sliced.expr).toContain(".slice(2, 7)");
    const list = resolveSource(ctx, Object.fromEntries(collectedState(ctx)), sliced);
    expect(urlsOf(list)).toEqual(urlsOfPosts(ctx, evaluatePosts(ctx, offset)!));
  });

  test("a native plan written as an expression too lists the same entries", async () => {
    const ctx = bare(await makeCtx("fineline", { kind: "post", id: 195 }));
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("service"),
        queryPerPage: st("25"),
        queryExclude: pick(5282),
      }),
      ctx,
    );
    const native = registerPostList(ctx, plan, "n");
    const inline = registerPostList(ctx, plan, "n", { inline: true });
    expect("pointer" in native && "expr" in inline).toBe(true);
    const state = Object.fromEntries(collectedState(ctx));
    expect(urlsOf(resolveSource(ctx, state, inline))).toEqual(
      urlsOf(resolveSource(ctx, state, native)),
    );
  });

  test("defineState: the same definition is one entry, a different one under a taken key is numbered", () => {
    const ctx = bare({ report: createReport() } as unknown as ConvertCtx);
    expect(defineState(ctx, "a", { x: 1 })).toBe("a");
    expect(defineState(ctx, "a", { x: 1 })).toBe("a");
    expect(defineState(ctx, "a", { x: 2 })).toBe("a_2");
    expect(defineState(ctx, "a", { x: 2 })).toBe("a_2");
    expect(defineState(ctx, "a", { x: 3 })).toBe("a_3");
    expect([...collectedState(ctx).keys()]).toEqual(["a", "a_2", "a_3"]);
    // a context with a collector of its own is asked, not bypassed
    const seen: string[] = [];
    const own = {
      report: createReport(),
      defineState: (k: string) => (seen.push(k), `${k}!`),
    } as unknown as ConvertCtx;
    expect(defineState(own, "k", {})).toBe("k!");
    expect(seen).toEqual(["k"]);
    expect(collectedState(own).size).toBe(0);
  });

  test("a pointer is written for what an expression says, `$map.item` and page state alike; an expression that computes has none", () => {
    expect(pointerOf("state.entry", "data", "terms", "post_tag")).toBe(
      "#/state/entry/data/terms/post_tag",
    );
    expect(pointerOf("$map.item", "data", "rows")).toBe("$map/item/data/rows");
    expect(pointerOf("state.a.b")).toBe("#/state/a/b");
    expect(pointerOf("state.entry", "a/b", "c~d")).toBe("#/state/entry/a~1b/c~0d");
    expect(pointerOf("somethingElse")).toBeUndefined();
    expect(pointerOfExpr("state.entry.data.rows")).toBe("#/state/entry/data/rows");
    expect(pointerOfExpr("state.entry.data?.grp?.rows")).toBe("#/state/entry/data/grp/rows");
    expect(pointerOfExpr("$map.item.data.terms?.tag")).toBe("$map/item/data/terms/tag");
    expect(pointerOfExpr("state.entry.data['field-name']")).toBe("#/state/entry/data/field-name");
    expect(pointerOfExpr("state.entry.data?.['a\\u007bb']")).toBe("#/state/entry/data/a{b");
    expect(pointerOfExpr("state.entry.data.rows ?? []")).toBeUndefined();
    expect(pointerOfExpr("rows")).toBeUndefined();
    expect(pointerOfExpr("state.entry.data.rows.map(x => x)")).toBeUndefined();
  });
});

describe("the plan of a terms query", () => {
  let ctx: ConvertCtx;
  const termsPlan = (attrs: Record<string, unknown>): TermsPlan => {
    const { plan } = planOf(queryBlock({ queryType: "terms", ...attrs }), ctx);
    if (plan.kind !== "terms") throw new Error(plan.kind);
    return plan;
  };
  const names = (attrs: Record<string, unknown>): string[] =>
    termRows(ctx, termsPlan(attrs)).map((r) => r.slug);

  test("setup", async () => {
    ctx = await makeCtx("ap", { kind: "post", id: 819 });
  });

  test("the defaults are the plugin's: the category taxonomy, by name ascending, and empty terms hidden (block.json's queryHideEmpty is true)", () => {
    const plan = termsPlan({ queryHideEmpty: false });
    expect(plan).toMatchObject({
      taxonomies: ["category"],
      orderBy: "name",
      order: "asc",
      hideEmpty: false,
    });
    expect(termsPlan({})).toMatchObject({ hideEmpty: true });
    const rows = termRows(ctx, plan);
    expect(rows).toHaveLength(15);
    expect(rows.map((r) => r.name)).toEqual(
      rows.map((r) => r.name).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })),
    );
    expect(rows[0]).toEqual({
      slug: "ask-anabaptist-perspectives-anything",
      name: "Ask Anabaptist Perspectives Anything",
      url: "/category/ask-anabaptist-perspectives-anything/",
      description: "",
      taxonomy: "category",
    });
  });

  test("order, number, exclude, include, hide_empty, parent and the orderby that WordPress does not have", () => {
    expect(
      names({ queryOrderBy: st("count"), queryOrder: st("DESC"), queryPerPage: st("3") }),
    ).toEqual(["current-issues", "theology", "christian-living"]);
    expect(
      names({
        queryOrderBy: st("count"),
        queryOrder: st("DESC"),
        queryExclude: pick(191, 189),
        queryPerPage: st("2"),
      }),
    ).toEqual(["christian-living", "history"]);
    expect(names({ queryInclude: pick(326, 189), queryOrderBy: st("term_id") })).toEqual([
      "theology",
      "war",
    ]);
    expect(names({ queryParent: st("0") })).toHaveLength(15);
    expect(names({ queryParent: st("99") })).toEqual([]);
    // `date` is not an order of terms: WP_Term_Query falls back to the name
    expect(termsPlan({ queryOrderBy: st("date") }).orderBy).toBe("name");
  });

  test("hide_empty leaves out the terms nothing is filed under", async () => {
    const fl = await makeCtx("fineline", { kind: "post", id: 195 });
    const attrs = { queryType: "terms", queryTaxonomies: pick("project_tag") };
    const slugsOf = (a: Record<string, unknown>): string[] => {
      const { plan } = planOf(queryBlock({ ...attrs, ...a }), fl);
      return termRows(fl, plan as TermsPlan).map((r) => r.slug);
    };
    const all = slugsOf({ queryHideEmpty: false });
    const filled = slugsOf({ queryHideEmpty: true });
    // Gutenberg leaves out an attribute that equals its default (true): a block that never touched it hides them too
    expect(slugsOf({})).toEqual(filled);
    const expected = [...fl.model.terms.values()].filter(
      (t) => t.taxonomy === "project_tag" && t.count > 0,
    );
    expect(all).toHaveLength(18);
    expect(filled.length).toBeLessThan(all.length);
    expect(new Set(filled)).toEqual(new Set(expected.map((t) => t.slug)));
  });

  test("several taxonomies are listed together; what the plan does not read is said", () => {
    const rows = termRows(
      ctx,
      termsPlan({
        queryTaxonomies: pick("season", "series"),
        queryOrderBy: st("term_id"),
        queryHideEmpty: false,
      }),
    );
    expect(rows).toHaveLength(5 + 33);
    expect(new Set(rows.map((r) => r.taxonomy))).toEqual(new Set(["season", "series"]));
    expect(termsPlan({ queryNameLike: st("peace") }).dropped).toEqual(["queryNameLike"]);
  });
});

// ── What a query becomes ─────────────────────────────────────────────────────────────────────────

const queryHtml =
  '<div id="query-test{idadd}" class="query-test" data-query_id="7" data-cc_fr="true" data-cc_il="scroll"><ccdyn></ccdyn></div>';

/** A context that collects its own state and reports, with `convert` bound to itself. */
async function fresh(
  site: SiteName,
  subject: Subject,
  over: Partial<ConvertCtx> = {},
): Promise<ConvertCtx> {
  const real = await makeCtx(site, subject, over);
  const hoisted: { selector: string; style: unknown }[] = [];
  const ctx = {
    ...real,
    report: createReport(),
    defineState: undefined,
    hoist: (rule: { selector: string; style: unknown }) => void hoisted.push(rule),
    hoisted,
  } as unknown as ConvertCtx;
  ctx.convert = (blocks, more) => convertBlocks(blocks, more ? withOverrides(ctx, more) : ctx);
  return ctx;
}

/** The rules a conversion handed to `ctx.hoist`, for a context made by {@link fresh}. */
const hoistedOf = (ctx: ConvertCtx): { selector: string; style: unknown }[] =>
  (ctx as unknown as { hoisted: { selector: string; style: unknown }[] }).hoisted;

/** A conversion of one query over projects, with the title template inside. */
async function convertQuery(
  attrs: Record<string, unknown>,
  inner: WpBlock[] = [templateBlock()],
  over: Partial<ConvertCtx> = {},
  subject: Subject = { kind: "post", id: 195 },
  site: SiteName = "fineline",
): Promise<{ nodes: JxNode[]; ctx: ConvertCtx; state: Map<string, unknown> }> {
  const ctx = await fresh(site, subject, over);
  const q = {
    ...queryBlock({ queryPostType: pick("project"), queryPerPage: st("3"), ...attrs }, inner),
    innerHTML: queryHtml,
  };
  const nodes = convertBlocks([q], ctx);
  return { nodes, ctx, state: collectedState(ctx) };
}

describe("a query block", () => {
  test("is its element, around the query template, around a mapped array that is the template's only child", async () => {
    const { nodes, state } = await convertQuery({ frontendRendering: true });
    expect(nodes).toHaveLength(1);
    const root = nodes[0] as JxElement;
    expect(root.tagName).toBe("div");
    expect(classes(root)[0]).toBe("query-test");
    // the plugin's own scripts read these two attributes; the id and the query's number stay
    expect(root.attributes).toEqual({ "data-query_id": "7", id: "query-test" });
    const template = (root.children as JxElement[])[0]!;
    expect(template).toMatchObject({
      tagName: "div",
      attributes: { "cc-query-template": "", id: "querytemplate-test" },
    });
    expect(template.children).toHaveLength(1);
    const array = (template.children as JxElement[])[0]!;
    expect(isArray(array)).toBe(true);
    expect(array).toMatchObject({ $prototype: "Array", items: { $ref: "#/state/project_q7" } });
    expect(array.map).toMatchObject({ tagName: "div", className: "cc-query-item" });
    // the item is converted as an entry of the loop: `$map.item`, in entry mode
    expect((array.map as JxElement).children).toEqual([
      expect.objectContaining({ tagName: "h3", textContent: "${$map.item.data.title ?? ''}" }),
    ]);
    expect(state.get("project_q7")).toMatchObject({ $prototype: "ContentCollection", limit: 3 });
  });

  test("a users query is a plan: the people an ACF user field of the post holds, a list of ids, or the people of roles; the block's own pick is not used", async () => {
    const ctx = await makeCtx(
      "ap",
      { kind: "template", slug: "single-episode" },
      { mode: "entry", entryType: "episode" },
    );
    const field = planOf(
      queryBlock({
        queryType: "users",
        queryOrder: st("DESC"),
        queryOrderBy: st("date"),
        queryInclude: {
          source: "dynamic",
          type: "acf",
          group: "g",
          field: "field_62d867cf7c18b",
          fallback: "226, 153",
        },
      }),
      ctx,
    );
    expect(field.plan).toMatchObject({
      kind: "users",
      field: { key: "field_62d867cf7c18b" },
      ids: [],
      order: "desc",
    });
    expect(
      planOf(queryBlock({ queryType: "users", queryInclude: st("4, 9") }), ctx).plan,
    ).toMatchObject({ kind: "users", field: undefined, ids: [4, 9] });
    expect(
      planOf(
        queryBlock({
          queryType: "users",
          queryRole: pick("staff", "editor"),
          queryRoleNotIn: pick("subscriber"),
        }),
        ctx,
      ).plan,
    ).toMatchObject({ kind: "users", roles: ["staff", "editor"], rolesNotIn: ["subscriber"] });
    // What a static list cannot follow is said, and the request's own search is the unfiltered list.
    const odd = planOf(
      queryBlock({
        queryType: "users",
        queryMeta: [{ key: "x" }],
        querySearch: dyn("urlparameter", "s"),
        queryInclude: dyn("postterms"),
      }),
      ctx,
    );
    expect(odd.plan).toMatchObject({ kind: "users" });
    expect((odd.plan as { dropped: string[] }).dropped.join(" ")).toContain("queryMeta");
    expect((odd.plan as { dropped: string[] }).dropped.join(" ")).toContain("postterms");
    expect(odd.info.map((i) => i.code)).toEqual(["query.url-parameter"]);
  });

  test("the people of a users query are a loop whose row is the person: the post's own entry is still the entry, and the tokens read the row", async () => {
    const seen: ConvertCtx[] = [];
    registerConverters({
      "x/probe": (_b, c) => {
        seen.push(c);
        return [];
      },
    });
    const person = block(
      "cwicly/heading",
      { headingTag: "h3", dynamic: "userquery", dynamicWordPressType: "display_name" },
      [],
      "<h3>{userquery=display_name}</h3>",
    );
    const { nodes, ctx: made } = await convertQuery(
      {
        queryType: "users",
        queryPostType: undefined,
        queryOrder: st("DESC"),
        queryOrderBy: st("date"),
        queryInclude: {
          source: "dynamic",
          type: "acf",
          group: "g",
          field: "field_62d867cf7c18b",
          fallback: "226",
        },
      },
      [templateBlock([person, block("x/probe")])],
      { mode: "entry", entryExpr: "state.entry", entryType: "episode" } as Partial<ConvertCtx>,
      { kind: "template", slug: "single-episode" },
      "ap",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      mode: "entry",
      entryExpr: "state.entry",
      rowExpr: "$map.item",
    });
    const root = nodes[0] as JxElement;
    const template = (root.children as JxElement[])[0]!;
    // The host field holds one person or several: the list is computed from the entry, newest account first.
    const expr = String((template.children as string[])[0]);
    expect(expr).toContain("[].concat(state.entry.data.host ?? [])");
    expect(expr).toContain(".sort((a, b) => -1 * String(a.slug).localeCompare(String(b.slug)))");
    expect(expr).toContain("$i0?.title ?? ''");
    // The block's own pick (226) is the editor's sample: an episode with no host lists nobody, as the live page does.
    expect(expr).not.toContain("226");
    expect(expr).not.toContain("r.length");
    expect(made.report.entries().some((e) => e.code === "block.unsupported")).toBe(false);
  });

  test("the people of roles and of a list of ids are the profiles that hold them, in the block's order, and the report says what the list can hold", async () => {
    const base = await fresh("ap", { kind: "post", id: 819 });
    const model = { ...base.model } as typeof base.model;
    const person = (id: number, name: string, roles: string[]) => ({
      id,
      slug: name.toLowerCase().replace(/ /g, "-"),
      displayName: name,
      meta: { position: `${name}'s position` },
      roles,
    });
    setUserProfiles(
      model,
      new Map([
        [9001, person(9001, "Ada Staff", ["staff"])],
        [9002, person(9002, "Bea Board", ["board_member"])],
        [9003, person(9003, "Cy Staff", ["staff", "board_member"])],
        [9004, person(9004, "Di Reader", ["subscriber"])],
      ]),
    );
    const ctx = { ...base, model } as ConvertCtx;
    const plan = (attrs: Record<string, unknown>): QueryPlan =>
      planOf(queryBlock({ queryType: "users", ...attrs }), ctx).plan;
    const names = (source: ListSource): string[] => {
      const key = "pointer" in source ? source.pointer.replace("#/state/", "") : "";
      const rows = collectedState(ctx).get(key) as { title: string }[] | undefined;
      return (rows ?? []).map((r) => r.title);
    };
    const run = (attrs: Record<string, unknown>) => {
      const q = queryBlock({ queryType: "users", ...attrs });
      const p = planQuery(q, ctx).plan;
      if (p.kind !== "users") throw new Error("not a users plan");
      return userList(ctx, p, q);
    };
    expect(plan({ queryRole: pick("staff") })).toMatchObject({ kind: "users" });
    const staff = run({
      queryRole: pick("staff"),
      queryOrderBy: st("display_name"),
      queryOrder: st("DESC"),
    });
    expect(names(staff.source)).toEqual(["Cy Staff", "Ada Staff"]);
    expect(staff.notes.map((n) => n.code)).toEqual(["query.users-profiled"]);
    expect(
      names(run({ queryRoleNotIn: pick("subscriber"), queryOrderBy: st("display_name") }).source),
    ).toEqual(["Ada Staff", "Bea Board", "Cy Staff"]);
    // `registered` is the order of the accounts, newest first for DESC.
    expect(
      names(
        run({
          queryRole: pick("board_member"),
          queryOrder: st("DESC"),
          queryOrderBy: st("registered"),
        }).source,
      ),
    ).toEqual(["Cy Staff", "Bea Board"]);
    const ids = run({ queryInclude: st("9004, 9001, 99999"), queryOrderBy: st("display_name") });
    expect(names(ids.source)).toEqual(["Ada Staff", "Di Reader"]);
    expect(ids.notes).toMatchObject([{ code: "query.user-missing", detail: "99999" }]);
    // The rows are the person as an entry holds one: the account and the profile's fields.
    const key = (ids.source as { pointer: string }).pointer.replace("#/state/", "");
    expect((collectedState(ctx).get(key) as Record<string, unknown>[])[0]).toMatchObject({
      id: 9001,
      slug: "ada-staff",
      title: "Ada Staff",
      url: "",
    });
    // Nobody holds the role: an empty list the build computes, not an empty mapped array.
    expect(run({ queryRole: pick("nobody") }).source).toEqual({ expr: "[]" });
    // The field of the post is read from the entry; a field that is not a user field is left empty and said.
    const wrong = run({
      queryInclude: {
        source: "dynamic",
        type: "acf",
        group: "g",
        field: "field_nope",
        fallback: "",
      },
    });
    expect(wrong.source).toEqual({ expr: "[]" });
    expect(wrong.notes[0]).toMatchObject({ code: "query.approximated", severity: "warn" });
  });

  test("`date` is not an order of users: WP_User_Query falls back to the login, as it does for any key it cannot parse", async () => {
    const base = await fresh("ap", { kind: "post", id: 819 });
    const model = { ...base.model } as typeof base.model;
    // Three orders that disagree: registered Zoe, Mia, Abe; named Abe, Mia, Zoe; logged in as Mia, Zoe, Abe.
    const person = (id: number, name: string, slug: string) => ({
      id,
      slug,
      displayName: name,
      meta: {},
      roles: ["staff"],
    });
    setUserProfiles(
      model,
      new Map([
        [10, person(10, "Zoe Late", "bb-zoe")],
        [11, person(11, "Mia Middle", "aa-mia")],
        [12, person(12, "Abe Early", "cc-abe")],
      ]),
    );
    const ctx = { ...base, model } as ConvertCtx;
    const order = (orderBy: string | undefined, dir: string): string[] => {
      const q = queryBlock({
        queryType: "users",
        queryRole: pick("staff"),
        queryOrder: st(dir),
        ...(orderBy === undefined ? {} : { queryOrderBy: st(orderBy) }),
      });
      const p = planQuery(q, ctx).plan;
      if (p.kind !== "users") throw new Error("not a users plan");
      const { source } = userList(ctx, p, q);
      const key = (source as { pointer: string }).pointer.replace("#/state/", "");
      return (collectedState(ctx).get(key) as { title: string }[]).map((r) => r.title);
    };
    expect(order("date", "DESC")).toEqual(["Abe Early", "Zoe Late", "Mia Middle"]);
    expect(order("date", "ASC")).toEqual(["Mia Middle", "Zoe Late", "Abe Early"]);
    expect(order("nonsense", "DESC")).toEqual(["Abe Early", "Zoe Late", "Mia Middle"]);
    expect(order(undefined, "ASC")).toEqual(["Mia Middle", "Zoe Late", "Abe Early"]);
    // the keys it does know
    expect(order("registered", "DESC")).toEqual(["Abe Early", "Mia Middle", "Zoe Late"]);
    expect(order("ID", "ASC")).toEqual(["Zoe Late", "Mia Middle", "Abe Early"]);
    expect(order("display_name", "ASC")).toEqual(["Abe Early", "Mia Middle", "Zoe Late"]);
    expect(order("user_login", "ASC")).toEqual(["Mia Middle", "Zoe Late", "Abe Early"]);
  });

  test("a list of several post types gives its items no type of their own: the page's is not theirs", async () => {
    const seen: ConvertCtx[] = [];
    registerConverters({
      "x/probe": (_b, c) => {
        seen.push(c);
        return [];
      },
    });
    await convertQuery(
      { queryPostType: pick("project", "service") },
      [templateBlock([block("x/probe")])],
      { entryType: "project" } as Partial<ConvertCtx>,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ mode: "entry", entryExpr: "$map.item" });
    expect(seen[0]!.entryType).toBeUndefined();
  });

  test("hands its items an entry context: `$map.item`, entry mode, the loop's post type, no enclosing row, no loop of their own", async () => {
    const seen: ConvertCtx[] = [];
    registerConverters({
      "x/probe": (_b, c) => {
        seen.push(c);
        return [];
      },
    });
    await convertQuery({}, [templateBlock([block("x/probe")])], {
      rowExpr: "$map.item",
    } as Partial<ConvertCtx>);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ mode: "entry", entryExpr: "$map.item", entryType: "project" });
    expect(seen[0]!.rowExpr).toBeUndefined();
    // a query inside it is its own query, not the loop of the one around it
    seen.length = 0;
    const inner = block(
      "cwicly/query",
      { queryId: 1, queryPostType: pick("project"), queryPerPage: st("2") },
      [templateBlock([block("x/probe")])],
    );
    const { nodes } = await convertQuery({}, [templateBlock([inner])]);
    expect(elementsWhere(nodes, isArray)).toHaveLength(2);
  });

  /** A paragraph with one hide condition on the query it sits in. */
  const noteWhen = (condition: string, operator: string, data = ""): WpBlock =>
    block(
      "cwicly/paragraph",
      {
        classID: `note-${condition}`,
        content: "A note",
        hideConditions: [{ condition, operator, data }],
      },
      [],
      `<p class="note-${condition}">A note</p>`,
    );

  /** The value of a `${…}` binding over the state a conversion registered (and the collections of the model). */
  const evaluate = (
    ctx: ConvertCtx,
    state: Map<string, unknown>,
    binding: unknown,
    extra: Record<string, unknown> = {},
  ): unknown => {
    const inner = /^\$\{([\s\S]*)\}$/.exec(String(binding))![1]!;
    return resolveSource(ctx, Object.fromEntries(state), { expr: inner }, extra);
  };

  test("the query itself passes a queryhasitems condition, whatever its operator (the plugin's cc_pass), and says nothing about it", async () => {
    for (const operator of ["true", "false"]) {
      const { nodes, ctx } = await convertQuery({
        hideConditions: [{ condition: "queryhasitems", operator, data: "" }],
        hideConditionsType: "&&",
        isStyling: true,
      });
      const root = nodes[0] as JxElement;
      expect(root.attributes).not.toHaveProperty("hidden");
      expect(root.style ?? {}).not.toHaveProperty("&[hidden]");
      expect(ctx.report.entries().some((e) => e.code === "condition.dropped")).toBe(false);
    }
    // with OR the pass makes the whole list true
    const or = await convertQuery({
      hideConditions: [
        { condition: "queryhasitems", operator: "false", data: "" },
        { condition: "posttitle", operator: "===", data: "Nothing like this" },
      ],
      hideConditionsType: "||",
    });
    expect(or.nodes).toHaveLength(1);
    expect((or.nodes[0] as JxElement).attributes).not.toHaveProperty("hidden");
    // querycount is not given to the block that makes the query: it says so and shows the block
    const own = await convertQuery({
      hideConditions: [{ condition: "querycount", operator: ">", data: "2" }],
    });
    expect(own.ctx.report.entries().find((e) => e.code === "condition.dropped")).toBeDefined();
  });

  test("the blocks inside a query are given its count: queryhasitems is the length of the list, querycount every match, not the page", async () => {
    const { nodes, ctx, state } = await convertQuery({}, [
      templateBlock(),
      noteWhen("queryhasitems", "false"),
      noteWhen("queryhasitems", "true"),
      noteWhen("querycount", ">", "3"),
    ]);
    const root = nodes[0] as JxElement;
    const [, none, some, many] = (root.children as JxElement[]).map((c) => c);
    // "no results" is hidden when the list has items; the other way round for "has results"
    expect(evaluate(ctx, state, none!.attributes!.hidden)).toBe(true);
    expect(evaluate(ctx, state, some!.attributes!.hidden)).toBe(false);
    expect(none!.style).toMatchObject({ "&[hidden]": { display: "none !important" } });
    expect(JSON.stringify(nodes)).not.toContain("\uE0F1");
    // the page of the query holds three projects and 82 match: `querycount > 3` is true, which counting the page (3) would not say
    expect(evaluate(ctx, state, many!.attributes!.hidden)).toBe(false);
    expect(String(many!.attributes!.hidden)).toContain("state.project_q7_all.length");
    expect(state.get("project_q7_all")).toMatchObject({ contentType: "project" });
    expect(state.get("project_q7_all")).not.toHaveProperty("limit");
    expect(state.get("project_q7")).toMatchObject({ limit: 3 });
    // the state of the total is written only when a block asks for it
    const without = await convertQuery({}, [templateBlock(), noteWhen("queryhasitems", "false")]);
    expect([...without.state.keys()]).toEqual(["project_q7"]);
    expect(ctx.report.entries().some((e) => e.code === "condition.dropped")).toBe(false);
  });

  test("an empty list shows what says there is nothing, and hides what says there is something", async () => {
    const { nodes, ctx, state } = await convertQuery(
      { queryTaxonomy: [taxEntry({ taxonomy: "project_tag", terms: pick(34) })] }, // commercial-projects: no posts
      [templateBlock(), noteWhen("queryhasitems", "false"), noteWhen("querycount", "===", "0")],
    );
    const [, none, zero] = (nodes[0] as JxElement).children as JxElement[];
    expect(evaluate(ctx, state, none!.attributes!.hidden)).toBe(false);
    expect(evaluate(ctx, state, zero!.attributes!.hidden)).toBe(false);
  });

  test("in a Markdown entry the count is known, and the block is decided now: kept, or not there at all", async () => {
    const { nodes } = await convertQuery(
      {},
      [
        templateBlock(),
        noteWhen("queryhasitems", "false"),
        noteWhen("queryhasitems", "true"),
        noteWhen("querycount", ">", "1"),
      ],
      {},
      { kind: "post", id: 1078 },
    );
    const children = (nodes[0] as JxElement).children as JxElement[];
    const notes = children.filter((c) => (classes(c)[0] ?? "").startsWith("note-"));
    expect(notes.map((c) => classes(c)[0])).toEqual(["note-queryhasitems", "note-querycount"]);
    for (const n of notes) expect(n.attributes ?? {}).not.toHaveProperty("hidden");
  });

  test("a query inside a query gives its own blocks its own count", async () => {
    const inner = block(
      "cwicly/query",
      {
        classID: "inner",
        queryId: 8,
        queryInherit: false,
        queryPostType: pick("service"),
        queryPerPage: st("2"),
      },
      [templateBlock(), noteWhen("queryhasitems", "true")],
      '<div class="inner"><ccdyn></ccdyn></div>',
    );
    const { nodes, ctx, state } = await convertQuery({}, [
      templateBlock(),
      inner,
      noteWhen("querycount", ">", "50"),
    ]);
    const root = nodes[0] as JxElement;
    const innerRoot = (root.children as JxElement[]).find((c) => classes(c)[0] === "inner")!;
    const innerNote = (innerRoot.children as JxElement[]).find(
      (c) => classes(c)[0] === "note-queryhasitems",
    )!;
    expect(String(innerNote.attributes!.hidden)).toContain("state.service_q8.length");
    const outerNote = (root.children as JxElement[]).find(
      (c) => classes(c)[0] === "note-querycount",
    )!;
    expect(String(outerNote.attributes!.hidden)).toContain("project_q7_all");
    expect(evaluate(ctx, state, outerNote.attributes!.hidden)).toBe(false);
  });

  test("a query that selects nothing today still writes its list, and says it is empty", async () => {
    const { nodes, state, ctx } = await convertQuery({
      queryTaxonomy: [taxEntry({ taxonomy: "project_tag", terms: pick(34) })], // commercial-projects: no posts
    });
    // a taxonomy clause is computed children over the one collection of the type
    expect([...state.keys()]).toEqual(["project_entries"]);
    expect(inlineLoops(nodes)).toHaveLength(1);
    expect(ctx.report.entries().find((e) => e.code === "query.empty")).toMatchObject({
      severity: "info",
    });
    // a list a collection can say is a mapped array over it
    const native = await convertQuery({
      queryExclude: pick(
        ...entryPosts(await makeCtx("fineline", { kind: "post", id: 195 }), "project").map(
          (p) => p.id,
        ),
      ),
      queryPerPage: st("3"),
    });
    expect(elementsWhere(native.nodes, isArray)).toHaveLength(1);
    expect(native.ctx.report.entries().some((e) => e.code === "query.empty")).toBe(true);
  });

  test("that cannot be a list is its element and an empty template, and is reported as unsupported with where it is", async () => {
    const { nodes, ctx, state } = await convertQuery({
      queryType: "comments",
      queryPostType: undefined,
    });
    const root = nodes[0] as JxElement;
    const template = (root.children as JxElement[])[0]!;
    expect(template.attributes).toMatchObject({ "cc-query-template": "" });
    expect(template.children).toBeUndefined();
    expect(elementsWhere(nodes, isArray)).toEqual([]);
    expect(state.size).toBe(0);
    expect(ctx.report.entries().filter((e) => e.code === "block.unsupported")).toMatchObject([
      {
        severity: "warn",
        where: "post:195",
        data: { classID: "query-test", feature: "query-comments" },
      },
    ]);
  });

  test("with a pagination device lists every entry and says what the page size was and how many there are", async () => {
    const { state, ctx } = await convertQuery({ infiniteLoad: true, queryPerPage: st("5") });
    expect(state.get("project_q7")).not.toHaveProperty("limit");
    const entry = ctx.report.entries().find((e) => e.code === "query.pagination")!;
    expect(entry).toMatchObject({ severity: "warn", data: { perPage: 5, total: 82, pages: 17 } });
    // a plain limit says nothing about pagination
    const plain = await convertQuery({ queryPerPage: st("5") });
    expect(plain.ctx.report.entries().some((e) => e.code === "query.pagination")).toBe(false);
    expect(plain.state.get("project_q7")).toMatchObject({ limit: 5 });
  });

  test("the pagination blocks print nothing and say so", async () => {
    const numbers = block(
      "cwicly/query-pagination-numbers",
      { classID: "n" },
      [],
      "<div>{pagination}</div>",
    );
    const pagination = block("cwicly/query-pagination", { classID: "p" }, [numbers], "<div></div>");
    const { nodes, ctx } = await convertQuery({}, [templateBlock(), pagination]);
    const root = nodes[0] as JxElement;
    // The blocks print nothing: what the query has beside its template is the load-more device of
    // its own (the checkbox first, a label of ours after), and no trace of the two blocks.
    expect((root.children as JxElement[]).map((c) => c.tagName)).toEqual(["input", "div", "label"]);
    expect(JSON.stringify(root)).not.toContain("pagination");
    const entries = ctx.report.entries().filter((e) => e.code === "query.pagination");
    expect(entries.map((e) => e.severity).sort()).toEqual(["info", "warn"]);
    // standing alone, the same
    const alone = await fresh("fineline", { kind: "post", id: 195 });
    expect(convertBlocks([pagination, numbers], alone)).toEqual([]);
    expect(alone.report.entries().filter((e) => e.code === "query.pagination")).toHaveLength(2);
  });

  test("with a pagination device shows the first page and a no-script way to the rest", async () => {
    const { nodes, ctx } = await convertQuery({
      infiniteLoad: true,
      infiniteLoadMore: "button",
      queryPerPage: st("5"),
    });
    const root = nodes[0] as JxElement;
    const [toggle, template, more] = root.children as JxElement[];
    expect(toggle).toMatchObject({
      tagName: "input",
      attributes: { type: "checkbox", id: "cc-more-195_7" },
    });
    expect(template?.attributes).toMatchObject({ "cc-query-template": "" });
    expect(more).toMatchObject({
      tagName: "label",
      className: "cc-load-more",
      attributes: { for: "cc-more-195_7" },
      textContent: "Load more",
    });
    // The entries are all there; the page size is a rule, which the checkbox lifts.
    const rules = hoistedOf(ctx).map((r) => r.selector);
    expect(rules).toContain("#cc-more-195_7:not(:checked) ~ * > .cc-query-item:nth-child(n+6)");
    expect(rules.some((r) => r.startsWith("#cc-more-195_7:checked ~ * label[for="))).toBe(true);
    expect(rules).toContain(".cc-load-more");
    expect(ctx.report.entries().find((e) => e.code === "query.pagination")?.message).toContain(
      "hides all but the first 5",
    );
  });

  test("the author's own Load More button is the control, as a label for the checkbox, with its classes", async () => {
    const button = block(
      "cwicly/button",
      { classID: "loadmore", content: "Load More", linkWrapperAction: "infiniteButtonLoad" },
      [],
      '<button class="loadmore">Load More</button>',
    );
    const holder = block(
      "cwicly/container",
      { classID: "holder" },
      [button],
      '<div class="holder"><ccdyn></ccdyn></div>',
    );
    const { nodes } = await convertQuery({ infiniteLoad: true, queryPerPage: st("6") }, [
      templateBlock(),
      holder,
    ]);
    const root = nodes[0] as JxElement;
    expect((root.children as JxElement[]).map((c) => c.tagName)).toEqual(["input", "div", "div"]);
    const labels = [...walkElements(nodes)].filter((e) => e.tagName === "label");
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      className: expect.stringContaining("loadmore"),
      attributes: expect.objectContaining({ for: "cc-more-195_7", role: "button" }),
      textContent: "Load More",
    });
    expect(labels[0]?.attributes).not.toHaveProperty("href");
    expect([...walkElements(nodes)].some((e) => e.tagName === "button")).toBe(false);
  });

  test("an infinite scroll loads the rest by itself, so the list stays whole and says so", async () => {
    const { nodes, ctx } = await convertQuery({
      infiniteLoad: true,
      infiniteLoadMore: "scroll",
      queryPerPage: st("5"),
    });
    expect(((nodes[0] as JxElement).children as JxElement[]).map((c) => c.tagName)).toEqual([
      "div",
    ]);
    expect(hoistedOf(ctx)).toEqual([]);
    const said = ctx.report.entries().find((e) => e.code === "query.pagination")!;
    expect(said.message).toContain("all 82 entries instead of 5 per page");
    expect(said.message).not.toContain("hides");
  });

  test("pagedByClick: a button mode, a pagination block or a link that goes to another page; not a scroll, not a plain limit", () => {
    const q = (attrs: Record<string, unknown>, inner: WpBlock[] = []) => queryBlock(attrs, inner);
    expect(pagedByClick(q({ infiniteLoad: true, infiniteLoadMore: "button" }))).toBe(true);
    expect(pagedByClick(q({ infiniteLoad: true, infiniteLoadMore: "scroll" }))).toBe(false);
    expect(pagedByClick(q({ infiniteLoad: true }))).toBe(false);
    expect(pagedByClick(q({}))).toBe(false);
    expect(pagedByClick(q({}, [block("cwicly/query-pagination")]))).toBe(true);
    expect(
      pagedByClick(
        q({}, [
          block("cwicly/div", {}, [block("cwicly/button", { linkWrapperAction: "nextQuery" })]),
        ]),
      ),
    ).toBe(true);
  });

  test("a plain limit has no device, and a query that cannot hoist keeps listing everything", async () => {
    const plain = await convertQuery({ queryPerPage: st("5") });
    expect((plain.nodes[0] as JxElement).children).toHaveLength(1);
    expect(hoistedOf(plain.ctx)).toEqual([]);
    const ctx = await fresh("fineline", { kind: "post", id: 195 });
    const bare = { ...ctx, hoist: undefined } as unknown as ConvertCtx;
    bare.convert = (blocks, more) => convertBlocks(blocks, more ? withOverrides(bare, more) : bare);
    const q = {
      ...queryBlock({ queryPostType: pick("project"), infiniteLoad: true, queryPerPage: st("5") }, [
        templateBlock(),
      ]),
      innerHTML: queryHtml,
    };
    const out = convertBlocks([q], bare);
    expect(((out[0] as JxElement).children as JxElement[]).map((c) => c.tagName)).toEqual(["div"]);
  });

  test("a masonry template marks its items, a slider is only said; a template outside a query is written once, and said", async () => {
    const masonry = block(
      "cwicly/query-template",
      { classID: "qt", repeaterMasonry: true, repeaterSlider: true },
      [titleHeading()],
      '<div class="qt"></div>',
    );
    const { nodes, ctx } = await convertQuery({}, [masonry]);
    expect(elementsWhere(nodes, isArray)[0]!.map).toMatchObject({
      className: "cc-query-item cc-masonry-item",
    });
    expect(ctx.report.entries().map((e) => e.code)).toContain("query.slider");
    const alone = await fresh("fineline", { kind: "post", id: 195 });
    const out = convertBlocks([templateBlock()], alone);
    expect(elementsWhere(out, isArray)).toEqual([]);
    expect(elementsWhere(out, (e) => e.tagName === "h3")).toHaveLength(1);
    expect(alone.report.entries().find((e) => e.code === "block.unsupported")).toMatchObject({
      data: { feature: "query-template" },
    });
  });

  test("inside another loop is reported: its list cannot depend on the enclosing item", async () => {
    const { ctx } = await convertQuery({}, [templateBlock()], {
      entryExpr: "$map.item",
      mode: "entry",
    });
    expect(ctx.report.entries().find((e) => e.code === "loop.nested")).toMatchObject({
      severity: "warn",
    });
    const flat = await convertQuery({});
    expect(flat.ctx.report.entries().some((e) => e.code === "loop.nested")).toBe(false);
  });

  test("a list of terms is a state entry of the terms and a loop over their term references", async () => {
    const attrs = {
      queryType: "terms",
      queryTaxonomies: pick("project_type"),
      queryPostType: undefined,
      queryPerPage: st("3"),
      queryOrderBy: st("count"),
      queryOrder: st("DESC"),
    };
    const heading = block(
      "cwicly/heading",
      { classID: "h", dynamic: "taxonomyquery", dynamicWordPressType: "name" },
      [],
      '<h3 class="h">{termquery=name}</h3>',
    );
    const { nodes, state } = await convertQuery(attrs, [templateBlock([heading])]);
    const [array] = elementsWhere(nodes, isArray);
    expect(array).toMatchObject({ items: { $ref: "#/state/terms_project_type_q7" } });
    expect(state.get("terms_project_type_q7")).toMatchObject([
      { slug: "staining", name: "Log Cabin Staining", taxonomy: "project_type" },
      { slug: "interior-painting" },
      { slug: "exterior-painting" },
    ]);
    // the term of the item is `$map.item`, a reference with no `data`
    expect(JSON.stringify(array!.map)).toContain("${$map.item.name ?? ''}");
  });

  test("in a template part the terms are written out, item by item: a `$ref` would make the component a client render", async () => {
    const attrs = {
      queryType: "terms",
      queryTaxonomies: pick("project_type"),
      queryPostType: undefined,
      queryPerPage: st("3"),
      queryOrderBy: st("count"),
      queryOrder: st("DESC"),
    };
    const link = block(
      "cwicly/paragraph",
      { classID: "l", dynamic: "taxonomyquery", dynamicWordPressType: "name" },
      [],
      '<p class="l">{termquery=name}</p>',
    );
    const { nodes, state } = await convertQuery(
      attrs,
      [templateBlock([link])],
      {},
      { kind: "part", slug: "footer" },
    );
    expect(elementsWhere(nodes, isArray)).toEqual([]);
    const [template] = elementsWhere(nodes, (e) => "cc-query-template" in (e.attributes ?? {}));
    const items = template!.children as JxElement[];
    expect(items).toHaveLength(3);
    expect(items.map((i) => (i.children as JxElement[])[0]!.textContent)).toEqual([
      "Log Cabin Staining",
      expect.any(String),
      expect.any(String),
    ]);
    // nothing of the item still reads the row, and nothing is a reference
    expect(JSON.stringify(items)).not.toContain("$map");
    expect(JSON.stringify(nodes)).not.toContain("$ref");
    // the state entry stays: a count a condition asks about reads it
    expect(state.get("terms_project_type_q7")).toHaveLength(3);
    // a page keeps its mapped array
    const page = await convertQuery(attrs, [templateBlock([link])]);
    expect(elementsWhere(page.nodes, isArray)).toHaveLength(1);
  });

  test("a written-out term list prints the row's values in the text around them, one text per item", async () => {
    const attrs = {
      queryType: "terms",
      queryTaxonomies: pick("project_type"),
      queryPostType: undefined,
      queryPerPage: st("2"),
      queryOrderBy: st("count"),
      queryOrder: st("DESC"),
    };
    const link = block(
      "cwicly/paragraph",
      { classID: "l", dynamic: "taxonomyquery", dynamicWordPressType: "name" },
      [],
      '<p class="l">{termquery=name}</p>',
    );
    const { nodes } = await convertQuery(
      attrs,
      [templateBlock([{ ...link, attrs: { ...link.attrs, dynamicStaticBefore: "Topic: " } }])],
      {},
      { kind: "part", slug: "footer" },
    );
    const [template] = elementsWhere(nodes, (e) => "cc-query-template" in (e.attributes ?? {}));
    expect(
      (template!.children as JxElement[]).map((i) => (i.children as JxElement[])[0]!.textContent),
    ).toEqual(["Topic: Log Cabin Staining", expect.stringMatching(/^Topic: \S/)]);
  });
});

describe("writtenOut: an item written once per row", () => {
  const item = (more: Record<string, unknown>): JxElement =>
    ({ tagName: "div", className: "cc-query-item", ...more }) as JxElement;
  const rows = [
    { name: "A & B", url: "/a/", count: 0 },
    { name: "C", url: "/c/", count: 2 },
  ];

  test("a binding of the row alone is its value, whole or inside text; a value that is not text keeps its type", () => {
    const out = writtenOut(
      item({
        attributes: { href: "${$map.item.url}", title: "${$map.item.count || false}" },
        children: ["x ${$map.item.name ?? ''} #${$map.index}"],
        textContent: "${$map.item.name ?? ''}",
      }),
      rows,
    )!;
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      attributes: { href: "/a/", title: false },
      children: ["x A & B #0"],
      textContent: "A & B",
    });
    expect(out[1]).toMatchObject({
      attributes: { href: "/c/", title: 2 },
      children: ["x C #1"],
      textContent: "C",
    });
    // A binding that is a whole object is not a value to write into a node: it stays as written.
    const [whole] = writtenOut(item({ attributes: { x: "${$map.item}" } }), rows)!;
    expect((whole as JxElement).attributes).toEqual({ x: "${$map.item}" });
  });

  test("a binding that reads state, or that does not run, is left as it was", () => {
    const [first] = writtenOut(
      item({
        attributes: { a: "${state.menu.open}", b: "${$map.item.nope.deeper}" },
        textContent: "${state.n} of ${$map.item.name}",
      }),
      rows,
    )!;
    expect(first).toMatchObject({
      attributes: { a: "${state.menu.open}", b: "${$map.item.nope.deeper}" },
      textContent: "${state.n} of A & B",
    });
  });

  test("an item with a loop or a reference of its own is not written out, and no rows is no children", () => {
    expect(
      writtenOut(item({ children: [{ $prototype: "Array", items: { $ref: "#/state/x" } }] }), rows),
    ).toBeUndefined();
    expect(writtenOut(item({ $ref: "./x.json" }), rows)).toBeUndefined();
    expect(writtenOut(item({}), [])).toEqual([]);
  });

  test("the item is copied: rows do not share nodes", () => {
    const [a, b] = writtenOut(
      item({ children: [{ tagName: "p", textContent: "${$map.item.name}" }] }),
      rows,
    )!;
    expect((a as JxElement).children).not.toBe((b as JxElement).children);
  });
});

describe("a query inside a Markdown entry", () => {
  test("is written out: the entries the plan selects now, each the template converted for that entry as a static page", async () => {
    const site = await loadSite("fineline");
    const subject: Subject = { kind: "post", id: 1078 };
    const out = await convertSubject(site, subject);
    expect(out.state).toEqual({}); // an entry has no state
    expect(elementsWhere(out.nodes, isArray)).toEqual([]);
    const items = elementsWhere(out.nodes, (e) => hasClass(e, "cc-query-item"));
    const ctx = await makeCtx("fineline", subject);
    const posts = evaluatePosts(ctx, postPlan(queriesOf(site, subject)[0]!, ctx))!;
    expect(posts).toHaveLength(4);
    expect(items).toHaveLength(4);
    // each item links to its own entry, in the plan's order, and prints its own title, with nothing left to bind
    const links = items.map((item) => elementsWhere([item], (e) => e.tagName === "a")[0]!);
    expect(links.map((a) => (a.attributes as Record<string, string>).href)).toEqual(
      urlsOfPosts(ctx, posts),
    );
    const titles = items.map((item) => {
      const h = elementsWhere([item], (e) => e.tagName === "h3")[0]!;
      const a = elementsWhere([h], (e) => e.tagName === "a")[0]!;
      return String(a.textContent);
    });
    expect(titles).toEqual(posts.map((p) => postData(ctx, p).title as string));
    expect(JSON.stringify(items)).not.toContain("${");
    expect(out.report.entries().find((e) => e.code === "query.static")).toMatchObject({
      severity: "warn",
      where: "post:1078",
      data: { entries: 4 },
    });
  });

  test("keeps what the entry can hold: the items' own style stays in a Markdown-safe form", async () => {
    const out = await convertSubject(await loadSite("fineline"), { kind: "post", id: 1078 });
    expect(out.report.entries().filter((e) => e.code === "convert.marker-leaked")).toEqual([]);
    expect(out.report.entries().filter((e) => e.severity === "error")).toEqual([]);
  });

  test("a loop over terms or rows has no static form in an entry and is left empty, and said", async () => {
    const essay = [...(await loadSite("ap")).model.posts.values()].find(
      (p) => p.slug === "the-cultural-captivity-of-the-gospel" && p.type === "post",
    )!;
    const ctx = await fresh("ap", { kind: "post", id: essay.id });
    const terms = block(
      "cwicly/taxonomyterms",
      { classID: "tt", taxtermsSource: "current" },
      [titleHeading()],
      '<div class="tt"><ccdyn></ccdyn></div>',
    );
    const rows = block(
      "cwicly/repeater",
      { classID: "rp", dynamic: "acf", dynamicACFField: "field_62d867cf76f62" },
      [],
      '<div class="rp"><ccdyn></ccdyn></div>',
    );
    const out = convertBlocks([terms, rows], ctx);
    expect(out).toHaveLength(2);
    expect(elementsWhere(out, isArray)).toEqual([]);
    expect(
      ctx.report
        .entries()
        .filter((e) => e.code === "block.unsupported")
        .map((e) => (e.data as { feature: string }).feature),
    ).toEqual(["taxonomyterms", "repeater"]);
    const list = await convertQuery(
      { queryType: "terms", queryTaxonomies: pick("category") },
      undefined,
      {},
      { kind: "post", id: essay.id },
      "ap",
    );
    expect(elementsWhere(list.nodes, isArray)).toEqual([]);
    expect(list.ctx.report.entries().map((e) => e.code)).toContain("block.unsupported");
  });
});

describe("taxonomyterms", () => {
  let ap: LoadedSite;
  let fl: LoadedSite;
  let essay: WpPost;
  /** The real block of a template. */
  const realBlock = (site: LoadedSite, slug: string): WpBlock =>
    blocksNamed(subjectBlocks(site, { kind: "template", slug }), "cwicly/taxonomyterms")[0]!;
  const withAttrs = (b: WpBlock, attrs: Record<string, unknown>): WpBlock => ({
    ...b,
    attrs: { ...b.attrs, ...attrs },
  });
  /** The rows a loop reads: its pointer followed from the state entry (or the page's own) it names, or its computed list evaluated. */
  const rowsOf = (
    ctx: ConvertCtx,
    nodes: JxNode[],
    extra: Record<string, unknown> = {},
  ): { slug: string; name: string }[] => {
    const state = Object.fromEntries(collectedState(ctx));
    const [array] = elementsWhere(nodes, isArray);
    if (array === undefined) {
      const [loop] = inlineLoops(nodes);
      const expr = inlineList((loop!.children as string[])[0]!);
      return resolveSource(ctx, state, { expr }, extra) as unknown as {
        slug: string;
        name: string;
      }[];
    }
    return resolveSource(
      ctx,
      state,
      { pointer: (array.items as { $ref: string }).$ref },
      extra,
    ) as unknown as { slug: string; name: string }[];
  };

  test("setup", async () => {
    ap = await loadSite("ap");
    fl = await loadSite("fineline");
    essay = [...ap.model.posts.values()].find(
      (p) => p.slug === "the-cultural-captivity-of-the-gospel" && p.type === "post",
    )!;
  });

  test("the entry's own terms are read from the entry when the page is built, so a tag added later shows by itself and an entry with none stays static; each is `<div><a>`", async () => {
    const ctx = await fresh("ap", { kind: "template", slug: "single-post" }, { mode: "entry" });
    const [out] = convertBlocks([realBlock(ap, "single-post")], ctx);
    const root = out as JxElement;
    expect(root.tagName).toBe("div");
    expect(classes(root)[0]).toBe("taxonomyterms-episodes");
    expect(root.attributes).toEqual({ id: "taxonomyterms-episodes" });
    expect(root.children).toHaveLength(1);
    // not a mapped array over `#/state/entry/data/terms/post_tag`: an entry with no tag has no such array,
    // and an empty or missing one turns the whole page into a client render
    expect(elementsWhere([root], isArray)).toEqual([]);
    const [only] = root.children as string[];
    expect(only).toContain("(state.entry.data.terms?.['post_tag'] ?? []).map(($i0, $x0) => (");
    expect(only).toContain("'tagName': 'div'");
    expect(only).not.toContain("'className'");
    expect(only).toContain("'attributes': {'href': ($i0.url ?? '')}");
    expect(only).toContain("'textContent': ($i0.name ?? '')");
    expect(collectedState(ctx).size).toBe(0); // nothing to register: the page already has the entry
    // it lists the entry's terms, and none for an entry without any
    const tagsOf = (p: WpPost): string[] =>
      rowsOf(ctx, [root], { entry: entryOf(ctx, p) }).map((r) => r.slug);
    expect(tagsOf(essay)).toEqual(
      (postData(ctx, essay).terms as Record<string, { slug: string }[]>).post_tag!.map(
        (t) => t.slug,
      ),
    );
    const untagged = entryPosts(ctx, "post").find(
      (p) =>
        (postData(ctx, p).terms as Record<string, unknown[]> | undefined)?.post_tag === undefined,
    )!;
    expect(untagged).toBeDefined();
    expect(tagsOf(untagged)).toEqual([]);
  });

  test("on a static page the terms are the page's own, as data, in WordPress's order", async () => {
    const ctx = await fresh("ap", { kind: "post", id: essay.id }, { target: "page" });
    const out = convertBlocks([realBlock(ap, "single-post")], ctx);
    expect(rowsOf(ctx, out).map((r) => r.name)).toEqual([
      "Church Community",
      "Discipleship",
      "Kingdom of God",
      "Ministry",
      "Missions",
    ]);
    const [array] = elementsWhere(out, isArray);
    expect((array!.items as { $ref: string }).$ref).toMatch(
      /^#\/state\/terms_current_[0-9a-f]{6}$/,
    );
  });

  test("term filters, a limit and several taxonomies make a Function over the entry, that the model confirms", async () => {
    const ctx = await fresh("ap", { kind: "template", slug: "single-post" }, { mode: "entry" });
    const base = realBlock(ap, "single-post");
    const run = (attrs: Record<string, unknown>): string[] => {
      const out = convertBlocks([withAttrs(base, attrs)], ctx);
      return rowsOf(ctx, out, { entry: entryOf(ctx, essay) }).map((r) => r.slug);
    };
    // by term id: kingdom-of-god 138, ministry 139, discipleship 143
    const tag = { label: "Tags", value: "post_tag", taxonomy: true };
    const term = (value: string): Record<string, unknown> => ({ label: value, value });
    expect(run({ taxtermsInclude: [tag, term("143"), term("138"), term("139")] })).toEqual([
      "discipleship",
      "kingdom-of-god",
      "ministry",
    ]);
    expect(run({ taxtermsInclude: [tag], taxtermsExclude: [term("139")] })).toEqual([
      "church-community",
      "discipleship",
      "kingdom-of-god",
      "missions",
    ]);
    // a term that is also included stays: the plugin only excludes what it was not asked to include
    expect(run({ taxtermsInclude: [tag, term("139")], taxtermsExclude: [term("139")] })).toEqual([
      "ministry",
    ]);
    expect(run({ taxtermsNumber: 2 })).toEqual(["church-community", "discipleship"]);
    // categories, then tags: the taxonomies in the order the block lists them
    const both = run({
      taxtermsInclude: [
        { label: "Categories", value: "category", taxonomy: true },
        { label: "Tags", value: "post_tag", taxonomy: true },
      ],
      taxtermsNumber: 0,
    });
    const own = postData(ctx, essay).terms as Record<string, { slug: string }[]>;
    expect(both).toEqual([...(own.category ?? []), ...(own.post_tag ?? [])].map((t) => t.slug));
    expect(both.length).toBeGreaterThan(5);
    // a taxonomy left out; one that is also asked for stays (the plugin only excludes what was not included)
    const noTags = {
      taxtermsInclude: [],
      taxtermsExclude: [{ label: "Tags", value: "post_tag", taxonomy: true }],
    };
    expect(run(noTags)).toEqual((own.category ?? []).map((t) => t.slug));
    expect(run({ taxtermsExclude: noTags.taxtermsExclude })).toEqual(
      (own.post_tag ?? []).map((t) => t.slug),
    );
  });

  test("all the terms of a taxonomy: the export's own, by name, leaving out the archive's term where the block says so", async () => {
    const ctx = await fresh(
      "fineline",
      { kind: "template", slug: "taxonomy-project_type" },
      { mode: "entry" },
    );
    const out = convertBlocks([realBlock(fl, "taxonomy-project_type")], ctx);
    // `taxtermsHideEmpty` is true by default, so Farmhouse (no project filed under it) is not listed: the
    // live archive of kitchen-cabinets prints eight buttons for the ten terms
    const all = [...fl.model.terms.values()]
      .filter((t) => t.taxonomy === "project_type" && t.count > 0)
      .map((t) => decodeEntities(t.name));
    expect([...fl.model.terms.values()].filter((t) => t.taxonomy === "project_type")).toHaveLength(
      10,
    );
    const shown = rowsOf(ctx, out, {
      term: { data: { slug: "staining", taxonomy: "project_type" } },
    });
    expect(shown.map((r) => r.name)).toEqual(
      all
        .filter((n) => n !== "Log Cabin Staining")
        .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })),
    );
    expect(shown).toHaveLength(8);
    expect(shown.map((r) => r.name)).not.toContain("Farmhouse");
    // any other term (a different taxonomy's slug, say) leaves all nine
    expect(
      rowsOf(ctx, out, { term: { data: { slug: "staining", taxonomy: "location" } } }),
    ).toHaveLength(9);
    const state = Object.fromEntries(collectedState(ctx));
    expect(Object.keys(state).filter((k) => k.endsWith("_rows"))).toHaveLength(1);
    // the terms are data; the page's term is read when the list is built, in an expression no state entry holds
    expect(JSON.stringify(state)).not.toContain("Function");
    const [loop] = inlineLoops(out);
    const list = inlineList((loop!.children as string[])[0]!);
    expect(list).toContain(
      "t.slug !== state.term.data.slug || t.taxonomy !== state.term.data.taxonomy",
    );
    expect(list).not.toContain("${");
  });

  test("outside an archive `exclude current` leaves out the terms of the current entry: a page's own, here", async () => {
    const malvern = entryPosts(
      await makeCtx("fineline", { kind: "post", id: 195 }),
      "project",
    ).find((p) => p.slug === "house-painting-in-malvern-pa")!;
    const ctx = await fresh("fineline", { kind: "post", id: malvern.id }, { target: "page" });
    const out = convertBlocks([realBlock(fl, "taxonomy-project_type")], ctx);
    const mine = new Set(termsOf(ctx.model, malvern.id, "project_type").map((t) => t.slug));
    expect(mine.size).toBe(2);
    const shown = rowsOf(ctx, out).map((r) => r.slug);
    expect(shown).toHaveLength(7);
    expect(shown.some((s) => mine.has(s))).toBe(false);
    expect(ctx.report.entries().some((e) => e.code === "query.approximated")).toBe(false);
  });

  test("with no current entry at all the terms are all there, and the missing exclusion is said", async () => {
    const ctx = await fresh("fineline", { kind: "part", slug: "footer" });
    const out = convertBlocks([realBlock(fl, "taxonomy-project_type")], ctx);
    expect(rowsOf(ctx, out)).toHaveLength(9);
    expect(ctx.report.entries().find((e) => e.code === "query.approximated")).toMatchObject({
      severity: "warn",
    });
  });

  test("in an entry template the entry's own terms are the ones left out", async () => {
    const ctx = await fresh(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry" },
    );
    const out = convertBlocks([realBlock(fl, "taxonomy-project_type")], ctx);
    const project = entryPosts(ctx, "project").find(
      (p) => p.slug === "house-painting-in-malvern-pa",
    )!;
    const mine = termsOf(ctx.model, project.id, "project_type").map((t) => t.slug);
    expect(mine).toHaveLength(2);
    const shown = rowsOf(ctx, out, { entry: entryOf(ctx, project) }).map((r) => r.slug);
    expect(shown).toHaveLength(7);
    expect(shown.some((s) => mine.includes(s))).toBe(false);
    // an entry with no type has nothing to leave out
    const bethel = entryPosts(ctx, "project").find(
      (p) => p.slug === "log-home-staining-in-bethel-pa",
    )!;
    expect(rowsOf(ctx, out, { entry: entryOf(ctx, bethel) })).toHaveLength(9);
  });

  test("options of a custom list: exclude, include, hide empty, top level only, order, number", async () => {
    const ctx = await fresh("fineline", { kind: "post", id: 195 }, { target: "page" });
    const base = block(
      "cwicly/taxonomyterms",
      {
        classID: "tt",
        taxtermsSource: "custom",
        taxtermsTaxonomies: [{ value: "location", label: "Locations" }],
        taxtermsHideEmpty: false,
      },
      [titleHeading()],
      '<div class="tt"><ccdyn></ccdyn></div>',
    );
    const run = (attrs: Record<string, unknown>): string[] => {
      const out = convertBlocks([withAttrs(base, attrs)], ctx);
      return rowsOf(ctx, out).map((r) => r.slug);
    };
    expect(run({})).toHaveLength(24);
    // an attribute left out is block.json's default, true: the empty ones are not listed
    expect(run({ taxtermsHideEmpty: undefined })).toHaveLength(
      24 -
        [...ctx.model.terms.values()].filter((t) => t.taxonomy === "location" && t.count === 0)
          .length,
    );
    expect(run({ taxtermsExcludeChildren: true })).toEqual(["maryland", "pennsylvania"]);
    expect(
      run({
        taxtermsInclude: [
          { value: "79", label: "" },
          { value: "55", label: "" },
        ],
      }),
    ).toEqual(["lancaster-county-pa", "lebanon-county-pa"]);
    expect(run({ taxtermsExclude: [{ value: "50", label: "" }] })).toHaveLength(23);
    const empties = [...ctx.model.terms.values()].filter(
      (t) => t.taxonomy === "location" && t.count === 0,
    ).length;
    expect(run({ taxtermsHideEmpty: true })).toHaveLength(24 - empties);
    expect(
      run({ taxtermsOrderBy: "count", taxtermsOrderDirection: "DESC", taxtermsNumber: 2 }),
    ).toEqual(["lebanon-county-pa", "pennsylvania"]);
    // post types name taxonomies too
    const byType = withAttrs(base, {
      taxtermsTaxonomies: [],
      taxtermsPostType: [{ value: "service", label: "Services" }],
    });
    expect(rowsOf(ctx, convertBlocks([byType], ctx)).length).toBeGreaterThan(0);
  });

  test("a source it does not know, or `current` with no current entry, is an empty box, and said", async () => {
    const part = await fresh("fineline", { kind: "part", slug: "footer" });
    const current = block(
      "cwicly/taxonomyterms",
      { classID: "tt", taxtermsSource: "current" },
      [],
      '<div class="tt"><ccdyn></ccdyn></div>',
    );
    const unknown = block(
      "cwicly/taxonomyterms",
      { classID: "tt2", taxtermsSource: "mystery" },
      [],
      '<div class="tt2"><ccdyn></ccdyn></div>',
    );
    const out = convertBlocks([current, unknown], part);
    expect(out).toHaveLength(2);
    expect(elementsWhere(out, isArray)).toEqual([]);
    expect(part.report.entries().filter((e) => e.code === "block.unsupported")).toHaveLength(2);
  });

  test("inside another loop a filter cannot be a state entry: the pointer is all it says, and the rest is reported", async () => {
    const ctx = await fresh(
      "ap",
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryExpr: "$map.item" },
    );
    const filtered = withAttrs(realBlock(ap, "single-post"), { taxtermsNumber: 1 });
    const out = convertBlocks([filtered], ctx);
    expect(elementsWhere(out, isArray)[0]).toMatchObject({
      items: { $ref: "$map/item/data/terms/post_tag" },
    });
    expect(ctx.report.entries().find((e) => e.code === "query.approximated")).toMatchObject({
      severity: "warn",
    });
  });
});

describe("repeater", () => {
  const FIELD = "field_62d867cf76f62"; // ap's `collection-resource` repeater of the Posts group
  let ap: LoadedSite;
  let essay: WpPost;
  const cell = (): WpBlock =>
    block(
      "cwicly/heading",
      { classID: "h", headingTag: "h3", dynamic: "repeater", dynamicRepeaterField: "resource" },
      [],
      '<h3 class="h">{acfrepeater=resource}</h3>',
    );
  const repeater = (attrs: Record<string, unknown> = {}, inner: WpBlock[] = [cell()]): WpBlock =>
    block(
      "cwicly/repeater",
      { classID: "repeater-x", id: "repeater-x", dynamic: "acf", dynamicACFField: FIELD, ...attrs },
      inner,
      '<div class="repeater-x"><ccdyn></ccdyn></div>',
    );
  /** A context for an essay that has two rows in its repeater: the stored count and the rows' meta. */
  async function withRows(over: Partial<ConvertCtx> = {}): Promise<ConvertCtx> {
    const real = await makeCtx("ap", { kind: "post", id: essay.id }, { target: "page", ...over });
    const meta = new Map(real.model.postMeta);
    meta.set(essay.id, {
      ...real.model.postMeta.get(essay.id),
      "collection-resource": ["2"],
      "_collection-resource": [FIELD],
      "collection-resource_0_resource": ["8819"],
      "collection-resource_1_resource": ["7260"],
    });
    const ctx = {
      ...real,
      model: { ...real.model, postMeta: meta },
      report: createReport(),
      defineState: undefined,
    } as unknown as ConvertCtx;
    ctx.convert = (blocks, more) => convertBlocks(blocks, more ? withOverrides(ctx, more) : ctx);
    return ctx;
  }

  test("setup", async () => {
    ap = await loadSite("ap");
    essay = [...ap.model.posts.values()].find(
      (p) => p.slug === "the-cultural-captivity-of-the-gospel" && p.type === "post",
    )!;
  });

  test("on a static page the rows are the page's own, as data, and each is `<div>` with the row as `$map.item`", async () => {
    const ctx = await withRows();
    const [out] = convertBlocks([repeater()], ctx);
    const root = out as JxElement;
    expect(classes(root)[0]).toBe("repeater-x");
    expect(root.children).toHaveLength(1);
    const array = (root.children as JxElement[])[0]!;
    const key = (array.items as { $ref: string }).$ref.replace("#/state/", "");
    expect(key).toMatch(/^rows_collection_resource_[0-9a-f]{6}$/);
    const rows = collectedState(ctx).get(key) as { resource: { id: number; url: string } }[];
    expect(rows.map((r) => r.resource.id)).toEqual([8819, 7260]);
    expect(rows[0]!.resource.url).toBe("/essays/the-cultural-captivity-of-the-gospel/");
    expect(array.map).toMatchObject({
      tagName: "div",
      children: [{ tagName: "h3", textContent: "${$map.item?.resource ?? ''}" }],
    });
    expect((array.map as JxElement).className).toBeUndefined();
  });

  test("in an entry template the rows are read from the entry when the page is built, found under the field's name: an entry with no rows has no such key", async () => {
    const ctx = await fresh("ap", { kind: "template", slug: "single-post" }, { mode: "entry" });
    const [out] = convertBlocks([repeater()], ctx);
    expect(elementsWhere([out as JxElement], isArray)).toEqual([]);
    const [only] = (out as JxElement).children as string[];
    expect(only).toContain("(state.entry.data['collection-resource'] ?? []).map(($i0, $x0) => (");
    expect(collectedState(ctx).size).toBe(0);
  });

  test("a repeater with no `dynamic` attribute is an ACF repeater: block.json's default", async () => {
    const ctx = await withRows();
    const rows = (b: WpBlock): JxElement[] => elementsWhere(convertBlocks([b], ctx), isArray);
    expect(rows(repeater({ dynamic: undefined }))).toHaveLength(1);
    expect(rows(repeater({ dynamic: undefined }))[0]!.items).toEqual(rows(repeater())[0]!.items);
    expect(ctx.report.entries().some((e) => e.code === "block.unsupported")).toBe(false);
  });

  test("a repeater inside a row reads that row's sub field; with no enclosing row it cannot be listed", async () => {
    const sub = repeater(
      { dynamic: "repeater", dynamicRepeaterField: "children", dynamicACFField: undefined },
      [],
    );
    const inside = await fresh("ap", { kind: "template", slug: "single-post" }, {
      mode: "entry",
      rowExpr: "$map.item",
    } as Partial<ConvertCtx>);
    const [out] = convertBlocks([sub], inside);
    expect(((out as JxElement).children as JxElement[])[0]).toMatchObject({
      items: { $ref: "$map/item/children" },
    });
    const alone = await fresh("ap", { kind: "template", slug: "single-post" }, { mode: "entry" });
    const shell = convertBlocks([sub], alone);
    expect(elementsWhere(shell, isArray)).toEqual([]);
    expect(alone.report.entries().find((e) => e.code === "block.unsupported")).toMatchObject({
      data: { feature: "repeater" },
    });
  });

  test("what is not a list of ACF rows is an empty box, with the reason: an unknown field, a field of another type, a shop, an options page the site lacks", async () => {
    const ctx = await fresh("ap", { kind: "template", slug: "single-post" }, { mode: "entry" });
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ dynamicACFField: "field_nope" }, /no ACF field group defines/],
      [{ dynamicACFField: "field_62d867cf7799c" }, /not a repeater/],
      [{ dynamic: "woogallery" }, /shop/],
      [{ dynamic: "something" }, /not one this tool can list/],
      [{ dynamicACFFieldLocation: "option" }, /options page/],
      [{ dynamicACFFieldLocation: "currentuser" }, /user/],
    ];
    for (const [attrs] of cases) {
      const out = convertBlocks([repeater(attrs)], ctx);
      expect(out).toHaveLength(1);
      expect(elementsWhere(out, isArray)).toEqual([]);
    }
    const reasons = ctx.report
      .entries()
      .filter((e) => e.code === "block.unsupported")
      .map((e) => e.message);
    expect(reasons).toHaveLength(cases.length);
    cases.forEach(([, why], i) => expect(reasons[i]).toMatch(why));
  });

  test("a masonry repeater marks its items, and a repeater inside a query loop says what its `$map` is", async () => {
    const ctx = await withRows();
    const out = convertBlocks([repeater({ repeaterMasonry: true, repeaterSlider: true })], ctx);
    expect(elementsWhere(out, isArray)[0]!.map).toMatchObject({ className: "cc-masonry-item" });
    expect(ctx.report.entries().map((e) => e.code)).toContain("query.slider");
    const nested = await withRows({ mode: "entry", entryExpr: "$map.item" });
    convertBlocks([repeater()], nested);
    expect(nested.report.entries().find((e) => e.code === "loop.nested")).toMatchObject({
      severity: "warn",
    });
  });
});

// ── Components ───────────────────────────────────────────────────────────────────────────────────

describe("the variant classes of an instance", () => {
  const meta = (m: Record<string, unknown>): ConvertCtx =>
    ({
      model: {
        postMeta: new Map([[1, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [v]]))]]),
      },
    }) as unknown as ConvertCtx;
  const classesOf = (
    m: Record<string, unknown>,
    attrs: Record<string, unknown> = {},
  ): { classes: string[]; unknown: string[] } => variantClasses(meta(m), { postId: 1 }, attrs);
  const V = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];

  test("a component with no variants prints none, whatever the instance remembers (and the stale id is reported back)", () => {
    expect(classesOf({})).toEqual({ classes: [], unknown: [] });
    expect(classesOf({ variants: [] }, { variant: "x" })).toEqual({ classes: [], unknown: ["x"] });
  });

  test("an instance that names no variant gets the component's first (the plugin's default), a group's styles when there is one", () => {
    expect(classesOf({ variants: V })).toEqual({ classes: ["cs-a"], unknown: [] });
    expect(classesOf({ variants: V, variantGroups: [{ id: "g", styles: ["a", "b"] }] })).toEqual({
      classes: ["cs-a", "cs-b"],
      unknown: [],
    });
    expect(classesOf({ variants: V, variantGroups: [{ id: "g", styles: [] }] })).toEqual({
      classes: ["cs-a"],
      unknown: [],
    });
  });

  test("the variant it names, a group (`group-<id>`), or an id the component does not define (kept, and reported)", () => {
    expect(classesOf({ variants: V }, { variant: "b" })).toEqual({
      classes: ["cs-b"],
      unknown: [],
    });
    expect(
      classesOf(
        { variants: V, variantGroups: [{ id: "g", styles: ["b", "a"] }] },
        { variant: "group-g" },
      ),
    ).toEqual({ classes: ["cs-b", "cs-a"], unknown: [] });
    expect(classesOf({ variants: V }, { variant: "zz" })).toEqual({
      classes: ["cs-zz"],
      unknown: ["zz"],
    });
    expect(
      classesOf(
        { variants: V, variantGroups: [{ id: "g", styles: ["a"] }] },
        { variant: "group-missing" },
      ),
    ).toEqual({ classes: [], unknown: [] });
  });

  test("with style variations, one class per variation the instance chose, groups expanded, each once", () => {
    const m = {
      variants: V,
      styleVariations: [{ id: "sv1" }, { id: "sv2" }, { id: "sv3" }],
      variantGroups: [{ id: "g", styles: ["a", "b"] }],
    };
    expect(classesOf(m, { variations: { sv1: "b", sv2: "group-g" } })).toEqual({
      classes: ["cs-b", "cs-a"],
      unknown: [],
    });
    expect(classesOf(m, { variations: {} })).toEqual({ classes: [], unknown: [] });
    expect(classesOf(m, { variant: "a" })).toEqual({ classes: [], unknown: [] }); // variations decide, `variant` is for the other kind
    expect(classesOf(m, { variations: { sv3: "q" } })).toEqual({
      classes: ["cs-q"],
      unknown: ["q"],
    });
  });

  test("variants can be stored as a list or as a map", () => {
    expect(classesOf({ variants: { x: { id: "a" }, y: { id: "b" } } })).toEqual({
      classes: ["cs-a"],
      unknown: [],
    });
  });

  test("fineline's icon card: the first variant by default, the one an instance names otherwise", async () => {
    const ctx = await makeCtx("fineline", { kind: "post", id: 1078 });
    const info = ctx.components.get("0a275b695a")!;
    expect(info.variants.map((v) => v.id)).toEqual(["bmuh8n", "kxrx4"]);
    expect(variantClasses(ctx, info, {})).toEqual({ classes: ["cs-bmuh8n"], unknown: [] });
    expect(variantClasses(ctx, info, { variant: "kxrx4" })).toEqual({
      classes: ["cs-kxrx4"],
      unknown: [],
    });
    const image = ctx.components.get("244868a12d")!;
    expect(variantClasses(ctx, image, {})).toEqual({ classes: [], unknown: [] });
  });
});

describe("the properties of an instance", () => {
  let fl: LoadedSite;
  let ctx: ConvertCtx;
  /** The instances of a post, by component. */
  const instances = (subject: Subject, ref: string): WpBlock[] =>
    blocksNamed(subjectBlocks(fl, subject), "cwicly/component").filter((b) => b.attrs.ref === ref);
  const propsOf = (b: WpBlock, c: ConvertCtx = ctx): Record<string, unknown> =>
    instanceProps(c, b, c.components.get(String(b.attrs.ref))!);

  test("setup", async () => {
    fl = await loadSite("fineline");
    ctx = await fresh("fineline", { kind: "post", id: 1078 }, { target: "page" });
  });

  test("an icon card: the icon is the SVG the plugin prints (`unicode`), the texts are the OUTER maker, texturized", () => {
    const [first] = instances({ kind: "post", id: 1078 }, "0a275b695a");
    const given = first!.attrs.properties as Record<
      string,
      { value: { icon?: { unicode: string }; maker?: string; content?: { maker: string } } }
    >;
    const props = propsOf(first!);
    expect(Object.keys(props).sort()).toEqual(["heading", "icon", "paragraph"]);
    expect(props.icon).toBe(given.pIyOg!.value.icon!.unicode);
    expect(String(props.icon)).toContain('<path fill="unset"');
    // the inner `content.maker` is the editor's stale copy ("Lovely Appearance"); the page printed "Beauty"
    expect(given["1nsiW"]!.value.content!.maker).toBe("Lovely Appearance");
    expect(props.heading).toBe("Beauty");
    expect(props.paragraph).toBe(
      "Choose from a range of colors and finishes to customize your cabin’s look. Staining enhances its beauty, making it blend seamlessly with nature’s allure and increasing property value.",
    );
    // the button text and link were not given: the component's own defaults apply
    expect(props).not.toHaveProperty("buttonText");
    expect(props).not.toHaveProperty("buttonLink");
  });

  test("every property of every fineline instance is a property its component declares, and every given one arrives", async () => {
    const out = new Map<string, number>();
    for (const sub of allSubjects(fl)) {
      const blocks = blocksNamed(subjectBlocks(fl, sub), "cwicly/component");
      if (blocks.length === 0) continue;
      const c = await fresh("fineline", sub, { target: "page" });
      for (const b of blocks) {
        const info = c.components.get(String(b.attrs.ref));
        if (!info) continue;
        const props = instanceProps(c, b, info);
        expect(Object.keys(props).every((k) => info.props.some((p) => p.key === k))).toBe(true);
        const given = Object.keys((b.attrs.properties as object | undefined) ?? {});
        // a property arrives under its key unless its value is empty (the plugin ignores those)
        expect(Object.keys(props).length).toBeLessThanOrEqual(given.length);
        expect(Object.keys(props).length).toBeGreaterThanOrEqual(1);
        out.set(info.tagName, (out.get(info.tagName) ?? 0) + 1);
        // nothing the plugin would not print: no unresolved token, no private-use mark
        expect(JSON.stringify(props)).not.toMatch(/[]|\{[a-z]+=/);
      }
    }
    // 161 + 128 instances in the dump; one of the 290 instances names no component
    expect([...out]).toEqual([
      ["wp-icon-card", 161],
      ["wp-image-card", 128],
    ]);
  });

  test("an image card: the image is the media plan's file with its size and alt; the rest are texts", () => {
    const b = allWith("244868a12d");
    const props = propsOf(b);
    const id = Number(
      (b.attrs.properties as Record<string, { value: { image?: { imageID: number } } }>).eDHhK!
        .value.image!.imageID,
    );
    const media = ctx.mediaFor(id)!;
    expect(props.image).toEqual({
      src: media.src,
      alt: media.alt,
      ...(media.width === undefined ? {} : { width: media.width }),
      ...(media.height === undefined ? {} : { height: media.height }),
    });
    expect(String((props.image as { src: string }).src)).toMatch(/^\/media\//);
    expect(typeof props.heading).toBe("string");
    expect(typeof props.paragraph).toBe("string");
  });

  /** Any instance of a component, found across the site. */
  function allWith(ref: string): WpBlock {
    for (const sub of allSubjects(fl)) {
      const found = instances(sub, ref)[0];
      if (found) return found;
    }
    throw new Error(`no instance of ${ref}`);
  }

  const withProp = (
    type: string,
    given: Record<string, unknown>,
  ): {
    b: WpBlock;
    info: { postId: number; props: { id: string; key: string; type: string }[] };
  } => ({
    b: block("cwicly/component", { ref: "r", properties: { p1: given } }),
    info: { postId: 1, props: [{ id: "p1", key: "thing", type }] },
  });
  const run = (type: string, given: Record<string, unknown>, c: ConvertCtx = ctx): unknown => {
    const { b, info } = withProp(type, given);
    return instanceProps(c, b, info).thing;
  };

  test("text: tokens are resolved (a site token as its value), WordPress's quotes are written, and a text already curled is left alone", () => {
    expect(run("text", { value: { maker: "Don't {sitetitle}" } })).toBe(
      `Don’t ${decodeEntities(fl.model.site.name)}`,
    );
    // wptexturize is not idempotent: a text that already has WordPress's quotes is left as it is
    expect(run("text", { value: { maker: 'It’s "fine"' } })).toBe('It’s "fine"');
    expect(run("text", { value: "plain value" })).toBe("plain value");
    // no maker: the editor's content stands in
    expect(run("text", { value: { content: { content: "from content" } } })).toBe("from content");
    expect(run("text", { value: { content: "plain content" } })).toBe("plain content");
  });

  test("in an entry or a loop a token is a binding on the entry", async () => {
    const entry = await fresh(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry" },
    );
    expect(run("text", { value: { maker: "{title}" } }, entry)).toBe(
      "${state.entry.data.title ?? ''}",
    );
    const inLoop = await fresh(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryExpr: "$map.item" },
    );
    expect(run("text", { value: { maker: "Project: {title}" } }, inLoop)).toBe(
      "Project: ${$map.item.data.title ?? ''}",
    );
  });

  test("richtext: markup, with its quotes written and the addresses of the site moved", () => {
    const html = run("richtext", {
      value: {
        maker: `<p>Don't <a href="${fl.model.site.url}/projects/">see all</a> <b>now</b></p>`,
      },
    }) as string;
    expect(html).toContain("Don’t");
    expect(html).toContain('<a href="/projects/">see all</a>');
    expect(html).toContain("<b>now</b>");
  });

  test("a text property that holds markup is passed as it is and reported, because the component has to bind it as HTML", () => {
    const c = bare(ctx);
    expect(run("text", { value: { maker: "Increased <br>Value " } }, c)).toBe(
      "Increased <br>Value ",
    );
    expect(c.report.entries().find((e) => e.code === "component.markup-in-text")).toMatchObject({
      severity: "warn",
      data: { value: "Increased <br>Value " },
    });
  });

  test("icon: the `unicode` markup; without it the icon's own paths", () => {
    expect(run("icon", { value: { icon: { unicode: "<svg>u</svg>" } } })).toBe("<svg>u</svg>");
    const svg = run("icon", {
      value: { icon: { icon: { viewBox: "0 0 2 2", paths: [null, { d: "M0 0" }] } } },
    }) as string;
    expect(svg).toContain('viewBox="0 0 2 2"');
    expect(svg).toContain('<path d="M0 0"></path>');
  });

  test("link: `{href, rel?, target?, title?}`, internal addresses moved, `_self` is the default and is not written", () => {
    expect(
      run("link", {
        value: {
          maker: { href: `${fl.model.site.url}/projects/`, rel: "noopener", target: "_self" },
        },
      }),
    ).toEqual({ href: "/projects/", rel: "noopener" });
    expect(
      run("link", {
        value: { maker: { href: "https://example.org/x", target: "_blank", title: "Ex" } },
      }),
    ).toEqual({ href: "https://example.org/x", target: "_blank", title: "Ex" });
    expect(run("link", { value: { link: { linkWrapperUrl: "tel:7175551234" } } })).toEqual({
      href: "tel:7175551234",
    });
    expect(run("link", { value: { maker: { href: "" } } })).toBeUndefined();
  });

  test("a page object in a link is its address on the site", () => {
    const home = ctx.urlFor("post", 5246)!;
    expect(run("link", { value: { maker: { href: "{pageobject=5246=page=post-type}" } } })).toEqual(
      { href: home },
    );
  });

  test("image by id is the plan's file; by address a media URL is moved and anything else kept; with neither, nothing", () => {
    const media = ctx.mediaFor(2943)!;
    expect(
      run("image", {
        value: { image: { imageID: 2943, imageURL: "https://elsewhere.test/x.png" } },
      }),
    ).toMatchObject({ src: media.src, alt: media.alt });
    expect(
      run("image", { value: { image: { imageURL: "https://elsewhere.test/x.png" } } }),
    ).toEqual({ src: "https://elsewhere.test/x.png" });
    // an address on the site that is no media file (a page, a download) is moved like a link's
    expect(
      run("image", { value: { image: { imageURL: `${fl.model.site.url}/projects/` } } }),
    ).toEqual({ src: "/projects/" });
    expect(run("image", { value: { image: { imageID: 999_999_999 }, maker: {} } })).toBeUndefined();
    expect(run("image", { value: {} })).toBeUndefined();
  });

  test("options: the chosen option's value, looked up in the component's own definition", () => {
    const c = {
      ...ctx,
      model: { ...ctx.model, postMeta: new Map(ctx.model.postMeta) },
    } as ConvertCtx;
    (c.model.postMeta as Map<number, Record<string, unknown[]>>).set(1, {
      properties: [
        {
          p1: {
            type: "options",
            options: [
              { id: "o1", value: "Large" },
              { id: "o2", value: "Small" },
            ],
          },
        },
      ],
    });
    expect(run("options", { value: "o2" }, c)).toBe("Small");
    expect(run("options", { value: "gone" }, c)).toBe("gone");
  });

  test("a class property is its additional classes, then the names of its global classes", () => {
    const [id, name] = [...ctx.cwicly.globalClassNames][0]!;
    expect(
      run("class", {
        value: { additionalClass: [{ value: "x y" }, { value: "z" }], globalClass: [id] },
      }),
    ).toBe(`x y z ${name}`);
    expect(run("class", { value: { globalClass: ["no-such-class"] } })).toBe("");
  });

  test("the plugin ignores a value that is empty, and so does the instance (the component's default applies)", () => {
    for (const value of ["", "0", 0, false, null, {}, []]) {
      expect(run("text", { value })).toBeUndefined();
    }
    expect(run("text", {})).toBeUndefined();
  });

  test("a value of a kind this tool cannot read is reported and left out", () => {
    const c = bare(ctx);
    expect(run("mystery", { value: { weird: true } }, c)).toBeUndefined();
    expect(
      c.report.entries().find((e) => e.code === "component.property-unsupported"),
    ).toMatchObject({ severity: "warn" });
  });

  test("a property that comes from the enclosing component is a binding on its state; with no such property it is left out, and said", async () => {
    const parent = await fresh("fineline", { kind: "component", ref: "0a275b695a" });
    expect(parent.props!.get("1nsiW")).toBe("heading");
    expect(run("text", { parent: true, value: "1nsiW" }, parent)).toBe("${state.heading ?? ''}");
    expect(run("link", { parent: true, value: "SKhKx" }, parent)).toBe("${state.buttonLink ?? {}}");
    expect(run("image", { parent: true, value: "1nsiW" }, parent)).toBe("${state.heading ?? {}}");
    const lost = bare(ctx);
    expect(run("text", { parent: true, value: "nope" }, lost)).toBeUndefined();
    expect(
      lost.report.entries().find((e) => e.code === "component.parent-unresolved"),
    ).toMatchObject({ severity: "warn" });
  });

  test("a property the component no longer has is dropped, and said", () => {
    const c = bare(ctx);
    const b = block("cwicly/component", {
      ref: "r",
      properties: { gone: { value: "x" }, p1: { value: "kept" } },
    });
    expect(
      instanceProps(c, b, { postId: 1, props: [{ id: "p1", key: "thing", type: "text" }] }),
    ).toEqual({ thing: "kept" });
    expect(c.report.entries().find((e) => e.code === "component.unknown-property")).toMatchObject({
      data: { detail: expect.stringContaining("gone") },
    });
  });
});

describe("a component instance", () => {
  const inst = (attrs: Record<string, unknown> = {}): WpBlock =>
    block(
      "cwicly/component",
      {
        ref: "0a275b695a",
        uniqueID: "u-1",
        classID: "component-x",
        id: "component-y",
        additionalClassesR: "",
        properties: { "1nsiW": { value: { maker: "Hi" }, type: "text" } },
        ...attrs,
      },
      [],
      "\n<div></div>\n",
    );

  test("is the component's custom element with its `$props` and the variant class; the tag's one rule takes it out of the box tree", async () => {
    const ctx = await fresh("fineline", { kind: "post", id: 1078 }, { target: "page" });
    const [out] = convertBlocks([inst()], ctx);
    const el = out as JxElement;
    expect(el.tagName).toBe("wp-icon-card");
    expect(el.$props).toEqual({ heading: "Hi" });
    expect(el.className).toBe("cs-bmuh8n");
    expect(el.style).toBeUndefined();
    // the rule is the tag's, in the project's style: one rule, not one on every instance
    expect(hoistedOf(ctx)).toEqual([{ selector: "wp-icon-card", style: { display: "contents" } }]);
    // no id (an element with an id scopes its style to `#id`) and none of the plugin's own attributes
    expect(el.id).toBeUndefined();
    expect(el.attributes).toBeUndefined();
    expect(el.children).toBeUndefined();
    expect(ctx.report.entries().filter((e) => e.severity !== "info")).toEqual([]);
    const [other] = convertBlocks([inst({ variant: "kxrx4" })], ctx);
    expect((other as JxElement).className).toBe("cs-kxrx4");
    expect(new Set(hoistedOf(ctx).map((r) => JSON.stringify(r))).size).toBe(1);
  });

  test("with nowhere to put the rule, the instance carries it", async () => {
    const ctx = {
      ...(await fresh("fineline", { kind: "post", id: 1078 }, { target: "page" })),
      hoist: undefined,
    } as unknown as ConvertCtx;
    const [out] = convertBlocks([inst()], ctx);
    expect((out as JxElement).style).toEqual({ display: "contents" });
    expect(classes(out as JxElement)[1]).toBe("cs-bmuh8n");
  });

  test("with no properties given has no `$props` at all", async () => {
    const ctx = await fresh("fineline", { kind: "post", id: 1078 }, { target: "page" });
    const [out] = convertBlocks([inst({ properties: undefined })], ctx);
    expect(out).not.toHaveProperty("$props");
    const [empty] = convertBlocks([inst({ properties: {} })], ctx);
    expect(empty).not.toHaveProperty("$props");
  });

  test("holds the slot content, converted in the instance's own context", async () => {
    const ctx = await fresh("fineline", { kind: "post", id: 1078 }, { target: "page" });
    const serialized =
      '<!-- wp:cwicly/heading {"classID":"hh","headingTag":"h2","content":"Inside"} -->\n<h2 class="hh">Inside</h2>\n<!-- /wp:cwicly/heading -->';
    const [out] = convertBlocks([inst({ serializedInnerBlocks: serialized })], ctx);
    expect((out as JxElement).children).toMatchObject([
      { tagName: "h2", className: "hh", textContent: "Inside" },
    ]);
  });

  test("a hide condition is a binding on the host, with the rule that makes the attribute win", async () => {
    const ctx = await fresh(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry" },
    );
    const barn = { condition: "posttitle", operator: "contains", data: "Barn" };
    const [out] = convertBlocks([inst({ hideConditions: [barn], hideConditionsType: "&&" })], ctx);
    const el = out as JxElement;
    expect(el.attributes).toEqual({
      hidden: "${!(String((state.entry.data.title) ?? '').includes('Barn'))}",
    });
    expect(el.style).toEqual({ "&[hidden]": { display: "none !important" } });
    expect(classes(el)[0]).toMatch(/^jx-[0-9a-f]{10}$/); // a style needs a scope of its own
    expect(hoistedOf(ctx)).toEqual([{ selector: "wp-icon-card", style: { display: "contents" } }]);
    // an instance hidden from every visitor is not there at all, and its properties are not even read
    const guest = bare(ctx);
    expect(
      convertBlocks([inst({ hideGuest: true, properties: { gone: { value: "x" } } })], guest),
    ).toEqual([]);
    expect(guest.report.entries().some((e) => e.code === "component.unknown-property")).toBe(false);
  });

  test("of a component the export does not have prints nothing, as the plugin does, and says so; so does one with no reference", async () => {
    const ctx = await fresh("fineline", { kind: "post", id: 1078 }, { target: "page" });
    expect(convertBlocks([inst({ ref: "ffffffffff" }), inst({ ref: undefined })], ctx)).toEqual([]);
    expect(ctx.report.entries().filter((e) => e.code === "component.missing")).toMatchObject([
      { severity: "warn", data: { detail: expect.stringContaining("ffffffffff") } },
      { severity: "warn", data: { detail: expect.stringContaining("none") } },
    ]);
  });

  test("with a variant id the component does not define keeps the class, as the plugin does, and says so", async () => {
    const ctx = await fresh("fineline", { kind: "post", id: 1078 }, { target: "page" });
    const [out] = convertBlocks([inst({ variant: "nope" })], ctx);
    expect(classes(out as JxElement)).toContain("cs-nope");
    expect(ctx.report.entries().find((e) => e.code === "component.variant-unknown")).toMatchObject({
      severity: "info",
    });
  });

  test("an instance inside a component passes the enclosing component's property down", async () => {
    const parent = await fresh("ap", { kind: "component", ref: "494db6e67a" });
    // `wp-support-the-work` holds instances of `wp-default-button` and others; its own instance props are fixed text
    const out = convertBlocks(
      blocksNamed(
        subjectBlocks(await loadSite("ap"), { kind: "component", ref: "494db6e67a" }),
        "cwicly/component",
      ).slice(0, 3),
      parent,
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((n) => typeof n !== "string" && String(n.tagName).startsWith("wp-"))).toBe(
      true,
    );
  });
});

describe("innerblocks", () => {
  test("inside a component is a box with the one default slot", async () => {
    const ctx = await fresh("fineline", { kind: "component", ref: "0a275b695a" });
    const html = '<div id="innerblocks-x{idadd}" class="innerblocks-x"></div>';
    const [out] = convertBlocks(
      [block("cwicly/innerblocks", { classID: "innerblocks-x", id: "innerblocks-x" }, [], html)],
      ctx,
    );
    expect(out).toMatchObject({ tagName: "div", children: [{ tagName: "slot" }] });
    expect(classes(out as JxElement)[0]).toBe("innerblocks-x");
    expect(((out as JxElement).children as JxElement[])[0]).toEqual({ tagName: "slot" });
  });

  test("anywhere else prints nothing, and says so", async () => {
    const ctx = await fresh("fineline", { kind: "post", id: 195 });
    expect(convertBlocks([block("cwicly/innerblocks", {}, [], "<div></div>")], ctx)).toEqual([]);
    expect(ctx.report.entries().find((e) => e.code === "block.innerblocks-outside")).toMatchObject({
      severity: "warn",
    });
  });

  test("a hidden innerblocks prints nothing even inside a component", async () => {
    const ctx = await fresh("fineline", { kind: "component", ref: "0a275b695a" });
    expect(
      convertBlocks([block("cwicly/innerblocks", { hideGuest: true }, [], "<div></div>")], ctx),
    ).toEqual([]);
  });
});

// ── The whole corpus ─────────────────────────────────────────────────────────────────────────────

describe("every data block of both sites", () => {
  const DATA = [
    "cwicly/query",
    "cwicly/query-template",
    "cwicly/query-pagination",
    "cwicly/query-pagination-numbers",
    "cwicly/repeater",
    "cwicly/taxonomyterms",
    "cwicly/component",
    "cwicly/innerblocks",
  ];
  /** What is expected of each site, from the census of the fixtures (the numbers are the data's, not the module's). */
  const EXPECTED = {
    fineline: {
      queries: 58,
      templates: 58,
      instances: 290,
      missing: 1,
      taxonomyterms: 1,
      unsupported: 0,
      static: 43,
      live: 15,
    },
    ap: {
      queries: 29,
      templates: 29,
      instances: 12,
      missing: 0,
      taxonomyterms: 2,
      unsupported: 1,
      static: 0,
      live: 28,
    },
  } as const;

  for (const siteName of ["fineline", "ap"] as const) {
    test(`${siteName}: every block converts or is reported, every loop points at state the page has, and nothing is lost on the way`, async () => {
      const site = await loadSite(siteName);
      const tags = new Set([...site.components.values()].map((c) => c.tagName));
      const total = {
        queries: 0,
        templates: 0,
        instances: 0,
        missing: 0,
        taxonomyterms: 0,
        unsupported: 0,
        static: 0,
        live: 0,
        found: 0,
        subjects: 0,
      };
      for (const sub of allSubjects(site)) {
        const blocks = subjectBlocks(site, sub);
        const names = new Set<string>();
        const counts = new Map<string, number>();
        walkBlocks(blocks, (b) => {
          if (b.name && DATA.includes(b.name)) {
            names.add(b.name);
            counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
          }
        });
        if (names.size === 0) continue;
        total.subjects++;
        const out: Converted = await convertSubject(site, sub);
        const entries = out.report.entries();
        expect(
          entries.filter(
            (e) => e.code === "block.converter-error" || e.code === "convert.marker-leaked",
          ),
        ).toEqual([]);
        const elements = [...walkElements(out.nodes)];
        const queries = counts.get("cwicly/query") ?? 0;
        const templates = elements.filter(
          (e) => e.attributes && "cc-query-template" in (e.attributes as object),
        ).length;
        expect(templates).toBe(counts.get("cwicly/query-template") ?? 0);
        total.queries += queries;
        total.templates += templates;
        // each query is a live list, a written-out one, or an empty box that says why
        const statics = entries.filter((e) => e.code === "query.static").length;
        const unsupported = entries.filter(
          (e) =>
            e.code === "block.unsupported" &&
            String((e.data as { feature?: string })?.feature).startsWith("query-"),
        ).length;
        const arrays = elements.filter(isArray);
        const inlines = inlineLoops(out.nodes);
        const termLoops = counts.get("cwicly/taxonomyterms") ?? 0;
        const isQueryLoop = (e: JxElement): boolean =>
          isArray(e)
            ? hasClass(e.map as JxElement, "cc-query-item")
            : (e.children as string[])[0]!.includes("'cc-query-item'");
        const items = [...arrays, ...inlines].filter((l) => isQueryLoop(l as JxElement)).length;
        // a component's list of terms is written out, one item element per term
        const writtenOut =
          sub.kind === "part" || sub.kind === "component"
            ? elements.filter(
                (e) =>
                  e.attributes &&
                  "cc-query-template" in (e.attributes as object) &&
                  Array.isArray(e.children) &&
                  e.children.length > 0 &&
                  e.children.every(
                    (c) => typeof c !== "string" && hasClass(c as JxElement, "cc-query-item"),
                  ),
              ).length
            : 0;
        expect(items + statics + unsupported + writtenOut).toBe(queries);
        expect(arrays.length + inlines.length - items).toBe(termLoops);
        total.static += statics;
        total.unsupported += unsupported;
        total.live += items + writtenOut;
        total.taxonomyterms += termLoops;
        // a loop's list is a state entry the conversion registered, or a pointer into the entry or the enclosing item
        for (const a of arrays) {
          const ref = (a.items as { $ref: string }).$ref;
          if (ref.startsWith("#/state/")) {
            const key = ref.split("/")[2]!;
            expect(key in out.state || key === "entry").toBe(true);
            expect(out.used.states.has(key)).toBe(true);
          } else expect(ref.startsWith("$map/")).toBe(true);
        }
        // a computed list reads state that exists: the collections it registered, the entry, the term
        for (const e of inlines) {
          const expr = (e.children as string[])[0]!;
          for (const m of expr.matchAll(/\bstate\.([A-Za-z_]\w*)/g)) {
            expect(m[1]! in out.state || ["entry", "term"].includes(m[1]!)).toBe(true);
          }
          expect(expr).not.toContain("$map");
        }
        // a loop is the only child of its element
        for (const e of elements) {
          if (
            Array.isArray(e.children) &&
            e.children.some(
              (c) =>
                (typeof c !== "string" && isArray(c)) ||
                (typeof c === "string" && c.startsWith("${(")),
            )
          ) {
            expect(e.children).toHaveLength(1);
          }
        }
        // components: found or reported
        const instances = counts.get("cwicly/component") ?? 0;
        const missing = entries.filter((e) => e.code === "component.missing").length;
        const found = elements.filter(
          (e) => typeof e.tagName === "string" && tags.has(e.tagName),
        ).length;
        // an instance hidden from every visitor is removed, so only the sum is bounded
        expect(found + missing).toBeLessThanOrEqual(instances);
        total.instances += instances;
        total.missing += missing;
        total.found += found;
        // no state entry is a template string: a template state ships JavaScript (docs/bindings.md, [L5])
        for (const def of Object.values(out.state)) expect(typeof def).not.toBe("string");
      }
      const want = EXPECTED[siteName];
      expect({ ...total, subjects: undefined, found: undefined }).toEqual({
        ...want,
        subjects: undefined,
        found: undefined,
      });
      expect(total.found + total.missing).toBe(total.instances);
    });
  }
});

// ── The real Jx build ────────────────────────────────────────────────────────────────────────────

import { replacePlaceholders } from "../../../src/placeholders.ts";
import { buildCollections } from "../../../src/emit/collections.ts";
import { targetOf } from "../../../src/core/static.ts";
import { BASE_PROPERTIES, BASE_REQUIRED, taxonomiesFor } from "../../../src/wp/acf.ts";

/** The `cc-query-item`s of a built page: first link and text, like {@link liveItems}. */
function itemsOf(html: string): LiveItem[] {
  const items: LiveItem[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (n: any): string =>
    n.nodeName === "#text" ? n.value : (n.childNodes ?? []).map(text).join("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const first = (n: any, tag: string): any => {
    if (n.nodeName === tag) return n;
    for (const c of n.childNodes ?? []) {
      const found = first(c, tag);
      if (found) return found;
    }
    return undefined;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any): void => {
    const cls = n.attrs?.find((a: { name: string }) => a.name === "class")?.value ?? "";
    if (/\bcc-query-item\b/.test(cls)) {
      const a = first(n, "a");
      items.push({
        href: a?.attrs.find((x: { name: string }) => x.name === "href")?.value ?? "",
        text: text(n).replaceAll(/\s+/g, " ").trim(),
      });
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(parse(html));
  return items;
}

/** Whether a built page loads a script of its own (the page's module, `app.js`), leaving out the import map every page has. */
const shipsJs = (html: string): boolean =>
  /<script[^>]*type="module"/.test(html.replace(/<script type="importmap">[\s\S]*?<\/script>/, ""));

/** `content/<type>/<slug>.md` for every entry of the given types: the entry data as the collections emitter writes it, with an empty body. */
async function entryProject(
  site: SiteName,
  types: string[],
  extra: Record<string, ProjectFile> = {},
): Promise<{ files: Record<string, ProjectFile>; ctx: ConvertCtx }> {
  const loaded = await loadSite(site);
  const ctx = await makeCtx(site, {
    kind: "post",
    id: [...loaded.model.posts.values()].find((p) => p.type === "page")!.id,
  });
  const content: Record<string, unknown> = {};
  const files: Record<string, ProjectFile> = {
    "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
  };
  for (const type of types) {
    content[type] = {
      source: `content/${type}`,
      format: "Markdown",
      schema: { type: "object", properties: BASE_PROPERTIES, required: [...BASE_REQUIRED] },
    };
    for (const post of entryPosts(ctx, type)) {
      files[`content/${type}/${post.slug}.md`] = `---\n${stringify(postData(ctx, post))}---\n\n`;
    }
  }
  files["project.json"] = {
    name: "data-test",
    url: "https://example.com",
    extensions: ["@jxsuite/parser"],
    $media: loaded.options.media,
    defaults: { layout: "./layouts/base.json" },
    content,
  };
  return { files: { ...files, ...extra }, ctx };
}

const ENTRY = (type: string): Record<string, unknown> => ({
  $prototype: "ContentEntry",
  contentType: type,
  field: "slug",
  id: { $ref: "#/$params/slug" },
  $src: "@jxsuite/parser/ContentEntry.class.json",
  timing: "compiler",
});

/** A page of a converted subject: its nodes (placeholders removed), its state, and the entry it renders. */
function pageOf(out: Converted, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "t",
    state: { ...out.state, ...(extra.state as object | undefined) },
    children: replacePlaceholders(out.nodes, { "*": () => null }),
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "state")),
  };
}

describe("built by Jx", () => {
  test("fineline /residential/: the six projects a live page printed, in its order, and no JavaScript; the project validates", async () => {
    const site = await loadSite("fineline");
    const out = await convertSubject(site, { kind: "post", id: 195 });
    const { files } = await entryProject("fineline", ["project"]);
    files["pages/index.json"] = pageOf(out) as ProjectFile;
    const built: BuiltProject = await buildJxProject(files, { name: "residential" });
    const html = built.html("/");
    const got = itemsOf(html);
    const live = liveItems("fineline", "residential");
    expect(got).toHaveLength(6);
    expect(got.map((i) => i.href)).toEqual(live.map((i) => sitePath(i.href, site)));
    expect(got.map((i) => i.text)).toEqual(live.map((i) => i.text));
    expect(shipsJs(html)).toBe(false);
    // the state entries are build-time only, and what the build bound is the entries' own data
    expect(html).not.toContain("${");
    expect(html).not.toContain("ContentCollection");
    const items = [
      ...html.matchAll(/<div class="cc-query-item">[\s\S]*?<img [^>]*src="([^"]*)"/g),
    ].map((m) => m[1]!);
    expect(items).toHaveLength(6);
    expect(items.every((src) => src.startsWith("/media/"))).toBe(true);
    const validation = await validateJxProject(built.dir);
    expect(validation.problems).toEqual([]);
  });

  test("fineline home: the six newest projects (the dump lacks the live page's three newest)", async () => {
    const site = await loadSite("fineline");
    const out = await convertSubject(site, { kind: "post", id: 5246 });
    const { files, ctx } = await entryProject("fineline", ["project"]);
    files["pages/index.json"] = pageOf(out) as ProjectFile;
    const built = await buildJxProject(files, { name: "home" });
    const html = built.html("/");
    const got = itemsOf(html);
    const live = liveItems("fineline", "home");
    expect(got).toHaveLength(6);
    expect(got.slice(0, 3).map((i) => i.href)).toEqual(
      live.slice(3).map((i) => sitePath(i.href, site)),
    );
    const want = evaluatePosts(
      ctx,
      postPlan(queriesOf(site, { kind: "post", id: 5246 })[0]!, ctx),
    )!;
    expect(got.map((i) => i.href)).toEqual(urlsOfPosts(ctx, want));
    expect(shipsJs(html)).toBe(false);
  });

  test("fineline single-project template: the related list is the entry's first project type, not itself, newest four, for every entry", async () => {
    const site = await loadSite("fineline");
    const out = await convertSubject(site, { kind: "template", slug: "single-project" });
    const { files, ctx } = await entryProject("fineline", ["project"]);
    files["pages/project/[slug].json"] = pageOf(out, {
      $paths: { contentType: "project", param: "slug", field: "slug" },
      title: "${state.entry.data.title}",
      state: { entry: ENTRY("project") },
    }) as ProjectFile;
    const built = await buildJxProject(files, { name: "single-project" });
    const projects = entryPosts(ctx, "project");
    expect(projects).toHaveLength(82);
    const bySlug = (slug: string): WpPost => projects.find((p) => p.slug === slug)!;
    let checked = 0;
    for (const p of projects) {
      const own = termsOf(ctx.model, p.id, "project_type").sort((a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
      )[0];
      const pool =
        own === undefined ? projects : postsWith(ctx, "project", "project_type", [own.slug]);
      const want = [...pool]
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
        .filter((x) => x.id !== p.id)
        .slice(0, 4);
      const html = built.html(`/project/${p.slug}/`);
      const got = itemsOf(html).map((i) => i.href);
      expect(got).toEqual(urlsOfPosts(ctx, want));
      expect(got).not.toContain(ctx.urlFor("post", p.id)!);
      expect(shipsJs(html)).toBe(false);
      checked++;
    }
    expect(checked).toBe(82);
    expect((await validateJxProject(built.dir)).problems).toEqual([]);
    // one with a single type, one with two (the first by name decides), one with none
    expect(
      termsOf(ctx.model, bySlug("exterior-fence-paint-project-in-lebanon").id, "project_type"),
    ).toHaveLength(1);
    expect(
      termsOf(ctx.model, bySlug("house-painting-in-malvern-pa").id, "project_type"),
    ).toHaveLength(2);
    expect(
      termsOf(ctx.model, bySlug("log-home-staining-in-bethel-pa").id, "project_type"),
    ).toHaveLength(0);
  });

  test("fineline taxonomy-location template: the projects of the archive's term and its children, up to the page size", async () => {
    const site = await loadSite("fineline");
    const out = await convertSubject(site, { kind: "template", slug: "taxonomy-location" });
    const { files, ctx } = await entryProject("fineline", ["project"]);
    const terms = ["pennsylvania", "lebanon-county-pa", "maryland"];
    for (const slug of terms) {
      files[`pages/loc-${slug}.json`] = pageOf(out, {
        // the page's term, as the archive page defines it: a build-time value
        state: {
          term: {
            $prototype: "Function",
            body: `return ${JSON.stringify({ data: { slug, taxonomy: "location", name: slug, description: "", url: `/service_area/${slug}/` } })};`,
            timing: "compiler",
          },
        },
      }) as ProjectFile;
    }
    const built = await buildJxProject(files, { name: "taxonomy-location" });
    const all = [...ctx.model.terms.values()].filter((t) => t.taxonomy === "location");
    for (const slug of terms) {
      const root = all.find((t) => t.slug === slug)!;
      const family = [root.slug, ...all.filter((t) => t.parent === root.termId).map((t) => t.slug)];
      const want = postsWith(ctx, "project", "location", family).slice(0, 50);
      const html = built.html(`/loc-${slug}/`);
      expect(itemsOf(html).map((i) => i.href)).toEqual(urlsOfPosts(ctx, want));
      expect(shipsJs(html)).toBe(false);
    }
    // Pennsylvania has children, Maryland has none: the counts differ by the family
    expect(itemsOf(built.html("/loc-pennsylvania/")).length).toBeGreaterThan(
      itemsOf(built.html("/loc-lebanon-county-pa/")).length,
    );
    expect(itemsOf(built.html("/loc-maryland/")).length).toBe(2);
  });

  test("anabaptistperspectives essay template: the tags the live page printed, and the lists of related posts and episodes", async () => {
    const site = await loadSite("ap");
    const out = await convertSubject(site, { kind: "template", slug: "single-post" });
    const { files, ctx } = await entryProject("ap", ["post", "episode"]);
    files["pages/essays/[slug].json"] = pageOf(out, {
      $paths: { contentType: "post", param: "slug", field: "slug" },
      title: "${state.entry.data.title}",
      state: { entry: ENTRY("post") },
    }) as ProjectFile;
    const built = await buildJxProject(files, { name: "ap-single-post" });
    for (const slug of [
      "the-cultural-captivity-of-the-gospel",
      "the-way-we-live-is-the-way-we-educate",
      "keeshons-story-a-knock-heard-round-the-hood-part-3",
    ]) {
      const html = built.html(`/essays/${slug}/`);
      const live = readFileSync(join(FIXTURES, `ap/html/essays__${slug}.html`), "utf8");
      const tagsOf = (page: string): { href: string; text: string }[] => {
        const block = /<div[^>]*id="taxonomyterms-episodes"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/.exec(
          page,
        )![1]!;
        return [...block.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => ({
          href: m[1]!,
          text: decodeEntities(m[2]!),
        }));
      };
      const got = tagsOf(html);
      expect(got.length).toBeGreaterThan(0);
      expect(got.map((t) => t.text)).toEqual(tagsOf(live).map((t) => t.text));
      expect(got.map((t) => t.href)).toEqual(tagsOf(live).map((t) => sitePath(t.href, site)));
      // and the lists of more from the essay's series and category: the model's own answer
      const post = entryPosts(ctx, "post").find((p) => p.slug === slug)!;
      const first = (tax: string): string | undefined =>
        termsOf(ctx.model, post.id, tax).sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
        )[0]?.slug;
      const pool = [...entryPosts(ctx, "post"), ...entryPosts(ctx, "episode")];
      const wantFor = (tax: string): string[] => {
        const slug1 = first(tax);
        return pool
          .filter(
            (p) =>
              p.id !== post.id &&
              (slug1 === undefined || termsOf(ctx.model, p.id, tax).some((t) => t.slug === slug1)),
          )
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
          .slice(0, 6)
          .map((p) => ctx.urlFor("post", p.id)!);
      };
      const hrefs = itemsOf(html).map((i) => i.href);
      const bySeries = wantFor("series");
      expect(hrefs).toEqual([...bySeries, ...wantFor("category")]);
      expect(bySeries.length).toBeGreaterThan(0);
      expect(shipsJs(html)).toBe(false);
    }
  });

  test("anabaptistperspectives footer: the eight categories the live page printed, linked, from a plain state list", async () => {
    const site = await loadSite("ap");
    const out = await convertSubject(site, { kind: "part", slug: "footer" });
    // a part is a component, and a component with a `$ref` in it is not static: the footer's list is written out
    expect(JSON.stringify(out.nodes)).not.toContain('"$ref"');
    expect(out.state).toBeDefined();
    const { files } = await entryProject("ap", ["post"]);
    files["pages/index.json"] = pageOf(out) as ProjectFile;
    const built = await buildJxProject(files, { name: "ap-footer" });
    const html = built.html("/");
    const got = itemsOf(html).filter((i) => i.href.startsWith("/category/") || i.text !== "");
    const live = liveItems("ap", "essays").slice(-8);
    const links = [
      ...html.matchAll(/<div class="cc-query-item cc-masonry-item"><a([^>]*)>([^<]*)<\/a>/g),
    ];
    const names = links.map((m) => decodeEntities(m[2]!));
    expect(names).toEqual(live.map((i) => i.text));
    // each is linked to its category (`{taxonomyqueryurl}`, the address of the loop's term), as the live page's are
    expect(links.map((m) => /href="([^"]*)"/.exec(m[1]!)?.[1])).toEqual(
      live.map((i) => sitePath(i.href, site)),
    );
    expect(got.length).toBeGreaterThanOrEqual(8);
    expect(shipsJs(html)).toBe(false);
  });

  test("an empty computed list is empty and ships nothing; an empty mapped array is the measured exception, a client render of its one element", async () => {
    const { files } = await entryProject("fineline", ["project"]);
    const all = entryPosts(await makeCtx("fineline", { kind: "post", id: 195 }), "project").map(
      (p) => p.id,
    );
    const emptyPage = async (attrs: Record<string, unknown>): Promise<string> => {
      const ctx = await fresh("fineline", { kind: "post", id: 195 });
      const q = {
        ...queryBlock({ queryPostType: pick("project"), queryPerPage: st("3"), ...attrs }, [
          templateBlock(),
        ]),
        innerHTML: queryHtml,
      };
      const nodes = convertBlocks([q], ctx);
      const page = {
        title: "t",
        state: Object.fromEntries(collectedState(ctx)),
        children: [
          { tagName: "p", textContent: "before" },
          ...nodes,
          { tagName: "p", textContent: "after" },
        ],
      };
      const built = await buildJxProject(
        { ...files, "pages/index.json": page },
        { name: "empty-list" },
      );
      return built.html("/");
    };
    // computed children: commercial-projects has no posts
    const computed = await emptyPage({
      queryTaxonomy: [taxEntry({ taxonomy: "project_tag", terms: pick(34) })],
    });
    expect(computed).toContain("<p>before</p>");
    expect(computed).toContain("<p>after</p>");
    expect(itemsOf(computed)).toEqual([]);
    expect(computed).toMatch(/<div class="querytemplate-test"[^>]*><\/div>/);
    expect(shipsJs(computed)).toBe(false);
    expect(computed).not.toContain("data-bind");
    // a mapped array over a collection that has nothing: its parent (the template's element only) is rendered by the client
    const mapped = await emptyPage({ queryExclude: pick(...all) });
    expect(mapped).toContain("<p>before</p>");
    expect(mapped).toContain("<p>after</p>");
    expect(itemsOf(mapped)).toEqual([]);
    expect(mapped).toMatch(/<div class="querytemplate-test"[^>]*data-bind/);
    expect(shipsJs(mapped)).toBe(true);
  });
});

describe("a native list with rules, built and validated", () => {
  test("fineline services without the three the template leaves out: a collection with `url` rules, the entries the model lists, and the project validates", async () => {
    const site = await loadSite("fineline");
    const { files, ctx } = await entryProject("fineline", ["service"]);
    const c = await fresh("fineline", { kind: "post", id: 195 }, { target: "page" });
    const q = {
      ...queryBlock(
        {
          queryPostType: pick("service"),
          queryPerPage: st("25"),
          queryExclude: pick(5282, 5280, 5307),
        },
        [templateBlock()],
      ),
      innerHTML: queryHtml,
    };
    const nodes = convertBlocks([q], c);
    expect(elementsWhere(nodes, isArray)).toHaveLength(1); // rules a collection can say: a mapped array over it
    expect([...collectedState(c).values()][0]).toMatchObject({
      filter: [{ field: "url", op: "!=" }, { field: "url" }, { field: "url" }],
    });
    files["pages/index.json"] = {
      title: "t",
      state: Object.fromEntries(collectedState(c)),
      children: nodes,
    } as ProjectFile;
    const built = await buildJxProject(files, { name: "native-rules" });
    const html = built.html("/");
    const want = entryPosts(ctx, "service")
      .filter((p) => ![5282, 5280, 5307].includes(p.id))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    expect(itemsOf(html).map((i) => i.text)).toEqual(
      want.map((p) => postData(ctx, p).title as string),
    );
    expect(shipsJs(html)).toBe(false);
    expect((await validateJxProject(built.dir)).problems).toEqual([]);
    void site;
  });
});

describe("computed children are the same page as the mapped array they replace", () => {
  /** The nodes with every mapped array over a pointer replaced by the computed children that list the same entries. */
  function inlined(nodes: readonly JxNode[], source: ListSource): JxNode[] {
    const swap = (node: JxNode): JxNode => {
      if (typeof node === "string") return node;
      const next: Record<string, unknown> = { ...node };
      if (Array.isArray(node.children)) {
        next.children = node.children.flatMap((child): JxNode[] =>
          typeof child !== "string" && isArray(child)
            ? loopChildren(source, swap(child.map as JxElement) as JxElement)
            : [swap(child)],
        );
      }
      return next as JxElement;
    };
    return nodes.map(swap);
  }

  /** What the page shows: the body, and every rule the build wrote, whitespace collapsed. */
  const shown = (built: BuiltProject, route: string): { body: string; css: string } => {
    const html = built.html(route);
    return {
      body: html.slice(html.indexOf("<body"), html.indexOf("</body>")).replaceAll(/\s+/g, " "),
      css: [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1]!.replaceAll(/\s+/g, " "))
        .join(""),
    };
  };

  for (const [name, siteName, subject, types] of [
    [
      "fineline home: the real item (a link with an image and a heading, each with its own style and binding)",
      "fineline",
      { kind: "post", id: 5246 },
      ["project"],
    ],
    [
      "anabaptistperspectives posts page: the real item (a reusable block, an icon, a component instance)",
      "ap",
      { kind: "template", slug: "index" },
      ["post"],
    ],
  ] as const) {
    test(name, async () => {
      const site = await loadSite(siteName);
      const out = await convertSubject(site, subject);
      const { files } = await entryProject(siteName, [...types]);
      const c = await fresh(siteName, subject, {
        mode: subject.kind === "template" ? "static" : undefined,
      } as Partial<ConvertCtx>);
      const plan = postPlan(queriesOf(site, subject)[0]!, c);
      expect(elementsWhere(out.nodes, isArray)).toHaveLength(1); // the page's one list is a mapped array over a collection
      const inline = registerPostList(c, plan, "x", { inline: true });
      expect("expr" in inline).toBe(true);
      const children = (n: readonly JxNode[]): JxNode[] =>
        replacePlaceholders(n, { "*": () => null });
      files["pages/a.json"] = {
        title: "t",
        state: out.state,
        children: children(out.nodes),
      } as ProjectFile;
      files["pages/b.json"] = {
        title: "t",
        state: { ...out.state, ...Object.fromEntries(collectedState(c)) },
        children: children(inlined(out.nodes, inline)),
      } as ProjectFile;
      const built = await buildJxProject(files, { name: "differential" });
      const a = shown(built, "/a/");
      const b = shown(built, "/b/");
      expect(a.body).toContain("cc-query-item");
      expect(b.body).toBe(a.body);
      expect(b.css).toBe(a.css);
      expect(shipsJs(built.html("/b/"))).toBe(false);
      // the mapped array is gone from the second page's source: it is one computed string
      expect(JSON.stringify(files["pages/b.json"])).not.toContain('"$prototype":"Array"');
      expect(itemsOf(built.html("/b/")).length).toBeGreaterThan(5);
    });
  }
});

describe("component instances built with their components", () => {
  test("fineline: the cards the live page printed, their rule written once, and the project validates", async () => {
    const site = await loadSite("fineline");
    const files: Record<string, ProjectFile> = {
      "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
    };
    const elements: { $ref: string }[] = [];
    // each component as its own converter makes it, with the defaults of its properties as state
    for (const [ref, info] of site.components) {
      const converted = await convertSubject(site, { kind: "component", ref });
      const state = Object.fromEntries(
        info.props.map((p) => [
          p.key,
          p.type === "icon" ? "" : p.type === "link" || p.type === "image" ? {} : (p.default ?? ""),
        ]),
      );
      files[`components/${info.tagName}.json`] = {
        tagName: info.tagName,
        state,
        children: replacePlaceholders(converted.nodes, { "*": () => null }),
      };
      elements.push({ $ref: `../components/${info.tagName}.json` });
    }
    // the instances of the live page 1078, and one page with image cards
    const hoisted: { selector: string; style: Record<string, unknown> }[] = [];
    const instancesOf = async (subject: Subject): Promise<JxNode[]> => {
      const out = await convertSubject(site, subject, { target: "page" });
      hoisted.push(...out.hoisted);
      return [...walkElements(out.nodes)].filter(
        (e) =>
          typeof e.tagName === "string" && e.tagName.startsWith("wp-") && e.$props !== undefined,
      );
    };
    const cards = await instancesOf({ kind: "post", id: 1078 });
    const imageCards = await instancesOf({ kind: "post", id: 1377 });
    expect(cards.filter((e) => (e as JxElement).tagName === "wp-icon-card")).toHaveLength(3);
    files["pages/index.json"] = {
      title: "cards",
      $elements: elements,
      children: [...cards, ...imageCards].map((c) => JSON.parse(JSON.stringify(c)) as JxNode),
    };
    files["project.json"] = {
      name: "components",
      url: "https://example.com",
      $media: site.options.media,
      defaults: { layout: "./layouts/base.json" },
      // the tag's rule, once, as the assembler writes it
      style: Object.fromEntries(
        new Map(
          hoisted.filter((r) => r.selector.startsWith("wp-")).map((r) => [r.selector, r.style]),
        ),
      ),
    } as ProjectFile;
    const built = await buildJxProject(files, { name: "components" });
    const html = built.html("/");
    const text = (s: string): string =>
      decodeEntities(s.replaceAll(/<[^>]*>/g, ""))
        .replaceAll(/\s+/g, " ")
        .trim();
    const cardHtml = [...html.matchAll(/<wp-icon-card[^>]*>([\s\S]*?)<\/wp-icon-card>/g)].map(
      (m) => m[1]!,
    );
    expect(cardHtml).toHaveLength(6);
    // what the live page prints for the first three (https://finelinepainting.pro/project/log-cabin-staining-in-fredericksburg-pa/)
    const liveCards: [string, string][] = [
      [
        "Beauty",
        "Choose from a range of colors and finishes to customize your cabin’s look. Staining enhances its beauty, making it blend seamlessly with nature’s allure and increasing property value.",
      ],
      [
        "Protection",
        "Staining your cabin shields it from moisture, UV rays, and changes in temperature, preventing issues like warping and fading. This keeps your cabin sturdy and visually appealing over time.",
      ],
      [
        "Maintenance",
        "Regular staining extends the lifespan of your wood, reducing the need for expensive repairs or replacements. It’s a smart investment that saves money while keeping your cabin in top shape.",
      ],
    ];
    liveCards.forEach(([heading, paragraph], i) => {
      expect(text(/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(cardHtml[i]!)![1]!)).toBe(heading);
      expect(text(/<p[^>]*>([\s\S]*?)<\/p>/.exec(cardHtml[i]!)![1]!)).toBe(paragraph);
    });
    // the host is the variant's class and the one rule, and no `${` or unreplaced marker is left
    expect(html).toMatch(/<wp-icon-card class="cs-bmuh8n"/);
    const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1]!.replaceAll(/\s+/g, " "))
      .join("");
    expect([...css.matchAll(/wp-icon-card \{ display: contents \}/g)]).toHaveLength(1);
    expect([...css.matchAll(/wp-image-card \{ display: contents \}/g)]).toHaveLength(1);
    expect(html).not.toContain("${");
    expect(html).not.toMatch(/<wp2jx-/);
    // image cards: the image is the plan's file with the alt text of its attachment
    const imageHtml = [...html.matchAll(/<wp-image-card[^>]*>([\s\S]*?)<\/wp-image-card>/g)].map(
      (m) => m[1]!,
    );
    expect(imageHtml.length).toBeGreaterThan(0);
    for (const card of imageHtml) expect(card).toMatch(/<img [^>]*src="\/media\//);
    const validation = await validateJxProject(built.dir);
    expect(validation.problems).toEqual([]);
  });
});

describe("through the collections emitter", () => {
  test("posts with queries and components become Markdown entries that read back unchanged, with the lists written out", async () => {
    const site = await loadSite("fineline");
    const ids = new Set([1078, 3371, 1382]);
    const out = await buildCollections(site, { include: (p) => ids.has(p.id) });
    const entries = out.report.entries();
    expect(entries.filter((e) => e.severity === "error")).toEqual([]);
    // nothing the serializer could not write back (`md.lossy` is a tree that came back different).
    // `md.item-paragraphs` is a styling advisory about the reader's paragraphs, not a loss.
    expect(
      entries.filter(
        (e) =>
          e.code.startsWith("md.") &&
          !["md.normalized", "md.colon-escaped", "md.item-paragraphs"].includes(e.code),
      ),
    ).toEqual([]);
    const statics = entries.filter((e) => e.code === "query.static");
    expect(
      Object.fromEntries(statics.map((e) => [e.where, (e.data as { entries: number }).entries])),
    ).toEqual({
      "post:1078": 4,
      "post:3371": 4,
      "post:1382": 2,
    });
    const ctx = await makeCtx("fineline", { kind: "post", id: 1078 });
    for (const [id, expected] of [
      [1078, 4],
      [3371, 4],
      [1382, 2],
    ] as const) {
      const post = site.model.posts.get(id)!;
      const file = out.files.find((f) => f.path.endsWith(`/${post.slug}.md`))!;
      const posts = evaluatePosts(ctx, postPlan(queriesOf(site, { kind: "post", id })[0]!, ctx))!;
      expect(posts).toHaveLength(expected);
      // the links of the items, in the plan's order
      const hrefs = [
        ...file.content.matchAll(/:::a\{className="div-[^"]*"[^}]*href="([^"]*)"/g),
      ].map((m) => m[1]!);
      const wanted = posts.map((p) => ctx.urlFor("post", p.id)!);
      expect(hrefs.filter((h) => wanted.includes(h)).slice(0, expected)).toEqual(wanted);
    }
    // the three cards of post 1078 are directives on the component's tag, with their properties
    const file = out.files.find((f) =>
      f.path.endsWith("log-cabin-staining-in-fredericksburg-pa.md"),
    )!;
    expect([...file.content.matchAll(/^::wp-icon-card\{/gm)]).toHaveLength(3);
    expect(file.content).toContain('props.heading="Beauty"');
    expect(file.content).toContain(".cs-bmuh8n");
    expect(out.used.components.has("wp-icon-card")).toBe(true);
    // the tag's own rule is the project's, not each instance's
    expect(out.used.hoisted.filter((r) => r.selector === "wp-icon-card")).toEqual([
      { selector: "wp-icon-card", style: { display: "contents" } },
    ]);
  });
});

describe("a taxonomy archive built with its terms list", () => {
  test("fineline taxonomy-project_type: the other terms, linked, and the page's own left out; no JavaScript", async () => {
    const site = await loadSite("fineline");
    const out = await convertSubject(site, { kind: "template", slug: "taxonomy-project_type" });
    const { files, ctx } = await entryProject("fineline", ["project"]);
    const terms = ["staining", "agricultural"];
    for (const slug of terms) {
      files[`pages/pt-${slug}.json`] = pageOf(out, {
        state: {
          term: {
            $prototype: "Function",
            body: `return ${JSON.stringify({ data: { slug, taxonomy: "project_type" } })};`,
            timing: "compiler",
          },
        },
      }) as ProjectFile;
    }
    const built = await buildJxProject(files, { name: "taxonomy-project-type" });
    const all = [...ctx.model.terms.values()].filter((t) => t.taxonomy === "project_type");
    for (const slug of terms) {
      const html = built.html(`/pt-${slug}/`);
      const root =
        /<div[^>]*class="taxonomyterms-[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/.exec(
          html,
        )?.[1] ?? "";
      const links = [...root.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
        href: m[1]!,
        text: decodeEntities(m[2]!.replaceAll(/<[^>]*>/g, "")).trim(),
      }));
      // Farmhouse has no project: `taxtermsHideEmpty` is true by default, and the live archive prints eight buttons
      const want = all
        .filter((t) => t.slug !== slug && t.count > 0)
        .map((t) => ({ href: ctx.urlFor("term", t.termId)!, text: decodeEntities(t.name) }))
        .sort((a, b) => a.text.localeCompare(b.text, "en", { sensitivity: "base" }));
      expect(links).toEqual(want);
      expect(links).toHaveLength(8);
      expect(shipsJs(html)).toBe(false);
    }
  });
});

describe("what the plan reads from the current entry and from component properties", () => {
  let fl: LoadedSite;
  let malvern: WpPost;
  const term = (taxonomy: string, group: string, field = ""): Record<string, unknown> =>
    taxEntry({ taxonomy, terms: dyn(group, field) });

  test("setup", async () => {
    fl = await loadSite("fineline");
    const ctx = await makeCtx("fineline", { kind: "post", id: 195 });
    malvern = entryPosts(ctx, "project").find((p) => p.slug === "house-painting-in-malvern-pa")!;
    expect(termsOf(fl.model, malvern.id, "project_type")).toHaveLength(2);
  });

  test("`postterms` is ALL of the current post's terms in the taxonomy, where a `<taxonomy>_id` shortcode is its first", async () => {
    const page = await makeCtx("fineline", { kind: "post", id: malvern.id });
    const names = termsOf(fl.model, malvern.id, "project_type")
      .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }))
      .map((t) => t.slug);
    const run = (entry: Record<string, unknown>, operator = ""): WpPost[] =>
      evaluatePosts(
        page,
        postPlan(
          queryBlock({
            queryPostType: pick("project"),
            queryPerPage: st("9999"),
            queryTaxonomy: [{ ...entry, operator: st(operator) }],
          }),
          page,
        ),
      )!;
    const all = run(term("project_type", "postterms"));
    expect(new Set(all.map((p) => p.id))).toEqual(
      new Set(postsWith(page, "project", "project_type", names).map((p) => p.id)),
    );
    const first = run(term("project_type", "shortcode", "project_type_id"));
    expect(new Set(first.map((p) => p.id))).toEqual(
      new Set(postsWith(page, "project", "project_type", [names[0]!]).map((p) => p.id)),
    );
    expect(first.length).toBeLessThan(all.length);
    // AND is every one of the page's terms, NOT IN none of them
    const both = run(term("project_type", "postterms"), "AND");
    expect(new Set(both.map((p) => p.id))).toEqual(
      new Set(postsWith(page, "project", "project_type", names, "all").map((p) => p.id)),
    );
    expect(both.length).toBeLessThan(all.length);
    const none = run(term("project_type", "postterms"), "NOT IN");
    expect(new Set(none.map((p) => p.id))).toEqual(
      new Set(postsWith(page, "project", "project_type", names, "none").map((p) => p.id)),
    );
  });

  test("in an entry template `postterms` reads `state.entry` when the list is built; with no current entry it is left out, and said", async () => {
    const entry = await makeCtx(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry" },
    );
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryTaxonomy: [term("project_type", "postterms")],
      }),
      entry,
    );
    expect(plan.conds[0]).toMatchObject({ dynamic: true });
    expect(plan.conds[0]!.js).toContain("state.entry.data.terms?.['project_type'] ?? []");
    const part = await makeCtx("fineline", { kind: "part", slug: "footer" });
    const lost = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryTaxonomy: [term("project_type", "postterms")],
      }),
      part,
    );
    expect(lost.conds).toEqual([]);
    expect(lost.dropped.join(" ")).toContain("current post");
  });

  test("a taxonomy the archive names is read from `state.term`, children and all", async () => {
    const archive = await templateCtx("fineline", "taxonomy-location");
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryTaxonomy: [
          taxEntry({ taxonomy: dyn("shortcode", "taxonomy"), terms: dyn("shortcode", "term_id") }),
        ],
      }),
      archive,
    );
    expect(plan.conds[0]!.js).toContain("has(e, state.term.data.taxonomy,");
    const noArchive = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryTaxonomy: [taxEntry({ taxonomy: dyn("shortcode", "taxonomy"), terms: pick(55) })],
      }),
      await makeCtx("fineline", { kind: "post", id: 195 }),
    );
    expect(noArchive.conds).toEqual([]);
    expect(noArchive.dropped.join(" ")).toContain("taxonomy read from");
  });

  test("what a component property chooses, a source this tool has no reading of, or terms that are the taxonomy itself, is left out and said", async () => {
    const ctx = await makeCtx("fineline", { kind: "post", id: 195 });
    const dropped = (entry: Record<string, unknown>): string => {
      const plan = postPlan(
        queryBlock({ queryPostType: pick("project"), queryTaxonomy: [entry] }),
        ctx,
      );
      expect(plan.conds).toEqual([]);
      return plan.dropped.join(" ");
    };
    expect(dropped(taxEntry({ taxonomy: st("!ref=abc!"), terms: pick(1) }))).toContain(
      "component property",
    );
    expect(dropped(taxEntry({ taxonomy: "project_type", terms: st("!ref=abc!") }))).toContain(
      "component property",
    );
    expect(dropped(term("project_type", "somethingelse", "x"))).toContain("somethingelse");
    expect(dropped(term("project_type", "shortcode", "taxonomy"))).toContain(
      "taxonomy of the archive",
    );
  });

  test("a group of meta comparisons has its own relation", async () => {
    const ap = await makeCtx("ap", { kind: "post", id: 819 });
    const meta = (key: string, compare: string, value: string): Record<string, unknown> => ({
      multiple: false,
      key: st(key),
      value: st(value),
      compare: st(compare),
      type: st(""),
      relation: "AND",
      meta_query: [],
    });
    const group = {
      multiple: true,
      relation: "OR",
      meta_query: [meta("premium", "=", "1"), meta("id", "REGEXP", "^P")],
    };
    const plan = postPlan(queryBlock({ queryPostType: pick("episode"), queryMeta: [group] }), ap);
    const fn = compileConditions(plan.conds);
    expect(fn({ id: "x", data: { premium: true, id: "12" } })).toBe(true);
    expect(fn({ id: "x", data: { premium: false, id: "P94" } })).toBe(true);
    expect(fn({ id: "x", data: { premium: false, id: "12" } })).toBe(false);
  });

  test("a component property can be an image by address: a media URL is moved to the plan's file", async () => {
    const ctx = await makeCtx("fineline", { kind: "post", id: 195 });
    const upload = [...ctx.model.attachments.values()].find(
      (a) => ctx.mediaForUrl(a.url) !== undefined,
    )!;
    const media = ctx.mediaForUrl(upload.url)!;
    const b = block("cwicly/component", {
      ref: "r",
      properties: { p1: { value: { image: { imageURL: upload.url } } } },
    });
    const out = instanceProps(ctx, b, {
      postId: 1,
      props: [{ id: "p1", key: "img", type: "image" }],
    });
    expect(out.img).toMatchObject({ src: media.src });
    expect(String((out.img as { src: string }).src)).toMatch(/^\/media\//);
  });
});

describe("loops inside loops", () => {
  test("terms inside the items of a computed list: the inner loop is a nested map over the item's own terms, and the page lists what the model says", async () => {
    const site = await loadSite("fineline");
    const { files, ctx } = await entryProject("fineline", ["project"]);
    const own = block(
      "cwicly/taxonomyterms",
      {
        classID: "tt",
        id: "tt",
        taxtermsSource: "current",
        taxtermsInclude: [{ label: "Types", value: "project_type", taxonomy: true }],
      },
      [
        block(
          "cwicly/heading",
          {
            classID: "th",
            headingTag: "h4",
            dynamic: "taxonomyquery",
            dynamicWordPressType: "name",
          },
          [],
          '<h4 class="th">{taxterms=name}</h4>',
        ),
      ],
      '<div class="tt" id="tt"><ccdyn></ccdyn></div>',
    );
    const c = await fresh("fineline", { kind: "post", id: 195 }, { target: "page" });
    const q = {
      ...queryBlock(
        {
          queryPostType: pick("project"),
          queryPerPage: st("9999"),
          queryTaxonomy: [taxEntry({ taxonomy: "project_type", terms: pick(60, 56) })], // exterior and interior
        },
        [templateBlock([titleHeading(), own])],
      ),
      innerHTML: queryHtml,
    };
    const nodes = convertBlocks([q], c);
    // the page's list is computed, so the item's own loop (a mapped array over `$map/item/data/terms/...`) is compiled into it
    expect(elementsWhere(nodes, isArray)).toEqual([]);
    expect(inlineLoops(nodes)).toHaveLength(1);
    const text = String((inlineLoops(nodes)[0]!.children as string[])[0]);
    expect(text).toContain("...($i0?.data?.terms?.project_type ?? []).map(($i1, $x1) => (");
    expect(text).not.toContain("$map");
    files["pages/index.json"] = {
      title: "t",
      state: Object.fromEntries(collectedState(c)),
      children: nodes,
    } as ProjectFile;
    const built = await buildJxProject(files, { name: "nested-loops" });
    const html = built.html("/");
    expect(shipsJs(html)).toBe(false);
    const wanted = postsWith(ctx, "project", "project_type", [
      "exterior-painting",
      "interior-painting",
    ]);
    // every item is a project of the list, in order, with its own project types printed by name
    const items = [
      ...html.matchAll(
        /<div class="cc-query-item">([\s\S]*?)(?=<div class="cc-query-item">|<\/div><\/div><\/div>)/g,
      ),
    ].map((m) => m[1]!);
    expect(items).toHaveLength(wanted.length);
    items.forEach((item, i) => {
      const names = [...item.matchAll(/<h4[^>]*>([^<]*)<\/h4>/g)].map((m) => decodeEntities(m[1]!));
      const mine = termsOf(ctx.model, wanted[i]!.id, "project_type")
        .map((t) => decodeEntities(t.name))
        .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
      expect(names).toEqual(mine);
    });
    void site;
  });

  test("a loop whose list is not a pointer cannot be written inside a computed one, and says so", () => {
    const item = {
      tagName: "div",
      children: [{ $prototype: "Array", items: ["literal"], map: { tagName: "i" } }],
    } as unknown as JxElement;
    expect(() => loopChildren({ expr: "state.x" }, item)).toThrow("needs a pointer");
  });

  test("a binding written inside a computed list keeps the build's reading: bare for a typed value, joined for a mixed one, escapes undone for the literal parts", () => {
    const item = {
      tagName: "a",
      attributes: {
        href: "${$map.item.data.url || false}",
        "data-n": "n-${$map.index}-\\\\x",
        "data-both": "${$map.item.data.n}${$map.item.data.n}",
      },
      textContent: "${$map.item.data.title ?? ''} and \\`more\\` ${$map.item.data.n}",
      $props: {
        flag: "${!!$map.item.data.n}",
        nested: { a: ["${$map.item.data.n}", "static ${"] },
      },
    } as unknown as JxElement;
    const [out] = loopChildren({ expr: "state.items" }, item) as string[];
    const run = (entries: unknown[]): Record<string, unknown>[] =>
      new Function("state", `return ${out!.slice(2, -1)};`)({ items: entries }) as Record<
        string,
        unknown
      >[];
    const [first] = run([{ data: { url: "/a/", title: "A", n: 7 } }]);
    expect(first).toMatchObject({
      tagName: "a",
      // two numbers side by side are written next to each other, not added
      attributes: { href: "/a/", "data-n": "n-0-\\x", "data-both": "77" },
      textContent: "A and `more` 7",
      $props: { flag: true, nested: { a: [7, "static ${"] } },
    });
    // a false value stays false (so the attribute is left out), and an undefined binding prints as it does in a template
    const [second] = run([{ data: {} }]);
    expect((second!.attributes as Record<string, unknown>).href).toBe(false);
    expect(second!.textContent).toBe(" and `more` undefined");
  });
});

describe("what a computed list hides from the tree walkers", () => {
  const computedQuery = (inner: WpBlock[]): ReturnType<typeof convertQuery> =>
    convertQuery({ queryTaxonomy: [taxEntry({ taxonomy: "project_type", terms: pick(56, 60) })] }, [
      templateBlock(inner),
    ]);

  test("the class names and the tags written into a computed list are found by usesInComputedLists", async () => {
    const { nodes } = await computedQuery([
      titleHeading(),
      block("cwicly/div", { classID: "box" }, [], '<div class="box"></div>'),
    ]);
    const loops = inlineLoops(nodes);
    expect(loops).toHaveLength(1);
    const found = usesInComputedLists(nodes);
    expect(found.classes.has("cc-query-item")).toBe(true);
    // every class name the item tree holds is found, and a plain tree (no computed list) holds none
    const item = (loops[0]!.children as string[])[0]!;
    for (const m of item.matchAll(/'className': '([^']*)'/g)) {
      for (const name of m[1]!.split(" ").filter(Boolean))
        expect(found.classes.has(name)).toBe(true);
    }
    expect(usesInComputedLists([{ tagName: "div", className: "x", children: ["text"] }])).toEqual({
      classes: new Set(),
      tags: new Set(),
    });
    // a tag is found the same way
    const withTag = usesInComputedLists([
      {
        tagName: "div",
        children: loopChildren({ expr: "state.x" }, { tagName: "my-card", className: "a  b" }),
      },
    ]);
    expect([...withTag.tags]).toEqual(["my-card"]);
    expect([...withTag.classes].sort()).toEqual(["a", "b"]);
  });

  test("a placeholder inside a computed item stays an element no browser knows, and is reported where the list is", async () => {
    const { ctx } = await computedQuery([
      block("core/shortcode", {}, [], "[gallery]"),
      titleHeading(),
    ]);
    const said = ctx.report.entries().filter((e) => e.code === "loop.placeholder");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ severity: "error", data: { tags: ["wp2jx-shortcode"] } });
  });

  test("a list that is a mapped array, or an item without placeholders, says nothing", async () => {
    const mapped = await convertQuery({}, [
      templateBlock([block("core/shortcode", {}, [], "[x]")]),
    ]);
    expect(mapped.ctx.report.entries().some((e) => e.code === "loop.placeholder")).toBe(false);
    const plain = await computedQuery([titleHeading()]);
    expect(plain.ctx.report.entries().some((e) => e.code === "loop.placeholder")).toBe(false);
  });
});

describe("the edges of a loop", () => {
  test("a query in a Markdown entry that reads page state it does not have is an empty box, and said", async () => {
    const { nodes, ctx } = await convertQuery(
      {
        queryTaxonomy: [
          taxEntry({ taxonomy: "location", terms: dyn("currenttaxonomytermarchive") }),
        ],
      },
      undefined,
      { termExpr: "state.term" },
      { kind: "post", id: 1078 },
    );
    expect(elementsWhere(nodes, isArray)).toEqual([]);
    expect(ctx.report.entries().find((e) => e.code === "block.unsupported")).toMatchObject({
      data: { feature: "query" },
    });
  });

  test("a terms query that selects nothing says so", async () => {
    const { ctx } = await convertQuery({
      queryType: "terms",
      queryTaxonomies: pick("project_tag"),
      queryParent: st("99"),
      queryPostType: undefined,
    });
    expect(ctx.report.entries().find((e) => e.code === "query.empty")).toMatchObject({
      severity: "info",
    });
  });

  test("a taxonomyterms with no terms to list says so, and is still its own element", async () => {
    const ctx = await fresh("fineline", { kind: "post", id: 195 }, { target: "page" });
    const current = block(
      "cwicly/taxonomyterms",
      { classID: "tt", taxtermsSource: "current" },
      [titleHeading()],
      '<div class="tt"><ccdyn></ccdyn></div>',
    );
    const out = convertBlocks([current], ctx);
    expect(out).toHaveLength(1);
    expect(ctx.report.entries().find((e) => e.code === "query.empty")).toMatchObject({
      severity: "info",
    });
  });

  test("a repeater that is a sub field of a repeater reads the row's own", async () => {
    const real = await makeCtx("fineline", { kind: "template", slug: "single-project" }, {
      mode: "entry",
      rowExpr: "$map.item",
    } as Partial<ConvertCtx>);
    const field = (
      key: string,
      name: string,
      type: string,
      subFields: unknown[] = [],
    ): Record<string, unknown> => ({
      key,
      name,
      type,
      subFields,
      layouts: [],
      choices: [],
      settings: {},
      conditionalLogic: [],
    });
    const inner = field("f_inner", "inner", "repeater");
    const acf = {
      ...real.acf,
      groups: [
        {
          key: "g",
          active: true,
          location: [],
          fields: [field("f_outer", "outer", "repeater", [inner])],
        },
      ],
    };
    const ctx = {
      ...real,
      acf,
      report: createReport(),
      defineState: undefined,
    } as unknown as ConvertCtx;
    ctx.convert = (blocks, more) => convertBlocks(blocks, more ? withOverrides(ctx, more) : ctx);
    const b = block(
      "cwicly/repeater",
      { classID: "r", dynamic: "acf", dynamicACFField: "f_inner" },
      [titleHeading()],
      '<div class="r"><ccdyn></ccdyn></div>',
    );
    const [out] = convertBlocks([b], ctx);
    expect(((out as JxElement).children as JxElement[])[0]).toMatchObject({
      items: { $ref: "$map/item/inner" },
    });
  });
});

describe("terms of several taxonomies, and what an item of another post type may hold", () => {
  test("AND over terms named by their taxonomy id, from two taxonomies, is a project with every one", async () => {
    const ctx = await makeCtx("fineline", { kind: "post", id: 195 });
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryPerPage: st("9999"),
        // interior painting (a project type) and Pennsylvania (a location): a taxonomy id names a term of any taxonomy
        queryTaxonomy: [
          taxEntry({
            taxonomy: "project_type",
            terms: pick(56, 50),
            field: "term_taxonomy_id",
            operator: "AND",
            children: false,
          }),
        ],
      }),
      ctx,
    );
    const got = evaluatePosts(ctx, plan)!;
    const interior = new Set(
      postsWith(ctx, "project", "project_type", ["interior-painting"]).map((p) => p.id),
    );
    const pennsylvania = new Set(
      postsWith(ctx, "project", "location", ["pennsylvania"]).map((p) => p.id),
    );
    const both = [...interior].filter((id) => pennsylvania.has(id));
    expect(both).toHaveLength(14);
    expect(new Set(got.map((p) => p.id))).toEqual(new Set(both));
  });

  test("the items of a list inside a Markdown entry are written for Markdown", async () => {
    const targets: string[] = [];
    registerConverters({
      "x/target": (_b, c) => {
        targets.push(targetOf(c));
        return [];
      },
    });
    const { ctx } = await convertQuery(
      { queryPostType: pick("service"), queryPerPage: st("2") },
      [templateBlock([block("x/target")])],
      {},
      { kind: "post", id: 1078 },
    );
    expect(ctx.report.entries().some((e) => e.code === "query.static")).toBe(true);
    expect(targets).toEqual(["markdown", "markdown"]);
  });
});

describe("what the export holds that the entries do not", () => {
  test("a protected or unpublished post that still has a route is not an entry", async () => {
    const ctx = await makeCtx("fineline", { kind: "post", id: 195 });
    const [first, second] = entryPosts(ctx, "project");
    const posts = new Map(ctx.model.posts);
    posts.set(first!.id, { ...first!, passwordProtected: true });
    posts.set(second!.id, { ...second!, status: "draft" });
    const patched = { ...ctx, model: { ...ctx.model, posts } } as ConvertCtx;
    const ids = entryPosts(patched, "project").map((p) => p.id);
    expect(ids).toHaveLength(entryPosts(ctx, "project").length - 2);
    expect(ids).not.toContain(first!.id);
    expect(ids).not.toContain(second!.id);
  });

  test("children of a term are all its descendants: a term three levels down is under the top one", async () => {
    const ctx = await makeCtx("fineline", { kind: "post", id: 195 });
    const terms = new Map(ctx.model.terms);
    const base = terms.get(55)!; // lebanon-county-pa, a child of pennsylvania (50)
    terms.set(9999, {
      ...base,
      termId: 9999,
      taxonomyId: 9999,
      slug: "lebanon-city",
      name: "Lebanon City",
      parent: 55,
    });
    const project = entryPosts(ctx, "project").find(
      (p) => termsOf(ctx.model, p.id, "location").length === 0,
    )!;
    const termsByPost = new Map(ctx.model.termsByPost);
    termsByPost.set(project.id, [9999]);
    const patched = { ...ctx, model: { ...ctx.model, terms, termsByPost } } as ConvertCtx;
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryPerPage: st("9999"),
        queryTaxonomy: [taxEntry({ taxonomy: "location", terms: pick(50) })],
      }),
      patched,
    );
    expect(evaluatePosts(patched, plan)!.map((p) => p.id)).toContain(project.id);
    // and the archive's own children map holds the whole family
    const archive = await makeCtx(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      { mode: "entry" },
    );
    const withKid = { ...archive, model: { ...archive.model, terms, termsByPost } } as ConvertCtx;
    const dynamic = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryTaxonomy: [
          taxEntry({
            taxonomy: "location",
            field: "term_id",
            terms: dyn("currenttaxonomytermarchive"),
          }),
        ],
      }),
      withKid,
    );
    expect(dynamic.conds[0]!.js).toContain("lebanon-city");
    const keep = new Function(
      "e",
      "state",
      `const has = (e, t, s) => (e.data.terms?.[t] ?? []).some((x) => s.includes(x.slug)); return ${dynamic.conds[0]!.js};`,
    );
    expect(
      keep(entryOf(withKid, project), {
        term: { data: { slug: "pennsylvania", taxonomy: "location" } },
      }),
    ).toBe(true);
  });

  test("a term loop has no archive term to read: `$map.item` is a reference with no `data`", async () => {
    const ctx = await makeCtx("fineline", { kind: "template", slug: "taxonomy-location" }, {
      mode: "entry",
      termExpr: "$map.item",
    } as Partial<ConvertCtx>);
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("project"),
        queryTaxonomy: [
          taxEntry({ taxonomy: "location", terms: dyn("currenttaxonomytermarchive") }),
        ],
      }),
      ctx,
    );
    expect(plan.conds).toEqual([]);
    expect(plan.dropped.join(" ")).toContain("archive");
  });

  test("queries of users, comments and products say what they are, and why they are not lists", async () => {
    const ctx = await makeCtx("fineline", { kind: "post", id: 195 });
    const why = (queryType: string): string => {
      const { plan } = planOf(queryBlock({ queryType }), ctx);
      return plan.kind === "unsupported" ? plan.why : "";
    };
    expect(why("comments")).toContain("no comments");
    expect(why("products")).toContain("no shop");
    expect(why("galaxies")).toContain("not a query type");
  });
});

// ── What the plugin and WordPress do ──────────────────────────────────────────────────────────────
//
// Block.json's defaults (an attribute Gutenberg leaves out is its default), the semantics of `WP_Query`
// and `WP_Term_Query`, and what the plugin passes to them. Where a number is quoted the oracle is the
// real plugin (WordPress 7.1 booted over the full databases, `Cwicly\Query::front_args` and
// `WP_Query`); everywhere else it is the model, read without the module.

describe("a query that never wrote queryInherit inherits (block.json's default is true)", () => {
  /** The posts a built query loop lists for one term, evaluated the way the build does. */
  async function listFor(
    slug: string,
    term: { slug: string; taxonomy: string },
  ): Promise<{ ids: string[]; ctx: ConvertCtx; out: Converted }> {
    const site = await loadSite("fineline");
    const out = await convertSubject(site, { kind: "template", slug });
    const ctx = await makeCtx("fineline", { kind: "post", id: 195 });
    const loop = inlineLoops(out.nodes).find((e) =>
      (e.children as string[])[0]!.includes("'cc-query-item'"),
    )!;
    const expr = inlineList((loop.children as string[])[0]!);
    const list = resolveSource(ctx, out.state, { expr }, { term: { data: term } });
    return { ids: list.map((e) => e.id), ctx, out };
  }

  for (const [slug, taxonomy, term] of [
    ["taxonomy-project_type", "project_type", "kitchen-cabinets"],
    ["taxonomy-project_tag", "project_tag", "exterior-projects"],
  ] as const) {
    test(`fineline ${slug}: the projects of ${term}, not every project (the real archive printed 6 and 3 items)`, async () => {
      const { ids, ctx, out } = await listFor(slug, { slug: term, taxonomy });
      const want = postsWith(ctx, "project", taxonomy, [term]);
      expect(want.length).toBeGreaterThan(2);
      expect(want.length).toBeLessThan(15);
      expect(ids).toEqual(want.map((p) => ctx.urlFor("post", p.id)!));
      // the archive's term is read when the list is built, and the list is not the unfiltered collection
      expect(Object.keys(out.state).some((k) => k.startsWith("project_q"))).toBe(false);
      // another term of the same archive gives its own list
      const other = await listFor(slug, {
        slug: taxonomy === "project_type" ? "staining" : "residential-projects",
        taxonomy,
      });
      expect(other.ids).not.toEqual(ids);
      expect(other.ids.length).toBeGreaterThan(0);
    });
  }

  test("an inheriting query is the main query: its page size and order win, and its own inclusions, exclusions and search are overwritten", async () => {
    const archive = await templateCtx("fineline", "taxonomy-project_type");
    const own = {
      queryPostType: pick("project"),
      queryPerPage: st("3"),
      queryOrder: st("ASC"),
      queryExclude: pick(5282),
      querySearch: st("zzzzqq"),
    };
    const inherited = postPlan(queryBlock({ ...own, queryInherit: undefined }), archive);
    const site = Number(archive.model.options.get("posts_per_page"));
    // what `wp_parse_args($wp_query->query_vars, $args)` left: 10 per page, descending, no search, no exclusion (the archive's term only)
    expect(inherited.perPage).toBe(site);
    expect(inherited.sort).toEqual([{ field: "date", order: "desc" }]);
    expect(inherited.conds).toHaveLength(1);
    expect(inherited.conds[0]!.js).toContain("state.term.data.slug");
    expect(inherited.types).toEqual(["project"]);
    // the same block with an explicit false keeps all of it
    const alone = postPlan(queryBlock({ ...own, queryInherit: false }), archive);
    expect(alone.perPage).toBe(3);
    expect(alone.sort).toEqual([{ field: "date", order: "asc" }]);
    expect(alone.conds.length).toBeGreaterThanOrEqual(2);
  });

  test("the main query of a single is that one post", async () => {
    const fl = await makeCtx("fineline", { kind: "post", id: 195 });
    const project = entryPosts(fl, "project")[3]!;
    const ctx = await makeCtx("fineline", { kind: "post", id: project.id });
    const plan = postPlan(
      queryBlock({ queryInherit: undefined, queryPostType: pick("service") }),
      ctx,
    );
    expect(plan.types).toEqual(["project"]);
    expect(urlsOfPosts(ctx, evaluatePosts(ctx, plan)!)).toEqual([ctx.urlFor("post", project.id)!]);
    // in an entry template it reads the entry
    const single = await makeCtx("fineline", { kind: "template", slug: "single-project" }, {
      mode: "entry",
      entryType: "project",
    } as Partial<ConvertCtx>);
    const live = postPlan(queryBlock({ queryInherit: undefined }), single);
    expect(live.conds[0]!.js).toBe("e.data.url === state.entry.data.url");
  });

  test("a part, which is no page of any type, takes the block's own post type", async () => {
    const part = await makeCtx("fineline", { kind: "part", slug: "footer" });
    const plan = postPlan(
      queryBlock({ queryInherit: undefined, queryPostType: pick("service") }),
      part,
    );
    expect(plan.types).toEqual(["service"]);
    expect(plan.conds).toEqual([]);
  });
});

describe("the plan of a posts query: the plugin's and WordPress's own rules", () => {
  let fl: ConvertCtx;
  let ap: ConvertCtx;
  const run = (c: ConvertCtx, attrs: Record<string, unknown>): WpPost[] =>
    evaluatePosts(
      c,
      postPlan(queryBlock({ queryPerPage: st("9999"), queryOrderBy: st("date"), ...attrs }), c),
    )!;

  test("setup", async () => {
    fl = await makeCtx("fineline", { kind: "post", id: 195 });
    ap = await makeCtx("ap", { kind: "post", id: 819 });
  });

  test("post__in wins over post__not_in: an exclusion beside a list of posts is ignored (4 included, 1 of them excluded: 4)", () => {
    const some = entryPosts(fl, "project")
      .slice(0, 4)
      .map((p) => p.id);
    const got = run(fl, {
      queryPostType: pick("project"),
      queryInclude: pick(...some),
      queryExclude: pick(some[0]!),
    });
    expect(new Set(got.map((p) => p.id))).toEqual(new Set(some));
    // and with no list of posts the exclusion is applied
    expect(run(fl, { queryPostType: pick("project"), queryExclude: pick(some[0]!) })).toHaveLength(
      81,
    );
    // so is "exclude the current post"
    const noCurrent = run(fl, {
      queryPostType: pick("project"),
      queryInclude: pick(...some),
      queryExcludeCurrent: true,
    });
    expect(noCurrent).toHaveLength(4);
  });

  test("a tax clause that names no term is no clause, EXISTS and NOT EXISTS included (the plugin's XXX)", () => {
    const clause = (operator: string, terms: Record<string, unknown>): Record<string, unknown> =>
      taxEntry({ taxonomy: "project_type", terms, operator });
    for (const operator of ["EXISTS", "NOT EXISTS", "IN", "NOT IN", "AND"]) {
      expect(
        run(fl, { queryPostType: pick("project"), queryTaxonomy: [clause(operator, pick())] }),
      ).toHaveLength(82);
    }
    expect(
      run(fl, { queryPostType: pick("project"), queryTaxonomy: [clause("EXISTS", pick(124))] }),
    ).toHaveLength(76);
  });

  test("a typed value is one value: a comma is part of a term's name and of a LIKE or REGEXP, and splits only a list", () => {
    const series = "Scripture, Culture, and Church Planting";
    const pool = ["post", "episode"];
    const slug = "scripture-culture-and-church-planting";
    const want = pool.flatMap((t) => postsWith(ap, t, "series", [slug]));
    expect(want.length).toBeGreaterThan(0);
    const got = run(ap, {
      queryPostType: pick(...pool),
      queryTaxonomy: [taxEntry({ taxonomy: "series", field: "name", terms: pick(series) })],
    });
    expect(new Set(got.map((p) => p.id))).toEqual(new Set(want.map((p) => p.id)));
    // typed as text, WordPress reads one term, and so does the module
    const typed = postPlan(
      queryBlock({
        queryPostType: pick("post"),
        queryTaxonomy: [taxEntry({ taxonomy: "series", field: "name", terms: st(series) })],
      }),
      ap,
    );
    expect(typed.conds[0]!.js).toContain(slug);
    // meta values: only the lists split (and by commas and spaces), `{1,3}` of a regular expression does not
    const episodes = entryPosts(ap, "episode");
    const stored = (p: WpPost): string => String(ap.model.postMeta.get(p.id)?.id?.[0] ?? "");
    const meta = (compare: string, value: string): Record<string, unknown> => ({
      multiple: false,
      key: st("id"),
      value: st(value),
      compare: st(compare),
      type: st(""),
      relation: "AND",
      meta_query: [],
    });
    const regexp = run(ap, {
      queryPostType: pick("episode"),
      queryMeta: [meta("REGEXP", "^[0-9]{1,3}$")],
    });
    const wantRegexp = episodes.filter((p) => /^[0-9]{1,3}$/.test(stored(p)));
    expect(wantRegexp.length).toBeGreaterThan(0);
    expect(new Set(regexp.map((p) => p.id))).toEqual(new Set(wantRegexp.map((p) => p.id)));
    const truth = (compare: string, value: string, data: Record<string, unknown>): boolean =>
      compileConditions(
        postPlan(
          queryBlock({ queryPostType: pick("episode"), queryMeta: [meta(compare, value)] }),
          ap,
        ).conds,
      )({ id: "x", data });
    expect(truth("=", "P1,P2", { id: "P1,P2" })).toBe(true);
    expect(truth("=", "P1,P2", { id: "P1" })).toBe(false);
    expect(truth("LIKE", "1,3", { id: "x1,3y" })).toBe(true);
    expect(truth("LIKE", "1,3", { id: "13" })).toBe(false);
    expect(truth("IN", "P1, P2 P3", { id: "P2" })).toBe(true);
    expect(truth("IN", "P1, P2 P3", { id: "P3" })).toBe(true);
    expect(truth("IN", "P1, P2 P3", { id: "P1, P2" })).toBe(false);
    expect(truth("NOT IN", "P1,P2", { id: "P3" })).toBe(true);
  });

  test("typed ids and types are lists, where WordPress or the plugin splits them", () => {
    const some = entryPosts(fl, "project")
      .slice(0, 3)
      .map((p) => p.id);
    expect(run(fl, { queryPostType: st("project,service") }).length).toBe(82 + 19);
    expect(
      run(fl, { queryPostType: pick("project"), queryInclude: st(some.join(",")) }),
    ).toHaveLength(3);
  });

  test("MySQL compares without regard to case: LIKE, REGEXP and = alike", () => {
    const meta = (compare: string, value: string): Record<string, unknown> => ({
      multiple: false,
      key: st("id"),
      value: st(value),
      compare: st(compare),
      type: st(""),
      relation: "AND",
      meta_query: [],
    });
    const truth = (compare: string, value: string, id: string): boolean =>
      compileConditions(
        postPlan(
          queryBlock({ queryPostType: pick("episode"), queryMeta: [meta(compare, value)] }),
          ap,
        ).conds,
      )({ id: "x", data: { id } });
    // sql: `like '%p1%'` and `like '%P1%'` count the same rows
    expect(truth("LIKE", "p1", "xP1y")).toBe(true);
    expect(truth("LIKE", "P1", "xp1y")).toBe(true);
    expect(truth("NOT LIKE", "p1", "P12")).toBe(false);
    expect(truth("REGEXP", "^p", "P1")).toBe(true);
    expect(truth("NOT REGEXP", "^p", "P1")).toBe(false);
    expect(truth("=", "p1", "P1")).toBe(true);
    expect(truth("!=", "p1", "P1")).toBe(false);
    expect(truth("IN", "p1,p2", "P2")).toBe(true);
    // a regular expression keeps its own letters: `\D` is not `\d`
    expect(truth("REGEXP", "^\\D", "P1")).toBe(true);
    expect(truth("REGEXP", "^\\D", "1P")).toBe(false);
  });

  test("a term named by the form WordPress stored (`Missions &amp; Evangelism`) is found, and so is the one the editor shows", () => {
    const stored = [...ap.model.terms.values()].find((t) => t.slug === "missions-evangelism")!;
    expect(stored.name).toBe("Missions &amp; Evangelism");
    for (const name of ["Missions &amp; Evangelism", "Missions & Evangelism"]) {
      const { plan, info } = planOf(
        queryBlock({
          queryPostType: pick("post"),
          queryTaxonomy: [taxEntry({ taxonomy: "category", field: "name", terms: pick(name) })],
        }),
        ap,
      );
      expect(info).toEqual([]);
      expect((plan as PostPlan).conds[0]!.js).toContain("missions-evangelism");
    }
  });

  test("a post status other than publish and sticky posts first are left out and said; the defaults are not", () => {
    const dropped = (attrs: Record<string, unknown>, c: ConvertCtx = fl): string[] =>
      postPlan(queryBlock({ queryPostType: pick("project"), ...attrs }), c).dropped;
    expect(dropped({ queryPostStatus: pick("publish") })).toEqual([]);
    expect(dropped({})).toEqual([]);
    expect(dropped({ queryPostStatus: pick("publish", "private") }).join(" ")).toContain("private");
    expect(dropped({ queryPostStatus: st("any") }).join(" ")).toContain("any");
    expect(dropped({ queryPostStatus: dyn("urlparameter", "status") }).join(" ")).toContain(
      "status",
    );
    // sticky posts matter only on a site that has some
    expect(dropped({ querySticky: true })).toEqual([]);
    const options = new Map(fl.model.options);
    options.set("sticky_posts", "a:1:{i:0;i:5282;}");
    const sticky = { ...fl, model: { ...fl.model, options } } as ConvertCtx;
    expect(dropped({ querySticky: true }, sticky).join(" ")).toContain("sticky");
    expect(dropped({ querySticky: false }, sticky)).toEqual([]);
  });

  test("a query over pages lists nothing: a page is a document, not a content entry, and the query says so", async () => {
    expect(entryPosts(fl, "page")).toEqual([]);
    const { plan, info } = planOf(queryBlock({ queryPostType: pick("page", "project") }), fl);
    expect((plan as PostPlan).types).toEqual(["project"]);
    expect(info).toMatchObject([{ code: "query.type-unrouted", detail: "page" }]);
    expect(info[0]!.message).toContain("document");
    const { state, ctx } = await convertQuery({ queryPostType: pick("page") });
    expect([...state.keys()]).toEqual([]);
    expect(ctx.report.entries().find((e) => e.code === "query.type-unrouted")).toMatchObject({
      data: { detail: expect.stringContaining("page") },
    });
  });

  test("a post type that starts with a digit gets an identifier for its state, in the list and in the length of it", async () => {
    // WordPress allows `3d-model`: `state.3d_model_entries` is a syntax error where it is read
    const posts = new Map(fl.model.posts);
    for (const p of entryPosts(fl, "project")) posts.set(p.id, { ...p, type: "3d-model" });
    const ctx = bare({ ...fl, model: { ...fl.model, posts } } as ConvertCtx);
    const plan = postPlan(
      queryBlock({
        queryPostType: pick("3d-model"),
        queryPerPage: st("4"),
        queryTaxonomy: [taxEntry({ taxonomy: "project_type", terms: pick(124) })],
      }),
      ctx,
    );
    const source = registerPostList(ctx, plan, "7");
    const state = Object.fromEntries(collectedState(ctx));
    expect(Object.keys(state)).toEqual(["t_3d_model_entries"]);
    const { expr } = source as { expr: string };
    expect(expr).toContain("state.t_3d_model_entries");
    expect(() => new Function("state", `return ${expr}`)).not.toThrow();
    expect(resolveSource(ctx, state, source)).toHaveLength(4);
    // a native list, whose key is read as `state.<key>.length` by a condition on its count
    const native = registerPostList(
      ctx,
      postPlan(queryBlock({ queryPostType: pick("3d-model") }), ctx),
      "9",
    );
    expect(native).toEqual({ pointer: "#/state/t_3d_model_q9" });
    expect(lengthOf(native)).toBe("state.t_3d_model_q9.length");
    expect(() => new Function("state", `return ${lengthOf(native)}`)).not.toThrow();
  });
});

describe("a terms query: hide_empty is true by default, and get=all turns it off", () => {
  let ap: LoadedSite;
  let ctx: ConvertCtx;
  /** The real tags block of anabaptistperspectives' welcome page: twenty tags by name, descending, `queryGet: all`. */
  let tags: WpBlock;
  const rows = (attrs: Record<string, unknown>): { slug: string; name: string }[] => {
    const { plan } = planOf({ ...tags, attrs: { ...tags.attrs, ...attrs } }, ctx);
    return termRows(ctx, plan as TermsPlan);
  };
  /** The first twenty names of terms, descending (what the block asks for), by the case-insensitive collation. */
  const first20 = (list: WpTerm[]): string[] =>
    list
      .map((t) => decodeEntities(t.name))
      .sort((a, b) => b.localeCompare(a, "en", { sensitivity: "base" }))
      .slice(0, 20);
  const names = (attrs: Record<string, unknown>): string[] => rows(attrs).map((r) => r.name);
  const postTags = (keep: (t: WpTerm) => boolean = () => true): WpTerm[] =>
    [...ctx.model.terms.values()].filter((t) => t.taxonomy === "post_tag" && keep(t));

  test("setup", async () => {
    ap = await loadSite("ap");
    ctx = await makeCtx("ap", { kind: "post", id: 819 });
    tags = queriesOf(ap, { kind: "post", id: 819 }).find((b) => b.attrs.queryType === "terms")!;
    expect(tags.attrs.queryGet).toMatchObject({ field: "all" });
    expect(tags.attrs.queryOrder).toMatchObject({ field: "DESC" });
  });

  test("the block as it stands (get: all) lists every tag, empty or not, as WP_Term_Query does", () => {
    expect(postTags().some((t) => t.count === 0)).toBe(true);
    expect(names({})).toEqual(first20(postTags()));
  });

  test("with queryGet left at its default the empty tags are hidden, and the page of twenty shifts (plugin args: hide_empty true)", () => {
    const want = first20(postTags((t) => t.count > 0));
    expect(names({ queryGet: undefined })).toEqual(want);
    expect(names({ queryGet: st("empty") })).toEqual(want);
    // an empty tag the page of twenty would otherwise hold
    const empty = postTags((t) => t.count === 0).map((t) => decodeEntities(t.name));
    const listed = names({});
    const hidden = empty.filter((n) => listed.includes(n));
    expect(hidden.length).toBeGreaterThan(0);
    for (const n of hidden) expect(names({ queryGet: undefined })).not.toContain(n);
    expect(names({ queryGet: undefined })).not.toEqual(listed);
  });

  test("queryHideEmpty is the switch it holds: false lists the empty terms, true hides them, and `get: all` overrides both", () => {
    const filled = first20(postTags((t) => t.count > 0));
    const everything = first20(postTags());
    const none = { queryGet: undefined };
    expect(names({ ...none, queryHideEmpty: false })).toEqual(everything);
    expect(names({ ...none, queryHideEmpty: true })).toEqual(filled);
    expect(names({ ...none, queryHideEmpty: undefined })).toEqual(filled);
    expect(names({ queryGet: st("all"), queryHideEmpty: true })).toEqual(everything);
    const plan = (attrs: Record<string, unknown>): TermsPlan =>
      planOf({ ...tags, attrs: { ...tags.attrs, ...attrs } }, ctx).plan as TermsPlan;
    expect(plan({ queryGet: undefined, queryHideEmpty: false }).hideEmpty).toBe(false);
    expect(plan({ queryGet: undefined, queryHideEmpty: "true" }).hideEmpty).toBe(true);
    expect(plan({ queryGet: undefined, queryHideEmpty: "" }).hideEmpty).toBe(false);
  });

  test("a hierarchical query keeps an empty term that has a descendant with entries, and `all` ignores childless and child_of", () => {
    // categories: make one empty parent of a filled child
    const cats = [...ctx.model.terms.values()].filter(
      (t) => t.taxonomy === "category" && t.count > 0,
    );
    const child = cats[0]!;
    const terms = new Map(ctx.model.terms);
    terms.set(9_001, {
      ...child,
      termId: 9_001,
      taxonomyId: 9_001,
      slug: "empty-parent",
      name: "Empty Parent",
      count: 0,
      parent: 0,
    });
    terms.set(child.termId, { ...child, parent: 9_001 });
    const patched = { ...ctx, model: { ...ctx.model, terms } } as ConvertCtx;
    const slugs = (attrs: Record<string, unknown>): string[] =>
      termRows(
        patched,
        planOf(
          queryBlock({ queryType: "terms", queryTaxonomies: pick("category"), ...attrs }),
          patched,
        ).plan as TermsPlan,
      ).map((r) => r.slug);
    expect(slugs({})).not.toContain("empty-parent"); // not hierarchical: the term is empty
    expect(slugs({ queryHierarchical: true })).toContain("empty-parent");
    expect(slugs({ queryHierarchical: true, queryGet: st("all") })).toContain("empty-parent");
    expect(slugs({ queryHierarchical: false, queryGet: st("all") })).toContain("empty-parent");
    const dropped = (attrs: Record<string, unknown>): string[] =>
      (
        planOf(
          queryBlock({ queryType: "terms", queryTaxonomies: pick("category"), ...attrs }),
          patched,
        ).plan as TermsPlan
      ).dropped;
    expect(dropped({ queryChildless: true })).toEqual(["queryChildless"]);
    expect(dropped({ queryChildless: true, queryGet: st("all") })).toEqual([]);
  });

  test("the typed list of taxonomies is split by commas, a picked one is not", () => {
    const plan = (queryTaxonomies: unknown): TermsPlan =>
      planOf(queryBlock({ queryType: "terms", queryTaxonomies }), ctx).plan as TermsPlan;
    expect(plan(st("season, series")).taxonomies).toEqual(["season", "series"]);
    expect(plan(pick("season", "series")).taxonomies).toEqual(["season", "series"]);
    expect(plan(st("")).taxonomies).toEqual(["category"]);
  });
});

describe("meta comparisons that need the stored rows are applied to the entry and said", () => {
  let ap: ConvertCtx;
  let episodes: WpPost[];
  const meta = (key: string, compare: string, value = "", extra: Record<string, unknown> = {}) => ({
    multiple: false,
    key: st(key),
    value: st(value, extra),
    compare: st(compare),
    type: st(""),
    relation: "AND",
    meta_query: [],
  });
  const plan = (queryMeta: unknown[], c: ConvertCtx = ap): ReturnType<typeof planOf> =>
    planOf(queryBlock({ queryPostType: pick("episode"), queryPerPage: st("9999"), queryMeta }), c);

  test("setup", async () => {
    ap = await makeCtx("ap", { kind: "post", id: 6708 });
    episodes = entryPosts(ap, "episode");
  });

  test("EXISTS, NOT EXISTS and every negative comparison are reported (query.approximated, warn); the positive ones are not", () => {
    for (const compare of ["EXISTS", "NOT EXISTS", "!=", "NOT LIKE", "NOT IN", "NOT REGEXP"]) {
      const { info } = plan([meta("premium", compare, "1")]);
      expect(info).toMatchObject([
        { code: "query.approximated", severity: "warn", detail: `meta ${compare} premium` },
      ]);
      expect(info[0]!.message).toContain("premium");
    }
    for (const compare of ["=", "LIKE", "IN", "REGEXP", ">"]) {
      expect(plan([meta("premium", compare, "1")]).info).toEqual([]);
    }
  });

  test("the conversion says it, once per comparison, in the report", async () => {
    const { ctx } = await convertQuery(
      {
        queryPostType: pick("episode"),
        queryMeta: [meta("premium", "!=", "true", { formatType: "boolean" })],
      },
      [templateBlock()],
      {},
      { kind: "post", id: 6708 },
      "ap",
    );
    const said = ctx.report.entries().filter((e) => e.code === "query.approximated");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ severity: "warn" });
  });

  test("the difference is real: an episode that never had a premium row is in the entry's list and not in WordPress's (INNER JOIN on the key)", () => {
    const queryMeta = [meta("premium", "!=", "true", { formatType: "boolean" })];
    const target = episodes[0]!;
    const rows = new Map(ap.model.postMeta);
    const own = { ...rows.get(target.id) };
    delete own.premium;
    rows.set(target.id, own);
    const patched = { ...ap, model: { ...ap.model, postMeta: rows } } as ConvertCtx;
    const got = evaluatePosts(patched, plan(queryMeta, patched).plan as PostPlan)!;
    // what WordPress answers: the rows joined, so an episode with no premium row is out
    const stored = (p: WpPost): string | undefined =>
      patched.model.postMeta.get(p.id)?.premium?.[0] as string | undefined;
    const wp = episodes.filter((p) => stored(p) !== undefined && stored(p) !== "1");
    expect(wp.map((p) => p.id)).not.toContain(target.id);
    expect(got.map((p) => p.id)).toContain(target.id);
    // and the report is what tells the person
    expect(plan(queryMeta, patched).info[0]!.code).toBe("query.approximated");
  });
});

describe("taxonomyterms and repeater: defaults, visibility and what an entry may not have", () => {
  const FIELD = "field_62d867cf76f62"; // ap's `collection-resource` repeater of the Posts group
  const custom = (attrs: Record<string, unknown>): WpBlock =>
    block(
      "cwicly/taxonomyterms",
      { classID: "tt", taxtermsSource: "custom", ...attrs },
      [titleHeading()],
      '<div class="tt"><ccdyn></ccdyn></div>',
    );
  const repeat = (attrs: Record<string, unknown> = {}): WpBlock =>
    block(
      "cwicly/repeater",
      { classID: "repeater-x", id: "repeater-x", dynamic: "acf", dynamicACFField: FIELD, ...attrs },
      [
        block(
          "cwicly/heading",
          {
            classID: "h",
            headingTag: "h3",
            dynamic: "repeater",
            dynamicRepeaterField: "resource",
          },
          [],
          '<h3 class="h">{acfrepeater=resource}</h3>',
        ),
      ],
      '<div class="repeater-x"><ccdyn></ccdyn></div>',
    );

  test("taxtermsHideEmpty is true by default: the real taxonomy-project_type block lists the nine terms that have a project, not Farmhouse; an explicit false lists all ten", async () => {
    const fl = await loadSite("fineline");
    const real = blocksNamed(
      subjectBlocks(fl, { kind: "template", slug: "taxonomy-project_type" }),
      "cwicly/taxonomyterms",
    )[0]!;
    expect(real.attrs).not.toHaveProperty("taxtermsHideEmpty");
    const rowsOf = async (b: WpBlock): Promise<string[]> => {
      const ctx = await fresh(
        "fineline",
        { kind: "template", slug: "taxonomy-project_type" },
        { mode: "entry" },
      );
      convertBlocks([b], ctx);
      const [rows] = [...collectedState(ctx)].filter(([k]) => k.endsWith("_rows"));
      return (rows![1] as { name: string }[]).map((r) => r.name);
    };
    const listed = await rowsOf(real);
    expect(listed).toHaveLength(9);
    expect(listed).not.toContain("Farmhouse");
    const all = await rowsOf({ ...real, attrs: { ...real.attrs, taxtermsHideEmpty: false } });
    expect(all).toHaveLength(10);
    expect(all).toContain("Farmhouse");
    expect(
      await rowsOf({ ...real, attrs: { ...real.attrs, taxtermsHideEmpty: "false" } }),
    ).toHaveLength(10);
  });

  test("a custom list of a post type's taxonomies has the built-in ones too: a post's categories and tags, as get_object_taxonomies lists them", async () => {
    const ctx = await fresh("ap", { kind: "post", id: 819 }, { target: "page" });
    const ap = await loadSite("ap");
    const out = convertBlocks(
      [custom({ taxtermsPostType: [{ value: "post", label: "Posts" }] })],
      ctx,
    );
    expect(elementsWhere(out, isArray)).toHaveLength(1);
    const rows = [...collectedState(ctx).values()][0];
    const taxonomies = new Set((rows as { taxonomy: string }[]).map((r) => r.taxonomy));
    // the taxonomies of a `post`: the built-in two and the ACF ones the field groups put on it (only those with a term filled are listed: hide_empty)
    const own = new Set(["category", "post_tag", ...taxonomiesFor(ap.acf, "post")]);
    const want = [...ctx.model.terms.values()].filter((t) => own.has(t.taxonomy) && t.count > 0);
    expect(taxonomies).toEqual(new Set(want.map((t) => t.taxonomy)));
    expect(taxonomies).toEqual(new Set(["category", "post_tag", "series"]));
    expect((rows as unknown[]).length).toBe(want.length);
  });

  test("a block no visitor sees registers no state and reports nothing", async () => {
    const ctx = await fresh("ap", { kind: "post", id: 819 }, { target: "page" });
    const hidden = { hideGuest: true, repeaterSlider: true };
    // the lists: custom terms, an entry's current terms (no current entry here), a repeater with rows, one that cannot be listed
    const out = convertBlocks(
      [
        custom({ taxtermsPostType: [{ value: "post", label: "Posts" }], ...hidden }),
        { ...repeat(hidden), attrs: { ...repeat(hidden).attrs, dynamicACFField: "field_nope" } },
        repeat({ ...hidden, dynamicACFField: FIELD }),
        block("cwicly/taxonomyterms", { taxtermsSource: "mystery", ...hidden }),
      ],
      ctx,
    );
    expect(out).toEqual([]);
    expect([...collectedState(ctx)]).toEqual([]);
    expect(
      ctx.report
        .entries()
        .filter((e) => /^(query|block\.unsupported|loop)/.test(e.code))
        .map((e) => e.code),
    ).toEqual([]);
    // shown to a visitor, the same blocks do say it
    const shown = await fresh("ap", { kind: "post", id: 819 }, { target: "page" });
    convertBlocks(
      [
        custom({ taxtermsPostType: [{ value: "post", label: "Posts" }], repeaterSlider: true }),
        block("cwicly/taxonomyterms", { taxtermsSource: "mystery" }),
      ],
      shown,
    );
    expect(shown.report.entries().map((e) => e.code)).toEqual(
      expect.arrayContaining(["query.slider", "block.unsupported"]),
    );
    expect([...collectedState(shown)].length).toBeGreaterThan(0);
  });

  test("a list with nothing in it is its element, empty, and the page stays static (an empty mapped array is a client render)", async () => {
    const ctx = await fresh("fineline", { kind: "post", id: 195 }, { target: "page" });
    const out = convertBlocks(
      [
        custom({
          taxtermsTaxonomies: [{ value: "location", label: "L" }],
          taxtermsInclude: [{ value: "9999", label: "" }],
        }),
      ],
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(elementsWhere(out, isArray)).toEqual([]);
    expect((out[0] as JxElement).children).toBeUndefined();
    expect(ctx.report.entries().find((e) => e.code === "query.empty")).toBeDefined();
    // the same for a repeater whose page has no rows
    const rep = await fresh("ap", { kind: "post", id: 819 }, { target: "page" });
    const shell = convertBlocks([repeat()], rep);
    expect(elementsWhere(shell, isArray)).toEqual([]);
    expect((shell[0] as JxElement).children).toBeUndefined();
  });

  test("a loop in an entry template reads its list when the page is built: entries with and without tags build with no JavaScript, every one of them", async () => {
    const site = await loadSite("ap");
    const out = await convertSubject(site, { kind: "template", slug: "single-post" });
    const { files, ctx } = await entryProject("ap", ["post", "episode"]);
    files["pages/essays/[slug].json"] = pageOf(out, {
      $paths: { contentType: "post", param: "slug", field: "slug" },
      title: "${state.entry.data.title}",
      state: { entry: ENTRY("post") },
    }) as ProjectFile;
    const built = await buildJxProject(files, { name: "ap-every-essay" });
    const tagsOf = (p: WpPost): { slug: string }[] =>
      (postData(ctx, p).terms as Record<string, { slug: string }[]> | undefined)?.post_tag ?? [];
    const essays = entryPosts(ctx, "post");
    const untagged = essays.filter((p) => tagsOf(p).length === 0);
    expect(untagged.length).toBeGreaterThan(5); // 25 of the live site's 102 have no tag
    for (const post of essays) {
      const html = built.html(ctx.urlFor("post", post.id)!);
      expect(shipsJs(html)).toBe(false);
      expect(html).not.toContain("data-bind");
      const box = /<div[^>]*id="taxonomyterms-episodes"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/.exec(
        html,
      );
      const hrefs = [...(box?.[1] ?? "").matchAll(/<a href="([^"]*)">/g)].map((m) => m[1]);
      expect(hrefs).toHaveLength(tagsOf(post).length);
    }
  });

  test("a repeater in an entry template builds with no JavaScript for every entry, which hold no rows", async () => {
    const ctx = await fresh("ap", { kind: "template", slug: "single-post" }, { mode: "entry" });
    const nodes = convertBlocks([repeat()], ctx);
    expect(elementsWhere(nodes, isArray)).toEqual([]);
    const { files, ctx: real } = await entryProject("ap", ["post"]);
    files["pages/essays/[slug].json"] = {
      title: "t",
      $paths: { contentType: "post", param: "slug", field: "slug" },
      state: { entry: ENTRY("post") },
      children: nodes,
    } as ProjectFile;
    const built = await buildJxProject(files, { name: "ap-repeater" });
    for (const post of entryPosts(real, "post")) {
      const html = built.html(real.urlFor("post", post.id)!);
      expect(shipsJs(html)).toBe(false);
      expect(html).toContain('class="repeater-x"');
    }
  });
});

describe("the author clauses of a posts query", () => {
  async function plansFor(
    site: SiteName,
    subject: Subject,
    over: Partial<ConvertCtx>,
    attrs: Record<string, unknown>,
  ) {
    const ctx = await makeCtx(site, subject, over);
    return {
      ctx,
      ...planOf(queryBlock({ queryPostType: pick("post"), queryInherit: false, ...attrs }), ctx),
    };
  }
  const authorName = dyn("authorname");

  test("on an author's page the list is that author's: an entry is theirs when its author's address is the page's", async () => {
    const { plan } = await plansFor(
      "ap",
      { kind: "template", slug: "author" },
      { mode: "entry", entryExpr: "state.author", entryType: "page" },
      { queryAuthorName: authorName, queryAuthorIn: authorName },
    );
    const conds = (plan as PostPlan).conds.filter((c) => c.why === "the author of the page");
    // The two attributes name the same thing: one clause.
    expect(conds).toHaveLength(1);
    expect(conds[0]).toMatchObject({
      js: "e.data.authorUrl === state.author.data.authorUrl",
      dynamic: true,
    });
    expect((plan as PostPlan).dropped.join(" ")).not.toContain("queryAuthor");
    const keep = compileConditions(conds) as unknown as (e: EntryLike, state: unknown) => boolean;
    const state = { author: { data: { authorUrl: "/people/a/" } } };
    const run = (url: string) => keep({ id: "x", data: { authorUrl: url } }, state);
    expect([run("/people/a/"), run("/people/b/")]).toEqual([true, false]);
  });

  test("on a static page of a post it is the post's author; an author with no page of their own is said", async () => {
    const loaded = await loadSite("ap");
    const post = [...loaded.model.posts.values()].find(
      (p) => p.type === "post" && loaded.routes.forAuthor(p.authorId) !== undefined,
    )!;
    const { plan, ctx } = await plansFor(
      "ap",
      { kind: "post", id: post.id },
      {},
      { queryAuthorName: authorName },
    );
    const url = ctx.urlForAuthor?.(post.authorId);
    expect(url).toBeDefined();
    expect((plan as PostPlan).conds.map((c) => c.js)).toContain(`e.data.authorUrl === '${url}'`);
    // The posts of that list are that author's own.
    const listed = evaluatePosts(ctx, plan as PostPlan, { all: true })!;
    expect(listed.length).toBeGreaterThan(0);
    for (const p of listed) expect(ctx.urlForAuthor?.(p.authorId)).toBe(url);
    const nobody = { ...ctx, urlForAuthor: () => undefined } as ConvertCtx;
    const lost = planOf(
      queryBlock({ queryPostType: pick("post"), queryInherit: false, queryAuthorName: authorName }),
      nobody,
    );
    expect((lost.plan as PostPlan).dropped.join(" ")).toContain("who has no page of their own");
  });

  test("authors named by id are their pages' addresses; where there is no page, no entry, and a dynamic source is said", async () => {
    const loaded = await loadSite("ap");
    const ids = [...new Set([...loaded.model.posts.values()].map((p) => p.authorId))].slice(0, 2);
    const { plan, ctx } = await plansFor(
      "ap",
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryType: "post" },
      { queryAuthor: pick(...ids) },
    );
    const urls = ids.map((id) => ctx.urlForAuthor?.(id)).filter(Boolean);
    expect((plan as PostPlan).conds.map((c) => c.js)).toContain(
      `[${urls.map((u) => `'${u}'`).join(", ")}].includes(e.data.authorUrl)`,
    );
    const dynamic = await plansFor(
      "ap",
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryType: "post" },
      { queryAuthor: dyn("urlparameter", "who") },
    );
    expect((dynamic.plan as PostPlan).dropped.join(" ")).toContain(
      "authors read from a dynamic source",
    );
    const none = await plansFor(
      "ap",
      { kind: "template", slug: "archive" },
      {},
      { queryAuthorName: authorName },
    );
    expect((none.plan as PostPlan).dropped.join(" ")).toContain("the author of the page");
    // Some other source the plugin has for the name stays what it was: not read.
    const other = await plansFor(
      "ap",
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryType: "post" },
      { queryAuthorName: dyn("shortcode", "x") },
    );
    expect((other.plan as PostPlan).dropped.join(" ")).toContain("queryAuthorName");
  });
});
