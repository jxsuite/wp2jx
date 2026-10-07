/**
 * WordPress pages as Jx JSON pages: `pages/<uri>.json` at the `Route.file` the route table gave each
 * one (the front page is `pages/index.json`).
 *
 * ## What a page is
 *
 * The page's blocks (`convertSubject`, static, for a page) are its `children`; everything else a Jx
 * page document holds is decided here, in this order:
 *
 * 1. **`title`, `$head` and `$sitemap` from Rank Math** (`seoFor`): the `<title>`, the meta description,
 *    the robots meta, and the Open Graph and Twitter tags, in the `attributes` form (top-level
 *    `name`/`content` are silently dropped by the build). The **canonical and `og:url` are written
 *    on every page**: a person's `rank_math_canonical_url` (a same-site address mapped to its route,
 *    so an alias that WordPress redirects names the page it redirects to), else the page's own
 *    address, `siteUrl` plus the route with its trailing slash. Jx would print both itself, but
 *    without the slash (`/about-us`, where WordPress and every indexed link say `/about-us/`), and
 *    the build lets an authored entry win. Jx's sitemap `<loc>` still leaves the slash off, which is
 *    Jx's to correct. A noindex page is written with `$sitemap: false`, because Rank Math's sitemap
 *    leaves it out and Jx's lists every page. `og:image` goes through the media plan to the
 *    project's own copy, found by the attachment's id first (the address Rank Math prints is guessed
 *    from the guid, which can be a page address) and by its address second, made absolute against
 *    the site's address (a crawler does not resolve `/media/…`); an attachment neither finds is
 *    reported (`page.og-image-unresolved`). A literal `${` in any of it cannot be escaped in a title
 *    or an attribute, so it is degraded with a zero-width space and reported
 *    (`page.literal-template`).
 * 2. **`$layout`**: the page template's layout, `./layouts/<template slug>.json` (project-root
 *    relative). Without a layout the page's `title` leaks onto the root element as a `title`
 *    attribute, so a page the templates emitter has no layout for is reported (`page.no-layout`,
 *    error) rather than written silently without one. The choice is the templates emitter's
 *    (`layoutFor(site, subject)` in `emit/templates.ts`: Cwicly's `cwicly_conditions` rules are its
 *    business); until it exists, or when it has none to give, the WordPress template hierarchy over
 *    the model's own templates (the active theme's: an inactive theme's stay in the database) answers ({@link hierarchyLayout}): the front page's `front-page`, the
 *    page's `_wp_page_template`, `page-<slug>`, `page-<id>`, `page`, `singular`, `index`.
 * 3. **Placeholders** (`wp2jx-*`) are replaced ({@link replacePlaceholders}) with the resolvers the
 *    caller hands in (menus, navigation, template parts) over the defaults here: a template part
 *    becomes an instance of its component, and a shortcode, a search form or a block nothing
 *    converts becomes a visible neutral element holding what it said (`page.placeholder-neutral`),
 *    because a site that silently shows nothing hides what was lost. What no resolver answers stays
 *    and is reported (`placeholder.unresolved`). A `url()` in an element's style that names an
 *    absolute address (a background image: the styling modules leave it as the live site wrote it)
 *    goes through `rewriteUrl`, so an upload becomes the project's own copy.
 * 4. **`$elements`**: a relative `$ref` to `components/<tag>.json` for every component, template part
 *    and reusable block the finished nodes instantiate.
 * 5. **`state`**: the page-level entries converters registered (collections and the like), checked
 *    against the pointers the nodes hold (`page.state-missing`; only a `{"$ref": "#/state/…"}` is a
 *    pointer), and the page's own post under `entry` ({@link ENTRY_STATE_KEY}): `{id, timing: "compiler", data}` with the
 *    post's own fields in the Entry data contract's keys (`title`, `slug`, `date`, `modified`,
 *    `excerpt`, `author`, `url`, `featuredImage`). A page's state is visible to its layout, and the
 *    H1 is the post's title, which is not Rank Math's document title, so a layout renders it as
 *    `${state.entry.data.title ?? ''}` (`page.entry-state-taken` when a conversion already used the
 *    name, `page.entry-failed` when the post cannot be read as an entry).
 * 6. **`style`**: the rules that cannot live in one element's style (keyframes, `:where()` rules, the
 *    rules of other classes). A page's `style` is scoped to the layout's root, and a nested key is a
 *    compound with it, so a rule about descendants is written `& <selector>`; an at-rule is written
 *    as it is. Two rules of one selector accumulate as they do in CSS (the later value wins per
 *    property); only an at-rule that names one definition (`@keyframes x`, `@property --y`,
 *    `@font-face`, which has one slot per key) is replaced, and a replacement that differs is
 *    reported (`page.hoisted-collision`). A rule about the document itself (`body`, `html`,
 *    `:root`) has no spelling in a page's style, so it is not written into any page: it is returned
 *    in {@link PagesUsed.documentRules} for the project's `style`, which takes unscoped selectors
 *    (`page.hoisted-unplaced`, info).
 *
 * ## Which pages
 *
 * A published page with its own address (`Route.kind` `page` or `front`) becomes a file. Not emitted,
 * each with a report entry: drafts, private, pending and scheduled pages (one `page.unpublished` line
 * per status), a password-protected page (`page.password-protected`: the form WordPress put in front
 * of it is not a static feature, and publishing the content would leak it; `passwordProtected:
 * "include"` overrides), the posts page (`page.posts-page`: the templates emitter renders it) and a
 * page whose address WordPress gave to something else (`page.shadowed`: fineline's `/services/` is the
 * archive of the `service` type, so the page's own content never showed).
 *
 * Nothing here writes a `${` that is not a binding the converters made: {@link misplacedBindings}
 * walks every finished page for the positions docs/bindings.md says are never evaluated
 * (`page.binding-misplaced`).
 *
 * Report codes: `page.unpublished`, `page.password-protected`, `page.posts-page`, `page.shadowed`,
 * `page.no-route`, `page.empty`, `page.no-layout`, `page.layout-hierarchy`, `page.layout-module-failed`,
 * `page.template-conditions`, `page.literal-template`, `page.placeholder-neutral`,
 * `page.state-missing`, `page.entry-state-taken`, `page.entry-failed`, `page.og-image-unresolved`,
 * `page.hoisted-nested`, `page.hoisted-unplaced`, `page.hoisted-collision`,
 * `page.binding-misplaced`, `page.convert-failed` (the conversion threw, or anything after it did:
 * one page's failure costs that page only), plus everything the conversion and the SEO reader
 * report for the page, with the page's public URL filled in.
 */
import { existsSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { collectWpClasses } from "../core/block-css.ts";
import { postData } from "../cwicly/tokens.ts";
import { convertSubject, dedupeRules, type Converted } from "../convert.ts";
import { fluentFormFor } from "./fluentform.ts";
import { geoMapFor } from "./geomap.ts";
import { rewriteStyleUrls } from "./style-urls.ts";
import {
  childNodes,
  replacePlaceholders,
  walkElements,
  type Placeholder,
  type ResolverMap,
} from "../placeholders.ts";
import { createReport } from "../report.ts";
import type { Route } from "../routes.ts";
import {
  partTag,
  siteTags,
  subjectCtx,
  type HoistedRule,
  type SiteContext,
  type Subject,
  type SubjectOptions,
} from "../site.ts";
import type {
  JxDocument,
  JxElement,
  JxNode,
  JxStyle,
  Report,
  ReportEntry,
  WpPost,
} from "../types.ts";
import { seoFor, type Seo, type SeoImage } from "../wp/seo.ts";

// ── Contract ─────────────────────────────────────────────────────────────────────────────────────

/** What the templates emitter answers for a page: the layout path, or the path with the template it came from. */
export type LayoutChoice = string | { path: string; template?: string };

/**
 * Which layout a page uses (`emit/templates.ts` exports this under the same name). The path is what
 * `$layout` holds: project-root relative, `./layouts/<template slug>.json`. `undefined` means the
 * site has no template for the page.
 */
export type LayoutFor = (
  site: SiteContext,
  subject: Subject,
) => LayoutChoice | undefined | Promise<LayoutChoice | undefined>;

export interface PageOptions {
  /** Where findings go. Default: a fresh report (returned as `PagesOutput.report`). */
  report?: Report;
  /** The address the migrated site is served at: `og:image` is made absolute against it. Default: the source site's `home`. */
  siteUrl?: string;
  /** The layout of a page. Default: `layoutFor` of `emit/templates.ts` when it has one, else {@link hierarchyLayout}. */
  layoutFor?: LayoutFor;
  /**
   * The module that holds the templates emitter's `layoutFor`: an absolute path, or `false` for none.
   * Default: `emit/templates.ts` beside this file, when it exists.
   */
  templates?: string | false;
  /**
   * Resolvers for the placeholders a page holds, over the defaults (a template part, a shortcode, a
   * block nothing converts). A tag (`wp2jx-menu`) outranks a kind (`menu`), and a kind outranks `*`.
   */
  resolvers?: ResolverMap;
  /** What a password-protected page becomes. Default `skip`: it is reported and not written. */
  passwordProtected?: "skip" | "include";
  /** Only these page ids (for a partial run). */
  only?: readonly number[];
  /** The clock Rank Math's `%currentyear%` and kin read; one for the whole run. Default: now. */
  now?: Date;
  /** The conversion of one page; a seam for tests. Default: `convertSubject`. */
  convert?: (site: SiteContext, subject: Subject, opts?: SubjectOptions) => Promise<Converted>;
}

export interface PageFile {
  /** Project-relative, forward slashes: `pages/about-us.json`. */
  path: string;
  content: string;
}

export interface PageInfo {
  /** The post id. */
  id: number;
  /** Where it is in the Jx site: `/about-us/`, `/` for the front page. */
  route: string;
  /** The file it is written to (`Route.file`). */
  file: string;
  /** The `$layout` it carries, or null when no layout could be chosen. */
  layout: string | null;
}

export interface PageSkip {
  id: number;
  /** The report code that says why. */
  code: string;
  reason: string;
}

export interface PagesUsed {
  /** Tags of the components, template parts and reusable blocks the pages instantiate: `components/<tag>.json` must exist for each. */
  components: Set<string>;
  /** Every class name the pages carry (for the compatibility stylesheet's pruning). */
  wpClasses: Set<string>;
  /** The rules written into pages' own `style` because no element's style could hold them, duplicates removed. */
  hoisted: HoistedRule[];
  /**
   * The rules about the document itself (`body:has(#modal:popover-open) { overflow: hidden }`, a modal's
   * scroll lock) that a page's own style has no spelling for, duplicates removed. They are NOT written
   * into any page: the assembler writes them into the project's `style`, which takes unscoped selector keys.
   */
  documentRules: HoistedRule[];
  /** Page-level state keys the pages point at. */
  states: Set<string>;
}

export interface PagesOutput {
  /** One file per emitted page, in `Route.file` order. */
  files: PageFile[];
  pages: PageInfo[];
  /** Pages that did not become a file, and why. */
  skipped: PageSkip[];
  used: PagesUsed;
  /** Everything the pages' conversions, SEO and this emitter found, each with its location and the page's public URL. */
  report: Report;
}

// ── Layouts ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Shortcodes that print nothing on the live pages of the sites this was built from: the markers of the
 * PDF plugin's `[dkpdf-remove]`, which only keep the section out of a PDF. Removed and said
 * (`template.shortcode-empty`). (Rank Math's `[rank_math_breadcrumb]` is NOT here: it prints a real
 * `nav.rank-math-breadcrumb` on every page that has the shortcode, see {@link breadcrumbNode}.)
 */
export const EMPTY_SHORTCODES: ReadonlySet<string> = new Set(["dkpdf-remove", "dkpdf-pdf-remove"]);

/**
 * Shortcodes whose output only a server can make, and that print a link or a button rather than
 * content: a page without them is not misleading, and the visible placeholder text (`[dkpdf-button]`)
 * would stand on every page that carries them. Left out and said (`template.shortcode-dropped`).
 */
export const SERVER_ONLY_SHORTCODES: ReadonlyMap<string, string> = new Map([
  [
    "dkpdf-button",
    "it links to a PDF that the live server makes from the page for each request, which a static site has no way to serve",
  ],
]);

/**
 * What the report says for a shortcode that is left out instead of shown as a placeholder, or
 * undefined for any other: {@link EMPTY_SHORTCODES} print nothing live, {@link SERVER_ONLY_SHORTCODES}
 * need a server.
 */
export function leftOutShortcode(
  name: string,
  scope: "page" | "template" = "template",
): { code: string; message: string; data: { shortcode: string } } | undefined {
  const base = name.replace(/^\//, "");
  if (EMPTY_SHORTCODES.has(base)) {
    return {
      code: `${scope}.shortcode-empty`,
      message: `The shortcode [${base}] printed nothing on the live pages and is left out.`,
      data: { shortcode: base },
    };
  }
  const why = SERVER_ONLY_SHORTCODES.get(base);
  return why === undefined
    ? undefined
    : {
        code: `${scope}.shortcode-dropped`,
        message: `The shortcode [${base}] is left out: ${why}.`,
        data: { shortcode: base },
      };
}

const firstMeta = (site: Pick<SiteContext, "model">, id: number, key: string): unknown =>
  site.model.postMeta.get(id)?.[key]?.[0];

/**
 * Whether a template belongs to another theme than the active one: WordPress keeps the templates of
 * an inactive theme in the database tagged with that theme's `wp_theme` term, and
 * `get_block_templates` only reads those of `get_stylesheet()`. A template with no theme term at all
 * is a hand-made one and counts (the rule `site.ts` ranks them by).
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

/** The slug of every published `wp_template` of the active theme. */
function templateSlugs(site: Pick<SiteContext, "model">): Set<string> {
  const slugs = new Set<string>();
  for (const post of site.model.posts.values()) {
    if (post.type === "wp_template" && post.status === "publish" && !ofAnotherTheme(site, post)) {
      slugs.add(post.slug);
    }
  }
  return slugs;
}

/** The layout file of a template: the convention the templates emitter writes to. */
export const layoutPath = (templateSlug: string): string => `./layouts/${templateSlug}.json`;

/** Whether `post` is the page the site shows on its front. */
const isFrontPage = (site: Pick<SiteContext, "model">, post: WpPost): boolean =>
  site.model.site.showOnFront === "page" && site.model.site.pageOnFront === post.id;

/**
 * The templates WordPress tries for a page, most specific first (`get_front_page_template`, then
 * `get_page_template`, then the block theme's fallbacks): `front-page` for the front page, the
 * page's own template (`_wp_page_template`, anything but `default`), `page-<slug>`, `page-<id>`,
 * `page`, `singular`, `index`.
 */
export function templateHierarchy(site: Pick<SiteContext, "model">, post: WpPost): string[] {
  const out: string[] = [];
  if (isFrontPage(site, post)) out.push("front-page");
  const own = firstMeta(site, post.id, "_wp_page_template");
  if (typeof own === "string" && own !== "" && own !== "default") out.push(own);
  if (post.slug !== "") out.push(`page-${post.slug}`);
  out.push(`page-${post.id}`, "page", "singular", "index");
  return out;
}

/**
 * The layout a page gets when the templates emitter has no opinion: the first template of the
 * hierarchy the site actually has. A page template that names a file of a classic theme
 * (`page-templates/wide.php`) is no `wp_template` and falls through, as it does in WordPress.
 */
export const hierarchyLayout = (
  site: Pick<SiteContext, "model">,
  subject: Subject,
): { path: string; template: string } | undefined => {
  if (subject.kind !== "post") return undefined;
  const post = site.model.posts.get(subject.id);
  if (!post) return undefined;
  const have = templateSlugs(site);
  const template = templateHierarchy(site, post).find((slug) => have.has(slug));
  return template === undefined ? undefined : { path: layoutPath(template), template };
};

const normalise = (choice: LayoutChoice | undefined): string | undefined =>
  choice === undefined ? undefined : typeof choice === "string" ? choice : choice.path;

/**
 * `layoutFor` of the templates emitter, when that module exists and has one; undefined otherwise. A
 * module that is there and fails to load is a warning, and the hierarchy answers.
 */
async function templatesLayoutFor(
  report: Report,
  module: string | false | undefined,
): Promise<LayoutFor | undefined> {
  if (module === false) return undefined;
  const file = module ?? fileURLToPath(new URL("./templates.ts", import.meta.url));
  if (!existsSync(file)) return undefined;
  try {
    const mod = (await import(file)) as { layoutFor?: unknown };
    if (typeof mod.layoutFor === "function") return mod.layoutFor as LayoutFor;
  } catch (error) {
    report.add({
      severity: "warn",
      code: "page.layout-module-failed",
      message: `emit/templates.ts did not load (${error instanceof Error ? error.message : String(error)}); layouts follow the WordPress template hierarchy instead.`,
      where: "site",
    });
  }
  return undefined;
}

// ── Head ─────────────────────────────────────────────────────────────────────────────────────────

type HeadEntry = { tagName: string; attributes: Record<string, string> };

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** `/media/x.png` against the site's address; an address that already has a scheme is left alone. */
const absoluteUrl = (siteUrl: string, address: string): string =>
  ABSOLUTE.test(address)
    ? address
    : `${siteUrl.replace(/\/+$/, "")}${address.startsWith("/") ? "" : "/"}${address}`;

export interface HeadOptions {
  siteUrl: string;
  /** The project's copy of an uploads address, with its size. */
  mediaForUrl(url: string): { src: string; width?: number; height?: number } | undefined;
  /**
   * The project's copy of an attachment, by id. An image Rank Math names by attachment is asked here
   * first: the id is the media library's own answer, while the address Rank Math prints is guessed
   * from the guid and the file name, and a guid that is a page address (`/photo-by-x/`) makes a
   * guess that names nothing.
   */
  mediaFor?(id: number): { src: string; width?: number; height?: number } | undefined;
  /** Makes a string safe for a title or an attribute: a `${` cannot be spelled there. */
  text(value: string): string;
  /**
   * The page's own public address, absolute. Written as the canonical and `og:url` when Rank Math's
   * answer holds none, because the address Jx would print itself leaves off the route's trailing
   * slash, which is not the address WordPress (and so every indexed link) has.
   */
  self?: string;
  /** An address a person set (a canonical) for the Jx site: a same-site permalink becomes its route. Default: as written. */
  address?(url: string): string;
  /** Called with an image whose attachment is known and which neither the id nor its address found in the media plan. */
  unresolvedImage?(image: SeoImage): void;
}

/**
 * The `<head>` entries of a page from its Rank Math answer, in the order Rank Math prints them. An
 * entry whose value is empty is not written. The canonical and `og:url` are the answer's (a person's
 * `rank_math_canonical_url`, through `address`), else `self`, the page's own address.
 */
export function headEntries(seo: Seo, opts: HeadOptions): HeadEntry[] {
  const out: HeadEntry[] = [];
  const meta = (key: "name" | "property", name: string, value: string | undefined): void => {
    if (value === undefined || value === "") return;
    out.push({ tagName: "meta", attributes: { [key]: name, content: opts.text(value) } });
  };
  const address = (url: string | undefined): string | undefined =>
    url === undefined || url === ""
      ? opts.self
      : absoluteUrl(opts.siteUrl, opts.address?.(url) ?? url);
  const image = (prefix: string, source: SeoImage | undefined, rich: boolean): void => {
    if (!source) return;
    const byId = source.id === undefined ? undefined : opts.mediaFor?.(source.id);
    const own = byId ?? opts.mediaForUrl(source.url);
    if (own === undefined && source.id !== undefined) opts.unresolvedImage?.(source);
    meta(
      prefix === "twitter" ? "name" : "property",
      `${prefix}:image`,
      absoluteUrl(opts.siteUrl, own?.src ?? source.url),
    );
    if (!rich) return;
    const width = own?.width ?? source.width;
    const height = own?.height ?? source.height;
    if (width !== undefined) meta("property", "og:image:width", String(width));
    if (height !== undefined) meta("property", "og:image:height", String(height));
    meta("property", "og:image:alt", source.alt);
    meta("property", "og:image:type", source.type);
  };

  meta("name", "description", seo.description);
  meta("name", "robots", seo.robots);
  // Rank Math prints no canonical on a noindex page, but its og:url still holds a person's one; Jx
  // prints a canonical on every page, so one that is ours says the right thing.
  const canonical = address(seo.canonical ?? seo.openGraph.url);
  if (canonical !== undefined) {
    out.push({
      tagName: "link",
      attributes: { rel: "canonical", href: opts.text(canonical) },
    });
  }
  const og = seo.openGraph;
  meta("property", "og:locale", og.locale);
  meta("property", "og:type", og.type);
  meta("property", "og:title", og.title);
  meta("property", "og:description", og.description);
  meta("property", "og:url", address(og.url));
  meta("property", "og:site_name", og.siteName);
  image("og", og.image, true);
  const tw = seo.twitter;
  meta("name", "twitter:card", tw.card);
  meta("name", "twitter:title", tw.title);
  meta("name", "twitter:description", tw.description);
  meta("name", "twitter:site", tw.site);
  image("twitter", tw.image, false);
  return out;
}

/** `${` written so no binding can be read in it (a zero-width space between the two characters). */
export const literalText = (value: string): string => value.replaceAll("${", "$​{");

// ── Elements ─────────────────────────────────────────────────────────────────────────────────────

/** Where a component's file is written: flat in `components/`, named by its tag. */
export const componentFile = (tag: string): string => `components/${tag}.json`;

/** A `$ref` to a project file, relative to the page file it is written in. */
export function relativeRef(fromFile: string, toFile: string): string {
  const ref = posix.relative(posix.dirname(fromFile), toFile);
  return ref.startsWith(".") ? ref : `./${ref}`;
}

// ── Hoisted rules ────────────────────────────────────────────────────────────────────────────────

/** A selector split at its top-level commas (a comma inside `:is(a, b)` or `[x="a,b"]` is not a list separator). */
function selectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let from = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(selector.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(selector.slice(from).trim());
  return parts.filter((part) => part !== "");
}

/** Selectors about the document, which nothing nested under the layout's root can name. */
const DOCUMENT_SELECTOR = /^(?:html|body|:root|:host|\*)(?![\w-])|^&$/i;

export interface HoistedStyle {
  style: JxStyle;
  /** Selectors written as `& <selector>`: scoped under the layout's root, one class more specific than a project rule. */
  nested: number;
  /** Rules that have no spelling in a page's style. */
  unplaced: HoistedRule[];
  /** At-rules two rules define differently under one key, which cannot both be written; the later one is kept. */
  collisions: string[];
}

/**
 * At-rules whose key names ONE definition: a second `@keyframes spin` replaces the first in CSS, and a
 * page style has one slot per key, so `@font-face` (which CSS lets accumulate) is here too, because its
 * key is the same for every face. Every other rule accumulates, which a merge writes exactly.
 */
const REPLACING_AT_RULE =
  /^@(?:-\w+-)?(?:keyframes|property|counter-style|font-palette-values|font-feature-values|position-try|font-face)(?![\w-])/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `source` over `target` as the cascade reads two rules of one selector: a property the later rule
 * sets wins (and moves to the end, because a shorthand written after a longhand overrides it and the
 * reverse does not), nested blocks (`:hover`, `@--md`) merge the same way.
 */
function mergeStyle(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const known = target[key];
    if (isRecord(known) && isRecord(value)) {
      mergeStyle(known, value);
      continue;
    }
    delete target[key];
    target[key] = structuredClone(value);
  }
}

/** The page `style` that holds hoisted rules; see the module header for how each kind is written. */
export function hoistedStyle(rules: readonly HoistedRule[]): HoistedStyle {
  const style: Record<string, unknown> = {};
  const unplaced: HoistedRule[] = [];
  const collisions: string[] = [];
  let nested = 0;
  const put = (key: string, value: JxStyle): void => {
    const known = style[key];
    if (known === undefined) {
      style[key] = structuredClone(value);
    } else if (REPLACING_AT_RULE.test(key)) {
      if (JSON.stringify(known) !== JSON.stringify(value) && !collisions.includes(key)) {
        collisions.push(key);
      }
      style[key] = structuredClone(value);
    } else if (isRecord(known)) {
      mergeStyle(known, value as Record<string, unknown>);
    }
  };
  for (const rule of rules) {
    const selector = rule.selector.trim();
    if (selector.startsWith("@")) {
      put(selector, rule.style);
      continue;
    }
    const parts = selectorList(selector);
    if (parts.length === 0 || parts.some((part) => DOCUMENT_SELECTOR.test(part))) {
      unplaced.push(rule);
      continue;
    }
    for (const part of parts) {
      nested++;
      put(`& ${part}`, rule.style);
    }
  }
  return { style: style as JxStyle, nested, unplaced, collisions };
}

// ── Bindings in the wrong place ──────────────────────────────────────────────────────────────────

/** Top-level properties the static emitter writes but also binds on the client, which ships JavaScript. */
const UNBOUND_PROPS = ["hidden", "title", "tabIndex", "lang", "dir"] as const;

const hasBinding = (value: unknown): boolean => typeof value === "string" && value.includes("${");

/**
 * Whether a string is exactly one `${…}` expression, from its opening to its last character. The
 * build finds the end of an expression by counting braces without reading the strings in it
 * (docs/bindings.md rule 13), so this counts the same way: `${a}${b}` and `a ${b}` are not one.
 */
export function isWholeExpression(value: string): boolean {
  if (!value.startsWith("${") || !value.endsWith("}")) return false;
  let depth = 0;
  for (let i = 1; i < value.length; i++) {
    const c = value[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i === value.length - 1;
  }
  return false;
}

/**
 * Whether a whole expression is one the emitters make to yield nodes: it writes at least one node
 * object (a `tagName` key, quoted or not). The build evaluates a child string and takes its place by
 * what it yields only when that is an array (specs/spec.md, computed children); a scalar is printed
 * as the text `${…}` (docs/bindings.md [K2]), so `${state.entry.data.title}` is not exempt however
 * well formed.
 */
export function isComputedNodeList(value: string): boolean {
  return isWholeExpression(value) && /\btagName['"]?\s*:/.test(value);
}

/** Values inside a nested style block (`:hover`, `& a`, `@--md`), where a binding is silently lost. */
function nestedStyleBinding(style: unknown, nested: boolean): boolean {
  if (typeof style !== "object" || style === null) return nested && hasBinding(style);
  return Object.values(style).some((value) =>
    typeof value === "object" && value !== null
      ? nestedStyleBinding(value, true)
      : nested && hasBinding(value),
  );
}

export interface MisplacedBinding {
  /** Where: `children/2/children/0`. */
  path: string;
  /** Which position (docs/bindings.md rule 5): `className`, `id`, `children`, `style`, `hidden`… */
  position: string;
}

/**
 * The places in a finished page where a `${` is never evaluated, or is evaluated twice
 * (docs/bindings.md, rule 5): `className` and `id`, the top-level `hidden`/`title`/`tabIndex`/`lang`/`dir`,
 * a text child in `children` that holds a binding (a child that is exactly one expression writing
 * nodes is evaluated, `[K2]`; one that yields a scalar is not), a nested style block, and everything in the page's own `title` and
 * `$head`, which this emitter writes literally.
 */
export function misplacedBindings(doc: JxDocument): MisplacedBinding[] {
  const found: MisplacedBinding[] = [];
  if (hasBinding(doc.title)) found.push({ path: "title", position: "title" });
  (doc.$head ?? []).forEach((entry, i) => {
    if (JSON.stringify(entry).includes("${")) found.push({ path: `$head/${i}`, position: "$head" });
  });
  const visit = (node: JxNode, path: string): void => {
    if (typeof node === "string") return;
    const flag = (position: string): void => void found.push({ path, position });
    if (hasBinding(node.className)) flag("className");
    if (hasBinding(node.id)) flag("id");
    for (const prop of UNBOUND_PROPS) {
      if (path !== "" && hasBinding((node as Record<string, unknown>)[prop])) flag(prop);
    }
    if (nestedStyleBinding(node.style, false)) flag("style");
    if (Array.isArray(node.children)) {
      node.children.forEach((child, i) => {
        if (typeof child === "string") {
          // A string that is one expression yielding a list of nodes (or none) is evaluated and the
          // list takes its place (docs/bindings.md [K2]); text around a binding, and an expression
          // that yields anything else, is printed as is.
          if (hasBinding(child) && !isComputedNodeList(child))
            found.push({ path: `${path}/children/${i}`, position: "children" });
        } else visit(child, `${path}${path === "" ? "" : "/"}children/${i}`);
      });
    }
    // A repeater's template and a `$switch`'s cases are elements too.
    const rest = childNodes(node).filter(
      (child) => !(Array.isArray(node.children) && node.children.includes(child)),
    );
    rest.forEach((child, i) => visit(child, `${path}${path === "" ? "" : "/"}map/${i}`));
  };
  const root = { children: doc.children } as unknown as JxElement;
  visit(root, "");
  return found;
}

// ── Placeholders ─────────────────────────────────────────────────────────────────────────────────

/** The key a `#/state/<key>…` JSON pointer names, percent- and `~`-decoded; undefined for any other string. */
function stateKeyOf(pointer: string): string | undefined {
  const m = /^#\/state\/([^/]+)/.exec(pointer);
  if (!m) return undefined;
  let key = m[1]!;
  try {
    key = decodeURIComponent(key);
  } catch {
    // A stray `%` is not an escape; the pointer names the key as written.
  }
  return key.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * The state keys a tree points at: the `$ref` of an object, `{"$ref": "#/state/<key>…"}`, anywhere in
 * it. Only a `$ref` is a pointer: a paragraph that happens to read `#/state/x` is text (the same rule
 * as `convert.ts`, which does not export its own).
 */
function stateKeysIn(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) stateKeysIn(item, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === "$ref" && typeof inner === "string") {
      const state = stateKeyOf(inner);
      if (state !== undefined) into.add(state);
    } else stateKeysIn(inner, into);
  }
}

/** The visible stand-in for what has no static form: the class says what it is, the text says what it said. */
function neutralElement(placeholder: Placeholder, label: string, text: string): JxElement {
  const inner = placeholder.element.children;
  return {
    tagName: "div",
    className: `wp2jx-unconverted wp2jx-${placeholder.kind}`,
    attributes: { "data-wp2jx": label },
    ...(Array.isArray(inner) && inner.length > 0
      ? { children: inner }
      : { textContent: literalText(text) }),
  };
}

// ── The post, for the layout ─────────────────────────────────────────────────────────────────────

/** The page-level state key a page's own post is written under: the name a layout reads it by (`state.entry`, as in `site.ts`'s templates). */
export const ENTRY_STATE_KEY = "entry";

/** The keys of a post's entry data that are the post's own (docs/design.md, Entry data contract), not its ACF values or terms. */
const ENTRY_OWN_KEYS = [
  "title",
  "slug",
  "date",
  "modified",
  "excerpt",
  "author",
  "url",
  "featuredImage",
] as const;

/** A copy of `value` with every string through `text` (a state string holding a dollar-brace would be evaluated). */
function textual(value: unknown, text: (value: string) => string): unknown {
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map((item) => textual(item, text));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, textual(inner, text)]),
    );
  }
  return value;
}

