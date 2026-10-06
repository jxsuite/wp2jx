/**
 * WordPress block templates and template parts as Jx layouts, pages and components.
 *
 * ## Which template renders what
 *
 * {@link selectTemplate} answers it for one request (a page, an entry, a post-type archive, a term, an
 * author, the posts index, a search, a 404). WordPress's own order is the base: `template-loader.php`
 * tries the lists of `get_front_page_template`, `get_home_template`, `get_privacy_policy_template`,
 * `get_post_type_archive_template`, `get_taxonomy_template`, `get_single_template`,
 * `get_page_template`, `get_singular_template`, `get_category_template`, `get_tag_template`,
 * `get_author_template`, `get_archive_template` and ends in `index`, and the block theme takes the
 * first slug of the list that is a published `wp_template` of the ACTIVE theme
 * (`resolve_block_template`: the templates of an inactive theme stay in the database and are not read).
 * Cwicly puts its own rule set in front of it (`cwicly_conditions`,
 * `core/includes/helpers/theme-maker.php`, ported branch for branch in {@link cwiclyRule}): every
 * template whose include rule matches the request and whose exclude rule does not is a candidate, the
 * highest `priority` wins (the first of equals), and it applies unless the page names a page template
 * of its own (`_wp_page_template`) and the rule does not say `overridePageTemplate`. Neither fixture
 * site stores a rule that assigns anything, so the hierarchy alone answers for them; it is held against
 * the body classes and the `cc-tp-<theme>_<slug>.css` links of 12 committed live pages and 36 more
 * observed on the live sites (`tests/emit/templates.test.ts`), and the rules against the PHP's own
 * branches. What no static site can know at build time (the date, a cookie, a URL parameter, a
 * shortcode's answer, who is logged in) is decided for the one visitor a static site has, or counted
 * false, and said (`template.condition-approximated`, `template.condition-unsupported`).
 *
 * ## What a template becomes
 *
 * A template is converted once for every way it is used (`convertSubject` in the entry mode, so the
 * page's or the entry's data is bound; a listing in the static mode), then cut by who needs which half:
 *
 * - **A layout for pages** (`front-page`, `page`, `page-<slug>`, `wp-custom-template-*`, any template a
 *   page names, `layouts/<slug>.json`): the whole template with the page's body where the content block
 *   stood, which is the layout's `<slot>`. The page file holds the body and nothing else
 *   (`emit/pages.ts`), so the template's chrome (a header part, the title, the breadcrumb, a wrapper)
 *   lives here and reads the page's own post through the `state.entry` that file writes.
 * - **A layout for everything else** (an entry, an archive, a term, an author, the posts index, a
 *   search, a 404): only the template's CHROME, `[header … slot … footer]`, cut by {@link splitChrome}
 *   (the header is the last top-level block that holds a header-area part, the footer the first with a
 *   footer-area part: anabaptistperspectives' `single-post` has its header part inside the block that
 *   also holds the hero, so the whole block is chrome). The body is the page the route table names
 *   (`pages/<base>/[slug].json`, `pages/projects.json`, `pages/404.json`…), written here, so a template
 *   with two hundred routes is one file. A template that serves both is two layouts, the second named
 *   `<slug>-frame.json` ({@link layoutPathOf}).
 * - **Components** for every template part (`components/<tag>.json`, `partTag`) and every published
 *   reusable block (`reusableTag`; the core converter expands a `core/block` in place, so nothing
 *   instantiates these yet and they are a library). A part is the same markup on every page: a component
 *   with `display: contents` as its host and `$elements` for the parts and components it holds. An
 *   instance carries no wrapper element, because Cwicly's `templatePartWrapper` optimisation (on for
 *   both fixture sites) prints none; with it off the wrapper of WordPress is written.
 * - **`layouts/base.json`**: the document frame every layout nests in (`$layout`): the custom code that
 *   goes after `<body>` and before `</body>` (`cwicly_custom_code`), the global header and footer
 *   fragments (`Themer::add_global_fragments`: the parts of `globalheader` and `globalfooter` that show
 *   on every page), and WordPress's own `div.wp-site-blocks`, which the live pages wrap everything in.
 *
 * ## The pages, and the data they read
 *
 * - **An entry page** is the dynamic page the route table names (`pages/<base>/[slug].json`, `$paths`
 *   verbatim), the template's body in the entry mode. The entry is the collection's own `ContentEntry`
 *   with `timing: "compiler"` (a page of it ships no JavaScript); `title` and `$head` are bindings on its
 *   `seo` (Rank Math's answer, written by the collections module). A `$head` entry cannot be left out by
 *   a value (`false` prints the word, measured): an entry with no description has an empty one, and a
 *   tag no route of the page can fill (a term and an author have no image) is not written ({@link boundHead}).
 * - **A term page** reads `state.term`, a `ContentEntry` of a JSON collection of the taxonomy
 *   (`content/<taxonomy>/<slug>.json`: the term's own data (`termData`, ACF term fields included) and
 *   its `seo`), because a single `[slug].json` page has no other way to look a term up and a file per
 *   term would copy the template hundreds of times. Collections are returned in
 *   {@link TemplatesOutput.collections} for the project's `content` section. **An author page** is the
 *   same with a collection `author` and `state.author` as the entry: the tokens that read the author
 *   (`{authorname}`) read `state.author.data.author`. The author's `seo` is Rank Math's author archive
 *   (its title and description options, and the robots its `Paper\Author` prints: {@link authorRobots}),
 *   with `og:type` `profile`; a term's is `article`.
 * - **The posts index and the archives** are the static pages of their routes (`pages/blog.json`,
 *   `pages/projects.json`) with Rank Math's own title and head. **The 404** is `pages/404.json`: the Jx
 *   dev server serves it with the status 404, but the static build writes it to `/404/` and not `404.html`
 *   (`template.404-location`). **The search** is `pages/search.json` with its form and a notice where the
 *   results were: they are a query WordPress runs per request, the search term is a URL parameter a
 *   static page cannot read, and `@jxsuite/search` (a client-side index of titles and text) could not
 *   print the template's cards, which need an entry's image, date and fields (`template.search`). What
 *   else read the dropped results (a "No results found" paragraph, the "Load more" link) goes with them.
 * - **A route kind with no template** gets a minimal page and layout (`template.fallback`).
 * - Pagination does not exist in Jx: a listing shows every entry its query selects
 *   (`template.pagination`).
 *
 * ## What the converters leave to this module
 *
 * - `wp2jx-template-part` becomes the part's component; `wp2jx-menu` and `wp2jx-navigation` go to the
 *   menus emitter; `wp2jx-post-content` is the slot.
 * - **Shortcodes**: `[rank_math_breadcrumb]` is printed ({@link breadcrumbNode}: the live pages of both sites
 *   have a `nav.rank-math-breadcrumb`, `Home » …`, which a layout builds from the page's own title or the
 *   term's name, with the separator, home crumb and trail rules of Rank Math's breadcrumb settings
 *   ({@link breadcrumbSettings}, {@link crumbsFor}); what depends on the entry or the term (a post's
 *   ancestors and primary term, a term's ancestors) is said, not written: `template.breadcrumb-approximated`,
 *   and a site whose breadcrumbs are off prints none, as its live pages do: `template.breadcrumb-disabled`);
 *   the PDF plugin's markers (`[dkpdf-remove]`, `[/dkpdf-remove]`) printed nothing and are
 *   removed (`template.shortcode-empty`; the converter leaves a closing tag as a paragraph of text,
 *   which {@link withoutShortcodeText} takes out); every other one is a visible neutral element with
 *   what it said (`template.placeholder-neutral`), as `emit/pages.ts` does. `resolvers` override any.
 * - Three repairs of what the core converter writes, each reported: the archive title's
 *   `${state.term.name}` (the entry contract has the name under `data`), the `Category: ` prefix of a
 *   title under the generic `archive` template (the converter cannot know the kind; this module does:
 *   {@link archiveLabel}), and the results of a search template.
 *
 * Report codes: `template.fallback`, `template.skipped`, `template.rule-missing`,
 * `template.rule-no-exclude`, `template.status-code`, `template.condition-approximated`,
 * `template.condition-unsupported`, `template.page-template-missing`, `template.part-missing`,
 * `template.part-empty`, `template.reusable-skipped`, `template.fragment-conditional`,
 * `template.chrome-unsplit`, `template.no-content-slot`, `template.content-slot-extra`,
 * `template.entry-data-missing`, `template.entry-split`, `template.term-split`, `template.author-split`,
 * `template.posts-split`, `template.archive-split`, `template.route-mismatch`, `template.seo-failed`,
 * `template.og-image-unresolved`, `template.literal-template`, `template.shortcode-empty`,
 * `template.placeholder-neutral`, `template.dynamic-unavailable`, `template.term-binding-repaired`,
 * `template.search`, `template.404-location`, `template.pagination`, `template.breadcrumb-disabled`,
 * `template.breadcrumb-approximated`, `template.hoisted-unplaced`,
 * `template.hoisted-collision`, `template.state-taken`, `template.binding-misplaced`, `template.convert-failed`, plus everything
 * the conversions and the menus report, located at their subject.
 */
import { collectWpClasses } from "../core/block-css.ts";
import { jsString, termData, texturize } from "../cwicly/tokens.ts";
import { convertSubject, dedupeRules, type Converted } from "../convert.ts";
import { htmlToNodes } from "../html.ts";
import { escapeTemplate, htmlEscapeExpr } from "../jx-util.ts";
import { fluentFormFor } from "./fluentform.ts";
import { rewriteStyleUrls } from "./style-urls.ts";
import { menuResolvers, newUsed as newMenusUsed, type MenusUsed } from "./menus.ts";
import {
  ENTRY_STATE_KEY,
  componentFile,
  headEntries,
  hoistedStyle,
  layoutPath,
  literalText,
  misplacedBindings,
  relativeRef,
} from "./pages.ts";
import {
  PLACEHOLDER_PREFIX,
  replacePlaceholders,
  walkElements,
  type Placeholder,
  type Resolver,
  type ResolverMap,
} from "../placeholders.ts";
import { createReport } from "../report.ts";
import type { DynamicPage, Route } from "../routes.ts";
import {
  partTag,
  reusableTag,
  siteTags,
  subjectCtx,
  subjectWhere,
  type HoistedRule,
  type SiteContext,
  type Subject,
  type SubjectOptions,
} from "../site.ts";
import type {
  JxDocument,
  JxElement,
  JxNode,
  Report,
  ReportEntry,
  WpPost,
  WpTerm,
  WpUser,
} from "../types.ts";
import { renderRankMathTemplate, seoFor, toEntrySeo, type Seo } from "../wp/seo.ts";
import { maybeUnserialize } from "../wp/phpser.ts";
import { decodeEntities, termsOf } from "../wp/model.ts";

// ── Contract ─────────────────────────────────────────────────────────────────────────────────────

/** What a template is chosen for. */
export type TemplateRequest =
  /** A page, the front page included (`isFront` says so: the template `front-page` is tried first). */
  | { kind: "page"; post: WpPost }
  /** The posts index: the posts page, or the front page of a site that shows its latest posts. */
  | { kind: "posts"; front?: boolean }
  /** One entry of any post type but `page`. */
  | { kind: "single"; post: WpPost }
  /** The archive of a post type (`post` is the blog index only through {@link TemplateRequest} `posts`). */
  | { kind: "post-archive"; postType: string }
  | { kind: "term"; term: WpTerm }
  | { kind: "author"; user: Pick<WpUser, "id" | "slug"> }
  | { kind: "search" }
  | { kind: "404" };

/** Why a template was chosen. */
export interface TemplateChoice {
  /** The template's slug: `single-project`. */
  slug: string;
  /** `hierarchy`: WordPress's own lists; `rule`: a Cwicly `cwicly_conditions` rule outranked them. */
  via: "hierarchy" | "rule";
  /** The slugs WordPress tried, most specific first, and the Cwicly rule's template ahead of them when one applied. */
  tried: string[];
  /** The slug in `tried` that is a published template the active theme has; `undefined` when none is (a site with no `index`). */
  post: WpPost | undefined;
}

export type PageKind =
  | "entry"
  | "posts"
  | "archive"
  | "term"
  | "author"
  | "search"
  | "404"
  /** A page the site's own pages emitter writes; listed only so a caller can see which template it uses. */
  | "page";

export interface TemplatePageInfo {
  /** Project-relative file: `pages/project/[slug].json`. */
  file: string;
  /** The Jx route: `/project/:slug` for a dynamic page, `/projects/` for a static one. */
  route: string;
  /** The template the page renders. */
  template: string;
  kind: PageKind;
  /** The layout it carries, `./layouts/<slug>.json`. */
  layout: string;
}

export interface TemplatesOptions {
  report?: Report;
  /** The address the migrated site is served at (`og:image` is made absolute against it). Default: the source site's `home`. */
  siteUrl?: string;
  /** The clock Rank Math's `%currentyear%` and kin read. Default: now. */
  now?: Date;
  /** Resolvers for the placeholders a template holds, over the defaults (a part, a menu, a shortcode...). A tag outranks a kind and a kind outranks `*`. */
  resolvers?: ResolverMap;
  /** Only these template slugs (a partial run); the parts and components they reach are still written. */
  only?: readonly string[];
  /** The conversion of one subject; a seam for tests. Default: `convertSubject`. */
  convert?: (site: SiteContext, subject: Subject, opts?: SubjectOptions) => Promise<Converted>;
  /** `cwicly_custom_code` as the design system returns it. Default: the site's own options. */
  customCode?: { head?: string; bodyOpen: string; footer: string };
}

export interface TemplateFile {
  path: string;
  content: string;
}

export interface TemplatesUsed {
  /** Tags of the components, template parts and reusable blocks the files instantiate: `components/<tag>.json` must exist for each. */
  components: Set<string>;
  /** Every class name the files carry (for the compatibility stylesheet's pruning). */
  wpClasses: Set<string>;
  /** Rules that could not stay on an element, for the project's `style`. */
  hoisted: HoistedRule[];
  /** Rules about the document itself (`body`, `:root`): the project's `style` takes unscoped selectors, no page's does. */
  documentRules: HoistedRule[];
  /** Page-level state keys the pages point at. */
  states: Set<string>;
  /** The slugs of the templates the layouts and pages were written for. */
  templates: Set<string>;
  /** What the menus the parts, layouts and pages hold used. */
  menus: MenusUsed;
}

export interface TemplatesOutput {
  /** Everything written: layouts, pages, components, term data. */
  files: TemplateFile[];
  /** Template slug → its layout (`./layouts/<slug>.json`, project-root relative, as `$layout` holds it). */
  layouts: Record<string, string>;
  /** Template slug → the chrome-only layout of a template that is ALSO a page layout (`layouts` holds that one). */
  frames: Record<string, string>;
  /** `./layouts/base.json`, the layout every other layout nests in; null when none was needed. */
  base: string | null;
  /** The pages written here. */
  pages: TemplatePageInfo[];
  /** One component per template part. */
  parts: { slug: string; tag: string; file: string }[];
  /** One component per published reusable block. */
  reusables: { id: number; tag: string; file: string }[];
  /**
   * The `content` collections of `project.json` this module needs beside the Markdown ones: one JSON
   * collection per taxonomy whose terms have pages.
   */
  collections: Record<string, TermCollectionDef>;
  /** The page WordPress's 404 template became, `pages/404.json`, or null when the site routes that address itself. */
  notFound: string | null;
  used: TemplatesUsed;
  /** Everything the conversions could not carry over, located and with the public URL. */
  report: Report;
}

