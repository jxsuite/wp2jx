/**
 * The Cwicly blocks that read data: `query` and its `query-template`, `query-pagination`,
 * `query-pagination-numbers`, `repeater`, `taxonomyterms`, and the two that stand for a component,
 * `component` (an instance) and `innerblocks` (the slot inside one).
 *
 * ## A query is a list of entries
 *
 * What the plugin does (`core/includes/classes/class-query.php`, `helpers/class-cwicly-query-args.php`,
 * `dynamic/render.php`): the query block makes `WP_Query` arguments from about a hundred `query*`
 * attributes, each one `{source, type, group, field}` (a value typed in, or read from the page), runs
 * them, and the `query-template` prints its inner blocks once per post inside
 * `<div class="cc-query-item">`. {@link planQuery} reads those attributes into a plan; the plan is
 * written as Jx in one of three ways, by where the list lives:
 *
 * - **A list a collection can say** (one post type, an order, a limit, rules on a top-level field such
 *   as `url`) is ONE `ContentCollection` state entry with `filter`, `sort` and `limit`, and the loop is
 *   `{"$prototype": "Array", "items": {"$ref": "#/state/<list>"}, "map": <the item>}`: what Studio's
 *   collection panel edits, validated, with no JavaScript. The entry carries `$src` because
 *   `jx validate` wants it.
 * - **A list a collection cannot say** (taxonomy terms, the current entry or archive term, several post
 *   types, a meta comparison) is the computed children of the spec's section 8.4: the element's one
 *   child is `"${(<list>).map(($i0) => (<item>))}"`, `<list>` an expression over `state` that filters,
 *   orders and cuts the unfiltered collections (one state entry per post type, shared by every list of
 *   the page), and `<item>` the item tree as a JavaScript literal ({@link nodeExpr}). This is measured
 *   (`.dev/data/probe*.ts`), not guessed: a collection `filter` cannot read a nested field (`terms` is
 *   an object of objects), cannot name the current entry (a template or `$ref` in a rule is never
 *   resolved), `contains` on an array of `{slug, name, url}` never matches; a `Function` state entry
 *   with `timing: "compiler"` builds without JavaScript but `jx validate` rejects it (the schema's
 *   `FunctionDef` has no `timing`, and the spec's compile-time entries are external classes with an
 *   `$implementation`); an `Array` whose `items` is computed is a client render. Computed children
 *   validate, build static and ship no JavaScript, an empty list included. The two ways list the same
 *   entries and print the same page, which the tests compare byte for byte.
 * - **A Markdown entry cannot hold a loop** (it has no state, and a text child is never evaluated), so a
 *   query inside a post of any non-page type is written out: the entries the plan selects NOW, the
 *   template converted once per entry as a static page of that entry (`query.static`).
 *
 * The item is `<div class="cc-query-item">` around the converted inner blocks, converted in `entry`
 * mode with `entryExpr` `$map.item` and `entryType` the post type (so `{title}` is
 * `${$map.item.data.title ?? ''}`). The loop is always the only child of its element: an empty mapped
 * array makes its parent a client render (docs/bindings.md, rule 10), and the parent is then only the
 * query template's own element, never a container with siblings.
 *
 * **Pagination does not exist in Jx.** A query with a pagination device (`infiniteLoad`, a
 * `query-pagination` block, a previous, next or load-more link) lists ALL its entries (a list with no
 * way to reach the rest would lose content) and says so (`query.pagination`, with the counts); one
 * without is a plain limit (a "latest six" on a home page). The live page shows the first page and a
 * device, so the list is written the same way ({@link withLoadMore}): the entries past the page size
 * are hidden by a rule until a checkbox, the query's first child, is checked, which the "Load more"
 * button (or one of ours, where the page has none) does as a `label`. No script; one click shows
 * every entry, where the plugin loads a page at a time.
 *
 * What the plan reads, from the PHP: `post_type` (default `post`), `posts_per_page` (an `absint` of
 * the number the block holds: `-1` is 1, and `0`, a word or nothing is the site's own
 * `posts_per_page` option), `orderby` and `order` (`date` descending by default), `post__in` (which
 * makes `post__not_in` and `queryExcludeCurrent` moot, as in `WP_Query`), `post__not_in`, `tax_query`
 * (`IN`, `NOT IN`, `AND`, `EXISTS`, `NOT EXISTS`, children included, a term named by id, taxonomy id,
 * slug or name, a dynamic term: the archive's, the current entry's first term through a
 * `<taxonomy>_id` shortcode of the site, a URL parameter that is absent on a static site and so no
 * filter; a clause that names no term is no clause, `EXISTS` too), `meta_query` comparisons of ACF
 * values (compared as MySQL does, without regard to case; a text is split only where `WP_Meta_Query`
 * splits it), a static search (on titles and excerpts, said).
 *
 * **`queryInherit` is true by default** (block.json), and Gutenberg leaves out an attribute that equals
 * its default, so a block that never wrote it inherits: it is the template's main query
 * (`wp_parse_args($wp_query->query_vars, $args)`), whose own variables win. Measured on the real plugin
 * over WordPress: the main query's post type (an archive of a taxonomy has none, and lists the type the
 * block names), its `posts_per_page` (the site's), its `order` (descending), an empty `post__in`,
 * `post__not_in` and `s` (so the block's inclusions, exclusions and search are overwritten), and its
 * term (an archive) or its one post (a single). The block's own `tax_query` and `meta_query` stay.
 *
 * What it cannot carry is reported, never dropped quietly: `query.approximated` (a condition that was
 * left out, widening the list, or applied to what an entry holds where WordPress answers from stored
 * rows: a meta `!=`, `NOT *` or `EXISTS` cannot tell a field never filled from an empty one),
 * `query.url-parameter`, `query.pagination`, `query.static`, `query.empty`, `query.type-unrouted` (a
 * post type with no entries, and a document type: a page is a Jx page, not a collection), `query.term-missing`,
 * and `block.unsupported` for the queries that are not lists of entries (users, comments, products:
 * the site has no users or comments to list). A `terms` query is the export's terms as a state array
 * (`terms_<taxonomy>_q<id>`), in the order and number the plugin lists them: `hide_empty` is true by
 * default (block.json), `get: all` turns it off, and a hierarchical query keeps an empty term that has
 * a filled descendant.
 *
 * A list ordered by title is a computed list: MySQL's case-insensitive collation is not a
 * `ContentCollection` sort, and not `Intl.Collator`'s either (see {@link COLL}).
 *
 * `taxonomyterms` lists the terms of the current entry (read from `state.entry.data.terms.<taxonomy>`
 * where the page is built, so a new tag shows by itself and an entry with no tag, which has no such key,
 * is an empty list and not a client render; a filter or a limit makes it a longer expression) or the terms of whole
 * taxonomies (`get_object_taxonomies` of the types, the built-in ones included; the terms the export has,
 * leaving out the archive's own term, or the entry's, where the block says so; empty ones left out
 * unless `taxtermsHideEmpty` is false, block.json's default being true), `repeater` the rows of an ACF
 * repeater (`dynamic` is `acf` by default; `ctx.rowExpr` is `$map.item`). A loop with nothing to list is
 * its element, empty. Their items are `<div>` with no class (the plugin writes `<div >`).
 *
 * ## What the blocks inside a query know
 *
 * The plugin hands `hasPosts` and `queryCount` (`found_posts`: every match, not the page) to every block
 * below the query, and a block reads them in its `queryhasitems` and `querycount` hide conditions; the
 * query block itself passes `queryhasitems` (`cc_pass`). See {@link counting}: a block that holds such a
 * condition is answered with the list's length (or, for `querycount` on a cut list, the length of a
 * second, unlimited collection, written only when a block asks), and a Markdown entry's blocks are
 * decided now.
 *
 * ## State the conversion registers
 *
 * `ctx.defineState` of the driver's session (`Converted.state`; this module's own collector,
 * {@link collectedState}, serves a context made without one): `<type>_q<id>` (a native list),
 * `<type>_entries` (the unfiltered collection of a type, for computed lists), `terms_*` and `rows_*`
 * (plain arrays of data). The emitter of the page, template, part or component writes them into that
 * document's `state`. `ctx.hoist` receives one rule per component tag.
 *
 * ## Components
 *
 * An instance is the component's custom element (`ComponentInfo.tagName`) with `$props` and the
 * variant classes. The live page prints the component's root element and nothing around it, so the
 * tag is `display: contents` (one rule for the tag, through `ctx.hoist`): the root stays the flex or
 * grid item it was. `$props` hold the value the instance gives each property its component declares,
 * by the TYPE the component declares (an instance remembers the type the editor had then): text a
 * string, `richtext` HTML, `icon` the SVG markup, `link` `{href, target?, rel?, title?}`, `image`
 * `{src, alt?, width?, height?}`, `options` the chosen option's value, a class property a class list,
 * and a property that comes from the enclosing component (`parent`) a binding on its state. The value
 * the plugin reads is the OUTER `maker` (the inner `content` can be stale); a property the instance
 * does not give, or gives empty, is left out so the component's state default is used, as the plugin
 * does. A component with variants prints `cs-<id>` classes, the first variant when the instance
 * names none; the classes are on the host, and the component's own rules for them (`.cs-<id>` on
 * the elements inside) are the components emitter's.
 *
 * `serializedInnerBlocks` is the slot content: converted in the instance's context and written as
 * the host's children (the component's `innerblocks` is its one default `<slot>`).
 *
 * Report codes: `block.unsupported`, `query.approximated`, `query.url-parameter`, `query.pagination`,
 * `query.static`, `query.empty`, `query.type-unrouted`, `query.term-missing`, `query.slider`,
 * `loop.nested`, `component.missing`, `component.unknown-property`, `component.parent-unresolved`,
 * `component.property-unsupported`, `component.variant-unknown`, `component.markup-in-text`,
 * `block.innerblocks-outside`, and what the style, link, dynamic and condition modules report.
 */
import { createHash } from "node:crypto";
import { parseBlocks } from "../../wp/blocks.ts";
import { decodeEntities } from "../../wp/model.ts";
import { entryKey, taxonomiesFor } from "../../wp/acf.ts";
import { userProfiles } from "../../wp/profiles.ts";
import type {
  BlockConverter,
  ConvertCtx,
  JxElement,
  JxNode,
  WpBlock,
  WpPost,
  WpTerm,
} from "../../types.ts";
import {
  acfRef,
  fieldByKey,
  isExprRef,
  jsString,
  parseLocation,
  postFacts,
  userRef,
  resolveTokens,
  texturize,
  type EntryData,
  type Ref,
} from "../tokens.ts";
import { blockVisibility, type Visibility } from "../conditions.ts";
import { joinClass } from "../../jx-util.ts";
import { walkElements } from "../../placeholders.ts";
import {
  assemble,
  baseName,
  buildBlock,
  iconSvg,
  prepare,
  record,
  rewriteAddress,
  say,
  targetOf,
  text,
  type BlockEnv,
} from "./common.ts";

// ── Small readers ────────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A fragment of a state key: letters, digits and underscores. */
const keyOf = (name: string): string => {
  const k = name.replaceAll(/[^A-Za-z0-9_]/g, "_");
  return k === "" ? "_" : k;
};

/**
 * The start of a state key made from a post type. A key is read as `state.<key>` inside an
 * expression, where `state.3d_model_entries` is a malformed number and not an identifier, and
 * WordPress allows a post type like `3d-model`: a key never starts with a digit.
 */
const typeKey = (type: string): string => {
  const k = keyOf(type);
  return /^[0-9]/.test(k) ? `t_${k}` : k;
};

/**
 * What a `query*` attribute holds, once its `{source, type, group, field, fallback}` wrapper is read.
 * A static attribute carries its value in `field` (a text, a number, or a picked list of
 * `{value, label}`); a dynamic one names where the page reads it from.
 */
export type Src =
  | { kind: "none" }
  | { kind: "static"; values: string[]; flag?: boolean }
  | { kind: "dynamic"; type: string; group: string; field: string; fallback: string | undefined }
  | { kind: "ref" };

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;

/** Read one `query*` attribute. */
export function srcOf(attr: unknown): Src {
  const a = record(attr);
  if (a === undefined) {
    if (typeof attr === "boolean") return { kind: "static", values: [], flag: attr };
    const s = str(attr);
    return s === undefined || s === "" ? { kind: "none" } : { kind: "static", values: [s] };
  }
  if (a.source === "dynamic") {
    return {
      kind: "dynamic",
      type: str(a.type) ?? "",
      group: str(a.group) ?? "",
      field: str(a.field) ?? "",
      fallback: str(a.fallback),
    };
  }
  const f = a.field;
  if (typeof f === "boolean") return { kind: "static", values: [], flag: f };
  if (Array.isArray(f)) {
    const values = f
      .map((x) => (record(x) ? str(record(x)?.value) : str(x)))
      .filter((x): x is string => x !== undefined && x !== "");
    return values.length === 0 ? { kind: "none" } : { kind: "static", values };
  }
  const s = str(f);
  if (s === undefined || s === "") return { kind: "none" };
  if (s.includes("!ref=")) return { kind: "ref" };
  return { kind: "static", values: [s] };
}

/**
 * The values of a static attribute as a list. A picked list (`[{value, label}]`) keeps every pick
 * whole, a comma inside a term's name included; a typed text is split by `by` only where the plugin or
 * WordPress splits it (`explode(',')` for the ids and types of a `selector_maker`, `/[,\s]+/` for the
 * values of a meta `IN`), and is one value everywhere else (a tax clause's terms, a `LIKE`).
 */
function itemsOf(attr: unknown, by?: RegExp): string[] {
  const s = srcOf(attr);
  if (s.kind !== "static") return [];
  if (by === undefined || Array.isArray(record(attr)?.field)) return s.values;
  return s.values.flatMap((v) =>
    v
      .split(by)
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

/** `explode(',')`: how the plugin reads a typed list of ids, post types and taxonomies. */
const COMMAS = /,/;

/** `wp_parse_id_list`: how `WP_Term_Query` reads the `include` and `exclude` it is handed as text. */
const WP_ID_LIST = /[\s,]+/;

const staticOne = (s: Src): string | undefined => (s.kind === "static" ? s.values[0] : undefined);

// ── The plan ─────────────────────────────────────────────────────────────────────────────────────

/** A `ContentCollection` filter rule. Only the two operators whose meaning is the same in every reader are written. */
export interface Rule {
  field: string;
  op: "==" | "!=";
  value: string;
}

export interface SortRule {
  field: string;
  order: "asc" | "desc";
}

/** One condition on the entries of a query: a collection rule when it can be one, and the same as JavaScript over an entry `e`. */
export interface Cond {
  /** The rule a `ContentCollection` `filter` can say; absent when the condition needs more. */
  native?: Rule;
  /** A JavaScript expression over `e` (an entry `{id, data}`), true for an entry that stays. */
  js: string;
  /** Whether it reads page state (`state.entry`, `state.term`): it cannot be evaluated at conversion. */
  dynamic: boolean;
  /** What it says, for a report and a test. */
  why: string;
}

export interface PostPlan {
  kind: "posts";
  /** The post types, in the block's order. */
  types: string[];
  /** Entries per page; undefined: all. */
  perPage: number | undefined;
  offset: number;
  sort: SortRule[];
  conds: Cond[];
  /** The block has a way to reach what the first page does not show. */
  paginated: boolean;
  /** What the plan could not say, one line each (`query.approximated`). */
  dropped: string[];
}

export interface Unsupported {
  kind: "unsupported";
  /** `users`, `comments`, `products`, or the reason. */
  what: string;
  why: string;
}

export interface TermsPlan {
  kind: "terms";
  taxonomies: string[];
  exclude: number[];
  include: number[];
  /** `number`: undefined means all. */
  perPage: number | undefined;
  orderBy: string;
  order: "asc" | "desc";
  hideEmpty: boolean;
  /** `hide_empty` keeps an empty term that has a descendant with entries. */
  hierarchical: boolean;
  parent: number | undefined;
  dropped: string[];
}

/**
 * A list of people: the users an ACF user field of the current post holds (`queryInclude`), a list of
 * ids, or the people of some roles. Only people with a profile (`wp/profiles.ts`) are known. The block's
 * own `fallback` pick (`226`) is the editor's sample: the live page lists nobody for a post whose field
 * is empty (measured on an episode with no guest), so it is not used.
 */
export interface UsersPlan {
  kind: "users";
  /** The ACF field of the current post that names the people (its key). */
  field: { key: string } | undefined;
  ids: number[];
  roles: string[];
  rolesNotIn: string[];
  order: "asc" | "desc";
  dropped: string[];
}

export type QueryPlan = PostPlan | TermsPlan | UsersPlan | Unsupported;

// ── What the export has ──────────────────────────────────────────────────────────────────────────

/**
 * Post types that are documents, not content entries: a page is a Jx JSON page, a template, a part, a
 * component and a reusable block are never routed as content (docs/design.md, decisions). A
 * `ContentCollection` over one of them would be a list of nothing.
 */
const DOCUMENT_TYPES = new Set(["page", "wp_template", "wp_template_part", "cc_block", "wp_block"]);

/** The posts of a type that become entries: published, not password protected, with a page of their own. */
export function entryPosts(ctx: ConvertCtx, type: string): WpPost[] {
  const out: WpPost[] = [];
  if (DOCUMENT_TYPES.has(type)) return out;
  for (const post of ctx.model.posts.values()) {
    if (post.type !== type || post.status !== "publish" || post.passwordProtected) continue;
    if (ctx.urlFor("post", post.id) === undefined) continue;
    out.push(post);
  }
  return out;
}

/** The terms of a taxonomy, in the order the export has them. */
const termsIn = (ctx: ConvertCtx, taxonomy: string): WpTerm[] =>
  [...ctx.model.terms.values()].filter((t) => t.taxonomy === taxonomy);

/** Every descendant of a term, in its own taxonomy. */
function descendants(ctx: ConvertCtx, term: WpTerm): WpTerm[] {
  const all = termsIn(ctx, term.taxonomy);
  const out: WpTerm[] = [];
  const seen = new Set<number>([term.termId]);
  const queue = [term.termId];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const t of all) {
      if (t.parent === parent && !seen.has(t.termId)) {
        seen.add(t.termId);
        out.push(t);
        queue.push(t.termId);
      }
    }
  }
  return out;
}

