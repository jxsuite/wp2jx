/**
 * Shared contracts between wp2jx modules. Each module owns its files and implements the
 * signatures below; additions are welcome, changes to an existing signature are not (other
 * modules are being written against it).
 *
 * Pipeline: ingest (wp/) → read Cwicly state (cwicly/options, cwicly/css) → convert block trees
 * (cwicly/blocks, core/) → emit files (emit/) → verify (verify/).
 */
import type { JxDocument, JxElement, JxStyle } from "@jxsuite/schema/types";
import type { CwiclyOptionsFull } from "./cwicly/options.ts";
import type { AcfModel } from "./wp/acf.ts";

export type { JxDocument, JxElement, JxStyle };
export type JxNode = JxElement | string;

// ── Report ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Everything the converter could not carry over, or carried over imperfectly. Nothing is dropped
 * silently: a feature that does not translate is a report entry naming the page it was found on.
 */
export type Severity = "info" | "warn" | "error";

export interface ReportEntry {
  severity: Severity;
  /** Stable machine code, kebab-case, namespaced: `block.unsupported`, `css.artifact`, `token.unresolved`. */
  code: string;
  message: string;
  /** Where it was found: `post:5246`, `template:cwicly//header`, `option:cwicly_global_classes`. */
  where?: string;
  /** Public URL on the source site, when one exists. */
  url?: string;
  /** Free-form extra data (the block name, the token, the selector). */
  data?: Record<string, unknown>;
}

export interface Report {
  add(entry: ReportEntry): void;
  entries(): readonly ReportEntry[];
}

// ── Database ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Read-only access to a WordPress database. `mysql://` and `sqlite:` are both accepted (the
 * hermetic tests use SQLite), so SQL passed to `query` must be portable: `?` placeholders, no
 * backtick quoting, no MySQL-only functions. MySQL returns `Date` for DATETIME columns and SQLite
 * returns strings; callers go through `wp/model.ts`, which normalises both.
 */