/** One value of `project.json`'s `content` section for the term data. */
export interface TermCollectionDef {
  source: string;
  format: "json";
  schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

// ── Inventory ────────────────────────────────────────────────────────────────────────────────────

const firstMeta = (site: Pick<SiteContext, "model">, id: number, key: string): unknown =>
  site.model.postMeta.get(id)?.[key]?.[0];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

/**
 * Whether a template or part belongs to another theme than the active one: WordPress keeps the posts
 * of an inactive theme tagged with that theme's `wp_theme` term and reads only the active theme's. A
 * post with no theme term is hand-made and counts.
 */
function ofAnotherTheme(site: Pick<SiteContext, "model">, post: WpPost): boolean {
  const { model } = site;
  let other = false;
  for (const termId of model.termsByPost.get(post.id) ?? []) {
    const term = model.terms.get(termId);
    if (term?.taxonomy !== "wp_theme") continue;
    if (term.slug === model.site.theme) return false;
    other = true;
  }
  return other;
}

/** The area (`header`, `footer`, `uncategorized`) a template part is filed under. */
function areaOf(site: Pick<SiteContext, "model">, post: WpPost): string {
  for (const termId of site.model.termsByPost.get(post.id) ?? []) {
    const term = site.model.terms.get(termId);
    if (term?.taxonomy === "wp_template_part_area") return term.slug;
  }
  return "uncategorized";
}

/** Whether `a` should replace `b` as the post a slug names: the published one, then the lower id. */
const better = (a: WpPost, b: WpPost): boolean =>
  a.status === b.status ? a.id < b.id : a.status === "publish";

interface Inventory {
  /** Published `wp_template`s of the active theme, by slug. */
  templates: Map<string, WpPost>;
  /** Published `wp_template_part`s of the active theme, by slug. */
  parts: Map<string, WpPost>;
  /** Everything that was left out, for the report. */
  skipped: { post: WpPost; why: string }[];
}

const inventories = new WeakMap<object, Inventory>();

function inventoryOf(site: Pick<SiteContext, "model">): Inventory {
  let found = inventories.get(site.model);
  if (found) return found;
  const templates = new Map<string, WpPost>();
  const parts = new Map<string, WpPost>();
  const skipped: Inventory["skipped"] = [];
  for (const post of site.model.posts.values()) {
    if (post.type !== "wp_template" && post.type !== "wp_template_part") continue;
    if (post.status !== "publish") {
      skipped.push({ post, why: `status ${post.status}` });
      continue;
    }
    if (ofAnotherTheme(site, post)) {
      skipped.push({ post, why: "another theme's" });
      continue;
    }
    const into = post.type === "wp_template" ? templates : parts;
    const taken = into.get(post.slug);
    if (taken === undefined || better(post, taken)) into.set(post.slug, post);
  }
  found = { templates, parts, skipped };
  inventories.set(site.model, found);
  return found;
}

/** The published template a slug names in the active theme. */
export const templateOf = (site: Pick<SiteContext, "model">, slug: string): WpPost | undefined =>
  inventoryOf(site).templates.get(slug);

// ── The WordPress hierarchy ──────────────────────────────────────────────────────────────────────

const isPageTemplateSet = (site: Pick<SiteContext, "model">, post: WpPost): boolean => {
  const own = firstMeta(site, post.id, "_wp_page_template");
  return typeof own === "string" && own !== "" && own !== "default";
};

/** The page `wp_page_for_privacy_policy` names. */
const privacyPage = (site: Pick<SiteContext, "model">): number =>
  Number(site.model.options.get("wp_page_for_privacy_policy") ?? 0) || 0;

const isFrontPage = (site: Pick<SiteContext, "model">, post: WpPost): boolean =>
  site.model.site.showOnFront === "page" && site.model.site.pageOnFront === post.id;

/** `urldecode($slug)` as the `get_*_template` lists apply it: an address that is not valid percent-encoding is left as it is. */
const decodedSlug = (slug: string): string => {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
};

/**
 * The slugs WordPress tries for a request, most specific first, to the end of `template-loader.php`'s
 * chain (`index`): each `get_*_template` list in the order the loader asks them, every list as
 * `wp-includes/template.php` spells it (the decoded form of a slug ahead of the stored one, the term id
 * after it, a post's own page template ahead of its name).
 */
export function templateCandidates(
  site: Pick<SiteContext, "model">,
  request: TemplateRequest,
): string[] {
  const out: string[] = [];
  const push = (...slugs: (string | false | undefined)[]): void => {
    for (const slug of slugs) if (slug && !out.includes(slug)) out.push(slug);
  };
  /** `<prefix>-<decoded slug>`, `<prefix>-<slug>`, `<prefix>-<id>`: the three of a term's list, the id only where WordPress has one. */
  const named = (prefix: string, slug: string, id?: number): void => {
    if (slug === "") return;
    const decoded = decodedSlug(slug);
    if (decoded !== slug) push(`${prefix}-${decoded}`);
    push(`${prefix}-${slug}`);
    if (id !== undefined) push(`${prefix}-${id}`);
  };
  /** The page template a post names (`get_page_template_slug`): a name WordPress's `validate_file` accepts. */
  const ownTemplate = (post: WpPost): string | undefined => {
    const own = firstMeta(site, post.id, "_wp_page_template");
    return typeof own === "string" && own !== "" && own !== "default" ? own : undefined;
  };
  switch (request.kind) {
    case "404":
      push("404");
      break;
    case "search":
      push("search");
      break;
    case "posts":
      if (request.front === true) push("front-page");
      push("home");
      break;
    case "page": {
      const { post } = request;
      if (isFrontPage(site, post)) push("front-page");
      if (privacyPage(site) === post.id) push("privacy-policy");
      push(ownTemplate(post));
      named("page", post.slug);
      push(`page-${post.id}`, "page", "singular");
      break;
    }
    case "post-archive":
      push(`archive-${request.postType}`, "archive");
      break;
    case "term": {
      const { term } = request;
      if (term.taxonomy === "category") {
        named("category", term.slug, term.termId);
        push("category");
      } else if (term.taxonomy === "post_tag") {
        named("tag", term.slug, term.termId);
        push("tag");
      } else {
        named(`taxonomy-${term.taxonomy}`, term.slug, term.termId);
        push(term.slug === "" ? false : `taxonomy-${term.taxonomy}`, "taxonomy");
      }
      push("archive");
      break;
    }
    case "author":
      push(`author-${request.user.slug}`, `author-${request.user.id}`, "author", "archive");
      break;
    case "single": {
      const { post } = request;
      push(ownTemplate(post));
      named(`single-${post.type}`, post.slug);
      push(`single-${post.type}`, "single", "singular");
      break;
    }
  }
  push("index");
  return out;
}

// ── Cwicly's template rules ──────────────────────────────────────────────────────────────────────

/** What a request is, in the terms the plugin's conditions ask (`is_404()`, `is_singular('project')`…). */
interface Facts {
  is404: boolean;
  isFront: boolean;
  isSingular: boolean;
  singularType?: string;
  post?: WpPost;
  isArchive: boolean;
  isSearch: boolean;
  isAuthor: boolean;
  authorId?: number;
  authorSlug?: string;
  postTypeArchive?: string;
  taxonomy?: string;
  term?: WpTerm;
  /** The page names a page template of its own (`is_page_template()`). */
  pageTemplateSet: boolean;
}

function factsOf(site: Pick<SiteContext, "model">, request: TemplateRequest): Facts {
  const none: Facts = {
    is404: false,
    isFront: false,
    isSingular: false,
    isArchive: false,
    isSearch: false,
    isAuthor: false,
    pageTemplateSet: false,
  };
  switch (request.kind) {
    case "404":
      return { ...none, is404: true };
    case "search":
      return { ...none, isSearch: true };
    case "posts":
      return { ...none, isFront: request.front === true };
    case "page":
      return {
        ...none,
        isSingular: true,
        singularType: "page",
        post: request.post,
        isFront: isFrontPage(site, request.post),
        pageTemplateSet: isPageTemplateSet(site, request.post),
      };
    case "single":
      return { ...none, isSingular: true, singularType: request.post.type, post: request.post };
    case "post-archive":
      return { ...none, isArchive: true, postTypeArchive: request.postType };
    case "term":
      return { ...none, isArchive: true, taxonomy: request.term.taxonomy, term: request.term };
    case "author":
      return {
        ...none,
        isArchive: true,
        isAuthor: true,
        authorId: request.user.id,
        authorSlug: request.user.slug,
      };
  }
}

const has = (value: unknown): boolean => value !== undefined && value !== null;
/** PHP truthiness of a value read from JSON. */
const truthy = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  value !== 0 &&
  value !== "" &&
  value !== "0" &&
  !(Array.isArray(value) && value.length === 0);
/** What PHP's `isset($v) && $v` says of a flag Cwicly stores as `true`, `"true"` or `1`. */
const isOn = (value: unknown): boolean => value === true || value === "true" || value === 1;
/** A flag Cwicly tests as `'true' === $value->all`: the string and nothing else (a boolean or a number is off). */
const isTrueString = (value: unknown): boolean => value === "true";

const NUMERIC = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/** PHP's comparison of two strings: numbers when both are numeric, else by characters. */
function phpCompare(a: string, b: string): number {
  if (NUMERIC.test(a) && NUMERIC.test(b)) return Math.sign(Number(a) - Number(b));
  return a === b ? 0 : a < b ? -1 : 1;
}

/** `object_type[0]` of a taxonomy: where an archive of it says its posts belong. */
function objectTypeOf(site: Pick<SiteContext, "model" | "acf">, taxonomy: string): string {
  if (taxonomy === "category" || taxonomy === "post_tag") return "post";
  return site.acf.taxonomies.get(taxonomy)?.objectTypes[0] ?? "";
}

/** `has_term($spec, $taxonomy)` for a post: any term of the taxonomy when `spec` is empty, else by slug, name or id. */
function hasTerm(
  site: Pick<SiteContext, "model">,
  post: WpPost | undefined,
  spec: unknown,
  taxonomy: string,
): boolean {
  if (!post) return false;
  const terms = termsOf(site.model, post.id, taxonomy);
  const want = text(spec) ?? "";
  if (want === "") return terms.length > 0;
  return terms.some(
    (term) =>
      term.slug === want || decodeEntities(term.name) === want || String(term.termId) === want,
  );
}

type Verdict = boolean | "unknown";

/** `singular` conditions: what the request is, and whether the post is of the type, term or id named. */
function singularCondition(
  site: Pick<SiteContext, "model" | "acf">,
  raw: unknown,
  f: Facts,
): Verdict {
  const c = isRecord(raw) ? raw : {};
  const target = text(c.target);
  if (!target) return false;
  if (target === "all") return f.is404 || f.isFront || f.isSingular;
  if (target === "404") return f.is404;
  if (target === "frontPage") return f.isFront;
  if (!f.isSingular || f.singularType !== target) return false;
  const { data, extra, extraData } = c;
  let verdict = !has(data) || (truthy(data) && data === "all");
  if (has(data) && truthy(data) && data !== "all") {
    if (data === "directchildof") {
      verdict = has(extra) && Number(extra) === (f.post?.parent ?? 0);
    } else if (!has(extra) || (truthy(extra) && extra === "all")) {
      if (Array.isArray(data)) verdict = data.some((id) => Number(id) === f.post?.id);
      else verdict = hasTerm(site, f.post, "", text(data) ?? "");
    } else if (has(extra) && truthy(extra) && extra !== "all") {
      verdict = hasTerm(site, f.post, extra, text(data) ?? "");
      if (has(extraData) && truthy(extraData) && extraData !== "all") {
        verdict = Number(extraData) === f.post?.id;
      }
    }
  }
  return verdict;
}

/** `archive` conditions: a search, an author, or a post type's archive, a taxonomy's, a term's. */
function archiveCondition(
  site: Pick<SiteContext, "model" | "acf">,
  raw: unknown,
  f: Facts,
): Verdict {
  const c = isRecord(raw) ? raw : {};
  const target = text(c.target);
  const { data, extra } = c;
  if (target === "search" && f.isSearch) return true;
  if (target === "author" && f.isAuthor) {
    if (has(data) && truthy(data) && data !== "all") return String(f.authorId) === String(data);
    return true;
  }
  if (!f.isArchive || !target) return false;
  const postType = f.taxonomy
    ? objectTypeOf(site, f.taxonomy)
    : f.postTypeArchive === target
      ? target
      : "";
  if (target === "all") return true;
  if ((!has(data) || (truthy(data) && data === "all")) && target === postType) return true;
  if (postType === target && has(data) && f.taxonomy === data) {
    if (!has(extra) || (truthy(extra) && extra === "all")) return true;
    if (has(extra)) return Number(extra) === f.term?.termId;
  }
  return false;
}

/** `author` conditions: `true` for any author archive, or `{target}` an author id or name. */
function authorCondition(raw: unknown, f: Facts): Verdict {
  if (!f.isAuthor) return false;
  if (raw === true) return true;
  const target = isRecord(raw) ? text(raw.target) : undefined;
  if (!target) return false;
  return target === String(f.authorId) || target === f.authorSlug;
}

/** What the conditions that look at the visitor, the clock or the request say for the one visitor a static site has. */
const GUEST_APPROXIMATED = new Set([
  "username",
  "userid",
  "userrole",
  "usercapabilities",
  "loggedin",
]);
const REQUEST_ONLY = new Set(["date", "dayweek", "daymonth", "time", "shortcode"]);

/** The value an ACF condition reads: the field of the current post, as `strval` would have it. */
function acfValue(
  site: Pick<SiteContext, "model" | "acf">,
  c: Record<string, unknown>,
  f: Facts,
): string | undefined {
  const location = text(c.acfLocation) ?? "currentpost";
  if (location !== "currentpost" && location !== "postid") return undefined;
  const id = location === "postid" ? Number(c.acfLocationID) : f.post?.id;
  if (id === undefined || !Number.isFinite(id)) return undefined;
  const field = text(c.field);
  if (field === undefined) return undefined;
  let name = field;
  for (const group of site.acf.groups) {
    const found = findFieldName(group.fields as unknown as AcfFieldLike[], field);
    if (found !== undefined) {
      name = found;
      break;
    }
  }
  const value = site.model.postMeta.get(id)?.[name]?.[0];
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(String).join(" ");
  if (typeof value === "boolean") return value ? "1" : "";
  return String(value);
}

interface AcfFieldLike {
  key: string;
  name: string;
  subFields?: AcfFieldLike[];
}

function findFieldName(fields: readonly AcfFieldLike[], key: string): string | undefined {
  for (const field of fields) {
    if (field.key === key || field.name === key) return field.name;
    const inner = field.subFields ? findFieldName(field.subFields, key) : undefined;
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/** `custom` conditions: the visitor, the clock, the request, an ACF value. */
function customCondition(
  site: Pick<SiteContext, "model" | "acf">,
  raw: unknown,
  f: Facts,
  note: (kind: "approximated" | "unsupported", what: string) => void,
): Verdict {
  const c = isRecord(raw) ? raw : {};
  const target = text(c.target) ?? "";
  const op = text(c.extra) ?? "";
  const expected = text(c.extraData) ?? "";
  if (REQUEST_ONLY.has(target)) {
    note("unsupported", `${target} ${op} ${expected}`.trim());
    return "unknown";
  }
  if (GUEST_APPROXIMATED.has(target)) note("approximated", `${target} ${op} ${expected}`.trim());

  // The one visitor of a static site: not logged in, no cookie, no query string.
  let value: string;
  switch (target) {
    case "username":
    case "urlparameter":
      value = "";
      break;
    case "userid":
      value = "0";
      break;
    case "acf": {
      const found = acfValue(site, c, f);
      if (found === undefined) {
        note("unsupported", `acf ${text(c.field) ?? ""} at ${text(c.acfLocation) ?? ""}`.trim());
        return "unknown";
      }
      value = found;
      break;
    }
    default:
      value = "";
  }
  const guestRole = target === "userrole" || target === "usercapabilities";
  const cookie = target === "cookie";
  switch (op) {
    case "===":
      if (cookie || guestRole) return false;
      return value === expected;
    case "!=":
      if (cookie || guestRole) return true;
      return phpCompare(value, expected) !== 0;
    case "contains":
      if (cookie || guestRole) return false;
      return value.includes(expected);
    case "notcontain":
      if (cookie || guestRole) return true;
      return !value.includes(expected);
    case "before":
    case "<":
      return phpCompare(value, expected) < 0;
    case "after":
    case ">":
      return phpCompare(value, expected) > 0;
    case ">=":
      return phpCompare(value, expected) >= 0;
    case "<=":
      return phpCompare(value, expected) <= 0;
    case "empty":
      return target === "acf" ? !truthy(value) : false;
    case "notempty":
      return target === "acf" ? truthy(value) : false;
    case "true":
      if (target === "loggedin") return false;
      return target === "acf" ? /^(1|true|on|yes)$/i.test(value) : false;
    case "false":
      if (target === "loggedin") return true;
      return target === "acf" ? !/^(1|true|on|yes)$/i.test(value) : false;
    default:
      return false;
  }
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A rule that applies: the template, and how it ranks. */
interface RuleMatch {
  slug: string;
  priority: number;
  override: boolean;
  statusCode?: number;
}

/**
 * `cc_themer_maker`'s decision for one request. Every include rule is evaluated (`all`, then its four
 * lists), a rule whose `includeCondition` is `and` needs every entry true and one that says `or`
 * needs one; those that match are then checked against their exclude rule (which has to EXIST: a
 * template with no exclude entry is never applied, as in the plugin); of what is left the highest
 * priority wins, the first of equals in the order the rules are stored. The winner needs a published
 * template of that slug, and applies only where the page names no page template of its own or the rule
 * says `overridePageTemplate`.
 */
export function cwiclyRule(
  site: Pick<SiteContext, "model" | "acf" | "options">,
  request: TemplateRequest,
  report?: Report,
  where?: string,
): RuleMatch | undefined {
  const conditions = site.options.conditions;
  const include = isRecord(conditions?.include) ? conditions.include : undefined;
  if (!include) return undefined;
  const exclude = isRecord(conditions.exclude) ? conditions.exclude : {};
  const f = factsOf(site, request);
  const said = new Set<string>();
  const verdicts = (slug: string, rule: Record<string, unknown>, which: string) => {
    const note = (kind: "approximated" | "unsupported", what: string): void => {
      const key = `${kind}|${slug}|${which}|${what}`;
      if (said.has(key)) return;
      said.add(key);
      report?.add({
        severity: kind === "unsupported" ? "warn" : "info",
        code: `template.condition-${kind}`,
        message:
          kind === "unsupported"
            ? `The ${which} rule of the template ${slug} has a condition (${what}) that only the request can answer; a static site counts it false.`
            : `The ${which} rule of the template ${slug} has a condition (${what}) about the visitor; it is decided for a guest, the one visitor a static site has.`,
        ...(where === undefined ? {} : { where }),
        data: { template: slug, rule: which, condition: what },
      });
    };
    const out: boolean[] = [];
    const push = (v: Verdict): void => void out.push(v === true);
    for (const c of list(rule.singular)) push(singularCondition(site, c, f));
    for (const c of list(rule.archive)) push(archiveCondition(site, c, f));
    for (const c of list(rule.author)) push(authorCondition(c, f));
    for (const c of list(rule.custom)) push(customCondition(site, c, f, note));
    return out;
  };

  const priorities = new Map<string, number>();
  const overrides = new Set<string>();
  const matched: string[] = [];
  for (const [slug, value] of Object.entries(include)) {
    if (!isRecord(value)) continue;
    const send: boolean[] = [];
    if (isTrueString(value.all)) send.push(true);
    send.push(...verdicts(slug, value, "include"));
    priorities.set(slug, Number(value.priority) || 0);
    if (isOn(value.overridePageTemplate)) overrides.add(slug);
    const mode = value.includeCondition;
    const ok =
      mode === "and"
        ? send.length > 0 && send.every(Boolean)
        : mode === "or"
          ? send.some(Boolean)
          : false;
    if (ok) matched.push(slug);
  }

  const kept: string[] = [];
  for (const slug of matched) {
    const out = exclude[slug];
    if (!isRecord(out)) {
      report?.add({
        severity: "info",
        code: "template.rule-no-exclude",
        message: `The template ${slug} matches its include rule but has no exclude entry, and Cwicly never applies a template without one.`,
        ...(where === undefined ? {} : { where }),
        data: { template: slug },
      });
      continue;
    }
    const list4 = [out.singular, out.archive, out.author, out.custom].map(list);
    const excluded: boolean[] = isTrueString(out.all) ? [true] : [];
    for (const [i, name] of (["singular", "archive", "author", "custom"] as const).entries()) {
      if (list4[i]!.length === 0) continue;
      const sub = { [name]: list4[i] } as Record<string, unknown>;
      excluded.push(...verdicts(slug, sub, "exclude"));
    }
    const noExclude = !isTrueString(out.all) && list4.every((l) => l.length === 0);
    const allExcluded = excluded.length > 0 && excluded.every(Boolean);
    const keep =
      noExclude ||
      (out.excludeCondition === "and" && !allExcluded) ||
      (out.excludeCondition === "or" && !excluded.some(Boolean));
    if (keep) kept.push(slug);
  }

  const ranked = new Map([...priorities].filter(([slug]) => kept.includes(slug)));
  if (ranked.size === 0) return undefined;
  const top = Math.max(...ranked.values());
  const slug = [...ranked].find(([, level]) => level === top)![0];
  // `get_posts(name => slug, post_type => wp_template, post_status => publish)`: no post, no override.
  if (templateOf(site, slug) === undefined) {
    report?.add({
      severity: "warn",
      code: "template.rule-missing",
      message: `Cwicly's rule picks the template ${slug}, which is not a published template of the active theme; WordPress's own choice stands.`,
      ...(where === undefined ? {} : { where }),
      data: { template: slug },
    });
    return undefined;
  }
  const override = overrides.has(slug);
  if (f.pageTemplateSet && !override) return undefined;
  const code = Number((include[slug] as Record<string, unknown>).statusCode) || undefined;
  return {
    slug,
    priority: top,
    override,
    ...(code === undefined ? {} : { statusCode: code }),
  };
}

// ── Choosing ─────────────────────────────────────────────────────────────────────────────────────

/** The report location of a request: `post:1716`, `term:35`, `archive:project`, `route:404`. */
function whereRequest(request: TemplateRequest): string {
  switch (request.kind) {
    case "page":
    case "single":
      return `post:${request.post.id}`;
    case "term":
      return `term:${request.term.termId}`;
    case "post-archive":
      return `archive:${request.postType}`;
    case "author":
      return `author:${request.user.id}`;
    case "posts":
      return "route:posts";
    case "search":
      return "route:search";
    case "404":
      return "route:404";
  }
}

/**
 * The template that renders a request: Cwicly's rule when one applies, else the first slug of
 * WordPress's list that is a published template of the active theme. `post` is undefined only for a
 * site whose theme has no `index` (every block theme has one).
 */
export function selectTemplate(
  site: Pick<SiteContext, "model" | "acf" | "options">,
  request: TemplateRequest,
  report?: Report,
): TemplateChoice {
  const where = whereRequest(request);
  const inv = inventoryOf(site);
  const tried = templateCandidates(site, request);
  const rule = cwiclyRule(site, request, report, where);
  if (rule) {
    tried.unshift(rule.slug);
    if (rule.statusCode !== undefined) {
      report?.add({
        severity: "info",
        code: "template.status-code",
        message: `Cwicly serves the template ${rule.slug} with the HTTP status ${rule.statusCode}; a static page has a 200.`,
        where,
        data: { template: rule.slug, status: rule.statusCode },
      });
    }
  }
  if ((request.kind === "page" || request.kind === "single") && report) {
    const own = firstMeta(site, request.post.id, "_wp_page_template");
    if (typeof own === "string" && own !== "" && own !== "default" && !inv.templates.has(own)) {
      report.add({
        severity: "warn",
        code: "template.page-template-missing",
        message: `The page names the page template "${own}", which is not a published template of the active theme (a classic theme's file?); the hierarchy goes on without it.`,
        where,
        data: { template: own },
      });
    }
  }
  const slug = tried.find((candidate) => inv.templates.has(candidate));
  return {
    slug: slug ?? "index",
    via: rule !== undefined && slug === rule.slug ? "rule" : "hierarchy",
    tried: [...new Set(tried)],
    post: slug === undefined ? undefined : inv.templates.get(slug),
  };
}

// ── What the site's routes need ──────────────────────────────────────────────────────────────────

/** The slugs WordPress's hierarchy gives to something that is not a page: archives, entries, listings, errors. */
const BODY_TEMPLATE =
  /^(?:single|archive|taxonomy|category|tag|author|date|home|index|search|404|attachment|embed)(?:-|$)/;

/**
 * Whether a template is written for a page's content by its name: `front-page`, `page`, `page-<slug>`,
 * `singular`, `privacy-policy`, `wp-custom-template-*` and any name the hierarchy has no meaning for (a
 * custom template a page can choose, `test-header`). Everything the hierarchy gives to entries, archives,
 * listings and errors is the other kind.
 */
export const isPageTemplate = (slug: string): boolean => !BODY_TEMPLATE.test(slug);

type BodyKind = Exclude<PageKind, "page">;

/** The requests of one page that select the same template. */
interface UseGroup {
  slug: string;
  choice: TemplateChoice;
  requests: TemplateRequest[];
}

/** One page this module writes, with who renders what on it. */
interface PlannedPage {
  kind: BodyKind;
  /** The file: `Route.file` for a static page, the dynamic page's file otherwise. */
  file: string;
  /** The Jx route, or the pattern of a dynamic page. */
  route: string;
  dynamic?: DynamicPage;
  /** The post type of the entries, the taxonomy of the terms, the post type of an archive. */
  type?: string;
  /** The static page's own route (the file's address). */
  staticRoute?: Route;
  /** The routes behind a dynamic page. */
  routes: readonly Route[];
  /** Grouped by the template each request selects, the template of most requests first. */
  groups: UseGroup[];
}

interface Plan {
  pages: PlannedPage[];
  /** The template of every `page` post, whatever its status. */
  pageChoice: Map<number, TemplateChoice>;
  /** Templates that need a layout with the page's body in it. */
  slotted: Set<string>;
  /** Templates that need a chrome-only layout. */
  framed: Set<string>;
}

const sortGroups = (groups: Map<string, UseGroup>): UseGroup[] =>
  [...groups.values()].sort(
    (a, b) => b.requests.length - a.requests.length || (a.slug < b.slug ? -1 : 1),
  );

function group(
  site: Pick<SiteContext, "model" | "acf" | "options">,
  requests: readonly TemplateRequest[],
  report: Report | undefined,
): UseGroup[] {
  const groups = new Map<string, UseGroup>();
  for (const request of requests) {
    const choice = selectTemplate(site, request, report);
    const found = groups.get(choice.slug);
    if (found) found.requests.push(request);
    else groups.set(choice.slug, { slug: choice.slug, choice, requests: [request] });
  }
  return sortGroups(groups);
}

/** The static-page file of a route: `Route.file`, which is the page file for the kinds this module writes. */
const dirOf = (file: string): string => file.replace(/\/[^/]+$/, "");

function planOf(site: SiteContext, report?: Report): Plan {
  const pageChoice = new Map<number, TemplateChoice>();
  const pages: PlannedPage[] = [];
  const slotted = new Set<string>();
  const framed = new Set<string>();
  const inv = inventoryOf(site);

  for (const post of site.model.posts.values()) {
    if (post.type !== "page") continue;
    // Findings about a page's own choice are said once, for the pages the site will publish.
    const published = post.status === "publish" && site.routes.forPost(post.id)?.id === post.id;
    const choice = selectTemplate(site, { kind: "page", post }, published ? report : undefined);
    pageChoice.set(post.id, choice);
    slotted.add(choice.slug);
  }
  for (const slug of inv.templates.keys()) (isPageTemplate(slug) ? slotted : framed).add(slug);

  const routes = site.routes.all();
  const taken = new Set<string>(routes.map((r) => r.file));

  // The posts index, and the front page of a site that shows its latest posts.
  for (const route of routes) {
    if (route.kind !== "posts-page") continue;
    const front = route.jxRoute === "/";
    pages.push({
      kind: "posts",
      file: route.file,
      route: route.jxRoute,
      staticRoute: route,
      routes: [route],
      groups: group(site, [{ kind: "posts", front }], report),
    });
  }
  // The archive of a post type.
  for (const route of routes) {
    if (route.kind !== "post-archive") continue;
    const type = String(route.id);
    pages.push({
      kind: "archive",
      file: route.file,
      route: route.jxRoute,
      type,
      staticRoute: route,
      routes: [route],
      groups: group(site, [{ kind: "post-archive", postType: type }], report),
    });
  }
  // Entries, terms and authors: one dynamic page each.
  for (const dp of site.routes.dynamicPages()) {
    const requests: TemplateRequest[] = [];
    let type: string | undefined;
    let kind: BodyKind;
    if (dp.kind === "entries") {
      kind = "entry";
      for (const route of dp.routes) {
        const post = site.model.posts.get(Number(route.id));
        if (!post) continue;
        type = post.type;
        requests.push({ kind: "single", post });
      }
    } else if (dp.kind === "terms") {
      kind = "term";
      type = dp.source;
      for (const route of dp.routes) {
        const term = site.model.terms.get(Number(route.id));
        if (term) requests.push({ kind: "term", term });
      }
    } else {
      kind = "author";
      for (const route of dp.routes) {
        const user = site.model.users.get(Number(route.id));
        if (user) requests.push({ kind: "author", user });
      }
    }
    if (requests.length === 0) continue;
    pages.push({
      kind,
      file: dp.file,
      route: dp.pattern,
      dynamic: dp,
      ...(type === undefined ? {} : { type }),
      routes: dp.routes,
      groups: group(site, requests, report),
    });
  }
  // The pages every site has and no route table lists.
  if (!taken.has("pages/404.json")) {
    pages.push({
      kind: "404",
      file: "pages/404.json",
      route: "/404/",
      routes: [],
      groups: group(site, [{ kind: "404" }], report),
    });
  }
  if (!taken.has("pages/search.json")) {
    pages.push({
      kind: "search",
      file: "pages/search.json",
      route: "/search/",
      routes: [],
      groups: group(site, [{ kind: "search" }], report),
    });
  }
  for (const page of pages) for (const g of page.groups) framed.add(g.slug);
  return { pages, pageChoice, slotted, framed };
}

const plans = new WeakMap<object, Plan>();
const planFor = (site: SiteContext): Plan => {
  let plan = plans.get(site.model);
  if (!plan) {
    plan = planOf(site);
    plans.set(site.model, plan);
  }
  return plan;
};

/** The file name a template's layout takes: `base` and `fallback` are the document frame's and the fallback page's. */
const layoutName = (slug: string): string =>
  slug === "base" || slug === "fallback" ? `${slug}-template` : slug;

/** The layout of a template: the one with the page's body in it, or the chrome-only one (`-frame` when the template is both). */
export function layoutPathOf(site: SiteContext, slug: string, flavor: "slotted" | "frame"): string {
  const plan = planFor(site);
  if (flavor === "slotted") return layoutPath(layoutName(slug));
  return layoutPath(plan.slotted.has(slug) ? `${layoutName(slug)}-frame` : layoutName(slug));
}

/**
 * The template WordPress renders a subject with: a page, an entry (any post), or a template itself.
 * Undefined for a subject that is not a routed object (a part, a component, a reusable block).
 */
export function templateFor(site: SiteContext, subject: Subject): TemplateChoice | undefined {
  switch (subject.kind) {
    case "template": {
      const post = templateOf(site, subject.slug);
      return post
        ? { slug: subject.slug, via: "hierarchy", tried: [subject.slug], post }
        : undefined;
    }
    case "post": {
      const post = site.model.posts.get(subject.id);
      if (!post) return undefined;
      if (post.type === "page") {
        return (
          planFor(site).pageChoice.get(post.id) ?? selectTemplate(site, { kind: "page", post })
        );
      }
      return selectTemplate(site, { kind: "single", post });
    }
    default:
      return undefined;
  }
}

/**
 * The layout of a page or an entry: `./layouts/<template slug>.json`, project-root relative, as `$layout`
 * holds it. A page gets the layout with its body in it, an entry the chrome-only one (its body is the
 * entry page this module writes). Undefined when the site has no template for it.
 */
export function layoutFor(site: SiteContext, subject: Subject): string | undefined {
  const choice = templateFor(site, subject);
  if (choice?.post === undefined) return undefined;
  if (subject.kind === "template") {
    return layoutPathOf(site, choice.slug, isPageTemplate(choice.slug) ? "slotted" : "frame");
  }
  const post = subject.kind === "post" ? site.model.posts.get(subject.id) : undefined;
  return layoutPathOf(site, choice.slug, post?.type === "page" ? "slotted" : "frame");
}

// ── Pieces of a converted template ───────────────────────────────────────────────────────────────

/** The keys of a page's own post that `emit/pages.ts` writes under `state.entry` (its `ENTRY_OWN_KEYS`). */
export const PAGE_ENTRY_KEYS: readonly string[] = [
  "title",
  "slug",
  "date",
  "modified",
  "excerpt",
  "author",
  "url",
  "featuredImage",
];

/** `children` of an element that prints the entry's body: how `cwicly/content` and `core/post-content` write it. */
const ENTRY_BODY = /^\$\{state\.entry\.\$children(?: \?\? \[\])?\}$/;

const isEntryBody = (node: JxElement): boolean =>
  typeof node.children === "string" && ENTRY_BODY.test(node.children as string);

/** A deep copy: the conversions are memoised, so nothing here may edit what they returned. */
const copyNodes = (nodes: readonly JxNode[]): JxNode[] => structuredClone([...nodes]);

/** How many elements of the trees print the entry's body. */
export function countEntryBodies(nodes: readonly JxNode[]): number {
  let n = 0;
  for (const element of walkElements(nodes)) if (isEntryBody(element)) n++;
  return n;
}

/**
 * The trees with the entry's body replaced by the layout's `<slot>`: the first element that printed
 * `${state.entry.$children}` keeps its box (its classes and styles are the template's) and holds the slot
 * instead, and any later one is emptied (a layout has one default slot). `found` says how many there were.
 */
export function slotContent(nodes: readonly JxNode[]): { nodes: JxNode[]; found: number } {
  const copy = copyNodes(nodes);
  let found = 0;
  for (const element of walkElements(copy)) {
    if (!isEntryBody(element)) continue;
    found++;
    element.children = found === 1 ? [{ tagName: "slot" }] : [];
  }
  return { nodes: copy, found };
}

/** A tree's elements that are `wp2jx-template-part` placeholders of the given parts. */
function partsIn(node: JxNode): string[] {
  const slugs: string[] = [];
  for (const element of walkElements([node])) {
    if (element.tagName !== "wp2jx-template-part") continue;
    const slug = (element.attributes as Record<string, unknown> | undefined)?.slug;
    if (typeof slug === "string") slugs.push(slug);
  }
  return slugs;
}

/** Whether a template part is the site's header or footer: its area, else the name it has. */
export function partArea(
  site: Pick<SiteContext, "model">,
  slug: string,
): "header" | "footer" | "other" {
  const post = inventoryOf(site).parts.get(slug);
  const area = post ? areaOf(site, post) : "uncategorized";
  if (area === "header" || area === "footer") return area;
  return "other";
}

export interface ChromeSplit {
  /** Everything up to and including the last top-level node that holds a header part. */
  prefix: JxNode[];
  /** What is between: the template's own body. */
  body: JxNode[];
  /** From the first top-level node that holds a footer part to the end. */
  suffix: JxNode[];
  /** Why the template could not be cut, when it could not: the whole of it is then the body. */
  unsplit?: string;
}

/**
 * Cut a converted template into the chrome around its body. The header is the last top-level node that
 * holds a template part of the header area, the footer the first that holds one of the footer area
 * (anabaptistperspectives' `single-post` has its header part inside a `div` with a second bar, so the cut
 * is by node, not by block). A template whose header and footer sit in one node, whose chrome holds the
 * entry's body, or that has neither is not cut where that would lose the body: its chrome is empty.
 */
export function splitChrome(
  site: Pick<SiteContext, "model">,
  nodes: readonly JxNode[],
): ChromeSplit {
  const whole = (unsplit?: string): ChromeSplit => ({
    prefix: [],
    body: [...nodes],
    suffix: [],
    ...(unsplit === undefined ? {} : { unsplit }),
  });
  let header = -1;
  let footer = nodes.length;
  nodes.forEach((node, i) => {
    const areas = partsIn(node).map((slug) => partArea(site, slug));
    if (areas.includes("header")) header = i;
    if (areas.includes("footer") && i < footer && footer === nodes.length) footer = i;
  });
  if (header < 0 && footer === nodes.length) return whole();
  if (header >= footer)
    return whole("the header and the footer parts are in the same top-level node");
  const prefix = nodes.slice(0, header + 1);
  const suffix = nodes.slice(footer);
  if ([...prefix, ...suffix].some((node) => countEntryBodies([node]) > 0)) {
    return whole("the header or the footer is in the same node as the entry's body");
  }
  return { prefix: [...prefix], body: nodes.slice(header + 1, footer), suffix: [...suffix] };
}

/** A paragraph that is only the text of a shortcode: how `core/blocks.ts` keeps a closing tag it does not know (`[/dkpdf-remove]`). */
const SHORTCODE_TEXT = /^\[\/?([a-z][\w-]*)(?:\s[^\]]*)?\]$/i;

/**
 * The trees without the paragraphs that only spell a shortcode that prints nothing (see
 * {@link EMPTY_SHORTCODES}): the converter makes a placeholder of an opening tag but leaves a closing one
 * as text, which would show as `[/dkpdf-remove]` on every page. Returns the copy and the names dropped.
 */
export function withoutShortcodeText(nodes: readonly JxNode[]): {
  nodes: JxNode[];
  dropped: string[];
} {
  const dropped: string[] = [];
  const isEmptyText = (node: JxNode): boolean => {
    if (typeof node === "string" || node.tagName !== "p") return false;
    if (typeof node.textContent !== "string" || node.children !== undefined) return false;
    const name = SHORTCODE_TEXT.exec(node.textContent.trim())?.[1];
    if (name === undefined || !EMPTY_SHORTCODES.has(name)) return false;
    dropped.push(node.textContent.trim());
    return true;
  };
  const copy = copyNodes(nodes).filter((node) => !isEmptyText(node));
  for (const element of walkElements(copy)) {
    if (Array.isArray(element.children))
      element.children = element.children.filter((c) => !isEmptyText(c));
  }
  return { nodes: copy, dropped };
}

// ── Placeholders ─────────────────────────────────────────────────────────────────────────────────

/**
 * Shortcodes that print nothing on the live pages of the sites this was built from: the markers of the
 * PDF plugin's `[dkpdf-remove]`, which only keep the section out of a PDF. Removed and said
 * (`template.shortcode-empty`). (Rank Math's `[rank_math_breadcrumb]` is NOT here: it prints a real
 * `nav.rank-math-breadcrumb` on every page that has the shortcode, see {@link breadcrumbNode}.)
 */
export const EMPTY_SHORTCODES: ReadonlySet<string> = new Set(["dkpdf-remove", "dkpdf-pdf-remove"]);

/**
 * One crumb after `Home`: text known now (with the address it links to, when it has one), or an
 * expression the build evaluates.
 */
export type Crumb = { text: string; href?: string } | { expr: string };

/** What `[rank_math_breadcrumb]` takes from Rank Math's settings (`rank-math-options-general`, `breadcrumbs_*`). */
export interface BreadcrumbSettings {
  /** The shortcode prints nothing when Rank Math's breadcrumbs are switched off. */
  enabled: boolean;
  /** The separator as stored: markup (`&raquo;`) or text (`-`). */
  separator: string;
  /** Whether the trail starts with a home crumb, its label and the address it links to (as stored). */
  home: boolean;
  homeLabel: string;
  homeLink: string | undefined;
  hideTaxName: boolean;
  removeTitle: boolean;
  showAncestors: boolean;
  showBlog: boolean;
  archiveFormat: string;
}

/**
 * The breadcrumb settings of a site, as `Breadcrumbs::__construct` reads them. A site whose option is not
 * there prints the trail both fixture sites' live pages print (`Home » …`).
 */
export function breadcrumbSettings(site: Pick<SiteContext, "model">): BreadcrumbSettings {
  const raw = site.model.options.get("rank-math-options-general");
  const stored = raw === undefined ? undefined : maybeUnserialize(raw);
  const general = isRecord(stored) ? stored : {};
  const flag = (key: string, fallback: boolean): boolean =>
    general[key] === undefined ? fallback : onSetting(general[key]);
  const str = (key: string, fallback: string): string => {
    const value = general[key];
    return typeof value === "string" ? value : fallback;
  };
  const link = general.breadcrumbs_home_link;
  return {
    enabled: flag("breadcrumbs", true),
    separator: str("breadcrumbs_separator", "&raquo;"),
    home: flag("breadcrumbs_home", true),
    homeLabel: str("breadcrumbs_home_label", "Home"),
    homeLink: typeof link === "string" && link !== "" ? link : undefined,
    hideTaxName: flag("breadcrumbs_hide_taxonomy_name", false),
    removeTitle: flag("breadcrumbs_remove_post_title", false),
    showAncestors: flag("breadcrumbs_ancestor_categories", false),
    showBlog: flag("breadcrumbs_blog_page", false),
    archiveFormat: str("breadcrumbs_archive_format", "Archives for %s"),
  };
}

/** What `breadcrumbNode` writes around the crumbs. */
export interface BreadcrumbOptions {
  /** The separator, as markup (default `&raquo;`). */
  separator?: string;
  /** The home crumb, or `false` for none (default `Home` linking to `/`). */
  home?: { label: string; href: string } | false;
  /** Every crumb with an address is a link, the last included (`breadcrumbs_remove_post_title` removed the page's own). */
  linkLast?: boolean;
}

/**
 * `[rank_math_breadcrumb]` as the live pages print it (checked on the pages of both sites):
 * `nav.rank-math-breadcrumb > p` with `Home`, then each crumb behind a `separator` span; a crumb with an
 * address is a link unless it is the last, every other crumb is a `span.last` (`class-breadcrumbs.php`
 * calls them all that; the taxonomy of a custom taxonomy's term is a crumb with no address, `Series » A
 * Knock Heard Round the Hood`, a category's and a tag's is not). It is one `innerHTML`, because the build
 * puts a visible space between inline siblings, and the live markup has none.
 */
export function breadcrumbNode(
  crumbs: readonly Crumb[],
  options: BreadcrumbOptions = {},
): JxElement {
  // A string that holds a binding is a template literal: its literal text needs `\` and a backtick escaped
  // (docs/bindings.md, rule 8), and a string that holds none is printed as it is, so only then.
  const bound = crumbs.some((crumb) => "expr" in crumb);
  const literal = (text: string): string =>
    bound ? text.replaceAll("\\", "\\\\").replaceAll("`", "\\`") : text;
  const plain = (text: string): string =>
    escapeTemplate(
      literal(text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")),
    );
  const attribute = (text: string): string => plain(text).replaceAll('"', "&quot;");
  const separator = `<span class="separator"> ${escapeTemplate(literal(options.separator ?? "&raquo;"))} </span>`;
  const home = options.home === undefined ? { label: "Home", href: "/" } : options.home;
  const inner: string[] = [];
  if (home !== false) {
    inner.push(`<a href="${attribute(home.href)}">${plain(home.label)}</a>`);
  }
  const shown = crumbs.map((crumb, i) => {
    const last = i === crumbs.length - 1;
    if ("expr" in crumb) {
      return `<span class="last">\${${htmlEscapeExpr(crumb.expr)}}</span>`;
    }
    if (crumb.href !== undefined && (!last || options.linkLast === true)) {
      return `<a href="${attribute(crumb.href)}">${plain(crumb.text)}</a>`;
    }
    return `<span class="last">${plain(crumb.text)}</span>`;
  });
  // Rank Math puts a separator after every crumb but the last, the home crumb included.
  const parts = [...inner, ...shown];
  const html = parts.join(separator);
  return {
    tagName: "nav",
    className: "rank-math-breadcrumb",
    attributes: { "aria-label": "breadcrumbs" },
    children: [{ tagName: "p", innerHTML: html }],
  };
}

/** The dynamic blocks of core that print data of the page being rendered: a template that is not an entry has none to read. */
const PAGE_DATA = new Set([
  "wp2jx-post-title",
  "wp2jx-post-featured-image",
  "wp2jx-post-excerpt",
  "wp2jx-post-date",
  "wp2jx-post-terms",
]);

/** The visible stand-in for what has no static form: the class says what it is, the text says what it said. */
function neutralElement(placeholder: Placeholder, label: string, say: string): JxElement {
  const inner = placeholder.element.children;
  return {
    tagName: "div",
    className: `wp2jx-unconverted wp2jx-${placeholder.kind}`,
    attributes: { "data-wp2jx": label },
    ...(Array.isArray(inner) && inner.length > 0
      ? { children: inner }
      : { textContent: literalText(say) }),
  };
}

interface Env {
  site: SiteContext;
  report: Report;
  siteUrl: string;
  now: Date;
  extra: ResolverMap;
  convert: NonNullable<TemplatesOptions["convert"]>;
  tags: Set<string>;
  menus: MenusUsed;
  used: TemplatesUsed;
  customCode: { head?: string; bodyOpen: string; footer: string };
  converted: Map<string, Promise<Converted>>;
}

interface ResolveFlags {
  /** `{postcontent}` in markup the converters could not slot is the layout's slot. */
  slot?: boolean;
  /** The post type of an archive page: `core/query-title` prints its plural label. */
  archiveType?: string;
  /** What `[rank_math_breadcrumb]` prints after `Home` on this page; without it the shortcode has nothing to say. */
  crumbs?: readonly Crumb[];
  /** Every crumb with an address is a link (`breadcrumbs_remove_post_title` took the page's own off the end). */
  crumbsLinkLast?: boolean;
  /** What Rank Math's trail has on this page that a static one cannot carry, said when the shortcode prints. */
  crumbNotes?: readonly string[];
}

const optimiseWrapper = (site: Pick<SiteContext, "options">): boolean =>
  site.options.optimise.templatePartWrapper !== true;

/** The element WordPress wraps a part in, when Cwicly's optimisation that removes it is off. */
function partWrapper(
  site: Pick<SiteContext, "model">,
  placeholder: Placeholder,
  slug: string,
  inner: JxElement,
): JxElement {
  const post = inventoryOf(site).parts.get(slug);
  const area = post ? areaOf(site, post) : "uncategorized";
  const tag =
    placeholder.attrs.tag ?? (area === "header" ? "header" : area === "footer" ? "footer" : "div");
  const className = placeholder.element.className;
  return {
    tagName: tag,
    className:
      typeof className === "string" && className !== "" ? className : "wp-block-template-part",
    children: [inner],
  };
}

/** What `replacePlaceholders` is handed for a template, a part or a page this module writes. */
function resolversFor(
  env: Env,
  where: string,
  flags: ResolveFlags = {},
  url?: string,
): ResolverMap {
  const { site, report } = env;
  const said = new Set<string>();
  const once = (key: string, entry: ReportEntry): void => {
    if (said.has(key)) return;
    said.add(key);
    report.add({ ...entry, where, ...(url === undefined ? {} : { url }) });
  };
  const tools = site.urls.bind(report, where);
  const menus = menuResolvers(site, {
    report,
    where,
    used: env.menus,
    ...(url === undefined ? {} : { url }),
  });
  const own: Record<string, Resolver> = {
    "wp2jx-template-part": (placeholder) => {
      const slug = placeholder.attrs.slug;
      const inv = inventoryOf(site);
      if (slug === undefined || slug === "" || !inv.parts.has(slug)) {
        once(`part|${slug ?? ""}`, {
          severity: "error",
          code: "template.part-missing",
          message:
            slug === undefined || slug === ""
              ? "A template part block names no part, so nothing is printed for it."
              : `The template part "${slug}" is not a published part of the active theme; nothing is printed for it.`,
          data: { part: slug ?? null },
        });
        return null;
      }
      const tag = partTag(site, slug);
      env.used.components.add(tag);
      const instance: JxElement = { tagName: tag };
      return optimiseWrapper(site) ? partWrapper(site, placeholder, slug, instance) : instance;
    },
    "wp2jx-post-content": () => {
      if (flags.slot === true) return { tagName: "slot" };
      once("post-content", {
        severity: "warn",
        code: "template.dynamic-unavailable",
        message:
          "A {postcontent} token sits in markup that is not the template's content block, and this place has no page body to print.",
        data: { kind: "post-content" },
      });
      return null;
    },
    "wp2jx-shortcode": (placeholder) => {
      const name = placeholder.attrs["data-shortcode"] ?? "";
      if (name === "rank_math_breadcrumb") {
        const settings = breadcrumbSettings(site);
        if (!settings.enabled) {
          once("breadcrumb-off", {
            severity: "info",
            code: "template.breadcrumb-disabled",
            message:
              "Rank Math's breadcrumbs are switched off for this site, so the shortcode printed nothing on the live pages and is left out.",
            data: { shortcode: name },
          });
          return null;
        }
        if (flags.crumbs !== undefined) {
          for (const note of flags.crumbNotes ?? []) {
            once(`breadcrumb-approximated|${note}`, {
              severity: "info",
              code: "template.breadcrumb-approximated",
              message: `Rank Math's trail has ${note} here, which depends on the entry or term and is not written; the trail is the part every page of this kind shares.`,
              data: { shortcode: name, difference: note },
            });
          }
          const homeHref =
            settings.homeLink === undefined ? "/" : tools.rewriteUrl(settings.homeLink);
          return breadcrumbNode(flags.crumbs, {
            separator: settings.separator,
            home: settings.home ? { label: settings.homeLabel, href: homeHref } : false,
            ...(flags.crumbsLinkLast === true ? { linkLast: true } : {}),
          });
        }
        once("breadcrumb", {
          severity: "warn",
          code: "template.dynamic-unavailable",
          message:
            "A breadcrumb shortcode sits where the page it is on has no trail to print (a part, a layout of entries); it is left out.",
          data: { shortcode: name },
        });
        return null;
      }
      // A closing tag (`[/dkpdf-remove]`) is the same shortcode's own.
      const base = name.replace(/^\//, "");
      if (EMPTY_SHORTCODES.has(base)) {
        once(`shortcode-empty|${base}`, {
          severity: "info",
          code: "template.shortcode-empty",
          message: `The shortcode [${base}] printed nothing on the live pages and is left out.`,
          data: { shortcode: base },
        });
        return Array.isArray(placeholder.element.children) ? placeholder.element.children : null;
      }
      const form = fluentFormFor(site, placeholder, (entry) =>
        once(`${entry.code}|${placeholder.attrs["data-attributes"] ?? ""}|${entry.message}`, entry),
      );
      if (form !== undefined) return form;
      once(`shortcode|${name}`, {
        severity: "warn",
        code: "template.placeholder-neutral",
        message: `The shortcode [${name}] has no static form; a visible neutral element holds its text where it stood.`,
        data: { kind: "shortcode", shortcode: name },
      });
      return neutralElement(
        placeholder,
        `shortcode:${name}`,
        placeholder.attrs["data-source"] ?? `[${name}]`,
      );
    },
    "wp2jx-block": (placeholder) => {
      const block = placeholder.block ?? "unknown";
      const form = fluentFormFor(site, placeholder, (entry) =>
        once(`${entry.code}|${JSON.stringify(placeholder.blockAttrs)}|${entry.message}`, entry),
      );
      if (form !== undefined) return form;
      once(`block|${block}`, {
        severity: "warn",
        code: "template.placeholder-neutral",
        message: `The block ${block} saved no markup and has no converter; a visible neutral element marks where it stood.`,
        data: { kind: "block", block },
      });
      return neutralElement(placeholder, `block:${block}`, `[${block}]`);
    },
    "wp2jx-query-title": (placeholder) => {
      const type =
        flags.archiveType === undefined ? undefined : site.acf.postTypes.get(flags.archiveType);
      if (type === undefined) {
        once("query-title", {
          severity: "warn",
          code: "template.dynamic-unavailable",
          message:
            "A query title block prints the title of the archive, and this page is not one of a post type or a term; nothing is printed.",
          data: { kind: "query-title" },
        });
        return null;
      }
      const level = Number(placeholder.blockAttrs.level ?? 1);
      return {
        tagName: level >= 1 && level <= 6 ? `h${level}` : "p",
        className: "wp-block-query-title",
        textContent: literalText(decodeEntities(type.labels.name ?? type.plural)),
      };
    },
  };
  for (const tag of PAGE_DATA) {
    own[tag] = (placeholder) => {
      once(`data|${tag}`, {
        severity: "warn",
        code: "template.dynamic-unavailable",
        message: `A ${placeholder.block ?? tag} block prints data of the page being rendered, and this ${where.split(":")[0] ?? "place"} has none to read; nothing is printed.`,
        data: { kind: tag.slice(PLACEHOLDER_PREFIX.length) },
      });
      return null;
    };
  }
  return { ...menus, ...own, ...env.extra };
}

/** The tags of components the trees instantiate. */
function tagsIn(env: Env, nodes: readonly JxNode[]): string[] {
  const found = new Set<string>();
  for (const element of walkElements(nodes)) {
    const tag = element.tagName as string | undefined;
    if (tag !== undefined && env.tags.has(tag)) found.add(tag);
  }
  return [...found].sort();
}

/** The `$elements` of a document at `file` for the components its nodes use. */
const elementsFor = (env: Env, nodes: readonly JxNode[], file: string): { $ref: string }[] =>
  tagsIn(env, nodes).map((tag) => ({ $ref: relativeRef(file, componentFile(tag)) }));

/** Put a conversion's findings in the run's report. {@link convertOnce} is the only caller, so each conversion is said once. */
function absorb(env: Env, converted: Converted): void {
  for (const entry of converted.report.entries()) env.report.add(entry);
}

const subjectKey = (subject: Subject, opts: SubjectOptions): string =>
  `${JSON.stringify(subject)}|${JSON.stringify(opts)}`;

/**
 * The conversion with its addresses moved to the project: the nodes' and the hoisted rules' `url()`s are
 * rewritten in copies, because the conversion is shared (and may be memoised by whoever made it).
 */
function withProjectUrls(env: Env, subject: Subject, converted: Converted): Converted {
  const tools = env.site.urls.bind(env.report, subjectWhere(env.site, subject));
  const rewrite = (address: string): string => tools.rewriteUrl(address);
  const nodes = copyNodes(converted.nodes);
  for (const element of walkElements(nodes)) rewriteStyleUrls(element.style, rewrite);
  const hoisted = structuredClone(converted.hoisted);
  for (const rule of hoisted) rewriteStyleUrls(rule.style, rewrite);
  return { ...converted, nodes, hoisted };
}

/** A subject converted once for the whole run, whoever asks. */
function convertOnce(env: Env, subject: Subject, opts: SubjectOptions = {}): Promise<Converted> {
  const key = subjectKey(subject, opts);
  let found = env.converted.get(key);
  if (!found) {
    found = env.convert(env.site, subject, opts).then((made) => {
      absorb(env, made);
      const converted = withProjectUrls(env, subject, made);
      const cleaned = withoutShortcodeText(converted.nodes);
      if (cleaned.dropped.length === 0) return converted;
      const where = subjectWhere(env.site, subject);
      for (const name of new Set(cleaned.dropped)) {
        env.report.add({
          severity: "info",
          code: "template.shortcode-empty",
          message: `The shortcode text ${name} printed nothing on the live pages and is left out.`,
          where,
          data: { shortcode: name },
        });
      }
      return { ...converted, nodes: cleaned.nodes };
    });
    env.converted.set(key, found);
  }
  return found;
}

/** What a finished document brings to the project: the classes, the components, the states. */
function account(env: Env, nodes: readonly JxNode[], states: Iterable<string> = []): void {
  for (const tag of tagsIn(env, nodes)) env.used.components.add(tag);
  for (const name of collectWpClasses(nodes)) env.used.wpClasses.add(name);
  for (const key of states) env.used.states.add(key);
}

/** `${state.term.name}` is how `core/query-title` (core/blocks.ts) writes the archive's name; a term entry holds it under `data`. */
const TERM_NAME = /\$\{state\.term\.name\}/g;

/**
 * What `get_the_archive_title()` puts before the name of a term: `Category: `, `Tag: `, or a custom
 * taxonomy's singular label (checked against the live archive pages of anabaptistperspectives).
 */
export function archiveLabel(site: Pick<SiteContext, "acf">, taxonomy: string): string | undefined {
  if (taxonomy === "category") return "Category";
  if (taxonomy === "post_tag") return "Tag";
  const found = site.acf.taxonomies.get(taxonomy);
  return found === undefined ? undefined : decodeEntities(found.singular);
}

/**
 * Repair the bindings core writes against a term the way the entry data contract does not have it: the
 * name is under `data`, and a title that is only the name (the generic `archive` template shows several
 * kinds of archive, so the converter cannot know the kind) gets the prefix WordPress prints when `label`
 * says what the page is. Returns how many bindings were repaired.
 */
export function repairTermBindings(nodes: JxNode[], label?: string): number {
  let n = 0;
  const name = "${state.term.data.name ?? ''}";
  /**
   * The label as the literal part of a string that now holds a binding: a template literal, so `\` and a
   * backtick are escaped (docs/bindings.md, rule 8) and a `${` is degraded; in markup it is also HTML.
   */
  const literal = (text: string, markup: boolean): string => {
    const safe = markup
      ? text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      : text;
    return literalText(safe).replaceAll("\\", "\\\\").replaceAll("`", "\\`");
  };
  const fix = (value: string, markup: boolean): string => {
    const bare = value === "${state.term.name}" && label !== undefined;
    const done = value.replace(TERM_NAME, () => {
      n++;
      return name;
    });
    return bare ? `${literal(label, markup)}: ${done}` : done;
  };
  for (const element of walkElements(nodes)) {
    if (typeof element.textContent === "string")
      element.textContent = fix(element.textContent, false);
    if (typeof element.innerHTML === "string") element.innerHTML = fix(element.innerHTML, true);
  }
  return n;
}

// ── Components: template parts and reusable blocks ───────────────────────────────────────────────

const json = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

interface ComponentBuilt {
  file: string;
  tag: string;
  content: string;
  empty: boolean;
}

/**
 * One component document from a part or a reusable block: the subject's nodes with their placeholders
 * replaced, `$elements` for every component they instantiate, the state the conversion registered and the
 * rules that could not stay on an element. The host is `display: contents`, because the live page prints
 * the part's own elements and nothing around them (Cwicly's `templatePartWrapper`), so a part's section
 * stays the flex or grid item it was.
 */
async function componentOf(
  env: Env,
  subject: Subject,
  tag: string,
  where: string,
): Promise<ComponentBuilt> {
  const converted = await convertOnce(env, subject, { mode: "static", target: "page" });
  const file = componentFile(tag);
  const nodes = replacePlaceholders(copyNodes(converted.nodes), resolversFor(env, where), {
    report: env.report,
    where,
  });
  const placed = hoistedStyle(dedupeRules(converted.hoisted));
  env.used.documentRules.push(...placed.unplaced);
  for (const key of placed.collisions) {
    env.report.add({
      severity: "warn",
      code: "template.hoisted-collision",
      message: `Two rules of ${where} define ${key} differently and an at-rule has one definition; the later one is kept.`,
      where,
      data: { key },
    });
  }
  const doc: Record<string, unknown> = { tagName: tag };
  const elements = elementsFor(env, nodes, file).filter(
    (ref) => !ref.$ref.endsWith(`/${tag}.json`),
  );
  if (elements.length > 0) doc.$elements = elements;
  if (Object.keys(converted.state).length > 0) doc.state = converted.state;
  doc.style = { display: "contents", ...placed.style };
  doc.children = nodes;
  for (const bad of misplacedBindings({
    children: wholeBindingsAside(nodes),
  } as unknown as JxDocument)) {
    env.report.add({
      severity: "error",
      code: "template.binding-misplaced",
      message: `A \${…} sits in ${bad.position} (${bad.path || "component"}), where the build never evaluates it.`,
      where,
      data: { ...bad },
    });
  }
  account(env, nodes, converted.used.states);
  return { file, tag, content: json(doc), empty: nodes.length === 0 };
}

// ── Layouts ──────────────────────────────────────────────────────────────────────────────────────

/** The document frame: `cwicly_custom_code`'s body-open and footer markup around WordPress's own `div.wp-site-blocks`. */
export const BASE_LAYOUT_FILE = "layouts/base.json";
export const BASE_LAYOUT = "./layouts/base.json";

const FRAGMENT_CONDITION_KEYS = ["singular", "archive", "author", "acf", "custom"];

/**
 * The template parts of a global fragment (`globalheader` is printed at `wp_body_open`, `globalfooter` at
 * `wp_footer`, on every request: `Themer::add_global_fragments`) that apply to every page, and the ones that
 * depend on the page, as `cc_condition_checker` decides them. A part is included only when its
 * `includeCondition` is `and` (every result true) or `or` (any result true); `all` is a result only when it
 * is the string `"true"`, the others being the page's own conditions, so `or` with `all` is every page and
 * anything else that holds a condition of the page is the page's to decide. An `all` exclusion removes the
 * part (unless it is an `and` over conditions of the page too). The plugin adds a part only when the
 * include rule has an exclude entry to read (`cc_condition_checker` reads `$conditions->exclude->$templater`
 * after the include checks and adds nothing when it is not there), so a rule with none is skipped.
 */
export function fragmentParts(
  site: Pick<SiteContext, "options">,
  name: string,
  /** Called with the slug of a part whose include rule matches but which has no exclude entry. */
  skipped?: (slug: string) => void,
): { always: string[]; conditional: string[] } {
  const parts = site.options.globalParts;
  const fragment = isRecord(parts.fragments) ? parts.fragments[name] : undefined;
  const conditions = isRecord(fragment) && isRecord(fragment.conditions) ? fragment.conditions : {};
  const include = isRecord(conditions.include) ? conditions.include : {};
  const exclude = isRecord(conditions.exclude) ? conditions.exclude : {};
  const isAll = (rule: unknown): boolean => isRecord(rule) && rule.all === "true";
  const keyed = (rule: unknown): boolean =>
    isRecord(rule) && FRAGMENT_CONDITION_KEYS.some((k) => list(rule[k]).length > 0);
  const always: string[] = [];
  const conditional: string[] = [];
  for (const [slug, rule] of Object.entries(include)) {
    const r = isRecord(rule) ? rule : {};
    const mode = r.includeCondition;
    if (mode !== "and" && mode !== "or") continue;
    const out = exclude[slug];
    const excludedByPage = keyed(out);
    if (isAll(out) && !(isRecord(out) && out.excludeCondition === "and" && excludedByPage))
      continue;
    let shown: "always" | "page" | undefined;
    if (mode === "or") shown = isAll(r) ? "always" : keyed(r) ? "page" : undefined;
    else shown = keyed(r) ? "page" : isAll(r) ? "always" : undefined;
    if (shown === undefined) continue;
    // `$conditions->exclude->$templater` has to exist: a part with no exclude entry is never printed.
    if (!isRecord(out)) {
      skipped?.(slug);
      continue;
    }
    if (shown === "always" && excludedByPage) shown = "page";
    if (shown === "always") always.push(slug);
    else if (shown === "page") conditional.push(slug);
  }
  return { always, conditional };
}

/** The instances of the parts a global fragment prints on every page, with what could not be placed said. */
function fragmentNodes(env: Env, name: "globalheader" | "globalfooter"): JxNode[] {
  const where = "option:cwicly_global_parts";
  const { always, conditional } = fragmentParts(env.site, name, (slug) => {
    env.report.add({
      severity: "info",
      code: "template.rule-no-exclude",
      message: `The global fragment ${name} matches the part "${slug}" with its include rule but has no exclude entry for it, and Cwicly never prints a part without one.`,
      where,
      data: { fragment: name, part: slug },
    });
  });
  for (const slug of conditional) {
    env.report.add({
      severity: "warn",
      code: "template.fragment-conditional",
      message: `The global fragment ${name} prints the part "${slug}" only where its display conditions say so, which the one base layout cannot decide: the part is left out.`,
      where,
      data: { fragment: name, part: slug },
    });
  }
  const nodes: JxNode[] = [];
  for (const slug of always) {
    if (!inventoryOf(env.site).parts.has(slug)) {
      env.report.add({
        severity: "error",
        code: "template.part-missing",
        message: `The global fragment ${name} names the part "${slug}", which is not a published part of the active theme; nothing is printed for it.`,
        where,
        data: { fragment: name, part: slug },
      });
      continue;
    }
    nodes.push({ tagName: partTag(env.site, slug) });
  }
  return nodes;
}

function baseLayout(env: Env): string {
  const where = "option:cwicly_custom_code";
  const html = (markup: string): JxNode[] =>
    markup.trim() === ""
      ? []
      : htmlToNodes(markup, {
          report: env.report,
          where,
          // A snippet is the site owner's markup: its inline styles stay inline, where they win as they did.
          inlineStyle: "attribute",
        });
  const open = html(env.customCode.bodyOpen);
  const foot = html(env.customCode.footer);
  const children: JxNode[] = [
    ...open,
    ...fragmentNodes(env, "globalheader"),
    { tagName: "div", className: "wp-site-blocks", children: [{ tagName: "slot" }] },
    ...fragmentNodes(env, "globalfooter"),
    ...foot,
  ];
  const elements = elementsFor(env, children, BASE_LAYOUT_FILE);
  account(env, children);
  return json({ ...(elements.length > 0 ? { $elements: elements } : {}), children });
}

/** What a layout's data needs from the page's own post that `emit/pages.ts` does not write under `state.entry`. */
function entryKeysUsed(nodes: readonly JxNode[]): string[] {
  const keys = new Set<string>();
  const text = JSON.stringify(nodes);
  for (const m of text.matchAll(
    /state\.entry\.data(?:\.([A-Za-z_$][\w$]*)|\[\\?"([^"\\]+)\\?"\])/g,
  )) {
    keys.add(m[1] ?? m[2]!);
  }
  return [...keys].filter((key) => !PAGE_ENTRY_KEYS.includes(key)).sort();
}

interface LayoutBuilt {
  slug: string;
  flavor: "slotted" | "frame";
  file: string;
  content: string;
}

/** The layout of a template that serves pages: the whole template, the page's body where the content block was. */
async function slottedLayout(env: Env, slug: string): Promise<LayoutBuilt> {
  const where = `template:${env.site.model.site.theme}//${slug}`;
  const converted = await convertOnce(
    env,
    { kind: "template", slug },
    { mode: "entry", entryExpr: "state.entry", entryType: "page", target: "page" },
  );
  const slotted = slotContent(converted.nodes);
  let nodes = slotted.nodes;
  if (slotted.found === 0) {
    // A page template with no content block prints nothing of the page: the slot goes where the body would be.
    const cut = splitChrome(env.site, nodes);
    nodes = [...cut.prefix, ...cut.body, { tagName: "slot" }, ...cut.suffix];
    env.report.add({
      severity: "warn",
      code: "template.no-content-slot",
      message: `The template ${slug} has no content block, so WordPress prints none of a page's content with it; the layout's slot is put after the template's own blocks so the page's content is not lost.`,
      where,
      data: { template: slug },
    });
  } else if (slotted.found > 1) {
    env.report.add({
      severity: "warn",
      code: "template.content-slot-extra",
      message: `The template ${slug} has ${slotted.found} content blocks; a layout has one slot, so the first holds it and the others are empty.`,
      where,
      data: { template: slug, found: slotted.found },
    });
  }
  const missing = entryKeysUsed(nodes);
  if (missing.length > 0) {
    env.report.add({
      severity: "warn",
      code: "template.entry-data-missing",
      message: `The layout of ${slug} reads ${missing.map((k) => `state.entry.data.${k}`).join(", ")}, which the page's own entry state does not hold (it carries ${PAGE_ENTRY_KEYS.join(", ")}); those bindings print nothing.`,
      where,
      data: { template: slug, keys: missing },
    });
  }
  const file = layoutPathOf(env.site, slug, "slotted").replace(/^\.\//, "");
  const { removeTitle } = breadcrumbSettings(env.site);
  const hasPageParents = [...env.site.model.posts.values()].some(
    (post) => post.type === "page" && post.status === "publish" && post.parent !== 0,
  );
  const resolved = replacePlaceholders(
    nodes,
    resolversFor(env, where, {
      slot: true,
      // A page's trail is its title, which `breadcrumbs_remove_post_title` takes off (and the home crumb links).
      crumbs: removeTitle ? [] : [{ expr: "state.entry.data.title ?? ''" }],
      ...(removeTitle ? { crumbsLinkLast: true } : {}),
      crumbNotes: hasPageParents ? ["the page's ancestors"] : [],
    }),
    { report: env.report, where },
  );
  env.used.hoisted.push(...converted.hoisted);
  const doc: Record<string, unknown> = { $layout: BASE_LAYOUT };
  const elements = elementsFor(env, resolved, file);
  if (elements.length > 0) doc.$elements = elements;
  if (Object.keys(converted.state).length > 0) doc.state = converted.state;
  doc.children = resolved;
  account(env, resolved, converted.used.states);
  return { slug, flavor: "slotted", file, content: json(doc) };
}

/** The chrome-only layout of a template: its header and footer around one slot. */
function frameLayout(env: Env, slug: string, cut: ChromeSplit): LayoutBuilt {
  const where = `template:${env.site.model.site.theme}//${slug}`;
  const file = layoutPathOf(env.site, slug, "frame").replace(/^\.\//, "");
  if (cut.unsplit !== undefined) {
    env.report.add({
      severity: "info",
      code: "template.chrome-unsplit",
      message: `The template ${slug} could not be cut into header, body and footer (${cut.unsplit}); its layout is only the slot and the whole template is the page's body.`,
      where,
      data: { template: slug, reason: cut.unsplit },
    });
  }
  const children = replacePlaceholders(
    [...copyNodes(cut.prefix), { tagName: "slot" }, ...copyNodes(cut.suffix)],
    resolversFor(env, where),
    { report: env.report, where },
  );
  const doc: Record<string, unknown> = { $layout: BASE_LAYOUT };
  const elements = elementsFor(env, children, file);
  if (elements.length > 0) doc.$elements = elements;
  doc.children = children;
  account(env, children);
  return { slug, flavor: "frame", file, content: json(doc) };
}

// ── Pages ────────────────────────────────────────────────────────────────────────────────────────

/** The `$src` of a `ContentEntry`: the parser extension's class, which `jx validate` wants named. */
const ENTRY_SRC = "@jxsuite/parser/ContentEntry.class.json";

type HeadMeta = { tagName: string; attributes: Record<string, string> };

/** The conversion options a page of a kind needs. */
function conversionOptions(page: PlannedPage): SubjectOptions {
  switch (page.kind) {
    case "entry":
      return {
        mode: "entry",
        entryExpr: "state.entry",
        ...(page.type === undefined ? {} : { entryType: page.type }),
        target: "page",
      };
    case "term":
      return { mode: "static", termExpr: "state.term", target: "page" };
    case "author":
      return { mode: "entry", entryExpr: "state.author", target: "page" };
    case "archive":
      return {
        mode: "static",
        ...(page.type === undefined ? {} : { entryType: page.type }),
        target: "page",
      };
    default:
      return { mode: "static", target: "page" };
  }
}

/** The page's own `style` and the rules that have no spelling in one, reported the way `emit/pages.ts` does. */
function pageStyle(
  env: Env,
  converted: Converted,
  where: string,
): Record<string, unknown> | undefined {
  const placed = hoistedStyle(dedupeRules(converted.hoisted));
  for (const rule of placed.unplaced) {
    env.report.add({
      severity: "info",
      code: "template.hoisted-unplaced",
      message: `The rule ${rule.selector} is about the document itself, which a page's own style cannot reach; it is returned in used.documentRules for the project's style.`,
      where,
      data: { selector: rule.selector },
    });
  }
  env.used.documentRules.push(...placed.unplaced);
  for (const key of placed.collisions) {
    env.report.add({
      severity: "warn",
      code: "template.hoisted-collision",
      message: `Two rules define ${key} differently and an at-rule has one definition; the later one is kept.`,
      where,
      data: { key },
    });
  }
  env.used.hoisted.push(...converted.hoisted.filter((rule) => !placed.unplaced.includes(rule)));
  return Object.keys(placed.style).length > 0
    ? (placed.style as Record<string, unknown>)
    : undefined;
}

/** Everything a page holds, in the order a Jx page document keeps it. */
interface PageDoc {
  $paths?: unknown;
  title: string;
  layout: string;
  sitemap?: false;
  head?: HeadMeta[];
  elements?: { $ref: string }[];
  state?: Record<string, unknown>;
  style?: Record<string, unknown>;
  children: JxNode[];
}

/** A string that is one binding and nothing else. */
const WHOLE_BINDING = /^\$\{[\s\S]*\}$/;

/**
 * The trees with every string child that is a whole `${…}` expression replaced by a plain string: that
 * is the form that evaluates in `children` (docs/bindings.md, [K2]: the computed list of a query), where
 * `misplacedBindings` would count it with the text children that never do ([K1]).
 */
export function wholeBindingsAside(nodes: readonly JxNode[]): JxNode[] {
  const copy = copyNodes(nodes);
  for (const element of walkElements(copy)) {
    if (!Array.isArray(element.children)) continue;
    element.children = element.children.map((child) =>
      typeof child === "string" && WHOLE_BINDING.test(child) ? "(binding)" : child,
    );
  }
  return copy;
}

function pageContent(env: Env, parts: PageDoc, where: string): string {
  const doc: Record<string, unknown> = {};
  if (parts.$paths !== undefined) doc.$paths = parts.$paths;
  doc.title = parts.title;
  doc.$layout = parts.layout;
  if (parts.sitemap === false) doc.$sitemap = false;
  if (parts.head && parts.head.length > 0) doc.$head = parts.head;
  if (parts.elements && parts.elements.length > 0) doc.$elements = parts.elements;
  if (parts.state && Object.keys(parts.state).length > 0) doc.state = parts.state;
  if (parts.style) doc.style = parts.style;
  doc.children = parts.children;
  // The title and `$head` of an entry or term page hold bindings on purpose (docs/bindings.md, [P1]): only the body is checked.
  for (const bad of misplacedBindings({
    children: wholeBindingsAside(parts.children),
  } as unknown as JxDocument)) {
    env.report.add({
      severity: "error",
      code: "template.binding-misplaced",
      message: `A \${…} sits in ${bad.position} (${bad.path || "page"}), where the build never evaluates it.`,
      where,
      data: { ...bad },
    });
  }
  return json(doc);
}

/** A string for a binding's literal part: the characters that would end or open a template are escaped. */
const jsLiteral = (value: string): string =>
  JSON.stringify(value)
    .slice(1, -1)
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${");

/** `https://site` + a path binding, as one template string: the build evaluates it, a literal part is escaped. */
const absolute = (siteUrl: string, expr: string): string =>
  `${jsLiteral(siteUrl)}\${${expr} ?? ''}`;

/** What a dynamic page's data can print in its head: a tag no route can fill is left out, because `$head` has no way to omit one. */
export interface HeadHas {
  description: boolean;
  robots: boolean;
  image: boolean;
}

/**
 * The `<head>` of a page that renders an entry or a term, with bindings: the description, the robots
 * meta, the canonical and Open Graph tags from the entry's `seo` (Rank Math's answer, written by the
 * collections module) and the entry's own address. The constants (the locale, the site name, the card, the
 * handle) come from what Rank Math printed for a sample page of the same kind.
 *
 * `$head` has no way to leave an attribute out: a value of `false` prints the word (`content="false"`,
 * measured), and unlike an element's `attributes` there is no omission. So a value a route does not have
 * is the empty string, which is inert in a description, a robots meta and the image tags, and a tag that NO
 * route of the page can fill is not written at all (`has` says which: a term and an author have no
 * image). `ogType` is Rank Math's `og:type` of the kind (`article` for an entry and a term, `profile`
 * for an author).
 */
export function boundHead(
  data: string,
  siteUrl: string,
  sample: Seo | undefined,
  ogType: string,
  has: Partial<HeadHas> = {},
): HeadMeta[] {
  const present: HeadHas = { description: true, robots: true, image: true, ...has };
  const out: HeadMeta[] = [];
  const meta = (key: "name" | "property", name: string, content: string): void =>
    void out.push({ tagName: "meta", attributes: { [key]: name, content } });
  const bound = (expr: string): string => `\${${expr} ?? ''}`;
  const seo = `${data}.seo`;
  const title = `${seo}?.title || ${data}.title || ${data}.name || ''`;
  const description = `${seo}?.description`;
  const image = `(s => s ? (/^(?:[a-z][a-z0-9+.-]*:|\\/\\/)/i.test(s) ? s : ${JSON.stringify(siteUrl.replace(/\/+$/, ""))} + s) : '')(${seo}?.image?.src)`;
  if (present.description) meta("name", "description", bound(description));
  if (present.robots) meta("name", "robots", bound(`${seo}?.robots`));
  // Rank Math prints no canonical on a noindex page, but Jx prints one on every page that has none of its
  // own (without the trailing slash WordPress addresses have), so ours says the right address.
  out.push({
    tagName: "link",
    attributes: { rel: "canonical", href: absolute(siteUrl, `${data}.url`) },
  });
  if (sample?.openGraph.locale) meta("property", "og:locale", sample.openGraph.locale);
  meta("property", "og:type", ogType);
  meta("property", "og:title", `\${${title}}`);
  if (present.description) meta("property", "og:description", bound(description));
  meta("property", "og:url", absolute(siteUrl, `${data}.url`));
  if (sample?.openGraph.siteName) meta("property", "og:site_name", sample.openGraph.siteName);
  if (present.image) {
    meta("property", "og:image", `\${${image}}`);
    meta("property", "og:image:width", bound(`${seo}?.image?.width`));
    meta("property", "og:image:height", bound(`${seo}?.image?.height`));
    meta("property", "og:image:alt", bound(`${seo}?.image?.alt`));
  }
  if (sample?.twitter.card) meta("name", "twitter:card", sample.twitter.card);
  meta("name", "twitter:title", `\${${title}}`);
  if (present.description) meta("name", "twitter:description", bound(description));
  if (present.image) meta("name", "twitter:image", `\${${image}}`);
  if (sample?.twitter.site) meta("name", "twitter:site", sample.twitter.site);
  return out;
}

/** The title binding of a page that renders an entry or a term. */
export const boundTitle = (data: string): string =>
  `\${${data}.seo?.title || ${data}.title || ${data}.name || ''}`;

/** The static `<head>` of a page Rank Math has an answer for (the posts page, an archive). */
function staticHead(
  env: Env,
  seo: Seo,
  route: string,
  where: string,
): { title: string; head: HeadMeta[] } {
  let literal = false;
  const text = (value: string): string => {
    if (value.includes("${")) literal = true;
    return literalText(value);
  };
  const head = headEntries(seo, {
    siteUrl: env.siteUrl,
    mediaForUrl: (address) => env.site.media.mediaForUrl(address),
    mediaFor: (id) => env.site.media.mediaFor(id),
    text,
    self: `${env.siteUrl}${route}`,
    address: (address) => env.site.urls.rewriteUrl(address),
    unresolvedImage: (image) =>
      env.report.add({
        severity: "warn",
        code: "template.og-image-unresolved",
        message: `The social image (attachment ${String(image.id)}, ${image.url}) is not in the media plan, so the live address is kept.`,
        where,
        data: { id: image.id, address: image.url },
      }),
  });
  const title = text(seo.title);
  if (literal) {
    env.report.add({
      severity: "warn",
      code: "template.literal-template",
      message:
        "A literal dollar-brace in the title or head would be read as a binding; it is written with a zero-width space between the two characters.",
      where,
    });
  }
  return { title, head };
}

/**
 * The title Rank Math gives a page that has no object behind it: the option template of the 404 page,
 * rendered (`Page Not Found - Fine Line Painting`); the search page has no query at build time, so its title
 * is `Search` with the site's separator and name. Without Rank Math's option the defaults stand.
 */
function optionTitle(env: Env, key: "404_title" | "search", fallback: string): string {
  const { model } = env.site;
  const raw = model.options.get("rank-math-options-titles");
  const siteName = decodeEntities(model.site.name);
  const stored = raw === undefined ? undefined : maybeUnserialize(raw);
  const options = isRecord(stored) ? stored : {};
  const sep = typeof options.title_separator === "string" ? options.title_separator : "-";
  const own = key === "404_title" ? options["404_title"] : undefined;
  const template = typeof own === "string" && own !== "" ? own : fallback;
  const title = renderRankMathTemplate(template, { sep, sitename: siteName, page: "" });
  return title.trim() === "" ? siteName : title;
}

// ── Terms and authors as data ────────────────────────────────────────────────────────────────────

/** What the `$paths` value of a route is: its address below the dynamic page's own directory. */
function pathValue(route: Route, page: PlannedPage): string {
  const dir = dirOf(page.file).replace(/^pages\/?/, "");
  const base = dir === "" ? "/" : `/${dir}/`;
  const route0 = route.jxRoute;
  return (route0.startsWith(base) ? route0.slice(base.length) : route0.replace(/^\/+/, "")).replace(
    /\/+$/,
    "",
  );
}

/** Every string of a value through `literalText`: data is bound into templates, and a literal dollar-brace must not be read as one. */
function degrade(value: unknown, hit: () => void): unknown {
  if (typeof value === "string") {
    if (value.includes("${")) hit();
    return literalText(value);
  }
  if (Array.isArray(value)) return value.map((item) => degrade(item, hit));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, degrade(v, hit)]));
  }
  return value;
}

/** Keys in order, so the same site writes the same bytes. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sorted(value[k])]),
    );
  }
  return value;
}

interface DataSet {
  /** The collection name `ContentEntry.contentType` names. */
  name: string;
  def: TermCollectionDef;
  files: TemplateFile[];
  /** What the head of the page can print for at least one of its routes. */
  has: HeadHas;
}

/** What at least one of the `seo` values holds: a head tag that no route fills is not written (see {@link boundHead}). */
function headHas(seos: readonly unknown[]): HeadHas {
  const records = seos.filter(isRecord);
  const robotsOf = (seo: Record<string, unknown>): string =>
    typeof seo.robots === "string" ? seo.robots : "";
  return {
    description: records.some(
      (seo) => typeof seo.description === "string" && seo.description !== "",
    ),
    robots: records.some((seo) => robotsOf(seo) !== ""),
    image: records.some(
      (seo) => isRecord(seo.image) && typeof seo.image.src === "string" && seo.image.src !== "",
    ),
  };
}

const TERM_SCHEMA: TermCollectionDef["schema"] = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    slug: { type: "string" },
    description: { type: "string" },
    taxonomy: { type: "string" },
    url: { type: "string", format: "uri-reference" },
    seo: { type: "object" },
  },
  required: ["id", "name", "slug", "taxonomy"],
};

const AUTHOR_SCHEMA: TermCollectionDef["schema"] = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    title: { type: "string" },
    slug: { type: "string" },
    author: { type: "string" },
    authorUrl: { type: "string", format: "uri-reference" },
    url: { type: "string", format: "uri-reference" },
    seo: { type: "object" },
  },
  required: ["id", "name", "slug"],
};

