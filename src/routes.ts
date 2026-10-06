/**
 * Routes: where every public WordPress object lives on the source site, where it lives in the Jx
 * site, and which Jx file renders it. Redirects (`emit/redirects.ts`) and every link a converter
 * writes (`ConvertCtx.urlFor`, `ConvertCtx.rewriteUrl`) are derived from the table built here.
 *
 * ## What WordPress does (read from wp-includes, not from memory)
 *
 * - A page is at `get_page_uri()`: its slug behind the slugs of its ancestors, whatever the status of
 *   an ancestor (a draft parent with a name still lends it; one with no name lends nothing). The
 *   page structure is `%pagename%` alone: the permalink structure's front never reaches a page.
 *   `page_on_front` is served at `/`, and its own slug URL is a 301 to `/` (`get_page_link`; the live
 *   site confirms it), so that URL is an alias of the front route rather than a route of its own.
 * - A post is at the permalink structure with the tags `%year% %monthnum% %day% %hour% %minute%
 *   %second% %post_id% %postname% %category% %author%` replaced, and nothing else: `get_permalink`
 *   has no `%tag%` (it stays in the URL as typed), so a structure carrying one, or any other tag,
 *   is reported and its posts are not routed. The date parts are the stored LOCAL `post_date`.
 *   `%category%` is the post's category with the lowest term id, behind the slugs of its ancestors
 *   (`get_category_parents`), and where the post has none, the default category. Rank Math's primary
 *   category replaces "lowest id" when the post type's primary taxonomy is on and the primary is one
 *   of the post's own categories (its `post_link_category` filter).
 * - A custom post type's permastruct is `<rewrite slug>/%<type>%`, with the permalink front before
 *   it when `with_front` is true (ACF writes `with_front` only when it is false), the rewrite root
 *   otherwise. A hierarchical type puts `get_page_uri()` where the slug goes. Its archive, when
 *   `has_archive` is set, is the archive slug (the rewrite slug when `has_archive` is `true`) behind
 *   the same prefix.
 * - A term is at `<base>/<slug>` behind the same prefix, the base being the taxonomy's rewrite slug;
 *   a hierarchical rewrite puts the whole ancestor chain in the slug position, and a flat one does
 *   not, whatever the taxonomy's own `hierarchical` says (fineline's `location` is hierarchical and
 *   its child terms are at `/service_area/<slug>/`). `category` and `post_tag` take `category_base`
 *   and `tag_base`, and keep the front only when no base is set (`create_initial_taxonomies`).
 *   Rank Math's "strip category base" removes the base again.
 * - An author is at `<front or /><author_base>/<nicename>`; Rank Math's `url_author_base` replaces
 *   the base and drops the front (`class-rewrite.php`), which is why anabaptistperspectives has
 *   `/people/<slug>/`. Only an author with a published post has anything on the archive.
 * - An attachment page is `<parent permalink><slug>/`, or `/<slug>/` with no parent
 *   (`get_attachment_link`); `attachment/<slug>` where the slug is a number or the permalink
 *   structure holds `%category%`. Rank Math answers it with a 301 to the parent's permalink, or to
 *   `attachment_redirect_default` with no parent, while its "redirect attachments" setting is on.
 * - A post's old slugs (`_wp_old_slug`) are redirected by WordPress to its current permalink, so
 *   each is an alias of the route, except for a hierarchical type (`wp_old_slug_redirect` returns
 *   before looking at one). On the live sites that holds for flat custom post types and for posts
 *   behind a static front (anabaptistperspectives), and not for fineline's posts under a root
 *   `/%postname%/` (3 of 3 checked answered 404), so there the aliases give a few more redirects
 *   than the old site did, never fewer.
 * - Rank Math's options (author base, category-base stripping, attachment redirects, disabled
 *   author archives) apply only while the plugin is active: a deactivated one leaves its options in
 *   `wp_options` and WordPress does not read them.
 * - When two of these meet on one URL the first rewrite rule wins and the other is unreachable:
 *   CPT archives, then the extra permastructs (taxonomy terms and CPT entries), then authors, then
 *   pages before posts when the structure starts with `%postname%`, `%category%`, `%tag%` or
 *   `%author%` and posts before pages otherwise (`rewrite_rules()`, `init()`).
 *
 * ## What the Jx site does with it
 *
 * Every path is kept where Jx can serve it. A page is `pages/<uri>.json` (the front page
 * `pages/index.json`); a page whose last segment is `index` goes to `pages/<uri>/index/index.json`,
 * because `pages/<uri>/index.json` would be its parent. A segment starting with `_` is not routed by
 * Jx, so it is renamed (leading underscores dropped) and the old path becomes a redirect.
 *
 * Posts and custom-type entries are content entries (`content/<type>/<entryId>.md`), and the entry
 * id is the path BELOW the static base of their URL: `/project/foo/` is entry `foo`, and a
 * hierarchical type's `/service/a/b/` is entry `a/b`, so `$paths` (`{contentType, param}`, the
 * default `field` is the id) generates the URL back. One dynamic page per base renders them,
 * `pages/<base>/[slug].json` when every entry id is one segment and `pages/<base>/[...path].json`
 * when any is nested (a permalink structure with dates, a type with real parents). Terms and
 * authors are rendered by the same kind of page, their `$paths` a `values` list of slugs.
 * {@link RouteTable.dynamicPages} says which file renders what and what its `$paths` is.
 * Two kinds that want one base (the rewrite slug of a type and of a taxonomy) cannot share it; the
 * later by WordPress's own order is dropped and reported, as is any URL two objects claim. An
 * object that lost its address to another still has an answer from `forPost` / `forTerm` / ...: the
 * winner's route, because WordPress served the winner at that address (a menu item for the
 * `/services/` page leads to the services archive); it is not in `all()` and no dynamic page lists
 * it. An object with no address WordPress could have served (no slug, a date nothing can read where
 * the structure needs one) is reported as `route.unroutable` and has no route at all.
 *
 * What is not shipped is reported, once each: date archives, pagination, feeds and search.
 */
import { planMedia, type MediaPlan } from "./media.ts";
import { maybeUnserialize } from "./wp/phpser.ts";
import { termsOf } from "./wp/model.ts";
import type { AcfModel, AcfPostType, AcfTaxonomy } from "./wp/acf.ts";
import type { Report, WpModel, WpPost, WpTerm } from "./types.ts";

// ── Contract ─────────────────────────────────────────────────────────────────────────────────────

export type RouteKind =
  | "page"
  | "front"
  | "posts-page"
  | "entry"
  | "term"
  | "post-archive"
  | "author"
  | "attachment";

export interface Route {
  kind: RouteKind;
  /**
   * The post id (page, front, posts-page, entry, attachment; 0 for the blog index of a site that
   * shows its posts on the front), the term id, the user id of an author, or the post type of a
   * `post-archive`.
   */
  id: number | string;
  /**
   * Where the object was on the source site: leading and trailing slash, `/` for the home page. It
   * is kept as WordPress wrote it (a non-ASCII slug stays percent-encoded), so compare with
   * {@link pathKey}. A site on plain permalinks has no path to keep and this is the query form
   * (`/?p=12`).
   */
  wpPath: string;
  /**
   * Where it is in the Jx site (decoded, leading and trailing slash). For an `attachment` it is
   * where the attachment page now leads: the parent's route or the media file.
   */
  jxRoute: string;
  /**
   * The Jx file: the page file for `page`, `front` and `posts-page` and for a `post-archive`; the
   * content file `content/<collection>/<entryId>.md` for an `entry`; the dynamic page that renders
   * it for a `term` and an `author`; the media file for an `attachment` that leads to one (the
   * parent's file otherwise).
   */
  file: string;
  /** The content collection of an `entry` (its post type). */
  collection?: string;
  /** Why `jxRoute` differs from `wpPath`, when it does. */
  reason?: string;
  /** The post type of a page/entry/archive, the taxonomy of a term. */
  type?: string;
  /** The entry's id in its collection: the path of its URL below the static base of its type. */
  entryId?: string;
  /** Other WordPress paths that end up here: the front page's own slug URL, an old slug. */
  aliases?: string[];
}

/** The page file that renders a family of dynamic routes, and the `$paths` that generates them. */
export interface DynamicPage {
  /** `pages/project/[slug].json`. */
  file: string;
  /** The Jx URL pattern of the file: `/project/:slug`, `/essays/*`. */
  pattern: string;
  /** Where the URLs come from. */
  kind: "entries" | "terms" | "authors";
  /** The collection (entries), the taxonomy (terms) or `author`. */
  source: string;
  /** The route parameter: `slug` for a flat family, `path` where an id has a slash in it. */
  param: "slug" | "path";
  /** The `$paths` value of the page. */
  paths: { contentType: string; param: string } | { values: string[]; param: string };
  /** The routes it renders. */
  routes: readonly Route[];
}

export interface RouteTable {
  all(): readonly Route[];
  /** Any WordPress path, however written (case, slashes, percent-encoding, query and fragment ignored); aliases included. */
  byWpPath(path: string): Route | undefined;
  /** A page, entry or attachment by post id; the front page and the posts page too. */
  forPost(id: number): Route | undefined;
  forTerm(id: number): Route | undefined;
  /** A custom post type's archive by post type, and `post` for the blog index. */
  forArchive(key: string): Route | undefined;
  forAuthor(id: number): Route | undefined;
  dynamicPages(): readonly DynamicPage[];
  /** Whether WordPress ended its URLs with a slash (the permalink structure does). */
  readonly trailingSlash: boolean;
}