/** `{parentSlug: [descendant slugs]}` of a taxonomy, only for the terms that have any. */
function childMap(ctx: ConvertCtx, taxonomy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const term of termsIn(ctx, taxonomy)) {
    const kids = descendants(ctx, term).map((t) => t.slug);
    if (kids.length > 0) out[term.slug] = kids;
  }
  return out;
}

// ── Where the "current" things are ───────────────────────────────────────────────────────────────

/**
 * The entry the conversion is for: an entry template reads it from page state, a static page knows it,
 * and everything else (a part, a component) has none. A loop item (`$map.item`) is an entry too, but a
 * list that depends on it cannot be computed in a state entry.
 */
export type Current =
  | { kind: "entry"; expr: string }
  | { kind: "post"; post: WpPost; facts: EntryData }
  | { kind: "none" };

const isStateExpr = (expr: string): boolean => /^state(\.|\[|$)/.test(expr);

export function currentOf(ctx: ConvertCtx): Current {
  if (ctx.mode === "entry") return { kind: "entry", expr: ctx.entryExpr };
  const post = ctx.mode === "static" && ctx.subject.kind === "post" ? ctx.subject.post : undefined;
  return post === undefined
    ? { kind: "none" }
    : { kind: "post", post, facts: postFacts(ctx, post) };
}

/** The archive's term as expressions, when the conversion has one that a state entry can read. */
function archiveTerm(ctx: ConvertCtx): { slug: string; taxonomy: string } | undefined {
  const t = ctx.termExpr;
  if (t === undefined || !isStateExpr(t) || /^\$map\b/.test(t)) return undefined;
  return { slug: `${t}.data.slug`, taxonomy: `${t}.data.taxonomy` };
}

// ── The JavaScript the conditions are written in ─────────────────────────────────────────────────

/** Helpers a Function body needs, written once at its top. Each is a single `const`, so the body reads top to bottom. */
const HAS = "const has = (e, t, s) => (e.data.terms?.[t] ?? []).some((x) => s.includes(x.slug));";
const META =
  "const m = (e, k) => { const v = e.data[k]; return v === undefined || v === null ? undefined : v === true ? '1' : v === false ? '0' : String(v); };";
const BY =
  "const by = (f, d, c) => (a, b) => { const x = a.data[f] ?? ''; const y = b.data[f] ?? ''; return (c ? coll(x, y) : x < y ? -1 : x > y ? 1 : 0) * d; };";

/**
 * How MySQL orders titles (`utf8mb4_unicode_520_ci`, the collation of WordPress's `post_title`): without
 * regard to case or accents, a space before every other punctuation mark, the marks in the order the
 * Unicode collation algorithm gives them (a straight quote before its typographic one, `[` before `@`),
 * then the digits, then the letters. `Intl.Collator` is not the same function: its root collation puts
 * a straight and a curly quote at one primary weight, and a title that starts with either then sorts by
 * its next letter. The marks are listed as code points, because the build finds the end of a `${…}` by
 * counting braces without reading strings (docs/bindings.md, rule 13).
 */
const COLL = [
  "const P = [32, 95, 45, 8211, 8212, 44, 59, 58, 33, 63, 46, 8230, 39, 8216, 8217, 34, 8220, 8221, 40, 41, 91, 93, 123, 125, 64, 42, 47, 92, 38, 35, 37, 96, 94, 43, 60, 61, 62, 124, 126, 36];",
  "const rank = (c) => { const n = c.trim() === '' ? 32 : c.codePointAt(0); const i = P.indexOf(n); return i >= 0 ? i : n >= 48 && n <= 57 ? 100 + n : n >= 97 && n <= 122 ? 200 + n : 1000 + n; };",
  "const fold = (s) => [...String(s).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase()].map(rank);",
  "const coll = (x, y) => { const a = fold(x); const b = fold(y); for (let i = 0; i < a.length && i < b.length; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; } return a.length < b.length ? -1 : a.length > b.length ? 1 : 0; };",
].join(" ");

/** The comparison of two titles, made from the same source the computed lists carry, so a list and its evaluation cannot disagree. */
const collate = new Function(`${COLL} return coll;`)() as (x: unknown, y: unknown) => number;

/**
 * A JavaScript literal for a value, every string through `jsString`: the build finds the end of a
 * `${…}` by counting braces without reading strings, so a brace, a dollar or a backtick of a literal is
 * written as an escape (docs/bindings.md, rule 13).
 */
const j = (v: unknown): string => {
  if (typeof v === "string") return jsString(v);
  if (Array.isArray(v)) return `[${v.map(j).join(", ")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.entries(v)
      .map(([k, x]) => `${jsString(k)}: ${j(x)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
};

/** The conditions' helper `const`s that a set of expressions uses. */
function prelude(code: string): string[] {
  const out: string[] = [];
  if (/\bhas\(/.test(code)) out.push(HAS);
  if (/\bm\(/.test(code)) out.push(META);
  if (/\bby\(/.test(code)) {
    if (/\bby\([^()]*, -?1, 1\)/.test(code)) out.push(COLL);
    out.push(BY);
  }
  return out;
}

const isDynamic = (js: string): boolean => /\bstate\b/.test(js);

// ── Terms in a tax query ─────────────────────────────────────────────────────────────────────────

/** The terms a static tax clause names, by the field the clause says they are given in. */
function resolveTerms(
  ctx: ConvertCtx,
  field: string,
  values: string[],
  taxonomy: string | undefined,
  missing: string[],
): WpTerm[] {
  const out: WpTerm[] = [];
  for (const raw of values) {
    let found: WpTerm | undefined;
    const n = Number(raw);
    for (const t of ctx.model.terms.values()) {
      if (field === "term_taxonomy_id") {
        if (Number.isInteger(n) && t.taxonomyId === n) found = t;
      } else if (taxonomy !== undefined && t.taxonomy !== taxonomy) {
        continue;
      } else if (field === "slug") {
        if (t.slug === raw) found = t;
      } else if (field === "name") {
        // The column holds the name as WordPress stored it (`Study &amp; Education`), which is what a query
        // has to say to match; the decoded form is what the editor shows, and is accepted too.
        if (t.name === raw || decodeEntities(t.name) === decodeEntities(raw)) found = t;
      } else if (Number.isInteger(n) && t.termId === n) {
        found = t;
      }
      if (found) break;
    }
    if (found) out.push(found);
    else missing.push(`${field || "term_id"} ${raw}`);
  }
  return out;
}

/** The slugs of terms, by taxonomy. */
function slugsByTaxonomy(terms: WpTerm[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of terms) {
    const slugs = out.get(t.taxonomy) ?? [];
    if (!slugs.includes(t.slug)) slugs.push(t.slug);
    out.set(t.taxonomy, slugs);
  }
  return out;
}

/** The site's own shortcodes a term source names (`[project_type_id]`: the first term of that taxonomy on the current post). */
function shortcodeKind(
  ctx: ConvertCtx,
  name: string,
): { kind: "archive" } | { kind: "first"; taxonomy: string } | { kind: "taxonomy" } | undefined {
  if (name === "object_id" || name === "term_id") return { kind: "archive" };
  if (name === "taxonomy") return { kind: "taxonomy" };
  const m = /^(.+)_id$/.exec(name);
  const taxonomy = m?.[1];
  if (taxonomy === undefined) return undefined;
  const known =
    ctx.acf.taxonomies.has(taxonomy) ||
    taxonomy === "category" ||
    taxonomy === "post_tag" ||
    [...ctx.model.terms.values()].some((t) => t.taxonomy === taxonomy);
  return known ? { kind: "first", taxonomy } : undefined;
}

interface Clause {
  js: string;
  why: string;
}

interface PlanEnv {
  ctx: ConvertCtx;
  block: WpBlock;
  /** One line per thing left out. */
  dropped: string[];
  /** Things worth saying, but nothing was lost. */
  info: { code: string; message: string; detail: string; severity?: "info" | "warn" }[];
  current: Current;
}

const drop = (env: PlanEnv, what: string): void => {
  if (!env.dropped.includes(what)) env.dropped.push(what);
};

/** A tax clause (`IN`, `NOT IN`, `AND`, `EXISTS`, `NOT EXISTS`) over slugs of one taxonomy or of several. */
function termClause(operator: string, byTax: Map<string, string[]>): string {
  const op = operator.toUpperCase();
  const parts = [...byTax].map(([tax, slugs]) =>
    op === "AND"
      ? slugs.map((s) => `has(e, ${j(tax)}, ${j([s])})`).join(" && ")
      : `has(e, ${j(tax)}, ${j(slugs)})`,
  );
  const any = parts.length === 0 ? "false" : op === "AND" ? parts.join(" && ") : parts.join(" || ");
  return op === "NOT IN" ? `!(${any || "false"})` : `(${any})`;
}

/** One tax clause of a query: `{taxonomy, field, terms, operator, include_children}`, each one a wrapped attribute. */
function taxClause(env: PlanEnv, clause: Rec): Clause | undefined {
  const { ctx } = env;
  const taxSrc = srcOf(clause.taxonomy);
  const fieldSrc = srcOf(clause.field);
  const termsSrc = srcOf(clause.terms);
  const operator = staticOne(srcOf(clause.operator)) ?? "IN";
  const children = clause.include_children !== false;
  const field = staticOne(fieldSrc) ?? "term_id";
  const missing: string[] = [];

  // The taxonomy: named, or the archive's.
  let taxonomy: string | undefined;
  let taxonomyExpr: string | undefined;
  if (taxSrc.kind === "static") taxonomy = staticOne(taxSrc);
  else if (taxSrc.kind === "dynamic") {
    const archive = archiveTerm(ctx);
    if (archive && (taxSrc.group === "currenttaxonomyarchive" || taxSrc.group === "shortcode")) {
      taxonomyExpr = archive.taxonomy;
    } else {
      drop(env, `a taxonomy read from ${taxSrc.group || taxSrc.type}`);
      return undefined;
    }
  } else if (taxSrc.kind === "ref") {
    drop(env, "a taxonomy chosen by a component property");
    return undefined;
  }

  // The plugin gives every clause with no terms the operator `XXX` (`front_prep`), which WordPress
  // does not apply: that is `EXISTS` and `NOT EXISTS` too, so a clause that picks no terms filters nothing.
  if (termsSrc.kind === "none") return undefined;
  const existsOnly = /^(NOT )?EXISTS$/i.test(operator);
  if (existsOnly) {
    if (taxonomy === undefined) return undefined;
    const has = `(e.data.terms?.[${j(taxonomy)}] ?? []).length > 0`;
    return {
      js: /^NOT/i.test(operator) ? `!(${has})` : `(${has})`,
      why: `${operator} ${taxonomy}`,
    };
  }

  // The terms.
  if (termsSrc.kind === "ref") {
    drop(env, "terms chosen by a component property");
    return undefined;
  }
  if (termsSrc.kind === "static") {
    const values = itemsOf(clause.terms);
    let terms = resolveTerms(ctx, field, values, taxonomy, missing);
    if (children && terms.length > 0) {
      const kids = terms.flatMap((t) => descendants(ctx, t));
      terms = [...terms, ...kids.filter((k) => !terms.includes(k))];
    }
    for (const m of missing) {
      env.info.push({
        code: "query.term-missing",
        message: `The query names ${m}, which the export does not have (or has in another taxonomy); it matches nothing.`,
        detail: m,
      });
    }
    const byTax = slugsByTaxonomy(terms);
    return {
      js: termClause(operator, byTax),
      why: `${operator} ${[...byTax].map(([t, s]) => `${t}:${s.join("|")}`).join(" ")}`,
    };
  }
  // A dynamic source.
  const group = termsSrc.group;
  if (group === "urlparameter") {
    env.info.push({
      code: "query.url-parameter",
      message: `The query is filtered by the URL parameter ${j(termsSrc.field)}, which a static site never has: the list is the unfiltered one, as the live page's with no parameter.`,
      detail: termsSrc.field,
    });
    return undefined;
  }
  const code =
    group === "shortcode"
      ? shortcodeKind(ctx, termsSrc.field)
      : group === "currenttaxonomytermarchive"
        ? ({ kind: "archive" } as const)
        : group === "postterms"
          ? taxonomy === undefined
            ? undefined
            : ({ kind: "first-all", taxonomy } as const)
          : undefined;
  if (code === undefined) {
    drop(
      env,
      `terms read from ${group || termsSrc.type}${termsSrc.field ? ` (${termsSrc.field})` : ""}`,
    );
    return undefined;
  }
  const op = operator.toUpperCase();
  if (code.kind === "taxonomy") {
    drop(env, "terms that are the taxonomy of the archive");
    return undefined;
  }
  // What the build can know: the slugs the source stands for, as an expression, and the taxonomy to look them up in.
  let slugs: string;
  let tax: string;
  let kidsOf: Record<string, string[]> = {};
  let what: string;
  if (code.kind === "archive") {
    const archive = archiveTerm(ctx);
    if (archive === undefined) {
      drop(env, "the term of an archive, where this conversion has no archive");
      return undefined;
    }
    slugs = `[${archive.slug}].filter(Boolean)`;
    tax = taxonomy === undefined ? (taxonomyExpr ?? archive.taxonomy) : j(taxonomy);
    if (taxonomy !== undefined && children) kidsOf = childMap(ctx, taxonomy);
    what = "the archive term";
  } else {
    // The current post's terms of the clause's taxonomy: the first by name (a `<taxonomy>_id` shortcode) or all of them (`postterms`).
    const taxName = code.taxonomy;
    const cur = env.current;
    const all = code.kind === "first-all";
    if (cur.kind === "entry" && isStateExpr(cur.expr) && !/^\$map\b/.test(cur.expr)) {
      const own = `${cur.expr}.data.terms?.[${j(taxName)}]`;
      slugs = all ? `(${own} ?? []).map((x) => x.slug)` : `[${own}?.[0]?.slug].filter(Boolean)`;
    } else if (cur.kind === "post") {
      const own =
        (cur.facts.terms as Record<string, { slug: string }[]> | undefined)?.[taxName] ?? [];
      slugs = j((all ? own : own.slice(0, 1)).map((t) => t.slug));
    } else {
      drop(
        env,
        `the ${all ? "" : "first "}${taxName} term of the current post, where this conversion has no current post`,
      );
      return undefined;
    }
    tax = j(taxName);
    if (children) kidsOf = childMap(ctx, taxName);
    what = `${all ? "the" : "the first"} ${taxName} term${all ? "s" : ""} of the current post`;
  }
  // No term, no clause (the plugin marks it `XXX`); otherwise the term and its children are what an entry must carry.
  const reach = Object.keys(kidsOf).length > 0 ? `[s, ...(${j(kidsOf)}[s] ?? [])]` : "[s]";
  const some = `sl.flatMap((s) => ${reach})`;
  const test =
    op === "AND"
      ? `sl.every((s) => has(e, ${tax}, ${reach}))`
      : op === "NOT IN"
        ? `!has(e, ${tax}, ${some})`
        : `has(e, ${tax}, ${some})`;
  return { js: `((sl) => sl.length === 0 || ${test})(${slugs})`, why: `${operator} ${what}` };
}

/** `tax_query` of a query: the clauses, joined by the relation the block says (AND by default). */
function taxConds(env: PlanEnv, a: Rec): Cond[] {
  const clauses: string[] = [];
  const whys: string[] = [];
  const relation = (str(a.queryTaxonomyRelation) ?? "").toUpperCase() === "OR" ? "||" : "&&";
  for (const raw of list(a.queryTaxonomy)) {
    const clause = record(raw);
    if (clause === undefined) continue;
    let made: Clause | undefined;
    if (clause.multiple === true) {
      // A group: its own list of clauses with its own relation.
      const inner = list(clause.tax_query)
        .map((c) => (record(c) ? taxClause(env, record(c)!) : undefined))
        .filter((c): c is Clause => c !== undefined);
      if (inner.length > 0) {
        const rel = (str(clause.relation) ?? "").toUpperCase() === "OR" ? " || " : " && ";
        made = {
          js: `(${inner.map((c) => c.js).join(rel)})`,
          why: inner.map((c) => c.why).join(rel),
        };
      }
    } else {
      made = taxClause(env, clause);
    }
    if (made) {
      clauses.push(made.js);
      whys.push(made.why);
    }
  }
  if (clauses.length === 0) return [];
  const js = clauses.length === 1 ? clauses[0]! : `(${clauses.join(` ${relation} `)})`;
  return [{ js, dynamic: isDynamic(js), why: `tax_query ${whys.join(` ${relation} `)}` }];
}

// ── Meta, exclusions, search, order ──────────────────────────────────────────────────────────────

/** `preg_split('/[,\s]+/')`: how `WP_Meta_Query` reads the text of an `IN`, `NOT IN` or `BETWEEN`. */
const META_LIST = /[,\s]+/;

/**
 * The comparisons whose answer depends on telling a field that has no stored value from one that holds
 * an empty one, or a switch that was never saved from one that is off: WordPress joins the meta table
 * and sees the rows, an entry holds only what the collections module wrote (an empty value is absent,
 * `false` is read as `'0'`). Everything else compares a value that is there, and agrees.
 */
const NEEDS_ROWS = new Set([
  "EXISTS",
  "NOT EXISTS",
  "!=",
  "NOT LIKE",
  "NOT IN",
  "NOT REGEXP",
  "NOT RLIKE",
]);

/**
 * A meta comparison of an ACF value, as JavaScript over the entry. Values are compared as the strings
 * WordPress stores (`true` is `'1'`), and, as MySQL's collation does, without regard to case (`LIKE`,
 * `REGEXP` and `=` alike). A comparison that needs the meta rows themselves is applied to what the
 * entry holds and said (`query.approximated`): the list can differ by the entries whose field was
 * never filled.
 */
function metaClause(env: PlanEnv, m: Rec): Clause | undefined {
  const key = staticOne(srcOf(m.key));
  const compare = (staticOne(srcOf(m.compare)) ?? "=").toUpperCase();
  if (key === undefined) return undefined;
  const valueAttr = record(m.value);
  const boolean = valueAttr?.formatType === "boolean" || valueAttr?.formatType === "bool";
  let values = itemsOf(m.value, /^(NOT )?(IN|BETWEEN)$/.test(compare) ? META_LIST : undefined);
  if (boolean) values = values.map((v) => (/^(true|1)$/i.test(v) ? "1" : "0"));
  const numeric = /^(NUMERIC|DECIMAL|SIGNED|UNSIGNED)/i.test(staticOne(srcOf(m.type)) ?? "");
  const field = entryKey(key);
  const read = `m(e, ${j(field)})`;
  const one = values[0] ?? "";
  const num = (x: string): string => `Number(${x})`;
  /** The literal a value is compared with: lower case, because the comparison lower-cases what it reads. */
  const low = (x: string): string => j(x.toLowerCase());
  const cmp = (op: string): string =>
    numeric ? `${num("v")} ${op} ${num(j(one))}` : `v.toLowerCase() ${op} ${low(one)}`;
  let body: string;
  switch (compare) {
    case "=":
      body = `v !== undefined && ${cmp("===")}`;
      break;
    case "!=":
      body = `v !== undefined && ${cmp("!==")}`;
      break;
    case ">":
    case ">=":
    case "<":
    case "<=":
      body = `v !== undefined && ${cmp(compare)}`;
      break;
    case "LIKE":
      body = `v !== undefined && v.toLowerCase().includes(${low(one)})`;
      break;
    case "NOT LIKE":
      body = `v !== undefined && !v.toLowerCase().includes(${low(one)})`;
      break;
    case "IN":
      body = `v !== undefined && ${j(values.map((x) => x.toLowerCase()))}.includes(v.toLowerCase())`;
      break;
    case "NOT IN":
      body = `v !== undefined && !${j(values.map((x) => x.toLowerCase()))}.includes(v.toLowerCase())`;
      break;
    case "EXISTS":
      body = "v !== undefined";
      break;
    case "NOT EXISTS":
      body = "v === undefined";
      break;
    case "REGEXP":
    case "RLIKE":
      body = `v !== undefined && new RegExp(${j(one)}, 'i').test(v)`;
      break;
    case "NOT REGEXP":
    case "NOT RLIKE":
      body = `v !== undefined && !new RegExp(${j(one)}, 'i').test(v)`;
      break;
    default:
      drop(env, `a meta comparison ${compare} on ${key}`);
      return undefined;
  }
  if (NEEDS_ROWS.has(compare)) {
    env.info.push({
      code: "query.approximated",
      severity: "warn",
      message: `The query compares ${key} with ${compare}, which WordPress answers from the stored meta rows (a field never filled has none, an empty one has an empty row); an entry holds no such difference, so an entry whose ${key} has no value is decided as if it were empty: the list can differ from the live page's by those entries.`,
      detail: `meta ${compare} ${key}`,
    });
  }
  return { js: `((v) => ${body})(${read})`, why: `meta ${key} ${compare} ${values.join(",")}` };
}

function metaConds(env: PlanEnv, a: Rec): Cond[] {
  const parts: Clause[] = [];
  for (const raw of list(a.queryMeta)) {
    const m = record(raw);
    if (m === undefined) continue;
    if (list(m.meta_query).length > 0 && m.multiple === true) {
      const inner = list(m.meta_query)
        .map((x) => (record(x) ? metaClause(env, record(x)!) : undefined))
        .filter((c): c is Clause => c !== undefined);
      if (inner.length > 0) {
        const rel = (str(m.relation) ?? "").toUpperCase() === "OR" ? " || " : " && ";
        parts.push({
          js: `(${inner.map((c) => c.js).join(rel)})`,
          why: inner.map((c) => c.why).join(rel),
        });
      }
    } else {
      const made = metaClause(env, m);
      if (made) parts.push(made);
    }
  }
  if (parts.length === 0) return [];
  const rel = (str(a.queryMetaRelation) ?? "").toUpperCase() === "OR" ? " || " : " && ";
  const js = parts.length === 1 ? parts[0]!.js : `(${parts.map((p) => p.js).join(rel)})`;
  return [{ js, dynamic: false, why: parts.map((p) => p.why).join(rel) }];
}

/** `url` is what names an entry: unique across the site, and a collection filter can read it. */
function urlRule(url: string, why: string): Cond {
  return {
    native: { field: "url", op: "!=", value: url },
    js: `e.data.url !== ${j(url)}`,
    dynamic: false,
    why,
  };
}

/**
 * The author clauses: the author of the page being rendered (`queryAuthorName`, `queryAuthorIn`, source
 * `authorname`: an author's own page, or "more by this author" on a post) or the authors a list of ids
 * names (`queryAuthor`). An entry knows its author by the address of the author's page (`authorUrl`).
 */
function authorConds(env: PlanEnv, a: Rec): Cond[] {
  const { ctx } = env;
  const out: Cond[] = [];
  const ofPage = ["queryAuthorName", "queryAuthorIn"].some((name) => {
    const src = srcOf(a[name]);
    return src.kind === "dynamic" && src.group === "authorname";
  });
  if (ofPage) {
    const cur = env.current;
    if (cur.kind === "entry" && isStateExpr(cur.expr) && !/^\$map\b/.test(cur.expr)) {
      out.push({
        js: `e.data.authorUrl === ${cur.expr}.data.authorUrl`,
        dynamic: true,
        why: "the author of the page",
      });
    } else if (cur.kind === "post") {
      const url = ctx.urlForAuthor?.(cur.post.authorId);
      if (url === undefined) drop(env, "the author of the page, who has no page of their own");
      else
        out.push({
          js: `e.data.authorUrl === ${j(url)}`,
          dynamic: false,
          why: "the author of the page",
        });
    } else drop(env, "the author of the page, where this conversion has no page");
  } else {
    for (const name of ["queryAuthorName", "queryAuthorIn"])
      if (holdsValue(a[name])) drop(env, name);
  }
  const ids = itemsOf(a.queryAuthor, COMMAS).map(Number).filter(Number.isInteger);
  if (srcOf(a.queryAuthor).kind === "static" && ids.length > 0) {
    const urls = ids
      .map((id) => ctx.urlForAuthor?.(id))
      .filter((u): u is string => u !== undefined);
    out.push({
      js: `${j(urls)}.includes(e.data.authorUrl)`,
      dynamic: false,
      why: `authors ${ids.join(",")}`,
    });
  } else if (srcOf(a.queryAuthor).kind === "dynamic")
    drop(env, "authors read from a dynamic source");
  return out;
}

function excludeConds(env: PlanEnv, a: Rec): Cond[] {
  const { ctx } = env;
  const out: Cond[] = [];
  const include = srcOf(a.queryInclude);
  const includeIds = itemsOf(a.queryInclude, COMMAS);
  if (include.kind === "static" && includeIds.length > 0) {
    const urls = includeIds
      .map((id) => ctx.urlFor("post", Number(id)))
      .filter((u): u is string => u !== undefined);
    out.push({
      js: `${j(urls)}.includes(e.data.url)`,
      dynamic: false,
      why: `include posts ${includeIds.join(",")}`,
    });
    // `WP_Query` ignores `post__not_in` once `post__in` names the posts: so do the exclusions.
    return out;
  }
  if (include.kind === "dynamic") drop(env, `posts read from ${include.group || include.type}`);
  for (const id of itemsOf(a.queryExclude, COMMAS)) {
    const url = ctx.urlFor("post", Number(id));
    if (url !== undefined) out.push(urlRule(url, `exclude post ${id}`));
  }
  const excludeCurrent = srcOf(a.queryExcludeCurrent);
  if (excludeCurrent.kind === "static" && excludeCurrent.flag === true) {
    const cur = env.current;
    if (cur.kind === "post") {
      const url = ctx.urlFor("post", cur.post.id);
      if (url !== undefined) out.push(urlRule(url, "exclude the current post"));
    } else if (cur.kind === "entry" && isStateExpr(cur.expr) && !/^\$map\b/.test(cur.expr)) {
      const js = `e.data.url !== ${cur.expr}.data.url`;
      out.push({ js, dynamic: true, why: "exclude the current entry" });
    } else {
      drop(env, "the exclusion of the current post, where this conversion has no current post");
    }
  }
  return out;
}

function searchConds(env: PlanEnv, a: Rec): Cond[] {
  const s = srcOf(a.querySearch);
  if (s.kind === "none") return [];
  if (s.kind === "dynamic") {
    if (s.group === "urlparameter") {
      env.info.push({
        code: "query.url-parameter",
        message: `The query searches for the URL parameter ${j(s.field)}, which a static site never has: the list is the unfiltered one.`,
        detail: s.field,
      });
    } else {
      drop(env, `a search read from ${s.group || s.type}`);
    }
    return [];
  }
  if (s.kind === "static" && s.values[0] !== undefined) {
    drop(
      env,
      `a search for ${j(s.values[0])} (the entries' titles and excerpts are searched instead of their whole text)`,
    );
    return [
      {
        js: `((e.data.title ?? '') + ' ' + (e.data.excerpt ?? '')).toLowerCase().includes(${j(s.values[0].toLowerCase())})`,
        dynamic: false,
        why: `search ${s.values[0]}`,
      },
    ];
  }
  return [];
}

const ORDER_FIELDS: Record<string, string> = {
  date: "date",
  modified: "modified",
  title: "title",
  name: "slug",
};

function sortOf(env: PlanEnv, a: Rec): SortRule[] {
  const by = staticOne(srcOf(a.queryOrderBy)) ?? "date";
  const order = (staticOne(srcOf(a.queryOrder)) ?? "DESC").toUpperCase() === "ASC" ? "asc" : "desc";
  if (by in ORDER_FIELDS) return [{ field: ORDER_FIELDS[by]!, order }];
  if (by === "meta_value" || by === "meta_value_num") {
    const key = staticOne(srcOf(a.queryMetaKey));
    if (key !== undefined) return [{ field: entryKey(key), order }];
    drop(env, `ordering by ${by} with no meta key`);
  } else if (by !== "relevance") {
    drop(env, `ordering by ${by}, which an entry has no value for (by date instead)`);
  }
  return [{ field: "date", order }];
}

/** Whether a block has a way to reach the entries the first page does not show. */
export function isPaginated(block: WpBlock): boolean {
  if (block.attrs.infiniteLoad === true) return true;
  const stack = [...block.innerBlocks];
  while (stack.length > 0) {
    const b = stack.pop()!;
    if (b.name === "cwicly/query-pagination" || b.name === "cwicly/query-pagination-numbers")
      return true;
    const action = text(b.attrs.linkWrapperAction);
    if (action === "prevQuery" || action === "nextQuery" || action === "infiniteButtonLoad")
      return true;
    stack.push(...b.innerBlocks);
  }
  return false;
}

/** The `query*` attributes this module reads; any other one that holds a value is a condition left out. */
const READ_ATTRS = new Set([
  "queryType",
  "queryId",
  "queryOld",
  "queryInherit",
  "queryPostType",
  "queryPerPage",
  "queryOffset",
  "queryOrder",
  "queryOrderBy",
  "queryMetaKey",
  "queryExclude",
  "queryInclude",
  "queryExcludeCurrent",
  "queryTaxonomy",
  "queryTaxonomyRelation",
  "queryMeta",
  "queryMetaRelation",
  "querySearch",
  "queryPage",
  "querySticky",
  "queryPostStatus",
  "queryTaxonomies",
  "queryAuthor",
  "queryAuthorName",
  "queryAuthorIn",
]);

/** Whether an attribute holds anything that narrows or changes a query. */
function holdsValue(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  const a = record(v);
  if (a === undefined) return true;
  if ("source" in a) {
    if (a.source === "dynamic") return str(a.group) !== undefined && a.group !== "";
    return srcOf(v).kind !== "none";
  }
  return Object.keys(a).length > 0;
}

// ── The plan of a query ──────────────────────────────────────────────────────────────────────────

const postsPerPageOption = (ctx: ConvertCtx): number => {
  const n = Number(ctx.model.options.get("posts_per_page"));
  return Number.isInteger(n) && n > 0 ? n : 10;
};

const SKIP = new Set(["queryStatus"]);

/** PHP's `is_numeric` on a typed number. */
const NUMBER = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/** `absint` of what the editor stored, or undefined when PHP would not take it for a number. */
function absint(value: string | undefined): number | undefined {
  if (value === undefined || !NUMBER.test(value)) return undefined;
  return Math.abs(Math.trunc(Number(value)));
}

/** What `WP_Query` is given as `posts_per_page`: the plugin passes an `absint` of a number, so `-1` is 1 and `0` or a word is the site's own. */
function perPageOf(ctx: ConvertCtx, a: Rec): number {
  const n = absint(staticOne(srcOf(a.queryPerPage)));
  return n === undefined || n === 0 ? postsPerPageOption(ctx) : n;
}

/** The descendants of every term of every taxonomy that has a hierarchy: `{taxonomy: {slug: [descendant slugs]}}`. */
function hierarchies(ctx: ConvertCtx): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  const taxonomies = new Set<string>();
  for (const t of ctx.model.terms.values()) if (t.parent > 0) taxonomies.add(t.taxonomy);
  for (const taxonomy of taxonomies) out[taxonomy] = childMap(ctx, taxonomy);
  return out;
}

/** Whether the post list of the site's sticky option holds anything (`a:0:{}` is the empty one). */
const hasSticky = (ctx: ConvertCtx): boolean =>
  /^a:[1-9]/.test(ctx.model.options.get("sticky_posts") ?? "");

/**
 * The post type of the page being rendered: an entry template's, or the post a static page is. A
 * template, a part or a component is no post of a type (its own post is a `wp_template`).
 */
const mainTypeOf = (ctx: ConvertCtx): string | undefined =>
  ctx.entryType ?? (ctx.subject.kind === "post" ? ctx.subject.post?.type : undefined);

function planPosts(block: WpBlock, ctx: ConvertCtx, env: PlanEnv): PostPlan {
  const a = block.attrs;
  const dropped = env.dropped;

  // `queryInherit` is true by default, and Gutenberg leaves out an attribute that equals its default:
  // only an explicit `false` is a query of the block's own. An inheriting query is the template's main
  // query (`wp_parse_args($wp_query->query_vars, $args)`), whose own variables win: its post type, its
  // `posts_per_page` (the site's), its `order` (descending), and an empty `post__in`, `post__not_in`
  // and `s`, which is what the main query always holds, so the block's inclusions, exclusions and
  // search are overwritten. Its `tax_query` and `meta_query` are not variables of the main query and stay.
  const inherit = a.queryInherit !== false;
  const archive = archiveTerm(ctx);
  const mainType = mainTypeOf(ctx);

  // Which post types. A taxonomy archive has no post type of its own (its main query lists every type
  // the taxonomy is on), and the block's own choice is the nearest thing a static site has.
  let types: string[];
  const typeSrc = srcOf(a.queryPostType);
  const inheritType = inherit ? mainType : undefined;
  if (inheritType !== undefined) types = [inheritType];
  else if (typeSrc.kind === "static") types = itemsOf(a.queryPostType, COMMAS);
  else if (typeSrc.kind === "dynamic") {
    types = [mainType ?? "post"];
    if (typeSrc.group !== "posttype")
      drop(env, `the post type read from ${typeSrc.group || typeSrc.type}`);
  } else types = ["post"];
  if (types.length === 0) types = ["post"];
  const routed: string[] = [];
  for (const type of types) {
    if (entryPosts(ctx, type).length > 0) routed.push(type);
    else
      env.info.push({
        code: "query.type-unrouted",
        message: DOCUMENT_TYPES.has(type)
          ? `The query lists the post type ${j(type)}, which is a document and not a content entry on the converted site (pages are Jx pages, not a collection): it is left out.`
          : `The query lists the post type ${j(type)}, which has no entries on the converted site (none is published and routed); it is left out.`,
        detail: type,
      });
  }
  types = routed;

  const conds: Cond[] = [
    ...(inherit ? [] : excludeConds(env, a)),
    ...taxConds(env, a),
    ...authorConds(env, a),
    ...metaConds(env, a),
    ...(inherit ? [] : searchConds(env, a)),
  ];
  if (inherit) {
    if (archive) {
      const kids = hierarchies(ctx);
      const reach = Object.keys(kids).length === 0 ? "[s]" : `[s, ...(${j(kids)}[t]?.[s] ?? [])]`;
      const js = `((s, t) => !s || has(e, t, ${reach}))(${archive.slug}, ${archive.taxonomy})`;
      conds.push({ js, dynamic: true, why: "the archive's term" });
    } else if (mainType !== undefined) {
      // A singular main query is the one post.
      const cur = env.current;
      if (cur.kind === "post") {
        const url = ctx.urlFor("post", cur.post.id);
        conds.push({
          js: url === undefined ? "false" : `e.data.url === ${j(url)}`,
          dynamic: false,
          why: "the current post (the main query of a single is that post)",
        });
      } else if (cur.kind === "entry" && isStateExpr(cur.expr) && !/^\$map\b/.test(cur.expr)) {
        conds.push({
          js: `e.data.url === ${cur.expr}.data.url`,
          dynamic: true,
          why: "the current entry (the main query of a single is that entry)",
        });
      }
    }
  }

  // Which of the attributes nobody reads hold something.
  for (const [name, value] of Object.entries(a)) {
    if (!name.startsWith("query") || READ_ATTRS.has(name) || SKIP.has(name)) continue;
    if (holdsValue(value)) drop(env, name);
  }
  // Two that are read only to be told apart from their defaults: every entry is a published post.
  const status = srcOf(a.queryPostStatus);
  if (status.kind === "dynamic")
    drop(env, `the post status read from ${status.group || status.type}`);
  else if (status.kind === "static") {
    const wanted = itemsOf(a.queryPostStatus, COMMAS);
    if (wanted.some((x) => x !== "publish"))
      drop(
        env,
        `the post status ${wanted.join(", ")} (the converted site lists published posts only)`,
      );
  }
  const sticky = srcOf(a.querySticky);
  if (sticky.kind === "static" && sticky.flag === true && hasSticky(ctx))
    drop(env, "the sticky posts first (the converted site has no sticky order)");

  const off = inherit ? 0 : (absint(staticOne(srcOf(a.queryOffset))) ?? 0);
  const sort = sortOf(env, a).map((r) => (inherit ? { ...r, order: "desc" as const } : r));

  return {
    kind: "posts",
    types,
    perPage: inherit ? postsPerPageOption(ctx) : perPageOf(ctx, a),
    offset: off,
    sort,
    conds,
    paginated: isPaginated(block),
    dropped,
  };
}

const TERM_ORDER = new Set([
  "name",
  "slug",
  "term_group",
  "term_id",
  "id",
  "description",
  "parent",
  "count",
  "none",
]);

/** A switch the plugin reads as `$attr ? true : false`: absent is the block.json default. */
function toggle(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v !== "" && v !== "0";
  if (typeof v === "number") return v !== 0;
  const s = srcOf(v);
  if (s.kind !== "static") return fallback;
  return s.flag ?? s.values.some((x) => x !== "" && x !== "0");
}

function planTerms(block: WpBlock, env: PlanEnv): TermsPlan {
  const a = block.attrs;
  const taxonomies = itemsOf(a.queryTaxonomies, COMMAS);
  const by = staticOne(srcOf(a.queryOrderBy)) ?? "name";
  const per = staticOne(srcOf(a.queryPerPage));
  const parent = staticOne(srcOf(a.queryParent));
  // `get: 'all'` is WP_Term_Query's "every term": it turns `hide_empty`, `hierarchical`, `childless`
  // and `child_of` off, whatever the block says. The block's default is `empty` (the usual rules).
  const everything = staticOne(srcOf(a.queryGet)) === "all";
  for (const name of [
    "queryName",
    "querySlug",
    "queryNameLike",
    "queryDescriptionLike",
    ...(everything ? [] : ["queryChildOf", "queryChildless"]),
    "queryExcludeTree",
    "queryObjectIDs",
    "querySearch",
  ]) {
    if (holdsValue(a[name])) drop(env, name);
  }
  return {
    kind: "terms",
    taxonomies: taxonomies.length === 0 ? ["category"] : taxonomies,
    exclude: itemsOf(a.queryExclude, WP_ID_LIST).map(Number).filter(Number.isInteger),
    include: itemsOf(a.queryInclude, WP_ID_LIST).map(Number).filter(Number.isInteger),
    perPage: per !== undefined && Number(per) > 0 ? Number(per) : undefined,
    orderBy: TERM_ORDER.has(by) ? by : "name",
    order: (staticOne(srcOf(a.queryOrder)) ?? "ASC").toUpperCase() === "DESC" ? "desc" : "asc",
    // block.json: `queryHideEmpty` is true by default, so a block that never touched it hides them.
    hideEmpty: !everything && toggle(a.queryHideEmpty, true),
    hierarchical: !everything && toggle(a.queryHierarchical, false),
    parent: parent !== undefined && Number.isInteger(Number(parent)) ? Number(parent) : undefined,
    dropped: env.dropped,
  };
}

/** Query attributes of a users query that name something a static list cannot follow. */
const USER_QUERY_UNSUPPORTED = [
  "queryMeta",
  "queryWho",
  "queryHasPublishedPosts",
  "queryBlogId",
  "querySearchColumn",
];

function planUsers(block: WpBlock, env: PlanEnv): UsersPlan {
  const a = block.attrs;
  const include = srcOf(a.queryInclude);
  let field: UsersPlan["field"];
  let ids: number[] = [];
  if (include.kind === "static") {
    ids = itemsOf(a.queryInclude, WP_ID_LIST).map(Number).filter(Number.isInteger);
  } else if (include.kind === "dynamic") {
    if (include.type === "acf" && include.field !== "") {
      field = { key: include.field };
    } else drop(env, `people read from ${include.group || include.type}`);
  } else if (include.kind === "ref") drop(env, "people chosen by a component property");
  const search = srcOf(a.querySearch);
  if (search.kind === "dynamic" && search.group === "urlparameter") {
    env.info.push({
      code: "query.url-parameter",
      message: `The query is filtered by the URL parameter ${j(search.field)}, which a static site never has: the list is the unfiltered one, as the live page's with no parameter.`,
      detail: search.field,
    });
  } else if (search.kind !== "none") drop(env, "a search of the people");
  for (const name of USER_QUERY_UNSUPPORTED) if (holdsValue(a[name])) drop(env, name);
  return {
    kind: "users",
    field,
    ids,
    roles: itemsOf(a.queryRole, COMMAS),
    rolesNotIn: itemsOf(a.queryRoleNotIn, COMMAS),
    order: (staticOne(srcOf(a.queryOrder)) ?? "ASC").toUpperCase() === "DESC" ? "desc" : "asc",
    dropped: env.dropped,
  };
}

/**
 * What a `cwicly/query` block asks for, as a plan the rest of this module writes as Jx state (or
 * evaluates, for a Markdown entry and for the counts). `env.info` and `env.dropped` carry what was
 * left out or only worth saying; {@link planQuery} is the entry point for tests.
 */
export function planQuery(
  block: WpBlock,
  ctx: ConvertCtx,
): { plan: QueryPlan; info: PlanEnv["info"] } {
  const env: PlanEnv = { ctx, block, dropped: [], info: [], current: currentOf(ctx) };
  const type = str(block.attrs.queryType) ?? "posts";
  if (type === "users") return { plan: planUsers(block, env), info: env.info };
  if (type === "comments" || type === "products") {
    const why =
      type === "comments" ? "the converted site has no comments" : "the converted site has no shop";
    return { plan: { kind: "unsupported", what: type, why }, info: [] };
  }
  if (type === "terms") return { plan: planTerms(block, env), info: env.info };
  if (type !== "posts") {
    return {
      plan: { kind: "unsupported", what: type, why: `${type} is not a query type this tool knows` },
      info: [],
    };
  }
  return { plan: planPosts(block, ctx, env), info: env.info };
}

// ── Evaluating a plan ────────────────────────────────────────────────────────────────────────────

/** An entry as the build hands it to a Function body or an `Array`: `{id, data}`. */
export interface EntryLike {
  id: string;
  data: EntryData;
}

const entryLike = (ctx: ConvertCtx, post: WpPost): EntryLike => {
  const authorUrl = ctx.urlForAuthor?.(post.authorId);
  return {
    id: ctx.urlFor("post", post.id) ?? String(post.id),
    // An entry holds the address of its author's page (`authorUrl`, written by the collections), which a clause on the author reads.
    data: { ...postFacts(ctx, post), ...(authorUrl === undefined ? {} : { authorUrl }) },
  };
};

/** The conditions of a plan compiled to one function over an entry: how the posts of a plan are selected now. */
export function compileConditions(conds: readonly Cond[]): (e: EntryLike) => boolean {
  if (conds.length === 0) return () => true;
  const code = prelude(conds.map((c) => c.js).join("\n")).join("\n");
  const body = `${code}\nreturn (${conds.map((c) => `(${c.js})`).join(" && ")});`;
  // The source is built here from the export's own values, every string through JSON.stringify.
  return new Function("e", "state", body).bind(undefined) as (
    e: EntryLike,
    state?: unknown,
  ) => boolean;
}

/**
 * Titles are ordered by MySQL's case-insensitive collation (`Barn Painting in Lebanon` before `Barn
 * Painting In Manheim`), which neither a code-unit comparison nor a `ContentCollection` sort says: a
 * list ordered by title is a computed list, and this is its comparison.
 */
const COLLATED = new Set(["title"]);

const nameOrder = new Intl.Collator("en", { sensitivity: "base" });

const compare =
  (rules: readonly SortRule[]) =>
  (a: EntryLike, b: EntryLike): number => {
    for (const { field, order } of rules) {
      const x = (a.data[field] ?? "") as string | number;
      const y = (b.data[field] ?? "") as string | number;
      const c = COLLATED.has(field) ? collate(x, y) : x < y ? -1 : x > y ? 1 : 0;
      if (c !== 0) return order === "asc" ? c : -c;
    }
    return 0;
  };

/**
 * The posts a plan selects now, in order: what a Markdown entry writes out, what the counts of
 * `query.pagination` are, and the oracle of the tests. `undefined` for a plan that reads page state.
 * `all` ignores the page size (a query with a pagination device, by default).
 */
export function evaluatePosts(
  ctx: ConvertCtx,
  plan: PostPlan,
  opts: { all?: boolean } = {},
): WpPost[] | undefined {
  if (plan.conds.some((c) => c.dynamic)) return undefined;
  const keep = compileConditions(plan.conds);
  const entries = plan.types
    .flatMap((type) => entryPosts(ctx, type))
    .map((post) => ({ post, e: entryLike(ctx, post) }))
    .filter(({ e }) => keep(e));
  const order = compare(plan.sort);
  entries.sort((a, b) => order(a.e, b.e));
  const from = plan.offset;
  const all = opts.all ?? plan.paginated;
  const to = all || plan.perPage === undefined ? undefined : from + plan.perPage;
  return entries.slice(from, to).map((x) => x.post);
}

// ── State ────────────────────────────────────────────────────────────────────────────────────────

/** `ctx.defineState` of a subject's session (site.ts), or this module's own collector for a context that has none. */
interface StateCtx {
  defineState?: (key: string, definition: unknown) => string;
}

const ownState = new WeakMap<object, Map<string, unknown>>();

/** The state entries `defineState` kept for a context that had no collector of its own, by report. */
export const collectedState = (ctx: ConvertCtx): Map<string, unknown> =>
  ownState.get(ctx.report) ?? new Map();

/**
 * Register a page-level state entry and get the key it was stored under. The driver's session
 * collects them (`Converted.state`); a context made without one keeps them in {@link collectedState}.
 */
export function defineState(ctx: ConvertCtx, key: string, definition: unknown): string {
  const own = (ctx as StateCtx).defineState;
  if (typeof own === "function") return own.call(ctx, key, definition);
  let state = ownState.get(ctx.report);
  if (!state) ownState.set(ctx.report, (state = new Map()));
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  let use = key;
  for (let n = 2; state.has(use) && !same(state.get(use), definition); n++) use = `${key}_${n}`;
  state.set(use, definition);
  return use;
}

/** The pointer `{"$ref": …}` to a path under an expression of page state or a loop item; undefined for any other expression. */
export function pointerOf(base: string, ...path: string[]): string | undefined {
  const esc = (s: string): string => s.replaceAll("~", "~0").replaceAll("/", "~1");
  if (base === "$map.item") return ["$map/item", ...path.map(esc)].join("/");
  const m = /^state((?:\.[A-Za-z_$][\w$]*)+)$/.exec(base);
  if (!m) return undefined;
  const parts = m[1]!.slice(1).split(".");
  return ["#/state", ...parts.map(esc), ...path.map(esc)].join("/");
}

/** A short stable name for a query of no id. */
const hashOf = (value: unknown): string =>
  createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 6);

/** The class a `ContentCollection` state entry names: `jx validate` refuses the entry without it. */
const COLLECTION_SRC = "@jxsuite/parser/ContentCollection.class.json";

/**
 * Where a loop reads its list: a pointer into page state (a collection, an array of rows, the entry's
 * own terms), or a JavaScript expression the build evaluates (`state` in scope) and the loop is written
 * around. A collection's `filter` cannot read a nested field or the current entry, and `jx validate`
 * refuses a Function state entry with `timing: "compiler"`, so a list a collection cannot say is the
 * computed children of the spec's section 8.4.
 */
export type ListSource = { pointer: string } | { expr: string };

/** The expression of a source's length (the count a hide condition asks about). */
export const lengthOf = (source: ListSource): string =>
  "pointer" in source
    ? `${source.pointer.replace(/^#\//, "").replaceAll("/", ".")}.length`
    : `(${source.expr}).length`;

/**
 * The list a post plan selects as a source for a loop. A single post type with nothing but collection
 * rules is one `ContentCollection` (`filter`, `sort`, `limit`); anything else is an expression over
 * unfiltered collections, one state entry per post type, shared by every list of the page.
 * `opts.inline` writes the expression even for a native plan (the tests compare the two).
 */
export function registerPostList(
  ctx: ConvertCtx,
  plan: PostPlan,
  id: string,
  opts: { inline?: boolean } = {},
): ListSource {
  const base = typeKey(plan.types[0] ?? "post");
  const name = `${base}_q${keyOf(id)}`;
  const limit = plan.paginated ? undefined : plan.perPage;
  const sorts = plan.sort.map((s) => ({ field: s.field, order: s.order }));
  const natives = plan.conds.map((c) => c.native);
  const allNative = natives.every((n): n is Rule => n !== undefined);
  const collated = plan.sort.some((r) => COLLATED.has(r.field));
  if (
    opts.inline !== true &&
    plan.types.length === 1 &&
    allNative &&
    plan.offset === 0 &&
    !collated
  ) {
    const key = defineState(ctx, name, {
      $prototype: "ContentCollection",
      $src: COLLECTION_SRC,
      contentType: plan.types[0],
      ...(natives.length > 0 ? { filter: natives } : {}),
      sort: sorts,
      ...(limit === undefined ? {} : { limit }),
      timing: "compiler",
    });
    return { pointer: `#/state/${key}` };
  }
  const sources = plan.types.map(
    (type) =>
      `state.${defineState(ctx, `${typeKey(type)}_entries`, {
        $prototype: "ContentCollection",
        $src: COLLECTION_SRC,
        contentType: type,
        timing: "compiler",
      })}`,
  );
  const tests = plan.conds.map((c) => `(${c.js})`);
  const sorting = sorts
    .map(
      (s) =>
        `by(${j(s.field)}, ${s.order === "asc" ? 1 : -1}${COLLATED.has(s.field) ? ", 1" : ""})(a, b)`,
    )
    .join(" || ");
  const chain = [
    `[${sources.map((s) => `...${s}`).join(", ")}]`,
    ...(tests.length > 0 ? [`.filter((e) => ${tests.join(" && ")})`] : []),
    `.sort((a, b) => ${sorting === "" ? "0" : sorting})`,
    ...(limit === undefined && plan.offset === 0
      ? []
      : [`.slice(${plan.offset}${limit === undefined ? "" : `, ${plan.offset + limit}`})`]),
  ].join("");
  const helpers = prelude(`${chain}\nby(`);
  return { expr: `(() => { ${[...helpers, `return ${chain};`].join(" ")} })()` };
}

// ── Terms ────────────────────────────────────────────────────────────────────────────────────────

/** A term as a loop item holds it. Entries carry `{slug, name, url}`; a list from the export adds the rest. */
export interface TermRow {
  slug: string;
  name: string;
  url: string;
  description: string;
  taxonomy: string;
}

const termRow = (ctx: ConvertCtx, t: WpTerm): TermRow => ({
  slug: t.slug,
  name: decodeEntities(t.name),
  url: ctx.urlFor("term", t.termId) ?? "",
  description: t.description,
  taxonomy: t.taxonomy,
});

const TERM_KEYS: Record<string, (t: WpTerm) => string | number> = {
  name: (t) => decodeEntities(t.name),
  slug: (t) => t.slug,
  term_id: (t) => t.termId,
  id: (t) => t.termId,
  count: (t) => t.count,
  parent: (t) => t.parent,
  description: (t) => t.description,
  term_group: () => 0,
  none: () => 0,
};

/** Sort terms the way `WP_Term_Query` does: by the key, names by the database's case-insensitive collation. */
function sortTerms(terms: WpTerm[], by: string, order: "asc" | "desc"): WpTerm[] {
  const key = TERM_KEYS[by] ?? TERM_KEYS.name!;
  const dir = order === "asc" ? 1 : -1;
  return [...terms].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : nameOrder.compare(String(x), String(y));
    return c * dir;
  });
}

const USER_ORDER: Readonly<Record<string, string>> = {
  display_name: "title",
  name: "title",
  nicename: "slug",
  login: "slug",
  user_login: "slug",
  user_nicename: "slug",
  ID: "id",
  id: "id",
  // `date` is a post's key: WP_User_Query does not know it, and an `orderby` it cannot parse is
  // `user_login` (the plugin passes the block's value on as it is), so the people are by login.
  // An account's `user_nicename` is its login, lowercased and hyphenated, and the export has that.
  date: "slug",
  // Registration order is the order of the accounts.
  registered: "id",
  user_registered: "id",
};

/**
 * The people of a users query as a source for a loop: the ACF user field of the current post (an
 * expression over the entry, or the people it names now on a static page), a fixed list of ids, or the
 * people of some roles. A person the export has no profile for is not on the list, and the report says so.
 */
export function userList(
  ctx: ConvertCtx,
  plan: UsersPlan,
  block: WpBlock,
): {
  source: ListSource;
  notes: { code: string; severity: "info" | "warn"; message: string; detail: string }[];
} {
  const notes: { code: string; severity: "info" | "warn"; message: string; detail: string }[] = [];
  const person = (id: number): Rec | undefined => {
    const found = userRef(ctx, id);
    if (found === undefined) {
      notes.push({
        code: "query.user-missing",
        severity: "warn",
        message: `The query lists the user ${id}, who is not on the converted site (no account the export carries has that id).`,
        detail: String(id),
      });
    }
    return found as Rec | undefined;
  };
  const by = USER_ORDER[staticOne(srcOf(block.attrs.queryOrderBy)) ?? ""] ?? "slug";
  const sorted = (rows: Rec[]): Rec[] => {
    const flip = plan.order === "desc" ? -1 : 1;
    return rows.sort((a, b) => {
      const x = a[by] as string | number;
      const y = b[by] as string | number;
      return flip * (typeof x === "number" ? x - (y as number) : collate(String(x), String(y)));
    });
  };
  const fixed = (): Rec[] => {
    if (plan.field === undefined && plan.ids.length > 0) {
      return sorted(plan.ids.map(person).filter((r): r is Rec => r !== undefined));
    }
    // The people of some roles: those with a profile, since no other account is read.
    const ids = [...userProfiles(ctx.model).values()]
      .filter(
        (p) =>
          (plan.roles.length === 0 || plan.roles.some((r) => p.roles.includes(r))) &&
          !plan.rolesNotIn.some((r) => p.roles.includes(r)),
      )
      .map((p) => p.id);
    if (plan.roles.length > 0 || plan.rolesNotIn.length > 0) {
      notes.push({
        code: "query.users-profiled",
        severity: "info",
        message: `The list of people${plan.roles.length > 0 ? ` of the role ${plan.roles.join(", ")}` : ""} holds the ${ids.length} accounts that have a profile (the photograph, position and biography fields): an account with none is not read, so it is not on the list.`,
        detail: [...plan.roles, ...plan.rolesNotIn.map((r) => `!${r}`)].join(","),
      });
    }
    return sorted(ids.map(person).filter((r): r is Rec => r !== undefined));
  };
  const staticSource = (rows: Rec[]): ListSource =>
    rows.length === 0
      ? NOTHING
      : {
          pointer: rowsPointer(
            ctx,
            `users_q${keyOf(str(block.attrs.queryId) ?? hashOf(rows))}`,
            rows,
          ),
        };

  if (plan.field === undefined) return { source: staticSource(fixed()), notes };
  const info = fieldByKey(ctx.acf, plan.field.key);
  if (info === undefined || info.field.type !== "user") {
    notes.push({
      code: "query.approximated",
      severity: "warn",
      message: `The query takes its people from the ACF field ${plan.field.key}, which ${info === undefined ? "no field group defines" : `is a ${info.field.type}, not a user field`}: the list is left empty.`,
      detail: plan.field.key,
    });
    return { source: NOTHING, notes };
  }
  const found = acfRef(ctx, info, { kind: "current" });
  if (!("ref" in found)) {
    notes.push({
      code: "query.approximated",
      severity: "warn",
      message: `The query takes its people from the ACF field ${info.field.name}, which cannot be read here (${found.problem}): the list is left empty.`,
      detail: info.field.name,
    });
    return { source: NOTHING, notes };
  }
  const ref: Ref = found.ref;
  if (!isExprRef(ref)) {
    const held = ref.value === undefined || ref.value === null ? [] : [ref.value].flat();
    return { source: staticSource(held as Rec[]), notes };
  }
  // A person is one object (a field that holds one) or a list of them; an entry with none lists nobody.
  const pick = `[].concat(${ref.expr} ?? [])`;
  // WP_User_Query orders the people it was given by the block's own order (registration, newest first, by default).
  const flip = plan.order === "desc" ? -1 : 1;
  const compare =
    by === "id"
      ? `${flip} * (a.id - b.id)`
      : `${flip} * String(a.${by}).localeCompare(String(b.${by}))`;
  return { source: { expr: `${pick}.slice().sort((a, b) => ${compare})` }, notes };
}

/** The terms a `terms` query lists, in order. */
export function termRows(ctx: ConvertCtx, plan: TermsPlan): TermRow[] {
  let terms = plan.taxonomies.flatMap((tax) => termsIn(ctx, tax));
  if (plan.include.length > 0) terms = terms.filter((t) => plan.include.includes(t.termId));
  if (plan.exclude.length > 0) terms = terms.filter((t) => !plan.exclude.includes(t.termId));
  if (plan.hideEmpty) {
    // A hierarchical query keeps an empty term that has a descendant with entries.
    terms = terms.filter(
      (t) => t.count > 0 || (plan.hierarchical && descendants(ctx, t).some((d) => d.count > 0)),
    );
  }
  if (plan.parent !== undefined) terms = terms.filter((t) => t.parent === plan.parent);
  terms = sortTerms(terms, plan.orderBy, plan.order);
  if (plan.perPage !== undefined) terms = terms.slice(0, plan.perPage);
  return terms.map((t) => termRow(ctx, t));
}

// ── The loop a query hands to its template ──────────────────────────────────────────────────────

const LOOP = Symbol("wp2jx.data.loop");

/**
 * What a `query` tells the blocks inside it: the list a `query-template` repeats over (a pointer into
 * page state), the posts it repeats over when a Markdown entry has no state to point at, or nothing
 * (a query with no entries to show, or that this tool cannot translate: the template keeps its box).
 */
export type Loop =
  | {
      kind: "live";
      source: ListSource;
      entryType?: string;
      terms?: boolean;
      users?: boolean;
      /** The rows themselves, for a list the item is written out for (a component's terms). */
      rows?: readonly unknown[];
    }
  | { kind: "static"; posts: WpPost[] }
  | { kind: "none" };

const loopOf = (ctx: ConvertCtx): Loop | undefined =>
  (ctx as unknown as Record<symbol, Loop | undefined>)[LOOP];

/** Context overrides that carry a loop (or clear it, with `undefined`) to the blocks inside. */
const withLoop = (loop: Loop | undefined, more: Partial<ConvertCtx> = {}): Partial<ConvertCtx> =>
  ({ ...more, [LOOP]: loop }) as unknown as Partial<ConvertCtx>;

/** Whether the blocks being converted become a component (a Cwicly component or a template part). */
const inComponent = (ctx: ConvertCtx): boolean =>
  ctx.mode === "component" || (ctx as { inComponent?: boolean }).inComponent === true;

/** A mapped array over a pointer. */
function mapped(pointer: string, map: JxElement): JxElement {
  return { $prototype: "Array", items: { $ref: pointer }, map } as unknown as JxElement;
}

// ── A list the build computes: children written as an expression ────────────────────────────────

/** Where each `${…}` of a string ends, by the rule the build uses: braces counted without reading strings (docs/bindings.md, rule 13). */
function bindingParts(text: string): { lit?: string; expr?: string }[] {
  const parts: { lit?: string; expr?: string }[] = [];
  let at = 0;
  for (;;) {
    const start = text.indexOf("${", at);
    if (start < 0) break;
    let level = 0;
    let end = -1;
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === "{") level++;
      else if (text[i] === "}" && --level === 0) {
        end = i;
        break;
      }
    }
    // An unterminated `${` is no binding: the build does not read it as one.
    if (end < 0) break;
    if (start > at) parts.push({ lit: text.slice(at, start) });
    parts.push({ expr: text.slice(start + 2, end) });
    at = end + 1;
  }
  if (at < text.length) parts.push({ lit: text.slice(at) });
  return parts;
}