/**
 * A subject whose context reads a term's data (the ACF term fields print the same through any): the first
 * template, else the first part, else the first post. A site with no template at all still has terms.
 */
function sampleOf(site: Pick<SiteContext, "model">): Subject | undefined {
  const inv = inventoryOf(site);
  const template = inv.templates.keys().next().value as string | undefined;
  if (template !== undefined) return { kind: "template", slug: template };
  const part = inv.parts.keys().next().value as string | undefined;
  if (part !== undefined) return { kind: "part", slug: part };
  const post = site.model.posts.values().next().value as WpPost | undefined;
  return post === undefined ? undefined : { kind: "post", id: post.id };
}

/** The JSON collection of a taxonomy's terms or of the authors a dynamic page renders. */
async function dataSet(
  env: Env,
  page: PlannedPage,
  name: string,
  now: Date,
): Promise<DataSet | undefined> {
  const dp = page.dynamic;
  if (!dp || !("values" in dp.paths)) return undefined;
  const { site } = env;
  const sampleSubject = sampleOf(site);
  const sample = sampleSubject === undefined ? undefined : await subjectCtx(site, sampleSubject);
  const scratch = createReport();
  const files: TemplateFile[] = [];
  let degraded = false;
  const wanted = new Set(dp.paths.values);
  const made = new Set<string>();
  const seos: unknown[] = [];
  for (const route of dp.routes) {
    const value = pathValue(route, page);
    if (!wanted.has(value) || made.has(value)) {
      env.report.add({
        severity: "error",
        code: "template.route-mismatch",
        message: `The route ${route.jxRoute} is not one of the $paths values of ${page.file}; its data file is not written.`,
        where: `${page.kind}:${String(route.id)}`,
        data: { route: route.jxRoute, value },
      });
      continue;
    }
    made.add(value);
    let data: Record<string, unknown>;
    if (page.kind === "term") {
      const term = site.model.terms.get(Number(route.id));
      if (!term || sample === undefined) continue;
      data = { ...(termData(sample, term) as Record<string, unknown>) };
      try {
        data.seo = toEntrySeo(
          seoFor(site.model, { kind: "term", term }, { report: scratch, now }),
          {
            attachment: (id) => site.media.mediaFor(id),
          },
        );
      } catch (error) {
        env.report.add({
          severity: "warn",
          code: "template.seo-failed",
          message: `Rank Math's SEO could not be read for the term (${error instanceof Error ? error.message : String(error)}); the term has no seo.`,
          where: `term:${term.termId}`,
        });
      }
      data.id = value;
    } else {
      const user = site.model.users.get(Number(route.id));
      if (!user) continue;
      const name0 = decodeEntities(user.displayName);
      data = {
        id: value,
        name: name0,
        title: name0,
        slug: user.slug,
        author: name0,
        url: route.jxRoute,
        authorUrl: route.jxRoute,
        seo: {
          title: authorText(env, "title", name0),
          description: authorText(env, "description", name0),
          robots: authorRobots(titleOptions(env), site.model.options.get("blog_public")),
        },
      };
    }
    seos.push(data.seo);
    const clean = sorted(
      degrade(data, () => {
        degraded = true;
      }),
    );
    files.push({ path: `content/${name}/${value}.json`, content: json(clean) });
  }
  if (degraded) {
    env.report.add({
      severity: "warn",
      code: "template.literal-template",
      message: `A literal dollar-brace in the data of ${page.file} would be read as a binding; it is written with a zero-width space between the two characters.`,
      where: page.file,
    });
  }
  return {
    name,
    def: {
      source: `content/${name}`,
      format: "json",
      schema: page.kind === "term" ? TERM_SCHEMA : AUTHOR_SCHEMA,
    },
    files,
    has: headHas(seos),
  };
}