/**
 * The page's own post as the entry the Entry data contract describes, `{id, timing, data}`, so a layout converted
 * in entry mode reads `${state.entry.data.title ?? ''}` for the H1 (the post's title, which is not Rank
 * Math's document title) and the template's other fields. A page's state is visible to its layout. Only
 * the post's own fields are carried; its ACF values and terms are the templates emitter's to ask for.
 * Undefined, and reported, when the entry cannot be read.
 */
async function entryStateFor(
  site: SiteContext,
  post: WpPost,
  route: Route,
  report: Report,
  text: (value: string) => string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const ctx = await subjectCtx(site, { kind: "post", id: post.id }, { report });
    const all = postData(ctx, post);
    const data: Record<string, unknown> = {};
    for (const key of ENTRY_OWN_KEYS) {
      const value = all[key];
      if (value === undefined) continue;
      if ((key === "date" || key === "modified") && Number.isNaN(Date.parse(String(value))))
        continue;
      data[key] = textual(value, text);
    }
    // `timing: "compiler"` is what keeps a page that only reads its own entry free of JavaScript:
    // without it a state object that is not a prototype is client state, and the page ships `app.js`
    // and the reactivity runtime (docs/bindings.md rule 1).
    return { id: route.jxRoute, timing: "compiler", data };
  } catch (error) {
    report.add({
      severity: "warn",
      code: "page.entry-failed",
      message: `The page's own post could not be read as an entry (${error instanceof Error ? error.message : String(error)}); a layout cannot render its title.`,
      where: `post:${post.id}`,
    });
    return undefined;
  }
}