/** A loop's variables at a depth: the item and its index, which `$map.item` and `$map.index` mean in the node written there. */
const scope = (depth: number, expr: string): string =>
  expr.replaceAll(/\$map\.item\b/g, `$i${depth}`).replaceAll(/\$map\.index\b/g, `$x${depth}`);

/**
 * A string of a node as an expression. A string with no binding is its text. One that is a single
 * binding is that binding's value (so `false` still leaves an attribute out and a list stays a
 * list); a mixed one is the literal parts and the bindings joined, the literal parts read the way the
 * build reads a template literal (a backslash or a backtick is escaped), and a binding that is
 * undefined prints `undefined`, as it does there.
 */
function stringExpr(text: string, depth: number): string {
  if (!text.includes("${")) return j(text);
  const parts = bindingParts(text);
  const each = parts.map((p) =>
    p.expr !== undefined
      ? `(${scope(depth, p.expr)})`
      : j((p.lit ?? "").replaceAll(/\\([\\`])/g, "$1")),
  );
  if (parts.length === 1 && parts[0]!.expr !== undefined) return each[0]!;
  return parts[0]!.expr !== undefined ? `'' + ${each.join(" + ")}` : each.join(" + ");
}

/** The expression of the list a loop node reads: its pointer, from a loop item (`$map/item/…`) or from page state (`#/state/…`). */
function pointerExpr(ref: string, depth: number): string | undefined {
  const base = ref.startsWith("$map/item")
    ? `$i${depth}`
    : ref.startsWith("#/state/")
      ? "state"
      : undefined;
  if (base === undefined) return undefined;
  const path = ref
    .replace(/^\$map\/item\/?/, "")
    .replace(/^#\/state\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((seg) => seg.replaceAll("~1", "/").replaceAll("~0", "~"));
  return `(${base}${path.map((seg) => (/^[A-Za-z_$][\w$]*$/.test(seg) ? `?.${seg}` : `?.[${j(seg)}]`)).join("")} ?? [])`;
}

const isLoopNode = (v: unknown): v is { $prototype: "Array"; items: unknown; map?: unknown } =>
  v !== null && typeof v === "object" && !Array.isArray(v) && (v as Rec).$prototype === "Array";

/** A node, or a part of one, as a JavaScript literal whose strings are expressions and whose loops are `map`s. */
function nodeExpr(value: unknown, depth: number): string {
  if (typeof value === "string") return stringExpr(value, depth);
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => {
        if (!isLoopNode(item)) return nodeExpr(item, depth);
        const ref = record(item.items)?.$ref;
        const list = typeof ref === "string" ? pointerExpr(ref, depth) : undefined;
        if (list === undefined)
          throw new Error("a loop inside a computed list needs a pointer it can read");
        return `...${list}.map(($i${depth + 1}, $x${depth + 1}) => (${nodeExpr(item.map, depth + 1)}))`;
      })
      .join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([k, v]) => `${jsString(k)}: ${nodeExpr(v, depth)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

const hasLoopRefs = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  (Array.isArray(value)
    ? value.some(hasLoopRefs)
    : "$prototype" in value || "$ref" in value || Object.values(value).some(hasLoopRefs));

/** The value of a binding that reads the row alone, or `undefined` when it reads anything else (a name the build knows and this does not) or fails. */
function rowValue(expr: string, row: unknown, index: number): { value: unknown } | undefined {
  try {
    return { value: new Function("$map", `return (${expr});`)({ item: row, index }) };
  } catch {
    return undefined;
  }
}

/** A string of the item for one row: each binding of the row replaced by its value, any other left as it is. */
function rowString(text: string, row: unknown, index: number): unknown {
  if (!text.includes("${")) return text;
  const parts = bindingParts(text);
  const values = parts.map((p) =>
    p.expr === undefined ? undefined : rowValue(p.expr, row, index),
  );
  const only = parts[0]!;
  if (parts.length === 1 && only.expr !== undefined) {
    const v = values[0];
    return v !== undefined && (v.value === null || typeof v.value !== "object") ? v.value : text;
  }
  return parts
    .map((p, i) =>
      p.expr === undefined
        ? p.lit
        : values[i] === undefined
          ? `\${${p.expr}}`
          : String(values[i]!.value),
    )
    .join("");
}

function rowNode(value: unknown, row: unknown, index: number): unknown {
  if (typeof value === "string") return rowString(value, row, index);
  if (Array.isArray(value)) return value.map((v) => rowNode(v, row, index));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rowNode(v, row, index)]));
  return value;
}

/**
 * The item once per row, with the row's values written in: the children of a list whose rows are known
 * and that must not be a `$ref` (a component's), or `undefined` when the item holds a loop of its own.
 */
export function writtenOut(item: JxElement, rows: readonly unknown[]): JxNode[] | undefined {
  if (hasLoopRefs(item)) return undefined;
  return rows.map((row, index) => rowNode(item, row, index) as JxNode);
}

/** The children of a loop's element: the mapped array over a pointer, or the computed children that write each item of an expression's list. */
export function loopChildren(source: ListSource, item: JxElement): JxNode[] {
  if ("pointer" in source) return [mapped(source.pointer, item)];
  return [`\${(${source.expr}).map(($i0, $x0) => (${nodeExpr(item, 0)}))}`];
}

/**
 * What the item trees of the computed lists in `nodes` hold that a walker of the nodes cannot see: the
 * class names, the element tags (a component's, a placeholder's). The nodes' tree walkers read
 * elements, and a computed list is one string, so the class pruning of the compatibility stylesheet,
 * the component registration of a page and the placeholder replacement need this added to what they
 * found (`classes` and `tags`); a tag that starts with `wp2jx-` is a placeholder no emitter can replace
 * in there ({@link loopChildren} reports it where it is made).
 */
export function usesInComputedLists(nodes: readonly JxNode[]): {
  classes: Set<string>;
  tags: Set<string>;
} {
  const classes = new Set<string>();
  const tags = new Set<string>();
  for (const element of walkElements(nodes)) {
    const [only] = Array.isArray(element.children) ? element.children : [];
    if (typeof only !== "string" || !only.startsWith("${(")) continue;
    for (const m of only.matchAll(/'className': '((?:[^'\\]|\\.)*)'/g)) {
      for (const name of m[1]!.split(/\s+/)) if (name !== "") classes.add(name);
    }
    for (const m of only.matchAll(/'tagName': '((?:[^'\\]|\\.)*)'/g)) tags.add(m[1]!);
  }
  return { classes, tags };
}

/** Say what a computed list cannot keep: a placeholder an emitter would have replaced, which stays as it is in there. */
function sayHidden(ctx: ConvertCtx, block: WpBlock, source: ListSource, item: JxElement): void {
  if ("pointer" in source) return;
  const left = new Set(
    [...walkElements([item])]
      .map((e) => e.tagName)
      .filter((t): t is string => typeof t === "string" && t.startsWith("wp2jx-")),
  );
  if (left.size === 0) return;
  say(
    ctx,
    block,
    "loop.placeholder",
    "error",
    `The items of this list are computed when the page is built, and ${[...left].map((t) => `<${t}>`).join(", ")} inside them cannot be replaced by an emitter: it stays an element no browser knows.`,
    { detail: [...left].join(","), tags: [...left] },
  );
}

/** The context a loop item is converted in: `$map.item` is the entry, and the loop is not the block's own any more. */
function itemContext(loop: Extract<Loop, { kind: "live" }>): Partial<ConvertCtx> {
  const more: Record<string, unknown> =
    loop.users === true
      ? // A person is a row, not the entry: the page's own entry is still the entry.
        { rowExpr: "$map.item" }
      : loop.terms === true
        ? { termExpr: "$map.item" }
        : {
            mode: "entry",
            entryExpr: "$map.item",
            // `$map` inside is the entry; an enclosing repeater's row is out of reach.
            rowExpr: undefined,
            // The page's own type is not the items' (a list of several types has none: they carry `postType`).
            entryType: loop.entryType,
          };
  return withLoop(undefined, more as Partial<ConvertCtx>);
}

/** Convert a post's loop item for a Markdown entry: the template as a static page of that post. */
const staticItemContext = (post: WpPost, ctx: ConvertCtx): Partial<ConvertCtx> =>
  withLoop(undefined, {
    mode: "static",
    subject: { kind: "post", id: String(post.id), post },
    entryType: post.type,
    // The entry the items are written into decides what they may hold, not the type of the post they show.
    target: targetOf(ctx),
  });

const severityOf: Record<string, "info" | "warn"> = {
  "query.url-parameter": "info",
  "query.term-missing": "warn",
  "query.type-unrouted": "warn",
};

// ── query ────────────────────────────────────────────────────────────────────────────────────────

// ── What the blocks inside a query know about its count ──────────────────────────────────────────

/**
 * The conditions that read the query a block sits in: `queryhasitems` (the plugin's `hasPosts`: the
 * page of results is not empty) and `querycount` (`found_posts`: every match, before the page size
 * cuts it). `queryissinglepage` is the number of pages, which a list with no pages cannot say.
 */
const COUNT_CONDITIONS = new Set(["queryhasitems", "querycount"]);

/** The numbers a query hands the blocks inside it, as expressions: how many it shows, and how many match. */
interface Counts {
  shown: string;
  total: () => string;
}

/** A block's hide conditions, unless it has turned them all off. */
const conditionsOf = (block: WpBlock): Rec[] =>
  block.attrs.hideConditionsToggle === true
    ? []
    : list(block.attrs.hideConditions)
        .map((c) => record(c))
        .filter((c): c is Rec => c !== undefined);

/**
 * The query block itself passes a `queryhasitems` condition, whatever its operator (`cc_pass` in
 * `cc-conditions.php`: the context that holds the count is the query's own, and the block that makes
 * it is not inside it). `&&` loses the entry, which is true; `||` is true as a whole.
 */
function passingOwnCount(block: WpBlock): WpBlock {
  const entries = list(block.attrs.hideConditions);
  const is = (c: unknown): boolean => record(c)?.condition === "queryhasitems";
  if (!entries.some(is)) return block;
  const or = (str(block.attrs.hideConditionsType) ?? "&&") === "||";
  return {
    ...block,
    attrs: {
      ...block.attrs,
      hideConditions: or ? [] : entries.filter((c) => !is(c)),
      ...(or ? { hideConditionsType: "&&" } : {}),
    },
  };
}

/**
 * A `${…}` of numbers and operators only, with no state or loop item in it, is a fact at conversion
 * time: a Markdown entry has no state, and its blocks are decided now.
 */
function decided(hidden: string): boolean | undefined {
  const inner = /^\$\{([\s\S]*)\}$/.exec(hidden)?.[1];
  if (inner === undefined || /\b(state|\$map)\b/.test(inner)) return undefined;
  try {
    const value: unknown = new Function(`return (${inner});`)();
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** What a block's visibility says, written onto the elements it was converted to (the same three things `assemble` writes). */
function showing(nodes: JxNode[], vis: Visibility, now: boolean | undefined): JxNode[] {
  if (now === true) return [];
  return nodes.map((node) => {
    if (typeof node === "string") return node;
    const style: Record<string, unknown> = {
      ...(node.style as Record<string, unknown> | undefined),
    };
    if (now === undefined && vis.hiddenStyle) Object.assign(style, vis.hiddenStyle);
    for (const key of Object.keys(vis.deviceHide ?? {})) {
      style[`@--${key}`] = { ...(style[`@--${key}`] as object | undefined), display: "none" };
    }
    return {
      ...node,
      ...(now === undefined && vis.hidden !== undefined
        ? { attributes: { ...node.attributes, hidden: vis.hidden } }
        : {}),
      ...(Object.keys(style).length > 0 ? { style } : {}),
    } as JxElement;
  });
}

/**
 * `ctx.convert` for the blocks inside a query, which gives each of them the query's count. The plugin
 * hands `hasPosts` and `queryCount` to every block below the query through its context, and a block
 * reads them for its own `queryhasitems` and `querycount` conditions. Every converter asks the
 * conditions module about its own block, with no way to pass it this, so a block that holds such a
 * condition is answered here (`blockVisibility` with the count) and converted with its conditions turned
 * off, and what the answer says is written on what it became. `acc` is everything laid over `base`
 * between here and the block being converted: a nested `convert` composes it, as `withOverrides` does,
 * and a caller's own `convert` is its own.
 */
function counting(
  base: ConvertCtx,
  counts: Counts,
  acc: Partial<ConvertCtx>,
): ConvertCtx["convert"] {
  return (blocks, again) => {
    const overrides: Partial<ConvertCtx> = again === undefined ? acc : { ...acc, ...again };
    const next: Partial<ConvertCtx> = {
      ...overrides,
      convert: again?.convert ?? counting(base, counts, overrides),
    };
    const out: JxNode[] = [];
    for (const block of blocks) {
      const wanted = conditionsOf(block);
      const mine = wanted.filter((c) => COUNT_CONDITIONS.has(String(c.condition)));
      // A query inside the query makes its own count; a condition this module cannot count is the conditions module's.
      if (
        mine.length === 0 ||
        block.name === "cwicly/query" ||
        wanted.some((c) => c.condition === "queryissinglepage")
      ) {
        out.push(...base.convert([block], next));
        continue;
      }
      const count = mine.some((c) => c.condition === "querycount") ? counts.total() : counts.shown;
      const vis = blockVisibility(block, { ...base, ...next } as ConvertCtx, { queryCount: count });
      if (vis.omit) continue;
      const plain: WpBlock = { ...block, attrs: { ...block.attrs, hideConditionsToggle: true } };
      const now = vis.hidden !== undefined && /^\d+$/.test(count) ? decided(vis.hidden) : undefined;
      out.push(...showing(base.convert([plain], next), vis, now));
    }
    return out;
  };
}

/** The blocks inside a query, converted with the loop it makes and the count it hands them. */
const convertInside = (
  ctx: ConvertCtx,
  counts: Counts,
  loop: Loop | undefined,
  blocks: WpBlock[],
): JxNode[] => counting(ctx, counts, withLoop(loop))(blocks);

const nestedLoop = (ctx: ConvertCtx): boolean =>
  /^\$map\b/.test(ctx.entryExpr) ||
  (ctx.termExpr !== undefined && /^\$map\b/.test(ctx.termExpr)) ||
  ctx.rowExpr !== undefined;

const query: BlockConverter = (block, ctx) => {
  const env = prepare(passingOwnCount(block), ctx);
  if (!env) return [];
  const { plan, info } = planQuery(block, ctx);
  for (const i of info) {
    say(ctx, block, i.code, i.severity ?? severityOf[i.code] ?? "info", i.message, {
      detail: i.detail,
    });
  }
  let loop: Loop = { kind: "none" };
  let counts: Counts = { shown: "0", total: () => "0" };

  if (plan.kind === "unsupported") {
    say(
      ctx,
      block,
      "block.unsupported",
      "warn",
      `The query lists ${plan.what}, and ${plan.why}: the list is left empty.`,
      {
        detail: plan.what,
        feature: `query-${plan.what}`,
      },
    );
  } else {
    if (nestedLoop(ctx)) {
      say(
        ctx,
        block,
        "loop.nested",
        "warn",
        "A query inside another loop: its list cannot depend on the enclosing item, and inside it `$map.item` names its own entry, not the enclosing one.",
        { detail: "nested-query" },
      );
    }
    for (const what of plan.dropped) {
      say(
        ctx,
        block,
        "query.approximated",
        "warn",
        `The query asks for ${what}, which a static site cannot say: that condition is left out, so the list can hold more than the live page's.`,
        { detail: what, condition: what },
      );
    }
    if (plan.kind === "posts") {
      const markdown = targetOf(ctx) === "markdown";
      const posts = evaluatePosts(ctx, plan, { all: plan.paginated });
      if (markdown && posts !== undefined) {
        loop = { kind: "static", posts };
        counts = {
          shown: String(posts.length),
          total: () =>
            String(evaluatePosts(ctx, { ...plan, offset: 0 }, { all: true })?.length ?? 0),
        };
        say(
          ctx,
          block,
          "query.static",
          "warn",
          `A Markdown entry cannot hold a live list: the query's ${posts.length} entries as of the migration are written out and will not follow new posts.`,
          { detail: "static", entries: posts.length },
        );
      } else if (markdown) {
        say(
          ctx,
          block,
          "block.unsupported",
          "warn",
          "The query depends on page state a Markdown entry does not have: its list is left empty.",
          { detail: "markdown-dynamic", feature: "query" },
        );
      } else {
        const id = str(block.attrs.queryId) ?? hashOf(plan);
        const source = registerPostList(ctx, plan, id);
        loop = {
          kind: "live",
          source,
          // A list of several types has no one type for its items: they carry their own (`postType`).
          ...(plan.types.length === 1 ? { entryType: plan.types[0]! } : {}),
        };
        const shown = lengthOf(source);
        // `found_posts` ignores the page size: a list that is cut has a second source, with no limit, only if a block asks.
        const cut = !plan.paginated && (plan.perPage !== undefined || plan.offset > 0);
        let all: string | undefined;
        counts = {
          shown,
          total: () =>
            !cut
              ? shown
              : (all ??= lengthOf(
                  registerPostList(
                    ctx,
                    { ...plan, perPage: undefined, offset: 0, paginated: false },
                    `${id}_all`,
                  ),
                )),
        };
      }
      if (posts !== undefined && posts.length === 0) {
        say(
          ctx,
          block,
          "query.empty",
          "info",
          "The query selects no entries on the converted site: its list is empty (and a page with an empty list ships a client script to render it).",
          { detail: "empty" },
        );
      }
      if (plan.paginated) {
        const total = evaluatePosts(ctx, plan, { all: true })?.length;
        say(
          ctx,
          block,
          "query.pagination",
          "warn",
          `Jx has no pagination: the query lists ${total === undefined ? "all its entries" : `all ${total} entries`}${plan.perPage === undefined ? "" : ` instead of ${plan.perPage} per page`}${ctx.hoist && plan.perPage !== undefined && loop.kind === "live" && pagedByClick(block) ? `, and hides all but the first ${plan.perPage} until its "Load more" control is used (a checkbox and a label, no script: one click shows them all)` : ""}.`,
          {
            detail: "pagination",
            perPage: plan.perPage ?? null,
            total: total ?? null,
            pages:
              total === undefined || plan.perPage === undefined
                ? null
                : Math.ceil(total / plan.perPage),
          },
        );
      }
    } else if (plan.kind === "users") {
      if (targetOf(ctx) === "markdown") {
        say(
          ctx,
          block,
          "block.unsupported",
          "warn",
          "A list of people has no static form in a Markdown entry: it is left empty.",
          { detail: "users-markdown", feature: "query-users" },
        );
      } else {
        const people = userList(ctx, plan, block);
        loop = { kind: "live", source: people.source, users: true };
        counts = { shown: lengthOf(people.source), total: () => lengthOf(people.source) };
        for (const note of people.notes)
          say(ctx, block, note.code, note.severity, note.message, { detail: note.detail });
      }
    } else if (targetOf(ctx) === "markdown") {
      say(
        ctx,
        block,
        "block.unsupported",
        "warn",
        "A list of terms has no static form in a Markdown entry: it is left empty.",
        {
          detail: "terms-markdown",
          feature: "query-terms",
        },
      );
    } else {
      const rows = termRows(ctx, plan);
      const key = defineState(
        ctx,
        `terms_${keyOf(plan.taxonomies.join("_"))}_q${keyOf(str(block.attrs.queryId) ?? hashOf(plan))}`,
        rows,
      );
      // Rows a component can list as they are: a mapped array is a `$ref`, which keeps the component
      // from being static, and a computed list is not expanded inside a component by the build.
      loop = {
        kind: "live",
        source: { pointer: `#/state/${key}` },
        terms: true,
        ...(inComponent(ctx) ? { rows } : {}),
      };
      const shown = `state.${key}.length`;
      counts = { shown, total: () => shown };
      if (rows.length === 0) {
        say(ctx, block, "query.empty", "info", "The query selects no terms: its list is empty.", {
          detail: "empty",
        });
      }
    }
  }

  const inside = convertInside(ctx, counts, loop, block.innerBlocks);
  const children =
    plan.kind === "posts" &&
    plan.paginated &&
    plan.perPage !== undefined &&
    loop.kind === "live" &&
    pagedByClick(block)
      ? withLoadMore(
          ctx,
          inside,
          `cc-more-${keyOf(`${ctx.subject.id}_${str(block.attrs.queryId) ?? hashOf(plan)}`)}`,
          plan.perPage,
        )
      : inside;
  return assemble(env, {
    tag: "div",
    children,
    // Cwicly's scripts read these two; nothing here does.
    attributes: { "data-cc_fr": undefined, "data-cc_il": undefined },
  }).nodes;
};

/**
 * Whether the way to the next page is a click, which a page that is only its first page shows (a "Load
 * more" button, previous and next links, page numbers). An infinite scroll is not one: it loads the
 * following pages by itself as soon as the end of the list is in view, and a visitor who scrolls sees
 * every entry, so the static list is left whole.
 */
export function pagedByClick(block: WpBlock): boolean {
  if (str(block.attrs.infiniteLoadMore) === "button") return true;
  const stack = [...block.innerBlocks];
  while (stack.length > 0) {
    const b = stack.pop()!;
    if (b.name === "cwicly/query-pagination" || b.name === "cwicly/query-pagination-numbers")
      return true;
    const action = str(b.attrs.linkWrapperAction);
    if (action === "prevQuery" || action === "nextQuery" || action === "infiniteButtonLoad")
      return true;
    stack.push(...b.innerBlocks);
  }
  return false;
}

/** What a "Load more" control says, the plugin's own wording or the author's. */
const LOAD_MORE = /^\s*load\s+more\s*$/i;

/** The first element below `nodes` that is a button or a link of that name. */
function loadMoreControl(nodes: readonly JxNode[]): JxElement | undefined {
  for (const element of walkElements(nodes)) {
    if (
      (element.tagName === "button" || element.tagName === "a") &&
      typeof element.textContent === "string" &&
      LOAD_MORE.test(element.textContent)
    ) {
      return element;
    }
  }
  return undefined;
}

/** The rule for a control the page did not have. */
const LOAD_MORE_STYLE = {
  display: "block",
  width: "fit-content",
  margin: "1.5rem auto",
  padding: "0.75rem 1.5rem",
  cursor: "pointer",
  textAlign: "center",
  borderWidth: "2px",
  borderStyle: "solid",
  borderRadius: "999px",
} as const;

/**
 * A query with a pagination device, shown as its first page and a way to the rest, with no script. The
 * plugin renders the first page in the browser and fetches the others one click at a time; a static
 * page has every entry already, so the entries past the page size are hidden until a hidden checkbox,
 * the query's first child, is checked, which the "Load more" control (a `label` for it: the button the
 * author drew, or one of ours where the page has none, as on an infinite scroll) does. One click
 * shows them all, where the plugin loads a page at a time. The rules are the project's own
 * (`ctx.hoist`); without one the query keeps listing everything.
 */
function withLoadMore(ctx: ConvertCtx, nodes: JxNode[], id: string, perPage: number): JxNode[] {
  if (!ctx.hoist) return nodes;
  const own = structuredClone(nodes);
  const control = loadMoreControl(own);
  const toggle: JxElement = {
    tagName: "input",
    attributes: { type: "checkbox", id, "aria-label": "Show more" },
    style: {
      position: "absolute",
      width: "1px",
      height: "1px",
      margin: "-1px",
      overflow: "hidden",
      opacity: 0,
      pointerEvents: "none",
    } as never,
  };
  let out = own;
  if (control === undefined) {
    out = [
      ...own,
      {
        tagName: "label",
        className: "cc-load-more",
        attributes: { for: id },
        textContent: "Load more",
      },
    ];
    ctx.hoist({ selector: ".cc-load-more", style: { ...LOAD_MORE_STYLE } as never });
  } else {
    control.tagName = "label";
    control.attributes = { ...control.attributes, for: id, role: "button" };
    delete control.attributes.href;
    delete control.attributes.type;
  }
  ctx.hoist({
    selector: `#${id}:not(:checked) ~ * > .cc-query-item:nth-child(n+${perPage + 1})`,
    style: { display: "none" },
  });
  ctx.hoist({
    selector: `#${id}:checked ~ * label[for="${id}"], #${id}:checked ~ label[for="${id}"]`,
    style: { display: "none" },
  });
  return [toggle, ...out];
}

// ── query-template and the pagination blocks ─────────────────────────────────────────────────────

const queryTemplate: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, () => {
    const loop = loopOf(ctx);
    const a = block.attrs;
    const itemClass = joinClass("cc-query-item", a.repeaterMasonry === true && "cc-masonry-item");
    if (a.repeaterSlider === true) {
      say(
        ctx,
        block,
        "query.slider",
        "info",
        "The query's items are a slider on the live page; the slider's script is not carried over, so they are an ordinary list.",
        { detail: "slider" },
      );
    }
    const item = (children: JxNode[]): JxElement => ({
      tagName: "div",
      className: itemClass,
      ...(children.length > 0 ? { children } : {}),
    });
    switch (loop?.kind) {
      case "live": {
        const inner = loop.terms === true ? block.innerBlocks.map(inTermLoop) : block.innerBlocks;
        const built = item(ctx.convert(inner, itemContext(loop)));
        sayHidden(ctx, block, loop.source, built);
        return {
          tag: "div",
          children:
            (loop.rows !== undefined && writtenOut(built, loop.rows)) ||
            loopChildren(loop.source, built),
          attributes: { "cc-query-template": "" },
        };
      }
      case "static":
        return {
          tag: "div",
          children: loop.posts.map((post) =>
            item(ctx.convert(block.innerBlocks, staticItemContext(post, ctx))),
          ),
          attributes: { "cc-query-template": "" },
        };
      case "none":
        return { tag: "div", attributes: { "cc-query-template": "" } };
      default:
        say(
          ctx,
          block,
          "block.unsupported",
          "warn",
          "A query template outside a query has nothing to repeat over: its blocks are written once.",
          { detail: "query-template-alone", feature: "query-template" },
        );
        return {
          tag: "div",
          children: ctx.convert(block.innerBlocks),
          attributes: { "cc-query-template": "" },
        };
    }
  });

/**
 * The blocks of an item of a loop over terms. The plugin names the address of the loop's term
 * `taxonomyqueryurl` in a terms query (a link's source, `{taxonomyqueryurl}` in the saved markup) and
 * `taxonomytermsurl` in a list of a post's terms; they are the same address, and the token and link
 * modules resolve the second (`$map.item.url`) and no value for the first.
 */
function inTermLoop(block: WpBlock): WpBlock {
  const fix = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      return key === "linkWrapperSourceDynamic" && v === "taxonomyqueryurl"
        ? "taxonomytermsurl"
        : v.replaceAll("{taxonomyqueryurl}", "{taxonomytermsurl}");
    }
    if (Array.isArray(v)) return v.map((x) => fix(x));
    const r = record(v);
    return r === undefined
      ? v
      : Object.fromEntries(Object.entries(r).map(([k, x]) => [k, fix(x, k)]));
  };
  return {
    ...block,
    attrs: fix(block.attrs) as Rec,
    innerHTML: fix(block.innerHTML) as string,
    innerContent: block.innerContent.map((c) => (typeof c === "string" ? (fix(c) as string) : c)),
    innerBlocks: block.innerBlocks.map(inTermLoop),
  };
}

