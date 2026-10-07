/**
 * Cwicly's render-time tokens: `{title}`, `{acffield=…}`, `{pageobject=ID=type=kind}`, `<ccd>…</ccd>`.
 *
 * Cwicly saves markup with these in it and PHP resolves them per request (`cc_parser` and
 * `cc_get_dyn`, core/includes/dynamic/render.php). A converted site has no PHP, so each token becomes
 * one of three things, by what it means on the new site:
 *
 * - a **value**, when the answer is known at conversion time and is the same for every visitor: the
 *   site title, the URL of a fixed page, an attachment's file, and everything about the post when the
 *   subject is a static page (`ctx.mode === "static"`);
 * - a **binding** into the content entry, when the answer belongs to the entry the template renders
 *   (`ctx.mode === "entry"`): `${state.entry.data.title ?? ''}`, following the Entry data contract of
 *   docs/design.md. The same token inside a query loop is bound to `$map.item` through
 *   `ctx.entryExpr`;
 * - a **state read**, `${state.<prop>}`, for a component's own parameters (`{component=…}`).
 *
 * A token no static site can answer (a logged-in user, WooCommerce, comments, a filter, a pagination
 * link) is reported as `token.unresolved` and becomes an empty string. It is never left in the output
 * as `{…}`: PHP leaves only a token it does not know, and so does this module (CSS in a `code` block
 * or a `customCSS` is `{color:red}` to a regular expression, and must survive).
 *
 * ## The three families that are not resolved here
 *
 * - **Class tokens** (`{class}`, `{gcl}`, `{acl}`, `{sacl}`, `{aclv}`, `{gclv}`, `{cs-index}`,
 *   `{cccomp}`, `{currentpageclass}`, `{darkmode_force}`) belong to cwicly/style.ts and are returned
 *   exactly as written.
 * - **Bookkeeping** (`{idadd}`, `{loop-id}`, `{loop-index}`, `{loop-position}`, `{empty}`) is removed:
 *   it numbers loop iterations and builds ids the new site does not need.
 * - **Structure** the string cannot carry: `{menu}` and `{postcontent}` become the marker elements
 *   {@link MENU_TAG} and {@link POST_CONTENT_TAG}, which the menu and content converters replace.
 *   `{menuname}` is the real label.
 *
 * ## Where the result goes
 *
 * {@link resolveTokens} returns a string in its final form: `${…}` bindings with the literal parts
 * escaped for the place the string is written (`opts.where`, see docs/bindings.md section 8.4). Markup
 * that has tokens in it must not be handed to `htmlToNodes` first (its `${` escaping would destroy a
 * binding, and a token inside an attribute would be read as text): use {@link tokenContent} or
 * {@link tokenNodes}, which resolve, convert and finish in one call.
 *
 * Report codes: `token.unresolved`, `token.unknown`, `token.frozen-date`, `token.literal-template`,
 * `token.private-use`, `dynamic.unsupported`, `dynamic.unknown-field`, `dynamic.missing-image`,
 * `dynamic.unrouted-reference`, `link.unresolved`, `token.approximated`.
 */
import { decodeEntities, publicUrl, termsOf } from "../wp/model.ts";
import { userProfiles } from "../wp/profiles.ts";
import { acfValues, entryKey, postTarget, termTarget, toEntryData, zoneClock } from "../wp/acf.ts";
import type { AcfField, AcfGroup, AcfModel, EntryHooks, EntryImage, EntryRef } from "../wp/acf.ts";
import { php } from "../wp/seo.ts";
import {
  bindingMarker,
  finishBindings,
  finishNodes,
  htmlEscapeExpr,
  type BindingContext,
} from "../jx-util.ts";
import { htmlToContent, htmlToNodes, type HtmlContent, type HtmlOptions } from "../html.ts";
import { parseBlocks } from "../wp/blocks.ts";
import type { ConvertCtx, JxNode, WpBlock, WpPost, WpTerm } from "../types.ts";

// ── Public surface ───────────────────────────────────────────────────────────────────────────────

/** What `{menu}` becomes: an element the menu converter replaces. `data-menu` is the nav menu's term id. */
export const MENU_TAG = "wp2jx-menu";

/** What `{postcontent}` becomes: an element the content converter replaces with the entry body. */
export const POST_CONTENT_TAG = "wp2jx-post-content";

export interface TokenOptions {
  /**
   * Where the string is going, which decides how its literal parts are escaped and how a text binding
   * is written: `attribute` (default) and `text` are values the Jx emitter escapes itself; `html` is
   * markup (an `innerHTML`), where a text value is escaped and an HTML value is written as is.
   */
  where?: BindingContext;
  /**
   * Return the intermediate form instead: literal values escaped as markup and bindings as opaque
   * placeholders, for markup that goes on through `htmlToNodes`/`htmlToContent` and is finished with
   * `finishNodes`. {@link tokenContent} and {@link tokenNodes} do all three steps.
   */
  marked?: boolean;
}

/**
 * Resolve every Cwicly token in `text` for the conversion `ctx` describes. `block` supplies the
 * attributes some tokens read (`dynamicStaticFallback`, `dynamicWordPressAuthorInfo`, a menu's
 * `menuSelected`…) and the location of a report.
 */
export function resolveTokens(
  text: string,
  ctx: ConvertCtx,
  block?: WpBlock,
  opts: TokenOptions = {},
): string {
  const where = opts.where ?? "attribute";
  const markup = opts.marked === true || where === "html";
  // Markup is texturized the way WordPress prints it, tokens or not.
  if (!markup && !text.includes("{") && !text.includes("<ccd>")) return text;
  const marked = resolveMarked(text, ctx, block, markup);
  if (opts.marked) return marked;
  return finishBindings(marked, where, () => {
    report(
      ctx,
      "token.literal-template",
      "warn",
      "A literal ${ in text that must stay textContent or an attribute was split with a zero-width space.",
      { text: text.slice(0, 80) },
    );
  });
}

/** Resolve the tokens in a block's saved markup and convert it into the content of one element. */
export function tokenContent(
  html: string,
  ctx: ConvertCtx,
  block?: WpBlock,
  htmlOpts: HtmlOptions = {},
): HtmlContent {
  const marked = resolveMarked(html, ctx, block, true);
  return finishNodes(htmlToContent(marked, htmlOpts), () => literalTemplate(ctx));
}

/** Resolve the tokens in markup and convert it into nodes. */
export function tokenNodes(
  html: string,
  ctx: ConvertCtx,
  block?: WpBlock,
  htmlOpts: HtmlOptions = {},
): JxNode[] {
  const marked = resolveMarked(html, ctx, block, true);
  return finishNodes(htmlToNodes(marked, htmlOpts), () => literalTemplate(ctx));
}

/** Report a literal `${` that had to be split (docs/bindings.md, section 8.10). */
export function literalTemplate(ctx: ConvertCtx): void {
  report(
    ctx,
    "token.literal-template",
    "warn",
    "A literal ${ in text that must stay textContent or an attribute was split with a zero-width space.",
  );
}

// ── Reporting ────────────────────────────────────────────────────────────────────────────────────

type Severity = "info" | "warn" | "error";

/** The location a report entry carries: `post:5246`, `template:cwicly//header`, `component:0a275b695a`. */
export function locationOf(ctx: ConvertCtx): string {
  return `${ctx.subject.kind}:${ctx.subject.id}`;
}

const reported = new WeakMap<object, Set<string>>();

/**
 * Add one report entry, once per subject, code and detail: a template with 800 `{imagealt=…}` tokens
 * says so once per distinct token, not 800 times. `data.token` or `data.detail` is the detail.
 */
