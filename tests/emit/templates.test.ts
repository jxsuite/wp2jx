/**
 * emit/templates.ts against the real fixture sites. Three oracles decide it:
 *
 * - the live pages: every page of tests/fixtures/<site>/html carries the template WordPress used in its
 *   body classes and its `cc-tp-<theme>_<slug>.css` links, and a table of further pages (fetched once
 *   from the live sites, see LIVE below) extends that to every kind of route the sites have;
 * - the plugin: Cwicly's template rules (`cc_themer_maker`) are held to the branches of the PHP;
 * - the build: everything written is validated and built with the installed `jx`, and the header and
 *   footer of the built pages are held against the live ones.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fromHtml } from "hast-util-from-html";
import { buildCollections } from "../../src/emit/collections.ts";
import { buildPages, hierarchyLayout } from "../../src/emit/pages.ts";
import {
  archiveLabel,
  authorRobots,
  BASE_LAYOUT,
  BASE_LAYOUT_FILE,
  boundHead,
  boundTitle,
  breadcrumbNode,
  breadcrumbNotes,
  breadcrumbSettings,
  buildTemplates,
  countEntryBodies,
  crumbsFor,
  cwiclyRule,
  EMPTY_SHORTCODES,
  fragmentParts,
  isPageTemplate,
  layoutFor,
  layoutPathOf,
  PAGE_ENTRY_KEYS,
  partArea,
  repairTermBindings,
  selectTemplate,
  slotContent,
  splitChrome,
  templateCandidates,
  templateFor,
  templateOf,
  wholeBindingsAside,
  withoutResults,
  withoutShortcodeText,
  type PageKind,
  type TemplateRequest,
  type TemplatesOutput,
} from "../../src/emit/templates.ts";
import { convertSubject, type Converted } from "../../src/convert.ts";
import { texturize } from "../../src/cwicly/tokens.ts";
import { walkElements } from "../../src/placeholders.ts";
import { createReport } from "../../src/report.ts";
import { decodeEntities, termsOf } from "../../src/wp/model.ts";
import { maybeUnserialize } from "../../src/wp/phpser.ts";
import { buildRoutes, createUrlTools } from "../../src/routes.ts";
import type { SiteContext, Subject } from "../../src/site.ts";
import { partTag } from "../../src/site.ts";
import type { JxElement, JxNode, Report, WpPost, WpTerm } from "../../src/types.ts";
import { parseBlocks as parseBlocksOf, walkBlocks as walkBlocksOf } from "../../src/wp/blocks.ts";
import { loadSite, type LoadedSite, type SiteName } from "../helpers/ctx.ts";
import { fixtureDir } from "../helpers/fixture-db.ts";
import { pilotForms } from "../helpers/fluentform-db.ts";
import {
  buildJxProject,
  cleanupJxProjects,
  validateJxProject,
  type BuiltProject,
} from "../helpers/jx-build.ts";

setDefaultTimeout(240_000);
afterAll(cleanupJxProjects);

const SITES: readonly SiteName[] = ["fineline", "ap"];

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

const NOT_TEXT = new Set(["script", "style", "noscript", "template", "svg", "head"]);

/** The text nodes a visitor reads under `root`, whitespace collapsed, in order. */
function textsOf(root: Hast): string[] {
  const out: string[] = [];
  const visit = (node: Hast): void => {
    if (node.type === "text") {
      const t = (node.value ?? "").replace(/\s+/g, " ").trim();
      if (t !== "") out.push(t);
    } else if (node.type === "root" || (node.type === "element" && !NOT_TEXT.has(node.tagName!))) {
      node.children?.forEach(visit);
    }
  };
  visit(root);
  return out;
}

const classOf = (element: Hast): string => {
  const value = element.properties?.className;
  return Array.isArray(value) ? value.join(" ") : String(value ?? "");
};

const attrOf = (element: Hast, name: string): string | undefined => {
  const value = element.properties?.[name];
  return value === undefined || value === false ? undefined : String(value);
};

const parseHtml = (html: string): Hast => fromHtml(html) as unknown as Hast;

function findAll(root: Hast, test: (element: Hast) => boolean): Hast[] {
  const out: Hast[] = [];
  walkHast(root, (element) => {
    if (test(element)) out.push(element);
  });
  return out;
}

/**
 * The block-level children of `div.wp-site-blocks`, with the template parts' component hosts a build
 * leaves (`<wp-header>`, `display: contents`) looked through: what the visitor sees as the page's own
 * top-level sections.
 */
function siteBlocks(root: Hast): Hast[] {
  const wrapper = findAll(
    root,
    (e) => e.tagName === "div" && classOf(e).split(" ").includes("wp-site-blocks"),
  )[0];
  if (!wrapper) return [];
  const hosts = new Set<string>();
  for (const name of SITES) {
    for (const part of outputs.get(name)?.parts ?? []) hosts.add(part.tag);
  }
  const out: Hast[] = [];
  const flatten = (node: Hast): void => {
    for (const child of node.children ?? []) {
      if (child.type !== "element") continue;
      if (NOT_TEXT.has(child.tagName!)) continue;
      if (hosts.has(child.tagName!)) flatten(child);
      else out.push(child);
    }
  };
  flatten(wrapper);
  return out;
}

const slotsIn = (nodes: readonly JxNode[]): number =>
  [...walkElements(nodes)].filter((e) => e.tagName === "slot").length;

const parse = (content: string): Record<string, unknown> =>
  JSON.parse(content) as Record<string, unknown>;

const fileOf = (out: TemplatesOutput, path: string): string => {
  const found = out.files.find((f) => f.path === path);
  if (!found) throw new Error(`no file ${path} in the output`);
  return found.content;
};

const docOf = (out: TemplatesOutput, path: string): Record<string, unknown> =>
  parse(fileOf(out, path));

const childrenOf = (doc: Record<string, unknown>): JxNode[] => doc.children as JxNode[];

/** Everything an output wrote, parsed, by path (JSON files only). */
const jsonFiles = (out: TemplatesOutput): Map<string, Record<string, unknown>> =>
  new Map(out.files.filter((f) => f.path.endsWith(".json")).map((f) => [f.path, parse(f.content)]));

const published = (site: LoadedSite, type: string): WpPost[] =>
  [...site.model.posts.values()].filter((p) => p.type === type && p.status === "publish");

const postBySlug = (site: LoadedSite, type: string, slug: string): WpPost => {
  const post = [...site.model.posts.values()].find((p) => p.type === type && p.slug === slug);
  if (!post) throw new Error(`no ${type} ${slug}`);
  return post;
};

const termBySlug = (site: LoadedSite, taxonomy: string, slug: string): WpTerm => {
  const term = [...site.model.terms.values()].find(
    (t) => t.taxonomy === taxonomy && t.slug === slug,
  );
  if (!term) throw new Error(`no term ${taxonomy} ${slug}`);
  return term;
};

/** A site whose model is a copy, so the per-model caches of the module cannot see a test's edit. */
function withModel(site: LoadedSite, edit: (posts: Map<number, WpPost>) => void): LoadedSite {
  const posts = new Map(site.model.posts);
  edit(posts);
  return { ...site, model: { ...site.model, posts } };
}

const sites = new Map<SiteName, LoadedSite>();
beforeAll(async () => {
  for (const name of SITES) sites.set(name, await loadSite(name));
});
const site = (name: SiteName): LoadedSite => sites.get(name)!;

// ── The WordPress hierarchy ──────────────────────────────────────────────────────────────────────

