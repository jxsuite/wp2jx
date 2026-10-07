/**
 * Cwicly's visibility conditions: `hideConditions` (a list of `{condition, operator, data, …}` joined by
 * `hideConditionsType`), `hideLoggedIn`, `hideGuest`, and the switch that disables them all.
 *
 * ## What the plugin does (core/includes/dynamic/cc-conditions.php)
 *
 * Despite the name, **the block is rendered when the conditions are true**: every block's render
 * callback is `if ( $hide_guest && $hide_logged_in && cc_conditions_maker( … ) )`, and
 * `cc_conditions_maker` is true when every entry (`&&`, the default) or some entry (`||`) is true.
 * An entry with no `condition` or no `operator` is skipped. With `||` and no usable entry, the block is
 * never rendered. `hideConditionsToggle` switches the whole list off.
 *
 * `hideLoggedIn` hides the block from logged-in users and `hideGuest` from guests. A converted site
 * has visitors and no users, so every visitor is a guest: `hideLoggedIn` changes nothing and
 * `hideGuest` removes the block (both are reported as `condition.approximated`).
 *
 * ## What a static site keeps
 *
 * Each entry becomes one of three things:
 * - **decided**: the answer is the same for every visitor (a static page's own ACF value, the post
 *   type, the visitor being a guest). A block that is always hidden is `omit`ted; a condition that is
 *   always true is dropped from the list.
 * - **a binding**: the answer belongs to the entry (an ACF field empty or not, the title, the featured
 *   image, a term). The result is `hidden`, a binding for `attributes.hidden`, with `hiddenStyle`
 *   carrying the rule that makes the attribute win over the block's own `display` (docs/bindings.md,
 *   section 2).
 * - **dropped**: nothing static can say (date and time, cookies, a request's parameters, comments,
 *   WooCommerce, an arbitrary PHP function). The condition is treated as true, so the block stays
 *   visible, and reported as `condition.dropped`; `dropped` names each.
 *
 * A `device` condition becomes a hide at the breakpoints that cover the device (`deviceHide`) when the
 * cascade can express it, and is reported as `condition.approximated`.
 */
import type { ConvertCtx, JxStyle, WpBlock } from "../types.ts";
import {
  acfRef,
  currentRef,
  fieldByKey,
  fieldText,
  isExprRef,
  jsString,
  notEmptyExpr,
  optPath,
  parseLocation,
  phpEmpty,
  report,
  subjectPost,
  termRef,
  type Ref,
} from "./tokens.ts";
import { termsOf } from "../wp/model.ts";

export interface Visibility {
  /** A binding for `attributes.hidden`: `${!(…)}`. Absent when the block is always or never hidden. */
  hidden?: string;
  /** What to merge into the element's own `style` so the hidden attribute wins over its `display`. */
  hiddenStyle?: JxStyle;
  /** The block is never visible on the converted site: the converter returns no nodes. */
  omit?: boolean;
  /** Breakpoint keys (`md`, `sm`) at which the block is hidden. */
  deviceHide?: Record<string, true>;
  /** One line per condition that could not be carried over, as reported. */
  dropped: string[];
}

export interface VisibilityOptions {
  /**
   * The expression for the number of items of the query the block sits in (`state.projects.length`),
   * which lets `queryhasitems` and `querycount` become bindings. Without it they are dropped.
   */
  queryCount?: string;
}

/** The style that makes `hidden` win over a class rule that sets `display` (docs/bindings.md, section 2). */
export const HIDDEN_STYLE: JxStyle = { "&[hidden]": { display: "none !important" } };

// ── A small algebra of answers ───────────────────────────────────────────────────────────────────

/** True or false for every visitor, or an expression that says. */
type Answer = { c: boolean } | { e: string };

const yes: Answer = { c: true };
const no: Answer = { c: false };
const when = (b: boolean): Answer => (b ? yes : no);
const isConst = (a: Answer): a is { c: boolean } => "c" in a;

/** `!(x)` with its parentheses dropped again when `x` is itself `!(…)` all the way round. */
function negate(e: string): string {
  if (e.startsWith("!(") && e.endsWith(")")) {
    let depth = 0;
    for (let i = 1; i < e.length; i++) {
      if (e[i] === "(") depth++;
      else if (e[i] === ")" && --depth === 0)
        return i === e.length - 1 ? e.slice(2, -1) : `!(${e})`;
    }
  }
  return `!(${e})`;
}