/** `rank-math-options-titles`, unserialised; empty when the site has none. */
function titleOptions(env: Pick<Env, "site">): Record<string, unknown> {
  const raw = env.site.model.options.get("rank-math-options-titles");
  const stored = raw === undefined ? undefined : maybeUnserialize(raw);
  return isRecord(stored) ? stored : {};
}

/** A Rank Math switch (`on`, `true`, `1`: what `Settings::normalize_it` turns into a truthy value). */
const onSetting = (value: unknown): boolean =>
  value === true || value === "on" || value === "true" || value === 1 || value === "1";

/** Rank Math's `author_archive_title` and `author_archive_description`, rendered for one author. */
function authorText(env: Env, key: "title" | "description", name: string): string {
  const options = titleOptions(env);
  const sep = typeof options.title_separator === "string" ? options.title_separator : "-";
  const own = options[`author_archive_${key}`];
  const template =
    typeof own === "string" && own !== ""
      ? own
      : key === "title"
        ? "%name% %sep% %sitename% %page%"
        : "";
  if (template === "") return "";
  const siteName = decodeEntities(env.site.model.site.name);
  // The empty `%page%` of an unpaged archive leaves a gap and a trailing space the live title does not have.
  return renderRankMathTemplate(template, { name, sep, sitename: siteName, page: "" })
    .replace(/\s+/g, " ")
    .trim();
}