/** Pagination is a script of the plugin's (and links that reload the query); Jx has none, and the query says what that costs. */
const pagination =
  (what: string): BlockConverter =>
  (block, ctx) => {
    const env = prepare(block, ctx);
    if (!env) return [];
    say(
      ctx,
      block,
      "query.pagination",
      "info",
      `The ${what} block is left out: Jx has no pagination, and the query shows its whole list instead.`,
      { detail: `${what} block` },
    );
    return [];
  };

// ── taxonomyterms and repeater ───────────────────────────────────────────────────────────────────

/** The `<div >` the plugin wraps each item of these loops in. */
const rowItem = (block: WpBlock, children: JxNode[]): JxElement => ({
  tagName: "div",
  ...(block.attrs.repeaterMasonry === true ? { className: "cc-masonry-item" } : {}),
  ...(children.length > 0 ? { children } : {}),
});

const sliderNote = (block: WpBlock, ctx: ConvertCtx): void => {
  if (block.attrs.repeaterSlider === true) {
    say(
      ctx,
      block,
      "query.slider",
      "info",
      "The block's items are a slider on the live page; the slider's script is not carried over, so they are an ordinary list.",
      { detail: "slider" },
    );
  }
};

/** A block that holds a loop and nothing to loop over: its own element, empty. */
function emptyShell(block: WpBlock, ctx: ConvertCtx, why: string, ready?: BlockEnv): JxNode[] {
  // A block no visitor sees reports nothing: it is not on the page.
  const env = ready ?? prepare(block, ctx);
  if (!env) return [];
  say(ctx, block, "block.unsupported", "warn", why, {
    detail: why,
    feature: baseName(block),
  });
  return assemble(env, { tag: "div" }).nodes;
}