const not = (a: Answer): Answer => (isConst(a) ? { c: !a.c } : { e: negate(a.e) });

/** Where a decision could not be made. */
const UNKNOWN = Symbol("unknown");
type Maybe = Answer | typeof UNKNOWN;

/** PHP's numeric strings: an optional sign, digits with a point or an exponent, spaces around. No hexadecimal, no `Infinity`. */
const NUMERIC = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;
const isNumeric = (s: string): boolean => NUMERIC.test(s);

/** PHP's comparison of two strings: numeric when both are numbers, else by characters. */
function phpCompare(a: string, b: string): number {
  if (isNumeric(a) && isNumeric(b)) return Math.sign(Number(a) - Number(b));
  return a === b ? 0 : a < b ? -1 : 1;
}

const stringOf = (e: string): string => `String((${e}) ?? '')`;

/**
 * The same comparison over an expression: when the value and `data` are both numeric strings they
 * compare as numbers (`'10' > '5'`), else by characters, as PHP does. `data` is known now, so a
 * `data` that is not a number needs no test at all.
 */
function comparison(e: string, op: "<" | ">" | "<=" | ">=" | "!==", data: string): string {
  const right = jsString(data);
  if (!isNumeric(data)) return `${e} ${op} ${right}`;
  return `((s) => /^\\s*[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?\\s*$/.test(s) ? Number(s) ${op} ${Number(data)} : s ${op} ${right})(${e})`;
}

/** A comparison of the value of an operand (a known string, or an expression) with the condition's `data`. */
function compare(op: string, operand: { lit: string } | { expr: string }, data: string): Maybe {
  const lit = "lit" in operand;
  const left = lit ? operand.lit : "";
  const right = jsString(data);
  const e = lit ? "" : stringOf((operand as { expr: string }).expr);
  switch (op) {
    case "===":
      return lit ? when(left === data) : { e: `${e} === ${right}` };
    case "!=":
      return lit ? when(phpCompare(left, data) !== 0) : { e: comparison(e, "!==", data) };
    case "contains":
      return lit ? when(left.includes(data)) : { e: `${e}.includes(${right})` };
    case "notcontain":
      return lit ? when(!left.includes(data)) : { e: `!${e}.includes(${right})` };
    case "before":
    case "<":
      return lit ? when(phpCompare(left, data) < 0) : { e: comparison(e, "<", data) };
    case "after":
    case ">":
      return lit ? when(phpCompare(left, data) > 0) : { e: comparison(e, ">", data) };
    case ">=":
      return lit ? when(phpCompare(left, data) >= 0) : { e: comparison(e, ">=", data) };
    case "<=":
      return lit ? when(phpCompare(left, data) <= 0) : { e: comparison(e, "<=", data) };
    default:
      return UNKNOWN;
  }
}

/** The answer for an operand that is itself a truth: `true`, `false` operators. */
function truth(op: string, a: Answer): Maybe {
  if (op === "true") return a;
  if (op === "false") return not(a);
  return UNKNOWN;
}

// ── Reading entries ──────────────────────────────────────────────────────────────────────────────

interface Entry {
  condition: string;
  operator: string;
  data: unknown;
  key?: string | undefined;
  acfField?: string | undefined;
  acfLocation?: string | undefined;
  acfLocationID?: unknown;
  acfRepeaterField?: string | undefined;
  function?: string | undefined;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined;

function entriesOf(block: WpBlock): Entry[] {
  const raw = block.attrs.hideConditions;
  if (!Array.isArray(raw)) return [];
  const out: Entry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    // The plugin skips an entry that names no condition or no operator.
    const condition = str(r.condition);
    const operator = str(r.operator);
    if (condition === undefined || operator === undefined) continue;
    out.push({
      condition,
      operator,
      data: r.data,
      key: str(r.key),
      acfField: str(r.acfField),
      acfLocation: str(r.acfLocation),
      acfLocationID: r.acfLocationID,
      acfRepeaterField: str(r.acfRepeaterField),
      function: str(r.function),
    });
  }
  return out;
}

/** `data` as text, or undefined when it is an object (a term) or a token. */
function dataText(entry: Entry): string | undefined {
  const d = entry.data;
  if (d === undefined || d === null) return "";
  if (typeof d === "string") return d;
  if (typeof d === "number") return String(d);
  return undefined;
}