type Pair = [string, string];

/** Rank Math's `Paper::robots_combine()` over a list of directives. */
function robotPairs(value: unknown, withDefault = false): Pair[] {
  const items = Array.isArray(value) ? value.map(String) : [];
  if (items.length === 0)
    return withDefault
      ? [
          ["index", "index"],
          ["follow", "follow"],
        ]
      : [];
  let pairs: Pair[] = [...new Set(items)].map((item): Pair => [item, item]);
  for (const [word, key] of [
    ["noindex", "index"],
    ["nofollow", "follow"],
  ] as const) {
    if (pairs.some(([k]) => k === word)) {
      pairs = [[key, word], ...pairs.filter(([k]) => k !== word && k !== key)];
    }
  }
  return pairs;
}

/** Rank Math's `Paper::advanced_robots_combine()`: null for no answer, else the directives that are set. */
function advancedPairs(value: unknown): Pair[] | null {
  if (!isRecord(value) || Object.keys(value).length === 0) return null;
  return Object.entries(value)
    .filter(([, data]) => truthy(data))
    .map(([key, data]): Pair => [key, `${key}:${String(data)}`]);
}

/**
 * The robots meta of an author archive as Rank Math prints it (`Paper\Author::robots` and the
 * `Paper::get_robots` that finishes it): the author's own setting when `author_custom_robots` is on, else the
 * site's, `index` and `follow` always present, the advanced directives unless the page is noindex. The
 * export has no user meta, so a person's own robots setting cannot be carried.
 */