export interface RouteOptions {
  report?: Report | undefined;
  /** Where an attachment page leads when it is not sent to its parent. Default: the real plan of the model. */
  media?: MediaPlan | undefined;
  /** The author base. Default: Rank Math's `url_author_base`, else `author`. */
  authorBase?: string | undefined;
  /** Give attachment pages a route (so they redirect). Default true. */
  attachments?: boolean | undefined;
  /** Post statuses that have a public page. Default `["publish"]`. */
  statuses?: readonly string[] | undefined;
  /**
   * Post types registered in code, which ACF knows nothing about: the rewrite of each. Anything not
   * listed here and not an ACF type is reported and left out.
   */
  postTypes?:
    | Readonly<
        Record<
          string,
          Partial<
            Pick<
              AcfPostType,
              "hierarchical" | "hasArchive" | "rewriteSlug" | "rewriteWithFront" | "public"
            >
          >
        >
      >
    | undefined;
  /** The content collection of a post type. Default: the type. */
  collection?: ((postType: string) => string) | undefined;
}

// ── Paths ────────────────────────────────────────────────────────────────────────────────────────

const slashes = (s: string): string => s.replace(/^\/+|\/+$/g, "");

/** `decodeURIComponent` that leaves a segment it cannot decode (a stray `%`) as it is. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A WordPress path as a lookup key: percent-escapes decoded, case folded, redundant slashes
 * dropped, one slash at each end. Query string and fragment are not part of it.
 */
export function pathKey(path: string): string {
  const bare = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").replace(/[?#].*$/s, "");
  const segments = bare
    .split("/")
    .filter((s) => s !== "")
    .map((s) => decodeSegment(s).normalize("NFC").toLowerCase());
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

const segmentsOf = (path: string): string[] => slashes(path).split("/").filter(Boolean);
const toPath = (segments: readonly string[]): string =>
  segments.length === 0 ? "/" : `/${segments.join("/")}/`;

/** Characters a decoded segment may not carry into a file name or a URL path. */
const UNSAFE_SEGMENT = /[\\/?#%<>:*"|\p{Cc}]/u;

/** A WordPress path segment as the Jx site spells it: readable (decoded) unless that would be unsafe. */
function jxSegment(segment: string): string {
  const decoded = decodeSegment(segment).normalize("NFC");
  return UNSAFE_SEGMENT.test(decoded) ? segment : decoded;
}

const rank = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── PHP-shaped settings ──────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Rank Math's own reading of a setting: `on`/`off` are booleans, and everything else is PHP-truthy. */
function enabled(value: unknown): boolean {
  if (value === "off" || value === "" || value === "0" || value === 0) return false;
  return value !== undefined && value !== null && value !== false;
}

function optionRecord(model: WpModel, name: string): Record<string, unknown> {
  const raw = model.options.get(name);
  const parsed = raw === undefined ? undefined : maybeUnserialize(raw);
  return isRecord(parsed) ? parsed : {};
}

// ── Local dates ──────────────────────────────────────────────────────────────────────────────────

/**
 * `post_date` as WordPress has it: the UTC instant of `post.date` read on the site's own clock. A
 * date nothing can read (`""`, `0000-00-00 00:00:00`, an offset that leaves the representable range)
 * has no parts, and a post whose address needs them has no address.
 */
function localParts(model: WpModel, iso: string): Record<string, string> | undefined {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return undefined;
  const zone = (model.options.get("timezone_string") ?? "").trim();
  const offset = Number((model.options.get("gmt_offset") ?? "").trim() || 0);
  if (zone !== "") {
    try {
      const parts: Record<string, string> = {};
      for (const { type, value } of new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).formatToParts(instant))
        parts[type] = value;
      return {
        year: parts.year ?? "",
        monthnum: parts.month ?? "",
        day: parts.day ?? "",
        hour: parts.hour ?? "",
        minute: parts.minute ?? "",
        second: parts.second ?? "",
      };
    } catch {
      // A zone PHP knows and the runtime does not: the numeric offset below is the best answer left.
    }
  }
  const wall = new Date(instant.getTime() + (Number.isFinite(offset) ? offset : 0) * 3_600_000);
  if (Number.isNaN(wall.getTime())) return undefined;
  const two = (n: number): string => String(n).padStart(2, "0");
  return {
    year: String(wall.getUTCFullYear()).padStart(4, "0"),
    monthnum: two(wall.getUTCMonth() + 1),
    day: two(wall.getUTCDate()),
    hour: two(wall.getUTCHours()),
    minute: two(wall.getUTCMinutes()),
    second: two(wall.getUTCSeconds()),
  };
}

// ── What routes ──────────────────────────────────────────────────────────────────────────────────

/** Post types that exist for WordPress, ACF, Cwicly or a plugin and have no page of their own. */
const INTERNAL_POST_TYPES = new Set([
  "attachment",
  "cc_block",
  "customize_changeset",
  "custom_css",
  "nav_menu_item",
  "oembed_cache",
  "revision",
  "scheduled-action",
  "user_request",
  "wp_block",
  "wp_font_face",
  "wp_font_family",
  "wp_global_styles",
  "wp_navigation",
  "wp_template",
  "wp_template_part",
]);

interface TypeInfo {
  hierarchical: boolean;
  hasArchive: boolean | string;
  rewriteSlug: string | false;
  withFront: boolean;
  public: boolean;
}

interface TaxInfo {
  name: string;
  rewriteSlug: string | false;
  withFront: boolean;
  hierarchical: boolean;
  /** Where Rank Math's "strip category base" moved the URL from, when it did. */
  strippedFrom?: string;
}

/** The order WordPress tries rewrite rules in (lower wins), see the module header. */
const RANK = {
  front: 0,
  archive: 1,
  entry: 2,
  term: 3,
  author: 4,
  /** Pages and posts swap places with the permalink structure. */
  first: 5,
  second: 6,
  attachment: 7,
} as const;

interface Candidate {
  route: Route;
  rank: number;
  /** The WordPress paths this candidate claims besides its own `wpPath`. */
  aliases: string[];
  /** Entries, terms and authors are rendered by a dynamic page under `base`. */
  dyn?: { base: string[]; rest: string[]; kind: DynamicPage["kind"]; source: string };
}

const KIND_ORDER: Record<RouteKind, number> = {
  front: 0,
  "posts-page": 1,
  page: 2,
  "post-archive": 3,
  entry: 4,
  term: 5,
  author: 6,
  attachment: 7,
};

const idKey = (id: number | string): number => (typeof id === "number" ? id : 0);

/** The slugs of the ancestors of a term or page-like post, root first, ending with its own. */
function chain<T extends { id: number; parent: number }>(
  start: T,
  lookup: (id: number) => T | undefined,
  name: (item: T) => string,
): string[] {
  const out = [name(start)];
  const seen = new Set<number>([start.id]);
  let parent = start.parent;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const next = lookup(parent);
    // WordPress keeps walking only through ancestors that exist, and skips one that has no name.
    if (!next) break;
    if (name(next) !== "") out.unshift(name(next));
    parent = next.parent;
  }
  return out;
}

/** `get_page_uri()`: the slug behind the slugs of its ancestors. */
function pageUri(model: WpModel, post: WpPost): string[] {
  return chain(
    post,
    (id) => model.posts.get(id),
    (p) => p.slug,
  );
}

function termChain(model: WpModel, term: WpTerm): string[] {
  const out = [term.slug];
  const seen = new Set<number>([term.termId]);
  let parent = term.parent;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const next = model.terms.get(parent);
    if (!next || next.taxonomy !== term.taxonomy) break;
    out.unshift(next.slug);
    parent = next.parent;
  }
  return out;
}

/** Everything the collectors share: the site's settings, read once. */
interface Plan {
  model: WpModel;
  acf: AcfModel;
  report: Report | undefined;
  options: RouteOptions;
  /** The structure in force: a site on plain permalinks is given the one WordPress offers first. */
  structure: string;
  plain: boolean;
  /** The text before the first tag, as path segments (`essays`). */
  front: string[];
  /** `index.php` for a site that has it in every URL, else nothing. */
  root: string[];
  trailing: boolean;
  statuses: ReadonlySet<string>;
  verbose: boolean;
  collection: (postType: string) => string;
  rankMath: { titles: Record<string, unknown>; general: Record<string, unknown> };
}

function makePlan(model: WpModel, acf: AcfModel, options: RouteOptions): Plan {
  const stored = model.site.permalinkStructure.trim();
  const plain = stored === "";
  const structure = plain ? "/%postname%/" : stored;
  const firstTag = structure.indexOf("%");
  const front = segmentsOf(firstTag < 0 ? "" : structure.slice(0, firstTag));
  const indexed = /^\/*index\.php(?:\/|$)/i.test(structure);
  return {
    model,
    acf,
    report: options.report,
    options,
    structure,
    plain,
    front,
    root: indexed ? ["index.php"] : [],
    trailing: structure.endsWith("/"),
    statuses: new Set(options.statuses ?? ["publish"]),
    verbose: /^[^%]*%(?:postname|category|tag|author)%/.test(structure),
    collection: options.collection ?? ((type) => type),
    // A deactivated plugin leaves its options in the table and WordPress does not read them.
    rankMath: model.site.activePlugins.some((p) => p.startsWith("seo-by-rank-math"))
      ? {
          titles: optionRecord(model, "rank-math-options-titles"),
          general: optionRecord(model, "rank-math-options-general"),
        }
      : { titles: {}, general: {} },
  };
}

/** The ACF definition of a post type, or what the caller said about one registered in code. */
function typeInfo(plan: Plan, type: string): TypeInfo | "inactive" | undefined {
  const acf = plan.acf.postTypes.get(type);
  if (acf) {
    if (!acf.active) return "inactive";
    return {
      hierarchical: acf.hierarchical,
      hasArchive: acf.hasArchive,
      rewriteSlug: acf.rewriteSlug,
      withFront: acf.rewriteWithFront,
      public: acf.public,
    };
  }
  const given = plan.options.postTypes?.[type];
  if (!given) return undefined;
  return {
    hierarchical: given.hierarchical ?? false,
    hasArchive: given.hasArchive ?? false,
    rewriteSlug: given.rewriteSlug ?? type,
    withFront: given.rewriteWithFront ?? true,
    public: given.public ?? true,
  };
}

const DATE_TAGS = ["year", "monthnum", "day", "hour", "minute", "second"];

/** The tags of a permalink structure WordPress replaces (`get_permalink`'s `$rewritecode`). */
const KNOWN_TAGS = new Set([
  "year",
  "monthnum",
  "day",
  "hour",
  "minute",
  "second",
  "postname",
  "post_id",
  "category",
  "author",
  "pagename",
]);

function fill(
  structure: string,
  values: Record<string, string>,
): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const text = structure.replace(/%([a-z_]+)%/gi, (whole, name: string) => {
    if (KNOWN_TAGS.has(name)) return values[name] ?? "";
    unknown.push(whole);
    return whole;
  });
  return { text, unknown };
}