/** An empty list as a loop's source: an expression the build evaluates, so the page stays static (an empty mapped array makes its parent a client render). */
const NOTHING: ListSource = { expr: "[]" };

/** A list of rows: a pointer into page state, or the rows themselves as a state entry of their own. */
function rowsPointer(ctx: ConvertCtx, name: string, rows: unknown): string {
  return `#/state/${defineState(ctx, name, rows)}`;
}

/** `get_object_taxonomies`: the taxonomies a post type has, the built-in ones of a `post` included. */
const taxonomiesOfType = (ctx: ConvertCtx, type: string): string[] => [
  ...new Set([
    ...taxonomiesFor(ctx.acf, type),
    ...(type === "post" ? ["category", "post_tag"] : []),
  ]),
];

const taxonomyterms: BlockConverter = (block, ctx) => {
  const a = block.attrs;
  // The block's own visibility first: a block no visitor sees registers no state and reports nothing.
  const env = prepare(block, ctx);
  if (!env) return [];
  if (targetOf(ctx) === "markdown") {
    return emptyShell(
      block,
      ctx,
      "A list of terms has no static form in a Markdown entry: it is left empty.",
      env,
    );
  }
  const source = text(a.taxtermsSource) ?? "";
  const pick = (v: unknown): { value: string; taxonomy: boolean }[] =>
    list(v)
      .map((x) => record(x))
      .filter((x): x is Rec => x !== undefined && str(x.value) !== undefined)
      .map((x) => ({ value: str(x.value)!, taxonomy: x.taxonomy === true }));
  const include = pick(a.taxtermsInclude);
  const exclude = pick(a.taxtermsExclude);
  const limit = Number(a.taxtermsNumber);
  const dropped: string[] = [];
  let found: ListSource | undefined;
  let empty = false;

  if (source === "current") {
    const cur = currentOf(ctx);
    const type = mainTypeOf(ctx) ?? "post";
    let taxonomies = taxonomiesOfType(ctx, type);
    const taxIn = include.filter((x) => x.taxonomy).map((x) => x.value);
    // A taxonomy or term that is both included and excluded stays: the plugin only excludes what it was not asked to include.
    const taxOut = exclude
      .filter((x) => x.taxonomy && !taxIn.includes(x.value))
      .map((x) => x.value);
    if (taxIn.length > 0) taxonomies = taxIn;
    taxonomies = taxonomies.filter((t) => !taxOut.includes(t));
    const termIn = include.filter((x) => !x.taxonomy).map((x) => Number(x.value));
    const termOut = exclude
      .filter((x) => !x.taxonomy && !termIn.includes(Number(x.value)))
      .map((x) => Number(x.value));
    const slugOf = (ids: number[]): string[] =>
      ids.map((id) => ctx.model.terms.get(id)?.slug).filter((s): s is string => s !== undefined);
    const filtered =
      termIn.length > 0 || termOut.length > 0 || a.taxtermsTopParents === true || limit > 0;
    if (a.taxtermsTopParents === true) dropped.push("only the top-level parents of the terms");
    const id = hashOf([taxonomies, termIn, termOut, limit]);
    if (cur.kind === "post") {
      let rows = taxonomies.flatMap(
        (t) => (cur.facts.terms as Record<string, TermRow[]> | undefined)?.[t] ?? [],
      );
      if (termIn.length > 0) rows = rows.filter((r) => slugOf(termIn).includes(r.slug));
      if (termOut.length > 0) rows = rows.filter((r) => !slugOf(termOut).includes(r.slug));
      if (limit > 0) rows = rows.slice(0, limit);
      empty = rows.length === 0;
      found = empty ? NOTHING : { pointer: rowsPointer(ctx, `terms_current_${id}`, rows) };
    } else if (cur.kind === "entry") {
      const direct = taxonomies.length === 1 && !filtered;
      const own = direct ? pointerOf(cur.expr, "data", "terms", taxonomies[0]!) : undefined;
      if (own !== undefined && !isStateExpr(cur.expr)) {
        // An item of another loop: the pointer is all a loop inside a loop can read.
        found = { pointer: own };
      } else if (isStateExpr(cur.expr) && !/^\$map\b/.test(cur.expr)) {
        // The entry's terms, as a list the build computes: an entry that carries none has no such array
        // (a pointer to it, like an empty mapped array, would make the page a client render).
        let chain = direct
          ? `${cur.expr}.data.terms?.[${j(taxonomies[0]!)}] ?? []`
          : `[${taxonomies.map((t) => `...(${cur.expr}.data.terms?.[${j(t)}] ?? [])`).join(", ")}]`;
        if (termIn.length > 0) chain += `.filter((t) => ${j(slugOf(termIn))}.includes(t.slug))`;
        if (termOut.length > 0) chain += `.filter((t) => !${j(slugOf(termOut))}.includes(t.slug))`;
        if (limit > 0) chain += `.slice(0, ${limit})`;
        found = { expr: chain };
      } else {
        // A loop item's terms, with a filter: the pointer is all the loop can say.
        const first =
          taxonomies.length > 0 ? pointerOf(cur.expr, "data", "terms", taxonomies[0]!) : undefined;
        if (first !== undefined) found = { pointer: first };
        if (filtered) dropped.push("the term filters and the limit, inside another loop");
        if (taxonomies.length > 1)
          dropped.push("every taxonomy but the first, inside another loop");
      }
    } else {
      return emptyShell(
        block,
        ctx,
        "The block lists the current entry's terms, and this conversion has no current entry.",
        env,
      );
    }
  } else if (source === "custom") {
    const taxIn = pick(a.taxtermsTaxonomies).map((x) => x.value);
    const types = pick(a.taxtermsPostType).map((x) => x.value);
    const taxonomies =
      taxIn.length > 0 ? taxIn : [...new Set(types.flatMap((t) => taxonomiesOfType(ctx, t)))];
    let terms = taxonomies.flatMap((t) => termsIn(ctx, t));
    const ids = (xs: { value: string }[]): number[] => xs.map((x) => Number(x.value));
    if (include.length > 0) terms = terms.filter((t) => ids(include).includes(t.termId));
    if (exclude.length > 0) terms = terms.filter((t) => !ids(exclude).includes(t.termId));
    // block.json: `taxtermsHideEmpty` is true by default (the plugin's `hide_empty`), so only an explicit false lists the empty ones.
    if (a.taxtermsHideEmpty !== false && a.taxtermsHideEmpty !== "false")
      terms = terms.filter((t) => t.count > 0);
    if (a.taxtermsExcludeChildren === true) terms = terms.filter((t) => t.parent === 0);
    terms = sortTerms(
      terms,
      text(a.taxtermsOrderBy) ?? "name",
      (text(a.taxtermsOrderDirection) ?? "ASC").toUpperCase() === "DESC" ? "desc" : "asc",
    );
    // The plugin cuts after it has left the archive's own term out, so the cut is made in the same order.
    const archive = archiveTerm(ctx);
    const cur = currentOf(ctx);
    const rows = terms.map((t) => termRow(ctx, t));
    const id = hashOf([taxonomies, ids(include), ids(exclude), limit]);
    const name = `terms_${keyOf(taxonomies.join("_"))}_${id}`;
    /** The terms are data, and the build keeps the ones the page's term or entry allows. */
    const filtered = (test: string): ListSource => {
      const rowsKey = defineState(ctx, `${name}_rows`, rows);
      return {
        expr: `state.${rowsKey}.filter((t) => ${test})${limit > 0 ? `.slice(0, ${limit})` : ""}`,
      };
    };
    if (a.taxtermsExcludeCurrent === true && archive !== undefined) {
      // On an archive the plugin leaves out the archive's own term.
      found = filtered(`t.slug !== ${archive.slug} || t.taxonomy !== ${archive.taxonomy}`);
    } else if (
      a.taxtermsExcludeCurrent === true &&
      cur.kind === "entry" &&
      isStateExpr(cur.expr) &&
      !/^\$map\b/.test(cur.expr)
    ) {
      // Anywhere else it leaves out the terms the current entry has.
      found = filtered(
        `!(${cur.expr}.data.terms?.[t.taxonomy] ?? []).some((x) => x.slug === t.slug)`,
      );
    } else if (a.taxtermsExcludeCurrent === true && cur.kind === "post") {
      const own = (cur.facts.terms as Record<string, TermRow[]> | undefined) ?? {};
      const kept = rows.filter((r) => !(own[r.taxonomy] ?? []).some((x) => x.slug === r.slug));
      const cut = limit > 0 ? kept.slice(0, limit) : kept;
      empty = cut.length === 0;
      found = empty ? NOTHING : { pointer: rowsPointer(ctx, name, cut) };
    } else {
      if (a.taxtermsExcludeCurrent === true)
        dropped.push("leaving out the current term, where this conversion has none");
      const cut = limit > 0 ? rows.slice(0, limit) : rows;
      empty = cut.length === 0;
      found = empty ? NOTHING : { pointer: rowsPointer(ctx, name, cut) };
    }
  } else {
    return emptyShell(
      block,
      ctx,
      `The block's term source ${j(source)} is not one this tool knows.`,
      env,
    );
  }
  for (const what of dropped) {
    say(
      ctx,
      block,
      "query.approximated",
      "warn",
      `The block asks for ${what}, which a loop inside another loop cannot say: it is left out.`,
      {
        detail: what,
        condition: what,
      },
    );
  }
  if (empty) {
    say(ctx, block, "query.empty", "info", "The block lists no terms here: its list is empty.", {
      detail: "empty",
    });
  }
  sliderNote(block, ctx);
  // A list with nothing in it is its element, empty: there is no item to write.
  if (found === undefined || found === NOTHING) return assemble(env, { tag: "div" }).nodes;
  const item = rowItem(
    block,
    ctx.convert(block.innerBlocks, withLoop(undefined, { termExpr: "$map.item" })),
  );
  sayHidden(ctx, block, found, item);
  return assemble(env, { tag: "div", children: loopChildren(found, item) }).nodes;
};