export function authorRobots(options: Record<string, unknown>, blogPublic?: string): string {
  const custom = onSetting(options.author_custom_robots);
  let robots = custom ? robotPairs(options.author_robots, true) : [];
  if (robots.length === 0) robots = robotPairs(options.robots_global);
  const get = (key: string): string | undefined => robots.find(([k]) => k === key)?.[1];
  const first = (key: string, value: string): void => {
    robots = [[key, value], ...robots.filter(([k]) => k !== key)];
  };
  if (robots.length === 0) {
    robots = [
      ["index", "index"],
      ["follow", "follow"],
    ];
  } else {
    robots = robots.filter(([k]) =>
      ["index", "follow", "noarchive", "noimageindex", "nosnippet"].includes(k),
    );
    if (get("index") === undefined) first("index", "index");
    if (get("follow") === undefined) first("follow", "follow");
  }
  if (blogPublic !== undefined && Number(blogPublic) === 0) {
    robots = robots.map(([k, v]): Pair =>
      k === "index" ? [k, "noindex"] : k === "follow" ? [k, "nofollow"] : [k, v],
    );
  }
  if (get("index") !== "noindex" && get("nosnippet") !== "nosnippet") {
    let advanced = custom ? advancedPairs(options.author_advanced_robots) : null;
    if (advanced === null) {
      const global = isRecord(options.advanced_robots_global) ? options.advanced_robots_global : {};
      advanced = advancedPairs({
        "max-snippet": -1,
        "max-video-preview": -1,
        "max-image-preview": "large",
        ...global,
      })!;
    }
    const wanted = ["max-snippet", "max-video-preview", "max-image-preview"];
    robots = [...robots, ...advanced.filter(([k]) => wanted.includes(k))];
  }
  return robots.map(([, v]) => v).join(", ");
}