describe("templateCandidates: template-loader.php, list by list", () => {
  const fineline = () => site("fineline");
  const ap = () => site("ap");

  test("a page: its own template, page-<slug>, page-<id>, page, singular, index", () => {
    const about = postBySlug(fineline(), "page", "about-us");
    expect(templateCandidates(fineline(), { kind: "page", post: about })).toEqual([
      "page-about-us",
      "page-1716",
      "page",
      "singular",
      "index",
    ]);
    const filter = postBySlug(ap(), "page", "episodes");
    expect(templateCandidates(ap(), { kind: "page", post: filter })).toEqual([
      "wp-custom-template-filter-page",
      "page-episodes",
      "page-834",
      "page",
      "singular",
      "index",
    ]);
  });

  test("the front page tries front-page first, the privacy page privacy-policy", () => {
    const front = postBySlug(ap(), "page", "welcome");
    expect(templateCandidates(ap(), { kind: "page", post: front })[0]).toBe("front-page");
    const privacy = postBySlug(ap(), "page", "privacy");
    expect(templateCandidates(ap(), { kind: "page", post: privacy }).slice(0, 2)).toEqual([
      "privacy-policy",
      "page-privacy",
    ]);
    // A page that is neither names neither.
    const terms = postBySlug(ap(), "page", "terms");
    expect(templateCandidates(ap(), { kind: "page", post: terms })).not.toContain("front-page");
    expect(templateCandidates(ap(), { kind: "page", post: terms })).not.toContain("privacy-policy");
  });

  test('a page template named "default" or nothing is no template', () => {
    const quote = postBySlug(fineline(), "page", "quote");
    expect(templateCandidates(fineline(), { kind: "page", post: quote })).not.toContain("default");
    expect(templateCandidates(fineline(), { kind: "page", post: quote })[0]).toBe("page-quote");
  });

  test("an entry: single-<type>-<slug>, single-<type>, single, singular, index", () => {
    const project = published(fineline(), "project")[0]!;
    expect(templateCandidates(fineline(), { kind: "single", post: project })).toEqual([
      `single-project-${project.slug}`,
      "single-project",
      "single",
      "singular",
      "index",
    ]);
  });

  test("the posts index: home then index; the front of a site that shows its posts adds front-page", () => {
    expect(templateCandidates(fineline(), { kind: "posts" })).toEqual(["home", "index"]);
    expect(templateCandidates(fineline(), { kind: "posts", front: true })).toEqual([
      "front-page",
      "home",
      "index",
    ]);
  });

  test("archives: archive-<type>, archive, index", () => {
    expect(templateCandidates(fineline(), { kind: "post-archive", postType: "project" })).toEqual([
      "archive-project",
      "archive",
      "index",
    ]);
  });

  test("terms: taxonomy-<tax>-<term>, taxonomy-<tax>-<id>, taxonomy-<tax>, taxonomy, archive, index; category and tag have their own lists", () => {
    const location = termBySlug(fineline(), "location", "adams-county-pa");
    expect(templateCandidates(fineline(), { kind: "term", term: location })).toEqual([
      "taxonomy-location-adams-county-pa",
      `taxonomy-location-${location.termId}`,
      "taxonomy-location",
      "taxonomy",
      "archive",
      "index",
    ]);
    const category = termBySlug(ap(), "category", "bible");
    expect(templateCandidates(ap(), { kind: "term", term: category })).toEqual([
      "category-bible",
      `category-${category.termId}`,
      "category",
      "archive",
      "index",
    ]);
    const tag = termBySlug(ap(), "post_tag", "work");
    expect(templateCandidates(ap(), { kind: "term", term: tag })).toEqual([
      "tag-work",
      `tag-${tag.termId}`,
      "tag",
      "archive",
      "index",
    ]);
  });

  test("authors, search and the 404", () => {
    expect(
      templateCandidates(ap(), { kind: "author", user: { id: 158, slug: "dean-taylor" } }),
    ).toEqual(["author-dean-taylor", "author-158", "author", "archive", "index"]);
    expect(templateCandidates(ap(), { kind: "search" })).toEqual(["search", "index"]);
    expect(templateCandidates(ap(), { kind: "404" })).toEqual(["404", "index"]);
  });

  test("a slug is listed once however many lists name it", () => {
    for (const request of [
      { kind: "search" },
      { kind: "404" },
      { kind: "posts", front: true },
    ] as const) {
      const list = templateCandidates(ap(), request);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  test("an encoded page slug is tried decoded first, as get_page_template does", () => {
    const base = postBySlug(fineline(), "page", "quote");
    const odd: WpPost = { ...base, slug: "caf%C3%A9" };
    expect(templateCandidates(fineline(), { kind: "page", post: odd }).slice(0, 2)).toEqual([
      "page-café",
      "page-caf%C3%A9",
    ]);
    const broken: WpPost = { ...base, slug: "100%" };
    expect(templateCandidates(fineline(), { kind: "page", post: broken })[0]).toBe("page-100%");
  });
});

// ── What the live pages used ─────────────────────────────────────────────────────────────────────

interface Observed {
  site: SiteName;
  /** The address on the live site, or the name of a request that has none. */
  path: string;
  /** The template the page's body classes and `cc-tp-` links name. */
  template: string;
  /** The template parts the page's `cc-tp-` links name (a part nested in a part is listed). */
  parts: string[];
}

/**
 * Pages observed on the live sites on 2026-10-05, each by its body classes (`page-template-<slug>`,
 * `single-<type>`, `archive tax-<taxonomy>`…) and by the `cc-tp-cwicly_<slug>.css` links of its head: the
 * template, and the template parts. These are the pages the six committed fixtures per site do not
 * cover (an archive, a term, an author, a search, a 404, an entry of each type, a page with a page
 * template of its own). They were fetched once for this table; nothing here reads the network.
 */
const LIVE: Observed[] = [
  {
    site: "fineline",
    path: "/projects/",
    template: "archive-project",
    parts: ["footer", "header"],
  },
  {
    site: "fineline",
    path: "/services/",
    template: "archive-service",
    parts: ["footer", "header"],
  },
  {
    site: "fineline",
    path: "/project_tag/agricultural-projects/",
    template: "taxonomy-project_tag",
    parts: ["footer", "header"],
  },
  {
    site: "fineline",
    path: "/service_area/adams-county-pa/",
    template: "taxonomy-location",
    parts: ["footer", "header"],
  },
  {
    site: "fineline",
    path: "/project_type/agricultural/",
    template: "taxonomy-project_type",
    parts: ["footer", "header"],
  },
  { site: "fineline", path: "/category/blog/", template: "index", parts: ["footer", "header"] },
  { site: "fineline", path: "/tag/barns/", template: "index", parts: ["footer", "header"] },
  {
    site: "fineline",
    path: "/author/chad-beiler/",
    template: "index",
    parts: ["footer", "header"],
  },
  {
    site: "fineline",
    path: "/service-type/interior/",
    template: "index",
    parts: ["footer", "header"],
  },
  {
    site: "fineline",
    path: "/project/barn-painting-in-annville-pa/",
    template: "single-project",
    parts: ["footer", "header"],
  },
  {
    site: "fineline",
    path: "/project/chicken-house-painting-in-watsontown-pa/",
    template: "single-project",
    parts: ["footer", "header"],
  },
  {
    site: "fineline",
    path: "/service/kitchens/",
    template: "single-service",
    parts: ["footer", "header"],
  },
  { site: "fineline", path: "/quote/", template: "page", parts: ["footer", "header"] },
  { site: "fineline", path: "/contact-us/", template: "page", parts: ["footer", "header"] },
  { site: "fineline", path: "request:search", template: "search", parts: ["footer", "header"] },
  { site: "fineline", path: "request:404", template: "404", parts: ["footer", "header"] },
  {
    site: "ap",
    path: "/about/",
    template: "wp-custom-template-about-us",
    parts: ["footer", "header-light", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/donate/",
    template: "wp-custom-template-full-width",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/follow/",
    template: "wp-custom-template-full-width",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/donor-dashboard/",
    template: "wp-custom-template-wide",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/episodes/",
    template: "wp-custom-template-filter-page",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/contact/",
    template: "page",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/origins/",
    template: "page",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/team/",
    template: "page",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/terms/",
    template: "page",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/thank-you/",
    template: "page",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/privacy/",
    template: "page",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/essays/series/a-knock-heard-round-the-hood/",
    template: "taxonomy-series",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/essays/season/season-1/",
    template: "archive",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/tag/work/",
    template: "tag",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/category/bible/",
    template: "archive",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/people/dean-taylor/",
    template: "author",
    parts: ["footer", "header-light", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/episodes/28-years-as-an-amish-mennonite-pastor-in-ireland/",
    template: "single-episode",
    parts: ["comments", "footer", "header-light", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "/supporters_update/three-years-in-supporters-update-15/",
    template: "single-supporters_update",
    parts: ["comments", "footer", "header", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "request:search",
    template: "search",
    parts: ["footer", "header-light", "mobile-menu", "top-menu"],
  },
  {
    site: "ap",
    path: "request:404",
    template: "404",
    parts: ["footer", "header", "mobile-menu", "top-menu"],
  },
];

/**
 * The request a path of the live site is, through the site's own route table. A post the fixture
 * database does not hold (the fixtures keep at most a hundred rows of a type) is stood in for by another
 * post of the same type under the address's own slug: only the type and the slug decide a template.
 */
function requestOf(s: LoadedSite, path: string): TemplateRequest {
  if (path === "request:search") return { kind: "search" };
  if (path === "request:404") return { kind: "404" };
  const route = s.routes.byWpPath(path);
  if (!route) {
    const slug = path.replace(/\/+$/, "").split("/").pop()!;
    const stand = published(s, "post")[0]!;
    return { kind: "single", post: { ...stand, slug } };
  }
  switch (route.kind) {
    case "page":
    case "front":
      return { kind: "page", post: s.model.posts.get(Number(route.id))! };
    case "posts-page":
      return { kind: "posts", front: route.jxRoute === "/" };
    case "entry":
      return { kind: "single", post: s.model.posts.get(Number(route.id))! };
    case "post-archive":
      return { kind: "post-archive", postType: String(route.id) };
    case "term":
      return { kind: "term", term: s.model.terms.get(Number(route.id))! };
    case "author":
      return { kind: "author", user: s.model.users.get(Number(route.id))! };
    default:
      throw new Error(`${path} is a ${route.kind}`);
  }
}

/** What a committed live page says: the template (page template body class, else the one `cc-tp-` link that is not a part) and its parts. */
function observedIn(
  name: SiteName,
  file: string,
): { template: string | undefined; parts: string[]; body: string } {
  const html = readFileSync(`${fixtureDir(name)}/html/${file}`, "utf8");
  const body = /<body class="([^"]*)"/.exec(html)?.[1] ?? "";
  const s = site(name);
  const parts = new Set(published(s, "wp_template_part").map((p) => p.slug));
  const links = [...html.matchAll(/cc-tp-[a-zA-Z0-9]+_([a-zA-Z0-9_-]+)\.css/g)].map((m) => m[1]!);
  const custom = /page-template-(wp-custom-template-[a-z-]+)/.exec(body)?.[1];
  return {
    template: custom ?? [...new Set(links)].find((slug) => !parts.has(slug)),
    parts: [...new Set(links.filter((slug) => parts.has(slug)))].sort(),
    body,
  };
}

/** The committed fixtures: file → the address it is. */
const FIXTURE_PAGES: { site: SiteName; file: string; path: string; template: string }[] = [
  { site: "fineline", file: "home.html", path: "/", template: "page" },
  { site: "fineline", file: "about-us.html", path: "/about-us/", template: "page" },
  { site: "fineline", file: "residential.html", path: "/residential/", template: "page" },
  { site: "fineline", file: "privacy-policy.html", path: "/privacy-policy/", template: "page" },
  { site: "fineline", file: "blog.html", path: "/blog/", template: "index" },
  {
    site: "fineline",
    file: "choosing-the-best-log-home-stain.html",
    path: "/choosing-the-best-log-home-stain/",
    template: "single",
  },
  { site: "ap", file: "essays.html", path: "/essays/", template: "index" },
  {
    site: "ap",
    file: "essays__get-in-the-way-of-evil.html",
    path: "/essays/get-in-the-way-of-evil/",
    template: "single-post",
  },
  {
    site: "ap",
    file: "essays__keeshons-story-a-knock-heard-round-the-hood-part-3.html",
    path: "/essays/keeshons-story-a-knock-heard-round-the-hood-part-3/",
    template: "single-post",
  },
  {
    site: "ap",
    file: "essays__the-cultural-captivity-of-the-gospel.html",
    path: "/essays/the-cultural-captivity-of-the-gospel/",
    template: "single-post",
  },
  {
    site: "ap",
    file: "essays__the-essence-of-anabaptism-dean-taylor.html",
    path: "/essays/the-essence-of-anabaptism-dean-taylor/",
    template: "single-post",
  },
  {
    site: "ap",
    file: "essays__the-way-we-live-is-the-way-we-educate.html",
    path: "/essays/the-way-we-live-is-the-way-we-educate/",
    template: "single-post",
  },
];

describe("selectTemplate against the live pages", () => {
  for (const row of FIXTURE_PAGES) {
    test(`${row.site} ${row.path} is rendered by ${row.template}, as its own head says`, () => {
      const seen = observedIn(row.site, row.file);
      // The committed page's own links name the template.
      expect(seen.template).toBe(row.template);
      const s = site(row.site);
      const choice = selectTemplate(s, requestOf(s, row.path));
      expect(choice.slug).toBe(row.template);
      expect(choice.via).toBe("hierarchy");
      expect(choice.post?.slug).toBe(row.template);
      expect(choice.tried.indexOf(choice.slug)).toBe(
        choice.tried.length - choice.tried.slice().reverse().indexOf(choice.slug) - 1,
      );
    });
  }

  for (const row of LIVE) {
    test(`${row.site} ${row.path} is rendered by ${row.template} (observed live)`, () => {
      const s = site(row.site);
      const choice = selectTemplate(s, requestOf(s, row.path));
      expect(choice.slug).toBe(row.template);
      expect(templateOf(s, row.template)?.id).toBe(choice.post?.id);
    });
  }

  test("the home page of a site with a static front uses the template of its own name when it has one", () => {
    // anabaptistperspectives has `front-page` (the live home loads no page.css), fineline has none and uses `page`.
    const apFront = selectTemplate(site("ap"), requestOf(site("ap"), "/"));
    expect(apFront.slug).toBe("front-page");
    const finelineFront = selectTemplate(site("fineline"), requestOf(site("fineline"), "/"));
    expect(finelineFront.slug).toBe("page");
  });

  test("a page template of a classic theme is no wp_template: it is reported and the hierarchy goes on", () => {
    const s = site("fineline");
    const quote = postBySlug(s, "page", "quote");
    const edited = {
      ...s,
      model: {
        ...s.model,
        postMeta: new Map(s.model.postMeta).set(quote.id, {
          ...s.model.postMeta.get(quote.id),
          _wp_page_template: ["page-templates/wide.php"],
        }),
      },
    };
    const report = createReport();
    const choice = selectTemplate(edited, { kind: "page", post: quote }, report);
    expect(choice.slug).toBe("page");
    const found = report.entries().find((e) => e.code === "template.page-template-missing");
    expect(found?.severity).toBe("warn");
    expect(found?.where).toBe(`post:${quote.id}`);
  });

  test("an inactive theme's templates are not candidates", () => {
    const s = site("fineline");
    const real = templateOf(s, "single-project")!;
    // Tag the template with another theme's `wp_theme` term: the active theme no longer has it.
    const other: WpTerm = {
      termId: 999999,
      taxonomyId: 999999,
      taxonomy: "wp_theme",
      slug: "twentytwentyfour",
      name: "twentytwentyfour",
      description: "",
      parent: 0,
      count: 1,
      meta: {},
    };
    const model = {
      ...s.model,
      terms: new Map(s.model.terms).set(other.termId, other),
      termsByPost: new Map(s.model.termsByPost).set(real.id, [other.termId]),
    };
    const edited = { ...s, model };
    const project = published(s, "project")[0]!;
    expect(selectTemplate(edited, { kind: "single", post: project }).slug).toBe("single");
    expect(templateOf(edited, "single-project")).toBeUndefined();
  });

  test("two posts of one slug: the published one, then the lower id", () => {
    const s = site("fineline");
    const real = templateOf(s, "single-service")!;
    const draftTwin = withModel(s, (posts) => posts.set(1, { ...real, id: 1, status: "draft" }));
    expect(templateOf(draftTwin, "single-service")?.id).toBe(real.id);
    const lower = withModel(s, (posts) => posts.set(1, { ...real, id: 1 }));
    expect(templateOf(lower, "single-service")?.id).toBe(1);
    const higher = withModel(s, (posts) => posts.set(999999, { ...real, id: 999999 }));
    expect(templateOf(higher, "single-service")?.id).toBe(real.id);
  });

  test("an unpublished template is not a candidate either", () => {
    const s = site("fineline");
    const real = templateOf(s, "single-service")!;
    const edited = withModel(s, (posts) => posts.set(real.id, { ...real, status: "draft" }));
    const service = published(s, "service")[0]!;
    expect(selectTemplate(edited, { kind: "single", post: service }).slug).toBe("single");
  });

  test("a site with no template at all answers `index` with no post, never a throw", () => {
    const s = site("fineline");
    const bare = withModel(s, (posts) => {
      for (const [id, post] of posts) if (post.type === "wp_template") posts.delete(id);
    });
    const choice = selectTemplate(bare, { kind: "404" });
    expect(choice.slug).toBe("index");
    expect(choice.post).toBeUndefined();
    expect(choice.tried).toEqual(["404", "index"]);
  });
});

// ── Cwicly's template rules ──────────────────────────────────────────────────────────────────────

type Rule = Record<string, unknown>;

const rule = (over: Rule = {}): Rule => ({
  all: "false",
  singular: [],
  archive: [],
  author: [],
  custom: [],
  includeCondition: "and",
  ...over,
});
const noExclude = (over: Rule = {}): Rule => ({
  all: "false",
  singular: [],
  archive: [],
  author: [],
  custom: [],
  excludeCondition: "and",
  ...over,
});

/** A site whose `cwicly_conditions` is `include`/`exclude`. */
function withRules(
  s: LoadedSite,
  include: Record<string, Rule>,
  exclude?: Record<string, Rule>,
): LoadedSite {
  const ex = exclude ?? Object.fromEntries(Object.keys(include).map((slug) => [slug, noExclude()]));
  return { ...s, options: { ...s.options, conditions: { include, exclude: ex } } };
}

const choose = (s: LoadedSite, request: TemplateRequest, report?: Report): string =>
  selectTemplate(s, request, report).slug;

describe("cwiclyRule: cc_themer_maker", () => {
  const fl = () => site("fineline");
  const quote = () => postBySlug(fl(), "page", "quote");
  const project = () => published(fl(), "project")[0]!;
  const requests = (): Record<string, TemplateRequest> => ({
    page: { kind: "page", post: quote() },
    single: { kind: "single", post: project() },
    archive: { kind: "post-archive", postType: "project" },
    term: { kind: "term", term: termBySlug(fl(), "project_tag", "agricultural-projects") },
    author: { kind: "author", user: { id: 8, slug: "chad-beiler" } },
    search: { kind: "search" },
    "404": { kind: "404" },
    posts: { kind: "posts" },
  });

  test("a site that stores no rule is answered by the hierarchy", () => {
    for (const request of Object.values(requests())) {
      expect(cwiclyRule(fl(), request)).toBeUndefined();
    }
    expect(selectTemplate(fl(), requests().page!).via).toBe("hierarchy");
  });

  test("`all` applies a template to every request", () => {
    const s = withRules(fl(), { "test-header": rule({ all: "true" }) });
    for (const [kind, request] of Object.entries(requests())) {
      expect([kind, choose(s, request)]).toEqual([kind, "test-header"]);
    }
    const choice = selectTemplate(s, requests().page!);
    expect(choice.via).toBe("rule");
    expect(choice.tried[0]).toBe("test-header");
  });

  test("a rule with no includeCondition prints nothing, as the plugin's own test does", () => {
    const s = withRules(fl(), {
      "test-header": rule({ all: "true", includeCondition: undefined }),
    });
    expect(choose(s, requests().page!)).toBe("page");
  });

  test("a rule that lists nothing matches nothing, even with `and`", () => {
    const s = withRules(fl(), { "test-header": rule() });
    for (const request of Object.values(requests())) {
      expect(cwiclyRule(s, request)).toBeUndefined();
    }
  });

  test("singular: a post type, `all`, 404 and frontPage", () => {
    const byType = withRules(fl(), {
      "test-header": rule({ singular: [{ target: "project", data: "all" }] }),
    });
    expect(choose(byType, requests().single!)).toBe("test-header");
    expect(choose(byType, requests().page!)).toBe("page");
    expect(choose(byType, requests().term!)).toBe("taxonomy-project_tag");

    const all = withRules(fl(), { "test-header": rule({ singular: [{ target: "all" }] }) });
    expect(choose(all, requests().single!)).toBe("test-header");
    expect(choose(all, requests().page!)).toBe("test-header");
    expect(choose(all, requests()["404"]!)).toBe("test-header");
    expect(choose(all, requests().term!)).toBe("taxonomy-project_tag");
    expect(choose(all, requests().archive!)).toBe("archive-project");

    const notFound = withRules(fl(), { "test-header": rule({ singular: [{ target: "404" }] }) });
    expect(choose(notFound, requests()["404"]!)).toBe("test-header");
    expect(choose(notFound, requests().page!)).toBe("page");
    expect(choose(notFound, requests().search!)).toBe("search");

    const front = withRules(fl(), { "test-header": rule({ singular: [{ target: "frontPage" }] }) });
    const home = postBySlug(fl(), "page", "home-2");
    expect(choose(front, { kind: "page", post: home })).toBe("test-header");
    expect(choose(front, requests().page!)).toBe("page");
    expect(choose(front, { kind: "posts", front: true })).toBe("test-header");
  });

  test("singular: a taxonomy, a term of it, and a list of post ids", () => {
    const tagged = published(fl(), "project").find((p) =>
      (fl().model.termsByPost.get(p.id) ?? []).some(
        (id) => fl().model.terms.get(id)?.taxonomy === "project_tag",
      ),
    )!;
    const term = (fl().model.termsByPost.get(tagged.id) ?? [])
      .map((id) => fl().model.terms.get(id)!)
      .find((t) => t.taxonomy === "project_tag")!;
    const request: TemplateRequest = { kind: "single", post: tagged };
    // data = taxonomy, extra = all: the post has any term of it.
    const anyTerm = withRules(fl(), {
      "test-header": rule({ singular: [{ target: "project", data: "project_tag", extra: "all" }] }),
    });
    expect(choose(anyTerm, request)).toBe("test-header");
    // data = taxonomy, extra = a term: that term.
    const ofTerm = (slug: string) =>
      withRules(fl(), {
        "test-header": rule({
          singular: [{ target: "project", data: "project_tag", extra: slug }],
        }),
      });
    expect(choose(ofTerm(term.slug), request)).toBe("test-header");
    expect(choose(ofTerm("no-such-term"), request)).toBe("single-project");
    // A taxonomy the post has no term of.
    const other = withRules(fl(), {
      "test-header": rule({
        singular: [{ target: "project", data: "project_type", extra: "all" }],
      }),
    });
    const untyped = published(fl(), "project").find(
      (p) =>
        !(fl().model.termsByPost.get(p.id) ?? []).some(
          (id) => fl().model.terms.get(id)?.taxonomy === "project_type",
        ),
    );
    if (untyped) expect(choose(other, { kind: "single", post: untyped })).toBe("single-project");
    // extraData: a single post.
    const one = withRules(fl(), {
      "test-header": rule({
        singular: [
          { target: "project", data: "project_tag", extra: term.slug, extraData: tagged.id },
        ],
      }),
    });
    expect(choose(one, request)).toBe("test-header");
    const elsewhere = withRules(fl(), {
      "test-header": rule({
        singular: [
          { target: "project", data: "project_tag", extra: term.slug, extraData: tagged.id + 1 },
        ],
      }),
    });
    expect(choose(elsewhere, request)).toBe("single-project");
    // A list of ids.
    const ids = withRules(fl(), {
      "test-header": rule({ singular: [{ target: "project", data: [tagged.id, 1] }] }),
    });
    expect(choose(ids, request)).toBe("test-header");
    const idsMiss = withRules(fl(), {
      "test-header": rule({ singular: [{ target: "project", data: [1, 2] }] }),
    });
    expect(choose(idsMiss, request)).toBe("single-project");
  });

  test("singular: directchildof compares the post's parent", () => {
    const parent = published(fl(), "service").find((p) => p.parent !== 0);
    const service = parent ?? published(fl(), "service")[0]!;
    const withParent: WpPost = { ...service, parent: 77 };
    const s = withRules(fl(), {
      "test-header": rule({ singular: [{ target: "service", data: "directchildof", extra: 77 }] }),
    });
    expect(choose(s, { kind: "single", post: withParent })).toBe("test-header");
    expect(choose(s, { kind: "single", post: { ...service, parent: 78 } })).toBe("single-service");
  });

  test("archive: search, all, a post type, a taxonomy of it, a term of it, an author", () => {
    const search = withRules(fl(), { "test-header": rule({ archive: [{ target: "search" }] }) });
    expect(choose(search, requests().search!)).toBe("test-header");
    expect(choose(search, requests().archive!)).toBe("archive-project");

    const all = withRules(fl(), { "test-header": rule({ archive: [{ target: "all" }] }) });
    expect(choose(all, requests().archive!)).toBe("test-header");
    expect(choose(all, requests().term!)).toBe("test-header");
    expect(choose(all, requests().author!)).toBe("test-header");
    expect(choose(all, requests().single!)).toBe("single-project");
    expect(choose(all, requests().posts!)).toBe("index");

    const type = withRules(fl(), {
      "test-header": rule({ archive: [{ target: "project", data: "all" }] }),
    });
    expect(choose(type, requests().archive!)).toBe("test-header");
    // A taxonomy archive belongs to the first post type of the taxonomy.
    expect(choose(type, requests().term!)).toBe("test-header");
    expect(choose(type, { kind: "post-archive", postType: "service" })).toBe("archive-service");

    const taxonomy = withRules(fl(), {
      "test-header": rule({ archive: [{ target: "project", data: "project_tag", extra: "all" }] }),
    });
    expect(choose(taxonomy, requests().term!)).toBe("test-header");
    expect(choose(taxonomy, requests().archive!)).toBe("archive-project");

    const term = termBySlug(fl(), "project_tag", "agricultural-projects");
    const oneTerm = (id: number) =>
      withRules(fl(), {
        "test-header": rule({ archive: [{ target: "project", data: "project_tag", extra: id }] }),
      });
    expect(choose(oneTerm(term.termId), requests().term!)).toBe("test-header");
    expect(choose(oneTerm(term.termId + 1), requests().term!)).toBe("taxonomy-project_tag");

    const author = withRules(fl(), {
      "test-header": rule({ archive: [{ target: "author", data: 8 }] }),
    });
    expect(choose(author, requests().author!)).toBe("test-header");
    expect(choose(author, { kind: "author", user: { id: 9, slug: "x" } })).toBe("index");
    const anyAuthor = withRules(fl(), {
      "test-header": rule({ archive: [{ target: "author", data: "all" }] }),
    });
    expect(choose(anyAuthor, { kind: "author", user: { id: 9, slug: "x" } })).toBe("test-header");
  });

  test("author: any author archive, or one author by id or name", () => {
    const any = withRules(fl(), { "test-header": rule({ author: [true] }) });
    expect(choose(any, requests().author!)).toBe("test-header");
    expect(choose(any, requests().archive!)).toBe("archive-project");
    const byId = withRules(fl(), { "test-header": rule({ author: [{ target: "8" }] }) });
    expect(choose(byId, requests().author!)).toBe("test-header");
    const byName = withRules(fl(), {
      "test-header": rule({ author: [{ target: "chad-beiler" }] }),
    });
    expect(choose(byName, requests().author!)).toBe("test-header");
    const other = withRules(fl(), { "test-header": rule({ author: [{ target: "nobody" }] }) });
    expect(choose(other, requests().author!)).toBe("index");
  });

  test("and needs every entry, or needs one", () => {
    const entries = {
      singular: [{ target: "project", data: "all" }],
      archive: [{ target: "search" }],
    };
    const and = withRules(fl(), { "test-header": rule({ ...entries, includeCondition: "and" }) });
    expect(choose(and, requests().single!)).toBe("single-project");
    expect(choose(and, requests().search!)).toBe("search");
    const or = withRules(fl(), { "test-header": rule({ ...entries, includeCondition: "or" }) });
    expect(choose(or, requests().single!)).toBe("test-header");
    expect(choose(or, requests().search!)).toBe("test-header");
    expect(choose(or, requests().page!)).toBe("page");
    // `and` of `all` with a condition needs both.
    const both = withRules(fl(), {
      "test-header": rule({ all: "true", singular: [{ target: "project", data: "all" }] }),
    });
    expect(choose(both, requests().single!)).toBe("test-header");
    expect(choose(both, requests().page!)).toBe("page");
  });

  test("custom: the visitor is a guest, there is no cookie and no query string", () => {
    const custom = (c: Rule[]) => withRules(fl(), { "test-header": rule({ custom: c }) });
    const page = requests().page!;
    // Not logged in.
    expect(choose(custom([{ target: "loggedin", extra: "true" }]), page)).toBe("page");
    expect(choose(custom([{ target: "loggedin", extra: "false" }]), page)).toBe("test-header");
    // A role or capability a guest does not have.
    expect(
      choose(custom([{ target: "userrole", extra: "===", extraData: "administrator" }]), page),
    ).toBe("page");
    expect(
      choose(custom([{ target: "userrole", extra: "!=", extraData: "administrator" }]), page),
    ).toBe("test-header");
    expect(
      choose(custom([{ target: "usercapabilities", extra: "===", extraData: "edit_posts" }]), page),
    ).toBe("page");
    // The user's id is 0 and the name empty.
    expect(choose(custom([{ target: "userid", extra: "===", extraData: "0" }]), page)).toBe(
      "test-header",
    );
    expect(choose(custom([{ target: "username", extra: "===", extraData: "" }]), page)).toBe(
      "test-header",
    );
    // No cookie by any name, no parameter.
    expect(choose(custom([{ target: "cookie", extra: "===", extraData: "seen" }]), page)).toBe(
      "page",
    );
    expect(choose(custom([{ target: "cookie", extra: "!=", extraData: "seen" }]), page)).toBe(
      "test-header",
    );
    expect(choose(custom([{ target: "cookie", extra: "contains", extraData: "se" }]), page)).toBe(
      "page",
    );
    expect(choose(custom([{ target: "cookie", extra: "notcontain", extraData: "se" }]), page)).toBe(
      "test-header",
    );
    expect(
      choose(custom([{ target: "urlparameter", key: "ref", extra: "===", extraData: "x" }]), page),
    ).toBe("page");
    expect(
      choose(custom([{ target: "urlparameter", key: "ref", extra: "!=", extraData: "x" }]), page),
    ).toBe("test-header");
    expect(choose(custom([{ target: "urlparameter", key: "ref", extra: "empty" }]), page)).toBe(
      "page",
    );
  });

  test("custom: values that are both numbers compare as numbers, as PHP does, anything else by characters", () => {
    const custom = (extra: string, extraData: string, target = "userid") =>
      withRules(fl(), { "test-header": rule({ custom: [{ target, extra, extraData }] }) });
    const page = requests().page!;
    // The guest's user id is "0": equal to "00" and "0.0" as numbers, different as text.
    expect(choose(custom("!=", "00"), page)).toBe("page");
    expect(choose(custom("!=", "0.0"), page)).toBe("page");
    expect(choose(custom("!=", "1"), page)).toBe("test-header");
    expect(choose(custom("<", "10"), page)).toBe("test-header");
    expect(choose(custom("<=", "00"), page)).toBe("test-header");
    expect(choose(custom(">=", "00"), page)).toBe("test-header");
    expect(choose(custom(">", "00"), page)).toBe("page");
    expect(choose(custom("after", "-1"), page)).toBe("test-header");
    expect(choose(custom("before", "-1"), page)).toBe("page");
    // Text: "0" against "a" by characters.
    expect(choose(custom("<", "a"), page)).toBe("test-header");
    expect(choose(custom(">", "a"), page)).toBe("page");
  });

  test("custom: an ACF field of the current post, by name or by key", () => {
    const s0 = fl();
    const post = published(s0, "project").find((p) => {
      const meta = s0.model.postMeta.get(p.id) ?? {};
      return typeof meta.fp_title_1?.[0] === "string" && meta.fp_title_1[0] !== "";
    })!;
    const value = String(s0.model.postMeta.get(post.id)!.fp_title_1![0]);
    const key = String(s0.model.postMeta.get(post.id)!._fp_title_1![0]);
    const request: TemplateRequest = { kind: "single", post };
    const acf = (c: Rule) =>
      withRules(s0, {
        "test-header": rule({ custom: [{ target: "acf", acfLocation: "currentpost", ...c }] }),
      });
    expect(choose(acf({ field: "fp_title_1", extra: "===", extraData: value }), request)).toBe(
      "test-header",
    );
    expect(choose(acf({ field: key, extra: "===", extraData: value }), request)).toBe(
      "test-header",
    );
    expect(
      choose(acf({ field: "fp_title_1", extra: "===", extraData: `${value}!` }), request),
    ).toBe("single-project");
    expect(choose(acf({ field: "fp_title_1", extra: "!=", extraData: `${value}!` }), request)).toBe(
      "test-header",
    );
    expect(
      choose(
        acf({ field: "fp_title_1", extra: "contains", extraData: value.slice(1, 4) }),
        request,
      ),
    ).toBe("test-header");
    expect(
      choose(
        acf({ field: "fp_title_1", extra: "notcontain", extraData: value.slice(1, 4) }),
        request,
      ),
    ).toBe("single-project");
    expect(choose(acf({ field: "fp_title_1", extra: "notempty" }), request)).toBe("test-header");
    expect(choose(acf({ field: "fp_title_1", extra: "empty" }), request)).toBe("single-project");
    // The same on a post that has none.
    const bare = published(s0, "project").find(
      (p) => !s0.model.postMeta.get(p.id)?.fp_title_1?.[0],
    );
    if (bare) {
      expect(
        choose(acf({ field: "fp_title_1", extra: "empty" }), { kind: "single", post: bare }),
      ).toBe("test-header");
    }
    // A field of a post the request has none of: nothing static can say.
    const report = createReport();
    expect(
      choose(acf({ field: "fp_title_1", extra: "empty", acfLocation: "option" }), request, report),
    ).toBe("single-project");
    expect(report.entries().map((e) => e.code)).toContain("template.condition-unsupported");
  });

  test("custom: a condition about the clock is counted false and reported once per request", () => {
    const report = createReport();
    const s = withRules(fl(), {
      "test-header": rule({
        custom: [
          { target: "date", extra: "===", extraData: "01/01/2030" },
          { target: "dayweek", extra: "===", extraData: "Monday" },
          { target: "date", extra: "===", extraData: "01/01/2030" },
        ],
        includeCondition: "or",
      }),
    });
    expect(choose(s, requests().page!, report)).toBe("page");
    const found = report.entries().filter((e) => e.code === "template.condition-unsupported");
    expect(found.map((e) => e.data?.condition)).toEqual([
      "date === 01/01/2030",
      "dayweek === Monday",
    ]);
    expect(found[0]!.severity).toBe("warn");
    expect(found[0]!.where).toBe(`post:${quote().id}`);
    expect(found[0]!.data?.rule).toBe("include");
  });

  test("a rule about the visitor is decided for a guest and said once", () => {
    const report = createReport();
    const s = withRules(fl(), {
      "test-header": rule({ custom: [{ target: "loggedin", extra: "false" }] }),
    });
    choose(s, requests().page!, report);
    const found = report.entries().filter((e) => e.code === "template.condition-approximated");
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("info");
  });

  test("the highest priority wins, the first of equals", () => {
    const include = {
      single: rule({ all: "true", priority: 2 }),
      "test-header": rule({ all: "true", priority: 5 }),
      "archive-project": rule({ all: "true", priority: 5 }),
    };
    const s = withRules(fl(), include);
    expect(choose(s, requests().page!)).toBe("test-header");
    const flipped = withRules(fl(), {
      "archive-project": include["archive-project"]!,
      "test-header": include["test-header"]!,
      single: include.single!,
    });
    expect(choose(flipped, requests().page!)).toBe("archive-project");
    // No priority is 0: the first stored rule.
    const plain = withRules(fl(), {
      "test-header": rule({ all: "true" }),
      single: rule({ all: "true" }),
    });
    expect(choose(plain, requests().page!)).toBe("test-header");
  });

  test("a priority belongs to the rule even when the rule does not match", () => {
    // `single` has the top priority but does not match a search: the matching rule wins.
    const s = withRules(fl(), {
      single: rule({ singular: [{ target: "project", data: "all" }], priority: 9 }),
      "test-header": rule({ archive: [{ target: "search" }], priority: 1 }),
    });
    expect(choose(s, requests().search!)).toBe("test-header");
    expect(choose(s, requests().single!)).toBe("single");
  });

  test("an exclude rule takes a template off a request: `and` needs every entry, `or` any", () => {
    const include = { "test-header": rule({ all: "true" }) };
    const exclude = (e: Rule) => withRules(fl(), include, { "test-header": noExclude(e) });
    // exclude `all`: never.
    expect(choose(exclude({ all: "true" }), requests().page!)).toBe("page");
    // exclude one post type: the others keep the template.
    const type = exclude({ singular: [{ target: "project", data: "all" }] });
    expect(choose(type, requests().single!)).toBe("single-project");
    expect(choose(type, requests().page!)).toBe("test-header");
    // `and` over two entries needs both; `or` needs one.
    const entries = {
      singular: [{ target: "project", data: "all" }],
      archive: [{ target: "search" }],
    };
    const and = exclude({ ...entries, excludeCondition: "and" });
    expect(choose(and, requests().single!)).toBe("test-header");
    expect(choose(and, requests().search!)).toBe("test-header");
    const or = exclude({ ...entries, excludeCondition: "or" });
    expect(choose(or, requests().single!)).toBe("single-project");
    expect(choose(or, requests().search!)).toBe("search");
    // `all` with `and`: excluded only when the entries are true too.
    const allAnd = exclude({
      all: "true",
      singular: [{ target: "project", data: "all" }],
      excludeCondition: "and",
    });
    expect(choose(allAnd, requests().single!)).toBe("single-project");
    expect(choose(allAnd, requests().page!)).toBe("test-header");
  });

  test("a template with no exclude entry is never applied, and the report says so", () => {
    const report = createReport();
    const s = withRules(fl(), { "test-header": rule({ all: "true" }) }, {});
    expect(choose(s, requests().page!, report)).toBe("page");
    const found = report.entries().find((e) => e.code === "template.rule-no-exclude");
    expect(found?.severity).toBe("info");
    expect(found?.data?.template).toBe("test-header");
  });

  test("a rule for a template the theme does not have leaves WordPress's choice and says so", () => {
    const report = createReport();
    const s = withRules(fl(), { "no-such-template": rule({ all: "true" }) });
    expect(choose(s, requests().page!, report)).toBe("page");
    const found = report.entries().find((e) => e.code === "template.rule-missing");
    expect(found?.severity).toBe("warn");
    expect(found?.data?.template).toBe("no-such-template");
  });

  test("a page that names a page template keeps it unless the rule overrides", () => {
    const ap = site("ap");
    const about = postBySlug(ap, "page", "about");
    const request: TemplateRequest = { kind: "page", post: about };
    expect(choose(ap, request)).toBe("wp-custom-template-about-us");
    const keeps = withRules(ap, { "wp-custom-template-blank": rule({ all: "true" }) });
    expect(choose(keeps, request)).toBe("wp-custom-template-about-us");
    const overrides = withRules(ap, {
      "wp-custom-template-blank": rule({ all: "true", overridePageTemplate: true }),
    });
    expect(choose(overrides, request)).toBe("wp-custom-template-blank");
    // A page with no page template of its own takes the rule either way.
    const contact = postBySlug(ap, "page", "contact");
    expect(choose(keeps, { kind: "page", post: contact })).toBe("wp-custom-template-blank");
  });

  test("the status code a rule serves is reported, never applied", () => {
    const report = createReport();
    const s = withRules(fl(), {
      "404": rule({ singular: [{ target: "project", data: "all" }], statusCode: 410 }),
    });
    expect(choose(s, requests().single!, report)).toBe("404");
    const found = report.entries().find((e) => e.code === "template.status-code");
    expect(found?.data).toEqual({ template: "404", status: 410 });
  });

  test("a malformed rule (not an object, no lists) is skipped, not thrown", () => {
    const s = {
      ...fl(),
      options: {
        ...fl().options,
        conditions: {
          include: { "test-header": "yes", single: rule({ singular: "x", all: "true" }) },
          exclude: { single: noExclude() },
        },
      },
    } as LoadedSite;
    expect(choose(s, requests().page!)).toBe("single");
    expect(
      choose(
        { ...fl(), options: { ...fl().options, conditions: {} } } as LoadedSite,
        requests().page!,
      ),
    ).toBe("page");
  });
});

// ── What buildTemplates writes ───────────────────────────────────────────────────────────────────

const outputs = new Map<SiteName, TemplatesOutput>();
beforeAll(async () => {
  for (const name of SITES) {
    outputs.set(name, await buildTemplates(site(name)));
  }
});
const out = (name: SiteName): TemplatesOutput => outputs.get(name)!;

/** Every element of a parsed Jx document, depth first (`children` lists, a repeater's `map`). */
function* elementsOf(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* elementsOf(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record.tagName === "string") yield record;
  yield* elementsOf(record.children);
  yield* elementsOf(record.map);
  yield* elementsOf(record.cases);
}

const refsOf = (doc: Record<string, unknown>): string[] =>
  (Array.isArray(doc.$elements) ? doc.$elements : []).map((e) =>
    String((e as { $ref: string }).$ref),
  );

describe("buildTemplates over both fixture sites", () => {
  for (const name of SITES) {
    describe(name, () => {
      const s = () => site(name);

      test("writes each file once, as JSON, sorted by path", () => {
        const o = out(name);
        const paths = o.files.map((f) => f.path);
        expect(new Set(paths).size).toBe(paths.length);
        expect([...paths].sort()).toEqual(paths);
        for (const file of o.files) {
          expect(() => JSON.parse(file.content)).not.toThrow();
          expect(file.content.endsWith("\n")).toBe(true);
        }
      });

      test("is deterministic: a second run writes the same bytes", async () => {
        const again = await buildTemplates(s());
        expect(again.files).toEqual(out(name).files);
        expect(again.layouts).toEqual(out(name).layouts);
        expect(again.pages).toEqual(out(name).pages);
      });

      test("every published template has a layout, and the layout is a written file", () => {
        const o = out(name);
        const slugs = published(s(), "wp_template")
          .map((p) => p.slug)
          .sort();
        expect(Object.keys(o.layouts).sort()).toEqual(slugs);
        const written = new Set(o.files.map((f) => f.path));
        for (const [slug, path] of Object.entries(o.layouts)) {
          expect(path).toBe(
            layoutPathOf(
              s(),
              slug,
              isPageTemplate(slug) || path.endsWith("-frame.json") ? "slotted" : "frame",
            ),
          );
          expect(written.has(path.replace(/^\.\//, ""))).toBe(true);
        }
        for (const path of Object.values(o.frames))
          expect(written.has(path.replace(/^\.\//, ""))).toBe(true);
        expect(o.base).toBe(BASE_LAYOUT);
        expect(written.has("layouts/base.json")).toBe(true);
      });

      test("every template part is a component named by partTag, with a display: contents host", () => {
        const o = out(name);
        const slugs = published(s(), "wp_template_part")
          .map((p) => p.slug)
          .sort();
        expect(o.parts.map((p) => p.slug).sort()).toEqual(slugs);
        for (const part of o.parts) {
          expect(part.tag).toBe(partTag(s(), part.slug));
          expect(part.file).toBe(`components/${part.tag}.json`);
          const doc = docOf(o, part.file);
          expect(doc.tagName).toBe(part.tag);
          expect(part.tag).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/);
          expect((doc.style as Record<string, unknown>).display).toBe("contents");
          expect(Array.isArray(doc.children)).toBe(true);
        }
      });

      test("reusable blocks are components: the published ones with content, no others", () => {
        const o = out(name);
        const wanted = published(s(), "wp_block").filter(
          (p) => p.content.trim() !== "" && !p.passwordProtected,
        );
        expect(o.reusables.map((r) => r.id)).toEqual(wanted.map((p) => p.id).sort((a, b) => a - b));
        for (const r of o.reusables) {
          expect(r.file).toBe(`components/${r.tag}.json`);
          expect(docOf(o, r.file).tagName).toBe(r.tag);
        }
        const skipped = o.report.entries().filter((e) => e.code === "template.reusable-skipped");
        const all = [...s().model.posts.values()].filter((p) => p.type === "wp_block");
        expect(skipped.length + o.reusables.length).toBe(all.length);
        for (const e of skipped) expect(e.where).toMatch(/^post:\d+$/);
      });

      test("no placeholder element is left in any file", () => {
        for (const [path, doc] of jsonFiles(out(name))) {
          for (const element of elementsOf(doc.children)) {
            expect([path, String(element.tagName).startsWith("wp2jx-")]).toEqual([path, false]);
          }
        }
        expect(
          out(name)
            .report.entries()
            .filter((e) => e.code.startsWith("placeholder.")),
        ).toEqual([]);
      });

      test("every $layout is a written layout and every $elements ref is a written component or a site component", () => {
        const o = out(name);
        const files = jsonFiles(o);
        const siteTagsSet = new Set([...s().components.values()].map((c) => c.tagName));
        for (const [path, doc] of files) {
          if (typeof doc.$layout === "string") {
            expect(files.has(String(doc.$layout).replace(/^\.\//, ""))).toBe(true);
          }
          for (const ref of refsOf(doc)) {
            const target = posix.normalize(posix.join(posix.dirname(path), ref));
            const tag = posix.basename(target, ".json");
            expect([path, files.has(target) || siteTagsSet.has(tag)]).toEqual([path, true]);
          }
        }
        for (const tag of o.used.components) {
          expect(files.has(`components/${tag}.json`) || siteTagsSet.has(tag)).toBe(true);
        }
      });

      test("a document's $elements list every component its nodes use, and only those", () => {
        const o = out(name);
        const known = new Set([
          ...o.parts.map((p) => p.tag),
          ...o.reusables.map((r) => r.tag),
          ...[...s().components.values()].map((c) => c.tagName),
        ]);
        for (const [path, doc] of jsonFiles(o)) {
          if (path.startsWith("content/")) continue;
          const used = new Set<string>();
          for (const element of elementsOf(doc.children)) {
            if (known.has(String(element.tagName)) && element.tagName !== doc.tagName)
              used.add(String(element.tagName));
          }
          const listed = new Set(refsOf(doc).map((r) => posix.basename(r, ".json")));
          expect([path, [...listed].sort()]).toEqual([path, [...used].sort()]);
        }
      });

      test("the report holds no error, and every entry has a code, a message and a location", () => {
        const entries = out(name).report.entries();
        expect(entries.filter((e) => e.severity === "error")).toEqual([]);
        for (const e of entries) {
          expect(e.code).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
          expect(e.message.length).toBeGreaterThan(10);
          expect(e.where).toBeDefined();
        }
        const mine = entries.filter((e) => e.code.startsWith("template."));
        expect(mine.length).toBeGreaterThan(0);
        for (const e of mine)
          expect(e.where).toMatch(
            /^(template|post|route|term|author|archive|option|site|content|pages|taxonomy)[:/]?/,
          );
      });
    });
  }
});

// ── Layouts ──────────────────────────────────────────────────────────────────────────────────────

const tagsOfLayout = (doc: Record<string, unknown>): string[] =>
  childrenOf(doc).map((n) => (typeof n === "string" ? n : String(n.tagName)));

/** The first element anywhere under `nodes` with a tag. */
const findTag = (nodes: unknown, tag: string): Record<string, unknown> | undefined => {
  for (const element of elementsOf(nodes)) if (element.tagName === tag) return element;
  return undefined;
};

describe("layouts", () => {
  test("fineline: the page layout is the header, the template's content box around the slot, the footer", () => {
    const o = out("fineline");
    const doc = docOf(o, "layouts/page.json");
    expect(doc.$layout).toBe(BASE_LAYOUT);
    expect(refsOf(doc)).toEqual(["../components/wp-footer.json", "../components/wp-header.json"]);
    const kids = childrenOf(doc) as JxElement[];
    expect(kids.map((k) => k.tagName)).toEqual(["wp-header", "div", "wp-footer"]);
    // The box is the template's `cwicly/content` block (`content-cd27ea0`), and the page's body is in it.
    expect(kids[1]!.className).toBe("content-cd27ea0");
    expect(kids[1]!.children).toEqual([{ tagName: "slot" }]);
    expect(slotsIn(kids)).toBe(1);
  });

  test("fineline: a template that is only chrome is the header, one slot and the footer", () => {
    const o = out("fineline");
    for (const slug of [
      "index",
      "single",
      "single-project",
      "single-service",
      "archive-project",
      "archive-service",
      "taxonomy-project_tag",
      "taxonomy-project_type",
      "taxonomy-location",
      "404",
      "search",
    ]) {
      const doc = docOf(o, `layouts/${slug}.json`);
      expect([slug, tagsOfLayout(doc)]).toEqual([slug, ["wp-header", "slot", "wp-footer"]]);
      expect(doc.$layout).toBe(BASE_LAYOUT);
    }
  });

  test("fineline: the test template's group and post content become a main around the slot", () => {
    const doc = docOf(out("fineline"), "layouts/test-header.json");
    const kids = childrenOf(doc) as JxElement[];
    expect(kids.map((k) => k.tagName)).toEqual(["wp-header-updated-menu", "main", "wp-footer"]);
    expect(slotsIn(kids)).toBe(1);
    expect(findTag(kids, "slot")).toBeDefined();
  });

  test("fineline: the base layout opens with the custom code's noscript and wraps the slot in div.wp-site-blocks", () => {
    const doc = docOf(out("fineline"), "layouts/base.json");
    const kids = childrenOf(doc) as JxElement[];
    expect(kids[0]!.tagName).toBe("noscript");
    const iframe = findTag(kids, "iframe")!;
    expect((iframe.attributes as Record<string, string>).src).toContain(
      "googletagmanager.com/ns.html?id=GTM-PHFM9WJ",
    );
    // The inline style the snippet came with is kept as the attribute, not scoped to a class.
    expect((iframe.attributes as Record<string, string>).style).toContain("display:none");
    const wrapper = kids.find((k) => k.className === "wp-site-blocks")!;
    expect(wrapper.tagName).toBe("div");
    expect(wrapper.children).toEqual([{ tagName: "slot" }]);
    expect(slotsIn(kids)).toBe(1);
  });

  test("ap: the base layout is only the wrapper (the site has no custom code)", () => {
    const doc = docOf(out("ap"), "layouts/base.json");
    expect(childrenOf(doc)).toEqual([
      { tagName: "div", className: "wp-site-blocks", children: [{ tagName: "slot" }] },
    ]);
    expect(doc.$elements).toBeUndefined();
  });

  test("ap: the page layout prints the title and the breadcrumb the template had, bound to the page's own entry", () => {
    const doc = docOf(out("ap"), "layouts/page.json");
    const kids = childrenOf(doc) as JxElement[];
    expect(kids.map((k) => k.tagName)).toEqual(["wp-header", "section", "wp-footer"]);
    const h1 = findTag(kids, "h1")!;
    expect(h1.textContent).toBe("${state.entry.data.title ?? ''}");
    const nav = findTag(kids, "nav")!;
    expect(nav.className).toBe("rank-math-breadcrumb");
    expect((nav.attributes as Record<string, string>)["aria-label"]).toBe("breadcrumbs");
    expect(String((nav.children as JxElement[])[0]!.innerHTML)).toContain(
      '<a href="/">Home</a><span class="separator"> &raquo; </span><span class="last">',
    );
    expect(slotsIn(kids)).toBe(1);
    // The slot sits where the template's content block was: after the heading and the breadcrumb.
    const wrapper = (kids[1]!.children as JxElement[])[0]!;
    expect((wrapper.children as JxElement[]).map((c) => c.tagName)).toEqual(["h1", "nav", "div"]);
  });

  test("ap: a page layout whose template is only post content has the slot in the content's own box", () => {
    const doc = docOf(out("ap"), "layouts/front-page.json");
    const kids = childrenOf(doc) as JxElement[];
    expect(kids.map((k) => k.tagName)).toEqual(["wp-header", "div", "wp-footer"]);
    expect(String(kids[1]!.className).split(" ")).toEqual(
      expect.arrayContaining(["wp-block-post-content", "entry-content"]),
    );
    expect(kids[1]!.children).toEqual([{ tagName: "slot" }]);
  });

  test("ap: a template with no header part has none, and the others keep the part they name", () => {
    const o = out("ap");
    expect(tagsOfLayout(docOf(o, "layouts/wp-custom-template-blank.json"))).toEqual([
      "section",
      "wp-footer",
    ]);
    expect(tagsOfLayout(docOf(o, "layouts/wp-custom-template-full-width.json"))).toEqual([
      "wp-header",
      "div",
      "wp-footer",
    ]);
    // about-us has a header-light inside the first block.
    const about = docOf(o, "layouts/wp-custom-template-about-us.json");
    expect(refsOf(about)).toContain("../components/wp-header-light.json");
  });

  test("ap: single-post keeps the header part nested in its first block, with the hero that shares the box", () => {
    const o = out("ap");
    const doc = docOf(o, "layouts/single-post.json");
    expect(doc.$layout).toBe(BASE_LAYOUT);
    expect(refsOf(doc)).toEqual([
      "../components/wp-footer.json",
      "../components/wp-header-light.json",
    ]);
    const kids = childrenOf(doc) as JxElement[];
    expect(kids.map((k) => k.tagName)).toEqual(["div", "slot", "wp-footer"]);
    expect(kids[0]!.className).toContain("div-c4eb023");
    expect(findTag(kids[0], "wp-header-light")).toBeDefined();
    expect(slotsIn(kids)).toBe(1);
    // The hero reads the entry through the page's own state (the layout is only used by entry pages).
    expect(JSON.stringify(kids[0])).toContain("state.entry.data.featuredImage");
    // The PDF plugin's markers print nothing and are gone, the opening one as a placeholder, the closing one as text.
    expect(fileOf(o, "layouts/single-post.json")).not.toContain("dkpdf");
    const reasons = o.report.entries().filter((e) => e.code === "template.shortcode-empty");
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.map((e) => e.severity)).toEqual(reasons.map(() => "info"));
  });

  test("ap: the part components nest: the header holds the top menu and the mobile menu through $elements", () => {
    const o = out("ap");
    const header = docOf(o, "components/wp-header.json");
    expect(refsOf(header).sort()).toEqual(["./wp-top-menu.json"]);
    const footer = docOf(o, "components/wp-footer.json");
    expect(refsOf(footer)).toContain("./wp-mobile-menu.json");
  });

  test("ap: a part keeps the state its conversion registered (the footer's list of terms), and a component that holds itself does not list itself", async () => {
    const o = out("ap");
    const footer = docOf(o, "components/wp-footer.json");
    expect(Object.keys(footer.state as object).some((k) => k.startsWith("terms_category"))).toBe(
      true,
    );
    expect([...o.used.states].some((k) => k.startsWith("terms_category"))).toBe(true);
    expect(docOf(o, "components/wp-header.json").state).toBeUndefined();
    // A part whose own blocks name the part again: the instance inside is fine, a reference to itself in $elements is not.
    const s = site("ap");
    const self = await buildTemplates(s, {
      only: ["404"],
      convert: async (_s, subject, opts) => {
        const converted = await convertSubject(s, subject, opts);
        if (subject.kind !== "part" || subject.slug !== "top-menu") return converted;
        return { ...converted, nodes: [...converted.nodes, part("top-menu")] };
      },
    });
    const doc = docOf(self, "components/wp-top-menu.json");
    expect(refsOf(doc)).toEqual([]);
    expect(JSON.stringify(doc.children)).toContain('"tagName":"wp-top-menu"');
  });

  test("the part of a template with no area is not mistaken for a header or a footer", () => {
    expect(partArea(site("ap"), "header")).toBe("header");
    expect(partArea(site("ap"), "header-light")).toBe("header");
    expect(partArea(site("ap"), "footer")).toBe("footer");
    expect(partArea(site("ap"), "mobile-menu")).toBe("other");
    expect(partArea(site("ap"), "top-menu")).toBe("other");
    expect(partArea(site("ap"), "comments")).toBe("other");
    expect(partArea(site("ap"), "no-such-part")).toBe("other");
  });

  test("a template that serves pages and everything else is two layouts, the second named -frame", () => {
    const s = site("fineline");
    // Without a `page` template the pages fall through `singular` to `index`, which the blog also uses.
    const edited = withModel(s, (posts) => {
      for (const [id, post] of posts)
        if (post.type === "wp_template" && post.slug === "page") posts.delete(id);
    });
    return buildTemplates(edited).then((o) => {
      expect(o.layouts.index).toBe("./layouts/index.json");
      expect(o.frames.index).toBe("./layouts/index-frame.json");
      expect(layoutPathOf(edited, "index", "slotted")).toBe("./layouts/index.json");
      expect(layoutPathOf(edited, "index", "frame")).toBe("./layouts/index-frame.json");
      expect(o.layouts.page).toBeUndefined();
      // The page layout has the body's slot where the template's content stood; the frame has chrome and a slot.
      expect(slotsIn(childrenOf(docOf(o, "layouts/index.json")))).toBe(1);
      expect(tagsOfLayout(docOf(o, "layouts/index-frame.json"))).toEqual([
        "wp-header",
        "slot",
        "wp-footer",
      ]);
      // Pages and the blog each get the one that suits them.
      const home = postBySlug(edited, "page", "about-us");
      expect(layoutFor(edited, { kind: "post", id: home.id })).toBe("./layouts/index.json");
      const blog = o.pages.find((p) => p.kind === "posts")!;
      expect(blog.layout).toBe("./layouts/index-frame.json");
      expect(docOf(o, blog.file).$layout).toBe("./layouts/index-frame.json");
    });
  });
});

describe("layoutFor", () => {
  for (const name of SITES) {
    test(`${name}: a page's layout is the one the hierarchy gives it, and a layout that is written`, () => {
      const s = site(name);
      const o = out(name);
      const written = new Set(o.files.map((f) => f.path));
      for (const page of published(s, "page")) {
        const subject: Subject = { kind: "post", id: page.id };
        const path = layoutFor(s, subject);
        expect(path).toBe(hierarchyLayout(s, subject)?.path);
        expect(written.has(String(path).replace(/^\.\//, ""))).toBe(true);
        expect(templateFor(s, subject)?.slug).toBe(hierarchyLayout(s, subject)?.template);
      }
    });
  }

  test("an entry's layout is the chrome of its single template, and the entry page carries it", () => {
    const s = site("ap");
    const o = out("ap");
    const entry = published(s, "post")[0]!;
    expect(layoutFor(s, { kind: "post", id: entry.id })).toBe("./layouts/single-post.json");
    const page = o.pages.find((p) => p.file === "pages/essays/[slug].json")!;
    expect(page.layout).toBe("./layouts/single-post.json");
    const episode = published(s, "episode")[0]!;
    expect(layoutFor(s, { kind: "post", id: episode.id })).toBe("./layouts/single-episode.json");
  });

  test("a template's own layout, and undefined for what is not routed", () => {
    const s = site("fineline");
    expect(layoutFor(s, { kind: "template", slug: "page" })).toBe("./layouts/page.json");
    expect(layoutFor(s, { kind: "template", slug: "single-project" })).toBe(
      "./layouts/single-project.json",
    );
    expect(layoutFor(s, { kind: "template", slug: "no-such" })).toBeUndefined();
    expect(layoutFor(s, { kind: "part", slug: "header" })).toBeUndefined();
    expect(layoutFor(s, { kind: "component", ref: "0a275b695a" })).toBeUndefined();
    expect(layoutFor(s, { kind: "reusable", id: 63 })).toBeUndefined();
    expect(layoutFor(s, { kind: "post", id: 999999 })).toBeUndefined();
    expect(templateFor(s, { kind: "post", id: 999999 })).toBeUndefined();
  });

  test("a site with no template for a page has no layout for it", () => {
    const s = site("fineline");
    const bare = withModel(s, (posts) => {
      for (const [id, post] of posts) if (post.type === "wp_template") posts.delete(id);
    });
    const about = postBySlug(bare, "page", "about-us");
    expect(layoutFor(bare, { kind: "post", id: about.id })).toBeUndefined();
  });

  test("pages.ts asks this module by default: the layout it writes is the one layoutFor gives", async () => {
    const s = site("fineline");
    const only = published(s, "page")
      .slice(0, 3)
      .map((p) => p.id);
    const pages = await buildPages(s, { only });
    for (const info of pages.pages) {
      expect(info.layout).toBe(layoutFor(s, { kind: "post", id: info.id }) ?? null);
    }
    expect(pages.report.entries().some((e) => e.code === "page.layout-hierarchy")).toBe(false);
  });
});

// ── Pages ────────────────────────────────────────────────────────────────────────────────────────

/** The page each route family is, and the template that renders it (the live pages' own, as observed above). */
const PAGES: Record<SiteName, Record<string, { kind: PageKind; template: string }>> = {
  fineline: {
    "pages/404.json": { kind: "404", template: "404" },
    "pages/search.json": { kind: "search", template: "search" },
    "pages/blog.json": { kind: "posts", template: "index" },
    "pages/projects.json": { kind: "archive", template: "archive-project" },
    "pages/services.json": { kind: "archive", template: "archive-service" },
    "pages/[slug].json": { kind: "entry", template: "single" },
    "pages/project/[slug].json": { kind: "entry", template: "single-project" },
    "pages/service/[slug].json": { kind: "entry", template: "single-service" },
    "pages/author/[slug].json": { kind: "author", template: "index" },
    "pages/category/[slug].json": { kind: "term", template: "index" },
    "pages/tag/[slug].json": { kind: "term", template: "index" },
    "pages/service-type/[slug].json": { kind: "term", template: "index" },
    "pages/project_tag/[slug].json": { kind: "term", template: "taxonomy-project_tag" },
    "pages/project_type/[slug].json": { kind: "term", template: "taxonomy-project_type" },
    "pages/service_area/[slug].json": { kind: "term", template: "taxonomy-location" },
  },
  ap: {
    "pages/404.json": { kind: "404", template: "404" },
    "pages/search.json": { kind: "search", template: "search" },
    "pages/essays.json": { kind: "posts", template: "index" },
    "pages/essays/[slug].json": { kind: "entry", template: "single-post" },
    "pages/episodes/[slug].json": { kind: "entry", template: "single-episode" },
    "pages/supporters_update/[slug].json": { kind: "entry", template: "single-supporters_update" },
    "pages/people/[slug].json": { kind: "author", template: "author" },
    "pages/category/[slug].json": { kind: "term", template: "archive" },
    "pages/essays/season/[slug].json": { kind: "term", template: "archive" },
    "pages/essays/series/[slug].json": { kind: "term", template: "taxonomy-series" },
    "pages/tag/[slug].json": { kind: "term", template: "tag" },
  },
};

/** The `<title>` of live pages as WordPress printed them, with the live site's name (the fixture database names the site differently). */
const LIVE_NAME: Record<SiteName, string> = {
  fineline: "Fine Line Painting",
  ap: "Anabaptist Perspectives",
};
const LIVE_TITLES: { site: SiteName; page: string; term?: [string, string]; title: string }[] = [
  { site: "fineline", page: "pages/projects.json", title: "Projects - Fine Line Painting" },
  { site: "fineline", page: "pages/services.json", title: "Services - Fine Line Painting" },
  { site: "fineline", page: "pages/404.json", title: "Page Not Found - Fine Line Painting" },
  {
    site: "fineline",
    page: "pages/project_tag/[slug].json",
    term: ["project_tag", "agricultural-projects"],
    title: "Agricultural Projects Archives - Fine Line Painting",
  },
  { site: "ap", page: "pages/404.json", title: "Page not found - Anabaptist Perspectives" },
  {
    site: "ap",
    page: "pages/tag/[slug].json",
    term: ["post_tag", "work"],
    title: "Work Archives - Anabaptist Perspectives",
  },
  {
    site: "ap",
    page: "pages/essays/series/[slug].json",
    term: ["series", "a-knock-heard-round-the-hood"],
    title: "A Knock Heard Round the Hood Archives - Anabaptist Perspectives",
  },
];

const titleOf = (name: SiteName, live: string): string =>
  live.replace(LIVE_NAME[name], site(name).model.site.name.replaceAll("&amp;", "&"));

describe("the pages of the routes that are not pages", () => {
  for (const name of SITES) {
    describe(name, () => {
      const s = () => site(name);

      test("one page per route family: the dynamic pages of the route table, the posts index, the archives, the 404 and the search", () => {
        const o = out(name);
        expect(
          Object.fromEntries(o.pages.map((p) => [p.file, { kind: p.kind, template: p.template }])),
        ).toEqual(PAGES[name]);
        const dynamic = s()
          .routes.dynamicPages()
          .map((d) => d.file);
        for (const file of dynamic) expect(PAGES[name][file]).toBeDefined();
        for (const route of s().routes.all()) {
          if (route.kind === "posts-page" || route.kind === "post-archive") {
            expect(o.pages.find((p) => p.file === route.file)?.route).toBe(route.jxRoute);
          }
        }
        expect(o.notFound).toBe("pages/404.json");
      });

      test("each page carries its template's layout and is written", () => {
        const o = out(name);
        for (const page of o.pages) {
          expect(page.layout).toBe(layoutPathOf(s(), page.template, "frame"));
          expect(docOf(o, page.file).$layout).toBe(page.layout);
          expect(Object.values(o.layouts).concat(Object.values(o.frames))).toContain(page.layout);
        }
      });

      test("an entry page reads its entry through the dynamic page's own $paths, with no client runtime", () => {
        const o = out(name);
        for (const dp of s()
          .routes.dynamicPages()
          .filter((d) => d.kind === "entries")) {
          const doc = docOf(o, dp.file);
          expect(doc.$paths).toEqual(dp.paths);
          const entry = (doc.state as Record<string, Record<string, unknown>>).entry!;
          expect(entry).toEqual({
            $prototype: "ContentEntry",
            contentType: (dp.paths as { contentType: string }).contentType,
            id: { $ref: `#/$params/${dp.param}` },
            $src: "@jxsuite/parser/ContentEntry.class.json",
            timing: "compiler",
          });
          expect(doc.title).toBe(
            "${state.entry.data.seo?.title || state.entry.data.title || state.entry.data.name || ''}",
          );
          // Every collection a conversion registered is compile-time too, so the page ships no JavaScript.
          for (const [key, value] of Object.entries(
            doc.state as Record<string, Record<string, unknown>>,
          )) {
            if (value.$prototype) expect([key, value.timing]).toEqual([key, "compiler"]);
          }
          expect((doc.$head as { tagName: string }[]).length).toBeGreaterThan(8);
        }
      });

      test("an entry page's head binds Rank Math's answer from the entry's seo, and omits what the entry has none of", () => {
        const o = out(name);
        const dp = s()
          .routes.dynamicPages()
          .find((d) => d.kind === "entries")!;
        const head = docOf(o, dp.file).$head as {
          tagName: string;
          attributes: Record<string, string>;
        }[];
        const byKey = new Map(
          head.map((h) => [h.attributes.name ?? h.attributes.property ?? h.attributes.rel!, h]),
        );
        // `$head` cannot omit an attribute (`false` prints the word): a value the entry lacks is empty.
        expect(byKey.get("description")!.attributes.content).toBe(
          "${state.entry.data.seo?.description ?? ''}",
        );
        expect(byKey.get("robots")!.attributes.content).toBe(
          "${state.entry.data.seo?.robots ?? ''}",
        );
        expect(byKey.get("canonical")!.attributes.href).toBe(
          `${s().model.site.home}\${state.entry.data.url ?? ''}`,
        );
        expect(byKey.get("og:url")!.attributes.content).toBe(
          `${s().model.site.home}\${state.entry.data.url ?? ''}`,
        );
        expect(byKey.get("og:type")!.attributes.content).toBe("article");
        expect(byKey.get("og:title")!.attributes.content).toBe(
          "${state.entry.data.seo?.title || state.entry.data.title || state.entry.data.name || ''}",
        );
        expect(byKey.get("twitter:card")!.attributes.content).toBe("summary_large_image");
        expect(byKey.get("og:image:width")!.attributes.content).toBe(
          "${state.entry.data.seo?.image?.width ?? ''}",
        );
      });

      test("a term page reads its term from a JSON collection of the taxonomy: one data file per routed term", () => {
        const o = out(name);
        const written = new Map(o.files.map((f) => [f.path, f.content]));
        for (const dp of s()
          .routes.dynamicPages()
          .filter((d) => d.kind === "terms")) {
          const doc = docOf(o, dp.file);
          expect(doc.$paths).toEqual(dp.paths);
          const collection = (doc.state as Record<string, Record<string, string>>).term!
            .contentType!;
          expect(o.collections[collection]).toEqual({
            source: `content/${collection}`,
            format: "json",
            schema: expect.objectContaining({
              type: "object",
              required: ["id", "name", "slug", "taxonomy"],
            }),
          });
          expect((doc.state as Record<string, unknown>).term).toEqual({
            $prototype: "ContentEntry",
            contentType: collection,
            id: { $ref: `#/$params/${dp.param}` },
            $src: "@jxsuite/parser/ContentEntry.class.json",
            timing: "compiler",
          });
          const values = (dp.paths as { values: string[] }).values;
          for (const route of dp.routes) {
            const term = s().model.terms.get(Number(route.id))!;
            const value = values.find((v) => route.jxRoute.endsWith(`/${v}/`))!;
            const data = JSON.parse(written.get(`content/${collection}/${value}.json`)!);
            expect(data.id).toBe(value);
            expect(data.slug).toBe(term.slug);
            expect(data.taxonomy).toBe(term.taxonomy);
            expect(data.url).toBe(route.jxRoute);
            expect(typeof data.name).toBe("string");
            expect(data.seo.title.length).toBeGreaterThan(0);
          }
          expect(o.files.filter((f) => f.path.startsWith(`content/${collection}/`))).toHaveLength(
            values.length,
          );
        }
      });

      test("an author page reads its author from a JSON collection too", () => {
        const o = out(name);
        const dp = s()
          .routes.dynamicPages()
          .find((d) => d.kind === "authors")!;
        const doc = docOf(o, dp.file);
        expect(doc.$paths).toEqual(dp.paths);
        expect(o.collections.author?.format).toBe("json");
        const route = dp.routes[0]!;
        const user = s().model.users.get(Number(route.id))!;
        const value = (dp.paths as { values: string[] }).values.find((v) =>
          route.jxRoute.endsWith(`/${v}/`),
        )!;
        const data = JSON.parse(fileOf(o, `content/author/${value}.json`));
        expect(data).toMatchObject({
          id: value,
          slug: user.slug,
          name: user.displayName,
          author: user.displayName,
          authorUrl: route.jxRoute,
          url: route.jxRoute,
        });
        // The author page converts as an entry of the author (the tokens read `state.author.data.author`).
        expect((doc.state as Record<string, { contentType: string }>).author!.contentType).toBe(
          "author",
        );
      });

      test("the 404 and the search are not in the sitemap, say noindex, and are written with the site's own titles", () => {
        const o = out(name);
        for (const file of ["pages/404.json", "pages/search.json"]) {
          const doc = docOf(o, file);
          expect(doc.$sitemap).toBe(false);
          expect(doc.$head).toEqual([
            { tagName: "meta", attributes: { name: "robots", content: "noindex, follow" } },
          ]);
        }
        expect(docOf(o, "pages/404.json").title).toBe(
          titleOf(
            name,
            LIVE_TITLES.find((t) => t.site === name && t.page === "pages/404.json")!.title,
          ),
        );
        expect(docOf(o, "pages/search.json").title).toBe(
          `Search - ${s().model.site.name.replaceAll("&amp;", "&")}`,
        );
        const e = o.report.entries().find((x) => x.code === "template.404-location")!;
        expect(e.severity).toBe("warn");
        expect(e.data).toEqual({
          file: "pages/404.json",
          built: "404/index.html",
          hostsWant: "404.html",
        });
        expect(e.message).toContain("404.html");
      });

      test("the posts index and the archives take Rank Math's title, as the committed live page prints it", () => {
        const o = out(name);
        const posts = o.pages.find((p) => p.kind === "posts")!;
        const live = readFileSync(
          `${fixtureDir(name)}/html/${name === "fineline" ? "blog" : "essays"}.html`,
          "utf8",
        );
        const liveTitle = /<title>([^<]*)<\/title>/.exec(live)![1]!;
        // The committed page and the database are one snapshot: the title is the same character for character.
        expect(String(docOf(o, posts.file).title)).toBe(liveTitle.replaceAll("&amp;", "&"));
      });

      test("every title of a live page that is not a fixture is the title the data holds", () => {
        const o = out(name);
        for (const row of LIVE_TITLES.filter((t) => t.site === name && t.term)) {
          const dp = s()
            .routes.dynamicPages()
            .find((d) => d.file === row.page)!;
          const term = termBySlug(s(), row.term![0], row.term![1]);
          const value = (dp.paths as { values: string[] }).values.find((v) => v === term.slug)!;
          const collection = (docOf(o, row.page).state as Record<string, { contentType: string }>)
            .term!.contentType;
          const data = JSON.parse(fileOf(o, `content/${collection}/${value}.json`));
          expect(data.seo.title).toBe(titleOf(name, row.title));
        }
        for (const row of LIVE_TITLES.filter(
          (t) => t.site === name && !t.term && t.page !== "pages/404.json",
        )) {
          expect(docOf(o, row.page).title).toBe(titleOf(name, row.title));
        }
      });

      test("no page ships a binding where the build never reads one", () => {
        const o = out(name);
        expect(o.report.entries().filter((e) => e.code === "template.binding-misplaced")).toEqual(
          [],
        );
        for (const page of o.pages) {
          const text = fileOf(o, page.file);
          // docs/bindings.md rule 5: never a binding in a className or an id.
          expect(text).not.toMatch(/"(?:className|id)": "[^"]*\$\{/);
        }
      });

      test("term data holds the texts as WordPress prints them and nothing that would be read as a binding", () => {
        const o = out(name);
        for (const f of o.files) {
          if (!f.path.startsWith("content/")) continue;
          expect(f.content).not.toContain("${");
        }
      });
    });
  }

  test("fineline: the location terms carry their ACF term fields, in the entry data contract's shapes", () => {
    const o = out("fineline");
    const adams = JSON.parse(fileOf(o, "content/location/adams-county-pa.json"));
    expect(adams.name).toBe("Adams County, PA");
    const richer = JSON.parse(fileOf(o, "content/location/berks-county-pa.json"));
    expect(Object.keys(richer).length).toBeGreaterThan(Object.keys(adams).length);
    // Keys are written sorted, so two runs write the same bytes.
    expect(Object.keys(richer)).toEqual(Object.keys(richer).sort());
  });
});

// ── The parts every page of a template reaches ───────────────────────────────────────────────────

/** The files a request is rendered from in the output: its layout, the page that holds its body, and everything they instantiate. */
function reachedParts(name: SiteName, request: TemplateRequest, path: string): string[] {
  const s = site(name);
  const o = out(name);
  const files = jsonFiles(o);
  const choice = selectTemplate(s, request);
  const start: string[] = [];
  const dynamicFor = (kind: string, id: number) =>
    s.routes
      .dynamicPages()
      .find((d) => d.kind === kind && d.routes.some((r) => Number(r.id) === id))!.file;
  switch (request.kind) {
    case "page":
      start.push(layoutPathOf(s, choice.slug, "slotted"));
      break;
    case "single":
      start.push(layoutPathOf(s, choice.slug, "frame"), dynamicFor("entries", request.post.id));
      break;
    case "term":
      start.push(layoutPathOf(s, choice.slug, "frame"), dynamicFor("terms", request.term.termId));
      break;
    case "author":
      start.push(layoutPathOf(s, choice.slug, "frame"), dynamicFor("authors", request.user.id));
      break;
    case "posts":
      start.push(
        layoutPathOf(s, choice.slug, "frame"),
        o.pages.find((p) => p.kind === "posts")!.file,
      );
      break;
    case "post-archive":
      start.push(layoutPathOf(s, choice.slug, "frame"), s.routes.byWpPath(path)!.file);
      break;
    case "search":
      start.push(layoutPathOf(s, choice.slug, "frame"), "pages/search.json");
      break;
    case "404":
      start.push(layoutPathOf(s, choice.slug, "frame"), "pages/404.json");
      break;
  }
  const seen = new Set<string>();
  const todo = start.map((p) => p.replace(/^\.\//, ""));
  // Layouts nest through $layout, documents through $elements.
  while (todo.length > 0) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const doc = files.get(file);
    if (!doc) continue;
    if (typeof doc.$layout === "string") todo.push(String(doc.$layout).replace(/^\.\//, ""));
    for (const ref of refsOf(doc)) todo.push(posix.normalize(posix.join(posix.dirname(file), ref)));
  }
  const slugOf = new Map(o.parts.map((p) => [p.file, p.slug]));
  return [...seen]
    .map((f) => slugOf.get(f))
    .filter((x): x is string => x !== undefined)
    .sort();
}

describe("the template parts a page reaches are the ones its live head loads", () => {
  for (const row of LIVE) {
    test(`${row.site} ${row.path}: ${row.parts.join(", ")}`, () => {
      const request = requestOf(site(row.site), row.path);
      expect(reachedParts(row.site, request, row.path)).toEqual(row.parts);
    });
  }
  for (const row of FIXTURE_PAGES) {
    test(`${row.site} ${row.path} (committed page)`, () => {
      const seen = observedIn(row.site, row.file);
      const request = requestOf(site(row.site), row.path);
      // An entry's body is the entry page: the parts are the layout's and the body's together.
      expect(reachedParts(row.site, request, row.path)).toEqual(seen.parts);
    });
  }
});

// ── The pieces ───────────────────────────────────────────────────────────────────────────────────

const el = (tagName: string, extra: Partial<JxElement> = {}): JxElement =>
  ({ tagName, ...extra }) as JxElement;
const part = (slug: string): JxElement =>
  el("wp2jx-template-part", {
    attributes: { "data-block": "core/template-part", slug, theme: "cwicly" },
  });
const ENTRY_BODY = "${state.entry.$children ?? []}";
const body = (): JxElement => el("div", { children: ENTRY_BODY as unknown as JxNode[] });

describe("splitChrome", () => {
  test("fineline: a template of header, one block and footer is cut into the three", async () => {
    const converted = await convertSubject(site("fineline"), { kind: "template", slug: "index" });
    const cut = splitChrome(site("fineline"), converted.nodes);
    expect(cut.unsplit).toBeUndefined();
    expect(cut.prefix).toHaveLength(1);
    expect(cut.body).toHaveLength(1);
    expect(cut.suffix).toHaveLength(1);
    expect((cut.prefix[0] as JxElement).attributes).toMatchObject({ slug: "header" });
    expect((cut.suffix[0] as JxElement).attributes).toMatchObject({ slug: "footer" });
    expect((cut.body[0] as JxElement).tagName).toBe("section");
  });

  test("ap: a header part nested in the first block makes that whole block the header", async () => {
    const converted = await convertSubject(
      site("ap"),
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryType: "post" },
    );
    const cut = splitChrome(site("ap"), converted.nodes);
    expect(cut.unsplit).toBeUndefined();
    // The PDF plugin's opening marker, then the block with the header part.
    expect(cut.prefix).toHaveLength(2);
    expect((cut.prefix[0] as JxElement).tagName).toBe("wp2jx-shortcode");
    expect(JSON.stringify(cut.prefix[1])).toContain('"slug":"header-light"');
    expect(cut.suffix).toHaveLength(1);
    expect(JSON.stringify(cut.suffix[0])).toContain('"slug":"footer"');
    expect(cut.body.length).toBeGreaterThan(3);
    expect(cut.prefix.length + cut.body.length + cut.suffix.length).toBe(converted.nodes.length);
  });

  test("a template with no header has an empty prefix, one with no footer an empty suffix", () => {
    const s = site("ap");
    const noHeader = splitChrome(s, [body(), part("footer")]);
    expect(noHeader.prefix).toEqual([]);
    expect(noHeader.suffix).toHaveLength(1);
    expect(noHeader.unsplit).toBeUndefined();
    const noFooter = splitChrome(s, [part("header"), el("section"), el("section")]);
    expect(noFooter.prefix).toHaveLength(1);
    expect(noFooter.body).toHaveLength(2);
    expect(noFooter.suffix).toEqual([]);
  });

  test("when several blocks hold a header part the header runs to the last of them", () => {
    const s = site("ap");
    const nodes = [
      part("header"),
      el("div", { children: [part("header-light")] }),
      body(),
      part("footer"),
    ];
    const cut = splitChrome(s, nodes);
    expect(cut.prefix).toHaveLength(2);
    expect(cut.body).toHaveLength(1);
    expect(cut.suffix).toHaveLength(1);
    // And the footer starts at the first block that holds a footer part.
    const footers = splitChrome(s, [
      part("header"),
      body(),
      part("footer"),
      el("div", { children: [part("footer")] }),
    ]);
    expect(footers.suffix).toHaveLength(2);
    expect(footers.body).toHaveLength(1);
  });

  test("a template with neither part is all body, and not reported unsplit", () => {
    const nodes = [el("section"), el("section")];
    const cut = splitChrome(site("ap"), nodes);
    expect(cut.prefix).toEqual([]);
    expect(cut.suffix).toEqual([]);
    expect(cut.body).toEqual(nodes);
    expect(cut.unsplit).toBeUndefined();
  });

  test("a part that is neither a header nor a footer is body, wherever it stands", () => {
    const nodes = [part("header"), el("section", { children: [part("comments")] }), part("footer")];
    const cut = splitChrome(site("ap"), nodes);
    expect(cut.body).toHaveLength(1);
    expect(JSON.stringify(cut.body)).toContain("comments");
  });

  test("a header and a footer in one block, or the entry's body in the chrome, is not cut", () => {
    const s = site("ap");
    const both = [el("div", { children: [part("header"), el("section"), part("footer")] })];
    const one = splitChrome(s, both);
    expect(one.unsplit).toContain("same top-level node");
    expect(one.body).toEqual(both);
    expect(one.prefix).toEqual([]);
    const inChrome = [el("div", { children: [part("header"), body()] }), part("footer")];
    const two = splitChrome(s, inChrome);
    expect(two.unsplit).toContain("entry's body");
    expect(two.body).toEqual(inChrome);
    // The body in the middle is fine.
    const fine = splitChrome(s, [part("header"), body(), part("footer")]);
    expect(fine.unsplit).toBeUndefined();
    expect(fine.body).toHaveLength(1);
  });

  test("the layout of an unsplit template is only the slot, the whole template is the page's body, and the report says why", async () => {
    const s = site("fineline");
    const o = await buildTemplates(s, {
      only: ["index"],
      convert: async (_s, subject, opts) => {
        const converted = await convertSubject(s, subject, opts);
        // The same template with everything in one wrapper, as a theme that wraps its parts in a `main` has it.
        return subject.kind === "template"
          ? { ...converted, nodes: [el("div", { children: converted.nodes })] }
          : converted;
      },
    });
    expect(tagsOfLayout(docOf(o, "layouts/index.json"))).toEqual(["slot"]);
    const blog = o.pages.find((p) => p.kind === "posts")!;
    const page = docOf(o, blog.file);
    expect(JSON.stringify(page.children)).toContain("wp-header");
    expect(JSON.stringify(page.children)).toContain("wp-footer");
    const e = o.report.entries().find((x) => x.code === "template.chrome-unsplit")!;
    expect(e.severity).toBe("info");
    expect(e.where).toBe("template:cwicly//index");
    expect(e.data?.reason).toContain("same top-level node");
  });
});

describe("Fluent Forms in a template", () => {
  test('the service template\'s `[fluentform id="6"]` shortcode becomes the form, drawn once for every service', async () => {
    const s = { ...site("fineline"), forms: await pilotForms() };
    const o = await buildTemplates(s, { only: ["single-service"] });
    const doc = JSON.stringify(jsonFiles(o).get("pages/service/[slug].json"));
    expect(doc).toContain("fluentform_wrapper_6");
    expect(doc).toContain("ffs_custom_wrap");
    expect(doc).not.toContain("[fluentform");
    const said = o.report.entries().filter((e) => e.code.startsWith("form."));
    expect(said.map((e) => e.code)).toEqual(["form.not-submittable"]);
    expect(said[0]!.where).toBe("template:cwicly//single-service");
    expect(
      o.report
        .entries()
        .some(
          (e) =>
            e.code === "template.placeholder-neutral" &&
            JSON.stringify(e.data).includes("fluentform"),
        ),
    ).toBe(false);
  });

  test("without the form in the database the shortcode keeps its neutral stand-in", async () => {
    const o = await buildTemplates(site("fineline"), { only: ["single-service"] });
    const doc = JSON.stringify(jsonFiles(o).get("pages/service/[slug].json"));
    expect(doc).toContain("fluentform");
    expect(doc).not.toContain("fluentform_wrapper_6");
    expect(o.report.entries().some((e) => e.code === "form.missing")).toBe(true);
  });
});

describe("slotContent", () => {
  test("the first element that printed the entry's body keeps its box and holds the slot", () => {
    const nodes = [
      el("section", {
        className: "a",
        children: [el("div", { className: "box", children: ENTRY_BODY as unknown as JxNode[] })],
      }),
    ];
    const before = JSON.stringify(nodes);
    const done = slotContent(nodes);
    expect(done.found).toBe(1);
    expect(done.nodes).toEqual([
      el("section", {
        className: "a",
        children: [el("div", { className: "box", children: [{ tagName: "slot" }] })],
      }),
    ]);
    // The input is not edited.
    expect(JSON.stringify(nodes)).toBe(before);
  });

  test("both spellings of the body are found; a second one is emptied, as a layout has one slot", () => {
    const plain = el("div", { children: "${state.entry.$children}" as unknown as JxNode[] });
    const done = slotContent([plain, body(), body()]);
    expect(done.found).toBe(3);
    expect(done.nodes).toEqual([
      el("div", { children: [{ tagName: "slot" }] }),
      el("div", { children: [] }),
      el("div", { children: [] }),
    ]);
    expect(slotsIn(done.nodes)).toBe(1);
  });

  test("a binding that only looks like the body is left alone", () => {
    const other = el("div", { children: "${state.entry.data.title}" as unknown as JxNode[] });
    const x = el("div", { children: "${state.other.$children}" as unknown as JxNode[] });
    expect(slotContent([other, x]).found).toBe(0);
    expect(countEntryBodies([other, x])).toBe(0);
    expect(countEntryBodies([el("p", { children: [body()] })])).toBe(1);
  });
});

describe("repairTermBindings", () => {
  test("core's ${state.term.name} is written against the term entry's own data", () => {
    const nodes: JxNode[] = [
      el("h1", { textContent: "Category: ${state.term.name}" }),
      el("p", { innerHTML: "<b>${state.term.name}</b> and ${state.term.name}" }),
      el("p", { textContent: "${state.term.data.name ?? ''}" }),
    ];
    expect(repairTermBindings(nodes)).toBe(3);
    expect((nodes[0] as JxElement).textContent).toBe("Category: ${state.term.data.name ?? ''}");
    expect((nodes[1] as JxElement).innerHTML).toBe(
      "<b>${state.term.data.name ?? ''}</b> and ${state.term.data.name ?? ''}",
    );
    expect((nodes[2] as JxElement).textContent).toBe("${state.term.data.name ?? ''}");
    expect(repairTermBindings(nodes)).toBe(0);
  });

  test("a title that is only the name gets the prefix WordPress prints when the page's kind is known", () => {
    const nodes: JxNode[] = [
      el("h1", { textContent: "${state.term.name}" }),
      el("h2", { textContent: "Tag: ${state.term.name}" }),
      el("p", { textContent: "a ${state.term.name}" }),
    ];
    expect(repairTermBindings(nodes, "Category")).toBe(3);
    expect((nodes[0] as JxElement).textContent).toBe("Category: ${state.term.data.name ?? ''}");
    // A prefix the converter already wrote, and text around the name, are left as written.
    expect((nodes[1] as JxElement).textContent).toBe("Tag: ${state.term.data.name ?? ''}");
    expect((nodes[2] as JxElement).textContent).toBe("a ${state.term.data.name ?? ''}");
    // Without a label nothing is added.
    const bare: JxNode[] = [el("h1", { textContent: "${state.term.name}" })];
    repairTermBindings(bare);
    expect((bare[0] as JxElement).textContent).toBe("${state.term.data.name ?? ''}");
  });

  test("a title the converter did not ask a prefix for (showPrefix: false) is left bare", async () => {
    const s = site("ap");
    const heading = async (quiet: boolean): Promise<string> => {
      const o = await buildTemplates(s, {
        only: ["archive"],
        convert: async (_s, subject, opts) => {
          const converted = await convertSubject(s, subject, opts);
          // Without the converter's `block.archive-prefix`, the title had no prefix to give.
          return quiet && subject.kind === "template"
            ? { ...converted, report: createReport() }
            : converted;
        },
      });
      return JSON.stringify(docOf(o, "pages/category/[slug].json").children);
    };
    expect(await heading(false)).toContain("Category: ${state.term.data.name ?? ''}");
    expect(await heading(true)).not.toContain("Category: ");
    expect(await heading(true)).toContain("${state.term.data.name ?? ''}");
  });

  test("archiveLabel: category and tag are named, a custom taxonomy by its singular label, anything else has none", () => {
    expect(archiveLabel(site("ap"), "category")).toBe("Category");
    expect(archiveLabel(site("ap"), "post_tag")).toBe("Tag");
    expect(archiveLabel(site("ap"), "series")).toBe("Series");
    expect(archiveLabel(site("ap"), "season")).toBe("Season");
    expect(archiveLabel(site("fineline"), "location")).toBe("Location");
    expect(archiveLabel(site("ap"), "no-such-taxonomy")).toBeUndefined();
  });

  test("ap: the archive titles of the real term templates are repaired in the page that is written", () => {
    const o = out("ap");
    const text = fileOf(o, "pages/tag/[slug].json");
    expect(text).not.toContain("${state.term.name}");
    expect(text).toContain("${state.term.data.name ?? ''}");
    const e = o.report.entries().filter((x) => x.code === "template.term-binding-repaired");
    expect(e.length).toBeGreaterThan(0);
    expect(e[0]!.severity).toBe("info");
  });
});

describe("withoutResults", () => {
  const results = (key: string) =>
    el("div", {
      children: {
        $prototype: "Array",
        items: { $ref: `#/state/${key}` },
        map: el("li"),
      } as unknown as JxNode[],
    });

  test("a loop over a collection the conversion registered becomes a notice, and the state is named", () => {
    const nodes = [el("section", { children: [el("h2"), results("post_q1")] })];
    const done = withoutResults(nodes, { post_q1: {} });
    expect(done.replaced).toBe(1);
    expect(done.dropped).toEqual(["post_q1"]);
    const notice = (done.nodes[0] as JxElement).children as JxElement[];
    expect(JSON.stringify(notice)).toContain("wp2jx-search");
    expect(JSON.stringify(notice)).toContain("Search is not available on this copy of the site.");
    expect(JSON.stringify(notice)).not.toContain("$prototype");
  });

  test("the loop is found as an entry of children, which is how the data converter writes it, and as the whole of them", () => {
    const loop = {
      $prototype: "Array",
      items: { $ref: "#/state/post_q1" },
      map: el("li"),
    } as unknown as JxNode;
    const nodes = [
      el("div", { children: [el("p", { textContent: "none" }), loop] }),
      el("ul", { children: loop as unknown as JxNode[] }),
    ];
    const done = withoutResults(nodes, { post_q1: {} });
    expect(done.replaced).toBe(2);
    expect(done.dropped).toEqual(["post_q1"]);
    expect(JSON.stringify(done.nodes)).not.toContain("$prototype");
    expect(((done.nodes[0] as JxElement).children as JxNode[]).length).toBe(2);
    expect((((done.nodes[0] as JxElement).children as JxNode[])[0] as JxElement).textContent).toBe(
      "none",
    );
  });

  test("a loop over something else is kept", () => {
    const nodes = [results("elsewhere")];
    const done = withoutResults(nodes, { post_q1: {} });
    expect(done.replaced).toBe(0);
    expect(done.dropped).toEqual([]);
    expect(JSON.stringify(done.nodes)).toContain("$prototype");
  });
});

describe("withoutShortcodeText", () => {
  test("a paragraph that is only the text of a shortcode that prints nothing is removed, wherever it is", () => {
    const nodes: JxNode[] = [
      el("p", { textContent: "[/dkpdf-remove]" }),
      el("section", {
        children: [
          el("p", { textContent: '[dkpdf-remove tag="header"]' }),
          el("p", { textContent: "kept" }),
        ],
      }),
      el("p", { textContent: "[dkpdf-button]" }),
      el("p", { textContent: "[/not-listed]" }),
    ];
    const done = withoutShortcodeText(nodes);
    expect(done.dropped).toEqual(["[/dkpdf-remove]", '[dkpdf-remove tag="header"]']);
    expect(done.nodes).toEqual([
      el("section", { children: [el("p", { textContent: "kept" })] }),
      el("p", { textContent: "[dkpdf-button]" }),
      el("p", { textContent: "[/not-listed]" }),
    ]);
    expect(nodes).toHaveLength(4);
  });

  test("the list names what the live pages were seen to print nothing for", () => {
    expect([...EMPTY_SHORTCODES].sort()).toEqual(["dkpdf-pdf-remove", "dkpdf-remove"]);
    // The breadcrumb is not among them: the live pages print it.
    expect(EMPTY_SHORTCODES.has("rank_math_breadcrumb")).toBe(false);
  });
});

describe("the breadcrumb", () => {
  test("is the markup Rank Math prints on the live pages: nav.rank-math-breadcrumb, Home, a separator and a last span per crumb", () => {
    const nav = breadcrumbNode([{ text: "Series" }, { text: "A & B <i>" }]);
    expect(nav).toEqual({
      tagName: "nav",
      className: "rank-math-breadcrumb",
      attributes: { "aria-label": "breadcrumbs" },
      children: [
        {
          tagName: "p",
          innerHTML:
            '<a href="/">Home</a><span class="separator"> &raquo; </span><span class="last">Series</span>' +
            '<span class="separator"> &raquo; </span><span class="last">A &amp; B &lt;i&gt;</span>',
        },
      ],
    });
  });

  test("a crumb that is an expression is escaped by its expression, and a literal dollar-brace in text cannot be read as a binding", () => {
    const nav = breadcrumbNode([{ expr: "state.entry.data.title ?? ''" }, { text: "${danger}" }]);
    const html = String(((nav.children as JxElement[])[0] as JxElement).innerHTML);
    expect(html).toContain(
      "<span class=\"last\">${String((state.entry.data.title ?? '') ?? '').replace(",
    );
    expect(html).toContain("&#36;{danger}");
    expect(html).not.toContain("${danger}");
  });

  test("the live pages print this trail: Home, a taxonomy crumb for a custom taxonomy only, then the name", () => {
    const s = site("ap");
    expect(crumbsFor(s, { kind: "entry", type: "supporters_update", route: "/x" })).toEqual([
      { expr: "state.entry.data.title ?? ''" },
    ]);
    expect(crumbsFor(s, { kind: "term", type: "series", route: "/x" })).toEqual([
      { text: "Series" },
      { expr: "state.term.data.name ?? ''" },
    ]);
    expect(crumbsFor(s, { kind: "term", type: "season", route: "/x" })?.[0]).toEqual({
      text: "Season",
    });
    for (const taxonomy of ["category", "post_tag"]) {
      expect(crumbsFor(s, { kind: "term", type: taxonomy, route: "/x" })).toEqual([
        { expr: "state.term.data.name ?? ''" },
      ]);
    }
    expect(crumbsFor(s, { kind: "posts", route: "/essays/" })).toEqual([
      { text: "Essays for King Jesus" },
    ]);
    expect(crumbsFor(s, { kind: "posts", route: "/" })).toEqual([]);
    expect(
      crumbsFor(site("fineline"), { kind: "archive", type: "project", route: "/projects/" }),
    ).toEqual([{ text: "Projects" }]);
    expect(crumbsFor(s, { kind: "404", route: "/404/" })).toBeUndefined();
    expect(crumbsFor(s, { kind: "search", route: "/search/" })).toBeUndefined();
  });

  test("a taxonomy that ACF registers under the name of category or tag is still the one WordPress prints without a taxonomy crumb", () => {
    const label = (singular: string) => ({
      singular,
      plural: singular,
      labels: { name: singular },
    });
    const acf = {
      taxonomies: new Map([
        ["category", label("Topic")],
        ["post_tag", label("Label")],
        ["series", label("Series")],
      ]),
      postTypes: new Map(),
    };
    const fake = { model: site("ap").model, acf } as unknown as Parameters<typeof crumbsFor>[0];
    expect(crumbsFor(fake, { kind: "term", type: "category", route: "/x" })).toHaveLength(1);
    expect(crumbsFor(fake, { kind: "term", type: "post_tag", route: "/x" })).toHaveLength(1);
    expect(crumbsFor(fake, { kind: "term", type: "series", route: "/x" })).toHaveLength(2);
  });

  test("ap: the shortcode prints the trail the live page has, in every kind of page that carries it", () => {
    const o = out("ap");
    const html = (file: string): string[] =>
      [...elementsOf(docOf(o, file).children)]
        .filter((e) => e.tagName === "nav" && e.className === "rank-math-breadcrumb")
        .map((e) => String((e.children as JxElement[])[0]!.innerHTML));
    // supporters_update, the posts index, a tag, a series and the page layout all have the shortcode.
    expect(html("pages/supporters_update/[slug].json")).toHaveLength(1);
    expect(html("pages/supporters_update/[slug].json")[0]).toContain("state.entry.data.title");
    expect(html("pages/essays.json")[0]).toContain(
      '<span class="last">Essays for King Jesus</span>',
    );
    expect(html("pages/tag/[slug].json")[0]).toContain("state.term.data.name");
    expect(html("pages/essays/series/[slug].json")[0]).toContain(
      '<span class="last">Series</span>',
    );
    expect(html("layouts/page.json")).toHaveLength(1);
    // Nothing prints a shortcode as its text, and none has no trail to print.
    for (const path of jsonFiles(o).keys())
      expect([path, fileOf(o, path).includes("rank_math_breadcrumb")]).toEqual([path, false]);
  });
});

describe("boundHead and boundTitle", () => {
  const head = boundHead("state.entry.data", "https://example.com/", undefined, "article");
  const find = (key: string) =>
    head.find(
      (h) => h.attributes.name === key || h.attributes.property === key || h.attributes.rel === key,
    )!;

  test("every value is coalesced to the empty string: `$head` has no omission, `false` prints the word", () => {
    for (const h of head) {
      const value = h.attributes.content ?? h.attributes.href!;
      expect(value).not.toContain("false");
    }
    expect(find("description").attributes.content).toBe(
      "${state.entry.data.seo?.description ?? ''}",
    );
    expect(find("og:image").attributes.content).toContain("state.entry.data.seo?.image?.src");
    expect(find("og:image").attributes.content).toContain('"https://example.com"');
    expect(find("canonical").attributes.href).toBe(
      "https://example.com/${state.entry.data.url ?? ''}",
    );
  });

  test("without a sample page the constants are left out, with one they are the sample's", () => {
    expect(head.find((h) => h.attributes.property === "og:locale")).toBeUndefined();
    expect(head.find((h) => h.attributes.name === "twitter:site")).toBeUndefined();
    const sample = {
      title: "t",
      description: "",
      robots: "",
      openGraph: { type: "article", locale: "en_US", title: "", description: "", siteName: "Site" },
      twitter: { card: "summary", title: "", description: "", site: "@site" },
    } as unknown as Parameters<typeof boundHead>[2];
    const withSample = boundHead("state.term.data", "https://example.com", sample, "website");
    expect(withSample.find((h) => h.attributes.property === "og:locale")!.attributes.content).toBe(
      "en_US",
    );
    expect(
      withSample.find((h) => h.attributes.property === "og:site_name")!.attributes.content,
    ).toBe("Site");
    expect(withSample.find((h) => h.attributes.name === "twitter:card")!.attributes.content).toBe(
      "summary",
    );
    expect(withSample.find((h) => h.attributes.name === "twitter:site")!.attributes.content).toBe(
      "@site",
    );
    expect(withSample.find((h) => h.attributes.property === "og:type")!.attributes.content).toBe(
      "website",
    );
  });

  test("the title falls back from Rank Math's to the entry's title to a term's name, and is never nullish", () => {
    expect(boundTitle("state.entry.data")).toBe(
      "${state.entry.data.seo?.title || state.entry.data.title || state.entry.data.name || ''}",
    );
    expect(boundTitle("state.term.data")).toBe(
      "${state.term.data.seo?.title || state.term.data.title || state.term.data.name || ''}",
    );
  });
});

describe("wholeBindingsAside", () => {
  test("a string child that is one expression is the computed list the build evaluates; a text child that holds one is not", () => {
    const nodes: JxNode[] = [
      el("ul", { children: ["${(state.a).map((x) => x)}"] }),
      el("p", { children: ["a ${state.b} c"] }),
      el("div", { children: [el("span", { children: ["${state.c}"] })] }),
    ];
    const aside = wholeBindingsAside(nodes);
    expect(aside).toEqual([
      el("ul", { children: ["(binding)"] }),
      el("p", { children: ["a ${state.b} c"] }),
      el("div", { children: [el("span", { children: ["(binding)"] })] }),
    ]);
    expect(JSON.stringify(nodes)).toContain("(state.a)");
  });
});

describe("isPageTemplate", () => {
  test("names the hierarchy gives to pages, and the custom ones a page can choose, are page templates", () => {
    for (const slug of [
      "page",
      "front-page",
      "page-about",
      "singular",
      "privacy-policy",
      "wp-custom-template-blank",
      "test-header",
      "anything",
    ]) {
      expect([slug, isPageTemplate(slug)]).toEqual([slug, true]);
    }
    for (const slug of [
      "index",
      "home",
      "single",
      "single-project",
      "archive",
      "archive-project",
      "taxonomy",
      "taxonomy-location",
      "category",
      "category-x",
      "tag",
      "tag-y",
      "author",
      "author-z",
      "date",
      "search",
      "404",
      "attachment",
      "embed",
    ]) {
      expect([slug, isPageTemplate(slug)]).toEqual([slug, false]);
    }
  });
});

// ── Options, fragments, wrappers and failures ────────────────────────────────────────────────────

/** A site whose options are edited (the cwicly options are read-only structures, so a copy). */
const withOptions = (s: LoadedSite, edit: Record<string, unknown>): LoadedSite =>
  ({ ...s, options: { ...s.options, ...edit } }) as LoadedSite;

describe("fragmentParts: the global header and footer", () => {
  /** A fragment whose parts have an exclude entry each (Cwicly prints none without), unless `exclude` is given. */
  const fragment = (include: Record<string, Rule>, exclude?: Record<string, Rule>) =>
    ({
      options: {
        globalParts: {
          fragments: {
            f: {
              conditions: {
                include,
                exclude:
                  exclude ?? Object.fromEntries(Object.keys(include).map((k) => [k, noExclude()])),
              },
            },
          },
        },
      },
    }) as unknown as Pick<SiteContext, "options">;

  test("a part applies to every page when `or` has `all`, or `and` has `all` and nothing of the page's", () => {
    const parts = fragmentParts(
      fragment({
        a: rule({ all: "true", includeCondition: "or" }),
        b: rule({ all: "true", includeCondition: "and" }),
        c: rule({ all: "true", singular: [{ target: "all" }], includeCondition: "and" }),
        d: rule({ all: "true", singular: [{ target: "all" }], includeCondition: "or" }),
        e: rule({ all: "false", includeCondition: "or" }),
        f: rule({ all: "true" }),
        g: rule({ all: "true", includeCondition: undefined }),
      }),
      "f",
    );
    expect(parts.always).toEqual(["a", "b", "d", "f"]);
    expect(parts.conditional).toEqual(["c"]);
  });

  test("a rule that lists a condition of the page depends on the page", () => {
    const parts = fragmentParts(
      fragment({
        a: rule({ archive: [{ target: "search" }], includeCondition: "or" }),
        b: rule({ custom: [{ target: "loggedin" }], includeCondition: "and" }),
        c: rule({ acf: [{ x: 1 }], includeCondition: "and" }),
      }),
      "f",
    );
    expect(parts).toEqual({ always: [], conditional: ["a", "b", "c"] });
  });

  test("an `all` exclusion removes the part, unless it is an `and` over conditions of the page too; a keyed exclusion makes it depend on the page", () => {
    const include = {
      a: rule({ all: "true", includeCondition: "or" }),
      b: rule({ all: "true", includeCondition: "or" }),
      c: rule({ all: "true", includeCondition: "or" }),
      d: rule({ all: "true", includeCondition: "or" }),
    };
    const parts = fragmentParts(
      fragment(include, {
        a: noExclude({ all: "true" }),
        b: noExclude({ all: "true", singular: [{ target: "all" }], excludeCondition: "and" }),
        c: noExclude({ singular: [{ target: "all" }] }),
        d: noExclude(),
      }),
      "f",
    );
    expect(parts.always).toEqual(["d"]);
    expect(parts.conditional).toEqual(["b", "c"]);
  });

  test("a fragment that does not exist, or has no rules, has no parts; nothing throws on a malformed one", () => {
    expect(fragmentParts(fragment({}), "f")).toEqual({ always: [], conditional: [] });
    expect(
      fragmentParts(fragment({ a: rule({ all: "true", includeCondition: "or" }) }), "other"),
    ).toEqual({ always: [], conditional: [] });
    expect(
      fragmentParts(
        { options: { globalParts: { fragments: "x" } } } as unknown as Pick<SiteContext, "options">,
        "f",
      ),
    ).toEqual({ always: [], conditional: [] });
    expect(
      fragmentParts(
        { options: { globalParts: {} } } as unknown as Pick<SiteContext, "options">,
        "f",
      ),
    ).toEqual({ always: [], conditional: [] });
  });

  test("the sites' own fragments print nothing: fineline's names a part under a rule with no includeCondition", () => {
    expect(fragmentParts(site("fineline"), "globalheader")).toEqual({
      always: [],
      conditional: [],
    });
    expect(fragmentParts(site("fineline"), "globalfooter")).toEqual({
      always: [],
      conditional: [],
    });
    expect(fragmentParts(site("ap"), "globalheader")).toEqual({ always: [], conditional: [] });
  });
});

describe("the base layout", () => {
  test("a global fragment's parts are printed around the site blocks, in the order WordPress hooks them", async () => {
    const ap = site("ap");
    const edited = withOptions(ap, {
      globalParts: {
        fragments: {
          globalheader: {
            templates: [],
            conditions: {
              include: {
                "top-menu": rule({ all: "true", includeCondition: "or" }),
                header: rule({ archive: [{ target: "search" }], includeCondition: "or" }),
                "gone-part": rule({ all: "true", includeCondition: "or" }),
              },
              exclude: {
                "top-menu": noExclude(),
                header: noExclude(),
                "gone-part": noExclude(),
              },
            },
          },
          globalfooter: {
            templates: [],
            conditions: {
              include: { comments: rule({ all: "true", includeCondition: "or" }) },
              exclude: { comments: noExclude() },
            },
          },
        },
      },
    });
    const o = await buildTemplates(edited, {
      customCode: {
        bodyOpen: "<noscript>open</noscript>",
        footer: "<script>window.done = 1</script>",
      },
    });
    const base = docOf(o, "layouts/base.json");
    const kids = childrenOf(base) as JxElement[];
    expect(kids.map((k) => k.tagName)).toEqual([
      "noscript",
      "wp-top-menu",
      "div",
      "wp-comments",
      "script",
    ]);
    expect(refsOf(base)).toEqual([
      "../components/wp-comments.json",
      "../components/wp-top-menu.json",
    ]);
    expect(kids[2]!.className).toBe("wp-site-blocks");
    const entries = o.report.entries();
    const conditional = entries.find((e) => e.code === "template.fragment-conditional")!;
    expect(conditional.severity).toBe("warn");
    expect(conditional.where).toBe("option:cwicly_global_parts");
    expect(conditional.data).toEqual({ fragment: "globalheader", part: "header" });
    const missing = entries.find((e) => e.code === "template.part-missing" && e.data?.fragment)!;
    expect(missing.severity).toBe("error");
    expect(missing.data).toEqual({ fragment: "globalheader", part: "gone-part" });
    expect(o.used.components.has("wp-top-menu")).toBe(true);
  });

  test("the custom code of the site is converted as markup: its inline style stays an attribute", async () => {
    const o = await buildTemplates(site("ap"), {
      customCode: { bodyOpen: '<div id="tag" style="display:none">x</div>', footer: "" },
    });
    const kids = childrenOf(docOf(o, "layouts/base.json")) as JxElement[];
    expect(kids[0]).toMatchObject({ tagName: "div", attributes: { style: "display:none" } });
    expect(kids[1]!.className).toBe("wp-site-blocks");
    expect(kids).toHaveLength(2);
  });
});

describe("the template part wrapper", () => {
  test("Cwicly's optimisation leaves the part's own elements: no wrapper, no class", () => {
    for (const name of SITES) {
      expect(site(name).options.optimise.templatePartWrapper).toBe(true);
    }
    expect(JSON.stringify(docOf(out("fineline"), "layouts/page.json"))).not.toContain(
      "wp-block-template-part",
    );
  });

  test("with it off, WordPress's wrapper is back: the header's tag for a header part, the footer's for a footer", async () => {
    const s = site("fineline");
    const edited = withOptions(s, {
      optimise: { ...s.options.optimise, templatePartWrapper: false },
    });
    const o = await buildTemplates(edited, { only: ["page"] });
    const kids = childrenOf(docOf(o, "layouts/page.json")) as JxElement[];
    expect(kids.map((k) => k.tagName)).toEqual(["header", "div", "footer"]);
    expect(kids[0]).toMatchObject({
      className: "wp-block-template-part",
      children: [{ tagName: "wp-header" }],
    });
    expect(kids[2]).toMatchObject({
      className: "wp-block-template-part",
      children: [{ tagName: "wp-footer" }],
    });
  });
});

describe("what a template can get wrong", () => {
  test("a part the theme does not have is an error, and prints nothing", async () => {
    const s = site("fineline");
    const footer = postBySlug(s, "wp_template_part", "footer");
    const edited = withModel(s, (posts) => posts.delete(footer.id));
    const o = await buildTemplates(edited, { only: ["page"] });
    expect(tagsOfLayout(docOf(o, "layouts/page.json"))).toEqual(["wp-header", "div"]);
    const e = o.report.entries().filter((x) => x.code === "template.part-missing");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      severity: "error",
      where: "template:cwicly//page",
      data: { part: "footer" },
    });
    expect(o.parts.map((p) => p.slug)).not.toContain("footer");
  });

  test("a page template with no content block still gets its page's slot, and the report says so", async () => {
    const s = site("fineline");
    const o = await buildTemplates(s, {
      only: ["page"],
      convert: async (_s, subject, opts) => {
        const converted = await convertSubject(s, subject, opts);
        if (subject.kind !== "template" || subject.slug !== "page") return converted;
        return {
          ...converted,
          nodes: converted.nodes.filter((n) => typeof n === "string" || n.tagName !== "div"),
        };
      },
    });
    expect(tagsOfLayout(docOf(o, "layouts/page.json"))).toEqual(["wp-header", "slot", "wp-footer"]);
    const e = o.report.entries().find((x) => x.code === "template.no-content-slot")!;
    expect(e).toMatchObject({ severity: "warn", where: "template:cwicly//page" });
  });

  test("a page template with two content blocks has one slot, and the report says so", async () => {
    const s = site("fineline");
    const o = await buildTemplates(s, {
      only: ["page"],
      convert: async (_s, subject, opts) => {
        const converted = await convertSubject(s, subject, opts);
        if (subject.kind !== "template" || subject.slug !== "page") return converted;
        const nodes = [...converted.nodes];
        nodes.splice(2, 0, structuredClone(nodes[1]!));
        return { ...converted, nodes };
      },
    });
    expect(slotsIn(childrenOf(docOf(o, "layouts/page.json")))).toBe(1);
    const e = o.report.entries().find((x) => x.code === "template.content-slot-extra")!;
    expect(e.data).toEqual({ template: "page", found: 2 });
  });

  test("a page layout that reads the page's own data beyond what the page's entry state carries is reported, with the keys", async () => {
    const s = site("fineline");
    const o = await buildTemplates(s, {
      only: ["page"],
      convert: async (_s, subject, opts) => {
        const converted = await convertSubject(s, subject, opts);
        if (subject.kind !== "template" || subject.slug !== "page") return converted;
        const nodes = [...converted.nodes];
        nodes.splice(
          1,
          0,
          el("p", {
            textContent:
              "${state.entry.data.terms?.category ?? ''} ${state.entry.data.title} ${state.entry.data.fp_title_1}",
          }),
        );
        return { ...converted, nodes };
      },
    });
    const e = o.report.entries().find((x) => x.code === "template.entry-data-missing")!;
    expect(e.severity).toBe("warn");
    expect(e.data).toEqual({ template: "page", keys: ["fp_title_1", "terms"] });
    expect(e.message).toContain("state.entry.data.terms");
  });

  test("one template that cannot be converted costs that template only", async () => {
    const s = site("fineline");
    const o = await buildTemplates(s, {
      convert: (_s, subject, opts) => {
        if (subject.kind === "template" && subject.slug === "single-project")
          throw new Error("boom");
        return convertSubject(s, subject, opts);
      },
    });
    const failed = o.report.entries().filter((e) => e.code === "template.convert-failed");
    expect(failed.map((e) => [e.severity, e.where])).toEqual([
      ["error", "route:/project/:slug"],
      ["error", "template:cwicly//single-project"],
    ]);
    expect(failed[0]!.message).toContain("boom");
    expect(o.pages.map((p) => p.file)).not.toContain("pages/project/[slug].json");
    expect(o.layouts["single-project"]).toBeUndefined();
    // Everything else is there.
    expect(o.pages.length).toBe(out("fineline").pages.length - 1);
    expect(o.layouts.page).toBe("./layouts/page.json");
    expect(o.parts).toEqual(out("fineline").parts);
  });

  test("a part that cannot be converted costs that part only", async () => {
    const s = site("ap");
    const o = await buildTemplates(s, {
      convert: (_s, subject, opts) => {
        if (subject.kind === "part" && subject.slug === "top-menu")
          return Promise.reject(new Error("no menu"));
        return convertSubject(s, subject, opts);
      },
    });
    expect(o.parts.map((p) => p.slug)).not.toContain("top-menu");
    expect(o.parts.length).toBe(out("ap").parts.length - 1);
    const e = o.report.entries().find((x) => x.code === "template.convert-failed")!;
    expect(e.where).toBe("template:cwicly//top-menu");
  });

  test("a closing shortcode tag is the same shortcode: the PDF marker is removed whether it opens or closes", async () => {
    const s = site("fineline");
    const marker = (name: string): JxElement =>
      el("wp2jx-shortcode", { attributes: { "data-shortcode": name, "data-source": `[${name}]` } });
    const o = await buildTemplates(s, {
      only: ["page"],
      convert: async (_s, subject, opts) => {
        const converted = await convertSubject(s, subject, opts);
        if (subject.kind !== "template" || subject.slug !== "page") return converted;
        return {
          ...converted,
          nodes: [
            marker("dkpdf-remove"),
            marker("/dkpdf-remove"),
            marker("/dkpdf-button"),
            ...converted.nodes,
          ],
        };
      },
    });
    const text = fileOf(o, "layouts/page.json");
    expect(text).not.toContain("dkpdf-remove");
    // A shortcode that does print something is kept as a visible stand-in, closing tag or not.
    expect(text).toContain("shortcode:/dkpdf-button");
    expect(o.report.entries().filter((e) => e.code === "template.shortcode-empty")).toHaveLength(1);
  });

  test("a conversion that registers the state key of the page's own data loses it, and the report says so", async () => {
    const s = site("fineline");
    const o = await buildTemplates(s, {
      only: ["single-project"],
      convert: async (_s, subject, opts) => {
        const converted = await convertSubject(s, subject, opts);
        if (subject.kind !== "template" || subject.slug !== "single-project") return converted;
        return { ...converted, state: { ...converted.state, entry: { junk: true }, other: [1] } };
      },
    });
    const doc = docOf(o, "pages/project/[slug].json");
    const state = doc.state as Record<string, unknown>;
    expect((state.entry as Record<string, unknown>).$prototype).toBe("ContentEntry");
    expect(state.other).toEqual([1]);
    expect(Object.keys(state)[0]).toBe("entry");
    const e = o.report.entries().find((x) => x.code === "template.state-taken")!;
    expect(e).toMatchObject({ severity: "warn", data: { key: "entry" } });
  });

  test("a resolver the caller gives outranks the defaults", async () => {
    const o = await buildTemplates(site("ap"), {
      only: ["single-post", "page"],
      resolvers: { "wp2jx-shortcode": () => ({ tagName: "div", className: "mine" }) },
    });
    expect(fileOf(o, "layouts/single-post.json")).toContain('"className": "mine"');
    // The page's own shortcode (the PDF button) is the caller's too.
    expect(fileOf(o, "pages/essays/[slug].json")).toContain('"className": "mine"');
    expect(fileOf(o, "pages/essays/[slug].json")).not.toContain("wp2jx-unconverted");
    expect(
      o.report
        .entries()
        .some((e) => e.code === "template.placeholder-neutral" && e.data?.kind === "shortcode"),
    ).toBe(false);
  });

  test("`only` writes the layouts and pages of those templates, and every component", async () => {
    const o = await buildTemplates(site("fineline"), { only: ["single-project"] });
    expect(Object.keys(o.layouts)).toEqual(["single-project"]);
    expect(o.pages.map((p) => p.file)).toEqual(["pages/project/[slug].json"]);
    expect(o.parts.length).toBe(out("fineline").parts.length);
    expect(o.files.find((f) => f.path === "layouts/base.json")).toBeDefined();
    expect([...o.used.templates]).toEqual(["single-project"]);
  });

  test("the caller's report is the one returned, and gets every finding", async () => {
    const report = createReport();
    const o = await buildTemplates(site("fineline"), { report, only: ["404"] });
    expect(o.report).toBe(report);
    expect(report.entries().some((e) => e.code === "template.404-location")).toBe(true);
  });

  test("the address the site will be served at is in the canonical and the image of an entry page", async () => {
    const o = await buildTemplates(site("fineline"), {
      siteUrl: "https://new.example.org/",
      only: ["single-project"],
    });
    const text = fileOf(o, "pages/project/[slug].json");
    expect(text).toContain("https://new.example.org${state.entry.data.url ?? ''}");
    expect(text).toContain('\\"https://new.example.org\\"');
    expect(text).not.toContain("https://finelinepainting.pro");
  });

  test("the unpublished templates and the other theme's are skipped, and said", async () => {
    const s = site("fineline");
    const real = templateOf(s, "single-service")!;
    const part = [...s.model.posts.values()].find(
      (p) => p.type === "wp_template_part" && p.slug === "header-updated-menu",
    )!;
    const edited = withModel(s, (posts) => {
      posts.set(real.id, { ...real, status: "draft" });
      posts.set(part.id, { ...part, status: "private" });
    });
    const o = await buildTemplates(edited);
    const skipped = o.report.entries().filter((e) => e.code === "template.skipped");
    expect(skipped.map((e) => [e.data?.slug, e.data?.why])).toEqual(
      expect.arrayContaining([
        ["single-service", "status draft"],
        ["header-updated-menu", "status private"],
      ]),
    );
    expect(o.layouts["single-service"]).toBeUndefined();
    expect(o.parts.map((p) => p.slug)).not.toContain("header-updated-menu");
    // Entries of a type that lost its template fall back to `single`.
    expect(o.pages.find((p) => p.file === "pages/service/[slug].json")?.template).toBe("single");
  });
});

// ── A route with no template ─────────────────────────────────────────────────────────────────────

describe("fallbacks: a route kind the theme has no template for still gets a page", () => {
  const bare = (name: SiteName): LoadedSite =>
    withModel(site(name), (posts) => {
      for (const [id, post] of posts) if (post.type === "wp_template") posts.delete(id);
    });

  for (const name of SITES) {
    test(`${name}: every route family is written, with the fallback layout, and the report says so`, async () => {
      const s = bare(name);
      const o = await buildTemplates(s);
      expect(o.layouts).toEqual({});
      expect(o.frames).toEqual({});
      expect(Object.keys(PAGES[name]).sort()).toEqual(o.pages.map((p) => p.file).sort());
      for (const page of o.pages) {
        expect(page.layout).toBe("./layouts/fallback.json");
        expect(docOf(o, page.file).$layout).toBe("./layouts/fallback.json");
        expect(page.template).toBe("index");
      }
      expect(docOf(o, "layouts/fallback.json")).toEqual({
        $layout: BASE_LAYOUT,
        children: [{ tagName: "main", children: [{ tagName: "slot" }] }],
      });
      const warned = o.report.entries().filter((e) => e.code === "template.fallback");
      expect(warned).toHaveLength(o.pages.length);
      for (const e of warned) {
        expect(e.severity).toBe("warn");
        expect(e.where).toMatch(/^route:/);
        expect(e.data?.tried).toContain("index");
      }
      // The parts are still components: the fallback does not depend on them.
      expect(o.parts.length).toBeGreaterThan(0);
    });
  }

  test("an entry shows its title and its body, a term its name, a list its entries, with no client runtime", async () => {
    const o = await buildTemplates(bare("fineline"));
    const entry = docOf(o, "pages/project/[slug].json");
    expect(entry.children).toEqual([
      {
        tagName: "article",
        children: [
          { tagName: "h1", textContent: "${state.entry.data.title ?? ''}" },
          { tagName: "div", children: "${state.entry.$children ?? []}" },
        ],
      },
    ]);
    expect(Object.keys(entry.state as object)).toEqual(["entry"]);
    expect(docOf(o, "pages/project_tag/[slug].json").children).toEqual([
      { tagName: "h1", textContent: "${state.term.data.name ?? ''}" },
    ]);
    expect(docOf(o, "pages/author/[slug].json").children).toEqual([
      { tagName: "h1", textContent: "${state.author.data.name ?? ''}" },
    ]);
    const archive = docOf(o, "pages/projects.json");
    expect((archive.state as Record<string, Record<string, unknown>>).list).toEqual({
      $prototype: "ContentCollection",
      $src: "@jxsuite/parser/ContentCollection.class.json",
      contentType: "project",
      sort: [{ field: "date", order: "desc" }],
      timing: "compiler",
    });
    expect(JSON.stringify(archive.children)).toContain("#/state/list");
    expect(docOf(o, "pages/404.json").children).toEqual([
      { tagName: "h1", textContent: "Page not found" },
    ]);
    expect(JSON.stringify(docOf(o, "pages/search.json").children)).toContain(
      "Search is not available",
    );
  });
});

// ── The built site ───────────────────────────────────────────────────────────────────────────────

interface Assembled {
  built: BuiltProject;
  templates: TemplatesOutput;
  files: Record<string, string>;
}

/**
 * The project a site's templates build in: the Markdown entries of a few real posts (the collections
 * emitter), the pages of the site (the pages emitter, which asks this module for each layout), this
 * module's own files and, for the components the components emitter owns (`cc_block`), a stub that
 * prints nothing: what is judged here is the templates, and the components have their own tests.
 */
async function assemble(
  name: SiteName,
  ids: number[],
  extra: Record<string, string> = {},
): Promise<Assembled> {
  const s = site(name);
  const want = new Set(ids);
  const collections = await buildCollections(s, { include: (post) => want.has(post.id) });
  const templates = await buildTemplates(s);
  const pages = await buildPages(s);
  const files: Record<string, string> = {};
  for (const f of [...collections.files, ...templates.files, ...pages.files])
    files[f.path] = f.content;
  Object.assign(files, extra);
  // The components that nothing here writes (a Cwicly `cc_block`).
  for (const [path, content] of Object.entries({ ...files })) {
    for (const m of content.matchAll(/"\$ref": "([^"#]+\.json)"/g)) {
      const target = posix.normalize(posix.join(posix.dirname(path), m[1]!));
      if (!(target in files)) {
        const tag = posix.basename(target, ".json");
        files[target] = JSON.stringify({
          tagName: tag,
          style: { display: "contents" },
          children: [],
        });
      }
    }
  }
  files["project.json"] = JSON.stringify({
    name: `templates-${name}`,
    url: s.model.site.url,
    extensions: ["@jxsuite/parser"],
    $media: s.options.media,
    defaults: { layout: templates.base },
    content: { ...collections.collections, ...templates.collections },
  });
  const built = await buildJxProject(files, { name: `templates-${name}`, timeoutMs: 280_000 });
  return { built, templates, files };
}

const builds = new Map<SiteName, Assembled>();

/**
 * The blocks of a template that Cwicly shows only when an ACF field of the entry is not empty
 * (`hideConditions` with `condition: acf`, `operator: notempty`): their classIDs and the field keys.
 */
function gatedBlocks(s: LoadedSite, slug: string): { classID: string; field: string }[] {
  const template = templateOf(s, slug)!;
  const out: { classID: string; field: string }[] = [];
  const seen = new Map<string, number>();
  walkBlocksOf(parseBlocksOf(template.content), (block) => {
    const id = String(block.attrs.classID);
    seen.set(id, (seen.get(id) ?? 0) + 1);
    const conditions = block.attrs.hideConditions;
    if (!Array.isArray(conditions)) return;
    for (const c of conditions as Record<string, unknown>[]) {
      if (c.condition === "acf" && c.operator === "notempty" && typeof c.acfField === "string") {
        out.push({ classID: id, field: c.acfField });
      }
    }
  });
  // A duplicated block keeps its classID (the editor copies it), so only a class that names one block can be found by it.
  return out.filter((g) => seen.get(g.classID) === 1);
}

/** Whether an ACF field (by key) holds something on a post, by PHP's `empty()`: the DB's own answer, read from the post's meta. */
function fieldFilled(s: LoadedSite, post: WpPost, key: string): boolean {
  const meta = s.model.postMeta.get(post.id) ?? {};
  const name = Object.keys(meta)
    .find((k) => k.startsWith("_") && meta[k]![0] === key)
    ?.slice(1);
  if (name === undefined) return false;
  const value = meta[name]?.[0];
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "0" ||
    value === 0 ||
    value === false
  )
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/** The entries the built site is made from: a post, a service, projects with the fewest and the most gated sections filled, an episode, a supporters update, essays. */
function entryIds(name: SiteName): number[] {
  const s = site(name);
  if (name === "ap") {
    return [
      773,
      8819,
      7260,
      published(s, "episode")[0]!.id,
      published(s, "supporters_update")[0]!.id,
    ];
  }
  const gated = gatedBlocks(s, "single-project");
  const filled = (p: WpPost): number => gated.filter((g) => fieldFilled(s, p, g.field)).length;
  const projects = published(s, "project").sort((a, b) => filled(a) - filled(b) || a.id - b.id);
  const service = published(s, "service")[0]!;
  return [
    3371,
    projects[0]!.id,
    projects[projects.length - 1]!.id,
    projects[Math.floor(projects.length / 2)]!.id,
    service.id,
  ];
}
const IDS: Record<SiteName, number[]> = { fineline: [], ap: [] };
const built = (name: SiteName): BuiltProject => builds.get(name)!.built;
const htmlOf = (name: SiteName, route: string): Hast => parseHtml(built(name).html(route));

beforeAll(async () => {
  for (const name of SITES) {
    IDS[name] = entryIds(name);
    builds.set(name, await assemble(name, IDS[name]));
  }
});

describe("the built site", () => {
  for (const name of SITES) {
    describe(name, () => {
      test("builds, and `jx validate` accepts the layouts, components and pages", async () => {
        expect(built(name).code).toBe(0);
        const v = await validateJxProject(built(name).dir);
        expect(v.problems).toEqual([]);
        expect(v.ok).toBe(true);
      });

      test("every route of the route table that a template renders is a built page", () => {
        const o = builds.get(name)!.templates;
        const s = site(name);
        for (const route of s.routes.all()) {
          if (
            route.kind === "term" ||
            route.kind === "author" ||
            route.kind === "post-archive" ||
            (route.kind === "posts-page" && route.jxRoute !== "/")
          ) {
            expect([
              route.jxRoute,
              built(name).exists(`${route.jxRoute.replace(/^\/|\/$/g, "")}/index.html`),
            ]).toEqual([route.jxRoute, true]);
          }
        }
        expect(built(name).exists("404/index.html")).toBe(true);
        expect(built(name).exists("search/index.html")).toBe(true);
        expect(o.notFound).toBe("pages/404.json");
      });

      test("the entry pages are built for the entries there are, with the template's layout around them", () => {
        const s = site(name);
        for (const id of IDS[name]) {
          const route = s.routes.forPost(id);
          if (!route) continue;
          const doc = htmlOf(name, route.jxRoute);
          const wrapper = findAll(doc, (e) => classOf(e).split(" ").includes("wp-site-blocks"));
          expect([route.jxRoute, wrapper.length]).toEqual([route.jxRoute, 1]);
          // The page prints the entry: a heading with its own text (what that is depends on the template: a title, an ACF field).
          const heading = findAll(doc, (e) => e.tagName === "h1").flatMap(textsOf);
          expect([route.jxRoute, (heading[0] ?? "").length > 0]).toEqual([route.jxRoute, true]);
        }
      });

      test("no entry page or term page ships a client runtime", () => {
        const s = site(name);
        for (const dp of s.routes.dynamicPages()) {
          const sample = dp.routes[0]!;
          const route = dp.kind === "entries" ? s.routes.forPost(Number(sample.id)) : sample;
          if (!route || (dp.kind === "entries" && !IDS[name].includes(Number(sample.id)))) continue;
          const html = built(name).html(route.jxRoute);
          expect([dp.file, /src="[^"]*app\.js"/.test(html)]).toEqual([dp.file, false]);
        }
      });
    });
  }
});

// ── The built chrome against the live pages ──────────────────────────────────────────────────────

const isMenu = (e: Hast): boolean =>
  e.tagName === "ul" && classOf(e).split(" ").includes("cc-menu");

/** The text of a subtree, leaving out the nav menus (the menus emitter's: a live menu's titles and `#` parents are its own). */
function textsWithoutMenus(root: Hast): string[] {
  const out: string[] = [];
  const visit = (node: Hast): void => {
    if (node.type === "text") {
      const t = (node.value ?? "").replace(/\s+/g, " ").trim();
      if (t !== "") out.push(t);
    } else if (
      node.type === "root" ||
      (node.type === "element" && !NOT_TEXT.has(node.tagName!) && !isMenu(node))
    ) {
      node.children?.forEach(visit);
    }
  };
  visit(root);
  return out;
}

/** Every `href` and image `src` under a subtree, menus left out, the live origin made relative. */
function addressesWithoutMenus(root: Hast, origin: string): string[] {
  const out: string[] = [];
  const visit = (node: Hast): void => {
    if (node.type !== "element" && node.type !== "root") return;
    if (node.type === "element") {
      if (NOT_TEXT.has(node.tagName!) && node.tagName !== "svg") return;
      if (isMenu(node)) return;
      const href = attrOf(node, "href");
      // A `#` address is a toggle, an opener or a back-to-top the converters turn into something else (link.approximated).
      if (node.tagName === "a" && href !== undefined && href !== "#") {
        out.push(href.startsWith(origin) ? href.slice(origin.length) || "/" : href);
      }
    }
    node.children?.forEach(visit);
  };
  visit(root);
  return out;
}

const firstClass = (e: Hast): string => classOf(e).split(" ")[0] ?? "";

/** The blocks the header part, then the footer part, are at the top of the site's blocks: the first and the last of them. */
function chromeOf(
  name: SiteName,
  doc: Hast,
  headerPart: string,
  footerPart: string,
): { header: Hast[]; footer: Hast[] } {
  const s = site(name);
  const count = (slug: string): number =>
    published(s, "wp_template_part")
      .filter((p) => p.slug === slug)
      .map((p) => parseBlocksOf(p.content).length)[0]!;
  const blocks = siteBlocks(doc);
  return {
    header: blocks.slice(0, count(headerPart)),
    footer: blocks.slice(blocks.length - count(footerPart)),
  };
}

const ORIGINS: Record<SiteName, string> = {
  fineline: "https://finelinepainting.pro",
  ap: "https://anabaptistperspectives.org",
};

describe("the header and footer of the built pages are the live ones", () => {
  const PAGES_OF_FINELINE = FIXTURE_PAGES.filter((p) => p.site === "fineline");

  for (const row of PAGES_OF_FINELINE) {
    test(`fineline ${row.path}: the same blocks, the same words and the same links around the content`, () => {
      const live = parseHtml(readFileSync(`${fixtureDir("fineline")}/html/${row.file}`, "utf8"));
      const own = htmlOf("fineline", row.path);
      const a = chromeOf("fineline", live, "header", "footer");
      const b = chromeOf("fineline", own, "header", "footer");
      expect(a.header.length).toBe(2);
      expect(b.header.map(firstClass)).toEqual(a.header.map(firstClass));
      expect(b.footer.map(firstClass)).toEqual(a.footer.map(firstClass));
      expect(b.header.flatMap(textsWithoutMenus)).toEqual(a.header.flatMap(textsWithoutMenus));
      expect(b.header.flatMap((e) => addressesWithoutMenus(e, ORIGINS.fineline))).toEqual(
        a.header.flatMap((e) => addressesWithoutMenus(e, ORIGINS.fineline)),
      );
      if (!/blog|choosing/.test(row.file)) {
        // The footer of a page template is the footer part alone. (A template with a call to action of its own after the
        // content, as the single post's, has one in the footer region too, and is judged whole below.)
        expect(b.footer.flatMap(textsWithoutMenus)).toEqual(a.footer.flatMap(textsWithoutMenus));
        expect(b.footer.flatMap((e) => addressesWithoutMenus(e, ORIGINS.fineline))).toEqual(
          a.footer.flatMap((e) => addressesWithoutMenus(e, ORIGINS.fineline)),
        );
      }
    });
  }

  test("fineline: the single post is the live page, word for word, whole", () => {
    const row = PAGES_OF_FINELINE.find((p) => p.file.startsWith("choosing"))!;
    const live = parseHtml(readFileSync(`${fixtureDir("fineline")}/html/${row.file}`, "utf8"));
    const own = htmlOf("fineline", row.path);
    const a = siteBlocks(live).flatMap(textsWithoutMenus);
    const b = siteBlocks(own).flatMap(textsWithoutMenus);
    expect(b).toEqual(a);
    const links = (blocks: Hast[], origin: string) =>
      blocks.flatMap((e) => addressesWithoutMenus(e, origin));
    expect(links(siteBlocks(own), ORIGINS.fineline)).toEqual(
      links(siteBlocks(live), ORIGINS.fineline),
    );
    // Same top-level structure, block by block.
    expect(siteBlocks(own).map(firstClass)).toEqual(siteBlocks(live).map(firstClass));
  });

  // The essays of the committed pages the fixture database holds (the fixtures keep at most a hundred posts of a type).
  const IN_DATABASE = new Set([
    "/essays/keeshons-story-a-knock-heard-round-the-hood-part-3/",
    "/essays/the-cultural-captivity-of-the-gospel/",
    "/essays/the-way-we-live-is-the-way-we-educate/",
  ]);
  const essays = FIXTURE_PAGES.filter((p) => p.site === "ap" && IN_DATABASE.has(p.path));

  test("three of the committed essays are in the database, and so in the built site", () => {
    expect(essays.length).toBe(3);
    for (const row of essays) {
      expect(site("ap").routes.byWpPath(row.path)).toBeDefined();
      expect(built("ap").exists(`${row.path.replace(/^\/|\/$/g, "")}/index.html`)).toBe(true);
    }
  });

  for (const row of essays) {
    test(`ap ${row.path}: the title and the hero are the live page's`, () => {
      const live = parseHtml(readFileSync(`${fixtureDir("ap")}/html/${row.file}`, "utf8"));
      const own = htmlOf("ap", row.path);
      const h1 = (doc: Hast) => findAll(doc, (e) => e.tagName === "h1").flatMap(textsOf);
      expect(h1(own)).toEqual(h1(live));
      expect(siteBlocks(own).length).toBeGreaterThan(5);
    });
  }
});

describe("fineline: the entry templates show the entry's fields, and the sections Cwicly gates on an ACF field follow the field", () => {
  const s = () => site("fineline");

  test("a project page hides the sections whose field is empty and shows the others, whatever the entry", () => {
    const gated = gatedBlocks(s(), "single-project");
    expect(gated.length).toBeGreaterThanOrEqual(5);
    const projects = IDS.fineline
      .map((id) => s().model.posts.get(id)!)
      .filter((p) => p.type === "project");
    const states = new Set<string>();
    for (const post of projects) {
      const route = s().routes.forPost(post.id)!;
      const doc = htmlOf("fineline", route.jxRoute);
      for (const { classID, field } of gated) {
        // The entry's own body is in the content block, and a body copied from another post can reuse a classID.
        const found = findAll(withoutContent(doc), (e) => classOf(e).split(" ").includes(classID));
        expect([route.jxRoute, classID, found.length]).toEqual([route.jxRoute, classID, 1]);
        const hidden = attrOf(found[0]!, "hidden") !== undefined;
        expect([route.jxRoute, classID, hidden]).toEqual([
          route.jxRoute,
          classID,
          !fieldFilled(s(), post, field),
        ]);
        states.add(hidden ? "hidden" : "shown");
      }
    }
    // The entries picked are the emptiest and the fullest: both outcomes are seen.
    expect([...states].sort()).toEqual(["hidden", "shown"]);
  });

  test("the rule that hides a section is written beside it, so the hidden attribute wins over the block's own display", () => {
    const o = out("fineline");
    const doc = docOf(o, "pages/project/[slug].json");
    const gated = gatedBlocks(s(), "single-project");
    for (const { classID } of gated) {
      const element = [...elementsOf(doc.children)].find((e) =>
        String(e.className).split(" ").includes(classID),
      )!;
      expect((element.style as Record<string, unknown>)["&[hidden]"]).toEqual({
        display: "none !important",
      });
      expect(typeof (element.attributes as Record<string, string>).hidden).toBe("string");
      expect((element.attributes as Record<string, string>).hidden).toContain("state.entry.data.");
    }
  });

  test("the entry's own fields are printed: the title and every ACF text the template binds", () => {
    const full = s().model.posts.get(IDS.fineline[2]!)!;
    expect(full.type).toBe("project");
    const route = s().routes.forPost(full.id)!;
    const words = textsOf(htmlOf("fineline", route.jxRoute)).join(" ").replace(/\s+/g, " ");
    expect(words).toContain(decodeTitle(full.title).replace(/\s+/g, " "));
    // The text fields of the project's field groups that the page binds and the entry holds.
    const bound = new Set(
      [
        ...fileOf(out("fineline"), "pages/project/[slug].json").matchAll(
          /state\.entry\.data\.([a-z_0-9]+)/g,
        ),
      ].map((m) => m[1]!),
    );
    const textFields = new Set<string>();
    const collect = (
      fields: readonly { name: string; type: string; subFields?: unknown }[],
    ): void => {
      for (const f of fields)
        if (f.type === "text" || f.type === "textarea") textFields.add(f.name);
    };
    for (const group of s().acf.groups)
      collect(group.fields as unknown as { name: string; type: string }[]);
    const meta = s().model.postMeta.get(full.id)!;
    let seen = 0;
    for (const name of bound) {
      const value = meta[name]?.[0];
      if (
        !textFields.has(name) ||
        typeof value !== "string" ||
        value.trim() === "" ||
        value === "0"
      )
        continue;
      const wanted = texturize(value).replace(/\s+/g, " ").trim();
      expect([name, words.includes(wanted)]).toEqual([name, true]);
      seen++;
    }
    expect(seen).toBeGreaterThan(5);
  });
});

/** The page without the subtree of the template's `cwicly/content` block, where the entry's own markup is. */
function withoutContent(doc: Hast): Hast {
  const copy = structuredClone(doc);
  walkHast(copy, (e) => {
    if (e.children)
      e.children = e.children.filter(
        (c) => !(c.type === "element" && /^content-c[0-9a-f]+$/.test(firstClass(c))),
      );
  });
  return copy;
}

function decodeTitle(title: string): string {
  return title.replaceAll("&amp;", "&").replaceAll("&#8217;", "’").replaceAll("&#8211;", "–");
}

describe("ap: the built page has the live page's top-level blocks, in order", () => {
  /** A block by its tag and its classes (the order the classes are written in is not a thing the page shows). */
  const skeleton = (doc: Hast): string[] =>
    siteBlocks(doc).map((e) => `${e.tagName}.${classOf(e).split(" ").sort().join(".")}`);

  /** Whether `a` is `b` with some entries left out, in order. */
  const isSubsequence = (a: string[], b: string[]): boolean => {
    let i = 0;
    for (const x of b) if (x === a[i]) i++;
    return i === a.length;
  };

  for (const row of FIXTURE_PAGES.filter((p) => p.site === "ap")) {
    test(`${row.path}`, () => {
      const route = site("ap").routes.byWpPath(row.path);
      if (!route || (route.kind === "entry" && !IDS.ap.includes(Number(route.id)))) return;
      const live = skeleton(
        parseHtml(readFileSync(`${fixtureDir("ap")}/html/${row.file}`, "utf8")),
      );
      // The header part's code block holds a donation banner (`ap-campaign-bar`) the committed live pages do not have: the
      // database is newer than the committed HTML (the fixtures are not one snapshot), so it is left out of the comparison.
      const own = skeleton(htmlOf("ap", route.jxRoute)).filter(
        (x) => !x.includes("ap-campaign-bar"),
      );
      // What the live page hid by a condition only the request can answer (a shortcode's answer, a cookie) is shown here, and reported.
      expect(isSubsequence(live, own)).toBe(true);
      const extra = own.length - live.length;
      const dropped = builds
        .get("ap")!
        .templates.report.entries()
        .filter((e) => e.code === "condition.dropped" && e.where?.endsWith(`//${row.template}`));
      expect(extra).toBeLessThanOrEqual(Math.max(dropped.length, 0));
      expect(own.filter((x) => !live.includes(x)).length).toBe(0);
    });
  }
});

// ── The headings of the built archive pages against the live ones ───────────────────────────────

/**
 * The first `h1` of live pages as WordPress printed them (observed 2026-10-05): what an archive's title prints
 * for the term it is on, and what the static headings of the templates say.
 */
const LIVE_H1: { site: SiteName; path: string; h1: string }[] = [
  { site: "ap", path: "/tag/work/", h1: "Tag: Work" },
  { site: "ap", path: "/category/bible/", h1: "Category: Bible" },
  {
    site: "ap",
    path: "/essays/series/a-knock-heard-round-the-hood/",
    h1: "Series: A Knock Heard Round the Hood",
  },
  { site: "ap", path: "/essays/season/season-1/", h1: "Season: Season 1" },
  { site: "fineline", path: "/project_type/agricultural/", h1: "Agricultural Projects" },
  {
    site: "fineline",
    path: "/service_area/adams-county-pa/",
    h1: "Professional Painters Serving Adams County, PA",
  },
  { site: "fineline", path: "/projects/", h1: "See Our Recent Projects" },
  { site: "fineline", path: "/services/", h1: "Certified Painting Contractor For Every Need" },
  { site: "fineline", path: "/author/chad-beiler/", h1: "Fine Tips from Fine Line" },
  { site: "fineline", path: "/category/blog/", h1: "Fine Tips from Fine Line" },
];

describe("the first heading of a built archive page is the live one", () => {
  for (const row of LIVE_H1) {
    test(`${row.site} ${row.path}: ${row.h1}`, () => {
      const doc = htmlOf(row.site, row.path);
      const h1 = findAll(doc, (e) => e.tagName === "h1").flatMap(textsOf);
      expect(h1[0]).toBe(row.h1);
    });
  }

  test("fineline: the 404 page says what the live one says, and has the search form the template had", () => {
    const doc = htmlOf("fineline", "/404/");
    expect(findAll(doc, (e) => e.tagName === "h1").flatMap(textsOf)[0]).toBe(
      "Grrr… can’t find that!",
    );
    const form = findAll(doc, (e) => e.tagName === "form" && attrOf(e, "role") === "search")[0]!;
    expect(attrOf(form, "action")).toBe("/search/");
    expect(attrOf(form, "method")).toBe("get");
  });

  test("the 404 and the search page are not in the sitemap, the posts index and the archives are", () => {
    for (const name of SITES) {
      const locs = [
        ...built(name)
          .read("sitemap.xml")
          .matchAll(/<loc>([^<]*)<\/loc>/g),
      ].map((m) => m[1]!.replace(/^https?:\/\/[^/]+/, ""));
      expect(locs.includes("/404")).toBe(false);
      expect(locs.includes("/search")).toBe(false);
      expect(locs.includes(name === "ap" ? "/essays" : "/blog")).toBe(true);
      expect(locs.length).toBeGreaterThan(50);
    }
  });

  test("a built entry's head says what Rank Math said about the entry", () => {
    for (const name of SITES) {
      const a = builds.get(name)!;
      const entry =
        a.templates &&
        IDS[name].map((id) => site(name).routes.forPost(id)).find((r) => r?.kind === "entry")!;
      const page = htmlOf(name, entry.jxRoute);
      const title = textsOf(findAll(page, (e) => e.tagName === "title")[0]!).join(" ");
      const file = a.files[entry.file]!;
      const yaml = /^---\n([\s\S]*?)\n---/.exec(file)![1]!;
      expect(yaml).toContain("seo:");
      // The collections module wrote the title Rank Math printed; the page's <title> is it.
      const seoTitle = /seo:[\s\S]*?\n {2}title: (.*)\n/
        .exec(yaml)?.[1]
        ?.replace(/^["']|["']$/g, "")
        .replaceAll("''", "'")
        .replaceAll('\\"', '"');
      expect(seoTitle).toBeDefined();
      expect(title).toBe(seoTitle!.replaceAll("&amp;", "&"));
    }
  });
});

// ── Routes the sites do not have ─────────────────────────────────────────────────────────────────

describe("route tables the fixtures do not have", () => {
  const withRoutes = (
    s: LoadedSite,
    dynamic: (real: ReturnType<LoadedSite["routes"]["dynamicPages"]>) => unknown[],
  ): LoadedSite =>
    ({
      ...s,
      routes: { ...s.routes, dynamicPages: () => dynamic(s.routes.dynamicPages()) },
    }) as unknown as LoadedSite;

  test("a hierarchical taxonomy's terms are nested data files read through a `path` parameter", async () => {
    const s = site("fineline");
    const dp = s.routes.dynamicPages().find((d) => d.source === "location")!;
    const routes = dp.routes.slice(0, 3).map((r, i) => ({
      ...r,
      jxRoute: `/service_area/${i === 0 ? "pennsylvania" : "pennsylvania/county"}/${s.model.terms.get(Number(r.id))!.slug}/`,
    }));
    const values = routes.map((r) => r.jxRoute.replace("/service_area/", "").replace(/\/$/, ""));
    const edited = withRoutes(s, () => [
      {
        ...dp,
        file: "pages/service_area/[...path].json",
        param: "path",
        routes,
        paths: { values, param: "path" },
      },
    ]);
    const o = await buildTemplates(edited, { only: ["taxonomy-location"] });
    const doc = docOf(o, "pages/service_area/[...path].json");
    expect(doc.$paths).toEqual({ values, param: "path" });
    expect((doc.state as Record<string, { id: unknown }>).term!.id).toEqual({
      $ref: "#/$params/path",
    });
    for (const value of values) {
      const data = JSON.parse(fileOf(o, `content/location/${value}.json`));
      expect(data.id).toBe(value);
    }
    expect(o.files.filter((f) => f.path.startsWith("content/location/"))).toHaveLength(3);
  });

  test("a route that is not one of the page's $paths values is an error, and has no data file", async () => {
    const s = site("fineline");
    const dp = s.routes.dynamicPages().find((d) => d.source === "location")!;
    const lost = { ...dp.routes[0]!, jxRoute: "/service_area/not-a-listed-term/" };
    const edited = withRoutes(s, () => [{ ...dp, routes: [lost, ...dp.routes.slice(1)] }]);
    const o = await buildTemplates(edited, { only: ["taxonomy-location"] });
    const e = o.report.entries().find((x) => x.code === "template.route-mismatch")!;
    expect(e.severity).toBe("error");
    expect(e.data?.route).toBe("/service_area/not-a-listed-term/");
    expect(o.files.filter((f) => f.path.startsWith("content/location/"))).toHaveLength(
      dp.routes.length - 1,
    );
  });

  test("a taxonomy that shares its name with a collection of entries gets its own name for the term data", async () => {
    const s = site("fineline");
    const dp = s.routes.dynamicPages().find((d) => d.source === "project_tag")!;
    // A taxonomy called `project`: the entries' collection is already named so.
    const renamed = { ...dp, source: "project", file: "pages/project_tag/[slug].json" };
    const edited = withRoutes(s, (real) => [...real.filter((d) => d.kind === "entries"), renamed]);
    const o = await buildTemplates(edited, { only: ["taxonomy-project_tag"] });
    expect(Object.keys(o.collections)).toEqual(["project-terms"]);
    const doc = docOf(o, "pages/project_tag/[slug].json");
    expect((doc.state as Record<string, { contentType: string }>).term!.contentType).toBe(
      "project-terms",
    );
    expect(o.files.some((f) => f.path.startsWith("content/project-terms/"))).toBe(true);
  });
});

describe("addresses the route table already gives to a page", () => {
  test("a route that owns pages/404.json or pages/search.json leaves this module's page out", async () => {
    const s = site("fineline");
    const page = [...s.routes.all()].find((r) => r.kind === "page")!;
    const routes = {
      ...s.routes,
      all: () => [
        ...s.routes.all(),
        { ...page, file: "pages/404.json", jxRoute: "/404/" },
        { ...page, file: "pages/search.json", jxRoute: "/search/" },
      ],
    };
    const o = await buildTemplates({ ...s, routes } as unknown as LoadedSite);
    expect(o.pages.some((p) => p.kind === "404" || p.kind === "search")).toBe(false);
    expect(o.notFound).toBeNull();
    expect(o.files.some((f) => f.path === "pages/404.json" || f.path === "pages/search.json")).toBe(
      false,
    );
  });
});

describe("a site that shows its latest posts on the front", () => {
  test("the front page is the posts index: `front-page`, `home`, `index`, and Rank Math's home title", async () => {
    const s = site("fineline");
    const model = {
      ...s.model,
      site: { ...s.model.site, showOnFront: "posts" as const, pageOnFront: 0, pageForPosts: 0 },
    };
    const routes = buildRoutes(model, s.acf, { media: s.media });
    const edited = {
      ...s,
      model,
      routes,
      urls: createUrlTools(model, routes, s.media),
    } as LoadedSite;
    const o = await buildTemplates(edited);
    const front = o.pages.find((p) => p.route === "/")!;
    expect(front).toMatchObject({ file: "pages/index.json", kind: "posts", template: "index" });
    const doc = docOf(o, "pages/index.json");
    expect(String(doc.title)).toContain(s.model.site.name.replaceAll("&amp;", "&"));
    expect(
      (doc.$head as { tagName: string; attributes: Record<string, string> }[]).find(
        (h) => h.attributes.rel === "canonical",
      )!.attributes.href,
    ).toBe(`${s.model.site.home}/`);
    expect(templateCandidates(edited, { kind: "posts", front: true })).toEqual([
      "front-page",
      "home",
      "index",
    ]);
    expect(crumbsFor(edited, { kind: "posts", route: "/" })).toEqual([]);
  });
});

describe("one page file for routes that select different templates", () => {
  test("a term with a template of its own: the page follows the template of most terms, and says how the others differ", async () => {
    const s = site("fineline");
    const index = templateOf(s, "index")!;
    const extra: WpPost = { ...index, id: 987654, slug: "taxonomy-project_tag-berks-county" };
    const edited = withModel(s, (posts) => posts.set(extra.id, extra));
    const o = await buildTemplates(edited, {
      only: ["taxonomy-project_tag", "taxonomy-project_tag-berks-county"],
    });
    const page = o.pages.find((p) => p.file === "pages/project_tag/[slug].json")!;
    expect(page.template).toBe("taxonomy-project_tag");
    const e = o.report.entries().find((x) => x.code === "template.term-split")!;
    expect(e.severity).toBe("warn");
    const total = s.routes.dynamicPages().find((d) => d.source === "project_tag")!.routes.length;
    expect(e.data?.templates).toEqual({
      "taxonomy-project_tag": total - 1,
      "taxonomy-project_tag-berks-county": 1,
    });
    expect(e.message).toContain("follows taxonomy-project_tag");
    // The other template still has its layout.
    expect(o.layouts["taxonomy-project_tag-berks-county"]).toBeDefined();
  });

  test("an entry that a Cwicly rule sends to another template: the same, for an entry page", async () => {
    const s = site("fineline");
    const projects = published(s, "project");
    const picked = projects[0]!;
    const edited = withRules(s, {
      "test-header": rule({ singular: [{ target: "project", data: [picked.id] }] }),
    });
    const o = await buildTemplates(edited, { only: ["single-project", "test-header"] });
    const e = o.report.entries().find((x) => x.code === "template.entry-split")!;
    expect(e.data?.templates).toEqual({
      "single-project":
        s.routes.dynamicPages().find((d) => d.source === "project")!.routes.length - 1,
      "test-header": 1,
    });
    expect(o.pages.find((p) => p.file === "pages/project/[slug].json")!.template).toBe(
      "single-project",
    );
    // layoutFor still says what that one entry's own template is (a page template, so its chrome-only layout is the -frame one).
    expect(layoutFor(edited, { kind: "post", id: picked.id })).toBe(
      "./layouts/test-header-frame.json",
    );
    expect(o.frames["test-header"]).toBe("./layouts/test-header-frame.json");
  });
});

describe("layout file names", () => {
  test("a template named like the document frame or the fallback page does not take their files", async () => {
    const s = site("fineline");
    const index = templateOf(s, "index")!;
    const edited = withModel(s, (posts) => {
      posts.set(990001, { ...index, id: 990001, slug: "base" });
      posts.set(990002, { ...index, id: 990002, slug: "fallback" });
    });
    const o = await buildTemplates(edited, { only: ["base", "fallback"] });
    // Both are page templates by name, so both are the layouts a page could choose.
    expect(o.layouts.base).toBe("./layouts/base-template.json");
    expect(o.layouts.fallback).toBe("./layouts/fallback-template.json");
    const paths = o.files.map((f) => f.path);
    expect(paths).toContain("layouts/base-template.json");
    expect(paths).toContain("layouts/fallback-template.json");
    // The document frame is still where every layout nests.
    expect(docOf(o, "layouts/base-template.json").$layout).toBe(BASE_LAYOUT);
    expect(docOf(o, "layouts/base.json").$layout).toBeUndefined();
    expect(layoutPathOf(edited, "base", "slotted")).toBe("./layouts/base-template.json");
  });
});

describe("the search page", () => {
  for (const name of SITES) {
    test(`${name}: the results list and the state behind it are gone, and the notice says why`, async () => {
      const o = await buildTemplates(site(name), { only: ["search"] });
      const doc = docOf(o, "pages/search.json");
      expect(doc.state).toBeUndefined();
      expect(JSON.stringify(doc.children)).not.toContain("$prototype");
      expect(JSON.stringify(doc.children)).toContain(
        "Search is not available on this copy of the site.",
      );
      // (A part's own state, the footer's list of terms, is not the search page's.)
      expect([...o.used.states].filter((k) => k.startsWith("post_"))).toEqual([]);
      const e = o.report.entries().find((x) => x.code === "template.search")!;
      expect(e.severity).toBe("warn");
      // ap's results list sits beside a "No results found" paragraph that reads its state, and a "Load more" link.
      expect(e.data).toEqual({ template: "search", replaced: 1, removed: name === "ap" ? 3 : 0 });
      expect(e.message).toContain("replaced by a notice");
      // The form of the template is still there (in the page, or in the layout when it shares a block with the header), and posts to the search page's address.
      const forms = [
        ...elementsOf(doc.children),
        ...elementsOf(docOf(o, "layouts/search.json").children),
      ].filter((x) => x.tagName === "form");
      expect(forms.length).toBeGreaterThan(0);
      expect((forms[0]!.attributes as Record<string, string>).action).toBe("/search/");
    });
  }
});

describe("fallback pages build", () => {
  test("a site with no template at all still builds, every route family a page with the minimal layout", async () => {
    const s = site("fineline");
    const bare = withModel(s, (posts) => {
      for (const [id, post] of posts) if (post.type === "wp_template") posts.delete(id);
    });
    const want = new Set(IDS.fineline);
    const collections = await buildCollections(bare, { include: (post) => want.has(post.id) });
    const o = await buildTemplates(bare);
    const files: Record<string, string> = {};
    for (const f of [...collections.files, ...o.files]) files[f.path] = f.content;
    files["project.json"] = JSON.stringify({
      name: "fallback",
      url: s.model.site.url,
      extensions: ["@jxsuite/parser"],
      $media: s.options.media,
      content: { ...collections.collections, ...o.collections },
    });
    const project = await buildJxProject(files, { name: "templates-fallback", timeoutMs: 280_000 });
    expect((await validateJxProject(project.dir)).problems).toEqual([]);
    const doc = parseHtml(project.html("/404/"));
    expect(findAll(doc, (e) => e.tagName === "main").length).toBe(1);
    expect(findAll(doc, (e) => e.tagName === "h1").flatMap(textsOf)).toEqual(["Page not found"]);
    // An entry: its title and its body, in the fallback layout.
    const route = s.routes.forPost(IDS.fineline[1]!)!;
    const entry = parseHtml(project.html(route.jxRoute));
    expect(findAll(entry, (e) => e.tagName === "article").length).toBe(1);
    const h1 = findAll(entry, (e) => e.tagName === "h1").flatMap(textsOf);
    expect(h1[0]).toBe(decodeTitle(s.model.posts.get(IDS.fineline[1]!)!.title));
    // A listing: the entries the collection has, as links.
    const list = parseHtml(project.html("/projects/"));
    expect(findAll(list, (e) => e.tagName === "a").length).toBeGreaterThan(0);
  });
});

describe("data that holds a dollar-brace", () => {
  test("a term whose name or description would be read as a binding is written with a zero-width space, and said", async () => {
    const s = site("fineline");
    const term = termBySlug(s, "project_tag", "agricultural-projects");
    const edited = {
      ...s,
      model: {
        ...s.model,
        terms: new Map(s.model.terms).set(term.termId, {
          ...term,
          name: "Barns ${state.entry.data.title}",
          description: "see ${1 + 1}",
        }),
      },
    } as LoadedSite;
    const o = await buildTemplates(edited, { only: ["taxonomy-project_tag"] });
    const text = fileOf(o, "content/project_tag/agricultural-projects.json");
    expect(text).not.toContain("${");
    const data = JSON.parse(text);
    expect(data.name).toBe("Barns $​{state.entry.data.title}");
    expect(data.description).toBe("see $​{1 + 1}");
    const e = o.report.entries().find((x) => x.code === "template.literal-template")!;
    expect(e.severity).toBe("warn");
    expect(e.where).toBe("pages/project_tag/[slug].json");
  });
});

describe("conversions are shared", () => {
  test("a template or a part is converted once for each way it is used, whatever number of layouts and pages need it", async () => {
    const s = site("ap");
    const calls: string[] = [];
    const o = await buildTemplates(s, {
      convert: (_s, subject, opts) => {
        calls.push(`${JSON.stringify(subject)}|${JSON.stringify(opts ?? {})}`);
        return convertSubject(s, subject, opts);
      },
    });
    expect(new Set(calls).size).toBe(calls.length);
    // The header part is in a dozen layouts and a dozen pages, and was converted once.
    expect(calls.filter((c) => c.startsWith('{"kind":"part","slug":"header"}'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('{"kind":"part"'))).toHaveLength(o.parts.length);
    // Every finding of a conversion is in the report once, not once per place it was used (the search template is
    // the body of the search page and the chrome of its layout).
    const direct = await convertSubject(
      s,
      { kind: "template", slug: "search" },
      { mode: "static", target: "page" },
    );
    const count = (
      entries: readonly { code: string; where?: string }[],
    ): Record<string, number> => {
      const found: Record<string, number> = {};
      for (const e of entries)
        if (e.where === "template:cwicly//search") found[e.code] = (found[e.code] ?? 0) + 1;
      return found;
    };
    const own = count(o.report.entries());
    for (const [code, n] of Object.entries(count(direct.report.entries()))) {
      expect([code, own[code]]).toEqual([code, n]);
    }
  });
});

describe("rules that cannot stay on an element", () => {
  test("a rule about the document itself (body:has(…), :root:has(…)) is for the project's style, and is in no component", () => {
    for (const name of SITES) {
      const o = out(name);
      expect(o.used.documentRules.length).toBeGreaterThan(0);
      for (const rule of o.used.documentRules)
        expect(rule.selector).toMatch(/^(?:body|html|:root)/);
      const written = o.files
        .filter((f) => f.path.startsWith("components/"))
        .map((f) => f.content)
        .join("");
      for (const rule of o.used.documentRules) {
        for (const part of rule.selector.split(/,\s*(?=:root|body|html)/)) {
          expect(written.includes(JSON.stringify(`& ${part}`).slice(1, -1))).toBe(false);
        }
      }
    }
    expect(out("fineline").used.documentRules.map((r) => r.selector)).toEqual([
      'body:has(.cc-nav[breakpoint="md"] > .cc-nav-wrapper[popover]:popover-open)',
    ]);
  });

  test("a rule about a class or a tag stays in the component that made it, scoped under the component's tag", () => {
    const footer = docOf(out("ap"), "components/wp-footer.json");
    const style = footer.style as Record<string, unknown>;
    expect(style.display).toBe("contents");
    const nested = Object.keys(style).filter((k) => k.startsWith("& "));
    expect(nested.length).toBeGreaterThan(3);
    expect(nested).toContain("& .cc-mdl[popover]");
  });

  test("rules that have no component or page to live in are for the project: the keyframes and the tag rule of the data converter", () => {
    const rules = out("ap").used.hoisted.map((r) => r.selector);
    expect(rules).toContain("@keyframes fade-in");
    expect(rules).toContain("@keyframes background-blur");
    expect(rules).toContain("wp-query-pagination");
  });
});

// ── The head of a dynamic page ───────────────────────────────────────────────────────────────────

/** A value of the shape PHP's `serialize()` writes, for the options a test edits. */
function phpSerialize(value: unknown): string {
  if (value === null || value === undefined) return "N;";
  if (typeof value === "boolean") return `b:${value ? 1 : 0};`;
  if (typeof value === "number") return `i:${value};`;
  if (typeof value === "string") return `s:${Buffer.byteLength(value)}:"${value}";`;
  const entries = Array.isArray(value)
    ? value.map((v, i): [string | number, unknown] => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const body = entries.map(([k, v]) => `${phpSerialize(k)}${phpSerialize(v)}`).join("");
  return `a:${entries.length}:{${body}}`;
}

/** A site whose option `name` is `value` (a string is stored as it is, anything else serialised). */
const withOption = (s: LoadedSite, name: string, value: unknown): LoadedSite =>
  ({
    ...s,
    model: {
      ...s.model,
      options: new Map(s.model.options).set(
        name,
        typeof value === "string" ? value : phpSerialize(value),
      ),
    },
  }) as LoadedSite;

/** A site whose option `name` (a serialised array) has `edit` merged in. */
function withSetting(s: LoadedSite, name: string, edit: Record<string, unknown>): LoadedSite {
  const stored = maybeUnserialize(s.model.options.get(name) ?? "") as Record<string, unknown>;
  return withOption(s, name, { ...stored, ...edit });
}

/** A site whose post has one more meta value. */
function withMeta(s: LoadedSite, id: number, key: string, value: unknown): LoadedSite {
  const postMeta = new Map(s.model.postMeta);
  postMeta.set(id, { ...postMeta.get(id), [key]: [value] });
  return { ...s, model: { ...s.model, postMeta } } as LoadedSite;
}

/** The `<head>` of a built page. */
const headOf = (name: SiteName, route: string): string =>
  /<head[\s\S]*?<\/head>/.exec(built(name).html(route))?.[0] ?? "";

/** A tag's attribute in a built head: `meta[name=robots]` → its `content`. */
function headTag(
  head: string,
  key: "name" | "property" | "rel",
  value: string,
): string | undefined {
  for (const tag of head.match(/<(?:meta|link)\b[^>]*>/g) ?? []) {
    if (!new RegExp(`\\b${key}="${value}"`).test(tag)) continue;
    return /\b(?:content|href)="([^"]*)"/.exec(tag)?.[1];
  }
  return undefined;
}

describe("boundHead leaves an attribute out only by not writing the tag", () => {
  test("`$head` prints `false`: no value of a head entry is `false`, `undefined` or `null`", () => {
    // Measured: `content="${x || false}"` in `$head` builds to `content="false"`, where the same
    // expression in an element's attributes omits the attribute (docs/bindings.md, rule 3).
    const head = boundHead("state.term.data", "https://example.com", undefined, "article");
    for (const h of head) {
      for (const value of Object.values(h.attributes)) expect(value).not.toMatch(/false|null/);
    }
    for (const key of ["description", "robots", "og:description", "twitter:description"]) {
      expect(
        head.find((h) => h.attributes.name === key || h.attributes.property === key)!.attributes
          .content,
      ).toMatch(/\?\? ''\}$/);
    }
    const src = head.find((h) => h.attributes.property === "og:image")!.attributes.content!;
    expect(src).toContain(": '')(state.term.data.seo?.image?.src)");
  });

  test("a tag no route can fill is not written: a term and an author have no image", () => {
    const head = boundHead("state.author.data", "https://example.com", undefined, "profile", {
      description: false,
      image: false,
      robots: true,
    });
    const keys = head.map((h) => h.attributes.name ?? h.attributes.property ?? h.attributes.rel);
    for (const key of [
      "description",
      "og:description",
      "twitter:description",
      "og:image",
      "og:image:width",
      "og:image:height",
      "og:image:alt",
      "twitter:image",
    ]) {
      expect(keys).not.toContain(key);
    }
    expect(keys).toContain("robots");
    expect(keys).toContain("canonical");
    expect(head.find((h) => h.attributes.property === "og:type")!.attributes.content).toBe(
      "profile",
    );
    const none = boundHead("state.term.data", "https://example.com", undefined, "article", {
      robots: false,
    });
    expect(none.some((h) => h.attributes.name === "robots")).toBe(false);
  });

  for (const name of SITES) {
    test(`${name}: no built page prints content="false" (or undefined, null or an unevaluated binding) in its head`, () => {
      const pages = built(name)
        .list()
        .filter((path) => path.endsWith(".html"));
      expect(pages.length).toBeGreaterThan(20);
      const bad: string[] = [];
      for (const path of pages) {
        const head = /<head[\s\S]*?<\/head>/.exec(built(name).read(path))?.[0] ?? "";
        for (const tag of head.match(/<(?:meta|link)\b[^>]*>/g) ?? []) {
          const value = /\b(?:content|href)="([^"]*)"/.exec(tag)?.[1];
          if (value !== undefined && /^(?:false|undefined|null)$|\$\{/.test(value)) {
            bad.push(`${path} ${tag}`);
          }
        }
      }
      expect(bad).toEqual([]);
    });
  }

  test("fineline: an author archive is noindex as Rank Math prints it, with no trailing space in its title and og:type profile", () => {
    const route = site("fineline")
      .routes.all()
      .find((r) => r.kind === "author")!.jxRoute;
    const head = headOf("fineline", route);
    expect(headTag(head, "name", "robots")).toBe("follow, noindex");
    expect(headTag(head, "property", "og:type")).toBe("profile");
    expect(headTag(head, "property", "og:image")).toBeUndefined();
    const title = /<title>([^<]*)<\/title>/.exec(head)![1]!;
    expect(title).toBe(title.trim());
    expect(title).toMatch(/ - finelinepainting\.pro$/);
    const data = parse(fileOf(out("fineline"), `content/author/${route.split("/")[2]}.json`));
    expect((data.seo as Record<string, string>).title).toBe(title);
  });

  test("ap: an author archive is indexable with the advanced directives, a term is og:type article", () => {
    const route = site("ap")
      .routes.all()
      .find((r) => r.kind === "author")!.jxRoute;
    const head = headOf("ap", route);
    expect(headTag(head, "name", "robots")).toBe(
      "follow, index, max-snippet:-1, max-video-preview:-1, max-image-preview:large",
    );
    expect(headTag(head, "property", "og:type")).toBe("profile");
    const term = site("ap")
      .routes.dynamicPages()
      .find((dp) => dp.kind === "terms")!.routes[0]!;
    expect(headTag(headOf("ap", term.jxRoute), "property", "og:type")).toBe("article");
  });

  test("authorRobots: Rank Math's own setting when custom robots are on, else the site's, always an index and a follow", () => {
    expect(authorRobots({ author_custom_robots: "on", author_robots: ["noindex"] })).toBe(
      "follow, noindex",
    );
    expect(
      authorRobots({ author_custom_robots: true, author_robots: ["noindex", "nofollow"] }),
    ).toBe("nofollow, noindex");
    expect(
      authorRobots({
        author_custom_robots: "on",
        author_robots: ["index"],
        author_advanced_robots: { "max-snippet": "-1", "max-image-preview": "large" },
      }),
    ).toBe("follow, index, max-snippet:-1, max-image-preview:large");
    // Custom robots off: the site-wide ones, and the default advanced directives.
    expect(authorRobots({ author_custom_robots: "off", author_robots: ["noindex"] })).toBe(
      "index, follow, max-snippet:-1, max-video-preview:-1, max-image-preview:large",
    );
    expect(authorRobots({ robots_global: ["noarchive"] })).toBe(
      "follow, index, noarchive, max-snippet:-1, max-video-preview:-1, max-image-preview:large",
    );
    expect(
      authorRobots({ advanced_robots_global: { "max-snippet": 50 }, author_custom_robots: "off" }),
    ).toBe("index, follow, max-snippet:50, max-video-preview:-1, max-image-preview:large");
    // A site that asks search engines to stay away says so on every page, and has no advanced directives.
    expect(authorRobots({ author_custom_robots: "on", author_robots: ["index"] }, "0")).toBe(
      "nofollow, noindex",
    );
    expect(authorRobots({}, "0")).toBe("noindex, nofollow");
    // nosnippet suppresses the advanced list too.
    expect(authorRobots({ robots_global: ["nosnippet"] })).toBe("follow, index, nosnippet");
  });

  test("the author's description comes from Rank Math's option, rendered for the name", async () => {
    const s = withSetting(site("ap"), "rank-math-options-titles", {
      author_archive_description: "Writing by %name% %page%",
    });
    const o = await buildTemplates(s, { only: ["author"] });
    const file = o.files.find((f) => f.path.startsWith("content/author/"))!;
    const seo = (parse(file.content).seo as Record<string, string>).description!;
    expect(seo).toMatch(/^Writing by [^%]+$/);
    expect(seo).toBe(seo.trim());
  });
});

// ── template-loader.php's lists, as template.php spells them ─────────────────────────────────────

describe("templateCandidates: the decoded slug, the term id and a post's own template", () => {
  const fl = () => site("fineline");
  const fakeTerm = (taxonomy: string, slug: string): WpTerm => ({
    ...termBySlug(fl(), "project_tag", "agricultural-projects"),
    taxonomy,
    slug,
    termId: 77,
  });

  test("every term list is decoded slug, slug, id, then the generic name (get_{category,tag,taxonomy}_template)", () => {
    for (const [taxonomy, expected] of [
      [
        "category",
        ["category-café", "category-caf%c3%a9", "category-77", "category", "archive", "index"],
      ],
      ["post_tag", ["tag-café", "tag-caf%c3%a9", "tag-77", "tag", "archive", "index"]],
      [
        "location",
        [
          "taxonomy-location-café",
          "taxonomy-location-caf%c3%a9",
          "taxonomy-location-77",
          "taxonomy-location",
          "taxonomy",
          "archive",
          "index",
        ],
      ],
    ] as const) {
      expect([
        taxonomy,
        templateCandidates(fl(), { kind: "term", term: fakeTerm(taxonomy, "caf%c3%a9") }),
      ]).toEqual([taxonomy, [...expected]]);
    }
  });

  test("a term with no slug has only the generic names, as `! empty( $term->slug )` has it", () => {
    expect(templateCandidates(fl(), { kind: "term", term: fakeTerm("location", "") })).toEqual([
      "taxonomy",
      "archive",
      "index",
    ]);
    expect(templateCandidates(fl(), { kind: "term", term: fakeTerm("category", "") })).toEqual([
      "category",
      "archive",
      "index",
    ]);
  });

  test("an entry's list has the decoded name first, and the post's own page template ahead of both", () => {
    const base = published(fl(), "project")[0]!;
    const odd: WpPost = { ...base, slug: "caf%c3%a9" };
    expect(templateCandidates(fl(), { kind: "single", post: odd })).toEqual([
      "single-project-café",
      "single-project-caf%c3%a9",
      "single-project",
      "single",
      "singular",
      "index",
    ]);
    const own = withMeta(fl(), base.id, "_wp_page_template", "wp-custom-template-wide");
    expect(templateCandidates(own, { kind: "single", post: base }).slice(0, 3)).toEqual([
      "wp-custom-template-wide",
      `single-project-${base.slug}`,
      "single-project",
    ]);
    // `default` and an empty value are no template.
    for (const value of ["default", ""]) {
      const none = withMeta(fl(), base.id, "_wp_page_template", value);
      expect(templateCandidates(none, { kind: "single", post: base })[0]).toBe(
        `single-project-${base.slug}`,
      );
    }
    // A post with no name tries the type's list only.
    expect(templateCandidates(fl(), { kind: "single", post: { ...base, slug: "" } })).toEqual([
      "single-project",
      "single",
      "singular",
      "index",
    ]);
  });

  test("a page that is the front page and the privacy page tries front-page first", () => {
    const home = postBySlug(fl(), "page", "home-2");
    const both = withOption(fl(), "wp_page_for_privacy_policy", String(home.id));
    expect(templateCandidates(both, { kind: "page", post: home }).slice(0, 3)).toEqual([
      "front-page",
      "privacy-policy",
      "page-home-2",
    ]);
  });

  test("a single entry's own page template that the theme does not have is reported, as a page's is", () => {
    const base = published(fl(), "project")[0]!;
    const own = withMeta(fl(), base.id, "_wp_page_template", "no-such-template");
    const report = createReport();
    const choice = selectTemplate(own, { kind: "single", post: base }, report);
    expect(choice.tried[0]).toBe("no-such-template");
    expect(choice.slug).toBe("single-project");
    const found = report.entries().find((e) => e.code === "template.page-template-missing")!;
    expect(found.where).toBe(`post:${base.id}`);
  });
});

describe("cwiclyRule: `all` is the string true and nothing else", () => {
  const fl = () => site("fineline");
  const about = () => ({ kind: "page", post: postBySlug(fl(), "page", "about-us") }) as const;
  const include = (all: unknown) =>
    rule({ all: all as string, includeCondition: "or", overridePageTemplate: true });

  test("a boolean or a number does not apply a template (`'true' === $value->all`)", () => {
    expect(choose(withRules(fl(), { "test-header": include("true") }), about())).toBe(
      "test-header",
    );
    for (const all of [true, 1, "1", "on", "false"]) {
      expect([all, choose(withRules(fl(), { "test-header": include(all) }), about())]).toEqual([
        all,
        "page",
      ]);
    }
  });

  test("an exclude rule's `all` is the same test", () => {
    const s = (all: unknown) =>
      withRules(fl(), { "test-header": include("true") }, { "test-header": noExclude({ all }) });
    expect(choose(s("true"), about())).toBe("page");
    for (const all of [true, 1]) expect(choose(s(all), about())).toBe("test-header");
  });

  test("overridePageTemplate is PHP truthiness: true, 1 and the string all say yes", () => {
    const page = postBySlug(fl(), "page", "about-us");
    const named = withMeta(fl(), page.id, "_wp_page_template", "test-header-2");
    const rules = (override: unknown) =>
      withRules(named, {
        "test-header": rule({
          all: "true",
          includeCondition: "or",
          overridePageTemplate: override,
        }),
      });
    expect(choose(rules(false), { kind: "page", post: page })).toBe("page");
    for (const override of [true, 1, "true"]) {
      expect([override, choose(rules(override), { kind: "page", post: page })]).toEqual([
        override,
        "test-header",
      ]);
    }
  });
});

describe("fragmentParts: a part with no exclude entry is never printed", () => {
  const withFragment = (include: Record<string, Rule>, exclude: Record<string, Rule>) =>
    ({
      options: {
        globalParts: { fragments: { f: { conditions: { include, exclude } } } },
      },
    }) as unknown as Pick<SiteContext, "options">;

  test("`cc_condition_checker` adds a part only after it has read the exclude entry", () => {
    const skipped: string[] = [];
    const parts = fragmentParts(
      withFragment(
        {
          a: rule({ all: "true", includeCondition: "or" }),
          b: rule({ all: "true", includeCondition: "or" }),
          c: rule({ archive: [{ target: "search" }], includeCondition: "or" }),
          // Never matches: no report, an exclude entry or not.
          d: rule({ all: "false", includeCondition: "or" }),
        },
        { b: noExclude() },
      ),
      "f",
      (slug) => skipped.push(slug),
    );
    expect(parts).toEqual({ always: ["b"], conditional: [] });
    expect(skipped).toEqual(["a", "c"]);
  });

  test("the base layout leaves such a part out and says so", async () => {
    const edited = withOptions(site("ap"), {
      globalParts: {
        fragments: {
          globalheader: {
            conditions: {
              include: { "top-menu": rule({ all: "true", includeCondition: "or" }) },
              exclude: {},
            },
          },
        },
      },
    });
    const o = await buildTemplates(edited);
    const kids = childrenOf(docOf(o, "layouts/base.json")) as JxElement[];
    expect(kids.map((k) => k.tagName)).toEqual(["div"]);
    const said = o.report
      .entries()
      .find((e) => e.code === "template.rule-no-exclude" && e.data?.fragment);
    expect(said?.data).toEqual({ fragment: "globalheader", part: "top-menu" });
    expect(said?.where).toBe("option:cwicly_global_parts");
  });
});

// ── The search page keeps nothing of the state it dropped ────────────────────────────────────────

/** Every `state.<key>` and `#/state/<key>` a document reads that is not an entry of its own `state`. */
function danglingState(doc: Record<string, unknown>): string[] {
  const declared = new Set(Object.keys((doc.state as object | undefined) ?? {}));
  const text = JSON.stringify({ ...doc, state: undefined });
  const found = new Set<string>();
  for (const m of text.matchAll(/(?<![\w$.])state\.([A-Za-z_][\w]*)/g)) found.add(m[1]!);
  for (const m of text.matchAll(/#\/state\/([^/"]+)/g)) found.add(m[1]!);
  return [...found].filter((key) => !declared.has(key)).sort();
}

describe("withoutResults takes with the results list what reads its state", () => {
  const loop = (key: string): JxNode =>
    ({
      $prototype: "Array",
      items: { $ref: `#/state/${key}` },
      map: el("article"),
    }) as unknown as JxNode;
  const tree = (): JxNode[] => [
    el("div", {
      children: [
        el("p", {
          textContent: "No results found.",
          attributes: { hidden: "${(state.post_q1.length) > 0}" },
        }),
        el("div", { children: [loop("post_q1")] }),
        el("div", {
          children: [
            el("a", {
              className: "load-more-button button-default cc-btn",
              attributes: { id: "load-more-button" },
              textContent: "Load More",
            }),
          ],
        }),
        el("p", { textContent: "kept" }),
        // Another entry, and names that only begin like the dropped one.
        el("p", { textContent: "${state.other.x}" }),
        el("p", { textContent: "${state.post_q10.x}" }),
        el("p", { innerHTML: "${state.post_q1x}" }),
      ],
    }),
  ];
  const state = () => ({ post_q1: {}, other: {}, post_q10: {}, post_q1x: {} });

  test("the no-results paragraph, a node of the loop's state in a style or markup, the load more link and its emptied box are removed", () => {
    const nodes = tree();
    (nodes[0] as JxElement & { children: JxNode[] }).children.push(
      el("section", { innerHTML: "${state.post_q1.map((x) => x.id).join('')}" }),
      el("span", { style: { width: "${state.post_q1.length}px" } }),
      el("ul", { children: "${state.post_q1.map((x) => x)}" as never }),
    );
    const cut = withoutResults(nodes, state());
    expect(cut.replaced).toBe(1);
    expect(cut.dropped).toEqual(["post_q1"]);
    // paragraph, load more, its box, the section, the span and the ul
    expect(cut.removed).toBe(6);
    const left = JSON.stringify(cut.nodes);
    expect(left).not.toContain("state.post_q1.");
    expect(left).not.toContain("No results found");
    expect(left).not.toContain("load-more");
    expect(left).toContain("Search is not available");
    expect(left).toContain("kept");
    expect(left).toContain("state.other.x");
    // A longer name is another entry.
    expect(left).toContain("state.post_q10.x");
    expect(left).toContain("state.post_q1x");
  });

  test("a tree with no results loop is returned as it was: nothing reads a dropped entry, so nothing goes", () => {
    const nodes = tree();
    (nodes[0] as JxElement & { children: JxNode[] }).children.splice(1, 1);
    const before = JSON.stringify(nodes);
    const cut = withoutResults(nodes, state());
    expect(cut.replaced).toBe(0);
    expect(cut.removed).toBe(0);
    expect(cut.dropped).toEqual([]);
    expect(JSON.stringify(cut.nodes)).toBe(before);
  });
});

describe("the search page", () => {
  for (const name of SITES) {
    test(`${name}: no node reads a state the page dropped, and the built page ships no JavaScript`, async () => {
      const doc = docOf(out(name), "pages/search.json");
      expect(danglingState(doc)).toEqual([]);
      const text = JSON.stringify(doc);
      expect(text).not.toContain("post_q1");
      expect(text).not.toContain("No results found");
      expect(text).not.toContain("load-more");
      const html = built(name).html("/search/");
      expect(html).not.toMatch(/src="[^"]*app\.js"/);
      expect(html).not.toContain("data-bind");
      expect(html).toContain("Search is not available on this copy of the site.");
      expect(html).not.toContain("No results found");
    });
  }

  test("every page this module writes reads only state it declares (a layout reads its page's)", () => {
    for (const name of SITES) {
      for (const page of out(name).pages) {
        const doc = docOf(out(name), page.file);
        expect([name, page.file, danglingState(doc)]).toEqual([name, page.file, []]);
      }
    }
  });

  test("ap: the report says how many nodes went with the list", () => {
    const e = out("ap")
      .report.entries()
      .find((x) => x.code === "template.search")!;
    expect(e.message).toContain("3 nodes that read the results or load more of them are removed");
  });
});

// ── Addresses and escapes in what a template writes ──────────────────────────────────────────────

describe("a style's url() is the project's, as emit/pages.ts makes it", () => {
  const SOURCE_UPLOADS = /https?:\/\/[^"')\s]*\/wp-content\/uploads\//;

  test("fineline: the header's swash is /media/..., and no file the module writes names the source site's uploads", async () => {
    const s = site("fineline");
    const direct = await convertSubject(
      s,
      { kind: "part", slug: "header" },
      { mode: "static", target: "page" },
    );
    // The conversion itself holds the live address: this module is the one that moves it.
    expect(JSON.stringify(direct.nodes)).toMatch(SOURCE_UPLOADS);
    const header = fileOf(out("fineline"), "components/wp-header.json");
    expect(header).toContain("url(/media/swash.svg)");
    for (const name of SITES) {
      for (const file of out(name).files) {
        expect([name, file.path, SOURCE_UPLOADS.test(file.content)]).toEqual([
          name,
          file.path,
          false,
        ]);
      }
    }
    // The pages that carry the same kind of background (pages/services.json and the entry pages).
    expect(fileOf(out("fineline"), "pages/services.json")).toContain("url(/media/");
  });

  test("nested styles and hoisted rules are rewritten, a binding and an external address are not, and the shared conversion is left as it was", async () => {
    const s = site("fineline");
    const live = `${s.model.site.url}/wp-content/uploads/swash.svg`;
    const kept: Converted[] = [];
    const o = await buildTemplates(s, {
      only: ["page"],
      convert: async (site0, subject, opts) => {
        const made = await convertSubject(site0, subject, opts);
        if (subject.kind !== "part" || subject.slug !== "footer") return made;
        const nodes: JxNode[] = [
          el("div", {
            style: {
              backgroundImage: `url("${live}")`,
              ":hover": { backgroundImage: `url('${live}')` },
              "@--md": { backgroundImage: `url(${live})` },
              maskImage: "url(https://cdn.example.com/x.svg)",
              borderImage: "url(${state.entry.data.img.src})",
            } as never,
          }),
        ];
        const result = {
          ...made,
          nodes,
          hoisted: [
            { selector: ".x", style: { backgroundImage: `url(${live})` } },
          ] as unknown as Converted["hoisted"],
        };
        kept.push(result);
        return result;
      },
    });
    const footer = fileOf(o, "components/wp-footer.json");
    expect(footer).not.toContain(live);
    expect(footer).toContain('"backgroundImage": "url(\\"/media/swash.svg\\")"');
    expect(footer).toContain("url('/media/swash.svg')");
    expect(footer).toContain("https://cdn.example.com/x.svg");
    expect(footer).toContain("url(${state.entry.data.img.src})");
    expect(JSON.stringify(kept[0]!.nodes)).toContain(live);
    expect(JSON.stringify(kept[0]!.hoisted)).toContain(live);
    expect(JSON.stringify(o.used.hoisted)).not.toContain(live);
  });
});

describe("literal text beside a binding is escaped for the template literal it becomes", () => {
  const build = async (state: Record<string, unknown>, children: JxNode[]) => {
    const project = await buildJxProject(
      {
        "project.json": { name: "t", url: "https://t.test" },
        "pages/index.json": { title: "T", state, children },
      },
      { name: "escapes" },
    );
    return project.html("/");
  };

  test("breadcrumbNode: a backtick or a backslash in a text crumb beside an expression prints as written", async () => {
    const nav = breadcrumbNode([{ text: "Back`tick\\slash" }, { expr: "state.entry.data.title" }]);
    const html = await build({ entry: { data: { title: "Hello" } } }, [nav]);
    expect(html).toContain('<span class="last">Back`tick\\slash</span>');
    expect(html).toContain('<span class="last">Hello</span>');
    expect(html).not.toContain("${String(");
  });

  test("breadcrumbNode: with no expression nothing is a template, so nothing is escaped", () => {
    const nav = breadcrumbNode([{ text: "a`b\\c" }]);
    expect(String((nav.children as JxElement[])[0]!.innerHTML)).toContain(
      '<span class="last">a`b\\c</span>',
    );
  });

  test("repairTermBindings: a label with a backtick or a backslash is the literal part of the title", async () => {
    const nodes = [el("h1", { textContent: "${state.term.name}" })];
    expect(repairTermBindings(nodes, "Men`s \\ Ministry")).toBe(1);
    expect(nodes[0]!).toEqual(
      el("h1", { textContent: "Men\\`s \\\\ Ministry: ${state.term.data.name ?? ''}" }),
    );
    const html = await build({ term: { data: { name: "Nm" } } }, nodes);
    expect(html).toMatch(/<h1[^>]*>Men`s \\ Ministry: Nm<\/h1>/);
    expect(html).not.toContain("data-bind");
  });

  test("repairTermBindings: in markup the label is HTML as well, and a dollar-brace in it is not a binding", () => {
    const nodes = [el("h1", { innerHTML: "${state.term.name}" })];
    repairTermBindings(nodes, "A & <B> ${c}");
    expect(nodes[0]!.innerHTML).toBe("A &amp; &lt;B&gt; $​{c}: ${state.term.data.name ?? ''}");
  });
});

// ── The breadcrumb, from Rank Math's settings and rules ─────────────────────────────────────────

describe("crumbsFor and breadcrumbSettings follow class-breadcrumbs.php", () => {
  const fl = () => site("fineline");
  const ap = () => site("ap");
  const GENERAL = "rank-math-options-general";

  test("a term's taxonomy crumb is labels->name; the archive title keeps the singular name", () => {
    // fineline's project_tag: singular `Tag`, labels->name `Project tags` (on ap the two are the same word).
    expect(crumbsFor(fl(), { kind: "term", type: "project_tag", route: "/x" })).toEqual([
      { text: "Project tags" },
      { expr: "state.term.data.name ?? ''" },
    ]);
    expect(crumbsFor(fl(), { kind: "term", type: "location", route: "/x" })?.[0]).toEqual({
      text: "Project Locations",
    });
    expect(archiveLabel(fl(), "project_tag")).toBe("Tag");
    // `plural` stands in when a taxonomy has no `name` label.
    const noLabel = {
      model: ap().model,
      acf: {
        taxonomies: new Map([["x", { singular: "One", plural: "Many", labels: {} }]]),
        postTypes: new Map(),
      },
    } as unknown as Parameters<typeof crumbsFor>[0];
    expect(crumbsFor(noLabel, { kind: "term", type: "x", route: "/x" })?.[0]).toEqual({
      text: "Many",
    });
  });

  test("an entry of a type that has an archive starts with the archive's crumb, linked; a type with none, and `post`, do not", () => {
    const title = { expr: "state.entry.data.title ?? ''" };
    expect(crumbsFor(fl(), { kind: "entry", type: "project", route: "/x" })).toEqual([
      { text: "Projects", href: "/projects/" },
      title,
    ]);
    expect(crumbsFor(fl(), { kind: "entry", type: "service", route: "/x" })).toEqual([
      { text: "Services", href: "/services/" },
      title,
    ]);
    expect(crumbsFor(fl(), { kind: "entry", type: "post", route: "/x" })).toEqual([title]);
    expect(crumbsFor(ap(), { kind: "entry", type: "episode", route: "/x" })).toEqual([title]);
    // Without a route table the crumb has no address (a link needs one).
    const { routes: _routes, ...bare } = fl();
    expect(crumbsFor(bare as never, { kind: "entry", type: "project", route: "/x" })).toEqual([
      { text: "Projects" },
      title,
    ]);
  });

  test("the settings: ap's are the live ones, fineline has the breadcrumbs off, a site with no option prints the default trail", () => {
    expect(breadcrumbSettings(ap())).toMatchObject({
      enabled: true,
      separator: "&raquo;",
      home: true,
      homeLabel: "Home",
      showAncestors: true,
      showBlog: false,
      hideTaxName: false,
      removeTitle: false,
      archiveFormat: "Archives for",
    });
    expect(breadcrumbSettings(fl())).toMatchObject({
      enabled: false,
      separator: "-",
      archiveFormat: "Archives for %s",
      homeLink: "https://finelinepainting.pro",
    });
    const none = { model: { options: new Map() } } as unknown as Parameters<
      typeof breadcrumbSettings
    >[0];
    expect(breadcrumbSettings(none)).toEqual({
      enabled: true,
      separator: "&raquo;",
      home: true,
      homeLabel: "Home",
      homeLink: undefined,
      hideTaxName: false,
      removeTitle: false,
      showAncestors: false,
      showBlog: false,
      archiveFormat: "Archives for %s",
    });
  });

  test("hide taxonomy name leaves the term alone; the blog page is a linked crumb of a post, a category and a tag", () => {
    const hidden = withSetting(ap(), GENERAL, { breadcrumbs_hide_taxonomy_name: "on" });
    expect(crumbsFor(hidden, { kind: "term", type: "series", route: "/x" })).toEqual([
      { expr: "state.term.data.name ?? ''" },
    ]);
    const blog = withSetting(ap(), GENERAL, { breadcrumbs_blog_page: "on" });
    const posts = { text: "Essays for King Jesus", href: "/essays/" };
    expect(crumbsFor(blog, { kind: "term", type: "category", route: "/x" })).toEqual([
      posts,
      { expr: "state.term.data.name ?? ''" },
    ]);
    expect(crumbsFor(blog, { kind: "term", type: "post_tag", route: "/x" })?.[0]).toEqual(posts);
    expect(crumbsFor(blog, { kind: "entry", type: "post", route: "/x" })).toEqual([
      posts,
      { expr: "state.entry.data.title ?? ''" },
    ]);
    // It is off by default, and only for a site whose front page is a page.
    expect(crumbsFor(ap(), { kind: "term", type: "category", route: "/x" })).toHaveLength(1);
    const posting = withOption(blog, "show_on_front", "posts");
    const latest = {
      ...posting,
      model: { ...blog.model, site: { ...blog.model.site, showOnFront: "posts" as const } },
    } as LoadedSite;
    expect(crumbsFor(latest, { kind: "term", type: "category", route: "/x" })).toHaveLength(1);
  });

  test("remove post title drops the page's own crumb; every crumb with an address is then a link", () => {
    const removed = withSetting(ap(), GENERAL, { breadcrumbs_remove_post_title: "on" });
    expect(crumbsFor(removed, { kind: "entry", type: "episode", route: "/x" })).toEqual([]);
    expect(
      crumbsFor(withSetting(fl(), GENERAL, { breadcrumbs_remove_post_title: "on" }), {
        kind: "entry",
        type: "project",
        route: "/x",
      }),
    ).toEqual([{ text: "Projects", href: "/projects/" }]);
  });

  test("an author's crumb is the archive format with %s replaced by the name; a format with no %s says only what it says", () => {
    const evaluate = (s: LoadedSite, name: string): string => {
      const crumb = crumbsFor(s, { kind: "author", route: "/x" })![0] as { expr: string };
      return new Function("state", `return ${crumb.expr}`)({
        author: { data: { name } },
      }) as string;
    };
    expect(evaluate(ap(), "Allen Roth")).toBe("Archives for");
    expect(evaluate(fl(), "Chad")).toBe("Archives for Chad");
    for (const [format, printed] of [
      ["Posts by %s", "Posts by Chad"],
      // `%s` counts only before a space, a percent sign or the end (the plugin's own lookahead).
      ["%s' archive", "%s' archive"],
      ["%s archive", "Chad archive"],
      ["%s's posts", "%s's posts"],
      ["Archive: %s", "Archive: Chad"],
      ["100%s", "100Chad"],
      ["A } {", "A } {"],
    ]) {
      const s = withSetting(ap(), GENERAL, { breadcrumbs_archive_format: format });
      expect([format, evaluate(s, "Chad")]).toEqual([format, printed]);
    }
  });

  test("breadcrumbNode: the separator, the home crumb and which crumbs are links", () => {
    const html = (
      crumbs: Parameters<typeof breadcrumbNode>[0],
      options?: Parameters<typeof breadcrumbNode>[1],
    ) =>
      String(((breadcrumbNode(crumbs, options).children as JxElement[])[0] as JxElement).innerHTML);
    const crumbs = [{ text: "Projects", href: "/projects/" }, { text: "Barn" }];
    expect(html(crumbs)).toBe(
      '<a href="/">Home</a><span class="separator"> &raquo; </span><a href="/projects/">Projects</a>' +
        '<span class="separator"> &raquo; </span><span class="last">Barn</span>',
    );
    expect(html(crumbs, { separator: "-", home: { label: "Start & go", href: "/en/" } })).toBe(
      '<a href="/en/">Start &amp; go</a><span class="separator"> - </span><a href="/projects/">Projects</a>' +
        '<span class="separator"> - </span><span class="last">Barn</span>',
    );
    // No home crumb; the last crumb with an address is a link only when the title was removed.
    expect(html([{ text: "Projects", href: "/projects/" }], { home: false })).toBe(
      '<span class="last">Projects</span>',
    );
    expect(html([{ text: "Projects", href: "/projects/" }], { home: false, linkLast: true })).toBe(
      '<a href="/projects/">Projects</a>',
    );
    // An address with a quote cannot leave its attribute.
    expect(html([{ text: "x", href: '/a"b' }, { text: "y" }], { home: false })).toContain(
      '<a href="/a&quot;b">x</a>',
    );
    // A separator is the site's own markup, and cannot open a binding.
    expect(html([{ text: "x" }], { separator: "${a}" })).toContain("&#36;{a}");
  });

  test("the shortcode prints the site's separator and home label, and nothing when Rank Math's breadcrumbs are off", async () => {
    const navs = (o: TemplatesOutput, file: string): string[] =>
      [...elementsOf(docOf(o, file).children)]
        .filter((e) => e.tagName === "nav" && e.className === "rank-math-breadcrumb")
        .map((e) => String((e.children as JxElement[])[0]!.innerHTML));
    const edited = withSetting(ap(), GENERAL, {
      breadcrumbs_separator: "-",
      breadcrumbs_home_label: "Start",
      breadcrumbs_home_link: "https://anabaptistperspectives.org",
    });
    const o = await buildTemplates(edited, { only: ["page", "tag"] });
    const [page] = navs(o, "layouts/page.json");
    expect(page).toContain('<a href="/">Start</a><span class="separator"> - </span>');
    expect(navs(o, "pages/tag/[slug].json")[0]).toContain('<span class="separator"> - </span>');

    const off = withSetting(ap(), GENERAL, { breadcrumbs: "off" });
    const none = await buildTemplates(off, { only: ["page", "tag"] });
    for (const file of ["layouts/page.json", "pages/tag/[slug].json"]) {
      expect([file, navs(none, file)]).toEqual([file, []]);
      expect(fileOf(none, file)).not.toContain("rank-math-breadcrumb");
    }
    const said = none.report.entries().filter((e) => e.code === "template.breadcrumb-disabled");
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]!.severity).toBe("info");
    // No home crumb at all.
    const noHome = await buildTemplates(withSetting(ap(), GENERAL, { breadcrumbs_home: "off" }), {
      only: ["page"],
    });
    expect(navs(noHome, "layouts/page.json")[0]).not.toContain("Home");
  });

  test("remove post title: the page layout's trail has no title, and its home crumb is a link", async () => {
    const o = await buildTemplates(
      withSetting(ap(), GENERAL, { breadcrumbs_remove_post_title: "on" }),
      {
        only: ["page", "single-post"],
      },
    );
    const nav = [...elementsOf(docOf(o, "layouts/page.json").children)].find(
      (e) => e.className === "rank-math-breadcrumb",
    )!;
    expect(String((nav.children as JxElement[])[0]!.innerHTML)).toBe('<a href="/">Home</a>');
  });
});

describe("breadcrumbNotes: what Rank Math's trail has that one static trail for every route cannot", () => {
  const fl = () => site("fineline");
  const ap = () => site("ap");
  const pageOf = (kind: "entry" | "term", type: string, ids: number[]) => ({
    kind,
    type,
    routes: ids.map((id) => ({ id })) as never,
  });

  test("an entry with a parent has ancestors in the live trail; one whose type has a primary taxonomy has that term", () => {
    // (None of the fixtures' posts has a parent: one is given one.)
    const service = published(fl(), "service")[0]!;
    const child = withModel(fl(), (posts) => posts.set(service.id, { ...service, parent: 5 }));
    expect(breadcrumbNotes(child, pageOf("entry", "service", [service.id]))).toEqual([
      "the entry's ancestors",
    ]);
    const root = published(fl(), "project").find((p) => p.parent === 0)!;
    expect(breadcrumbNotes(fl(), pageOf("entry", "project", [root.id]))).toEqual([]);
    const tagged = published(fl(), "project").find(
      (p) => termsOf(fl().model, p.id, "project_tag").length > 0 && p.parent === 0,
    )!;
    const primary = withSetting(fl(), "rank-math-options-titles", {
      pt_project_primary_taxonomy: "project_tag",
    });
    expect(breadcrumbNotes(primary, pageOf("entry", "project", [tagged.id]))).toEqual([
      "the entry's primary project_tag term",
    ]);
    // "off", "0" and "" are Rank Math's way of saying none.
    for (const value of ["off", "0", ""]) {
      const none = withSetting(fl(), "rank-math-options-titles", {
        pt_project_primary_taxonomy: value,
      });
      expect(breadcrumbNotes(none, pageOf("entry", "project", [tagged.id]))).toEqual([]);
    }
  });

  test("a custom breadcrumb title (post or term meta) is a difference", () => {
    const post = published(fl(), "project")[0]!;
    const titled = withMeta(fl(), post.id, "rank_math_breadcrumb_title", "Short");
    expect(breadcrumbNotes(titled, pageOf("entry", "project", [post.id]))).toEqual([
      "a custom breadcrumb title",
    ]);
    const term = termBySlug(
      ap(),
      "series",
      [...ap().model.terms.values()].find((t) => t.taxonomy === "series")!.slug,
    );
    const terms = new Map(ap().model.terms).set(term.termId, {
      ...term,
      meta: { ...term.meta, rank_math_breadcrumb_title: "S" },
    });
    const edited = { ...ap(), model: { ...ap().model, terms } } as LoadedSite;
    expect(breadcrumbNotes(edited, pageOf("term", "series", [term.termId]))).toEqual([
      "a custom breadcrumb title",
    ]);
  });

  test("a child term has ancestors in a hierarchical taxonomy when the site shows them", () => {
    const category = [...ap().model.terms.values()].find((t) => t.taxonomy === "category")!;
    const terms = new Map(ap().model.terms).set(category.termId, { ...category, parent: 3 });
    const edited = { ...ap(), model: { ...ap().model, terms } } as LoadedSite;
    expect(breadcrumbNotes(edited, pageOf("term", "category", [category.termId]))).toEqual([
      "the term's ancestors",
    ]);
    // Not a hierarchical taxonomy (a tag), and not with the setting off.
    const tag = [...ap().model.terms.values()].find((t) => t.taxonomy === "post_tag")!;
    const tags = new Map(ap().model.terms).set(tag.termId, { ...tag, parent: 3 });
    expect(
      breadcrumbNotes(
        { ...ap(), model: { ...ap().model, terms: tags } } as LoadedSite,
        pageOf("term", "post_tag", [tag.termId]),
      ),
    ).toEqual([]);
    const off = withSetting(edited, "rank-math-options-general", {
      breadcrumbs_ancestor_categories: "off",
    });
    expect(breadcrumbNotes(off, pageOf("term", "category", [category.termId]))).toEqual([]);
  });

  test("the report says so once, where the shortcode prints", async () => {
    const entry = published(ap(), "supporters_update")[0]!;
    const posts = new Map(ap().model.posts).set(entry.id, { ...entry, parent: 5 });
    const edited = { ...ap(), model: { ...ap().model, posts } } as LoadedSite;
    const o = await buildTemplates(edited, { only: ["single-supporters_update"] });
    const said = o.report.entries().filter((e) => e.code === "template.breadcrumb-approximated");
    expect(said.map((e) => e.data?.difference)).toEqual(["the entry's ancestors"]);
    expect(said[0]!.severity).toBe("info");
    expect(said[0]!.message).toContain("the entry's ancestors");
  });
});

// ── What the data of a dynamic page needs, and what the module says about listings ──────────────

describe("the term and author data of a site with no template", () => {
  const stripped = (name: SiteName, types: string[]): LoadedSite =>
    withModel(site(name), (posts) => {
      for (const [id, post] of posts) if (types.includes(post.type)) posts.delete(id);
    });

  for (const name of SITES) {
    for (const types of [["wp_template"], ["wp_template", "wp_template_part"]]) {
      test(`${name}: with no ${types.join(" and no ")} every term and author still has its data file`, async () => {
        const s = stripped(name, types);
        const o = await buildTemplates(s);
        let expected = 0;
        for (const dp of s.routes.dynamicPages()) {
          if (dp.kind === "entries") continue;
          expected += dp.routes.length;
          const page = docOf(o, dp.file);
          const key = dp.kind === "terms" ? "term" : "author";
          const contentType = (page.state as Record<string, { contentType: string }>)[key]!
            .contentType;
          const written = o.files.filter((f) => f.path.startsWith(`content/${contentType}/`));
          expect([dp.file, written.length]).toEqual([dp.file, dp.routes.length]);
        }
        expect(expected).toBeGreaterThan(5);
        expect(o.files.filter((f) => f.path.startsWith("content/")).length).toBe(expected);
        // The page's heading reads data that is there.
        const sample = JSON.parse(
          o.files.find((f) => f.path.startsWith("content/") && f.path.endsWith(".json"))!.content,
        ) as Record<string, unknown>;
        expect(typeof sample.name).toBe("string");
      });
    }
  }
});

describe("listings say what Jx does not have", () => {
  test("every listing page reports its missing pagination, and the report names the addresses that are lost", () => {
    for (const name of SITES) {
      const listings = out(name).pages.filter((p) =>
        ["posts", "archive", "term", "author", "search"].includes(p.kind),
      );
      const said = out(name)
        .report.entries()
        .filter((e) => e.code === "template.pagination");
      expect(said.length).toBe(listings.length);
      expect(new Set(said.map((e) => e.data?.page))).toEqual(new Set(listings.map((p) => p.file)));
      for (const e of said) {
        expect(e.severity).toBe("info");
        expect(e.message).toContain("/page/N/");
        expect(e.message).toContain("redirect");
      }
    }
  });
});

describe("what the other modules write is what this one reads", () => {
  test("PAGE_ENTRY_KEYS are the keys emit/pages.ts writes under state.entry.data", async () => {
    for (const name of SITES) {
      const pages = await buildPages(site(name));
      const keys = new Set<string>();
      for (const file of pages.files) {
        if (!file.path.endsWith(".json")) continue;
        const doc = JSON.parse(file.content) as { state?: { entry?: { data?: object } } };
        for (const key of Object.keys(doc.state?.entry?.data ?? {})) keys.add(key);
      }
      expect([...keys].sort()).toEqual([...PAGE_ENTRY_KEYS].sort());
    }
  });

  test("the base layout is the one file BASE_LAYOUT names, and every layout nests in it", () => {
    expect(BASE_LAYOUT).toBe(`./${BASE_LAYOUT_FILE}`);
    for (const name of SITES) {
      const base = docOf(out(name), BASE_LAYOUT_FILE);
      expect(base.$layout).toBeUndefined();
      for (const path of Object.values(out(name).layouts)) {
        expect(docOf(out(name), path.replace(/^\.\//, "")).$layout).toBe(BASE_LAYOUT);
      }
    }
  });
});

describe("conditions that were only pinned by luck", () => {
  const fl = () => site("fineline");

  test("singular: a term of the taxonomy is named by slug, by its name or by its id", () => {
    const tagged = published(fl(), "project").find(
      (p) => termsOf(fl().model, p.id, "project_tag").length > 0,
    )!;
    const term = termsOf(fl().model, tagged.id, "project_tag")[0]!;
    const request: TemplateRequest = { kind: "single", post: tagged };
    const named = (extra: string) =>
      withRules(fl(), {
        "test-header": rule({ singular: [{ target: "project", data: "project_tag", extra }] }),
      });
    for (const spec of [term.slug, decodeEntities(term.name), String(term.termId)]) {
      expect([spec, choose(named(spec), request)]).toEqual([spec, "test-header"]);
    }
    expect(choose(named(String(term.termId + 100_000)), request)).toBe("single-project");
  });

  test("custom: an ACF value that is a list is read as its items joined by a space", () => {
    const post = published(fl(), "project")[0]!;
    const listed = withMeta(fl(), post.id, "fp_title_1", ["alpha", "beta"]);
    const acf = (extraData: string) =>
      withRules(listed, {
        "test-header": rule({
          custom: [
            {
              target: "acf",
              acfLocation: "currentpost",
              field: "fp_title_1",
              extra: "contains",
              extraData,
            },
          ],
        }),
      });
    const request: TemplateRequest = { kind: "single", post };
    expect(choose(acf("alpha beta"), request)).toBe("test-header");
    expect(choose(acf("alpha,beta"), request)).toBe("single-project");
  });

  test("a route listed twice is one data file and an error for the second", async () => {
    const s = fl();
    const dp = s.routes.dynamicPages().find((d) => d.source === "location")!;
    const edited = {
      ...s,
      routes: {
        ...s.routes,
        dynamicPages: () => [
          { ...dp, routes: [dp.routes[0]!, dp.routes[0]!, ...dp.routes.slice(1)] },
        ],
      },
    } as unknown as LoadedSite;
    const o = await buildTemplates(edited, { only: ["taxonomy-location"] });
    const errors = o.report.entries().filter((e) => e.code === "template.route-mismatch");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("error");
    expect(errors[0]!.data?.route).toBe(dp.routes[0]!.jxRoute);
    expect(o.files.filter((f) => f.path.startsWith("content/location/"))).toHaveLength(
      dp.routes.length,
    );
  });
});