// ── repeater ─────────────────────────────────────────────────────────────────────────────────────

/** The text a `jsString` literal spells (`\\uXXXX`, `\\'` and `\\\\` undone). */
const unJs = (body: string): string =>
  body.replaceAll(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) =>
    c.length === 5 ? String.fromCharCode(Number.parseInt(c.slice(1), 16)) : c,
  );

/**
 * A JSON pointer for an expression that only reads properties (`state.entry.data.rows`,
 * `$map.item.data.terms?.tag`, `state.entry.data['field-name']`): optional chaining reads the same
 * path. Anything else is undefined.
 */
export function pointerOfExpr(expr: string): string | undefined {
  const base = /^(state(?:\.[A-Za-z_$][\w$]*)*|\$map\.item)/.exec(expr)?.[0];
  if (base === undefined) return undefined;
  const path: string[] = [];
  let rest = expr.slice(base.length);
  while (rest !== "") {
    const dot = /^\??\.([A-Za-z_$][\w$]*)/.exec(rest);
    const bracket = /^\??\.?\['((?:[^'\\]|\\.)*)'\]/.exec(rest);
    const hit = dot ?? bracket;
    if (hit === null) return undefined;
    path.push(dot ? hit[1]! : unJs(hit[1]!));
    rest = rest.slice(hit[0].length);
  }
  return pointerOf(base, ...path);
}