// ── The body of a page ───────────────────────────────────────────────────────────────────────────

/** One page written, with what it is for. */
interface BodyBuilt {
  info: TemplatePageInfo;
  content: string;
}

/** The notice a search page shows where WordPress's results were: the server's search has no static form. */
const SEARCH_NOTICE: JxElement = {
  tagName: "p",
  className: "wp2jx-unconverted wp2jx-search",
  attributes: { "data-wp2jx": "search" },
  textContent: "Search is not available on this copy of the site.",
};

/** Whether a serialised value reads the state entry `key`: `state.key` in an expression or `#/state/key` as a pointer. */
const readsState = (text: string, key: string): boolean => {
  const name = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$.])state\\.${name}(?![\\w$])|#/state/${name}(?![\\w$-])`).test(text);
};

/** The dead "load more" link of a results list: Cwicly's own class and id for it (a query's `queryloadmore` action). */
const isLoadMore = (node: JxNode): boolean =>
  typeof node !== "string" &&
  ((node.attributes as Record<string, unknown> | undefined)?.id === "load-more-button" ||
    (typeof node.className === "string" &&
      node.className.split(/\s+/).includes("load-more-button")));

/**
 * The results of a search template are a query WordPress runs per request. Its conversion lists every
 * entry (the search term is a URL parameter a static page cannot read), which is a list of the whole
 * site where a result list belongs: every loop over a collection the conversion registered is replaced by
 * a visible notice, and the state it read is dropped. What else reads that state goes with it: a state
 * entry that no longer exists is a binding that throws in the browser (and ships the client runtime for
 * it), and a paragraph that says "No results found" beside a notice that says search is not here is two
 * answers to one question. The results list's own "Load more" link has nothing left to load. Returns
 * what was replaced, the state dropped and how many nodes were removed.
 */
export function withoutResults(
  nodes: JxNode[],
  state: Record<string, unknown>,
): { nodes: JxNode[]; replaced: number; dropped: string[]; removed: number } {
  let replaced = 0;
  let removed = 0;
  const dropped = new Set<string>();
  /** The state key a mapped array points at, when it is one the conversion registered. */
  const registered = (value: unknown): string | undefined => {
    if (!isRecord(value) || value.$prototype !== "Array" || !isRecord(value.items))
      return undefined;
    const ref = value.items.$ref;
    const key = typeof ref === "string" ? /^#\/state\/([^/]+)/.exec(ref)?.[1] : undefined;
    return key !== undefined && Object.hasOwn(state, key) ? key : undefined;
  };
  const notice = (key: string): JxNode => {
    dropped.add(key);
    replaced++;
    return structuredClone(SEARCH_NOTICE);
  };
  for (const element of walkElements(nodes)) {
    const children = element.children as unknown;
    if (Array.isArray(children)) {
      // The loop is an entry of `children` (what the data converter writes), or the whole of it.
      element.children = children.map((child) => {
        const key = registered(child);
        return key === undefined ? child : notice(key);
      }) as JxNode[];
    } else {
      const key = registered(children);
      if (key !== undefined) element.children = [notice(key)];
    }
  }
  if (replaced === 0) return { nodes, replaced, dropped: [], removed };

  const keys = [...dropped];
  /** An element whose own properties, or whose children when they are one expression, read a dropped entry. */
  const readsDropped = (element: JxElement): boolean => {
    const { children, ...own } = element;
    const text = JSON.stringify(Array.isArray(children) ? own : { ...own, children });
    return keys.some((key) => readsState(text, key));
  };
  const prune = (list: JxNode[]): JxNode[] => {
    const kept: JxNode[] = [];
    for (const node of list) {
      if (typeof node === "string") {
        kept.push(node);
        continue;
      }
      if (readsDropped(node) || isLoadMore(node)) {
        removed++;
        continue;
      }
      if (Array.isArray(node.children)) {
        const before = node.children.length;
        node.children = prune(node.children);
        // A box that held only what was removed is removed with it.
        if (before > 0 && node.children.length === 0) {
          removed++;
          continue;
        }
      }
      kept.push(node);
    }
    return kept;
  };
  return { nodes: prune(nodes), replaced, dropped: keys, removed };
}

/**
 * `state` with the page's own data entry under `key`, first. A conversion that registered the same key
 * (nothing does today) loses to it, and says so: the bindings of the template read the data.
 */
function withDataState(
  env: Env,
  state: Record<string, unknown>,
  key: string,
  entry: Record<string, unknown>,
  where: string,
): Record<string, unknown> {
  if (Object.hasOwn(state, key)) {
    env.report.add({
      severity: "warn",
      code: "template.state-taken",
      message: `A conversion registered the state entry "${key}" itself, so the page's own data is written under that name and the conversion's entry is dropped.`,
      where,
      data: { key },
    });
  }
  const { [key]: _taken, ...rest } = state;
  return { [key]: entry, ...rest };
}

/** The ContentEntry state of the data a dynamic page reads (`entry`, `term`, `author`). */
const entryState = (contentType: string, param: string): Record<string, unknown> => ({
  $prototype: "ContentEntry",
  contentType,
  id: { $ref: `#/$params/${param}` },
  $src: ENTRY_SRC,
  timing: "compiler",
});

/** A static page's `$head` robots entry: Rank Math prints `noindex` on a 404 and on search results. */
const NOINDEX: HeadMeta = {
  tagName: "meta",
  attributes: { name: "robots", content: "noindex, follow" },
};

interface BodyInput {
  env: Env;
  page: PlannedPage;
  /** The template group the page renders (the one of most routes). */
  group: UseGroup;
  /** The data collection a term or author page reads. */
  data?: DataSet;
  frames: Map<string, ChromeSplit>;
  now: Date;
}

/** The layout, the nodes and the findings of a page whose template cannot be found at all. */
const FALLBACK_LAYOUT = "fallback";

function fallbackNodes(page: PlannedPage): { state: Record<string, unknown>; children: JxNode[] } {
  switch (page.kind) {
    case "entry":
      return {
        state: {},
        children: [
          {
            tagName: "article",
            children: [
              { tagName: "h1", textContent: "${state.entry.data.title ?? ''}" },
              {
                tagName: "div",
                children: "${state.entry.$children ?? []}" as unknown as JxNode[],
              },
            ],
          },
        ],
      };
    case "term":
      return {
        state: {},
        children: [{ tagName: "h1", textContent: "${state.term.data.name ?? ''}" }],
      };
    case "author":
      return {
        state: {},
        children: [{ tagName: "h1", textContent: "${state.author.data.name ?? ''}" }],
      };
    case "404":
      return { state: {}, children: [{ tagName: "h1", textContent: "Page not found" }] };
    case "search":
      return {
        state: {},
        children: [{ tagName: "h1", textContent: "Search" }, structuredClone(SEARCH_NOTICE)],
      };
    default: {
      const type = page.type ?? "post";
      return {
        state: {
          list: {
            $prototype: "ContentCollection",
            $src: "@jxsuite/parser/ContentCollection.class.json",
            contentType: type,
            sort: [{ field: "date", order: "desc" }],
            timing: "compiler",
          },
        },
        children: [
          { tagName: "h1", textContent: type === "post" ? "Posts" : type },
          {
            tagName: "ul",
            children: {
              $prototype: "Array",
              items: { $ref: "#/state/list" },
              map: {
                tagName: "li",
                children: [
                  {
                    tagName: "a",
                    attributes: { href: "${$map.item.data.url ?? ''}" },
                    textContent: "${$map.item.data.title ?? ''}",
                  },
                ],
              },
            },
          } as unknown as JxNode,
        ],
      };
    }
  }
}

/** The Jx route of a post type's archive, or of the posts page, when the route table has one. */
const routeOf = (
  site: Partial<Pick<SiteContext, "routes">>,
  kind: "post-archive" | "posts-page",
  id?: string,
): string | undefined =>
  site.routes?.all().find((r) => r.kind === kind && (id === undefined || String(r.id) === id))
    ?.jxRoute;

/** The crumb of the posts page, which Rank Math adds to a post's and a category's or tag's trail when `breadcrumbs_blog_page` is on. */
function blogCrumb(
  site: Pick<SiteContext, "model"> & Partial<Pick<SiteContext, "routes">>,
  settings: BreadcrumbSettings,
): Crumb[] {
  const { model } = site;
  const posts = model.posts.get(model.site.pageForPosts);
  if (!settings.showBlog || model.site.showOnFront !== "page" || posts === undefined) return [];
  const href = routeOf(site, "posts-page");
  return [
    { text: texturize(decodeEntities(posts.title)), ...(href === undefined ? {} : { href }) },
  ];
}

/**
 * What `[rank_math_breadcrumb]` prints on a page of a kind (see {@link breadcrumbNode}); undefined where
 * there is no trail. `Breadcrumbs::add_crumbs_*` are the rules: an entry of a post type with an archive has
 * the archive's crumb (`labels->name`, linked) before its own title; a term of a custom taxonomy has the
 * taxonomy's `labels->name` (not its singular) unless `breadcrumbs_hide_taxonomy_name` says not; an author
 * has the archive format with `%s` replaced by the name (a format with no `%s` prints as it is).
 */
export function crumbsFor(
  site: Pick<SiteContext, "model" | "acf"> & Partial<Pick<SiteContext, "routes">>,
  page: Pick<PlannedPage, "kind" | "type" | "route">,
): Crumb[] | undefined {
  const settings = breadcrumbSettings(site);
  switch (page.kind) {
    case "entry": {
      const type = page.type === undefined ? undefined : site.acf.postTypes.get(page.type);
      const archive =
        type !== undefined && page.type !== "post" && type.hasArchive !== false
          ? [
              {
                text: decodeEntities(type.labels.name ?? type.plural),
                ...(routeOf(site, "post-archive", page.type) === undefined
                  ? {}
                  : { href: routeOf(site, "post-archive", page.type)! }),
              },
            ]
          : [];
      const blog = page.type === "post" ? blogCrumb(site, settings) : [];
      const title: Crumb = { expr: "state.entry.data.title ?? ''" };
      return [...archive, ...blog, ...(settings.removeTitle ? [] : [title])];
    }
    case "term": {
      const taxonomy = page.type === undefined ? undefined : site.acf.taxonomies.get(page.type);
      const name: Crumb = { expr: "state.term.data.name ?? ''" };
      if (page.type === "category" || page.type === "post_tag") {
        return [...blogCrumb(site, settings), name];
      }
      if (taxonomy === undefined || settings.hideTaxName) return [name];
      return [{ text: decodeEntities(taxonomy.labels.name ?? taxonomy.plural) }, name];
    }
    case "posts": {
      const posts = site.model.posts.get(site.model.site.pageForPosts);
      return posts && page.route !== "/" ? [{ text: texturize(decodeEntities(posts.title)) }] : [];
    }
    case "archive": {
      const type = page.type === undefined ? undefined : site.acf.postTypes.get(page.type);
      return type ? [{ text: decodeEntities(type.labels.name ?? type.plural) }] : [];
    }
    case "author": {
      // `preg_replace('/%s(?=\s|%|$)/', $name, $format)`: the name is the crumb's, a format with no `%s` is all it says.
      const parts = settings.archiveFormat.split(/%s(?=\s|%|$)/);
      const name = "(state.author.data.name ?? '')";
      const expr = parts.map((part) => jsString(part)).join(` + ${name} + `);
      return [{ expr }];
    }
    default:
      return undefined;
  }
}

/**
 * What Rank Math's trail has on a page that depends on the entry or the term and so cannot be one static
 * trail for every route of the page: a post's ancestors and primary term, a term's ancestors, a custom
 * breadcrumb title. Each is said once per page when the shortcode prints (`template.breadcrumb-approximated`).
 */