/** A segment Jx would not route (a leading underscore) turned into one it does. */
function routable(segment: string): string {
  const stripped = segment.replace(/^_+/, "");
  return stripped === "" ? "x" : stripped;
}

const pageFile = (segments: readonly string[]): string => {
  if (segments.length === 0) return "pages/index.json";
  return segments.at(-1) === "index"
    ? `pages/${segments.join("/")}/index.json`
    : `pages/${segments.join("/")}.json`;
};

// ── Collecting candidates ────────────────────────────────────────────────────────────────────────

/** Things left out, grouped so the report says it once per kind and not once per post. */
interface Skips {
  byTypeStatus: Map<string, number[]>;
  unregistered: Map<string, number[]>;
  inactive: Map<string, number[]>;
  private: Map<string, number[]>;
}

function note(map: Map<string, number[]>, key: string, id: number): void {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

function fail(plan: Plan, post: WpPost, message: string, data?: Record<string, unknown>): void {
  plan.report?.add({
    severity: "error",
    code: "route.unroutable",
    message,
    where: `post:${post.id}`,
    ...(data ? { data } : {}),
  });
}

/** An object that is not a post and has no address WordPress could have served: said, never skipped silently. */
function unroutable(
  plan: Plan,
  where: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  plan.report?.add({
    severity: "error",
    code: "route.unroutable",
    message,
    where,
    ...(data ? { data } : {}),
  });
}

function sourceUrl(plan: Plan, post: Pick<WpPost, "id">): string {
  return `${plan.model.site.home}/?p=${post.id}`;
}

const withoutIndex = (plan: Plan, segments: readonly string[]): string[] =>
  plan.root.length > 0 && segments[0] === "index.php" ? segments.slice(1) : [...segments];

/** Segments of a jx route: readable, and with nothing Jx would refuse to route. */
function jxSegments(
  plan: Plan,
  segments: readonly string[],
  fixable: number,
): { segments: string[]; renamed: string[] } {
  const renamed: string[] = [];
  const out = withoutIndex(plan, segments).map((segment, i) => {
    const readable = jxSegment(segment);
    if (i < fixable && /^[_]/.test(readable)) {
      const fixed = routable(readable);
      renamed.push(`${readable} -> ${fixed}`);
      return fixed;
    }
    return readable;
  });
  return { segments: out, renamed };
}

/** The `.`, `..` and empty segments a file name cannot be. */
const badSegment = (segment: string): boolean =>
  segment === "" || segment === "." || segment === "..";

function collectPages(plan: Plan, out: Candidate[], skips: Skips): void {
  const { model } = plan;
  const { site } = model;
  const frontId = site.showOnFront === "page" ? site.pageOnFront : 0;
  const postsId = site.showOnFront === "page" ? site.pageForPosts : 0;
  let frontSeen = false;

  for (const post of model.posts.values()) {
    if (post.type !== "page") continue;
    if (!plan.statuses.has(post.status)) {
      note(
        post.status === "private" ? skips.private : skips.byTypeStatus,
        `page/${post.status}`,
        post.id,
      );
      continue;
    }
    const uri = pageUri(model, post);
    if (post.slug === "" || uri.some((s) => s === "")) {
      fail(plan, post, "The page has no slug, so it has no address and cannot be routed.");
      continue;
    }
    const isFront = post.id === frontId;
    const isPosts = !isFront && post.id === postsId;
    frontSeen ||= isFront;
    const own = plan.plain ? `/?page_id=${post.id}` : toPath([...plan.root, ...uri]);
    const { segments, renamed } = jxSegments(plan, uri, uri.length);
    if (segments.some(badSegment)) {
      fail(plan, post, "A segment of the page's address cannot be a file name.", { uri });
      continue;
    }
    const jx = isFront ? [] : segments;
    const route: Route = {
      kind: isFront ? "front" : isPosts ? "posts-page" : "page",
      id: post.id,
      wpPath: isFront ? "/" : own,
      jxRoute: toPath(jx),
      file: pageFile(jx),
      type: "page",
    };
    const reasons: string[] = [];
    if (isFront) reasons.push("front page: its own address redirects to /");
    if (plan.plain && !isFront) reasons.push("the source site uses plain permalinks");
    if (renamed.length > 0)
      reasons.push(
        `Jx does not route a segment that starts with an underscore (${renamed.join(", ")})`,
      );
    if (reasons.length > 0 && (route.wpPath !== route.jxRoute || renamed.length > 0))
      route.reason = reasons.join("; ");
    out.push({
      route,
      rank: isFront ? RANK.front : plan.verbose ? RANK.first : RANK.second,
      aliases: isFront ? [own] : [],
    });
    if (renamed.length > 0) {
      plan.report?.add({
        severity: "warn",
        code: "route.renamed",
        message: `A path segment starts with an underscore, which Jx does not route; the page is at ${route.jxRoute} and its old address redirects there.`,
        where: `post:${post.id}`,
        url: sourceUrl(plan, post),
        data: { renamed },
      });
    }
  }

  if (site.showOnFront === "page" && frontId > 0 && !frontSeen) {
    plan.report?.add({
      severity: "warn",
      code: "route.front-missing",
      message: `The page_on_front option names page ${frontId}, which is not a published page; the home page has no content.`,
      where: "option:page_on_front",
    });
  }
  if (site.showOnFront === "posts") {
    out.push({
      route: {
        kind: "posts-page",
        id: 0,
        wpPath: "/",
        jxRoute: "/",
        file: "pages/index.json",
        type: "post",
      },
      rank: RANK.front,
      aliases: [],
    });
  }
}

/** Slugs of the categories in the chain `get_category_parents` walks, root first, ending with the term's own. */
function categoryPath(plan: Plan, post: WpPost): string[] | undefined {
  const { model } = plan;
  const cats = termsOf(model, post.id, "category").sort((a, b) => a.termId - b.termId);
  let chosen: WpTerm | undefined = cats[0];
  const primary = Number(model.postMeta.get(post.id)?.rank_math_primary_category?.[0]);
  if (
    chosen &&
    primary > 0 &&
    enabled(plan.rankMath.titles[`pt_${post.type}_primary_taxonomy`]) &&
    cats.some((c) => c.termId === primary)
  ) {
    chosen = model.terms.get(primary) ?? chosen;
  }
  if (chosen) return termChain(model, chosen);
  // A post with no category gets the default category's slug alone: `get_permalink` does not walk
  // its parents there, as it does for a category the post has.
  const fallback = model.terms.get(Number(model.options.get("default_category") ?? 0));
  return fallback?.taxonomy === "category" ? [fallback.slug] : undefined;
}

function entryRoute(
  plan: Plan,
  post: WpPost,
  base: readonly string[],
  rest: readonly string[],
  wp: string,
  info: { type: string; ranked: number },
): Candidate | undefined {
  const { segments: jxBase, renamed } = jxSegments(plan, base, base.length);
  const jxRest = rest.map(jxSegment);
  if (jxRest.length === 0 || jxRest.some(badSegment)) {
    fail(plan, post, "The address of the entry has a segment that cannot be a file name.", {
      path: [...base, ...rest].join("/"),
    });
    return undefined;
  }
  const entryId = jxRest.join("/");
  const collection = plan.collection(info.type);
  const route: Route = {
    kind: "entry",
    id: post.id,
    wpPath: wp,
    jxRoute: toPath([...jxBase, ...jxRest]),
    file: `content/${collection}/${entryId}.md`,
    collection,
    type: info.type,
    entryId,
  };
  const reasons: string[] = [];
  if (wp.includes("?"))
    reasons.push(
      plan.plain
        ? "the source site uses plain permalinks"
        : "the post type has pretty permalinks switched off",
    );
  if (renamed.length > 0)
    reasons.push(
      `Jx does not route a segment that starts with an underscore (${renamed.join(", ")})`,
    );
  if (reasons.length > 0) route.reason = reasons.join("; ");
  return {
    route,
    rank: info.ranked,
    aliases: [],
    dyn: { base: jxBase, rest: jxRest, kind: "entries", source: collection },
  };
}

/**
 * The slugs a post had before (`_wp_old_slug`): WordPress redirects them to the current permalink.
 * One that is the current slug is harmless, because a live address always beats an alias.
 */
function oldSlugs(plan: Plan, post: WpPost): string[] {
  const values = plan.model.postMeta.get(post.id)?._wp_old_slug ?? [];
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v !== ""))];
}