/** The rows of an ACF repeater as the pointer a loop reads them through, or why there is none. */
function repeaterRows(
  block: WpBlock,
  ctx: ConvertCtx,
): { source: ListSource } | { problem: string } {
  const a = block.attrs;
  // block.json: `dynamic` is `acf` by default, so an ACF repeater is saved without it.
  const dynamic = text(a.dynamic) ?? "acf";
  if (dynamic === "repeater") {
    const name = text(a.dynamicRepeaterField);
    if (name === undefined) return { problem: "the repeater names no field" };
    if (ctx.rowExpr === undefined) {
      return {
        problem: `the repeater reads the sub field ${name} of a row, and this conversion has no enclosing repeater row`,
      };
    }
    const pointer = pointerOf(ctx.rowExpr, name);
    return pointer === undefined
      ? { problem: "the enclosing row cannot be pointed at" }
      : { source: { pointer } };
  }
  if (dynamic !== "acf") {
    return {
      problem: dynamic.startsWith("woo")
        ? `the repeater lists shop data (${dynamic}), and the converted site has no shop`
        : `the repeater's source ${j(dynamic)} is not one this tool can list`,
    };
  }
  const key = text(a.dynamicACFField);
  const info = key === undefined ? undefined : fieldByKey(ctx.acf, key);
  if (info === undefined)
    return { problem: `no ACF field group defines the field ${key ?? "(none)"}` };
  if (info.field.type !== "repeater" && info.field.type !== "flexible_content") {
    return { problem: `the ACF field ${info.field.name} is a ${info.field.type}, not a repeater` };
  }
  const location = text(a.dynamicACFFieldLocation);
  const scope = parseLocation(location === "postid" ? text(a.dynamicACFFieldLocationID) : location);
  const found = acfRef(ctx, info, scope);
  if ("ref" in found) {
    const ref: Ref = found.ref;
    if (isExprRef(ref)) {
      // A field of the entry may hold no rows, and then the entry has no such key: the rows are read
      // where the build computes them. A pointer to it is left for the pointers of an enclosing loop's item.
      const pointer = isStateExpr(ref.expr) ? undefined : pointerOfExpr(ref.expr);
      return { source: pointer === undefined ? { expr: `${ref.expr} ?? []` } : { pointer } };
    }
    const rows = Array.isArray(ref.value) ? ref.value : [];
    if (rows.length === 0) return { source: NOTHING };
    return {
      source: { pointer: rowsPointer(ctx, `rows_${keyOf(info.field.name)}_${hashOf(rows)}`, rows) },
    };
  }
  // A repeater inside a repeater is a sub field of the row.
  const parent = info.path.at(-1);
  if (parent?.type === "repeater" && ctx.rowExpr !== undefined) {
    const pointer = pointerOf(ctx.rowExpr, info.field.name);
    if (pointer !== undefined) return { source: { pointer } };
  }
  return { problem: found.problem };
}