export function breadcrumbNotes(
  site: Pick<SiteContext, "model" | "acf">,
  page: Pick<PlannedPage, "kind" | "type" | "routes">,
): string[] {
  const notes: string[] = [];
  const settings = breadcrumbSettings(site);
  const titles = maybeUnserialize(site.model.options.get("rank-math-options-titles") ?? "");
  const options = isRecord(titles) ? titles : {};
  if (page.kind === "entry") {
    const posts = page.routes
      .map((route) => site.model.posts.get(Number(route.id)))
      .filter((post): post is WpPost => post !== undefined);
    if (posts.some((post) => post.parent !== 0)) notes.push("the entry's ancestors");
    const primary = options[`pt_${page.type ?? "post"}_primary_taxonomy`];
    if (
      typeof primary === "string" &&
      !["", "0", "off", "false"].includes(primary) &&
      posts.some((post) => post.parent === 0 && termsOf(site.model, post.id, primary).length > 0)
    ) {
      notes.push(`the entry's primary ${primary} term`);
    }
    if (
      posts.some((post) => firstMeta(site, post.id, "rank_math_breadcrumb_title") !== undefined)
    ) {
      notes.push("a custom breadcrumb title");
    }
  } else if (page.kind === "term") {
    const taxonomy = page.type === undefined ? undefined : site.acf.taxonomies.get(page.type);
    const hierarchical = page.type === "category" || taxonomy?.hierarchical === true;
    const terms = page.routes
      .map((route) => site.model.terms.get(Number(route.id)))
      .filter((term): term is WpTerm => term !== undefined);
    if (settings.showAncestors && hierarchical && terms.some((term) => term.parent !== 0)) {
      notes.push("the term's ancestors");
    }
    if (terms.some((term) => has(term.meta.rank_math_breadcrumb_title))) {
      notes.push("a custom breadcrumb title");
    }
  }
  return notes;
}

async function bodyPage(input: BodyInput): Promise<BodyBuilt> {
  const { env, page, group, data, frames, now } = input;
  const { site } = env;
  const theme = site.model.site.theme;
  const dp = page.dynamic;
  const where = `template:${theme}//${group.slug}`;
  const fallback = group.choice.post === undefined;
  const converted = fallback
    ? undefined
    : await convertOnce(env, { kind: "template", slug: group.slug }, conversionOptions(page));
  let nodes: JxNode[];
  let state: Record<string, unknown> = {};
  let layout: string;
  /** State a search page's conversion registered for a results list that was replaced by a notice. */
  let droppedStates: string[] = [];
  if (converted === undefined) {
    const made = fallbackNodes(page);
    nodes = made.children;
    state = made.state;
    layout = layoutPath(FALLBACK_LAYOUT);
    env.report.add({
      severity: "warn",
      code: "template.fallback",
      message: `The theme has no template for ${page.file} (tried ${group.choice.tried.join(", ")}); a minimal page is written so the route is not missing.`,
      where: `route:${page.route}`,
      data: { page: page.file, tried: group.choice.tried },
    });
  } else {
    const cut = splitChrome(site, converted.nodes);
    if (!frames.has(group.slug)) frames.set(group.slug, cut);
    nodes = copyNodes(cut.body);
    state = { ...converted.state };
    layout = layoutPathOf(site, group.slug, "frame");
    if (page.kind === "term") {
      // The converter says when a title wanted a prefix it could not choose (`block.archive-prefix`).
      const wanted = converted.report.entries().some((e) => e.code === "block.archive-prefix");
      const repaired = repairTermBindings(
        nodes,
        wanted && page.type !== undefined ? archiveLabel(site, page.type) : undefined,
      );
      if (repaired > 0) {
        env.report.add({
          severity: "info",
          code: "template.term-binding-repaired",
          message: `${repaired} binding${repaired === 1 ? "" : "s"} of ${group.slug} read \${state.term.name}, but a term entry holds its name under data; written \${state.term.data.name ?? ''}.`,
          where,
          data: { template: group.slug, repaired },
        });
      }
    }
    if (page.kind === "search") {
      const cut2 = withoutResults(nodes, state);
      nodes = cut2.nodes;
      for (const key of cut2.dropped) delete state[key];
      droppedStates = cut2.dropped;
      env.report.add({
        severity: "warn",
        code: "template.search",
        message:
          cut2.replaced > 0
            ? `WordPress's search runs on the server and the migrated site has none: the results list of the search template is replaced by a notice (the page would list every entry of the site otherwise)${cut2.removed > 0 ? `, and the ${cut2.removed} node${cut2.removed === 1 ? "" : "s"} that read the results or load more of them ${cut2.removed === 1 ? "is" : "are"} removed` : ""}.`
            : "WordPress's search runs on the server and the migrated site has none; the page is the template's static part.",
        where,
        data: { template: group.slug, replaced: cut2.replaced, removed: cut2.removed },
      });
    }
  }
  const pageWhere = fallback ? `route:${page.route}` : where;
  const crumbs = crumbsFor(site, page);
  const resolved = replacePlaceholders(
    nodes,
    resolversFor(env, pageWhere, {
      ...(page.kind === "archive" && page.type !== undefined ? { archiveType: page.type } : {}),
      ...(crumbs === undefined
        ? {}
        : {
            crumbs,
            crumbNotes: breadcrumbNotes(site, page),
            ...(breadcrumbSettings(site).removeTitle && page.kind === "entry"
              ? { crumbsLinkLast: true }
              : {}),
          }),
    }),
    { report: env.report, where: pageWhere },
  );

  // The data the page reads, and the head it carries.
  let title: string;
  let head: HeadMeta[] | undefined;
  let $paths: unknown;
  let sitemap: false | undefined;
  const sampleSeo = (post: WpPost | undefined): Seo | undefined => {
    if (post === undefined) return undefined;
    try {
      return seoFor(site.model, { kind: "post", post }, { report: createReport(), now });
    } catch {
      return undefined;
    }
  };
  switch (page.kind) {
    case "entry": {
      const contentType =
        dp && "contentType" in dp.paths ? dp.paths.contentType : (page.type ?? "post");
      const param = dp?.param ?? "slug";
      $paths = dp?.paths;
      state = withDataState(env, state, ENTRY_STATE_KEY, entryState(contentType, param), pageWhere);
      title = boundTitle("state.entry.data");
      const first = page.routes.map((r) => site.model.posts.get(Number(r.id))).find(Boolean);
      head = boundHead("state.entry.data", env.siteUrl, sampleSeo(first), "article");
      break;
    }
    case "term":
    case "author": {
      const key = page.kind === "term" ? "term" : "author";
      $paths = dp?.paths;
      state = withDataState(
        env,
        state,
        key,
        entryState(data?.name ?? key, dp?.param ?? "slug"),
        pageWhere,
      );
      title = boundTitle(`state.${key}.data`);
      const first = site.model.posts.values().next().value as WpPost | undefined;
      // Rank Math's og:type of a taxonomy archive is `article` (it is its paper's default) and an author's is `profile`.
      head = boundHead(
        `state.${key}.data`,
        env.siteUrl,
        sampleSeo(first),
        key === "term" ? "article" : "profile",
        data?.has ?? {},
      );
      break;
    }
    case "posts":
    case "archive": {
      const seo = seoFor(
        site.model,
        page.kind === "archive"
          ? { kind: "archive", postType: page.type ?? "post" }
          : { kind: page.route === "/" ? "home" : "posts-page" },
        { report: env.report, now },
      );
      const made = staticHead(env, seo, page.route, pageWhere);
      title = made.title;
      head = made.head;
      break;
    }
    case "404":
      title = literalText(optionTitle(env, "404_title", "Page not found %sep% %sitename%"));
      head = [NOINDEX];
      sitemap = false;
      env.report.add({
        severity: "warn",
        code: "template.404-location",
        message:
          "The 404 template is pages/404.json: the Jx dev server serves it with the status 404 for every address no page answers, but the static build writes it to /404/ and not 404.html, which is the file a static host (Cloudflare Pages, Netlify, GitHub Pages) serves for a missing address. The host has to be told to serve /404/ with a 404 (a rewrite rule), or the page copied to 404.html.",
        where: `route:${page.route}`,
        data: { file: page.file, built: "404/index.html", hostsWant: "404.html" },
      });
      break;
    default:
      title = literalText(optionTitle(env, "search", "Search %sep% %sitename%"));
      head = [NOINDEX];
      sitemap = false;
  }
  if (["posts", "archive", "term", "author", "search"].includes(page.kind)) {
    env.report.add({
      severity: "info",
      code: "template.pagination",
      message: `WordPress pages this listing (/page/2/); Jx has no pagination, so the page lists every entry its query selects, with more entries on one page than the live one has, and the live /page/N/ addresses (indexed and linked) do not exist in the migrated site: they need a redirect.`,
      where: pageWhere,
      data: { page: page.file },
    });
  }

  const style = converted === undefined ? undefined : pageStyle(env, converted, pageWhere);
  const elements = elementsFor(env, resolved, page.file);
  const states = new Set(converted?.used.states ?? []);
  for (const key of droppedStates) states.delete(key);
  const content = pageContent(
    env,
    {
      ...($paths === undefined ? {} : { $paths }),
      title,
      layout,
      ...(sitemap === false ? { sitemap } : {}),
      ...(head === undefined ? {} : { head }),
      elements,
      state,
      ...(style === undefined ? {} : { style }),
      children: resolved,
    },
    pageWhere,
  );
  account(env, resolved, states);
  for (const key of Object.keys(state)) env.used.states.add(key);
  env.used.templates.add(group.slug);
  // A page that two templates would render (an entry of two types' templates, a term of two rules) is written once.
  if (page.groups.length > 1) {
    env.report.add({
      severity: "warn",
      code: `template.${page.kind === "entry" ? "entry" : page.kind}-split`,
      message: `The routes of ${page.file} select ${page.groups.length} different templates (${page.groups.map((g) => `${g.slug}: ${g.requests.length}`).join(", ")}) and one page file renders them all: it follows ${group.slug}, the template of most.`,
      where: `route:${page.route}`,
      data: { templates: Object.fromEntries(page.groups.map((g) => [g.slug, g.requests.length])) },
    });
  }
  return {
    info: {
      file: page.file,
      route: page.route,
      template: group.slug,
      kind: page.kind,
      layout,
    },
    content,
  };
}

// ── Building ─────────────────────────────────────────────────────────────────────────────────────

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** The location a template's findings carry: `template:cwicly//header`. */
const whereTemplate = (site: Pick<SiteContext, "model">, slug: string): string =>
  `template:${site.model.site.theme}//${slug}`;

/**
 * Every template, template part and reusable block of the site as Jx files, and the pages the route
 * table needs a template for; see the module header. Subjects are converted one after another (a
 * conversion shares process-wide state) and the output is sorted by path, so two runs over the same site
 * write the same bytes. One subject that cannot be converted costs that subject only
 * (`template.convert-failed`).
 */
export async function buildTemplates(
  site: SiteContext,
  opts: TemplatesOptions = {},
): Promise<TemplatesOutput> {
  const report = opts.report ?? createReport();
  const now = opts.now ?? new Date();
  const siteUrl = (opts.siteUrl ?? site.model.site.home).replace(/\/+$/, "");
  const only = opts.only === undefined ? undefined : new Set(opts.only);
  const used: TemplatesUsed = {
    components: new Set(),
    wpClasses: new Set(),
    hoisted: [],
    documentRules: [],
    states: new Set(),
    templates: new Set(),
    menus: newMenusUsed(),
  };
  const env: Env = {
    site,
    report,
    siteUrl,
    now,
    extra: opts.resolvers ?? {},
    convert: opts.convert ?? convertSubject,
    tags: siteTags(site),
    menus: used.menus,
    used,
    customCode: opts.customCode ?? site.options.customCode,
    converted: new Map(),
  };
  const files: TemplateFile[] = [];
  const pages: TemplatePageInfo[] = [];
  const parts: TemplatesOutput["parts"] = [];
  const reusables: TemplatesOutput["reusables"] = [];
  const collections: Record<string, TermCollectionDef> = {};
  const frames = new Map<string, ChromeSplit>();
  const inv = inventoryOf(site);

  const attempt = async (what: string, where: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      report.add({
        severity: "error",
        code: "template.convert-failed",
        message: `${what} could not be written (${error instanceof Error ? error.message : String(error)}); it is not in the output.`,
        where,
      });
    }
  };

  for (const { post, why } of inv.skipped) {
    report.add({
      severity: "info",
      code: "template.skipped",
      message: `The ${post.type === "wp_template" ? "template" : "template part"} "${post.slug}" is not converted: ${why}.`,
      where: `post:${post.id}`,
      data: { slug: post.slug, type: post.type, why },
    });
  }

  const plan = planOf(site, report);

  // Template parts and reusable blocks: components.
  for (const slug of [...inv.parts.keys()].sort()) {
    const tag = partTag(site, slug);
    const where = whereTemplate(site, slug);
    await attempt(`The template part ${slug}`, where, async () => {
      const built = await componentOf(env, { kind: "part", slug }, tag, where);
      files.push({ path: built.file, content: built.content });
      parts.push({ slug, tag, file: built.file });
      if (built.empty) {
        report.add({
          severity: "info",
          code: "template.part-empty",
          message: `The template part ${slug} has no content; its component is empty.`,
          where,
          data: { part: slug },
        });
      }
    });
  }
  const blocks = [...site.model.posts.values()]
    .filter((post) => post.type === "wp_block")
    .sort((a, b) => a.id - b.id);
  for (const post of blocks) {
    const where = `post:${post.id}`;
    if (post.status !== "publish" || post.passwordProtected) {
      report.add({
        severity: "info",
        code: "template.reusable-skipped",
        message: `The reusable block ${post.id} is ${post.passwordProtected ? "password protected" : `not published (${post.status})`}; WordPress prints nothing for it and it is not a component.`,
        where,
        data: { id: post.id, status: post.status },
      });
      continue;
    }
    if (post.content.trim() === "") {
      report.add({
        severity: "info",
        code: "template.reusable-skipped",
        message: `The reusable block ${post.id} (${post.title || post.slug}) has no content and is not a component.`,
        where,
        data: { id: post.id, status: "empty" },
      });
      continue;
    }
    const tag = reusableTag(site, post.id);
    await attempt(`The reusable block ${post.id}`, where, async () => {
      const built = await componentOf(env, { kind: "reusable", id: post.id }, tag, where);
      files.push({ path: built.file, content: built.content });
      reusables.push({ id: post.id, tag, file: built.file });
    });
  }

  // The pages of the routes that are not pages: entries, archives, terms, authors, the posts index, 404, search.
  const taken = new Set<string>([
    ...plan.pages.filter((p) => p.kind === "entry").map((p) => p.dynamic?.source ?? ""),
    ...[...site.routes.all()].map((r) => r.collection ?? "").filter(Boolean),
  ]);
  const nameFor = (base: string): string => {
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-terms${n > 2 ? n : ""}`;
    taken.add(name);
    return name;
  };
  for (const page of plan.pages) {
    const group = page.groups[0];
    if (group === undefined || (only && !only.has(group.slug))) continue;
    await attempt(`The page ${page.file}`, `route:${page.route}`, async () => {
      let data: DataSet | undefined;
      if (page.kind === "term" || page.kind === "author") {
        const base = page.kind === "author" ? "author" : (page.type ?? "term");
        data = await dataSet(env, page, nameFor(base), now);
        if (data) {
          collections[data.name] = data.def;
          files.push(...data.files);
        }
      }
      const built = await bodyPage({ env, page, group, ...(data ? { data } : {}), frames, now });
      files.push({ path: page.file, content: built.content });
      pages.push(built.info);
    });
  }

  // Layouts: one for the pages of a template, one for everything else.
  const layouts: Record<string, string> = {};
  const framesOut: Record<string, string> = {};
  const slugs = [...inv.templates.keys()].sort();
  for (const slug of slugs) {
    if (only && !only.has(slug)) continue;
    const where = whereTemplate(site, slug);
    if (plan.slotted.has(slug)) {
      await attempt(`The layout of the template ${slug}`, where, async () => {
        const built = await slottedLayout(env, slug);
        files.push({ path: built.file, content: built.content });
        layouts[slug] = layoutPathOf(site, slug, "slotted");
        used.templates.add(slug);
      });
    }
    if (plan.framed.has(slug)) {
      await attempt(`The frame of the template ${slug}`, where, async () => {
        let cut = frames.get(slug);
        if (cut === undefined) {
          const converted = await convertOnce(env, { kind: "template", slug });
          cut = splitChrome(site, converted.nodes);
          frames.set(slug, cut);
        }
        const built = frameLayout(env, slug, cut);
        files.push({ path: built.file, content: built.content });
        const path = layoutPathOf(site, slug, "frame");
        if (plan.slotted.has(slug)) framesOut[slug] = path;
        else layouts[slug] = path;
        used.templates.add(slug);
      });
    }
  }
  if (pages.some((p) => p.layout === layoutPath(FALLBACK_LAYOUT))) {
    files.push({
      path: `layouts/${FALLBACK_LAYOUT}.json`,
      content: json({
        $layout: BASE_LAYOUT,
        children: [{ tagName: "main", children: [{ tagName: "slot" }] }],
      }),
    });
  }
  files.push({ path: BASE_LAYOUT_FILE, content: baseLayout(env) });

  used.hoisted = dedupeRules(used.hoisted);
  used.documentRules = dedupeRules(used.documentRules);
  files.sort(byPath);
  pages.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  parts.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  reusables.sort((a, b) => a.id - b.id);
  const notFound = pages.find((p) => p.kind === "404")?.file ?? null;
  return {
    files,
    layouts,
    frames: framesOut,
    base: BASE_LAYOUT,
    pages,
    parts,
    reusables,
    collections,
    notFound,
    used,
    report,
  };
}