function collectEntries(plan: Plan, out: Candidate[], skips: Skips): void {
  const { model } = plan;
  const structureTags = [...plan.structure.matchAll(/%([a-z_]+)%/gi)].map((m) => m[1] ?? "");
  const badTags = [...new Set(structureTags.filter((t) => !KNOWN_TAGS.has(t)))];
  let badTagReported = false;
  const reportedTypes = new Set<string>();

  for (const post of model.posts.values()) {
    const type = post.type;
    if (type === "page" || type === "attachment" || INTERNAL_POST_TYPES.has(type)) continue;
    if (type.startsWith("acf-")) continue;
    if (!plan.statuses.has(post.status)) {
      note(
        post.status === "private" ? skips.private : skips.byTypeStatus,
        `${type}/${post.status}`,
        post.id,
      );
      continue;
    }

    if (type === "post") {
      if (badTags.length > 0) {
        if (!badTagReported) {
          badTagReported = true;
          plan.report?.add({
            severity: "error",
            code: "route.permalink-tag",
            message: `The permalink structure ${plan.structure} has ${badTags.map((t) => `%${t}%`).join(", ")}, which WordPress does not replace (get_permalink knows year, monthnum, day, hour, minute, second, post_id, postname, category and author, and leaves any other tag in the URL as typed); posts have no address that can be computed and are not routed.`,
            where: "option:permalink_structure",
            data: { structure: plan.structure, tags: badTags },
          });
        }
        continue;
      }
      if (post.slug === "") {
        fail(plan, post, "The post has no slug, so it has no address and cannot be routed.");
        continue;
      }
      const needsDate = DATE_TAGS.some((tag) => plan.structure.includes(`%${tag}%`));
      const dateParts = needsDate ? localParts(model, post.date) : {};
      if (!dateParts) {
        fail(
          plan,
          post,
          `The post's date (${JSON.stringify(post.date)}) is not a date WordPress could have written into its permalink (${plan.structure}), so its address cannot be computed.`,
          { date: post.date },
        );
        continue;
      }
      const values = (
        slug: string,
        cat: string[] | undefined,
      ): Record<string, string> | undefined => {
        const author = model.users.get(post.authorId)?.slug ?? "";
        if (plan.structure.includes("%category%") && (!cat || cat.length === 0)) return undefined;
        if (plan.structure.includes("%author%") && author === "") return undefined;
        return {
          ...dateParts,
          postname: slug,
          pagename: slug,
          post_id: String(post.id),
          category: (cat ?? []).join("/"),
          author,
        };
      };
      const cat = plan.structure.includes("%category%") ? categoryPath(plan, post) : undefined;
      const main = values(post.slug, cat);
      if (!main) {
        fail(
          plan,
          post,
          "The post has no category or no author to put in its permalink (%category% or %author%), so its address cannot be computed.",
        );
        continue;
      }
      const filled = fill(plan.structure, main).text;
      const segs = segmentsOf(filled);
      const base = plan.front;
      const rest = segs.slice(base.length);
      const cand = entryRoute(
        plan,
        post,
        base,
        rest,
        plan.plain ? `/?p=${post.id}` : toPath(segs),
        {
          type,
          ranked: plan.verbose ? RANK.second : RANK.first,
        },
      );
      if (!cand) continue;
      for (const old of oldSlugs(plan, post)) {
        const v = values(old, cat);
        if (v) cand.aliases.push(toPath(segmentsOf(fill(plan.structure, v).text)));
      }
      out.push(cand);
      continue;
    }

    const info = typeInfo(plan, type);
    if (info === undefined) {
      note(skips.unregistered, type, post.id);
      continue;
    }
    if (info === "inactive") {
      note(skips.inactive, type, post.id);
      continue;
    }
    if (!info.public) {
      note(skips.byTypeStatus, `${type}/not-public`, post.id);
      continue;
    }
    const slugOf = (slug: string): string[] =>
      info.hierarchical ? [...pageUri(model, post).slice(0, -1), slug] : [slug];
    const slugSegs = slugOf(post.slug);
    if (post.slug === "" || slugSegs.some((s) => s === "")) {
      fail(plan, post, "The entry has no slug, so it has no address and cannot be routed.");
      continue;
    }
    const prefix = info.withFront ? plan.front : plan.root;
    let base: string[];
    let wp: string;
    if (info.rewriteSlug === false) {
      base = [type];
      wp = `/?${type}=${post.slug}`;
    } else {
      if (info.rewriteSlug.includes("%")) {
        if (!reportedTypes.has(type)) {
          reportedTypes.add(type);
          plan.report?.add({
            severity: "error",
            code: "route.rewrite-tag",
            message: `The rewrite slug of the post type ${type} (${info.rewriteSlug}) holds a rewrite tag, which only a plugin can replace; its entries are not routed.`,
            where: `post-type:${type}`,
          });
        }
        continue;
      }
      base = [...prefix, ...segmentsOf(info.rewriteSlug)];
      wp = toPath([...base, ...slugSegs]);
    }
    const cand = entryRoute(
      plan,
      post,
      base,
      slugSegs,
      plan.plain ? `/?${type}=${post.slug}` : wp,
      {
        type,
        // ACF registers its types on `init` at priority 5, before a plugin's, and the earlier rule wins.
        ranked: plan.acf.postTypes.has(type) ? RANK.entry : RANK.entry + 0.5,
      },
    );
    if (!cand) continue;
    // `wp_old_slug_redirect` returns before looking for a hierarchical type: its old slugs are 404s.
    if (info.rewriteSlug !== false && !info.hierarchical) {
      for (const old of oldSlugs(plan, post)) cand.aliases.push(toPath([...base, ...slugOf(old)]));
    }
    out.push(cand);
  }
}

function taxonomies(plan: Plan): Map<string, TaxInfo> {
  const { model, acf } = plan;
  const out = new Map<string, TaxInfo>();
  const indexed = plan.root.length > 0;
  const categoryBase = slashes((model.options.get("category_base") ?? "").trim());
  const tagBase = slashes((model.options.get("tag_base") ?? "").trim());
  out.set("category", {
    name: "category",
    rewriteSlug: categoryBase || "category",
    withFront: categoryBase === "" || indexed,
    hierarchical: true,
  });
  out.set("post_tag", {
    name: "post_tag",
    rewriteSlug: tagBase || "tag",
    withFront: tagBase === "" || indexed,
    hierarchical: false,
  });
  for (const tax of acf.taxonomies.values()) {
    if (!tax.active || !tax.public || out.has(tax.slug)) continue;
    out.set(tax.slug, acfTaxonomy(tax));
  }
  return out;
}

const acfTaxonomy = (tax: AcfTaxonomy): TaxInfo => ({
  name: tax.slug,
  rewriteSlug: tax.rewriteSlug,
  withFront: tax.rewriteWithFront,
  hierarchical: tax.rewriteHierarchical,
});

/** Taxonomies of WordPress itself and of its tooling that never have an archive page. */
const INTERNAL_TAXONOMIES = new Set([
  "nav_menu",
  "link_category",
  "post_format",
  "wp_theme",
  "wp_template_part_area",
  "wp_pattern_category",
]);

function collectTerms(plan: Plan, out: Candidate[]): void {
  const { model } = plan;
  const infos = taxonomies(plan);
  const strip = enabled(plan.rankMath.general.strip_category_base);
  const unknown = new Map<string, number[]>();
  let strippedReported = false;
  const reportedTax = new Set<string>();

  for (const term of [...model.terms.values()].sort((a, b) => a.termId - b.termId)) {
    const info = infos.get(term.taxonomy);
    if (!info) {
      if (!INTERNAL_TAXONOMIES.has(term.taxonomy)) note(unknown, term.taxonomy, term.termId);
      continue;
    }
    if (term.slug === "") {
      unroutable(
        plan,
        `term:${term.termId}`,
        `The ${term.taxonomy} term has no slug, so it has no address and is not routed.`,
      );
      continue;
    }
    const slugSegs = info.hierarchical ? termChain(model, term) : [term.slug];
    const prefix = info.withFront ? plan.front : plan.root;
    let wp: string;
    let rawBase: string[];
    if (info.rewriteSlug === false) {
      rawBase = [term.taxonomy];
      wp =
        term.taxonomy === "category"
          ? `/?cat=${term.termId}`
          : term.taxonomy === "post_tag"
            ? `/?tag=${term.slug}`
            : `/?${term.taxonomy}=${term.slug}`;
    } else {
      if (info.rewriteSlug.includes("%")) {
        if (!reportedTax.has(term.taxonomy)) {
          reportedTax.add(term.taxonomy);
          plan.report?.add({
            severity: "error",
            code: "route.rewrite-tag",
            message: `The rewrite slug of the taxonomy ${term.taxonomy} (${info.rewriteSlug}) holds a rewrite tag, which only a plugin can replace; its terms are not routed.`,
            where: `taxonomy:${term.taxonomy}`,
          });
        }
        continue;
      }
      rawBase = [...prefix, ...segmentsOf(info.rewriteSlug)];
      wp = toPath([...rawBase, ...slugSegs]);
    }
    if (plan.plain)
      wp =
        term.taxonomy === "post_tag"
          ? `/?tag=${term.slug}`
          : term.taxonomy === "category"
            ? `/?cat=${term.termId}`
            : `/?${term.taxonomy}=${term.slug}`;
    // Rank Math's "strip category base" serves the term at the root; the Jx site keeps the base.
    if (term.taxonomy === "category" && strip && info.rewriteSlug !== false && !plan.plain) {
      wp = toPath([...plan.root, ...slugSegs]);
      if (!strippedReported) {
        strippedReported = true;
        plan.report?.add({
          severity: "warn",
          code: "route.category-base-stripped",
          message:
            "Rank Math strips the category base from category URLs. Jx cannot render terms and posts from one dynamic page at the root, so categories stay under their base in the migrated site and the stripped URLs redirect there.",
          where: "option:rank-math-options-general",
        });
      }
    }
    const fixed = jxSegments(plan, rawBase, rawBase.length);
    const jxBase = fixed.segments;
    const jxRest = slugSegs.map(jxSegment);
    if (jxRest.some(badSegment)) {
      unroutable(
        plan,
        `term:${term.termId}`,
        `A segment of the address of the ${term.taxonomy} term cannot be a file name, so it is not routed.`,
        { path: slugSegs.join("/") },
      );
      continue;
    }
    const route: Route = {
      kind: "term",
      id: term.termId,
      wpPath: wp,
      jxRoute: toPath([...jxBase, ...jxRest]),
      file: "",
      type: term.taxonomy,
    };
    const reasons: string[] = [];
    if (wp.includes("?"))
      reasons.push(
        plan.plain
          ? "the source site uses plain permalinks"
          : "the taxonomy has pretty permalinks switched off",
      );
    else if (term.taxonomy === "category" && strip)
      reasons.push("Rank Math stripped the category base on the source site");
    if (fixed.renamed.length > 0)
      reasons.push(
        `Jx does not route a segment that starts with an underscore (${fixed.renamed.join(", ")})`,
      );
    if (reasons.length > 0) route.reason = reasons.join("; ");
    out.push({
      route,
      rank: RANK.term,
      aliases: [],
      dyn: { base: jxBase, rest: jxRest, kind: "terms", source: term.taxonomy },
    });
  }

  for (const [taxonomy, ids] of unknown) {
    plan.report?.add({
      severity: "info",
      code: "route.taxonomy-unregistered",
      message: `The taxonomy ${taxonomy} is not registered through ACF or WordPress itself, so its ${ids.length} terms have no known address and are not routed (a plugin-internal taxonomy usually has no archive page).`,
      where: `taxonomy:${taxonomy}`,
      data: { terms: ids.length },
    });
  }
}