export function report(
  ctx: ConvertCtx,
  code: string,
  severity: Severity,
  message: string,
  data: Record<string, unknown> = {},
): void {
  let seen = reported.get(ctx.report);
  if (!seen) {
    seen = new Set();
    reported.set(ctx.report, seen);
  }
  const where = locationOf(ctx);
  const key = `${where}|${code}|${String(data.token ?? data.detail ?? message)}`;
  if (seen.has(key)) return;
  seen.add(key);
  const url = ctx.subject.post ? publicUrl(ctx.model.site, ctx.subject.post) : undefined;
  ctx.report.add({
    severity,
    code,
    message,
    where,
    ...(url ? { url } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  });
}

// ── Values ───────────────────────────────────────────────────────────────────────────────────────

/**
 * What a token (or a dynamic attribute) says, before it is written anywhere. A literal is known at
 * conversion time: `lit` is plain text, or markup when `html` is set. An expression is a JavaScript
 * expression over the entry or component state, whose result is text, or markup when `html` is set.
 */
export type Val = { lit: string; html?: boolean } | { expr: string; html?: boolean };

export const litV = (text: string, html = false): Val => ({ lit: text, html });
export const exprV = (expr: string, html = false): Val => ({ expr, html });

/**
 * A binding's placeholder (docs/bindings.md, section 8.5) is bracketed by two private-use characters. A
 * literal that carried them could spell a placeholder of its own, and the finishing step would turn it
 * into a binding that runs, so no literal keeps them.
 */
const PLACEHOLDER_BRACKETS = /[\uE000\uE001]/g;
const HAS_BRACKET = /[\uE000\uE001]/;
const stripMarks = (text: string): string => text.replaceAll(PLACEHOLDER_BRACKETS, "");

function reportBrackets(ctx: ConvertCtx): void {
  report(
    ctx,
    "token.private-use",
    "warn",
    "Text held the private-use characters that bracket a binding's placeholder; they were removed.",
  );
}

/** A value as the final-form string for a place that is not markup: bindings real, literal parts escaped, a literal `${` reported. */
export function finalForm(
  ctx: ConvertCtx,
  v: Val,
  where: "text" | "attribute" = "attribute",
): string {
  return finishBindings(emitVal(v, false), where, () => literalTemplate(ctx));
}

/**
 * A literal as the final-form string for an attribute or a text, which is what every returned string of
 * `dynamic.ts`, `links.ts` and `conditions.ts` is: a `${` in it is split with a zero-width space (and
 * reported, once per subject) and the characters that bracket a placeholder are removed, so the build
 * can never evaluate it.
 */
export function literalFinal(
  ctx: ConvertCtx,
  value: string,
  where: "text" | "attribute" = "attribute",
): string {
  return finishBindings(stripMarks(value), where, () => literalTemplate(ctx));
}

/** A markup string as the text a person reads: tags gone, character references decoded. */
export function plainOf(markup: string): string {
  return decodeEntities(php.stripAllTags(markup.replaceAll(/<br\s*\/?>/gi, " "), true));
}

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The expression that reduces markup to its text: what an HTML binding needs where only text can go. */
export const stripTagsExpr = (expr: string): string =>
  `String((${expr}) ?? '').replace(/<[^>]*>/g, '')`;

/**
 * A JavaScript string literal for text that goes inside a `${…}`. The build reads a template
 * brace by brace without knowing about strings, so a `{`, a `}`, a `$` or a backtick in a literal are
 * written as escapes: nothing in the literal can then unbalance or open a template.
 */
export function jsString(text: string): string {
  let out = "'";
  for (const ch of text) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "'") out += "\\'";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (/[${}`\u2028\u2029]/.test(ch))
      out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}'`;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** `base.key`, or `base['key']` for a name that is not an identifier, written so that no brace or dollar of it is left bare. */
export const propPath = (base: string, key: string): string =>
  IDENT.test(key) ? `${base}.${key}` : `${base}[${jsString(key)}]`;

/** The same with optional chaining: `base?.key`. */
export const optPath = (base: string, key: string): string =>
  IDENT.test(key) ? `${base}?.${key}` : `${base}?.[${jsString(key)}]`;

/**
 * A value as the string the resolver passes along. `markup` says the surrounding text is HTML, where a
 * text value must be escaped and a binding is a placeholder; otherwise the value is for a plain
 * string, where an HTML value is reduced to its text. `inTag` says the markup is a tag's, where the
 * value is an attribute's and its double quotes are escaped too.
 */
export function emitVal(v: Val, markup: boolean, inTag = false): string {
  if ("lit" in v) {
    const lit = stripMarks(v.lit);
    // Inside a tag the value is an attribute's, and a double quote in it would end the attribute.
    if (markup)
      return v.html ? lit : inTag ? escapeHtml(lit).replaceAll('"', "&quot;") : escapeHtml(lit);
    return v.html ? plainOf(lit) : lit;
  }
  if (markup) return bindingMarker(v.expr, v.html ? "html" : "text");
  return bindingMarker(v.html ? stripTagsExpr(v.expr) : v.expr, "text");
}

/**
 * `a || b` over values: the first when it is not empty. A literal that is empty gives way at conversion
 * time. When either is markup the result is markup, and a text on the other side is escaped to match.
 */
export function orElse(primary: Val | undefined, fallback: Val | undefined): Val | undefined {
  if (!primary) return fallback;
  if (!fallback) return primary;
  if ("lit" in primary) {
    if (primary.lit !== "") return primary;
    return fallback;
  }
  const html = primary.html === true || fallback.html === true;
  const first = html && primary.html !== true ? htmlEscapeExpr(primary.expr) : primary.expr;
  const second =
    "lit" in fallback
      ? jsString(html && fallback.html !== true ? escapeHtml(fallback.lit) : fallback.lit)
      : html && fallback.html !== true
        ? htmlEscapeExpr(fallback.expr)
        : fallback.expr;
  return { expr: `(${first}) || ${second}`, html };
}

// ── Text the way WordPress writes it ─────────────────────────────────────────────────────────────

/** `wp_spaces_regexp()`: the characters `wptexturize` counts as space, `&nbsp;` as the entity it still is in markup. */
const SPACES = "[\\r\\n\\t ]|\\u00a0|&nbsp;";

const APOS = "&#8217;";
const OPEN_DQ = "&#8220;";
const CLOSE_DQ = "&#8221;";
const OPEN_SQ = "&#8216;";
const OQ_FLAG = "<!--oq-->";
const OSQ_FLAG = "<!--osq-->";
const APOS_FLAG = "<!--apos-->";
const PRIME_FLAG = "<!--wp-prime-or-quote-->";

/** The words whose apostrophe is a letter dropped, not a quotation mark opening: a plain `str_replace` in WordPress. */
const COCKNEY = [
  "'tain't",
  "'twere",
  "'twas",
  "'tis",
  "'twill",
  "'til",
  "'bout",
  "'nuff",
  "'round",
  "'cause",
  "'em",
];

/** What may follow a closing quote: the end, punctuation, `&gt;` or a space. */
const AFTER_CLOSE = `$|[.,:;!?)}\\-\\]]|&gt;|${SPACES}`;

const APOS_RULES: [RegExp, string][] = [
  // '99' and '99" are ambiguous among other patterns; assume it's an abbreviated year at the end of a quotation.
  [new RegExp(`'(\\d\\d)'(?=${AFTER_CLOSE})`, "g"), `${APOS_FLAG}$1${APOS}`],
  [new RegExp(`'(\\d\\d)"(?=${AFTER_CLOSE})`, "g"), `${APOS_FLAG}$1${CLOSE_DQ}`],
  // '99 '99s '99's (apostrophe). But never '9 or '99% or '999 or '99.0.
  [/'(?=\d\d(?:$|(?![%\d]|[.,]\d)))/g, APOS_FLAG],
  // Quoted numbers like '0.42'.
  [new RegExp(`(?<=^|${SPACES})'(\\d[.,\\d]*)'`, "g"), `${OSQ_FLAG}$1${APOS}`],
  // A single quote at the start, or preceded by (, {, <, [, ", - or a space, opens.
  [new RegExp(`(?<=^|[([{"\\-]|&lt;|${SPACES})'`, "g"), OSQ_FLAG],
  // An apostrophe in a word: no space before, and no space, double apostrophe or punctuation after.
  [new RegExp(`(?<!${SPACES})'(?!$|[.,:;!?"'(){}[\\]\\-]|&[lg]t;|${SPACES})`, "g"), APOS_FLAG],
];

const QUOTE_RULES: [RegExp, string][] = [
  // Quoted numbers like "42".
  [new RegExp(`(?<=^|${SPACES})"(\\d[.,\\d]*)"`, "g"), `${OQ_FLAG}$1${CLOSE_DQ}`],
  // A double quote at the start, or preceded by (, {, <, [, - or a space, and not followed by a space, opens.
  [new RegExp(`(?<=^|[([{\\-]|&lt;|${SPACES})"(?!${SPACES})`, "g"), OQ_FLAG],
];

const DASH_RULES: [RegExp, string][] = [
  [/---/g, "&#8212;"],
  [new RegExp(`(?<=^|${SPACES})--(?=$|${SPACES})`, "g"), "&#8212;"],
  [/(?<!xn)--/g, "&#8211;"],
  [new RegExp(`(?<=^|${SPACES})-(?=$|${SPACES})`, "g"), "&#8211;"],
];

const countOf = (text: string, part: string): number => text.split(part).length - 1;

/**
 * `wptexturize_primes()`: whether `7'` or `7"` is a measurement or the end of a quotation. The closing
 * quote is counted as the entity it is in WordPress, so a quotation that already closes is seen.
 */
function primes(
  haystack: string,
  needle: "'" | '"',
  prime: string,
  openQuote: string,
  closeQuote: string,
): string {
  const quote = new RegExp(`${needle}(?=${AFTER_CLOSE})`, "g");
  const primeAfterDigit = new RegExp(`(?<=\\d)${needle}`, "g");
  const flagAfterDigit = new RegExp(`(?<=\\d)${PRIME_FLAG}`, "g");
  const flagNoDigit = new RegExp(`(?<!\\d)${PRIME_FLAG}`, "g");
  const sentences = haystack.split(openQuote);
  for (let key = 0; key < sentences.length; key++) {
    let sentence = sentences[key] as string;
    if (!sentence.includes(needle)) continue;
    if (key !== 0 && countOf(sentence, closeQuote) === 0) {
      let count = 0;
      sentence = sentence.replace(quote, () => {
        count++;
        return PRIME_FLAG;
      });
      if (count > 1) {
        // This sentence appears to have multiple closing quotes: every candidate that does not follow a digit closes it.
        let closed = 0;
        sentence = sentence.replace(flagNoDigit, () => {
          closed++;
          return closeQuote;
        });
        if (closed === 0) {
          // Try a quote followed by a period, the rightmost; else the rightmost candidate.
          const at = sentence.includes(`${PRIME_FLAG}.`)
            ? sentence.lastIndexOf(`${PRIME_FLAG}.`)
            : sentence.lastIndexOf(PRIME_FLAG);
          sentence = sentence.slice(0, at) + closeQuote + sentence.slice(at + PRIME_FLAG.length);
        }
        sentence = sentence
          .replace(primeAfterDigit, prime)
          .replace(flagAfterDigit, prime)
          .replaceAll(PRIME_FLAG, closeQuote);
      } else if (count === 1) {
        // Only one closing quote candidate, so it has priority over primes.
        sentence = sentence.replaceAll(PRIME_FLAG, closeQuote).replace(primeAfterDigit, prime);
      } else {
        sentence = sentence.replace(primeAfterDigit, prime);
      }
    } else {
      sentence = sentence.replace(primeAfterDigit, prime).replace(quote, closeQuote);
    }
    if (needle === '"' && sentence.includes('"')) sentence = sentence.replaceAll('"', closeQuote);
    sentences[key] = sentence;
  }
  return sentences.join(openQuote);
}

/** The character references `wptexturize` writes, as the characters they are. */
const WRITTEN: Readonly<Record<string, string>> = {
  "&#8217;": "’",
  "&#8216;": "‘",
  "&#8220;": "“",
  "&#8221;": "”",
  "&#8242;": "′",
  "&#8243;": "″",
  "&#8211;": "–",
  "&#8212;": "—",
  "&#8230;": "…",
  "&#8482;": "™",
  "&#215;": "×",
};

const NEEDS_TEXTURIZE = /['"`\-.x]|\(tm\)/;

/**
 * `wptexturize()` of one run of text (the part between tags), written rule for rule from
 * wp-includes/formatting.php, in its order: the static replacements, then the apostrophes, the quotes
 * with `wptexturize_primes`, the dashes and the multiplication sign. WordPress turns `Women's` into
 * `Women’s` and ` - ` into ` – ` in every title and block it prints, and the live pages show that, so
 * text written into a static page has to be turned the same way. The rules work on the markup as
 * WordPress has it: `&nbsp;` still counts as a space, `&lt;` and `&gt;` as the characters they stand
 * for, and a quotation counts the closing quotes (as entities) that are already there. What it writes
 * is returned as characters; character references that were already in the text stay as they were.
 */
export function texturize(text: string): string {
  if (!NEEDS_TEXTURIZE.test(text)) return text;
  let t = text.replaceAll("...", "&#8230;").replaceAll("``", OPEN_DQ).replaceAll("''", CLOSE_DQ);
  t = t.replaceAll(" (tm)", " &#8482;");
  for (const word of COCKNEY) t = t.replaceAll(word, `${APOS}${word.slice(1)}`);
  if (t.includes("'")) {
    for (const [re, to] of APOS_RULES) t = t.replace(re, to);
    t = primes(t, "'", "&#8242;", OSQ_FLAG, APOS);
    t = t.replaceAll(APOS_FLAG, APOS).replaceAll(OSQ_FLAG, OPEN_SQ);
  }
  if (t.includes('"')) {
    for (const [re, to] of QUOTE_RULES) t = t.replace(re, to);
    t = primes(t, '"', "&#8243;", OQ_FLAG, CLOSE_DQ);
    t = t.replaceAll(OQ_FLAG, OPEN_DQ);
  }
  if (t.includes("-")) for (const [re, to] of DASH_RULES) t = t.replace(re, to);
  // 9x9 (times), but never 0x9999.
  if (/(?<=\d)x\d/.test(t))
    t = t.replace(/\b((?:0[\d.,]+|[1-9][\d.,]*))x(\d[\d.,]*)\b/g, "$1&#215;$2");
  return t.replaceAll(/&#(?:8217|8216|8220|8221|8242|8243|8211|8212|8230|8482|215);/g, (m) => {
    return WRITTEN[m] as string;
  });
}

/** The elements `wptexturize` leaves alone: code and anything else whose text is not prose. */
const NO_TEXTURIZE = new Set(["pre", "code", "kbd", "style", "script", "tt"]);

/** A binding's placeholder (docs/bindings.md, section 8.5), which is not text and must come through untouched. */
const BINDING_PLACEHOLDER = /[th][A-Za-z0-9_-]*/g;
const MASK = "";

/** PHP's `trim()` of nothing: the character set differs from JavaScript's, which also strips a no-break space. */
// oxlint-disable-next-line no-control-regex -- PHP's trim() set is exactly these control characters.
const BLANK = /^[ \t\n\r\0\x0B]*$/;

/**
 * `_wptexturize_pushpop_element()`: an opening tag of a disabled element pushes it, and a closing tag pops
 * it only when it is the innermost one. The name is what lies between the angle bracket and the first
 * space, so a tag with its attributes after a newline is not recognised (as in WordPress).
 */
function pushPop(tag: string, stack: string[]): void {
  let opening: boolean;
  let offset: number;
  if (tag.length > 1 && tag[1] !== "/") {
    opening = true;
    offset = 1;
  } else if (stack.length === 0) {
    return;
  } else {
    opening = false;
    offset = 2;
  }
  const space = tag.indexOf(" ");
  const name = space < 0 ? tag.slice(offset, tag.length - 1) : tag.slice(offset, space);
  if (!NO_TEXTURIZE.has(name)) return;
  if (opening) stack.push(name);
  else if (stack[stack.length - 1] === name) stack.pop();
}

/**
 * {@link texturize} over the text of a piece of markup, as WordPress does it: an element (everything
 * from a `<` to the next `>`, or to the end when it never closes) and a comment are not text, and
 * nothing inside `pre`, `code`, `kbd`, `style`, `script` or `tt` is. The live pages of both sites print
 * their blocks' static text this way (`Don’t`, `9:00 AM – 5:00 PM`, `…`), in template parts as much as
 * in posts, so a block's text is made the same before it is written. Binding placeholders count as a
 * word and are not touched.
 */
export function texturizeHtml(html: string): string {
  if (!NEEDS_TEXTURIZE.test(html)) return html;
  const holders: string[] = [];
  const src = html.replaceAll(BINDING_PLACEHOLDER, (m) => {
    holders.push(m);
    return MASK;
  });
  const stack: string[] = [];
  let out = "";
  let at = 0;
  while (at < src.length) {
    const lt = src.indexOf("<", at);
    const run = src.slice(at, lt < 0 ? src.length : lt);
    out += stack.length > 0 || BLANK.test(run) ? run : texturize(run);
    if (lt < 0) break;
    let end: number;
    if (src.startsWith("<!--", lt)) {
      const close = src.indexOf("-->", lt + 2);
      end = close < 0 ? src.length : close + 3;
    } else {
      const gt = src.indexOf(">", lt + 1);
      end = gt < 0 ? src.length : gt + 1;
    }
    const part = src.slice(lt, end);
    if (!part.startsWith("<!--")) pushPop(part, stack);
    out += part;
    at = end;
  }
  let next = 0;
  return holders.length === 0 ? out : out.replaceAll(MASK, () => holders[next++] ?? MASK);
}

/**
 * `human_time_diff()` as WordPress 5.3 and later prints it: `30 seconds`, `5 minutes`, `2 days`,
 * `1 year`. The difference is cut to whole seconds, a month is thirty days and a year 365, and every
 * unit but the seconds rounds to the nearest whole one.
 */
export function humanTimeDiff(fromMs: number, toMs: number): string {
  const diff = Math.trunc(Math.abs(toMs - fromMs) / 1000);
  const unit = (n: number, one: string): string => {
    const count = Math.max(1, n);
    return `${count} ${one}${count === 1 ? "" : "s"}`;
  };
  if (diff < 60) return unit(diff, "second");
  if (diff < 3600) return unit(Math.round(diff / 60), "minute");
  if (diff < 86400) return unit(Math.round(diff / 3600), "hour");
  if (diff < 604800) return unit(Math.round(diff / 86400), "day");
  if (diff < 2592000) return unit(Math.round(diff / 604800), "week");
  if (diff < 31536000) return unit(Math.round(diff / 2592000), "month");
  return unit(Math.round(diff / 31536000), "year");
}

// ── The site's clock and PHP date formats ────────────────────────────────────────────────────────

/**
 * The site's time zone as a name `Intl` and `php.date` accept: `timezone_string`, else `gmt_offset` as a
 * fixed offset (`+05:30`), else UTC. A name the runtime does not know is UTC.
 */
export function siteZone(ctx: ConvertCtx): string {
  const stated = (ctx.model.options.get("timezone_string") ?? "").trim();
  if (stated !== "") {
    try {
      zoneClock(stated);
      return stated;
    } catch {
      // An unknown name falls through to the offset, as WordPress does.
    }
  }
  const offset = Number((ctx.model.options.get("gmt_offset") ?? "").trim());
  if (!Number.isFinite(offset) || offset === 0) return "UTC";
  const minutes = Math.round(Math.abs(offset) * 60);
  return `${offset < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The date formats Cwicly's `postdate`/`currentdate` tokens name by number. */
const DATE_FORMATS: Readonly<Record<string, string>> = {
  default: "F j, Y",
  "1": "F j, Y",
  "2": "Y-m-d",
  "3": "m/d/Y",
  "4": "d/m/Y",
  "6": "d.m.y",
  "7": "d.m.Y",
};
const TIME_FORMATS: Readonly<Record<string, string>> = {
  default: "g:i a",
  "1": "g:i a",
  "2": "g:i A",
  "3": "H:i",
};

/** A UTC instant as PHP's `date($format)` writes it in the site's zone. */
export function formatDate(ctx: ConvertCtx, format: string, utcMs: number): string {
  try {
    return php.date(format, utcMs, siteZone(ctx));
  } catch {
    return php.date(format, utcMs, "UTC");
  }
}

const MONTHS =
  "['January','February','March','April','May','June','July','August','September','October','November','December']";

/** The English locales whose short zone names are the ones tzdata uses (the static path's `T` reads the same list). */
const ABBREVIATION_LOCALES = "['en-US','en-GB','en-AU','en-NZ','en-IN','en-ZA','en-CA','en-IE']";

/** Expands `c` and `r`, which PHP defines as formats of their own, and keeps every other character, escapes included. */
function expandFormat(format: string): string {
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const c = format[i] as string;
    if (c === "\\") out += c + (format[++i] ?? "");
    else if (c === "c") out += "Y-m-d\\TH:i:sP";
    else if (c === "r") out += "D, d M Y H:i:s O";
    else out += c;
  }
  return out;
}

/**
 * A JavaScript expression that formats the instant `dateExpr` (an RFC 3339 string or a date) the way
 * PHP's `date($format)` would in the site's zone (or in `zoneName`, for a value that holds a day and
 * not an instant): every format character PHP has, `d D j l N S w z W F m M n t L o Y y a A B g G h H
 * i s u v e I O P p T Z c r U`. A letter that is not a format character is printed as it is, as PHP does.
 */
export function dateExpr(
  ctx: ConvertCtx,
  format: string,
  dateExpr: string,
  zoneName?: string,
): { expr: string } {
  const zone = zoneName ?? siteZone(ctx);
  const fixed = zone.startsWith("+") || zone.startsWith("-");
  const parts: string[] = [];
  const lit = (s: string): void => {
    if (s !== "") parts.push(jsString(s));
  };
  const pad = (e: string, n = 2): string => `String(${e}).padStart(${n}, '0')`;
  const full = expandFormat(format);
  /** Minutes the zone's wall clock is ahead of UTC at the instant. */
  const off =
    "Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(p.ms / 1000) * 1000) / 60000)";
  const offsetText = (colon: boolean): string =>
    `((o) => (o < 0 ? '-' : '+') + ${pad("Math.floor(Math.abs(o) / 60)")} + ${colon ? "':' + " : ""}${pad("Math.abs(o) % 60")})(${off})`;
  const day = "Date.UTC(p.year, p.month - 1, p.day)";
  // The ISO-8601 week-numbering year and week: those of the Thursday of this week.
  const iso = `((u, w) => ((t, y) => [y, Math.floor((t - Date.UTC(y, 0, 1)) / 604800000) + 1])(u + (4 - w) * 86400000, new Date(u + (4 - w) * 86400000).getUTCFullYear()))(${day}, new Date(${day}).getUTCDay() || 7)`;
  const offsetAt = `(t) => ((q) => Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - Math.floor(t / 1000) * 1000)(Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: ${jsString(zone)}, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'}).formatToParts(t).map(r => [r.type, +r.value])))`;
  const numeric = `((o) => (o < 0 ? '-' : '+') + ${pad("Math.floor(Math.abs(o) / 60)")} + (Math.abs(o) % 60 === 0 ? '' : ${pad("Math.abs(o) % 60")}))(${off})`;
  const abbreviation =
    zone === "UTC"
      ? "'UTC'"
      : fixed
        ? jsString(`GMT${zone.replace(":", "")}`)
        : `(() => { for (const l of ${ABBREVIATION_LOCALES}) { const n = new Intl.DateTimeFormat(l, {timeZone: ${jsString(zone)}, timeZoneName: 'short'}).formatToParts(p.ms).find(q => q.type === 'timeZoneName'); if (n && /^[A-Z]{2,5}$/.test(n.value)) return n.value; } return ${numeric}; })()`;
  let literal = "";
  for (let i = 0; i < full.length; i++) {
    const c = full[i] as string;
    if (c === "\\") {
      literal += full[++i] ?? "";
      continue;
    }
    let piece: string | undefined;
    switch (c) {
      case "d":
        piece = pad("p.day");
        break;
      case "j":
        piece = "p.day";
        break;
      case "D":
        piece = "p.weekday.slice(0, 3)";
        break;
      case "l":
        piece = "p.weekday";
        break;
      case "N":
        piece =
          "(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].indexOf(p.weekday) + 1)";
        break;
      case "w":
        piece =
          "(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].indexOf(p.weekday))";
        break;
      case "S":
        piece =
          "(p.day % 10 === 1 && p.day !== 11 ? 'st' : p.day % 10 === 2 && p.day !== 12 ? 'nd' : p.day % 10 === 3 && p.day !== 13 ? 'rd' : 'th')";
        break;
      case "z":
        piece = `Math.round((${day} - Date.UTC(p.year, 0, 1)) / 86400000)`;
        break;
      case "W":
        piece = pad(`${iso}[1]`);
        break;
      case "F":
        piece = `${MONTHS}[p.month - 1]`;
        break;
      case "M":
        piece = `${MONTHS}[p.month - 1].slice(0, 3)`;
        break;
      case "m":
        piece = pad("p.month");
        break;
      case "n":
        piece = "p.month";
        break;
      case "t":
        piece = "new Date(Date.UTC(p.year, p.month, 0)).getUTCDate()";
        break;
      case "L":
        piece = "((p.year % 4 === 0 && p.year % 100 !== 0) || p.year % 400 === 0 ? 1 : 0)";
        break;
      case "o":
        piece = `${iso}[0]`;
        break;
      case "Y":
        piece = pad("p.year", 4);
        break;
      case "x":
        piece = `(p.year < 0 ? '-' + ${pad("-p.year", 4)} : p.year > 9999 ? '+' + p.year : ${pad("p.year", 4)})`;
        break;
      case "X":
        piece = `(p.year < 0 ? '-' : '+') + ${pad("Math.abs(p.year)", 4)}`;
        break;
      case "y":
        piece = pad("p.year % 100");
        break;
      case "a":
        piece = "(p.hour < 12 ? 'am' : 'pm')";
        break;
      case "A":
        piece = "(p.hour < 12 ? 'AM' : 'PM')";
        break;
      case "B":
        piece = pad(
          "Math.floor(((((p.ms + 3600000) % 86400000) + 86400000) % 86400000) / 86400)",
          3,
        );
        break;
      case "g":
        piece = "(p.hour % 12 || 12)";
        break;
      case "G":
        piece = "p.hour";
        break;
      case "h":
        piece = pad("(p.hour % 12 || 12)");
        break;
      case "H":
        piece = pad("p.hour");
        break;
      case "i":
        piece = pad("p.minute");
        break;
      case "s":
        piece = pad("p.second");
        break;
      case "u":
        piece = `${pad("((p.ms % 1000) + 1000) % 1000", 3)} + '000'`;
        break;
      case "v":
        piece = pad("((p.ms % 1000) + 1000) % 1000", 3);
        break;
      case "e":
        piece = jsString(zone);
        break;
      case "I":
        piece = `((at) => { const j = at(Date.UTC(p.year, 0, 1)), l = at(Date.UTC(p.year, 6, 1)), n = at(p.ms); return j === l ? 0 : (${zone === "Europe/Dublin" ? "n === Math.min(j, l)" : "n === Math.max(j, l)"}) ? 1 : 0; })(${offsetAt})`;
        break;
      case "O":
        piece = offsetText(false);
        break;
      case "P":
        piece = offsetText(true);
        break;
      case "p":
        piece = zone === "UTC" || /^[+-]00:?00$/.test(zone) ? "'Z'" : offsetText(true);
        break;
      case "T":
        piece = abbreviation;
        break;
      case "Z":
        piece = `(${off}) * 60`;
        break;
      case "U":
        piece = "Math.floor(p.ms / 1000)";
        break;
      default:
        literal += c;
        continue;
    }
    lit(literal);
    literal = "";
    parts.push(piece);
  }
  lit(literal);
  // Only the parts the format reads are asked of Intl.
  const used = new Set<string>();
  for (let i = 0; i < full.length; i++) {
    const c = full[i] as string;
    if (c === "\\") i++;
    else used.add(c);
  }
  const has = (chars: string): boolean => [...chars].some((c) => used.has(c));
  // What reads the offset, the week or the instant needs the whole wall clock.
  const wall = has("WoBuvIOPpTZUz");
  const fields = [
    wall || has("YyLtxXzW") || has("mnFM") ? "year:'numeric'" : "",
    wall || has("mnFMt") ? "month:'numeric'" : "",
    wall || has("djSdtz") ? "day:'numeric'" : "",
    has("DlNw") ? "weekday:'long'" : "",
    wall || has("aAgGhH") ? "hour:'numeric',hourCycle:'h23'" : "",
    wall || has("i") ? "minute:'numeric'" : "",
    wall || has("s") ? "second:'numeric'" : "",
  ].filter((f) => f !== "");
  const instant = wall ? ", {ms: d.getTime()}" : "";
  const partsExpr = `Object.assign(Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:${jsString(zone)},${fields.join(",")}}).formatToParts(d).map(q => [q.type, q.type === 'weekday' ? q.value : +q.value]))${instant})`;
  const body = parts.length === 0 ? "''" : parts.join(" + ");
  return { expr: `((d) => ((p) => '' + ${body})(${partsExpr}))(new Date(${dateExpr}))` };
}

/** The format a Cwicly date or time token names: a number, `default`, or a PHP format (`custom`). */
export function cwiclyFormat(kind: "date" | "time", code: string, custom: string): string {
  if (code === "custom") return custom;
  return (kind === "date" ? DATE_FORMATS : TIME_FORMATS)[code] ?? "";
}

// ── What the entry holds: the Entry data contract for one post or term ──────────────────────────

/** An entry's frontmatter as docs/design.md names its keys. */
export type EntryData = Record<string, unknown>;

const dataCaches = new WeakMap<
  object,
  WeakMap<object, WeakMap<object, WeakMap<object, Map<string, EntryData>>>>
>();

/** What the data of a post depends on is the media, the routes, the model and the ACF definitions: a context that differs in any of them has its own. */
function cacheFor(ctx: ConvertCtx): Map<string, EntryData> {
  const step = <T extends object>(map: WeakMap<object, T>, key: object, make: () => T): T => {
    let next = map.get(key);
    if (!next) {
      next = make();
      map.set(key, next);
    }
    return next;
  };
  return step(
    step(
      step(
        step(dataCaches, ctx.mediaFor, () => new WeakMap()),
        ctx.urlFor,
        () => new WeakMap(),
      ),
      ctx.model,
      () => new WeakMap(),
    ),
    ctx.acf,
    () => new Map(),
  );
}

/** ACF's own findings about a value belong to the module that writes the entry, not to every page that reads it. */
const DISCARD = { add: () => undefined, entries: () => [] } as const;

/** The ACF fields of a person's profile in the shapes of the entry data contract, none for a person with no profile. */
/** A person as an entry holds a reference to one: `{id, slug, title, url}` and the profile's own fields. */
export function userRef(ctx: ConvertCtx, id: number): EntryRef | undefined {
  return hooksFor(ctx).user(id);
}

export function userFields(
  ctx: ConvertCtx,
  id: number,
  hasProfile: boolean,
): Record<string, unknown> {
  if (!hasProfile) return {};
  const key = `user-fields:${id}`;
  const cache = cacheFor(ctx);
  const hit = cache.get(key);
  if (hit) return hit;
  // A person's field that refers to a person is read as a bare reference: no profile inside a profile.
  const bare: EntryHooks = {
    ...hooksFor(ctx),
    user: (other) => {
      const user = ctx.model.users.get(other) ?? userProfiles(ctx.model).get(other);
      return user
        ? {
            id: other,
            slug: user.slug,
            title: user.displayName,
            url: ctx.urlForAuthor?.(other) ?? "",
          }
        : undefined;
    },
  };
  // ACF reads a wysiwyg value through `acf_the_content`, `wpautop` among its filters: the site prints
  // the paragraphs, not the stored text (a biography pasted from a word processor has none stored).
  const values = acfValues(ctx.model, ctx.acf, { kind: "user", userId: id }, { report: DISCARD });
  for (const raw of Object.values(values)) {
    if (raw.type === "wysiwyg" && typeof raw.value === "string") raw.value = php.wpautop(raw.value);
  }
  const data = toEntryData(values, bare) as EntryData;
  cache.set(key, data);
  return data;
}

function hooksFor(ctx: ConvertCtx): EntryHooks {
  /** An object the field holds that exists but has no page of its own (a podcast, a form entry) is still there: the field is filled. */
  const unrouted = (kind: "post" | "term", id: number): void => {
    report(
      ctx,
      "dynamic.unrouted-reference",
      "info",
      `The ${kind} ${id} that a field holds has no page on the converted site: the field counts as filled and its address is empty.`,
      { detail: `${kind}:${id}`, id },
    );
  };
  return {
    attachment(id): EntryImage | undefined {
      const media = ctx.mediaFor(id);
      if (!media) return undefined;
      return {
        src: media.src,
        ...(media.width === undefined ? {} : { width: media.width }),
        ...(media.height === undefined ? {} : { height: media.height }),
        alt: media.alt,
      };
    },
    post(id): EntryRef | undefined {
      const post = ctx.model.posts.get(id);
      if (!post) return undefined;
      const url = ctx.urlFor("post", id);
      if (url === undefined) unrouted("post", id);
      return { id, slug: post.slug, title: decodeEntities(post.title), url: url ?? "" };
    },
    term(id): EntryRef | undefined {
      const term = ctx.model.terms.get(id);
      if (!term) return undefined;
      const url = ctx.urlFor("term", id);
      if (url === undefined) unrouted("term", id);
      return { id, slug: term.slug, title: decodeEntities(term.name), url: url ?? "" };
    },
    user(id): EntryRef | undefined {
      const profile = userProfiles(ctx.model).get(id);
      const user = ctx.model.users.get(id) ?? profile;
      if (!user) return undefined;
      // A person the site has a page for (an author) links there; a guest or a host who never posted has none.
      const url = ctx.urlForAuthor?.(id) ?? "";
      // What the site prints about the person (the ACF fields of the user form) travels with the reference, so
      // a template that lists hosts and guests reads their photograph, position and biography from the entry.
      return {
        ...userFields(ctx, id, profile !== undefined),
        id,
        slug: user.slug,
        title: user.displayName,
        url,
      };
    },
    missing(kind, id, field) {
      report(
        ctx,
        kind === "attachment" ? "dynamic.missing-image" : "dynamic.unsupported",
        "warn",
        kind === "attachment"
          ? `The attachment ${id} that the field "${field}" holds has no file in the media plan.`
          : `The ${kind} ${id} that the field "${field}" holds is not on the converted site.`,
        { detail: `${kind}:${id}:${field}`, field, id },
      );
    },
  };
}

/** The blocks whose own content is an excerpt's text, and the blocks that may wrap them (`Helpers::excerpt_gutenberg`). */
const EXCERPT_TEXT_BLOCKS = new Set([
  "cwicly/heading",
  "cwicly/paragraph",
  "cwicly/list",
  "core/paragraph",
  "core/heading",
]);
const EXCERPT_WRAPPERS = new Set([
  "cwicly/div",
  "cwicly/section",
  "cwicly/column",
  "cwicly/columns",
]);

/** What `render_block` prints for a block, as far as its saved markup says: tokens cannot be resolved here and are left out. */
function renderedMarkup(b: WpBlock): string {
  const children = [...b.innerBlocks];
  const body = b.innerContent
    .map((piece) => (piece === null ? renderedMarkup(children.shift() as WpBlock) : piece))
    .join("");
  return body.replaceAll(/\{[^{}]*\}/g, "");
}

function excerptInner(parent: WpBlock, allowed: ReadonlySet<string>): string {
  let out = "";
  for (const inner of parent.innerBlocks) {
    if (inner.name === null || !allowed.has(inner.name)) continue;
    if (inner.innerBlocks.length === 0) {
      const a = inner.attrs;
      const own = a.dynamic === "wordpress" && a.dynamicWordPressType === "postexcerpt";
      if (own || (typeof a.content === "string" && a.content.includes("post_excerpt"))) continue;
      out += `${renderedMarkup(inner)} `;
    } else {
      out += excerptInner(inner, EXCERPT_WRAPPERS);
    }
  }
  return out;
}

/**
 * The excerpt a post prints, as Cwicly's `{postexcerpt}` computes it (`Helpers::excerpt_gutenberg`): the
 * post's own excerpt when it has one, else the markup of the post's text blocks (headings, paragraphs
 * and lists, inside Cwicly's layout blocks), all of it, with no word limit of its own. Blocks that print
 * the excerpt themselves are left out. The markup still holds its character references and tags:
 * the token strips the tags and cuts to the limit.
 */
export function excerptOf(post: WpPost): string {
  if (post.excerpt.trim() !== "") return post.excerpt;
  if (post.content.trim() === "") return "";
  let out = "";
  for (const b of parseBlocks(post.content)) {
    if (b.innerBlocks.length > 0) {
      if (b.name !== null && EXCERPT_WRAPPERS.has(b.name)) {
        out += excerptInner(b, EXCERPT_TEXT_BLOCKS);
        continue;
      }
      // A block with anything but plain text blocks inside, or with nesting, is skipped whole.
      if (
        b.innerBlocks.some(
          (i) => i.name === null || !EXCERPT_TEXT_BLOCKS.has(i.name) || i.innerBlocks.length > 0,
        )
      )
        continue;
    }
    const a = b.attrs;
    if (a.dynamic === "wordpress" && a.dynamicWordPressType === "postexcerpt") continue;
    if (typeof a.content === "string" && a.content.includes("post_excerpt")) continue;
    out += renderedMarkup(b);
  }
  return out;
}

/** Terms in the order WordPress lists them: `get_the_terms` asks for `orderby=name`, which is the database's case-insensitive collation of the stored name. A tie keeps the stored order. */
const termOrder = new Intl.Collator("en", { sensitivity: "base" });
const byName = (terms: readonly WpTerm[]): WpTerm[] =>
  [...terms].sort((a, b) => termOrder.compare(a.name, b.name));

/**
 * The facts of a post as a static page reads them: the post's own fields, its featured image, its terms
 * (in WordPress's order, by name) and its ACF values in the shapes of the Entry data contract, with the
 * text as it is stored. A static conversion prints these through WordPress's text filters itself; use
 * {@link postData} for what an entry holds.
 */
export function postFacts(ctx: ConvertCtx, post: WpPost): EntryData {
  const cache = cacheFor(ctx);
  const key = `facts:${post.id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { model } = ctx;
  const hooks = hooksFor(ctx);
  const data: EntryData = {
    title: decodeEntities(post.title),
    slug: post.slug,
    date: post.date,
    modified: post.modified,
    excerpt: excerptOf(post),
    // `excerpt` is generated from the content when the post has none of its own; a condition on the excerpt asks about the post's own.
    hasExcerpt: post.excerpt.trim() !== "",
  };
  const author = model.users.get(post.authorId);
  if (author) data.author = author.displayName;
  const url = ctx.urlFor("post", post.id);
  if (url !== undefined) data.url = url;
  const thumbnail = Number(model.postMeta.get(post.id)?._thumbnail_id?.[0]);
  if (Number.isInteger(thumbnail) && thumbnail > 0) {
    const image = hooks.attachment(thumbnail);
    if (image) data.featuredImage = image;
    else hooks.missing?.("attachment", thumbnail, "featuredImage");
  }
  const terms: Record<string, { slug: string; name: string; url: string }[]> = {};
  for (const term of byName(termsOf(model, post.id))) {
    (terms[term.taxonomy] ??= []).push({
      slug: term.slug,
      name: decodeEntities(term.name),
      url: ctx.urlFor("term", term.termId) ?? "",
    });
  }
  data.terms = terms;
  Object.assign(
    data,
    toEntryData(acfValues(model, ctx.acf, postTarget(model, post), { report: DISCARD }), hooks),
  );
  cache.set(key, data);
  return data;
}

/**
 * An ACF value as WordPress prints it, for the field types that are text: a text or textarea value goes
 * through `wptexturize`, a wysiwyg value through `wpautop` and `wptexturize`. Groups, repeaters and
 * flexible rows are walked; every other type is a number, a choice or a reference, which has no text
 * to turn.
 */
/** A text field's value as the page prints it: stored markup stays markup (its text is turned, its tags are not) where the plugin prints it raw. */
function texturizeText(v: string, raw: boolean): string {
  return raw && HAS_MARKUP.test(v) ? texturizeHtml(v) : texturize(v);
}

function printedValue(f: AcfField, v: unknown, raw: boolean): unknown {
  switch (f.type) {
    case "text":
      return typeof v === "string" ? texturizeText(v, raw) : v;
    case "textarea":
      // The paragraphs of a textarea that ACF runs through `wpautop` are markup; a plain one is text.
      if (typeof v !== "string") return v;
      return newLines(f) === "wpautop" ? texturizeHtml(php.wpautop(v)) : texturizeText(v, raw);
    case "wysiwyg":
      return typeof v === "string" ? texturizeHtml(php.wpautop(v)) : v;
    case "group":
      return printedFields(f.subFields, v, false, raw);
    case "repeater":
      return Array.isArray(v) ? v.map((row) => printedFields(f.subFields, row, false, raw)) : v;
    case "flexible_content":
      return Array.isArray(v)
        ? v.map((row) =>
            printedFields(
              f.layouts.find((l) => l.name === (row as Record<string, unknown>)?.acf_fc_layout)
                ?.subFields ?? [],
              row,
              false,
              raw,
            ),
          )
        : v;
    default:
      return v;
  }
}

function printedFields(
  fields: readonly AcfField[],
  row: unknown,
  top = false,
  raw = false,
): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const f of fields) {
    const key = top ? entryKey(f.name) : f.name;
    if (f.name !== "" && key in out) out[key] = printedValue(f, out[key], raw);
  }
  return out;
}

/** The ACF fields of every active group, once: a value is texturized by the type of the field that holds it. */
const fieldsOf = (ctx: ConvertCtx): AcfField[] => ctx.acf.groups.flatMap((g) => g.fields);

/**
 * The entry data of a post, as the collections module writes it into frontmatter (docs/design.md,
 * Entry data contract): the facts of {@link postFacts} with the text as WordPress prints it, which is
 * what an entry template binds. `title` is texturized, `excerpt` is its text (tags stripped) texturized,
 * ACF text and textarea values
 * texturized, wysiwyg values run through `wpautop` and texturized (docs/bindings.md, section 8.7). An
 * entry conversion binds to these paths and a static one reads the facts, so the two print the same.
 */
export function postData(ctx: ConvertCtx, post: WpPost): EntryData {
  const cache = cacheFor(ctx);
  const key = `entry:${post.id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const facts = postFacts(ctx, post);
  const data = printedFields(fieldsOf(ctx), facts, true, printsAcfRaw(ctx)) as EntryData;
  data.title = texturize(String(facts.title));
  // A static page strips the tags, cuts, and only then texturizes, so a dash at the start of a line the
  // tags broke is not an en dash there: the entry keeps the text the same way round.
  data.excerpt = texturize(php.stripAllTags(String(facts.excerpt)));
  cache.set(key, data);
  return data;
}

/** The facts of a taxonomy term for a static page: its name, description, slug and URL, and its ACF term fields as stored. */
export function termFacts(ctx: ConvertCtx, term: WpTerm): EntryData {
  const cache = cacheFor(ctx);
  const key = `term-facts:${term.termId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const data: EntryData = {
    name: decodeEntities(term.name),
    description: term.description,
    slug: term.slug,
    taxonomy: term.taxonomy,
  };
  const url = ctx.urlFor("term", term.termId);
  if (url !== undefined) data.url = url;
  Object.assign(
    data,
    toEntryData(
      acfValues(ctx.model, ctx.acf, termTarget(ctx.model, term), { report: DISCARD }),
      hooksFor(ctx),
    ),
  );
  cache.set(key, data);
  return data;
}

/** The same for a taxonomy term, as its entry holds it: the ACF text of {@link termFacts} as WordPress prints it. */
export function termData(ctx: ConvertCtx, term: WpTerm): EntryData {
  const cache = cacheFor(ctx);
  const key = `term:${term.termId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const data = printedFields(
    fieldsOf(ctx),
    termFacts(ctx, term),
    true,
    printsAcfRaw(ctx),
  ) as EntryData;
  cache.set(key, data);
  return data;
}

// ── References: a value known now, or an expression over the entry ───────────────────────────────

/**
 * Where a piece of data is: `value` is the data itself (a static conversion, or an object that is
 * fixed whatever entry is rendered); `expr` is a JavaScript expression that reads it from the entry or
 * from a component's state. Everything that reads entry data goes through a reference, so the static
 * and the entry form of a token are two outcomes of one piece of code.
 */
export type Ref = { value: unknown } | { expr: string };

export const isExprRef = (r: Ref): r is { expr: string } => "expr" in r;

/** A property of what a reference points at, `src` of an image, `name` of a term. */
export function refProp(r: Ref, key: string): Ref {
  if (isExprRef(r)) return { expr: optPath(r.expr, key) };
  const v = r.value;
  return {
    value: v !== null && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined,
  };
}

/** The `data` object of the entry the template renders (`state.entry.data`, `$map.item.data`). */
export const entryDataExpr = (ctx: ConvertCtx): string => `${ctx.entryExpr}.data`;

/** Whether a term expression names a loop item (a term reference `{id, name, url}`) and not a term entry. */
export const termIsLoopItem = (ctx: ConvertCtx): boolean =>
  ctx.termExpr !== undefined && /^\$map\b/.test(ctx.termExpr);

/**
 * What a conversion context may carry beyond `ConvertCtx`, read when present: the URL of an author's
 * archive and of a post type's archive (the routes module has both and the contract's `urlFor` has
 * neither), and the expression of the current ACF repeater row.
 */
export interface CtxExtras {
  urlForAuthor?: (id: number) => string | undefined;
  urlForArchive?: (type: string) => string | undefined;
  rowExpr?: string;
}

export const extrasOf = (ctx: ConvertCtx): CtxExtras => ctx as ConvertCtx & CtxExtras;

/** The post the conversion is about, when it has one (a static page). */
export const subjectPost = (ctx: ConvertCtx): WpPost | undefined =>
  ctx.mode === "static" && ctx.subject.kind === "post" ? ctx.subject.post : undefined;

/**
 * One key of the current post's entry data (`title`, `featuredImage`, `terms`, an ACF field's
 * `entryKey`): a value for a static page, a binding for an entry template, nothing in a component
 * (a component has no entry of its own).
 */
export function currentRef(ctx: ConvertCtx, key: string): Ref | undefined {
  if (ctx.mode === "entry") return { expr: propPath(entryDataExpr(ctx), key) };
  const post = subjectPost(ctx);
  return post ? { value: postFacts(ctx, post)[key] } : undefined;
}

/** One key of the term the archive shows (`name`, `description`, an ACF term field). */
export function termRef(ctx: ConvertCtx, key: string): Ref | undefined {
  if (ctx.termExpr === undefined) return undefined;
  return termIsLoopItem(ctx)
    ? { expr: propPath(ctx.termExpr, key) }
    : { expr: propPath(`${ctx.termExpr}.data`, key) };
}

// ── ACF fields ───────────────────────────────────────────────────────────────────────────────────

/** A field and where it lives: the group that holds it and the container fields between them. */
export interface FieldInfo {
  field: AcfField;
  group: AcfGroup;
  /** The group, repeater or layout fields around it, outermost first. */
  path: AcfField[];
}

const fieldIndexes = new WeakMap<AcfModel, Map<string, FieldInfo>>();

/** An ACF field by its key (`field_6985035a0b7cb`), wherever it nests. */
export function fieldByKey(acf: AcfModel, key: string): FieldInfo | undefined {
  let index = fieldIndexes.get(acf);
  if (!index) {
    index = new Map();
    const visit = (group: AcfGroup, f: AcfField, path: AcfField[]): void => {
      index!.set(f.key, { field: f, group, path });
      for (const sub of f.subFields) visit(group, sub, [...path, f]);
      for (const layout of f.layouts)
        for (const sub of layout.subFields) visit(group, sub, [...path, f]);
    };
    for (const group of acf.groups) for (const f of group.fields) visit(group, f, []);
    fieldIndexes.set(acf, index);
  }
  return index.get(key);
}

/** Where an ACF value is read from. */
export type AcfScope =
  | { kind: "current" }
  | { kind: "post"; id: number }
  | { kind: "term"; id?: number }
  | { kind: "archive-term" }
  | { kind: "options" }
  | { kind: "user"; detail: string }
  | { kind: "loop-term" }
  | { kind: "unsupported"; detail: string };

/**
 * ACF's location argument as Cwicly writes it into a token: nothing or `false` is the current post;
 * a number a post; `option` the options page; `term_N` (or `<taxonomy>_N`) a term; `currenttaxonomytermarchive`
 * the archive's term; `taxterm` and `termquery` the term of the loop item; the user forms need a user,
 * which the converted site does not have.
 */
export function parseLocation(location: string | undefined): AcfScope {
  const loc = (location ?? "").trim();
  if (loc === "" || loc === "false" || loc === "currentpost") return { kind: "current" };
  if (/^\d+$/.test(loc)) return { kind: "post", id: Number(loc) };
  if (loc === "option") return { kind: "options" };
  if (loc === "currenttaxonomytermarchive") return { kind: "archive-term" };
  if (loc === "taxterm" || loc === "termquery") return { kind: "loop-term" };
  const term = /^(?:term|[a-z0-9_-]+)_(\d+)$/i.exec(loc);
  if (term && !loc.startsWith("user_")) return { kind: "term", id: Number(term[1]) };
  if (
    loc === "currentuser" ||
    loc === "currentauthor" ||
    loc === "userquery" ||
    loc.startsWith("user_")
  ) {
    return { kind: "user", detail: loc };
  }
  return { kind: "unsupported", detail: loc };
}

/**
 * Where the profile fields of the person a location names are: `userquery` is the person of the users
 * query loop the block sits in (an item of it, `$map.item`), and `user_<id>` a person known now.
 * `currentauthor` is not read: see below.
 */
function userSource(
  ctx: ConvertCtx,
  detail: string,
): { expr: string } | { fields: Record<string, unknown> } | { problem: string } {
  if (detail === "userquery") {
    const row = extrasOf(ctx).rowExpr;
    return row === undefined
      ? { problem: "a field of a person in a list of users needs the users query it is in" }
      : { expr: row };
  }
  if (detail === "currentauthor") {
    // Measured on the live pages: the block prints its own fallback (an image block `src=""` and its
    // fallback picture on an essay, an empty picture on an author page) whatever the author holds. The
    // plugin's `currentauthor` location reads nothing there, so nothing is read here.
    return { problem: "the plugin's currentauthor location reads no field on the live pages" };
  }
  const id = /^user_(\d+)$/.exec(detail)?.[1];
  if (id !== undefined) {
    return profileOf(ctx, Number(id))
      ? { fields: userFields(ctx, Number(id), true) }
      : { problem: `the user ${id} has no profile in the export` };
  }
  return {
    problem: `the field is read from a user (${detail}), which the converted site cannot name`,
  };
}

const profileOf = (ctx: ConvertCtx, id: number): boolean => userProfiles(ctx.model).has(id);

/** The reference to an ACF field's value for a scope, or why there is none. */
export function acfRef(
  ctx: ConvertCtx,
  info: FieldInfo,
  scope: AcfScope,
): { ref: Ref } | { problem: string } {
  const top = (info.path[0] ?? info.field).name;
  const nested = [...info.path.slice(1), ...(info.path.length > 0 ? [info.field] : [])];
  if (info.path.some((f) => f.type !== "group")) {
    return {
      problem: `the field "${info.field.name}" sits inside a repeater or a flexible layout, which needs a row`,
    };
  }
  const walk = (base: Ref): Ref => nested.reduce((r, f) => refProp(r, f.name), base);
  switch (scope.kind) {
    case "current": {
      const base = currentRef(ctx, entryKey(top));
      return base ? { ref: walk(base) } : { problem: "there is no current post here" };
    }
    case "post": {
      const post = ctx.model.posts.get(scope.id);
      if (!post) return { problem: `the post ${scope.id} is not in the export` };
      return { ref: walk({ value: postFacts(ctx, post)[entryKey(top)] }) };
    }
    case "term": {
      const term = ctx.model.terms.get(scope.id ?? -1);
      if (!term) return { problem: `the term ${scope.id} is not in the export` };
      return { ref: walk({ value: termFacts(ctx, term)[top] }) };
    }
    case "archive-term": {
      const base = termRef(ctx, top);
      if (!base) return { problem: "there is no archive term here" };
      return termIsLoopItem(ctx)
        ? { problem: "the term is a loop item, which carries no custom fields" }
        : { ref: walk(base) };
    }
    case "loop-term":
      return termRef(ctx, top) && !termIsLoopItem(ctx)
        ? { ref: walk(termRef(ctx, top) as Ref) }
        : { problem: "the term is a loop item, which carries no custom fields" };
    case "options": {
      const page = ctx.acf.optionsPages.find((p) => p.prefix === "options" && p.active);
      if (!page) return { problem: "the site has no ACF options page" };
      const values = acfValues(
        ctx.model,
        ctx.acf,
        { kind: "options", page: page.slug },
        { report: DISCARD },
      );
      return { ref: walk({ value: toEntryData(values, hooksFor(ctx))[entryKey(top)] }) };
    }
    case "user": {
      const where = userSource(ctx, scope.detail);
      if ("problem" in where) return where;
      const key = entryKey(top);
      return {
        ref: walk(
          "expr" in where
            ? { expr: optPath(where.expr, key) }
            : { value: (where.fields as Record<string, unknown>)[key] },
        ),
      };
    }
    case "unsupported":
      return { problem: `the location "${scope.detail}" is not one this tool can read` };
  }
}

/** Whether a value is empty the way PHP's `empty()` says: nothing, `""`, `"0"`, 0, false, an empty list. */
export function phpEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === "" || v === "0") return true;
  return Array.isArray(v) && v.length === 0;
}

/** The expression that is true when an expression's value is not empty in that sense (`0` and `'0'` are empty, as in PHP). */
export const notEmptyExpr = (e: string): string =>
  `((v) => !!v && v != '0' && !(Array.isArray(v) && !v.length))(${e})`;

/** A textarea's `new_lines` setting: how ACF turns its line breaks into markup when it reads the value (`wpautop`, `br`, or nothing). */
const newLines = (f: AcfField): string =>
  typeof f.settings.new_lines === "string" ? f.settings.new_lines : "";

/**
 * Whether ACF's text and textarea values are printed as they are stored. Cwicly escapes them
 * (`esc_html`) from 1.6.0 on; the plugin before that (1.4.7 on the pilot, whose pages show a link
 * typed into a text field as a link) returns the stored string and the page prints it as markup. The
 * data format's version (`cwicly_db_version`) is what a database says about the plugin that wrote it;
 * a site that does not say is taken to be current, which is the escaping one.
 */
export const printsAcfRaw = (ctx: Pick<ConvertCtx, "cwicly">): boolean => {
  const found = /^(\d+)\.(\d+)/.exec(ctx.cwicly.version ?? "");
  if (!found) return false;
  const [major, minor] = [Number(found[1]), Number(found[2])];
  return major < 1 || (major === 1 && minor < 6);
};

/** Text that holds an element, a comment or a doctype: the part of it that is markup is not text to texturize. */
const HAS_MARKUP = /<[a-z!/]/i;

/** PHP's `nl2br`: `<br />` before each line break, which stays. */
const nl2br = (text: string): string => text.replaceAll(/\r\n|\n|\r/g, (m) => `<br />${m}`);

const STRING_FIELDS = new Set([
  "text",
  "textarea",
  "email",
  "url",
  "password",
  "color_picker",
  "time_picker",
  "oembed",
  "number",
  "range",
]);

/** The label of a choice, for a select whose return format is the label. */
function choiceLabel(f: AcfField, value: string): string {
  return f.choices.find((c) => c.value === value)?.label ?? value;
}

/** The text of a list of choice values: labels or values, joined as `implode(',')` does. */
function choiceText(f: AcfField, value: unknown): string {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const labels = f.returnFormat === "label";
  return list.map((v) => (labels ? choiceLabel(f, String(v)) : String(v))).join(",");
}

/**
 * The text an ACF field prints in a text position, as Cwicly's `ACF::processor` does for a block that is
 * not an image: scalars as they are (escaped, except wysiwyg and oembed, which are markup, and the text
 * and textarea values of a site whose plugin predates the escaping, {@link printsAcfRaw}), an image
 * or a file as its URL, a link as its URL, a gallery as its URLs joined with commas, a choice as its
 * value or its label by the field's return format, a date in the field's return format. A value that
 * is empty is the empty string; a type with no text form is `undefined`.
 */
export function fieldText(ctx: ConvertCtx, f: AcfField, ref: Ref): Val | undefined {
  const html =
    f.type === "wysiwyg" ||
    f.type === "oembed" ||
    ((f.type === "text" || f.type === "textarea") && printsAcfRaw(ctx));
  if (!isExprRef(ref)) {
    const v = ref.value;
    if (v === undefined || v === null) return litV("");
    // ACF runs a wysiwyg value through `acf_the_content` (wpautop among others) when it reads it.
    if (f.type === "wysiwyg") return litV(php.wpautop(String(v)), true);
    if (f.type === "textarea" && newLines(f) === "wpautop")
      return litV(php.wpautop(String(v)), true);
    if (f.type === "textarea" && newLines(f) === "br")
      return litV(nl2br(escapeHtml(String(v))), true);
    if (STRING_FIELDS.has(f.type)) return litV(String(v), html);
    switch (f.type) {
      case "true_false":
        return litV(v ? "1" : "");
      case "select":
      case "radio":
      case "button_group":
      case "checkbox":
        return litV(choiceText(f, v));
      case "date_picker":
      case "date_time_picker": {
        const iso = String(v);
        const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
        const format =
          typeof f.settings.return_format === "string" ? f.settings.return_format : "d/m/Y";
        if (Number.isNaN(ms)) return litV("");
        // A date picker holds a day, not an instant: it is formatted where it was written.
        return litV(
          f.type === "date_picker" ? php.date(format, ms, "UTC") : formatDate(ctx, format, ms),
        );
      }
      case "image":
      case "file":
        return litV(typeof v === "object" ? String((v as { src?: string }).src ?? "") : "");
      case "link":
        return litV(typeof v === "object" ? String((v as { url?: string }).url ?? "") : "");
      case "gallery":
        return litV(
          Array.isArray(v) ? v.map((i) => String((i as { src?: string }).src ?? "")).join(",") : "",
        );
      case "post_object":
      case "page_link":
        return litV(
          Array.isArray(v)
            ? v.map((r) => (r as EntryRef).id).join(",")
            : String((v as EntryRef).url ?? ""),
        );
      case "relationship":
      case "taxonomy":
      case "user":
      case "nav_menu":
        return litV(
          (Array.isArray(v) ? v : [v]).map((r) => String((r as EntryRef).id ?? "")).join(","),
        );
      case "google_map":
      case "icon_picker":
        return litV("");
      default:
        return undefined;
    }
  }
  const e = ref.expr;
  if (f.type === "textarea" && newLines(f) === "wpautop") {
    // `wpautop` is not an expression: the entry holds the paragraphs, as it does for a wysiwyg value (postData).
    return exprV(`${e} ?? ''`, true);
  }
  if (f.type === "textarea" && newLines(f) === "br")
    return exprV(`${htmlEscapeExpr(e)}.replace(/\\r\\n|\\n|\\r/g, m => '<br />' + m)`, true);
  if (STRING_FIELDS.has(f.type)) {
    return exprV(`${e} ?? ''`, (f.type === "text" || f.type === "textarea") && printsAcfRaw(ctx));
  }
  switch (f.type) {
    case "wysiwyg":
      return exprV(`${e} ?? ''`, true);
    case "true_false":
      return exprV(`${e} ? '1' : ''`);
    case "select":
    case "radio":
    case "button_group":
    case "checkbox": {
      const list = `[].concat(${e} ?? [])`;
      if (f.returnFormat === "label") {
        const map = `{${f.choices.map((c) => `${jsString(c.value)}: ${jsString(c.label)}`).join(", ")}}`;
        return exprV(`${list}.map(v => (${map})[v] ?? v).join(',')`);
      }
      return exprV(`${list}.join(',')`);
    }
    case "date_picker":
    case "date_time_picker": {
      const format =
        typeof f.settings.return_format === "string" ? f.settings.return_format : "d/m/Y";
      // A date picker holds a day, which the entry stores as `YYYY-MM-DD`: it is read as the UTC midnight
      // it parses to and formatted in UTC, or a zone west of Greenwich prints the day before.
      const made = dateExpr(
        ctx,
        format,
        `(${e}) ?? ''`,
        f.type === "date_picker" ? "UTC" : undefined,
      );
      // A missing date must print nothing, not "Invalid Date".
      return exprV(`(${e}) ? ${made.expr} : ''`);
    }
    case "image":
    case "file":
      return exprV(`${optPath(e, "src")} ?? ''`);
    case "link":
      return exprV(`${optPath(e, "url")} ?? ''`);
    case "gallery":
      return exprV(`[].concat(${e} ?? []).map(i => i.src).join(',')`);
    case "post_object":
    case "page_link":
      return exprV(
        `Array.isArray(${e}) ? ${e}.map(r => r.id).join(',') : (${optPath(e, "url")} ?? '')`,
      );
    case "relationship":
    case "taxonomy":
    case "user":
    case "nav_menu":
      return exprV(`[].concat(${e} ?? []).map(r => r.id).join(',')`);
    case "google_map":
    case "icon_picker":
      return litV("");
    default:
      return undefined;
  }
}

/** What `{authorinfo=…}` an author page's entry holds. */
const AUTHOR_PAGE_INFO: ReadonlySet<string> = new Set(["first_name", "last_name", "description"]);

/** What `{userquery=…}` names of a person, and where the item of the loop holds it. */
const USER_QUERY_KEYS: Readonly<Record<string, string>> = {
  display_name: "title",
  user_nicename: "slug",
  ID: "id",
  id: "id",
};

// ── The token table ──────────────────────────────────────────────────────────────────────────────

/** The conversion a token is resolved in, with the string it sits in. */
export interface Env {
  /** Set when a value resolved here is markup, so the caller knows the result is HTML. */
  trace?: { html: boolean } | undefined;
  ctx: ConvertCtx;
  block?: WpBlock | undefined;
  attrs: Record<string, unknown>;
  /** The text around the token is markup: a literal value is escaped, a binding is a placeholder. */
  markup: boolean;
  /** The character after the token, for the origin tokens that sit in front of a path. */
  next: string;
}

type Outcome = Val | { raw: string } | { keep: true } | { drop: string } | undefined;

/** The attribute of the block as non-empty text. */
function attr(env: Env, key: string): string | undefined {
  const v = env.attrs[key];
  return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined;
}

const textOfRef = (r: Ref): Val =>
  isExprRef(r)
    ? exprV(`${r.expr} ?? ''`)
    : litV(r.value === undefined || r.value === null ? "" : String(r.value));

const drop = (reason: string): Outcome => ({ drop: reason });

/** The fallback text a block carries for a dynamic value that is empty (`dynamicStaticFallback`). */
function fallbackText(env: Env): Val | undefined {
  const text = attr(env, "dynamicStaticFallback");
  return text === undefined ? undefined : litV(env.markup ? texturize(text) : text);
}

/** `text`, or the block's fallback text when it is empty. */
const withFallback = (env: Env, v: Val | undefined): Val | undefined =>
  orElse(v, fallbackText(env));

/** The Jx path of an image given by an attachment id or a URL: a fallback image, `{featuredimage}`'s fifth argument. */
function imageSrcOf(ctx: ConvertCtx, ref: string): string | undefined {
  if (ref === "" || ref === "false") return undefined;
  if (/^\d+$/.test(ref)) return ctx.mediaFor(Number(ref))?.src;
  return ctx.mediaForUrl(ref)?.src ?? ctx.rewriteUrl(ref);
}

/**
 * The fallback image a block names, as a Jx path: the attachment id first, then the address next to it,
 * because the id of an attachment that was deleted or never exported has no file while the address
 * still names the file the editor showed. `given` is what a token carries as its fallback argument.
 */
export function fallbackImageSrc(
  ctx: ConvertCtx,
  attrs: Record<string, unknown>,
  keys: { id: string; url: string },
  given?: string,
): string | undefined {
  const value = (k: string): string | undefined => {
    const v = attrs[k];
    return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined;
  };
  for (const ref of [given, value(keys.id), value(keys.url)]) {
    if (ref === undefined || ref === "" || ref === "false") continue;
    const src = imageSrcOf(ctx, ref);
    if (src !== undefined) return src;
  }
  return undefined;
}

/** The origin of the source site: where an absolute URL (a share link) has to start. */
const originOf = (ctx: ConvertCtx): string => ctx.model.site.home.replace(/\/$/, "");

/** `https://site` + a site-relative path, as a value. */
function absoluteVal(ctx: ConvertCtx, path: Val): Val {
  const origin = originOf(ctx);
  if ("lit" in path) return litV(path.lit.startsWith("/") ? origin + path.lit : path.lit);
  return exprV(`${jsString(origin)} + (${path.expr})`);
}

function noCurrentPost(env: Env, token: string): Outcome {
  return drop(
    env.ctx.mode === "component"
      ? `${token} reads the current post, and a component has no entry of its own`
      : `${token} reads the current post, and this conversion has none`,
  );
}

/** A media reference by attachment id: its file's description, or why there is none. */
function mediaOf(env: Env, ref: string | undefined, token: string) {
  const id = Number(ref);
  if (ref === undefined || !Number.isInteger(id) || id <= 0) {
    return { problem: `${token} names no attachment (${ref ?? "no argument"})` };
  }
  const media = env.ctx.mediaFor(id);
  if (!media) {
    report(
      env.ctx,
      "dynamic.missing-image",
      "warn",
      `The attachment ${id} that ${token} names has no file in the media plan.`,
      { token: `${token}:${id}`, id },
    );
    return { problem: `the attachment ${id} has no file` };
  }
  return { media };
}

/** The Jx URL of a WordPress object: `{pageobject}`'s and a static link's resolution. */
export function objectUrl(
  ctx: ConvertCtx,
  id: number,
  type: string,
  kind: string,
): { url: string } | { problem: string } {
  const post = (): string | undefined => ctx.urlFor("post", id);
  const term = (): string | undefined => ctx.urlFor("term", id);
  let url: string | undefined;
  switch (type) {
    case "post":
    case "page":
      url = post();
      break;
    case "category":
    case "tag":
    case "taxonomy":
      url = term();
      break;
    case "attachment":
      url = ctx.mediaFor(id)?.src;
      break;
    case "post_format":
      return { problem: "a post format archive is not on the converted site" };
  }
  if (url === undefined || url === "") {
    if (kind === "taxonomy") url = term();
    else if (kind === "post-type") url = post();
  }
  return url === undefined || url === ""
    ? { problem: `no ${type || kind} ${id} on the converted site` }
    : { url };
}

/** The `{pageurl}` of the current post, or of a given post id. */
function pageUrl(env: Env, args: string[]): Outcome {
  const { ctx } = env;
  const encoded = args[1] === "encoded";
  let base: Val | undefined;
  if (args[0] && args[0] !== "false") {
    const url = ctx.urlFor("post", Number(args[0]));
    if (url === undefined) return drop(`the post ${args[0]} is not on the converted site`);
    base = litV(url);
  } else {
    const r = currentRef(ctx, "url");
    if (!r) return noCurrentPost(env, "{pageurl}");
    base = isExprRef(r) ? exprV(`${r.expr} ?? ''`) : litV(String(r.value ?? ""));
    if (!isExprRef(r) && r.value === undefined)
      return drop("the current post has no URL on the converted site");
  }
  if (!encoded) return base;
  const abs = absoluteVal(ctx, base);
  report(
    ctx,
    "token.approximated",
    "info",
    "A share link carries the page's absolute URL: it assumes the converted site keeps the source site's address.",
    { token: "pageurl=encoded" },
  );
  return "lit" in abs
    ? litV(encodeURIComponent(abs.lit))
    : exprV(`encodeURIComponent(${abs.expr})`);
}

/** The date and time tokens that read the current post's own dates. */
function postDate(env: Env, args: string[], time: boolean): Outcome {
  const { ctx } = env;
  const modified = args[0] === "modified";
  const code = args[1];
  const key = modified ? "modified" : "date";
  const r = currentRef(ctx, key);
  if (!r) return noCurrentPost(env, time ? "{time}" : "{postdate}");
  const custom = args[2] || (time ? attr(env, "dynamicWordPressTimeCustom") : undefined) || "";
  const stated = args[0] === "published" || args[0] === "modified";
  let format = "F j, Y";
  if (stated && code !== undefined) {
    if (!time && code === "5") format = "ago";
    else format = cwiclyFormat(time ? "time" : "date", code, custom) || (time ? "g:i a" : "F j, Y");
  } else if (time) {
    format = "g:i a";
  }
  if (format === "ago") {
    if (isExprRef(r)) {
      report(
        ctx,
        "token.approximated",
        "warn",
        'A relative date ("5 mins ago") cannot be bound to an entry; the date is printed in full.',
        { token: "postdate=5" },
      );
      format = "F j, Y";
    } else {
      report(
        ctx,
        "token.frozen-date",
        "info",
        "A relative date is evaluated when the site is converted.",
        { token: "postdate=5" },
      );
      const ms = Date.parse(String(r.value));
      return Number.isNaN(ms) ? litV("") : litV(`${humanTimeDiff(ms, Date.now())} ago`);
    }
  }
  if (!isExprRef(r)) {
    const ms = Date.parse(String(r.value));
    return Number.isNaN(ms) ? litV("") : litV(formatDate(ctx, format, ms));
  }
  const made = dateExpr(ctx, format, `${r.expr}`);
  return exprV(`(${r.expr}) ? ${made.expr} : ''`);
}

/** The tokens that print the current date or time: evaluated when the site is built. */
function nowDate(env: Env, token: string, format: string): Outcome {
  const made = dateExpr(env.ctx, format, "Date.now()");
  report(
    env.ctx,
    "token.frozen-date",
    "info",
    "The current date is written as an expression, which the build evaluates: it shows the date of the last build.",
    { token },
  );
  return exprV(made.expr);
}

/** The terms of the current post, one taxonomy, as a list of names. */
function termNames(env: Env, token: string, taxonomy: string, index?: number): Outcome {
  const { ctx } = env;
  const r = currentRef(ctx, "terms");
  if (!r) return noCurrentPost(env, token);
  if (isExprRef(r)) {
    const list = `(${optPath(r.expr, taxonomy)} ?? [])`;
    return exprV(
      index === undefined ? `${list}.map(t => t.name).join(' ')` : `${list}[${index}]?.name ?? ''`,
    );
  }
  const terms = ((r.value as Record<string, { name: string }[]> | undefined)?.[taxonomy] ?? []).map(
    (t) => t.name,
  );
  return litV(index === undefined ? terms.join(" ") : (terms[index] ?? ""));
}

/**
 * The excerpt of a post as plain text, limited the way `{postexcerpt=N}` limits it: PHP's `substr` cuts
 * N BYTES (a curly quote is three) and `strrpos` then cuts at the last space, so an excerpt with
 * multibyte characters is shorter than N characters, and one with no space inside the limit is empty.
 */
export function limitExcerpt(text: string, limit: number): string {
  const plain = php.stripAllTags(text);
  if (limit <= 0) return plain;
  const bytes = new TextEncoder().encode(plain);
  if (bytes.length <= limit) return plain;
  const cut = bytes.subarray(0, limit);
  const at = cut.lastIndexOf(32);
  return at < 0 ? "" : new TextDecoder().decode(cut.subarray(0, at));
}

/**
 * The expression form of {@link limitExcerpt} over an entry's excerpt: tags stripped, PHP's `trim`
 * (which leaves a no-break space alone), then the same cut in bytes. The entry stores the excerpt as
 * WordPress prints it, but WordPress made the cut on the text before it was texturized, where a curly
 * quote that the author typed is three bytes and one that `wptexturize` wrote from a straight quote is
 * one. The stored text cannot tell the two apart, so the cut is exact except where the first `limit`
 * bytes hold a straight quote or a spaced dash that was texturized (about 1% of the excerpts of both
 * sites, over every limit they use); weighing every curly quote as one byte instead is wrong for the
 * far commoner case of text typed with curly quotes (five times as many excerpts).
 */
function excerptCutExpr(expr: string, limit: number): string {
  const plain = `String((${expr}) ?? '').replace(/<(script|style)[^>]*?>[\\s\\S]*?<\\/\\1>/gi, '').replace(/<[^>]*>/g, '').replace(/^[ \\t\\n\\r\\0\\x0B]+|[ \\t\\n\\r\\0\\x0B]+$/g, '')`;
  if (limit <= 0) return plain;
  return `((s) => { const b = new TextEncoder().encode(s); if (b.length <= ${limit}) return s; const c = b.subarray(0, ${limit}); const i = c.lastIndexOf(32); return i < 0 ? '' : new TextDecoder().decode(c.subarray(0, i)); })(${plain})`;
}

function excerpt(env: Env, args: string[]): Outcome {
  const { ctx } = env;
  const limit = Number(args[0] ?? "") || 0;
  const r = currentRef(ctx, "excerpt");
  if (!r) return noCurrentPost(env, "{postexcerpt}");
  // The text has had its tags stripped but not its character references: `&nbsp;` is printed as it was written.
  if (!isExprRef(r))
    return withFallback(env, litV(limitExcerpt(String(r.value ?? ""), limit), true));
  return withFallback(env, exprV(excerptCutExpr(r.expr, limit), true));
}

/** What `{archivetitle}` and `{archivedescription}` say: the term of the archive, or a post type's labels. */
function archive(env: Env, what: "title" | "description"): Outcome {
  const { ctx } = env;
  if (ctx.termExpr !== undefined) {
    const r = termRef(ctx, what === "title" ? "name" : "description");
    if (r)
      return what === "title"
        ? textOfRef(r)
        : withFallback(env, exprV(`${(r as { expr: string }).expr} ?? ''`, true));
  }
  const type = ctx.entryType;
  const postType = type === undefined ? undefined : ctx.acf.postTypes.get(type);
  if (postType && ctx.subject.kind === "template" && /(^|\/\/)archive-/.test(ctx.subject.id)) {
    if (what === "title") return litV(postType.labels.name ?? postType.plural);
    return withFallback(env, litV("", true));
  }
  return drop(
    `the ${what} of an archive needs the archive (a taxonomy term or a post type) this conversion is not about`,
  );
}

/** The term of the loop item or the archive, by property (`{taxterms=name}`, `{termquery=slug}`). */
function termProperty(env: Env, token: string, prop: string | undefined): Outcome {
  const known = ["name", "slug", "description", "taxonomy", "url"];
  if (prop === undefined || !known.includes(prop))
    return drop(
      `${token} reads the term property "${prop ?? ""}", which the converted site does not keep`,
    );
  const r = termRef(env.ctx, prop);
  return r
    ? prop === "description"
      ? exprV(`${(r as { expr: string }).expr} ?? ''`)
      : textOfRef(r)
    : drop(`${token} needs a term, and this conversion has none`);
}

/** `{customfield=key}` and its kin: post meta, which only an ACF field of that name has a place for. */
function customField(env: Env, key: string | undefined): Outcome {
  const { ctx } = env;
  if (key === undefined || key === "") return drop("{customfield} names no field");
  const post = subjectPost(ctx);
  if (post) {
    const meta = ctx.model.postMeta.get(post.id)?.[key]?.[0];
    return typeof meta === "string" || typeof meta === "number" ? litV(String(meta)) : litV("");
  }
  for (const group of ctx.acf.groups) {
    const f = group.fields.find((g) => g.name === key);
    if (f) {
      const r = currentRef(ctx, entryKey(key));
      const text = r ? fieldText(ctx, f, r) : undefined;
      if (text) return text;
    }
  }
  return drop(`the custom field "${key}" is not an ACF field, and only those are kept on an entry`);
}

// ── ACF ──────────────────────────────────────────────────────────────────────────────────────────

/** The fallback an ACF token carries: its fifth argument, then the block's fallback image or text. */
function acfFallback(env: Env, arg: string | undefined, image: boolean): Val | undefined {
  const given = arg !== undefined && arg !== "" && arg !== "false" ? arg : undefined;
  if (image) {
    const src =
      fallbackImageSrc(
        env.ctx,
        env.attrs,
        { id: "dynamicStaticFallbackID", url: "dynamicStaticFallbackURL" },
        given,
      ) ??
      fallbackImageSrc(env.ctx, env.attrs, {
        id: "backgroundDynamicStaticFallbackID",
        url: "backgroundDynamicStaticFallbackURL",
      });
    if (src !== undefined) return litV(src);
    if (given !== undefined && !/^\d+$/.test(given)) return litV(given);
    return undefined;
  }
  if (given !== undefined) return litV(env.markup ? texturize(given) : given);
  const url = attr(env, "dynamicStaticFallbackURL") ?? attr(env, "dynamicStaticFallbackID");
  if (url !== undefined) return litV(url);
  return fallbackText(env);
}

/** The sub-key of an ACF array value (`{acffield=field=false=url}`) as a reference. */
function acfSubRef(f: AcfField, ref: Ref, sub: string): Ref {
  if (f.type === "image" || f.type === "file") {
    const key = sub === "url" || sub === "src" ? "src" : sub;
    return refProp(ref, key);
  }
  return refProp(ref, sub);
}

const IMAGE_OPTION = "image";

/** `{acffield=key=location=subkey=fallback=options}`: an ACF value as the text it prints. */
function acfField(env: Env, args: string[]): Outcome {
  const { ctx } = env;
  const key = args[0] ?? "";
  const info = fieldByKey(ctx.acf, key);
  const options = (args[4] ?? "").split("-");
  const image =
    options[3] === IMAGE_OPTION || (options[0] === "background" && options[1] === IMAGE_OPTION);
  const fallback = acfFallback(env, args[3], image);
  if (!info) {
    report(
      ctx,
      "dynamic.unknown-field",
      "warn",
      `The ACF field "${key}" is not defined by any field group; the token prints its fallback.`,
      { token: key, field: key },
    );
    return fallback ?? drop(`the ACF field ${key} does not exist`);
  }
  const scope = parseLocation(args[1]);
  const got = acfRef(ctx, info, scope);
  if ("problem" in got) {
    report(
      ctx,
      "dynamic.unsupported",
      "warn",
      `The field "${info.field.name}" cannot be bound here: ${got.problem}.`,
      { token: `${key}:${args[1] ?? ""}`, field: info.field.name },
    );
    return fallback ?? drop(got.problem);
  }
  const sub = args[2];
  const subbed = sub !== undefined && sub !== "" && sub !== "false";
  const ref = subbed ? acfSubRef(info.field, got.ref, sub) : got.ref;
  let text: Val | undefined;
  if (subbed) {
    text = textOfRef(ref);
  } else {
    text = fieldText(ctx, info.field, ref);
    // Measured on the live pages: a person's biography (a wysiwyg field of the user form) prints as text,
    // its `<p>` tags and all, where the same kind of field of a post prints as markup.
    if (text !== undefined && scope.kind === "user" && info.field.type === "wysiwyg") {
      text = escapedText({ ...text, html: false });
    }
    if (text === undefined) {
      report(
        ctx,
        "dynamic.unsupported",
        "warn",
        `The ACF field type "${info.field.type}" has no text form (field "${info.field.name}").`,
        { token: key, field: info.field.name },
      );
      return fallback ?? drop(`the field type ${info.field.type} has no text form`);
    }
  }
  return orElse(subbed ? text : withoutPhpZero(info.field, text), fallback) ?? litV("");
}

/**
 * What `esc_html` makes of a value, as the text the page shows. It does not escape the `&` of a
 * character reference that is already there (`&quot;` stays `&quot;`), so the browser reads it as the
 * character; the emitter below this escapes every `&`, so the references are read here, once.
 */
function escapedText(v: Val): Val {
  if ("lit" in v) return { ...v, lit: decodeEntities(v.lit) };
  const read =
    "(s) => String(s).replace(/&(#\\d+|#[xX][0-9a-fA-F]+|quot|amp|lt|gt|apos|nbsp);/g, " +
    "(m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) " +
    ": ({quot: '\\x22', amp: '&', lt: '<', gt: '>', apos: '\\x27', nbsp: '\\xa0'})[e])";
  return { ...v, expr: `(${read})(${v.expr})` };
}

/** The field types whose value is one scalar, which Cwicly's `if ($field)` reads as empty when it is `0` or `"0"`. */
const SCALAR_FIELDS = new Set([...STRING_FIELDS, "select", "radio", "button_group"]);

/**
 * `ACF::processor` starts with `if ($field)`, and a value of `0` or `"0"` is false: such a field prints
 * its fallback, or nothing. (A list, an image or a link is never `0`.)
 */
function withoutPhpZero(f: AcfField, v: Val): Val {
  if (!SCALAR_FIELDS.has(f.type)) return v;
  if ("lit" in v) return v.lit === "0" ? litV("", v.html === true) : v;
  return exprV(
    `((t) => t == '0' ? '' : t ?? '')(${v.expr.replace(/ \?\? ''$/, "")})`,
    v.html === true,
  );
}

// ── Components ───────────────────────────────────────────────────────────────────────────────────

/** The prop of the component being converted that a token names, with its Jx state key. */
function propOf(env: Env, id: string | undefined): { key: string; type: string } | undefined {
  const key = id === undefined ? undefined : env.ctx.props?.get(id);
  if (key === undefined) return undefined;
  const info = env.ctx.components.get(env.ctx.subject.id);
  const type = info?.props.find((p) => p.id === id)?.type ?? "";
  return { key, type };
}

const RICH_PROPS = new Set(["richtext", "wysiwyg", "content", "html"]);

function componentToken(env: Env, args: string[]): Outcome {
  const { ctx } = env;
  const [what, id, variant] = args;
  const unknown = (): Outcome =>
    drop(`the component parameter ${id ?? ""} is not one of this component's properties`);
  if (what === "parameter") {
    const prop = propOf(env, id);
    if (!prop) return unknown();
    const read = `state.${prop.key}`;
    switch (variant) {
      case undefined:
      case "":
      case "lg":
      case "md":
      case "sm":
      case "boolean":
        return exprV(`${read} ?? ''`, RICH_PROPS.has(prop.type));
      case "accordionopen":
        return exprV(`${read} ? 'cc-accordion-active' : 'cc-accordion-hidden'`);
      case "listIconActive":
        return exprV(`${read} ? 'cc-icon-list' : ''`);
      default:
        report(
          ctx,
          "token.approximated",
          "warn",
          `The component parameter variant "${variant}" is passed through as the plain value.`,
          { token: `component=parameter=${id}=${variant}` },
        );
        return exprV(`${read} ?? ''`);
    }
  }
  if (what === "link" || what === "image") {
    const prop = propOf(env, id);
    if (!prop) return unknown();
    // The prop is `{href, target?, rel?, title?}` or `{src, alt?, ...}`; the other attributes are blockLink's and blockImage's.
    return exprV(`${optPath(`state.${prop.key}`, what === "link" ? "href" : "src")} ?? ''`);
  }
  if (what === "icon") {
    const prop = propOf(env, id);
    return prop ? exprV(`state.${prop.key} ?? ''`) : unknown();
  }
  if (what === "class") {
    const prop = propOf(env, id);
    return prop ? exprV(`state.${prop.key} ?? ''`) : unknown();
  }
  // `{component=content=<ref>}` and any other connector the block names: the value of its property.
  const connector = env.attrs.componentConnectors as Record<string, { ref?: string }> | undefined;
  const ref = (what === undefined ? undefined : connector?.[what]?.ref) ?? id;
  const prop = propOf(env, ref);
  if (!prop) return unknown();
  return exprV(`state.${prop.key} ?? ''`, RICH_PROPS.has(prop.type));
}

// ── The table ────────────────────────────────────────────────────────────────────────────────────

/** Tokens the class module owns: left exactly as written. */
const CLASS_TOKENS = new Set([
  "class",
  "acl",
  "sacl",
  "gcl",
  "aclv",
  "gclv",
  "cs-index",
  "cccomp",
  "currentpageclass",
  "darkmode_force",
]);

/** Loop and id bookkeeping: nothing on the converted site. */
const BOOKKEEPING = new Set(["empty", "idadd", "loop-id", "loop-index", "loop-position", "shell"]);

/** Tokens that need a person, a shop, a comment thread or a query: nothing a static site can answer. */
const UNSUPPORTED: Readonly<Record<string, string>> = {
  postcomments: "comments are not carried over",
  post_comments: "comments are not carried over",
  commentquery: "comments are not carried over",
  commentqueryauthorarchive: "comments are not carried over",
  commenturl: "comments are not carried over",
  commentsurl: "comments are not carried over",
  commentreplyurl: "comments are not carried over",
  editcommenturl: "comments are not carried over",
  formcomment: "comments are not carried over",
  currentcommenter: "comments are not carried over",
  commentcookiescheck: "comments are not carried over",
  loginurl: "the converted site has no login",
  directlogout: "the converted site has no login",
  postquery: "query output is the query converter's",
  pagination: "pagination is not built (Jx has no pagination yet)",
  nextquery: "pagination is not built (Jx has no pagination yet)",
  prevquery: "pagination is not built (Jx has no pagination yet)",
  nextqb: "pagination is not built (Jx has no pagination yet)",
  prevqb: "pagination is not built (Jx has no pagination yet)",
  filter: "filters need the query they filter",
  filterlink: "filters need the query they filter",
  filterstatus: "filters need the query they filter",
  filterimage: "filters need the query they filter",
  urlparam: "a URL parameter is a request, and a static page has none",
  previouspost: "an adjacent post is a query",
  nextpost: "an adjacent post is a query",
  shortcode: "a shortcode is PHP",
  return: "a PHP function return is PHP",
  readtime: "the reading time is written by Cwicly's script",
  slider: "sliders are not carried over",
  hide: "a shop attribute",
  taxonomyqueryurl: "a term query loop",
};

/**
 * The WooCommerce tokens `cc_get_dyn` switches on, by exact name: a CSS or script brace that merely
 * starts with one of these words (`{width:100%}`, `{quantity++}`) is not a token and is returned as written.
 */
const WOO = new Set([
  "wooimage",
  "woo_gallery_id",
  "woogallery",
  "woonotice",
  "iwgi",
  "cartthumbnail",
  "cartthumbnailsrcset",
  "woocategorythumbnail",
  "woocategorythumbnailsrcset",
  "woocategorythumbnailsizes",
  "woocheckouturl",
  "woocarturl",
  "carttotal",
  "cartitemname",
  "cartitemquantity",
  "cartitemprice",
  "cartsubtotal",
  "cartitemscount",
  "cartitemkey",
  "removecartitem",
  "removecartitemajax",
  "price",
  "saleprice",
  "regularprice",
  "currency",
  "currencysymbol",
  "weight",
  "height",
  "width",
  "length",
  "quantity",
  "description",
  "shortdescription",
  "maxpurchasequantity",
  "minpurchasequantity",
  "salefrom",
  "saletill",
  "sku",
  "ratingcount",
  "reviewcount",
  "averagerating",
  "salepercentage",
  "totalsold",
  "woo_item_min",
  "woo_item_max",
  "watc",
  "swatchclass",
  "swatchid",
  "htmltag",
  "swatch",
  "woocouponnonce",
  "wooaddtocartajax",
  "wooaddtocart",
  "formwoocoupon",
  "formaddtocart",
  "forminneraddtocart",
  "producttype",
  "variationqueryid",
  "variationprice",
  "variationsaleprice",
  "variationsalepercentage",
  "variationregularprice",
  "variationquanity",
  "variationheight",
  "variationwidth",
  "variationlength",
  "variationdescription",
  "variationminpurchasequantity",
  "variationmaxpurchasequantity",
  "variationlabel",
  "variationtype",
  "variationslug",
]);

type Handler = (args: string[], env: Env) => Outcome;

/** The tokens with a meaning on the converted site, by their canonical name. */
const HANDLERS: Readonly<Record<string, Handler>> = {
  // The current post.
  title: (_a, env) => {
    const r = currentRef(env.ctx, "title");
    if (!r) return noCurrentPost(env, "{title}");
    return isExprRef(r) ? exprV(`${r.expr} ?? ''`) : litV(texturize(String(r.value ?? "")));
  },
  pagetitle: (_a, env) => HANDLERS.title!([], env),
  postexcerpt: (a, env) => excerpt(env, a),
  postdate: (a, env) => postDate(env, a, false),
  time: (a, env) => postDate(env, a, true),
  id: (_a, env) => {
    const post = subjectPost(env.ctx);
    return post ? litV(String(post.id)) : drop("the post id is not in the entry data");
  },
  posttype: (_a, env) => {
    const post = subjectPost(env.ctx);
    if (post) return litV(post.type);
    if (env.ctx.entryType !== undefined) return litV(env.ctx.entryType);
    const r = currentRef(env.ctx, "postType");
    return r && isExprRef(r)
      ? exprV(`${r.expr} ?? ''`)
      : drop("the post type of the entry is unknown");
  },
  postparentid: () => drop("the parent post id is not in the entry data"),
  postcategories: (_a, env) => termNames(env, "{postcategories}", "category"),
  posttags: (_a, env) => termNames(env, "{posttags}", "post_tag"),
  postcategory: (_a, env) => {
    const index = Number(attr(env, "dynamicCategoryIndex") ?? 1) || 1;
    const names = termNames(env, "{postcategory}", "category", index - 1);
    return names !== undefined && "lit" in names ? withFallback(env, names) : names;
  },
  tag: (_a, env) => {
    const index = Number(attr(env, "dynamicTagIndex") ?? 1) || 1;
    return termNames(env, "{tag}", "post_tag", index - 1);
  },
  customfield: (a, env) => customField(env, a[0]),
  authorname: (_a, env) => {
    const r = currentRef(env.ctx, "author");
    return r ? withFallback(env, textOfRef(r)) : noCurrentPost(env, "{authorname}");
  },
  authorinfo: (_a, env) => {
    // `description` is the block's default, which Gutenberg does not store.
    const wanted = attr(env, "dynamicWordPressAuthorInfo") ?? "description";
    const r = wanted === "display_name" ? currentRef(env.ctx, "author") : undefined;
    if (r) return withFallback(env, textOfRef(r));
    // An author page's own entry holds the profile's names and biography.
    if (
      env.ctx.mode === "entry" &&
      env.ctx.entryExpr === "state.author" &&
      AUTHOR_PAGE_INFO.has(wanted)
    ) {
      return withFallback(env, exprV(`${optPath(entryDataExpr(env.ctx), wanted)} ?? ''`));
    }
    // The author of an entry or of a page: their biography and names, as the entry (`authorInfo`) holds them.
    if (AUTHOR_PAGE_INFO.has(wanted)) {
      if (env.ctx.mode === "entry") {
        return withFallback(
          env,
          exprV(`${optPath(optPath(entryDataExpr(env.ctx), "authorInfo"), wanted)} ?? ''`),
        );
      }
      const author = subjectPost(env.ctx)?.authorId;
      const held =
        author === undefined ? undefined : userProfiles(env.ctx.model).get(author)?.meta[wanted];
      if (author !== undefined)
        return withFallback(env, litV(typeof held === "string" ? held : ""));
    }
    const post = subjectPost(env.ctx);
    const user = post ? env.ctx.model.users.get(post.authorId) : undefined;
    if (user && wanted === "user_nicename") return litV(user.slug);
    return (
      withFallback(env, undefined) ??
      drop(`the author's "${wanted}" is not carried over (only the display name is)`)
    );
  },
  authorurl: (_a, env) => {
    // The entry data contract has no author address; `authorUrl` is the key this tool asks for.
    if (env.ctx.mode === "entry")
      return exprV(`${propPath(entryDataExpr(env.ctx), "authorUrl")} ?? ''`);
    const post = subjectPost(env.ctx);
    const id = post?.authorId;
    const url = id === undefined ? undefined : extrasOf(env.ctx).urlForAuthor?.(id);
    return url === undefined ? drop("the author archive is not on the converted site") : litV(url);
  },
  // The person of a users query loop: an item of it is `{id, slug, title, url, …profile fields}`.
  userquery: (a, env) => {
    const row = extrasOf(env.ctx).rowExpr;
    if (row === undefined) return drop("a user query token outside the loop of a users query");
    const name = a[0] ?? "display_name";
    const key = USER_QUERY_KEYS[name];
    return key === undefined
      ? drop(`the user's ${name} is not carried over`)
      : exprV(`${optPath(row, key)} ?? ''`);
  },
  userqueryurl: (_a, env) => {
    const row = extrasOf(env.ctx).rowExpr;
    return row === undefined
      ? drop("a user query token outside the loop of a users query")
      : exprV(`${optPath(row, "url")} ?? ''`);
  },
  authorcustomfield: () => drop("user meta is not carried over"),
  usercustomfield: () => litV(""),
  // The current user is nobody: a static site has visitors, not users.
  username: (_a, env) => withFallback(env, litV("")),
  userinfo: (_a, env) => withFallback(env, litV("")),
  user_info: () => litV(""),
  userid: () => litV("0"),
  userpicture: (_a, env) => acfFallback(env, undefined, true) ?? litV(""),
  user_avatar: (_a, env) => HANDLERS.userpicture!([], env),
  bguserpicture: (_a, env) =>
    litV(
      fallbackImageSrc(env.ctx, env.attrs, {
        id: "backgroundDynamicStaticFallbackID",
        url: "backgroundDynamicStaticFallbackURL",
      }) ?? "",
    ),
  // The site.
  sitetitle: (_a, env) => litV(decodeEntities(env.ctx.model.site.name)),
  sitetagline: (_a, env) => litV(decodeEntities(env.ctx.model.site.description)),
  siteoption: (a, env) => {
    const value = a[0] === undefined ? undefined : env.ctx.model.options.get(a[0]);
    if (value === undefined) return litV("");
    return /^(?:a|O|s|i|b):\d/.test(value) || /^[[{]/.test(value)
      ? drop(`the option "${a[0]}" is a structure, not text`)
      : litV(value);
  },
  siteurl: (_a, env) => originToken(env, env.ctx.model.site.url),
  homeurl: (_a, env) => originToken(env, env.ctx.model.site.home),
  currentdate: (a, env) => {
    const timeCode = a[0] || "";
    const dateCode = a[1] || "";
    const time =
      timeCode === "" ? "g:i a" : (TIME_FORMATS[timeCode] ?? (timeCode === "4" ? "" : "g:i a"));
    const date =
      dateCode === "" ? "F j, Y" : (DATE_FORMATS[dateCode] ?? (dateCode === "5" ? "" : "F j, Y"));
    return nowDate(env, "currentdate", `${date} ${time}`);
  },
  customcurrentdate: (a, env) => nowDate(env, "customcurrentdate", a[0] ?? ""),
  date: (_a, env) => nowDate(env, "date", "m/d/Y"),
  dayweek: (_a, env) => nowDate(env, "dayweek", "l"),
  daymonth: (_a, env) => nowDate(env, "daymonth", "d"),
  settime: (_a, env) => nowDate(env, "settime", "H:i:s"),
  // Links.
  pageurl: (a, env) => pageUrl(env, a),
  pageobject: (a, env) => {
    const found = objectUrl(env.ctx, Number(a[0]), a[1] ?? "", a[2] ?? "");
    if ("problem" in found) {
      report(env.ctx, "link.unresolved", "warn", `{pageobject=${a.join("=")}}: ${found.problem}.`, {
        token: `pageobject=${a.join("=")}`,
      });
      return drop(found.problem);
    }
    return litV(found.url);
  },
  taxonomytermsurl: (_a, env) => termProperty(env, "{taxonomytermsurl}", "url"),
  archiveurl: (_a, env) => {
    const type = subjectPost(env.ctx)?.type ?? env.ctx.entryType;
    const url = type === undefined ? undefined : extrasOf(env.ctx).urlForArchive?.(type);
    return url === undefined
      ? drop("the archive of the post type has no address on the converted site")
      : litV(url);
  },
  postarchiveurl: (a, env) => HANDLERS.archiveurl!(a, env),
  // Archives and term loops.
  archivetitle: (_a, env) => archive(env, "title"),
  archivedescription: (_a, env) => archive(env, "description"),
  taxterms: (a, env) => termProperty(env, "{taxterms}", a[0]),
  termquery: (a, env) => termProperty(env, "{termquery}", a[0]),
  // Fields.
  acffield: (a, env) => acfField(env, a),
  acfrepeater: (a, env) => {
    const row = extrasOf(env.ctx).rowExpr;
    if (row === undefined)
      return drop("an ACF repeater value needs the row of the repeater loop it is in");
    return a[0] === undefined ? undefined : exprV(`${optPath(row, a[0])} ?? ''`);
  },
  acf_group_field: () => drop("a group sub-field read by group and field name is not carried over"),
  acfvideo: () => drop("an ACF video is the video converter's"),
  acfvideourl: () => drop("an ACF video is the video converter's"),
  acfgallery: () =>
    drop("an ACF gallery is a block's markup; the gallery converter builds it from the field"),
  tooltipacf: () => drop("a tooltip from an ACF field is not carried over"),
  // Images.
  image: (a, env) => imageToken(env, "{image}", a[0], "src"),
  attachment_url: (a, env) => imageToken(env, "{attachmenturl}", a[0], "src"),
  imagesrc: (a, env) => imageToken(env, "{imagesrc}", a[0], "src"),
  imagealt: (a, env) => imageToken(env, "{imagealt}", a[0], "alt"),
  imagewidth: (a, env) => imageToken(env, "{imagewidth}", a[0], "width"),
  imageheight: (a, env) => imageToken(env, "{imageheight}", a[0], "height"),
  imageset: () => litV(""),
  imagesizes: () => litV(""),
  featuredimage: (a, env) => featured(env, a[4], "featuredImage"),
  bgfeaturedimage: (_a, env) => featured(env, undefined, "background"),
  authorpicture: (_a, env) => HANDLERS.userpicture!([], env),
  bgauthorpicture: (_a, env) => HANDLERS.bguserpicture!([], env),
  // Structure.
  menu: (_a, env) => ({ raw: menuMarker(env) }),
  menuname: (_a, env) => {
    const label = attr(env, "menuAriaLabel");
    if (label !== undefined) return litV(label);
    const id = Number(attr(env, "menuSelected"));
    const term = Number.isInteger(id) ? env.ctx.model.terms.get(id) : undefined;
    return litV(term ? decodeEntities(term.name) : "");
  },
  nav_menu: (a) => ({ raw: `<${MENU_TAG} data-menu="${escapeHtml(a[0] ?? "")}"></${MENU_TAG}>` }),
  postcontent: () => ({ raw: `<${POST_CONTENT_TAG}></${POST_CONTENT_TAG}>` }),
  component: (a, env) => componentToken(env, a),
  tab_state: (_a, env) => litV(env.attrs.tabContentActiveN ? "cc-tab-active" : "cc-tab-hidden"),
  tab_content_state: (_a, env) =>
    litV(env.attrs.tabContentActiveN ? "cc-tab-content-active" : "cc-tab-content-hidden"),
  svginline: (_a, env) => {
    const svg =
      typeof env.attrs.inlineSvg === "string"
        ? /<svg[^>]*>([\s\S]*?)<\/svg>/i.exec(env.attrs.inlineSvg)
        : null;
    return svg ? litV((svg[1] ?? "").trim(), true) : litV("");
  },
  viewbox: (a, env) => {
    const svg =
      a[0] === "inline" && typeof env.attrs.inlineSvg === "string"
        ? /viewBox="([^"]*)"/i.exec(env.attrs.inlineSvg)
        : null;
    return svg ? litV(svg[1] ?? "") : drop("the viewBox of an attachment's SVG needs the file");
  },
  svg: () => drop("an attachment's SVG needs the file"),
};

/** Aliases the plugin accepts for the same token. */
const ALIASES: Readonly<Record<string, string>> = {
  post_title: "title",
  page_title: "pagetitle",
  post_excerpt: "postexcerpt",
  post_date: "postdate",
  post_time: "time",
  post_type: "posttype",
  post_parent_id: "postparentid",
  post_tags: "posttags",
  post_category: "postcategory",
  site_title: "sitetitle",
  site_tagline: "sitetagline",
  site_option: "siteoption",
  author_name: "authorname",
  author_info: "authorinfo",
  author_custom_field: "authorcustomfield",
  user_custom_field: "usercustomfield",
  custom_field: "customfield",
  current_date: "currentdate",
  custom_current_date: "customcurrentdate",
  day_week: "dayweek",
  day_month: "daymonth",
  user_id: "userid",
  archive_title: "archivetitle",
  archive_description: "archivedescription",
  page_url: "pageurl",
  acf_field: "acffield",
  acf_repeater: "acfrepeater",
  attachmenturl: "attachment_url",
  attachment_url: "attachment_url",
  user_avatar: "userpicture",
  author_avatar: "authorpicture",
  customcurrentdate: "customcurrentdate",
};

/** `{siteurl}` and `{homeurl}`: the address of the site, which on the converted site is the root. */
function originToken(env: Env, origin: string): Outcome {
  const rewritten = env.ctx.rewriteUrl(origin.replace(/\/$/, ""));
  // A path that follows the token (`{homeurl}/about/`) supplies the slash itself.
  return litV(env.next === "/" && rewritten === "/" ? "" : rewritten);
}

function menuMarker(env: Env): string {
  const id = attr(env, "menuSelected");
  const label = id !== undefined && /^\d+$/.test(id) ? ` data-menu="${id}"` : "";
  return `<${MENU_TAG}${label}></${MENU_TAG}>`;
}

/** `{image}`, `{imagealt}`, `{imagewidth}`… by attachment id. */
function imageToken(
  env: Env,
  token: string,
  ref: string | undefined,
  part: "src" | "alt" | "width" | "height",
): Outcome {
  if (ref === "attachment" || ref === "woogallery")
    return drop("the image of an attachment page or a product gallery is not carried over");
  const got = mediaOf(env, ref, token);
  if ("problem" in got) return drop(got.problem);
  const v = got.media[part];
  return litV(v === undefined ? "" : String(v));
}

/** `{featuredimage}` and `{bgfeaturedimage}`: the post's thumbnail, or the block's fallback image. */
function featured(
  env: Env,
  fallbackArg: string | undefined,
  kind: "featuredImage" | "background",
): Outcome {
  const { ctx } = env;
  const fallback = fallbackImageSrc(
    ctx,
    env.attrs,
    kind === "background"
      ? { id: "backgroundDynamicStaticFallbackID", url: "backgroundDynamicStaticFallbackURL" }
      : { id: "dynamicStaticFallbackID", url: "dynamicStaticFallbackURL" },
    fallbackArg,
  );
  const r = currentRef(ctx, "featuredImage");
  if (!r) return fallback === undefined ? noCurrentPost(env, "{featuredimage}") : litV(fallback);
  const image = refProp(r, "src");
  const text = textOfRef(image);
  return orElse(text, fallback === undefined ? undefined : litV(fallback)) ?? litV("");
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────────

/** One token as `cc_parser`'s expression finds it: `{body}` (`brace`) or `<ccd>body</ccd>` (`ccd`). */
interface Found {
  index: number;
  whole: string;
  brace?: string;
  ccd?: string;
}

const LINE_BREAK = /[\n\r\u2028\u2029]/g;

/**
 * Every token of a text, the matches of `(?!\{\})\{(?!"|&quot;)(.*?)\}|<ccd>(.*?)<\/ccd>` (`cc_parser`'s
 * expression), in order. A body never spans a line. The expression rescans the rest of the line for every
 * `{` that has no closing brace, which makes a minified script with thousands of them quadratic; this
 * reads each line once, because a `{` with no `}` after it on its line means no later `{` of that line
 * has one either.
 */
function scanTokens(text: string): Found[] {
  const found: Found[] = [];
  const n = text.length;
  // The first line break at or after `breakFrom`, kept for every later query it still answers.
  let breakFrom = n + 1;
  let breakAt = -1;
  const nextBreak = (from: number): number => {
    if (from >= breakFrom && (breakAt === -1 || breakAt >= from)) return breakAt;
    LINE_BREAK.lastIndex = from;
    const m = LINE_BREAK.exec(text);
    breakFrom = from;
    breakAt = m ? m.index : -1;
    return breakAt;
  };
  let braceFrom = 0;
  let ccdFrom = 0;
  let i = 0;
  while (i < n) {
    const brace = text.indexOf("{", Math.max(i, braceFrom));
    const ccd = text.indexOf("<ccd>", Math.max(i, ccdFrom));
    if (brace < 0 && ccd < 0) break;
    if (ccd < 0 || (brace >= 0 && brace < ccd)) {
      const j = brace;
      i = j + 1;
      if (text.startsWith("{}", j) || text[j + 1] === '"' || text.startsWith("&quot;", j + 1))
        continue;
      const close = text.indexOf("}", j + 1);
      const lb = nextBreak(j + 1);
      if (close >= 0 && (lb < 0 || close < lb)) {
        found.push({ index: j, whole: text.slice(j, close + 1), brace: text.slice(j + 1, close) });
        i = close + 1;
      } else {
        braceFrom = lb < 0 ? n : lb;
      }
    } else {
      const j = ccd;
      i = j + 1;
      const close = text.indexOf("</ccd>", j + 5);
      const lb = nextBreak(j + 5);
      if (close >= 0 && (lb < 0 || close < lb)) {
        found.push({ index: j, whole: text.slice(j, close + 6), ccd: text.slice(j + 5, close) });
        i = close + 6;
      } else {
        ccdFrom = lb < 0 ? n : lb;
      }
    }
  }
  return found;
}

/** A token's name and arguments the way `cc_parser` splits them: on `=`, unless the `=` is the first character. */
export function parseToken(body: string): { name: string; args: string[] } {
  const args = body.indexOf("=") > 0 ? body.split("=") : [];
  const name = args.length > 0 ? (args.shift() as string) : body;
  return { name, args };
}

/** Every token in a text, as written, for the tests and for census. */
export function findTokens(text: string): { token: string; name: string; args: string[] }[] {
  const out: { token: string; name: string; args: string[] }[] = [];
  for (const m of scanTokens(text)) {
    const body = m.brace ?? m.ccd ?? "";
    if (body === "") continue;
    out.push({ token: m.whole, ...parseToken(body) });
  }
  return out;
}

/** Whether a token name is one the plugin's table knows. */
export function isKnownToken(name: string): boolean {
  const canonical = ALIASES[name] ?? name;
  return (
    canonical in HANDLERS ||
    CLASS_TOKENS.has(name) ||
    BOOKKEEPING.has(name) ||
    name in UNSUPPORTED ||
    WOO.has(name)
  );
}

/**
 * The resolver: every token in `text` replaced, literal values and placeholders in one string. `markup`
 * says the text is HTML. The result is in the intermediate form {@link finishBindings} and
 * {@link finishNodes} complete.
 */
export function resolveMarked(
  text: string,
  ctx: ConvertCtx,
  block: WpBlock | undefined,
  markup: boolean,
  trace?: { html: boolean },
): string {
  let source = text;
  if (HAS_BRACKET.test(source)) {
    reportBrackets(ctx);
    source = stripMarks(source);
  }
  const out = replaceTokens(source, ctx, block, markup, trace);
  return markup ? texturizeHtml(out) : out;
}

function replaceTokens(
  text: string,
  ctx: ConvertCtx,
  block: WpBlock | undefined,
  markup: boolean,
  trace?: { html: boolean },
): string {
  if (!text.includes("{") && !text.includes("<ccd>")) return text;
  const attrs = block?.attrs ?? {};
  let out = "";
  let at = 0;
  // Whether the text so far ends inside a tag, which makes a value an attribute's.
  let inTag = false;
  for (const m of scanTokens(text)) {
    const before = text.slice(at, m.index);
    const open = before.lastIndexOf("<");
    const close = before.lastIndexOf(">");
    if (open >= 0 || close >= 0) inTag = open > close;
    out += before;
    at = m.index + m.whole.length;
    out += replaceToken(m, text, ctx, block, attrs, markup, inTag, trace);
  }
  return out + text.slice(at);
}

/** What one token becomes: its value, its marker, nothing, or itself. */
function replaceToken(
  { whole, brace, ccd, index }: Found,
  text: string,
  ctx: ConvertCtx,
  block: WpBlock | undefined,
  attrs: Record<string, unknown>,
  markup: boolean,
  inTag: boolean,
  trace?: { html: boolean },
): string {
  const body = brace ?? ccd ?? "";
  if (body === "") return "";
  const { name, args } = parseToken(body);
  const env: Env = {
    trace,
    ctx,
    block,
    attrs,
    markup,
    next: text.charAt(index + whole.length),
  };
  if (CLASS_TOKENS.has(name)) return whole;
  if (BOOKKEEPING.has(name)) return "";
  const canonical = ALIASES[name] ?? name;
  const handler = HANDLERS[canonical];
  let outcome: Outcome;
  if (handler) {
    outcome = handler(args, env);
  } else if (name in UNSUPPORTED) {
    outcome = drop(UNSUPPORTED[name] as string);
  } else if (WOO.has(name)) {
    outcome = drop("WooCommerce is not carried over");
  } else {
    if (/^[A-Za-z][\w-]*$/.test(name)) {
      report(
        ctx,
        "token.unknown",
        "info",
        `The token {${body}} is not one Cwicly knows; it is left as written.`,
        { token: whole },
      );
    }
    return whole;
  }
  const result = outcome ?? drop("the token has no value here");
  if (result === undefined) return "";
  if ("keep" in result) return whole;
  if ("raw" in result) {
    if (trace) trace.html = true;
    return result.raw;
  }
  if ("drop" in result) {
    report(
      ctx,
      "token.unresolved",
      "warn",
      `The token ${whole} has no value on the converted site: ${result.drop}. It prints nothing.`,
      { token: whole, reason: result.drop },
    );
    return "";
  }
  if (trace && result.html) trace.html = true;
  if ("lit" in result && HAS_BRACKET.test(result.lit)) reportBrackets(ctx);
  return emitVal(result, markup, inTag);
}