export interface WpDb {
  /** Table prefix including the trailing underscore, e.g. `KjLnF_`. */
  readonly prefix: string;
  /** `db.table("posts")` → `KjLnF_posts`. */
  table(name: string): string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

// ── WordPress model (output of wp/model.ts) ─────────────────────────────────────────────────────

export interface WpPost {
  id: number;
  type: string;
  /** publish | private | draft | pending | future | inherit … */
  status: string;
  slug: string;
  title: string;
  /** Raw `post_content`: serialized blocks, or classic HTML. */
  content: string;
  excerpt: string;
  /** ISO 8601 UTC. */
  date: string;
  modified: string;
  /** Parent post id, 0 for none. */
  parent: number;
  menuOrder: number;
  authorId: number;
  guid: string;
  passwordProtected: boolean;
}

export interface WpAttachment {
  id: number;
  /**
   * URL as stored (guid). It is NOT guaranteed to sit on the site's own host: media offloaded to S3 or
   * a CDN keeps its guid there (1,793 of 1,794 anabaptistperspectives attachments), so download from
   * this host or resolve `file` against the uploads base, never assume `site.url`.
   */
  url: string;
  mime: string;
  title: string;
  alt: string;
  caption: string;
  /** `_wp_attached_file`, relative to uploads: `2023/03/foo.jpg` (the `-scaled` copy when WordPress made one). */
  file: string;
  /** The unscaled original (`_wp_attachment_metadata.original_image`), relative to uploads, when `file` is a `-scaled` copy. */
  originalFile?: string;
  width?: number;
  height?: number;
  /** Intermediate sizes from `_wp_attachment_metadata`: file names relative to the original's directory. */
  sizes: { name: string; file: string; width: number; height: number }[];
  parent: number;
}

export interface WpTerm {
  termId: number;
  taxonomyId: number;
  taxonomy: string;
  slug: string;
  /** As stored: HTML-entity-encoded; decode once with `decodeEntities` (wp/model.ts). */
  name: string;
  description: string;
  parent: number;
  count: number;
  /** Unserialised term meta (ACF fields live here for taxonomies). Values are single (last) values. */
  meta: Record<string, unknown>;
}

export interface WpUser {
  id: number;
  slug: string;
  displayName: string;
}

export interface WpMenuItem {
  id: number;
  menuTermId: number;
  parent: number;
  order: number;
  /** The stored post_title. Empty means the menu shows the target's own title: use `menuItemTitle(model, item)`. Entity-encoded as stored. */
  title: string;
  /** post_type | taxonomy | custom | post_type_archive */
  kind: string;
  /** For post_type/taxonomy: the target object id. */
  objectId: number;
  object: string;
  url: string;
  /** Includes the classes WordPress generates (`menu-item`, `menu-item-type-post_type`, `current_page_parent`…); strip them to get the authored ones. */
  classes: string[];
  target: string;
}

export interface WpRedirect {
  /** Source pattern as stored, plus how to compare it. One WpRedirect per source: a Rank Math row can hold several. */
  source: string;
  comparison: "exact" | "contains" | "start" | "end" | "regex";
  /** Rank Math's `ignore: case` on this source. */
  ignoreCase?: boolean;
  destination: string;
  status: number;
  active: boolean;
}

export interface WpSite {
  /** `siteurl` option, no trailing slash. */
  url: string;
  /** `home` option, no trailing slash. */
  home: string;
  /** As stored: HTML-entity-encoded (`Missions &amp; Evangelism`); decode once with `decodeEntities` (wp/model.ts) before using it as text. */
  name: string;
  /** As stored: HTML-entity-encoded; see `name`. */
  description: string;
  permalinkStructure: string;
  showOnFront: "page" | "posts";
  pageOnFront: number;
  pageForPosts: number;
  activePlugins: string[];
  theme: string;
  language: string;
}

export interface WpModel {
  site: WpSite;
  /**
   * Raw option values by name (strings, exactly as stored). Cwicly options come in three shapes:
   * JSON strings, PHP-serialised arrays, and plain text (compiled CSS, `<link>` markup, versions).
   * Read them through `readCwiclyOptions`, whose decoder accepts all of them.
   */
  options: ReadonlyMap<string, string>;
  posts: ReadonlyMap<number, WpPost>;
  /** Raw post meta, unserialised where PHP-serialised; multiple values keep order. */
  postMeta: ReadonlyMap<number, Readonly<Record<string, unknown[]>>>;
  attachments: ReadonlyMap<number, WpAttachment>;
  terms: ReadonlyMap<number, WpTerm>;
  /** post id → term ids (term_id, not term_taxonomy_id). */
  termsByPost: ReadonlyMap<number, readonly number[]>;
  users: ReadonlyMap<number, WpUser>;
  menuItems: readonly WpMenuItem[];
  redirects: readonly WpRedirect[];
}

/** One parsed block, in the shape `@wordpress/block-serialization-default-parser` produces. */
export interface WpBlock {
  /** `cwicly/div`, `core/paragraph`… ; null for freeform (classic) HTML between blocks. */
  name: string | null;
  attrs: Record<string, unknown>;
  innerBlocks: WpBlock[];
  /** Saved markup with nested blocks removed. */
  innerHTML: string;
  /** innerHTML split around nested blocks: strings, with `null` marking where each inner block goes. */
  innerContent: (string | null)[];
}

// ── Cwicly state (output of cwicly/options.ts) ──────────────────────────────────────────────────

export interface Breakpoint {
  /** Cwicly key: `lg`, `md`, `sm`… */
  key: string;
  width: number;
  /** The base breakpoint: no media query. */
  isMain: boolean;
  /** `min` for breakpoints listed before the main one, `max` for those after, `none` for the main. */
  direction: "min" | "max" | "none";
}

export interface CwiclyOptions {
  /**
   * In CASCADE order, not stored order: min-width breakpoints ascending, the main one, then
   * max-width breakpoints descending (the order Cwicly itself emits its media queries in).
   */
  breakpoints: Breakpoint[];
  /** The Jx `$media` map: `{"--": "1366px", "--md": "(max-width: 992px)", …}`. */
  media: Record<string, string>;
  globalStyles: {
    colors: { id: string; name: string; value: string; variable: string }[];
    /** Google/local font declarations, ready for `$head` or `@font-face`. */
    fonts: { family: string; source: "google" | "local" | "system"; url?: string }[];
  };
  /**
   * Cwicly's own compiled stylesheets. `global` (`cwicly_global_css`) and `stylesheets`
   * (`cwicly_global_stylesheets_rendered`) are plain CSS; parse them with cwicly/css.ts for tag rules
   * (`h1`, `body`), `:root` colour variables and custom CSS. `classes` is NOT what the site serves:
   * `cwicly_global_classes_rendered` is a PHP-serialised per-class cache (`{fontCSS, common,
   * responsive}`) that is stale in coverage and content, so options.ts assembles it into CSS text
   * with no `@media` wrapper. Global-class rules come from `cc-global-classes.css`, read through a
   * CssSource, not from here.
   */
  compiledCss: { global: string; classes: string; stylesheets: string };
  /** Global class id → CSS class name (`classID`). An id that no block can resolve is reported by the reader, not dropped silently. */
  globalClassNames: ReadonlyMap<string, string>;
  /** Global class id → its raw Cwicly attributes (for the fallback style path). */
  globalClassAttrs: ReadonlyMap<string, Record<string, unknown>>;
  /** Custom code snippets (GTM etc.): head/body-open/footer HTML. */
  customCode: { head: string; bodyOpen: string; footer: string };
  /** Template-assignment rules (`cwicly_conditions`) in raw form. */
  conditions: unknown;
  /** Named fragments / global parts in raw form. */
  globalParts: unknown;
}

/** classID → Jx style, recovered from Cwicly's generated CSS (see cwicly/css.ts). */
export interface ClassStyle {
  /**
   * Declarations for the class itself, in Jx style form (camelCase keys). Pseudo-classes and
   * pseudo-elements are nested keys (`":hover"`, `"::before"`), breakpoints are `"@--md"` keys
   * (which may themselves contain `":hover"`), and rules about the class's descendants or its own
   * tag are nested `&` keys (`"& a"`, `"& > div:nth-of-type(1)"`, `"&:is(a)"`).
   */
  style: JxStyle;
}

/**
 * What one set of Cwicly stylesheets says. An index belongs to the stylesheets of ONE page (global
 * files plus that post's, template's and components' files): see ConvertCtx.css. Its style objects
 * are shared with the index, so clone before editing; mergeCssIndexes returns copies.
 */
export interface CssIndex {
  /** Rules rooted at exactly one `.class`, keyed by the class name without the dot. */
  classes: ReadonlyMap<string, ClassStyle>;
  /**
   * Rules whose selector is not rooted at a single `.class` (`:root`, `body`, `h1`, `.a .b`,
   * `.a.b`): selector → style, with `"@--md"` nesting.
   */
  other: ReadonlyMap<string, JxStyle>;
  /**
   * `@font-face`, `@keyframes`, … in source order, as Jx at-rule style entries (`key` is the at-rule
   * head). Several `@font-face` entries share the key. Statement at-rules (`@import url(…)`) appear
   * with an empty `style`; Jx style objects cannot carry them, so a project emits them as `$head` links.
   */
  atRules: { key: string; style: JxStyle }[];
  /** Everything odd in the source CSS (`!var=…!`, `undefined…`, unparseable selectors). */
  artifacts: { code: string; selector?: string; detail: string; file?: string }[];
}

/** Where stylesheets come from: a local uploads directory or the live site. */
export interface CssSource {
  /** `cc-post-5246.css`, `cc-global-classes.css`… Null when absent. */
  get(name: string): Promise<string | null>;
}

// ── Conversion ───────────────────────────────────────────────────────────────────────────────────

/**
 * What a block tree is being converted *for*. It decides what tokens become:
 * - `static`:    a page; tokens resolve to values (`{title}` → the page title).
 * - `entry`:     a collection entry's template; tokens become bindings (`${state.entry.data.title}`).
 * - `component`: a component body; `{component=parameter=id}` becomes `${state.<prop>}`.
 */
export type ConvertMode = "static" | "entry" | "component";

export interface ConvertCtx {
  mode: ConvertMode;
  model: WpModel;
  cwicly: CwiclyOptionsFull;
  /**
   * The stylesheets of ONE subject (a post, template or component): classIDs repeat across posts with
   * different declarations (a duplicated page keeps its block ids; 144 differing declarations on
   * fineline), so an index must never merge stylesheets of unrelated posts.
   */
  css: CssIndex;
  report: Report;
  /** The post/template being converted, for report locations and `{title}`-style tokens. */
  subject: { kind: "post" | "template" | "component"; id: string; post?: WpPost };
  /**
   * The JS expression that names the current content entry inside Jx template strings:
   * `state.entry` in an entry template, `$map.item` inside a query loop. Bindings are built from it
   * (`${state.entry.data.title}`), following the entry data contract in docs/design.md.
   */
  entryExpr: string;
  /**
   * The post type the entries behind `entryExpr` have (the single template's post type, or a query
   * loop's `queryPostType`): it selects which ACF field groups apply to `{acffield=…}` bindings.
   */
  entryType?: string;
  /** The JS expression naming the current taxonomy term in taxonomy-archive templates (`state.term`); absent elsewhere. */
  termExpr?: string;
  /** The JS expression naming the current ACF repeater row (`$map.item`) inside a repeater's loop; fields inside a repeater cannot be bound without it. */
  rowExpr?: string;
  /**
   * What the converted nodes are written into: a JSON `page` (also templates, template parts,
   * components and reusable blocks) or a `markdown` collection entry. Markdown entries lose what the
   * serializer cannot write (table spans, cell classes) and must not contain component-only features.
   * Absent: derived from the subject (a post of any non-page type is a Markdown entry).
   */
  target?: "page" | "markdown";
  /** Author and post-type archive addresses (UrlTools in src/routes.ts has both). */
  urlForAuthor?(id: number): string | undefined;
  urlForArchive?(postType: string): string | undefined;
  /**
   * A sink for rules that cannot live in one element's `style` (`@keyframes` from custom CSS, `:where()`
   * rules, rules of other classes): the emitter writes them into the page's or project's `style`.
   */
  hoist?(rule: { selector: string; style: JxStyle }): void;
  /** Component prop id → Jx state key, when `mode === "component"`. */
  props?: ReadonlyMap<string, string>;
  /** Component reference (the `reference` meta) → Jx tag name, for instance conversion. */
  components: ReadonlyMap<string, ComponentInfo>;
  /** Public URL of a WordPress object in the Jx site; used by `{pageobject=…}` and menu links. */
  urlFor(kind: "post" | "term", id: number): string | undefined;
  /**
   * Rewrite any URL found in content (an href, a src, a srcset entry, a CSS url()) for the Jx site:
   * an internal permalink becomes its Jx route (anchor and query string kept), an uploads URL its
   * `/media/…` path, an external URL comes back unchanged. A same-site URL nothing accounts for is
   * returned unchanged and reported as `url.unresolved`.
   */
  rewriteUrl(url: string): string;
  /** ACF post types, taxonomies and field definitions: the field TYPE decides how a binding is written (an image field is `.src`, a wysiwyg field is HTML). */
  acf: AcfModel;
  /** Jx path of a media file for an attachment id (largest original of its family). */
  mediaFor(
    attachmentId: number,
  ): { src: string; width?: number; height?: number; alt: string } | undefined;
  /** The same for any uploads URL a block holds (a thumbnail name, the guid's host…); undefined when it is not an upload we ship. */
  mediaForUrl(
    url: string,
  ): { src: string; width?: number; height?: number; alt?: string } | undefined;
  /** Convert nested blocks with the same context. */
  convert(blocks: WpBlock[], overrides?: Partial<ConvertCtx>): JxNode[];
}

export interface ComponentInfo {
  /** The `reference` meta (what `cwicly/component.attrs.ref` holds). */
  ref: string;
  postId: number;
  /** Custom-element tag, kebab-case with a prefix: `fp-icon-card`. */
  tagName: string;
  /** Prop id → { Jx state key, type, default }. */
  props: { id: string; key: string; name: string; type: string; default: unknown }[];
  variants: { id: string; name: string }[];
}

/** Converts one block into Jx nodes. Registered per block name in cwicly/blocks and core/. */
export type BlockConverter = (block: WpBlock, ctx: ConvertCtx) => JxNode[];

// ── Output ───────────────────────────────────────────────────────────────────────────────────────

/** Where emitted files go. Paths are project-relative with forward slashes. */
export interface Sink {
  write(path: string, data: string | Uint8Array): Promise<void>;
}

/** In-memory sink for tests. */
export interface MemorySink extends Sink {
  files: Map<string, string | Uint8Array>;
}