function collectArchives(plan: Plan, out: Candidate[]): void {
  const types = new Set([
    ...plan.acf.postTypes.keys(),
    ...Object.keys(plan.options.postTypes ?? {}),
  ]);
  for (const type of [...types].sort(rank)) {
    const info = typeInfo(plan, type);
    if (info === undefined || info === "inactive" || !info.public || info.hasArchive === false)
      continue;
    // WordPress registers no archive rule for a type with `rewrite` off: only `?post_type=` reaches it.
    const queryOnly = plan.plain || info.rewriteSlug === false;
    if (info.rewriteSlug === false) {
      plan.report?.add({
        severity: "info",
        code: "route.archive-plain",
        message: `The post type ${type} has an archive but pretty permalinks are switched off for it, so its address on the source site is /?post_type=${type}; the archive is at /${type}/ in the migrated site.`,
        where: `post-type:${type}`,
      });
    }
    const slug = info.hasArchive === true ? info.rewriteSlug || type : info.hasArchive;
    if (slug.includes("%")) {
      unroutable(
        plan,
        `post-type:${type}`,
        `The archive slug of the post type ${type} (${slug}) holds a rewrite tag, which only a plugin can replace; its archive is not routed.`,
      );
      continue;
    }
    const prefix = info.withFront ? plan.front : plan.root;
    const raw = [...prefix, ...segmentsOf(slug)];
    const wp = queryOnly ? `/?post_type=${type}` : toPath(raw);
    const { segments: jx, renamed } = jxSegments(plan, raw, raw.length);
    if (jx.length === 0 || jx.some(badSegment)) {
      unroutable(
        plan,
        `post-type:${type}`,
        `The archive address of the post type ${type} has a segment that cannot be a file name, so it is not routed.`,
        { path: raw.join("/") },
      );
      continue;
    }
    const route: Route = {
      kind: "post-archive",
      id: type,
      wpPath: wp,
      jxRoute: toPath(jx),
      file: pageFile(jx),
      type,
    };
    if (renamed.length > 0)
      route.reason = `Jx does not route a segment that starts with an underscore (${renamed.join(", ")})`;
    else if (wp.includes("?"))
      route.reason = plan.plain
        ? "the source site uses plain permalinks"
        : "the post type has pretty permalinks switched off";
    out.push({ route, rank: RANK.archive, aliases: [] });
  }
}

function collectAuthors(plan: Plan, out: Candidate[], authors: ReadonlyMap<number, number>): void {
  const { model } = plan;
  if (enabled(plan.rankMath.titles.disable_author_archives)) {
    plan.report?.add({
      severity: "info",
      code: "route.author-archives-disabled",
      message:
        "Rank Math has author archives switched off, so the source site has no author pages and none are routed.",
      where: "option:rank-math-options-titles",
    });
    return;
  }
  const rmBase = String(plan.rankMath.titles.url_author_base ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^%a-z0-9 _-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const given = plan.options.authorBase === undefined ? [] : segmentsOf(plan.options.authorBase);
  const base = given.length > 0 ? given : rmBase !== "" ? [rmBase] : [...plan.front, "author"];
  const { segments: jxBase, renamed } = jxSegments(plan, base, base.length);
  for (const user of [...model.users.values()].sort((a, b) => a.id - b.id)) {
    if (!authors.has(user.id)) continue;
    const jxRest = [jxSegment(user.slug)];
    if (user.slug === "" || jxRest.some(badSegment)) {
      unroutable(
        plan,
        `user:${user.id}`,
        `The author's nicename (${JSON.stringify(user.slug)}) cannot be a path segment, so the author archive is not routed.`,
        { slug: user.slug },
      );
      continue;
    }
    const route: Route = {
      kind: "author",
      id: user.id,
      wpPath: plan.plain ? `/?author=${user.id}` : toPath([...base, user.slug]),
      jxRoute: toPath([...jxBase, ...jxRest]),
      file: "",
      type: "author",
    };
    if (renamed.length > 0)
      route.reason = `Jx does not route a segment that starts with an underscore (${renamed.join(", ")})`;
    else if (plan.plain) route.reason = "the source site uses plain permalinks";
    out.push({
      route,
      rank: RANK.author,
      aliases: [],
      dyn: { base: jxBase, rest: jxRest, kind: "authors", source: "author" },
    });
  }
}

// ── Attachments ──────────────────────────────────────────────────────────────────────────────────

const isNumeric = (s: string): boolean => /^\d+$/.test(s);

/**
 * Where a visitor of an attachment page is sent. With Rank Math's "redirect attachments" on, the
 * parent's permalink, or the configured address for an attachment with no parent. Without it the
 * attachment page showed the file, so the Jx site leads to the file.
 */
function collectAttachments(
  plan: Plan,
  table: RouteTable,
  lookup: (url: string) => Route | undefined,
  out: Candidate[],
): void {
  const { model } = plan;
  if (plan.options.attachments === false) return;
  const redirecting = enabled(plan.rankMath.general.attachment_redirect_urls);
  const defaultUrl = String(plan.rankMath.general.attachment_redirect_default ?? "").trim();
  let media: MediaPlan | undefined = plan.options.media;
  const mediaPlan = (): MediaPlan => (media ??= planMedia(model));

  for (const post of [...model.posts.values()].sort((a, b) => a.id - b.id)) {
    if (post.type !== "attachment" || post.slug === "") continue;
    if (post.status !== "inherit" && post.status !== "publish") continue;
    const parentRoute = post.parent > 0 ? table.forPost(post.parent) : undefined;
    // An attachment of a page nobody can see has no page either.
    if (post.parent > 0 && model.posts.has(post.parent) && !parentRoute) continue;

    // `get_attachment_link` marks the address when `<permalink>/<int>/` would be read as a page number,
    // and when the structure holds %category% (its tail could be a category path).
    const name =
      isNumeric(post.slug) || plan.structure.includes("%category%")
        ? `attachment/${post.slug}`
        : post.slug;
    let wpPath: string;
    if (plan.plain) wpPath = `/?attachment_id=${post.id}`;
    else if (parentRoute) {
      // `_get_page_link` does not know the front page: it is `/<slug>/` for the purpose of this link.
      const parentPath =
        parentRoute.kind === "front" ? (parentRoute.aliases?.[0] ?? "/") : parentRoute.wpPath;
      wpPath = parentPath.includes("?")
        ? `/?attachment_id=${post.id}`
        : toPath([...segmentsOf(parentPath), ...name.split("/")]);
    } else wpPath = toPath(post.slug.split("/"));

    let jxRoute: string;
    let file: string;
    let why: string;
    const toFile = (route: Route | undefined): void => {
      jxRoute = route?.jxRoute ?? "/";
      file = route?.file ?? "pages/index.json";
    };
    if (redirecting) {
      if (parentRoute) {
        toFile(parentRoute);
        why = "attachment pages are not shipped; Rank Math sent them to the parent's permalink";
      } else {
        toFile(defaultUrl === "" ? undefined : lookup(defaultUrl));
        why =
          "attachment pages are not shipped; Rank Math sent an attachment with no parent to the configured address";
      }
    } else {
      const src = mediaPlan().mediaFor(post.id)?.src;
      if (src) {
        jxRoute = src;
        file = `public${src}`;
        why = "attachment pages are not shipped; the address leads to the media file";
      } else {
        toFile(parentRoute);
        why = "attachment pages are not shipped; the address leads to the page the file belongs to";
      }
    }
    out.push({
      route: {
        kind: "attachment",
        id: post.id,
        wpPath,
        jxRoute: jxRoute!,
        file: file!,
        type: "attachment",
        reason: why!,
      },
      rank: RANK.attachment,
      aliases: [],
    });
  }
}

// ── Resolving what the candidates claim ──────────────────────────────────────────────────────────

const wpKey = (path: string): string => (path.includes("?") ? path : pathKey(path));

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.rank - b.rank ||
    KIND_ORDER[a.route.kind] - KIND_ORDER[b.route.kind] ||
    idKey(a.route.id) - idKey(b.route.id) ||
    rank(String(a.route.id), String(b.route.id)) ||
    rank(a.route.wpPath, b.route.wpPath)
  );
}