const repeater: BlockConverter = (block, ctx) => {
  // The block's own visibility first: a block no visitor sees registers no state and reports nothing.
  const env = prepare(block, ctx);
  if (!env) return [];
  if (targetOf(ctx) === "markdown") {
    return emptyShell(
      block,
      ctx,
      "A repeater has no static form in a Markdown entry: it is left empty.",
      env,
    );
  }
  const rows = repeaterRows(block, ctx);
  if ("problem" in rows)
    return emptyShell(block, ctx, `The repeater cannot be listed: ${rows.problem}.`, env);
  if (nestedLoop(ctx) && /^\$map\b/.test(ctx.entryExpr)) {
    say(
      ctx,
      block,
      "loop.nested",
      "warn",
      "A repeater inside a query: inside it `$map.item` is the row, so a binding that reads the enclosing entry reads the row instead.",
      { detail: "nested-repeater" },
    );
  }
  sliderNote(block, ctx);
  if (rows.source === NOTHING) return assemble(env, { tag: "div" }).nodes;
  const item = rowItem(
    block,
    ctx.convert(block.innerBlocks, withLoop(undefined, { rowExpr: "$map.item" })),
  );
  sayHidden(ctx, block, rows.source, item);
  return assemble(env, { tag: "div", children: loopChildren(rows.source, item) }).nodes;
};

// ── Components ───────────────────────────────────────────────────────────────────────────────────

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** One meta value of a component post, unserialised (`properties`, `variants`, `variantGroups`, `styleVariations`). */
const metaOf = (ctx: ConvertCtx, postId: number, key: string): unknown =>
  first(ctx.model.postMeta.get(postId)?.[key]);

const values = (v: unknown): Rec[] =>
  (Array.isArray(v) ? v : record(v) ? Object.values(record(v)!) : [])
    .map((x) => record(x))
    .filter((x): x is Rec => x !== undefined);

/**
 * The classes the plugin gives an instance (`componentVariantClasses`): the variant it names, or the
 * component's first one (a variant group's styles when it has one) when it names none, or one per
 * style variation. A component with no variants prints none, whatever the instance remembers.
 */
export function variantClasses(
  ctx: ConvertCtx,
  info: { postId: number },
  attrs: Rec,
): { classes: string[]; unknown: string[] } {
  const variants = values(metaOf(ctx, info.postId, "variants"));
  if (variants.length === 0) {
    const stale = text(attrs.variant);
    return { classes: [], unknown: stale === undefined ? [] : [stale] };
  }
  const groups = values(metaOf(ctx, info.postId, "variantGroups"));
  const styles = values(metaOf(ctx, info.postId, "styleVariations"));
  const known = new Set(variants.map((v) => str(v.id)));
  const classes: string[] = [];
  const unknown: string[] = [];
  const add = (value: string): void => {
    if (value.startsWith("group-")) {
      const group = groups.find((g) => str(g.id) === value.slice("group-".length));
      for (const s of list(group?.styles)) if (str(s) !== undefined) classes.push(`cs-${str(s)}`);
      return;
    }
    if (!known.has(value)) unknown.push(value);
    classes.push(`cs-${value}`);
  };
  if (styles.length > 0) {
    const chosen = record(attrs.variations);
    for (const item of styles) {
      const value = chosen === undefined ? undefined : str(chosen[str(item.id) ?? ""]);
      if (value !== undefined && value !== "") add(value);
    }
  } else if (text(attrs.variant) !== undefined) {
    add(text(attrs.variant)!);
  } else {
    const firstGroup = groups[0];
    const groupStyles = list(firstGroup?.styles)
      .map(str)
      .filter((s): s is string => s !== undefined);
    if (groupStyles.length > 0) for (const s of groupStyles) classes.push(`cs-${s}`);
    else if (str(variants[0]?.id) !== undefined) add(str(variants[0]!.id)!);
  }
  return { classes: [...new Set(classes)], unknown };
}

const TEXTURIZED = /[‘’“”′″]/;

/** `wptexturize` of a text that may hold bindings: each binding is held out of the way, a text that already has WordPress's quotes is left alone. */
function texturizeValue(value: string): string {
  if (TEXTURIZED.test(value)) return value;
  if (!value.includes("${")) return texturize(value);
  let out = "";
  let at = 0;
  for (;;) {
    const start = value.indexOf("${", at);
    if (start < 0) break;
    let level = 0;
    let end = value.length;
    for (let i = start + 1; i < value.length; i++) {
      if (value[i] === "{") level++;
      else if (value[i] === "}" && --level === 0) {
        end = i + 1;
        break;
      }
    }
    out += texturize(value.slice(at, start)) + value.slice(start, end);
    at = end;
  }
  return out + texturize(value.slice(at));
}

/** Move the addresses of a markup string to where the Jx site has them. */
const rewriteMarkup = (ctx: ConvertCtx, html: string): string =>
  html.replaceAll(
    /\b(href|src)=("([^"]*)"|'([^']*)')/g,
    (whole, attr: string, quoted: string, d?: string, s?: string) => {
      const value = d ?? s ?? "";
      const moved = rewriteAddress(ctx, value);
      return moved === value
        ? whole
        : `${attr}=${quoted.startsWith('"') ? '"' : "'"}${moved}${quoted.startsWith('"') ? '"' : "'"}`;
    },
  );

/** The text the plugin reads out of a property's value: the outer `maker`, else the value itself, else the editor's `content`. */
function makerOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const v = record(value);
  if (v === undefined) return undefined;
  if (typeof v.maker === "string") return v.maker;
  if (typeof v.content === "string") return v.content;
  const inner = record(v.content);
  return typeof inner?.content === "string" ? inner.content : undefined;
}

/** PHP's truthiness of a property's value: the plugin ignores one that is `""`, `"0"`, `0`, empty or absent. */
const phpTruthy = (v: unknown): boolean =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === "" ||
    v === "0" ||
    v === 0 ||
    (Array.isArray(v) && v.length === 0) ||
    (record(v) !== undefined && Object.keys(record(v)!).length === 0)
  );

const RICH = new Set(["richtext", "wysiwyg", "content", "html"]);
const OBJECT_PROPS = new Set(["link", "image"]);

/** The value an instance gives one property, as a `$props` entry; undefined when it gives none (the component's default applies). */
function propValue(
  ctx: ConvertCtx,
  block: WpBlock,
  info: { postId: number },
  def: { id: string; key: string; type: string },
  given: Rec,
): unknown {
  const raw = given.value;
  if (given.parent === true || given.parent === "true") {
    const parentId = str(raw);
    const key = parentId === undefined ? undefined : ctx.props?.get(parentId);
    if (key === undefined) {
      say(
        ctx,
        block,
        "component.parent-unresolved",
        "warn",
        `The property ${def.key} takes its value from the enclosing component's property ${parentId ?? "(none)"}, which this conversion does not have: the component's default is used.`,
        { detail: `${def.id}:${parentId ?? ""}` },
      );
      return undefined;
    }
    return OBJECT_PROPS.has(def.type) ? `\${state.${key} ?? {}}` : `\${state.${key} ?? ''}`;
  }
  if (!phpTruthy(raw)) return undefined;
  const v = record(raw);
  const type = def.type;
  if (type === "icon") {
    const icon = record(v?.icon);
    const unicode = str(icon?.unicode);
    return unicode ?? iconSvg(icon?.icon);
  }
  if (type === "image") {
    const image = record(v?.image);
    const id = Number(image?.imageID);
    const media = Number.isInteger(id) && id > 0 ? ctx.mediaFor(id) : undefined;
    if (media) {
      return {
        src: media.src,
        alt: media.alt,
        ...(media.width === undefined ? {} : { width: media.width }),
        ...(media.height === undefined ? {} : { height: media.height }),
      };
    }
    const maker = record(v?.maker);
    const src = str(maker?.src) ?? str(image?.imageURL);
    if (src === undefined) return undefined;
    const resolved = resolveTokens(src, ctx, block, { where: "attribute" });
    const byUrl = ctx.mediaForUrl(resolved);
    if (byUrl) {
      return {
        src: byUrl.src,
        alt: byUrl.alt ?? "",
        ...(byUrl.width === undefined ? {} : { width: byUrl.width }),
        ...(byUrl.height === undefined ? {} : { height: byUrl.height }),
      };
    }
    return { src: rewriteAddress(ctx, resolved) };
  }
  if (type === "link") {
    const maker = record(v?.maker);
    const href = str(maker?.href) ?? str(record(v?.link)?.linkWrapperUrl);
    if (href === undefined || href === "") return undefined;
    const target = str(maker?.target);
    const rel = str(maker?.rel);
    const title = str(maker?.title);
    return {
      href: rewriteAddress(ctx, resolveTokens(href, ctx, block, { where: "attribute" })),
      ...(target === undefined || target === "" || target === "_self" ? {} : { target }),
      ...(rel === undefined || rel === "" ? {} : { rel }),
      ...(title === undefined || title === "" ? {} : { title }),
    };
  }
  if (type === "options") {
    const options = values(
      record(metaOf(ctx, info.postId, "properties"))?.[def.id] &&
        record(record(metaOf(ctx, info.postId, "properties"))?.[def.id])?.options,
    );
    const id = makerOf(raw);
    const chosen = options.find((o) => str(o.id) === id);
    return chosen === undefined ? makerOf(raw) : (str(chosen.value) ?? undefined);
  }
  if (v !== undefined && (v.globalClass !== undefined || v.additionalClass !== undefined)) {
    const names = list(v.globalClass)
      .map((id) => (typeof id === "string" ? ctx.cwicly.globalClassNames.get(id) : undefined))
      .filter((n): n is string => n !== undefined);
    const own = list(v.additionalClass)
      .map((c) => str(record(c)?.value))
      .filter((c): c is string => c !== undefined);
    return [...own, ...names].join(" ");
  }
  const maker = makerOf(raw);
  if (maker === undefined) {
    say(
      ctx,
      block,
      "component.property-unsupported",
      "warn",
      `The property ${def.key} (${type || "no type"}) has a value this tool does not know how to read: the component's default is used.`,
      { detail: `${def.id}:${type}` },
    );
    return undefined;
  }
  if (RICH.has(type)) {
    return rewriteMarkup(ctx, resolveTokens(maker, ctx, block, { where: "html" }));
  }
  const resolved = texturizeValue(resolveTokens(maker, ctx, block, { where: "text" }));
  if (/<[a-z][^>]*>/i.test(resolved)) {
    say(
      ctx,
      block,
      "component.markup-in-text",
      "warn",
      `The text property ${def.key} holds markup (${j(resolved.slice(0, 60))}), which the live page prints as HTML and a plain text property shows as text: the component has to bind it as HTML, or the tags show.`,
      { detail: def.id, value: resolved.slice(0, 120) },
    );
  }
  return resolved;
}

/** `$props` of an instance: one entry per property the instance gives, by the component's state key. */
export function instanceProps(
  ctx: ConvertCtx,
  block: WpBlock,
  info: { postId: number; props: { id: string; key: string; type: string }[] },
): Record<string, unknown> {
  const given = record(block.attrs.properties) ?? {};
  const out: Record<string, unknown> = {};
  for (const def of info.props) {
    const own = record(given[def.id]);
    if (own === undefined) continue;
    const value = propValue(ctx, block, info, def, own);
    if (value !== undefined) out[def.key] = value;
  }
  for (const id of Object.keys(given)) {
    if (!info.props.some((p) => p.id === id)) {
      say(
        ctx,
        block,
        "component.unknown-property",
        "warn",
        `The instance gives the property ${id}, which its component no longer has: the value is dropped.`,
        { detail: id },
      );
    }
  }
  return out;
}

/** What takes the host out of the box tree, so the component's root is the flex or grid item it was. */
const HOST_STYLE = { display: "contents" } as const;

const component: BlockConverter = (block, ctx) => {
  const ref = text(block.attrs.ref);
  const info = ref === undefined ? undefined : ctx.components.get(ref);
  if (info === undefined) {
    // The plugin prints an empty string for a component it cannot find.
    say(
      ctx,
      block,
      "component.missing",
      "warn",
      `The instance names the component ${ref ?? "(none)"}, which the export does not have (or has unpublished): the plugin prints nothing for it, and so does the converted page.`,
      { detail: ref ?? "none" },
    );
    return [];
  }
  const env = prepare(block, ctx);
  if (!env) return [];
  const variants = variantClasses(ctx, info, block.attrs);
  for (const id of variants.unknown) {
    say(
      ctx,
      block,
      "component.variant-unknown",
      "info",
      `The instance names the variant ${id}, which ${info.tagName} does not define: ${variants.classes.length > 0 ? "the class is kept" : "no class is printed"}, as the plugin does.`,
      { detail: id },
    );
  }
  const props = instanceProps(ctx, block, info);
  const serialized = text(block.attrs.serializedInnerBlocks);
  const slot = serialized === undefined ? [] : ctx.convert(parseBlocks(serialized));
  // One rule for the tag, in the project's style, rather than one on every instance (the build writes an
  // element's own style once per element, so 290 instances would be 290 copies of it).
  if (ctx.hoist) ctx.hoist({ selector: info.tagName, style: { ...HOST_STYLE } });
  const built = assemble(env, {
    forceTag: info.tagName,
    classes: variants.classes,
    ...(ctx.hoist ? {} : { style: { ...HOST_STYLE } }),
    link: "none",
    ...(slot.length > 0 ? { children: slot } : {}),
  });
  if (Object.keys(props).length > 0)
    built.element.$props = props as NonNullable<JxElement["$props"]>;
  return built.nodes;
};

const innerblocks: BlockConverter = (block, ctx) => {
  if (ctx.mode !== "component") {
    say(
      ctx,
      block,
      "block.innerblocks-outside",
      "warn",
      "An innerblocks block is the slot of a component, and this conversion is not a component: it prints nothing.",
      { detail: "outside" },
    );
    return [];
  }
  return buildBlock(block, ctx, () => ({ tag: "div", children: [{ tagName: "slot" }] }));
};

// ── The table ────────────────────────────────────────────────────────────────────────────────────

export const dataConverters: Record<string, BlockConverter> = {
  "cwicly/query": query,
  "cwicly/query-template": queryTemplate,
  "cwicly/query-pagination": pagination("query pagination"),
  "cwicly/query-pagination-numbers": pagination("pagination numbers"),
  "cwicly/repeater": repeater,
  "cwicly/taxonomyterms": taxonomyterms,
  "cwicly/component": component,
  "cwicly/innerblocks": innerblocks,
};