// ── The conditions ───────────────────────────────────────────────────────────────────────────────

type Operand = { lit: string } | { expr: string } | { bool: Answer };

/** What a condition reads, as a string or an expression, or why it cannot be read here. */
function operandOf(entry: Entry, ctx: ConvertCtx): Operand | string {
  const post = subjectPost(ctx);
  switch (entry.condition) {
    case "authorname": {
      const r = currentRef(ctx, "author");
      return r ? refOperand(r) : "there is no current post";
    }
    case "posttitle": {
      const r = currentRef(ctx, "title");
      return r ? refOperand(r) : "there is no current post";
    }
    case "postid":
      return post ? { lit: String(post.id) } : "the post id is not in the entry data";
    case "postparentid":
      return post ? { lit: String(post.parent) } : "the parent post id is not in the entry data";
    case "posttype": {
      if (post) return { lit: post.type };
      if (ctx.entryType !== undefined) return { lit: ctx.entryType };
      // The items of a list of several types: each entry says what it is.
      const r = currentRef(ctx, "postType");
      return r ? refOperand(r) : "the post type of the entry is unknown";
    }
    case "postfeaturedimage": {
      const r = currentRef(ctx, "featuredImage");
      if (!r) return "there is no current post";
      return { bool: isExprRef(r) ? { e: `!!(${r.expr})` } : when(!!r.value) };
    }
    case "postexcerpt": {
      const r = currentRef(ctx, "excerpt");
      if (!r) return "there is no current post";
      if (!isExprRef(r)) return { bool: when(post !== undefined && post.excerpt.trim() !== "") };
      // `has_excerpt()` asks about the post's own excerpt, and the entry's `excerpt` is generated from the
      // content when the post has none: the entry says which it is in `hasExcerpt` (docs/bindings.md,
      // section 8.11), and an entry written without it is read as having an excerpt when it holds one.
      const own = currentRef(ctx, "hasExcerpt") as { expr: string };
      return { bool: { e: `(${own.expr} ?? !!(${r.expr}))` } };
    }
    case "postcontent": {
      if (post) return { bool: when(post.content.trim() !== "") };
      if (ctx.mode === "entry")
        return { bool: { e: `(${ctx.entryExpr}.$children?.length ?? 0) > 0` } };
      return "there is no current post";
    }
    case "username":
      return { lit: "" };
    case "userid":
      return { lit: "0" };
    default:
      return `the condition "${entry.condition}" has no value on a static site`;
  }
}

function refOperand(r: Ref): { lit: string } | { expr: string } {
  return isExprRef(r)
    ? { expr: r.expr }
    : { lit: r.value === undefined || r.value === null ? "" : String(r.value) };
}

/**
 * The slug the site's `get_current_slug()` returns: the last segment of the request's path. On a
 * taxonomy archive that is the term's slug; on an entry's page the last segment of the entry's own
 * address; on a page known now the last segment of its address (the front page's is empty).
 */