function whereOf(route: Route): string {
  switch (route.kind) {
    case "term":
      return `term:${route.id}`;
    case "author":
      return `user:${route.id}`;
    case "post-archive":
      return `post-type:${route.id}`;
    default:
      return `post:${route.id}`;
  }
}

const urlOfRoute = (plan: Plan, route: Route): string => `${plan.model.site.home}${route.wpPath}`;

function collision(
  plan: Plan,
  loser: Route,
  winner: Route,
  message: string,
  data: Record<string, unknown> = {},
): void {
  plan.report?.add({
    severity: "warn",
    code: "route.collision",
    message,
    where: whereOf(loser),
    url: urlOfRoute(plan, loser),
    data: {
      loser: { kind: loser.kind, id: loser.id, wpPath: loser.wpPath, jxRoute: loser.jxRoute },
      winner: { kind: winner.kind, id: winner.id, wpPath: winner.wpPath, jxRoute: winner.jxRoute },
      ...data,
    },
  });
}

/** An object that lost its address to another: WordPress served the winner there, so the id resolves to the winner's route. */
interface Lost {
  loser: Route;
  winner: Route;
}

/**
 * Settles every address two objects claim, in four passes: the source site's own address (the first
 * rewrite rule wins, see the module header), the Jx route (two addresses that became one, by
 * dropping a leading underscore), the dynamic page that would have to render two kinds of object
 * (a page file renders one `$paths`), and the old addresses (an old slug never beats a live one).
 */
function resolveCandidates(
  plan: Plan,
  input: readonly Candidate[],
): { winners: Candidate[]; lost: Lost[] } {
  const sorted = [...input].sort(compareCandidates);

  const claimed = new Map<string, Candidate>();
  const unique: Candidate[] = [];
  const beaten: { loser: Route; winner: Candidate }[] = [];
  for (const cand of sorted) {
    const key = wpKey(cand.route.wpPath);
    const owner = claimed.get(key);
    if (owner) {
      beaten.push({ loser: cand.route, winner: owner });
      collision(
        plan,
        cand.route,
        owner.route,
        `Two objects have the address ${cand.route.wpPath} on the source site; WordPress serves the ${owner.route.kind}, so the ${cand.route.kind} was never reachable there and is not routed.`,
        { on: "wordpress-path" },
      );
      continue;
    }
    claimed.set(key, cand);
    unique.push(cand);
  }

  const jxClaimed = new Map<string, Candidate>();
  const distinct: Candidate[] = [];
  // An address that is its own Jx route outranks one that was renamed into it.
  const renamed = (c: Candidate): number =>
    Number(pathKey(c.route.wpPath) !== pathKey(c.route.jxRoute));
  for (const cand of [...unique].sort((a, b) => renamed(a) - renamed(b))) {
    const key = pathKey(cand.route.jxRoute);
    const owner = jxClaimed.get(key);
    if (owner) {
      collision(
        plan,
        cand.route,
        owner.route,
        `${cand.route.wpPath} and ${owner.route.wpPath} are both ${cand.route.jxRoute} in the Jx site; the ${owner.route.kind} keeps it and the ${cand.route.kind} is not routed.`,
        { on: "jx-route" },
      );
      continue;
    }
    jxClaimed.set(key, cand);
    distinct.push(cand);
  }

  // One page file renders one family of objects: `pages/<base>/[slug].json` has one `$paths`.
  const families = new Map<string, Map<string, Candidate[]>>();
  for (const cand of distinct) {
    if (!cand.dyn) continue;
    const base = cand.dyn.base.join("/");
    const family = `${cand.dyn.kind}\0${cand.dyn.source}`;
    const byFamily = families.get(base) ?? new Map<string, Candidate[]>();
    families.set(base, byFamily);
    const list = byFamily.get(family) ?? [];
    list.push(cand);
    byFamily.set(family, list);
  }
  const dropped = new Set<Candidate>();
  for (const [base, byFamily] of families) {
    if (byFamily.size < 2) continue;
    const ordered = [...byFamily.values()].sort((a, b) => compareCandidates(a[0]!, b[0]!));
    const keep = ordered[0]!;
    for (const lost of ordered.slice(1)) {
      for (const cand of lost) dropped.add(cand);
      const first = lost[0]!;
      const owner = keep[0]!;
      const label = (c: Candidate): string => `${c.dyn?.kind ?? ""} of ${c.dyn?.source ?? ""}`;
      plan.report?.add({
        severity: "error",
        code: "route.collision",
        message: `The ${label(first)} and the ${label(owner)} both live under /${base}/, and one page file (pages/${base === "" ? "" : `${base}/`}[slug].json) renders one kind of object. The ${label(owner)} keeps the address; the ${lost.length} ${label(first)} below it are not routed and need a different address.`,
        where:
          first.route.kind === "term"
            ? `taxonomy:${first.dyn?.source}`
            : `post-type:${first.dyn?.source}`,
        data: {
          on: "dynamic-page",
          base: `/${base}/`,
          kept: { kind: owner.dyn?.kind, source: owner.dyn?.source },
          dropped: { kind: first.dyn?.kind, source: first.dyn?.source, count: lost.length },
        },
      });
    }
  }
  const result = distinct.filter((c) => !dropped.has(c));

  const live = new Set(result.map((c) => wpKey(c.route.wpPath)));
  const aliased = new Map<string, Candidate>();
  for (const cand of result) {
    const kept: string[] = [];
    for (const alias of cand.aliases) {
      const key = pathKey(alias);
      if (live.has(key) || aliased.has(key)) continue;
      aliased.set(key, cand);
      kept.push(alias);
    }
    cand.aliases = kept;
  }
  // The address WordPress served for a loser is its winner's, so a link to the loser leads there; a
  // winner that was itself dropped later leaves nothing to lead to.
  const lost = beaten
    .filter((b) => result.includes(b.winner))
    .map((b) => ({ loser: b.loser, winner: b.winner.route }));
  return { winners: result, lost };
}

// ── The dynamic pages ────────────────────────────────────────────────────────────────────────────

function buildDynamicPages(winners: readonly Candidate[]): DynamicPage[] {
  const groups = new Map<string, Candidate[]>();
  for (const cand of winners) {
    if (!cand.dyn) continue;
    const key = `${cand.dyn.base.join("/")}\0${cand.dyn.kind}\0${cand.dyn.source}`;
    const list = groups.get(key) ?? [];
    groups.set(key, list);
    list.push(cand);
  }
  const pages: DynamicPage[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    const dyn = first.dyn!;
    const param: "slug" | "path" = list.some((c) => c.dyn!.rest.length > 1) ? "path" : "slug";
    const dir = dyn.base.length === 0 ? "pages" : `pages/${dyn.base.join("/")}`;
    const file = `${dir}/${param === "path" ? "[...path]" : "[slug]"}.json`;
    const routes = list.map((c) => c.route).sort((a, b) => rank(a.jxRoute, b.jxRoute));
    for (const route of routes) if (route.kind !== "entry") route.file = file;
    pages.push({
      file,
      pattern: `/${[...dyn.base, param === "path" ? "*" : ":slug"].join("/")}`,
      kind: dyn.kind,
      source: dyn.source,
      param,
      paths:
        dyn.kind === "entries"
          ? { contentType: dyn.source, param }
          : {
              values: [...new Set(list.map((c) => c.dyn!.rest.join("/")))].sort(rank),
              param,
            },
      routes,
    });
  }
  return pages.sort((a, b) => rank(a.file, b.file) || rank(a.source, b.source));
}

// ── The table ────────────────────────────────────────────────────────────────────────────────────

function makeTable(
  plan: Plan,
  winners: readonly Candidate[],
  dynamic: readonly DynamicPage[],
  lost: readonly Lost[],
): RouteTable {
  const routes = winners
    .map((c) => c.route)
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        rank(a.wpPath, b.wpPath) ||
        rank(String(a.id), String(b.id)),
    );
  const byPath = new Map<string, Route>();
  const posts = new Map<number, Route>();
  const terms = new Map<number, Route>();
  const archives = new Map<string, Route>();
  const authors = new Map<number, Route>();
  for (const cand of winners) {
    const route = cand.route;
    byPath.set(wpKey(route.wpPath), route);
    for (const alias of cand.aliases) byPath.set(pathKey(alias), route);
    if (cand.aliases.length > 0) route.aliases = [...cand.aliases];
    switch (route.kind) {
      case "term":
        terms.set(Number(route.id), route);
        break;
      case "author":
        authors.set(Number(route.id), route);
        break;
      case "post-archive":
        archives.set(String(route.id), route);
        break;
      case "posts-page":
        if (typeof route.id === "number" && route.id > 0) posts.set(route.id, route);
        archives.set("post", route);
        break;
      default:
        posts.set(Number(route.id), route);
    }
  }
  // A loser has no route of its own (all() and the dynamic pages do not list it), but its id still
  // names the address WordPress served for it, which a menu item or a `{pageobject}` link needs.
  for (const { loser, winner } of lost) {
    switch (loser.kind) {
      case "term":
        if (!terms.has(Number(loser.id))) terms.set(Number(loser.id), winner);
        break;
      case "author":
        if (!authors.has(Number(loser.id))) authors.set(Number(loser.id), winner);
        break;
      case "post-archive":
        if (!archives.has(String(loser.id))) archives.set(String(loser.id), winner);
        break;
      default:
        if (typeof loser.id === "number" && !posts.has(loser.id)) posts.set(loser.id, winner);
    }
  }
  return {
    all: () => routes,
    byWpPath(path: string): Route | undefined {
      const key = pathKey(path);
      const direct = byPath.get(key);
      if (direct) return direct;
      // `/index.php/about/` and `/about/` are one address on a site that has no rewrite rules.
      const stripped = key.replace(/^\/index\.php(?=\/)/, "");
      if (stripped !== key) return byPath.get(stripped === "" ? "/" : stripped);
      return plan.root.length > 0 ? byPath.get(`/index.php${key}`) : undefined;
    },
    forPost: (id) => posts.get(id),
    forTerm: (id) => terms.get(id),
    forArchive: (key) => archives.get(key),
    forAuthor: (id) => authors.get(id),
    dynamicPages: () => dynamic,
    trailingSlash: plan.trailing,
  };
}