// ── Building ─────────────────────────────────────────────────────────────────────────────────────

const byFile = (a: { file: string; id: number }, b: { file: string; id: number }): number =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.id - b.id;

/**
 * Every published page of the site as a Jx page document; see the module header. Pages are converted
 * one after another (a conversion shares process-wide state), in id order, and the output is sorted
 * by file, so two runs over the same site write the same bytes.
 */
export async function buildPages(site: SiteContext, opts: PageOptions = {}): Promise<PagesOutput> {
  const report = opts.report ?? createReport();
  const convert = opts.convert ?? convertSubject;
  const now = opts.now ?? new Date();
  const siteUrl = (opts.siteUrl ?? site.model.site.home).replace(/\/+$/, "");
  const fromTemplates =
    opts.layoutFor === undefined ? await templatesLayoutFor(report, opts.templates) : undefined;
  const layoutFor: LayoutFor = opts.layoutFor ?? fromTemplates ?? hierarchyLayout;
  if (opts.layoutFor === undefined && fromTemplates === undefined) {
    report.add({
      severity: "info",
      code: "page.layout-hierarchy",
      message:
        "The templates emitter gave no layoutFor: each page's layout is the first template of the WordPress hierarchy (front-page, its own template, page-<slug>, page, singular, index) that the site has.",
      where: "site",
    });
  }
  const only = opts.only === undefined ? undefined : new Set(opts.only);

  const files: PageFile[] = [];
  const pages: PageInfo[] = [];
  const skipped: PageSkip[] = [];
  const used: PagesUsed = {
    components: new Set(),
    wpClasses: new Set(),
    hoisted: [],
    documentRules: [],
    states: new Set(),
  };
  const tags = siteTags(site);
  // One report for every page's SEO reads: the reader says a site-wide thing once per report.
  const seoReport = createReport();
  let seoSeen = 0;
  const unpublished = new Map<string, number[]>();

  const addEntry = (post: WpPost, url: string | undefined, entry: ReportEntry): void => {
    // The page's address belongs to the page's own findings, not to a site-wide one the SEO reader made.
    const own = entry.where === undefined || entry.where === `post:${post.id}`;
    report.add({
      ...entry,
      where: entry.where ?? `post:${post.id}`,
      ...(own && entry.url === undefined && url !== undefined ? { url } : {}),
    });
  };
  const skip = (post: WpPost, entry: Omit<ReportEntry, "where"> & { url?: string }): void => {
    skipped.push({ id: post.id, code: entry.code, reason: entry.message });
    report.add({ ...entry, where: `post:${post.id}` });
  };

  const candidates = [...site.model.posts.values()]
    .filter((post) => post.type === "page" && (only === undefined || only.has(post.id)))
    .sort((a, b) => a.id - b.id);

  const emit: { post: WpPost; route: Route }[] = [];
  for (const post of candidates) {
    if (post.status !== "publish") {
      unpublished.set(post.status, [...(unpublished.get(post.status) ?? []), post.id]);
      continue;
    }
    const route = site.routes.forPost(post.id);
    const url = route === undefined ? undefined : `${site.model.site.home}${route.wpPath}`;
    if (route === undefined) {
      skip(post, {
        severity: "warn",
        code: "page.no-route",
        message: `The page "${post.title}" has no address WordPress could have served (no usable slug), so it is not written.`,
      });
      continue;
    }
    if (route.id !== post.id) {
      skip(post, {
        severity: "warn",
        code: "page.shadowed",
        message: `WordPress served ${route.wpPath} from a ${route.kind} (${String(route.id)}), never from this page, so its content never showed and it is not written; the winner renders that address.`,
        ...(url === undefined ? {} : { url }),
        data: { winner: route.kind, id: route.id, route: route.jxRoute },
      });
      continue;
    }
    if (route.kind === "posts-page") {
      skip(post, {
        severity: "info",
        code: "page.posts-page",
        message: `The posts page ${route.wpPath} shows the post listing, not this page's content (WordPress ignores it); the templates emitter renders it.`,
        ...(url === undefined ? {} : { url }),
      });
      continue;
    }
    if (route.kind !== "page" && route.kind !== "front") {
      skip(post, {
        severity: "warn",
        code: "page.no-route",
        message: `The route of this page is a ${route.kind}, not a page; it is not written.`,
        ...(url === undefined ? {} : { url }),
      });
      continue;
    }
    if (post.passwordProtected && opts.passwordProtected !== "include") {
      skip(post, {
        severity: "warn",
        code: "page.password-protected",
        message: `The page is password protected: WordPress showed a password form, which a static site cannot, and publishing its content would leak it. It is not written (passwordProtected: "include" writes it).`,
        ...(url === undefined ? {} : { url }),
      });
      continue;
    }
    emit.push({ post, route });
  }
  for (const [status, ids] of [...unpublished].sort(([a], [b]) => (a < b ? -1 : 1))) {
    report.add({
      severity: "info",
      code: "page.unpublished",
      message: `${ids.length} ${status} page${ids.length === 1 ? " is" : "s are"} not published on the source site and ${ids.length === 1 ? "is" : "are"} not written.`,
      where: "site",
      data: { status, ids },
    });
    for (const id of ids)
      skipped.push({ id, code: "page.unpublished", reason: `status ${status}` });
  }

  const resolvers = (page: { url: string; where: string; report: Report }): ResolverMap => ({
    "template-part": (placeholder) => {
      const slug = placeholder.attrs.slug;
      if (slug === undefined || slug === "") return undefined;
      const tag = partTag(site, slug);
      if (!tags.has(tag)) return undefined;
      const className = placeholder.element.className;
      return {
        tagName: tag,
        ...(typeof className === "string" && className !== "" ? { className } : {}),
      };
    },
    shortcode: (placeholder) => {
      const name = placeholder.attrs["data-shortcode"] ?? "";
      const left = leftOutShortcode(name, "page");
      if (left !== undefined) {
        page.report.add({ severity: "info", ...left, where: page.where, url: page.url });
        return Array.isArray(placeholder.element.children) ? placeholder.element.children : null;
      }
      const form = fluentFormFor(site, placeholder, (entry) =>
        page.report.add({ ...entry, where: page.where, url: page.url }),
      );
      if (form !== undefined) return form;
      const map = geoMapFor(site, placeholder, (entry) =>
        page.report.add({ ...entry, where: page.where, url: page.url }),
      );
      if (map !== undefined) return map;
      page.report.add({
        severity: "warn",
        code: "page.placeholder-neutral",
        message: `The shortcode [${name}] has no static form; a visible neutral element holds its text where it stood.`,
        where: page.where,
        url: page.url,
        data: { kind: "shortcode", shortcode: name },
      });
      return neutralElement(
        placeholder,
        `shortcode:${name}`,
        placeholder.attrs["data-source"] ?? `[${name}]`,
      );
    },
    block: (placeholder) => {
      const block = placeholder.block ?? "unknown";
      const form = fluentFormFor(site, placeholder, (entry) =>
        page.report.add({ ...entry, where: page.where, url: page.url }),
      );
      if (form !== undefined) return form;
      page.report.add({
        severity: "warn",
        code: "page.placeholder-neutral",
        message: `The block ${block} saved no markup and has no converter; a visible neutral element marks where it stood.`,
        where: page.where,
        url: page.url,
        data: { kind: "block", block },
      });
      return neutralElement(placeholder, `block:${block}`, `[${block}]`);
    },
    search: (placeholder) => {
      page.report.add({
        severity: "warn",
        code: "page.placeholder-neutral",
        message:
          "WordPress's search runs on the server and the migrated site has none; a visible neutral element marks where the search form stood.",
        where: page.where,
        url: page.url,
        data: { kind: "search" },
      });
      return neutralElement(placeholder, "search", "[search]");
    },
    ...opts.resolvers,
  });

  for (const { post, route } of emit) {
    const where = `post:${post.id}`;
    const url = `${site.model.site.home}${route.wpPath}`;
    const subject: Subject = { kind: "post", id: post.id };
    const pageReport = createReport();
    let converted: Converted;
    try {
      converted = await convert(site, subject, { mode: "static", target: "page" });
    } catch (error) {
      skip(post, {
        severity: "error",
        code: "page.convert-failed",
        message: `The page could not be converted (${error instanceof Error ? error.message : String(error)}); it is not written.`,
        url,
      });
      continue;
    }
    for (const entry of converted.report.entries()) pageReport.add(entry);

    try {
      // The body.
      let nodes = replacePlaceholders(
        converted.nodes,
        resolvers({ url, where, report: pageReport }),
        { report: pageReport, where, url },
      );
      // A `url()` in a style (a background image) holds the live address of an upload unless something
      // rewrote it; the elements are this page's own copies, so they are edited in place.
      const own = structuredClone(nodes);
      const tools = site.urls.bind(pageReport, where);
      for (const element of walkElements(own)) {
        rewriteStyleUrls(element.style, (address) => tools.rewriteUrl(address));
      }
      nodes = own;
      if (nodes.length === 0) {
        pageReport.add({
          severity: "info",
          code: "page.empty",
          message: "The page has no content; it is written with no children.",
          where,
          url,
        });
      }

      // The head.
      let literal = false;
      const text = (value: string): string => {
        if (value.includes("${")) literal = true;
        return literalText(value);
      };
      const seo = seoFor(
        site.model,
        isFrontPage(site, post) ? { kind: "home" } : { kind: "post", post },
        { report: seoReport, now },
      );
      const seoEntries = seoReport.entries();
      for (const entry of seoEntries.slice(seoSeen)) pageReport.add(entry);
      seoSeen = seoEntries.length;
      const head = headEntries(seo, {
        siteUrl,
        mediaForUrl: (address) => site.media.mediaForUrl(address),
        mediaFor: (id) => site.media.mediaFor(id),
        text,
        self: `${siteUrl}${route.jxRoute}`,
        address: (address) => tools.rewriteUrl(address),
        unresolvedImage: (image) =>
          pageReport.add({
            severity: "warn",
            code: "page.og-image-unresolved",
            message: `The social image (attachment ${String(image.id)}, ${image.url}) is not in the media plan under its id or its address, so the live address is kept and no file is downloaded for it.`,
            where,
            url,
            data: { id: image.id, address: image.url },
          }),
      });
      const pageTitle = text(seo.title);

      // The post itself, for a layout to render (the H1 is the post's title, which is not Rank Math's).
      const postEntry = await entryStateFor(site, post, route, pageReport, text);
      if (literal) {
        pageReport.add({
          severity: "warn",
          code: "page.literal-template",
          message:
            "A literal dollar-brace in the page's title or head would be read as a binding; it is written with a zero-width space between the two characters.",
          where,
          url,
        });
      }

      // The layout.
      let layout: string | null = null;
      try {
        layout = normalise(await layoutFor(site, subject)) ?? null;
      } catch (error) {
        pageReport.add({
          severity: "error",
          code: "page.no-layout",
          message: `The layout of the page could not be chosen (${error instanceof Error ? error.message : String(error)}).`,
          where,
          url,
        });
      }
      if (layout === null && !pageReport.entries().some((e) => e.code === "page.no-layout")) {
        pageReport.add({
          severity: "error",
          code: "page.no-layout",
          message:
            "The site has no template for this page, so the page is written without a $layout: its title will show as a tooltip over the whole page unless the project's defaults.layout covers it.",
          where,
          url,
        });
      }
      // The rules as the options reader normalised them: a rule listing only ACF, author or archive
      // conditions assigns a template too, and a malformed one is the reader's finding, not a crash here.
      const rules = (site.options.templateRules ?? []).filter((rule) => rule.assigned);
      if (rules.length > 0 && opts.layoutFor === undefined && fromTemplates === undefined) {
        pageReport.add({
          severity: "warn",
          code: "page.template-conditions",
          message: `Cwicly assigns templates by rule (${rules.map((rule) => rule.slug).join(", ")}); the hierarchy fallback does not evaluate them, so this page's layout may differ from the live site's.`,
          where,
          url,
        });
      }

      // Elements, state, style.
      const components = new Set<string>();
      for (const element of walkElements(nodes)) {
        const tag = element.tagName as string | undefined;
        if (tag !== undefined && tags.has(tag)) components.add(tag);
      }
      const elements = [...components]
        .sort()
        .map((tag) => ({ $ref: relativeRef(route.file, componentFile(tag)) }));

      const wanted = new Set<string>(converted.used.states);
      stateKeysIn(nodes, wanted);
      const missing = [...wanted].filter((key) => !Object.hasOwn(converted.state, key)).sort();
      for (const key of missing) {
        pageReport.add({
          severity: "error",
          code: "page.state-missing",
          message: `The page points at the state entry "${key}" and no conversion registered it.`,
          where,
          url,
          data: { key },
        });
      }
      const state: Record<string, unknown> = { ...converted.state };
      if (postEntry !== undefined) {
        if (Object.hasOwn(state, ENTRY_STATE_KEY)) {
          pageReport.add({
            severity: "warn",
            code: "page.entry-state-taken",
            message: `A conversion registered the state entry "${ENTRY_STATE_KEY}" itself, so the page's own post is not written under that name and a layout cannot read its title.`,
            where,
            url,
          });
        } else state[ENTRY_STATE_KEY] = postEntry;
      }

      const hoisted = dedupeRules(converted.hoisted);
      const placed = hoistedStyle(hoisted);
      if (placed.nested > 0) {
        pageReport.add({
          severity: "info",
          code: "page.hoisted-nested",
          message: `${placed.nested} hoisted rule${placed.nested === 1 ? " is" : "s are"} scoped under the layout's root (written "& <selector>"): the page's own style is scoped, so they are one class more specific than a project rule.`,
          where,
          url,
        });
      }
      for (const rule of placed.unplaced) {
        pageReport.add({
          severity: "info",
          code: "page.hoisted-unplaced",
          message: `The rule ${rule.selector} is about the document itself, which a page's own style cannot reach; it is returned in used.documentRules for the project's style, which takes unscoped selectors.`,
          where,
          url,
          data: { selector: rule.selector },
        });
      }
      for (const key of placed.collisions) {
        pageReport.add({
          severity: "warn",
          code: "page.hoisted-collision",
          message: key.startsWith("@font-face")
            ? "Several @font-face rules were hoisted onto this page, and a page's style has one slot for them: only the last is written."
            : `Two rules define ${key} differently, and an at-rule of that name has one definition; the later one is kept.`,
          where,
          url,
          data: { key },
        });
      }

      const doc: Record<string, unknown> = { title: pageTitle };
      if (layout !== null) doc.$layout = layout;
      // Rank Math's sitemap leaves a noindex page out; Jx's lists every page unless told not to.
      if (/(?:^|,)\s*noindex\s*(?:,|$)/i.test(seo.robots)) doc.$sitemap = false;
      if (head.length > 0) doc.$head = head;
      if (elements.length > 0) doc.$elements = elements;
      if (Object.keys(state).length > 0) doc.state = state;
      if (Object.keys(placed.style).length > 0) doc.style = placed.style;
      doc.children = nodes;

      for (const misplaced of misplacedBindings(doc as unknown as JxDocument)) {
        pageReport.add({
          severity: "error",
          code: "page.binding-misplaced",
          message: `A \${…} sits in ${misplaced.position} (${misplaced.path || "page"}), where the build never evaluates it.`,
          where,
          url,
          data: { ...misplaced },
        });
      }

      for (const found of pageReport.entries()) addEntry(post, url, found);
      files.push({ path: route.file, content: `${JSON.stringify(doc, null, 2)}\n` });
      pages.push({ id: post.id, route: route.jxRoute, file: route.file, layout });
      for (const tag of components) used.components.add(tag);
      for (const name of collectWpClasses(nodes)) used.wpClasses.add(name);
      for (const key of wanted) used.states.add(key);
      used.hoisted.push(...hoisted.filter((rule) => !placed.unplaced.includes(rule)));
      used.documentRules.push(...placed.unplaced);
    } catch (error) {
      // One page that cannot be built (a resolver another module wrote, a malformed value) must not
      // cost the run every other page: what was found about it so far is kept, and the page is lost.
      for (const found of pageReport.entries()) addEntry(post, url, found);
      skip(post, {
        severity: "error",
        code: "page.convert-failed",
        message: `The page could not be built after its conversion (${error instanceof Error ? error.message : String(error)}); it is not written.`,
        url,
      });
    }
  }

  used.hoisted = dedupeRules(used.hoisted);
  used.documentRules = dedupeRules(used.documentRules);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  pages.sort(byFile);
  skipped.sort((a, b) => a.id - b.id);
  return { files, pages, skipped, used, report };
}