function currentSlug(ctx: ConvertCtx): { lit: string } | { expr: string } | undefined {
  if (ctx.termExpr !== undefined) {
    const term = termRef(ctx, "slug");
    return term === undefined ? undefined : refOperand(term);
  }
  if (ctx.mode === "entry") {
    const entry = currentRef(ctx, "slug");
    return entry === undefined ? undefined : refOperand(entry);
  }
  const post = subjectPost(ctx);
  if (post === undefined) return undefined;
  const url = ctx.urlFor("post", post.id);
  if (url === undefined) return undefined;
  return {
    lit:
      url
        .replace(/[?#].*$/, "")
        .replace(/\/+$/, "")
        .split("/")
        .pop() ?? "",
  };
}

/** `functionreturn`: the few WordPress functions whose answer is in the entry. */
function functionAnswer(entry: Entry, ctx: ConvertCtx): Maybe {
  const fn = (entry.function ?? "").replace(/\s+/g, "");
  if (fn === "get_current_slug()") {
    const data = dataText(entry);
    const slug = currentSlug(ctx);
    return data === undefined || slug === undefined ? UNKNOWN : compare(entry.operator, slug, data);
  }
  const terms = currentRef(ctx, "terms");
  let value: Answer | undefined;
  if (fn === "has_tags()" && terms) {
    value = isExprRef(terms)
      ? { e: `(${terms.expr}?.post_tag?.length ?? 0) > 0` }
      : when(((terms.value as Record<string, unknown[]> | undefined)?.post_tag ?? []).length > 0);
  } else if (fn === "has_post_thumbnail()") {
    const image = currentRef(ctx, "featuredImage");
    if (image) value = isExprRef(image) ? { e: `!!(${image.expr})` } : when(!!image.value);
  }
  if (value === undefined) return UNKNOWN;
  if (entry.operator === "true") return value;
  if (entry.operator === "false") return not(value);
  return UNKNOWN;
}

/**
 * `shortcode`: a site's own `[<taxonomy>_id]` shortcode (the first term of that taxonomy on the current
 * post, the snippet every Cwicly site that filters by "my category" writes) is empty exactly when the
 * entry has no term of that taxonomy. Any other shortcode is PHP the converter cannot read.
 */
function shortcodeAnswer(entry: Entry, ctx: ConvertCtx): Maybe {
  const name = dataText(entry);
  const taxonomy = name === undefined ? undefined : /^(.+)_id$/.exec(name)?.[1];
  if (taxonomy === undefined) return UNKNOWN;
  const known =
    ctx.acf.taxonomies.has(taxonomy) ||
    taxonomy === "category" ||
    taxonomy === "post_tag" ||
    [...ctx.model.terms.values()].some((t) => t.taxonomy === taxonomy);
  const terms = currentRef(ctx, "terms");
  if (!known || !terms) return UNKNOWN;
  const value: Answer = isExprRef(terms)
    ? { e: `(${optPath(terms.expr, taxonomy)} ?? []).length > 0` }
    : when(((terms.value as Record<string, unknown[]> | undefined)?.[taxonomy] ?? []).length > 0);
  return truth(entry.operator, value);
}

/** The ACF condition on a field: empty, not empty, true, false, or a comparison with `data`. */
function acfAnswer(entry: Entry, ctx: ConvertCtx): Maybe {
  if (entry.acfField === undefined) return UNKNOWN;
  const info = fieldByKey(ctx.acf, entry.acfField);
  if (!info) {
    report(
      ctx,
      "dynamic.unknown-field",
      "warn",
      `The ACF field "${entry.acfField}" of a condition is not defined by any field group.`,
      { token: entry.acfField, field: entry.acfField },
    );
    return UNKNOWN;
  }
  if (entry.acfRepeaterField !== undefined && entry.acfRepeaterField !== "cc_overall")
    return UNKNOWN;
  const location = entry.acfLocation;
  const id = str(entry.acfLocationID);
  const arg =
    location === "postid" && id !== undefined
      ? id
      : location === "termid" || location === "taxterm"
        ? "taxterm"
        : location === "option" ||
            location === "termquery" ||
            location === "userquery" ||
            location === "currentauthor" ||
            location === "currentuser"
          ? location
          : location === "taxonomyterm" && id !== undefined
            ? `term_${id}`
            : "";
  const got = acfRef(ctx, info, parseLocation(arg));
  if ("problem" in got) return UNKNOWN;
  const ref = got.ref;
  const f = info.field;
  const filled: Answer = !isExprRef(ref)
    ? when(!phpEmpty(ref.value))
    : f.type === "image" || f.type === "file"
      ? { e: `!!(${ref.expr}?.src)` }
      : f.type === "link"
        ? { e: `!!(${ref.expr}?.url)` }
        : f.multiple ||
            f.type === "gallery" ||
            f.type === "repeater" ||
            f.type === "flexible_content" ||
            f.type === "relationship"
          ? { e: `(${ref.expr}?.length ?? 0) > 0` }
          : { e: notEmptyExpr(ref.expr) };
  switch (entry.operator) {
    case "empty":
    case "false":
      return not(filled);
    case "notempty":
    case "true":
      return filled;
    default: {
      const data = dataText(entry);
      const text = fieldText(ctx, f, ref);
      if (data === undefined || text === undefined) return UNKNOWN;
      if ("lit" in text) return compare(entry.operator, { lit: text.lit }, data);
      return compare(entry.operator, { expr: text.expr }, data);
    }
  }
}

/** Term membership: `postterm`, `postcategory`, `posttag`. */
function termAnswer(entry: Entry, ctx: ConvertCtx): Maybe {
  const d = entry.data;
  let termId: number | undefined;
  if (entry.condition === "postterm") {
    termId =
      d !== null && typeof d === "object" ? Number((d as { value?: unknown }).value) : Number(d);
  } else if (entry.condition === "postcategory") {
    termId = Number(d);
  }
  const post = subjectPost(ctx);
  let member: Answer | undefined;
  if (entry.condition === "posttag" && typeof d === "string") {
    const wanted = d.toLowerCase();
    const terms = currentRef(ctx, "terms");
    if (!terms) return UNKNOWN;
    if (isExprRef(terms))
      member = {
        e: `(${terms.expr}?.post_tag ?? []).some(t => String(t.name).toLowerCase() === ${jsString(wanted)})`,
      };
    else
      member = when(
        ((terms.value as Record<string, { name: string }[]> | undefined)?.post_tag ?? []).some(
          (t) => t.name.toLowerCase() === wanted,
        ),
      );
  } else if (termId !== undefined && Number.isInteger(termId)) {
    const term = ctx.model.terms.get(termId);
    if (!term) return UNKNOWN;
    if (post) member = when(termsOf(ctx.model, post.id).some((t) => t.termId === term.termId));
    else {
      const terms = currentRef(ctx, "terms");
      if (!terms || !isExprRef(terms)) return UNKNOWN;
      member = {
        e: `(${optPath(terms.expr, term.taxonomy)} ?? []).some(t => t.slug === ${jsString(term.slug)})`,
      };
    }
  }
  if (member === undefined) return UNKNOWN;
  switch (entry.operator) {
    case "===":
      return member;
    case "!=":
      return not(member);
    default:
      return UNKNOWN;
  }
}

/** The answer of a user condition for the only visitor the converted site has: a guest. */
function guestAnswer(entry: Entry): Maybe {
  const data = dataText(entry);
  switch (entry.condition) {
    case "userrole": {
      // A guest has no roles.
      if (entry.operator === "===") return no;
      if (entry.operator === "!=") return yes;
      return UNKNOWN;
    }
    case "usercapabilities": {
      // `current_user_can` is false for a guest. `===` reads it, and every other operator compares the
      // boolean with `data` as PHP's loose `!=` does: a non-empty capability name is true.
      if (entry.operator === "===") return no;
      if (entry.operator === "!=")
        return data === "" || data === "0" || data === undefined ? no : yes;
      return UNKNOWN;
    }
    default:
      return UNKNOWN;
  }
}

/** One condition entry. */
function answerOf(entry: Entry, ctx: ConvertCtx, opts: VisibilityOptions): Maybe {
  switch (entry.condition) {
    case "acf":
      return acfAnswer(entry, ctx);
    case "postterm":
    case "postcategory":
    case "posttag":
      return termAnswer(entry, ctx);
    case "userrole":
    case "usercapabilities":
      return guestAnswer(entry);
    case "functionreturn":
      return functionAnswer(entry, ctx);
    case "shortcode":
      return shortcodeAnswer(entry, ctx);
    case "queryhasitems": {
      if (opts.queryCount === undefined) return UNKNOWN;
      const has: Answer = { e: `(${opts.queryCount}) > 0` };
      return truth(entry.operator, has);
    }
    case "querycount": {
      if (opts.queryCount === undefined) return UNKNOWN;
      const data = dataText(entry);
      return data === undefined
        ? UNKNOWN
        : compare(entry.operator, { expr: opts.queryCount }, data);
    }
    case "queryissinglepage": {
      if (opts.queryCount === undefined) return UNKNOWN;
      return truth(entry.operator, { e: `(${opts.queryCount}) === 1` });
    }
    case "device":
      return UNKNOWN;
    default: {
      if (
        /^(woo|date|dayweek|daymonth|time|cookie|urlparameter|shortcode|comment|queryhas|postcomments)/.test(
          entry.condition,
        )
      )
        return UNKNOWN;
      const operand = operandOf(entry, ctx);
      if (typeof operand === "string") return UNKNOWN;
      const data = dataText(entry);
      if (data === undefined) return UNKNOWN;
      if ("bool" in operand) {
        // These conditions are the strings 'true' and 'false'.
        const same = entry.operator === "===" || entry.operator === "!=";
        if (!same || (data !== "true" && data !== "false")) return UNKNOWN;
        const wanted = data === "true" ? operand.bool : not(operand.bool);
        return entry.operator === "===" ? wanted : not(wanted);
      }
      if (entry.operator === "true" || entry.operator === "false") return UNKNOWN;
      return compare(entry.operator, operand, data);
    }
  }
}

/** Why a condition is dropped, in words. */
function whyDropped(entry: Entry, ctx: ConvertCtx): string {
  if (entry.condition === "device") return "a device condition the breakpoints cannot express";
  if (/^(date|dayweek|daymonth|time)$/.test(entry.condition))
    return "it depends on the time of the request";
  if (entry.condition === "cookie") return "it depends on the visitor's cookies";
  if (entry.condition === "urlparameter") return "it depends on the request's parameters";
  if (entry.condition.startsWith("woo")) return "WooCommerce is not carried over";
  if (/^comment|^postcomments/.test(entry.condition)) return "comments are not carried over";
  if (entry.condition.startsWith("query"))
    return "it depends on a query, and the block is not given the query's count";
  if (entry.condition === "functionreturn")
    return `it calls the PHP function ${entry.function ?? ""}`;
  if (entry.condition === "shortcode") return "it runs a shortcode";
  if (entry.condition === "acf") return "its field cannot be read here";
  if (typeof operandOf(entry, ctx) === "string") return operandOf(entry, ctx) as string;
  return `the operator "${entry.operator}" has no static form`;
}

// ── Devices ──────────────────────────────────────────────────────────────────────────────────────

/** The breakpoint bands: a phone is the narrowest, a tablet the next, a desktop the base. */
function deviceBands(ctx: ConvertCtx): { phone?: string; tablet?: string } {
  const max = ctx.cwicly.breakpoints.filter((b) => b.direction === "max");
  // In cascade order the max-width breakpoints run from the widest to the narrowest.
  const tablet = max[0]?.key;
  const phone = max.length > 1 ? max[max.length - 1]?.key : undefined;
  return { ...(tablet === undefined ? {} : { tablet }), ...(phone === undefined ? {} : { phone }) };
}

/** The bands (`desktop`, `tablet`, `phone`) a device condition keeps visible. */
function visibleDevices(entry: Entry): Set<string> | undefined {
  const data = dataText(entry);
  const named: Record<string, string[]> = {
    // Mobile_Detect's `isMobile()` is true for tablets too.
    mobile: ["tablet", "phone"],
    tablet: ["tablet"],
    desktop: ["desktop"],
  };
  const group = data === undefined ? undefined : named[data];
  if (!group) return undefined;
  const all = ["desktop", "tablet", "phone"];
  if (entry.operator === "===") return new Set(group);
  if (entry.operator === "!=") return new Set(all.filter((d) => !group.includes(d)));
  return undefined;
}

// ── The visibility of a block ────────────────────────────────────────────────────────────────────

/**
 * Whether a block is shown, and how to say so: see the module comment. `hidden` is a binding for
 * `attributes.hidden`, `omit` means the block is never shown, `deviceHide` the breakpoints where it is
 * hidden, and `dropped` the conditions that had no static form.
 */
export function blockVisibility(
  block: WpBlock,
  ctx: ConvertCtx,
  opts: VisibilityOptions = {},
): Visibility {
  const out: Visibility = { dropped: [] };
  const a = block.attrs;
  if (a.hideConditionsToggle === true) return out;

  if (a.hideLoggedIn === true) {
    report(
      ctx,
      "condition.approximated",
      "info",
      "The block is hidden from logged-in users; every visitor of the converted site is logged out, so it is shown.",
      { token: "hideLoggedIn", detail: "hideLoggedIn" },
    );
  }
  if (a.hideGuest === true) {
    report(
      ctx,
      "condition.approximated",
      "info",
      "The block is hidden from guests; every visitor of the converted site is a guest, so it is removed.",
      { token: "hideGuest", detail: "hideGuest" },
    );
    out.omit = true;
    return out;
  }

  const type = str(a.hideConditionsType) ?? "&&";
  const entries = entriesOf(block);
  const answers: Answer[] = [];
  const devices: Set<string>[] = [];
  for (const entry of entries) {
    if (entry.condition === "device") {
      const kept = visibleDevices(entry);
      if (kept) {
        devices.push(kept);
        continue;
      }
    }
    const got = answerOf(entry, ctx, opts);
    if (got === UNKNOWN) {
      const why = whyDropped(entry, ctx);
      const label = `${entry.condition} ${entry.operator}${dataText(entry) ? ` ${dataText(entry)}` : ""}`;
      out.dropped.push(`${label}: ${why}`);
      report(
        ctx,
        entry.condition === "device" ? "condition.approximated" : "condition.dropped",
        entry.condition === "device" ? "info" : "warn",
        `The condition "${label}" has no static form (${why}); the block is shown.`,
        { token: label, condition: entry.condition, operator: entry.operator },
      );
      // An answer nothing can give counts as true: the block stays.
      answers.push(yes);
      continue;
    }
    if (entry.condition === "userrole" || entry.condition === "usercapabilities") {
      report(
        ctx,
        "condition.approximated",
        "info",
        `The condition "${entry.condition}" is decided for a guest, the only visitor the converted site has.`,
        { token: `guest:${entry.condition}`, condition: entry.condition },
      );
    }
    answers.push(got);
  }

  // Devices: a standalone device condition, or several `&&` ones.
  if (devices.length > 0) {
    if (type === "||" && (answers.length > 0 || devices.length > 1)) {
      out.dropped.push("device: a device condition combined with others by OR");
      // A condition nothing can decide counts as true, so the OR is true and the block stays.
      answers.push(yes);
      report(
        ctx,
        "condition.approximated",
        "info",
        "A device condition combined with others by OR cannot be expressed with breakpoints; the block is shown.",
        { token: "device-or", detail: "device-or" },
      );
    } else {
      const visible = devices.reduce(
        (acc, d) => new Set([...acc].filter((x) => d.has(x))),
        new Set(["desktop", "tablet", "phone"]),
      );
      const { tablet, phone } = deviceBands(ctx);
      const hideTablet = !visible.has("tablet");
      const hidePhone = !visible.has("phone");
      const hideDesktop = !visible.has("desktop");
      // Max-width breakpoints nest: what is hidden at the tablet's breakpoint is hidden on phones too.
      const expressible =
        !hideDesktop &&
        !(hideTablet && !hidePhone) &&
        (tablet !== undefined || (!hideTablet && !hidePhone));
      if (!expressible) {
        out.dropped.push(
          "device: the devices it keeps cannot be expressed with the site's breakpoints",
        );
        report(
          ctx,
          "condition.approximated",
          "info",
          "A device condition keeps a set of devices the site's breakpoints cannot express; the block is shown on all of them.",
          { token: "device", detail: "device" },
        );
      } else {
        if (hideTablet && hidePhone && tablet !== undefined) out.deviceHide = { [tablet]: true };
        else if (hidePhone && phone !== undefined) out.deviceHide = { [phone]: true };
        else if (hidePhone && tablet !== undefined) out.deviceHide = { [tablet]: true };
        if (out.deviceHide) {
          report(
            ctx,
            "condition.approximated",
            "info",
            "A device condition becomes a display:none at the matching breakpoints.",
            { token: "device", detail: "device" },
          );
        }
      }
    }
  }

  // Combine, as `cc_conditions_maker` does: `&&` is false when any answer is false (and true for none),
  // `||` is true when any answer is true (and false for none, which hides the block).
  const consts = answers.filter(isConst);
  const exprs = answers.filter((x): x is { e: string } => !isConst(x));
  let visible: Answer;
  if (type === "||") {
    if (consts.some((x) => x.c)) visible = yes;
    else if (exprs.length === 0) visible = devices.length > 0 && answers.length === 0 ? yes : no;
    else
      visible = {
        e:
          exprs.length === 1
            ? (exprs[0] as { e: string }).e
            : exprs.map((x) => `(${x.e})`).join(" || "),
      };
  } else if (consts.some((x) => !x.c)) {
    visible = no;
  } else if (exprs.length === 0) {
    visible = yes;
  } else {
    visible = {
      e:
        exprs.length === 1
          ? (exprs[0] as { e: string }).e
          : exprs.map((x) => `(${x.e})`).join(" && "),
    };
  }

  if (isConst(visible)) {
    if (!visible.c) out.omit = true;
    return out;
  }
  out.hidden = `\${${negate(visible.e)}}`;
  out.hiddenStyle = HIDDEN_STYLE;
  return out;
}