// ── Same-site addresses ──────────────────────────────────────────────────────────────────────────

const WWW = /^www\./i;

interface SiteAddress {
  /** Hosts the site answers to, without `www.`. */
  hosts: ReadonlySet<string>;
  /** The path WordPress is installed under (`blog` for `https://example.com/blog`), no slashes. */
  home: string;
}

function siteAddress(model: WpModel): SiteAddress {
  const hosts = new Set<string>();
  let home = "";
  for (const raw of [model.site.home, model.site.url]) {
    try {
      const url = new URL(raw);
      hosts.add(url.host.toLowerCase().replace(WWW, ""));
      if (raw === model.site.home) home = slashes(decodeSegment(url.pathname));
    } catch {
      // A site with no usable address has nothing to recognise.
    }
  }
  return { hosts, home };
}

interface ParsedUrl {
  /** What the address is: this site, someone else's, or not an address a page can follow. */
  kind: "site" | "external" | "other";
  /** The path as the visitor sees it, with the install path removed. */
  path: string;
  search: string;
  hash: string;
  /** The address as an absolute URL, for the media plan. */
  absolute: string;
}

function parseUrl(model: WpModel, address: SiteAddress, raw: string): ParsedUrl {
  const text = raw.trim();
  const other = (kind: ParsedUrl["kind"]): ParsedUrl => ({
    kind,
    path: "",
    search: "",
    hash: "",
    absolute: text,
  });
  if (text === "" || text.startsWith("#")) return other("other");
  let url: URL;
  const siteUrl = model.site.url || model.site.home;
  try {
    if (text.startsWith("//")) url = new URL(`https:${text}`);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
      if (!/^https?:/i.test(text)) return other("other");
      url = new URL(text);
    } else if (text.startsWith("/")) url = new URL(text, `${siteUrl}/`);
    else return other("other");
  } catch {
    return other("other");
  }
  const sameHost = address.hosts.has(url.host.toLowerCase().replace(WWW, ""));
  if (!sameHost) return { ...other("external"), hash: url.hash, absolute: url.href };
  const decodedPath = decodeSegment(url.pathname);
  const underHome =
    address.home !== "" && slashes(decodedPath).startsWith(`${address.home}/`)
      ? `/${slashes(decodedPath).slice(address.home.length + 1)}${url.pathname.endsWith("/") ? "/" : ""}`
      : address.home !== "" && slashes(decodedPath) === address.home
        ? "/"
        : url.pathname;
  return { kind: "site", path: underHome, search: url.search, hash: url.hash, absolute: url.href };
}

/**
 * Where a URL points inside the source site, or undefined when it points elsewhere (another host, a
 * mail address, a bare fragment). The path is the one WordPress routes: the install path removed.
 */
export function sameSiteLocation(
  model: WpModel,
  url: string,
): { path: string; search: string; hash: string } | undefined {
  const parsed = parseUrl(model, siteAddress(model), url);
  return parsed.kind === "site"
    ? { path: parsed.path, search: parsed.search, hash: parsed.hash }
    : undefined;
}

// ── buildRoutes ──────────────────────────────────────────────────────────────────────────────────

function reportSkips(plan: Plan, skips: Skips): void {
  const { report } = plan;
  if (!report) return;
  for (const [key, ids] of [...skips.byTypeStatus].sort((a, b) => rank(a[0], b[0]))) {
    const [type, status] = key.split("/") as [string, string];
    // A draft is nobody's address: only what a visitor could have reached is worth a line.
    if (status !== "not-public") continue;
    report.add({
      severity: "info",
      code: "route.skipped",
      message: `${ids.length} ${type} posts are not public (the post type is registered with public off), so they have no address.`,
      where: `post-type:${type}`,
      data: { type, count: ids.length },
    });
  }
  for (const [key, ids] of [...skips.private].sort((a, b) => rank(a[0], b[0]))) {
    const [type] = key.split("/") as [string];
    report.add({
      severity: "info",
      code: "route.skipped",
      message: `${ids.length} private ${type} posts are only visible to signed-in users on the source site and are not routed.`,
      where: `post-type:${type}`,
      data: { type, count: ids.length, status: "private" },
    });
  }
  for (const [type, ids] of [...skips.unregistered].sort((a, b) => rank(a[0], b[0]))) {
    report.add({
      severity: "warn",
      code: "route.unregistered",
      message: `The post type ${type} (${ids.length} published posts) is not registered through ACF and the caller did not describe it, so its address is unknown and it is not routed. Pass its rewrite rules with the postTypes option if it has public pages.`,
      where: `post-type:${type}`,
      data: { type, count: ids.length },
    });
  }
  for (const [type, ids] of [...skips.inactive].sort((a, b) => rank(a[0], b[0]))) {
    report.add({
      severity: "info",
      code: "route.skipped",
      message: `ACF has the post type ${type} switched off, so WordPress never registered it and its ${ids.length} posts had no address.`,
      where: `post-type:${type}`,
      data: { type, count: ids.length, status: "acf-inactive" },
    });
  }
}

/** What WordPress serves that the Jx site does not: said once, because it is the same everywhere. */
function reportNotShipped(plan: Plan): void {
  const { report } = plan;
  if (!report) return;
  const kinds: [string, string][] = [
    ["date-archive", "Date archives (/2023/05/)"],
    ["pagination", "Pagination (/page/2/)"],
    ["feed", "Feeds (/feed/)"],
    ["search", "Search results (/?s=)"],
  ];
  for (const [kind, label] of kinds) {
    report.add({
      severity: "info",
      code: "route.not-shipped",
      message: `${label} are not part of the migrated site: a link to one is reported (url.unresolved) and a visitor of the old address gets no redirect.`,
      where: "site",
      data: { kind },
    });
  }
}

/**
 * Users WordPress links an author archive for: those with a published post of any public type
 * (`has_published_posts => true`, which Rank Math's sitemap and the author link both use). The
 * archive itself lists only `post` entries, so a user with episodes alone gets an empty page.
 */
function authorsWithPosts(plan: Plan): Map<number, number> {
  const out = new Map<number, number>();
  for (const post of plan.model.posts.values()) {
    if (!plan.statuses.has(post.status)) continue;
    const info =
      post.type === "post" || post.type === "page" ? undefined : typeInfo(plan, post.type);
    if (
      post.type !== "post" &&
      post.type !== "page" &&
      (info === undefined || info === "inactive" || !info.public)
    )
      continue;
    out.set(post.authorId, (out.get(post.authorId) ?? 0) + 1);
  }
  return out;
}

export function buildRoutes(model: WpModel, acf: AcfModel, opts: RouteOptions = {}): RouteTable {
  const plan = makePlan(model, acf, opts);
  const skips: Skips = {
    byTypeStatus: new Map(),
    unregistered: new Map(),
    inactive: new Map(),
    private: new Map(),
  };
  const candidates: Candidate[] = [];
  collectPages(plan, candidates, skips);
  collectEntries(plan, candidates, skips);
  collectTerms(plan, candidates);
  collectArchives(plan, candidates);
  collectAuthors(plan, candidates, authorsWithPosts(plan));
  reportSkips(plan, skips);
  reportNotShipped(plan);

  const { winners, lost } = resolveCandidates(plan, candidates);
  const dynamic = buildDynamicPages(winners);
  const content = makeTable(plan, winners, dynamic, lost);

  // Attachment pages need the others' addresses (their parents, and Rank Math's fallback address).
  const address = siteAddress(model);
  const attachments: Candidate[] = [];
  collectAttachments(
    plan,
    content,
    (url) => {
      const parsed = parseUrl(model, address, url);
      return parsed.kind === "site" ? content.byWpPath(parsed.path) : undefined;
    },
    attachments,
  );
  if (attachments.length === 0) return content;
  const kept = [...winners];
  const claimed = new Map<string, Route>(winners.map((c) => [wpKey(c.route.wpPath), c.route]));
  const lostAttachments: Lost[] = [...lost];
  for (const att of attachments.sort(compareCandidates)) {
    const key = wpKey(att.route.wpPath);
    const owner = claimed.get(key);
    if (owner) {
      collision(
        plan,
        att.route,
        owner,
        owner.kind === "attachment"
          ? `The attachment pages of post ${owner.id} and post ${att.route.id} have one address (${att.route.wpPath}) on the source site; WordPress serves the first, so the second is not routed.`
          : `The attachment page ${att.route.wpPath} shares its address with the ${owner.kind} (${whereOf(owner)}), which WordPress serves instead; the attachment page is not routed.`,
        { on: "wordpress-path" },
      );
      lostAttachments.push({ loser: att.route, winner: owner });
      continue;
    }
    claimed.set(key, att.route);
    kept.push(att);
  }
  return makeTable(plan, kept, dynamic, lostAttachments);
}

// ── URL tools ────────────────────────────────────────────────────────────────────────────────────

export interface UrlTools {
  /** `ConvertCtx.urlFor`: the Jx path of a post (page, entry, attachment) or a term. */
  urlFor(kind: "post" | "term", id: number): string | undefined;
  /** `ConvertCtx.rewriteUrl`: any URL found in content, for the Jx site. */
  rewriteUrl(url: string): string;
  /** The Jx path of a custom post type's archive (`post` for the blog index). */
  urlForArchive(type: string): string | undefined;
  urlForAuthor(id: number): string | undefined;
  /**
   * The same tools writing `url.unresolved` into another report, with a location. A subject has its
   * own report (`ConvertCtx.report`), and a URL is reported once per report.
   */
  bind(report: Report, where?: string): UrlTools;
}

export interface UrlToolsOptions {
  report?: Report | undefined;
  /** Where `url.unresolved` says the URL was found, when it is not bound to a subject. */
  where?: string | undefined;
}

/** Addresses of WordPress itself that no page of the migrated site answers. */
const WORDPRESS_ENDPOINT =
  /^\/(?:wp-admin|wp-login\.php|wp-json|wp-cron\.php|xmlrpc\.php|wp-content|wp-includes|wp-signup\.php|wp-comments-post\.php|robots\.txt|sitemap[^/]*\.xml|wp-sitemap[^/]*\.xml)(?:\/|$)/i;
const FEED = /(?:^|\/)(?:feed|rss2?|atom|rdf)(?:\/(?:atom|rdf|rss2?))?\/?$/i;
const PAGINATION = /\/(?:page|comment-page)-?\/?\d+\/?$/i;
const DATE_ARCHIVE = /^\/\d{4}(?:\/\d{1,2}){0,2}\/?$/;

type Unresolved =
  | "media"
  | "wordpress"
  | "feed"
  | "pagination"
  | "date-archive"
  | "search"
  | "no-route"
  | "query";

/** Which of the things the migrated site does not have an address is, for the report. */
function whyUnresolved(path: string, query: URLSearchParams): Unresolved {
  if (query.has("s")) return "search";
  if (WORDPRESS_ENDPOINT.test(path)) return "wordpress";
  if (FEED.test(path) || query.has("feed")) return "feed";
  if (PAGINATION.test(path) || query.has("paged")) return "pagination";
  if (DATE_ARCHIVE.test(path) || query.has("m")) return "date-archive";
  return "no-route";
}

export function createUrlTools(
  model: WpModel,
  routes: RouteTable,
  media: MediaPlan,
  options: UrlToolsOptions = {},
): UrlTools {
  const address = siteAddress(model);
  const reported = new WeakMap<Report, Set<string>>();

  // Slug lookups for `?tag=x`, `?project=x`, `?series=x`: built once, on first use.
  let termsBySlug: Map<string, Route> | undefined;
  let entriesBySlug: Map<string, Route> | undefined;
  const termIndex = (): Map<string, Route> => {
    if (termsBySlug) return termsBySlug;
    termsBySlug = new Map();
    for (const route of routes.all()) {
      if (route.kind !== "term") continue;
      const term = model.terms.get(Number(route.id));
      if (term) termsBySlug.set(`${term.taxonomy}\0${term.slug}`, route);
    }
    return termsBySlug;
  };
  const entryIndex = (): Map<string, Route> => {
    if (entriesBySlug) return entriesBySlug;
    entriesBySlug = new Map();
    for (const route of routes.all()) {
      if (route.kind !== "entry" && route.kind !== "page") continue;
      const post = model.posts.get(Number(route.id));
      if (post) entriesBySlug.set(`${post.type}\0${post.slug}`, route);
    }
    return entriesBySlug;
  };

  /** The object a `?p=12` style query names, or undefined when it names none we route. */
  function viaQuery(query: URLSearchParams): {
    route: Route | undefined;
    named: boolean;
    used: string[];
  } {
    const used: string[] = [];
    const take = (key: string): string | undefined => {
      const value = query.get(key);
      if (value === null || value === "") return undefined;
      used.push(key);
      return value;
    };
    const num = (key: string): number | undefined => {
      const value = take(key);
      return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
    };
    const post = num("p") ?? num("page_id") ?? num("attachment_id");
    if (post !== undefined) return { route: routes.forPost(post), named: true, used };
    const cat = num("cat");
    if (cat !== undefined) return { route: routes.forTerm(cat), named: true, used };
    const tag = take("tag");
    if (tag !== undefined) return { route: termIndex().get(`post_tag\0${tag}`), named: true, used };
    const categoryName = take("category_name");
    if (categoryName !== undefined) {
      const last = categoryName.split("/").filter(Boolean).at(-1) ?? "";
      return { route: termIndex().get(`category\0${last}`), named: true, used };
    }
    const author = num("author");
    if (author !== undefined) return { route: routes.forAuthor(author), named: true, used };
    const authorName = take("author_name");
    if (authorName !== undefined) {
      const user = [...model.users.values()].find((u) => u.slug === authorName);
      return { route: user ? routes.forAuthor(user.id) : undefined, named: true, used };
    }
    const postType = take("post_type");
    if (postType !== undefined) return { route: routes.forArchive(postType), named: true, used };
    const pagename = take("pagename");
    if (pagename !== undefined)
      return { route: routes.byWpPath(`/${pagename}/`), named: true, used };
    const name = take("name");
    if (name !== undefined) return { route: entryIndex().get(`post\0${name}`), named: true, used };
    // `?project=slug` and `?service_area=slug`: a query variable named after a post type or a taxonomy.
    for (const [key, value] of query) {
      if (value === "") continue;
      const found = entryIndex().get(`${key}\0${value}`) ?? termIndex().get(`${key}\0${value}`);
      if (found) {
        used.push(key);
        return { route: found, named: true, used };
      }
    }
    return { route: undefined, named: false, used };
  }

  function make(report: Report | undefined, where: string | undefined): UrlTools {
    const miss = (url: string, reason: Unresolved): void => {
      if (!report) return;
      let seen = reported.get(report);
      if (!seen) {
        seen = new Set();
        reported.set(report, seen);
      }
      if (seen.has(url)) return;
      seen.add(url);
      report.add({
        severity: "warn",
        code: "url.unresolved",
        message: UNRESOLVED_TEXT[reason],
        ...(where === undefined ? {} : { where }),
        url,
        data: { url, reason },
      });
    };

    const tools: UrlTools = {
      urlFor(kind, id) {
        return (kind === "post" ? routes.forPost(id) : routes.forTerm(id))?.jxRoute;
      },
      urlForArchive: (type) => routes.forArchive(type)?.jxRoute,
      urlForAuthor: (id) => routes.forAuthor(id)?.jxRoute,
      bind: (next, at) => make(next, at),
      rewriteUrl(url) {
        const parsed = parseUrl(model, address, url);
        if (parsed.kind === "external") {
          // Uploads offloaded to a CDN or another bucket keep their host (1,793 of 1,794 ap attachments),
          // and the media plan ships them: ask it before leaving the address alone.
          const shipped = media.mediaForUrl(parsed.absolute.replace(/[?#].*$/s, ""));
          return shipped ? `${shipped.src}${parsed.hash}` : url;
        }
        if (parsed.kind !== "site") return url;
        const query = new URLSearchParams(parsed.search);

        // Uploads: the media plan knows every file it ships, in any of its spellings.
        const uploads = media.mediaForUrl(parsed.absolute.replace(/[?#].*$/s, ""));
        if (uploads) return `${uploads.src}${parsed.hash}`;
        if (/\/wp-content\/uploads\//i.test(parsed.path)) {
          miss(url, "media");
          return url;
        }

        const rest = (used: readonly string[]): string => {
          const keep = new URLSearchParams();
          for (const [key, value] of query) if (!used.includes(key)) keep.append(key, value);
          const text = keep.toString();
          return text === "" ? "" : `?${text}`;
        };
        const done = (route: Route, used: readonly string[]): string =>
          `${route.jxRoute}${rest(used)}${parsed.hash}`;

        const path = pathKey(parsed.path);
        if (path === "/" || path === "/index.php/") {
          const reason = whyUnresolved(parsed.path, query);
          if (reason !== "no-route") {
            miss(url, reason);
            return url;
          }
          const queried = viaQuery(query);
          if (queried.named) {
            if (queried.route) return done(queried.route, queried.used);
            miss(url, "query");
            return url;
          }
        }
        const route = routes.byWpPath(parsed.path);
        if (route) return done(route, []);
        miss(url, whyUnresolved(parsed.path, query));
        return url;
      },
    };
    return tools;
  }
  return make(options.report, options.where);
}

const UNRESOLVED_TEXT: Record<Unresolved, string> = {
  media:
    "An address in the uploads folder that no attachment and no extra URL accounts for; it is left as written.",
  wordpress:
    "An address of WordPress itself (admin, login, REST, a theme or plugin file), which the migrated site does not have; it is left as written.",
  feed: "A feed address; the migrated site has no feeds, so the link is left as written.",
  pagination:
    "A paginated archive address; the migrated site has no pagination, so the link is left as written.",
  "date-archive":
    "A date archive address; the migrated site has none, so the link is left as written.",
  search:
    "A search address; the migrated site has no search results page, so the link is left as written.",
  "no-route":
    "A link to this site that no page, entry, term, author or archive of the migrated site accounts for; it is left as written.",
  query:
    "A link by id or slug (?p=12, ?cat=3) to an object that is not in the migrated site; it is left as written.",
};
