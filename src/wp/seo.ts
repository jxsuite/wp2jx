/**
 * Rank Math SEO → what the live page prints in its head: the `<title>`, the meta description, the robots
 * meta, the canonical, the Open Graph and Twitter tags.
 *
 * The rules are Rank Math's own (the plugin's `Paper`, `Replacer` and `OpenGraph` classes), read from its
 * source, because the answer is not stored anywhere: a post's title is its `rank_math_title` meta when it
 * has one and otherwise the site-wide template for its type (`rank-math-options-titles`, `pt_<type>_title`),
 * and both are run through the variable replacer (`%title% %sep% %sitename%`). A description is the meta, else
 * the excerpt, else the type's template, which is `%excerpt%` by default, which is the first paragraph of
 * the post's content when the post has no excerpt. Producing that text is where most of the code is: it
 * runs the content through the ports of WordPress's `wpautop` and `wp_kses` the plugin runs it through.
 * The ports are pinned against PHP's own answers in the tests.
 *
 * Text is worked on as WordPress works on it, as stored (entity-encoded where WordPress stores it so),
 * and decoded once at the end, which is what `esc_html` and the browser do together. What comes out is
 * plain text, ready for an attribute or a text node.
 */
import { createHash } from "node:crypto";
import type { Report, WpAttachment, WpModel, WpPost, WpTerm } from "../types.ts";
import {
  loadAcf,
  siteClock,
  zoneClock,
  type AcfModel,
  type EntryImage,
  type SiteClock,
} from "./acf.ts";
import { decodeEntities, termsOf } from "./model.ts";
import { maybeUnserialize } from "./phpser.ts";

// ── Public types ─────────────────────────────────────────────────────────────────────────────────

export type SeoTarget =
  | { kind: "post"; post: WpPost }
  | { kind: "term"; term: WpTerm }
  /** The front page: the static page when the site has one, else the latest-posts index. */
  | { kind: "home" }
  /** The page that lists the posts (`page_for_posts`). */
  | { kind: "posts-page" }
  /** The archive of a custom post type (`/projects/`). */
  | { kind: "archive"; postType: string };

export interface SeoImage {
  /** The attachment, when the image is in the media library. */
  id?: number;
  /** The address the live page prints: the size Rank Math picks (full, else large, else medium_large). */
  url: string;
  width?: number;
  height?: number;
  alt?: string;
  /** The mime type (`image/webp`). */
  type?: string;
}

export interface Seo {
  /** The `<title>`, as text. */
  title: string;
  /** The meta description; empty when the page prints none. */
  description: string;
  /** What the robots meta says (`follow, index, max-snippet:-1, …`); empty when the page prints none. */
  robots: string;
  /**
   * The canonical a person set (`rank_math_canonical_url`), or the object's own address when the caller
   * says what that is (`SeoOptions.permalink`). Rank Math prints no canonical on a noindex page.
   */
  canonical?: string;
  /** The og:image. */
  image?: SeoImage;
  openGraph: {
    type: string;
    locale: string;
    title: string;
    description: string;
    siteName: string;
    url?: string;
    image?: SeoImage;
  };
  twitter: {
    card: string;
    title: string;
    description: string;
    /** `@handle` of the site, when Rank Math has one. */
    site?: string;
    image?: SeoImage;
  };
}

export interface SeoOptions {
  report?: Report;
  /**
   * The address of an object on the source site, for the canonical and og:url. Rank Math's default
   * canonical is the object's own permalink, which this module does not compute (the routes module does).
   */
  permalink?: (target: SeoTarget) => string | undefined;
  /** The current time, for `%currentyear%` and its kin. Default: now. */
  now?: Date;
}

/** A value for a template variable, or a function of the argument in `%name(argument)%`. */
export type RankMathVars = Readonly<
  Record<
    string,
    string | number | null | undefined | ((arg: string) => string | number | null | undefined)
  >
>;

// ── PHP ports ────────────────────────────────────────────────────────────────────────────────────

/** PCRE's `\s` (without /u) is ASCII only; JS's also takes no-break and Unicode spaces (and the byte order mark). */
const S = "[ \\t\\n\\x0B\\f\\r]";

/** What `\s` means to PCRE under /u, which is Unicode's White_Space: JS's `\s` adds the byte order mark and lacks U+0085. */
const US =
  "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/** What C's `isspace()` (which `strip_tags` uses) calls whitespace. */
const isSpace = (c: string | undefined): boolean => c !== undefined && " \t\n\r\v\f".includes(c);

/** PHP's `trim()`: ASCII whitespace and NUL, never a no-break space. */
function phpTrim(s: string, chars = " \t\n\r\0\x0B"): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start]!)) start++;
  while (end > start && chars.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

/** PHP's `stripslashes()`. */
const stripSlashes = (s: string): string =>
  s.replace(/\\(.?)/gs, (_m, c: string) => (c === "0" ? "\0" : c));

/**
 * PHP's `strip_tags()` with no tag allowed, as `php_strip_tags_ex` runs it (PHP 8.3): five states. Text
 * (0) is kept. After a `<` that is not followed by whitespace a tag (1) runs to the first `>` outside
 * quotes and outside nested `<…>`; `<?` (2) is a processing instruction that ends at `?>` outside
 * parentheses and quotes, `<!` (3) ends at the first `>` (nothing nests inside it), and `<!--` (4) at `-->`.
 * A `<` that ends the input opens a tag, so it goes with the rest.
 */
function stripTags(input: string): string {
  let out = "";
  let state = 0;
  let depth = 0;
  let quote = "";
  let lc = "";
  let br = 0;
  let xml = false;
  /** A quote opens a quoted run, and the same quote closes it. */
  const toggle = (c: string): void => {
    if (quote === "") quote = c;
    else if (quote === c) quote = "";
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const prev = input.charAt(i - 1);
    if (c === "\0") continue;
    if (state === 0) {
      if (c === "<" && !isSpace(input[i + 1])) {
        lc = "<";
        state = 1;
      } else if (c === ">" && depth > 0) depth--;
      else out += c;
    } else if (state === 1) {
      if (c === "<") {
        if (quote === "" && !isSpace(input[i + 1])) depth++;
      } else if (c === ">") {
        if (depth > 0) depth--;
        else if (quote === "" && !(xml && prev === "-")) {
          state = 0;
          xml = false;
        }
      } else if (c === '"' || c === "'") toggle(c);
      else if (c === "!" && prev === "<") state = 3;
      else if (c === "?" && prev === "<") {
        br = 0;
        state = 2;
      }
    } else if (state === 2) {
      if (c === "(" || c === ")") {
        if (lc !== '"' && lc !== "'") {
          lc = c;
          br += c === "(" ? 1 : -1;
        }
      } else if (c === ">") {
        if (depth > 0) depth--;
        else if (quote === "" && br === 0 && lc !== '"' && prev === "?") state = 0;
      } else if (c === '"' || c === "'") {
        if (prev !== "\\") {
          if (lc === c) lc = "";
          else if (lc !== "\\") lc = c;
          toggle(c);
        }
      } else if (
        (c === "l" || c === "L") &&
        i > 4 &&
        input.slice(i - 4, i).toLowerCase() === "<?xm"
      ) {
        // `<?xml` is not PHP: PHP drops back to an ordinary tag (for a `<?xml` that does not open the string).
        state = 1;
        xml = true;
      }
    } else if (state === 3) {
      if (c === ">") {
        if (depth > 0) depth--;
        else if (quote === "") state = 0;
      } else if (c === '"' || c === "'") {
        if (prev !== "\\") toggle(c);
      } else if (c === "-" && input.startsWith("!--", i - 2)) state = 4;
      else if ((c === "e" || c === "E") && input.slice(i - 6, i).toLowerCase() === "doctyp")
        state = 1;
    } else if (c === ">" && quote === "" && input.startsWith("--", i - 2)) {
      state = 0;
    }
  }
  return out;
}

/** WordPress's `wp_strip_all_tags()`. */
function stripAllTags(text: string, removeBreaks = false): string {
  let t = text.replace(/<(script|style)[^>]*?>.*?<\/\1>/gis, "");
  t = stripTags(t);
  if (removeBreaks) t = t.replace(/[\r\n\t ]+/g, " ");
  return phpTrim(t);
}

/** Rank Math's `Helper::strip_shortcodes()`: every `[…]` goes, and a caption takes its content with it. */
function stripShortcodes(content: string): string {
  if (!content.includes("[")) return content;
  const noCaptions = content.replace(
    new RegExp(`${S}*\\[caption[^\\]]*\\].*?\\[\\/caption\\]${S}*`, "gis"),
    "",
  );
  return noCaptions.replace(/\[\/?.*?\]/gs, "");
}

/** `wp_html_split()`: the text and the tags of a string, alternating, text first (as `preg_split` with a captured delimiter). */
function htmlSplit(input: string): string[] {
  const out: string[] = [];
  let at = 0;
  let from = 0;
  for (;;) {
    const lt = input.indexOf("<", from);
    if (lt === -1) break;
    let end: number;
    if (input.startsWith("<!--", lt)) {
      // The comment may end on the opener's own dashes: `<!-->` is a whole comment.
      const close = input.indexOf("-->", lt + 2);
      end = close === -1 ? input.length : close + 3;
    } else if (input.startsWith("<![CDATA[", lt)) {
      const close = input.indexOf("]]>", lt + 9);
      end = close === -1 ? input.length : close + 3;
    } else {
      const gt = input.indexOf(">", lt + 1);
      end = gt === -1 ? input.length : gt + 1;
    }
    out.push(input.slice(at, lt), input.slice(lt, end));
    at = end;
    from = end;
  }
  out.push(input.slice(at));
  return out;
}

/** WordPress's `wp_replace_in_html_tags()` for one needle: replaces inside tags only. */
function replaceInHtmlTags(haystack: string, needle: string, replacement: string): string {
  const parts = htmlSplit(haystack);
  let changed = false;
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i]!.includes(needle)) {
      parts[i] = parts[i]!.replaceAll(needle, replacement);
      changed = true;
    }
  }
  return changed ? parts.join("") : haystack;
}

const ALL_BLOCKS =
  "(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary)";

/** WordPress's `wpautop()`: blank lines become paragraphs and line breaks `<br />`, except around block elements. */
function wpautop(input: string, br = true): string {
  if (phpTrim(input) === "") return "";
  let text = `${input}\n`;
  const preTags = new Map<string, string>();

  // Pre tags are not touched: they are swapped for placeholders and brought back at the end.
  if (text.includes("<pre")) {
    const parts = text.split("</pre>");
    const last = parts.pop()!;
    text = "";
    let i = 0;
    for (const part of parts) {
      const start = part.indexOf("<pre");
      if (start === -1) {
        text += part;
        continue;
      }
      const name = `<pre wp-pre-tag-${i}></pre>`;
      preTags.set(name, `${part.slice(start)}</pre>`);
      text += part.slice(0, start) + name;
      i++;
    }
    text += last;
  }

  text = text.replace(new RegExp(`<br${S}*\\/?>${S}*<br${S}*\\/?>`, "g"), "\n\n");
  text = text.replace(new RegExp(`(<${ALL_BLOCKS}[ \\t\\n\\x0B\\f\\r/>])`, "g"), "\n\n$1");
  text = text.replace(new RegExp(`(<\\/${ALL_BLOCKS}>)`, "g"), "$1\n\n");
  text = text.replace(new RegExp(`(<hr${S}*?\\/?>)`, "g"), "$1\n\n");
  text = text.replace(/\r\n|\r/g, "\n");
  text = replaceInHtmlTags(text, "\n", " <!-- wpnl --> ");

  if (text.includes("<option")) {
    text = text.replace(new RegExp(`${S}*<option`, "g"), "<option");
    text = text.replace(new RegExp(`<\\/option>${S}*`, "g"), "</option>");
  }
  if (text.includes("</object>")) {
    text = text.replace(new RegExp(`(<object[^>]*>)${S}*`, "g"), "$1");
    text = text.replace(new RegExp(`${S}*<\\/object>`, "g"), "</object>");
    text = text.replace(new RegExp(`${S}*(<\\/?(?:param|embed)[^>]*>)${S}*`, "g"), "$1");
  }
  if (text.includes("<source") || text.includes("<track")) {
    text = text.replace(new RegExp(`([<\\[](?:audio|video)[^>\\]]*[>\\]])${S}*`, "g"), "$1");
    text = text.replace(new RegExp(`${S}*([<\\[]\\/(?:audio|video)[>\\]])`, "g"), "$1");
    text = text.replace(new RegExp(`${S}*(<(?:source|track)[^>]*>)${S}*`, "g"), "$1");
  }
  if (text.includes("<figcaption")) {
    text = text.replace(new RegExp(`${S}*(<figcaption[^>]*>)`, "g"), "$1");
    text = text.replace(new RegExp(`<\\/figcaption>${S}*`, "g"), "</figcaption>");
  }

  text = text.replace(/\n\n+/g, "\n\n");
  const paragraphs = text.split(new RegExp(`\\n${S}*\\n`)).filter((p) => p !== "");
  text = paragraphs.map((p) => `<p>${phpTrim(p, "\n")}</p>\n`).join("");

  text = text.replace(new RegExp(`<p>${S}*<\\/p>`, "g"), "");
  text = text.replace(/<p>([^<]+)<\/(div|address|form)>/g, "<p>$1</p></$2>");
  text = text.replace(new RegExp(`<p>${S}*(<\\/?${ALL_BLOCKS}[^>]*>)${S}*<\\/p>`, "g"), "$1");
  text = text.replace(/<p>(<li.+?)<\/p>/g, "$1");
  text = text.replace(/<p><blockquote([^>]*)>/gi, "<blockquote$1><p>");
  text = text.replaceAll("</blockquote></p>", "</p></blockquote>");
  text = text.replace(new RegExp(`<p>${S}*(<\\/?${ALL_BLOCKS}[^>]*>)`, "g"), "$1");
  text = text.replace(new RegExp(`(<\\/?${ALL_BLOCKS}[^>]*>)${S}*<\\/p>`, "g"), "$1");

  if (br) {
    text = text.replace(/<(script|style|svg|math).*?<\/\1>/gs, (m) =>
      m.replaceAll("\n", "<WPPreserveNewline />"),
    );
    text = text.replaceAll("<br>", "<br />").replaceAll("<br/>", "<br />");
    text = text.replace(new RegExp(`(?<!<br />)${S}*\\n`, "g"), "<br />\n");
    text = text.replaceAll("<WPPreserveNewline />", "\n");
  }

  text = text.replace(new RegExp(`(<\\/?${ALL_BLOCKS}[^>]*>)${S}*<br />`, "g"), "$1");
  text = text.replace(
    new RegExp(`<br />(${S}*<\\/?(?:p|li|div|dl|dd|dt|th|pre|td|ul|ol)[^>]*>)`, "g"),
    "$1",
  );
  text = text.replace(/\n<\/p>(?=\n?$)/, "</p>");

  for (const [name, original] of preTags) text = text.replace(name, () => original);
  if (text.includes("<!-- wpnl -->"))
    text = text.replaceAll(" <!-- wpnl --> ", "\n").replaceAll("<!-- wpnl -->", "\n");
  return text;
}

/** The entity names `wp_kses` lets through (`$allowedentitynames`); any other `&name;` is escaped. */
const KSES_ENTITIES = new Set(
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn acute micro para middot cedil ordm raquo iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml quot amp lt gt apos OElig oelig Scaron scaron Yuml circ tilde ensp emsp thinsp zwnj zwj lrm rlm ndash mdash lsquo rsquo sbquo ldquo rdquo bdquo dagger Dagger permil lsaquo rsaquo euro fnof Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega thetasym upsih piv bull hellip prime Prime oline frasl weierp image real trade alefsym larr uarr rarr darr harr crarr lArr uArr rArr dArr hArr forall part exist empty nabla isin notin ni prod sum minus lowast radic prop infin ang and or cap cup int sim cong asymp ne equiv le ge sub sup nsub sube supe oplus otimes perp sdot lceil rceil lfloor rfloor lang rang loz spades clubs hearts diams sup1 sup2 sup3 frac14 frac12 frac34 there4".split(
    " ",
  ),
);

const validUnicode = (i: number): boolean =>
  i === 0x9 ||
  i === 0xa ||
  i === 0xd ||
  (i >= 0x20 && i <= 0xd7ff) ||
  (i >= 0xe000 && i <= 0xfffd) ||
  (i >= 0x10000 && i <= 0x10ffff);

/** `wp_kses_normalize_entities()`: every `&` is disarmed, then the references that are valid are restored. */
function ksesEntities(content: string): string {
  let c = content.replaceAll("&", "&amp;");
  c = c.replace(/&amp;#(0*[1-9][0-9]{0,6});/g, (_m, digits: string) =>
    validUnicode(Number.parseInt(digits, 10))
      ? `&#${digits.replace(/^0+/, "").padStart(3, "0")};`
      : `&amp;#${digits};`,
  );
  c = c.replace(/&amp;#[Xx](0*[1-9A-Fa-f][0-9A-Fa-f]{0,5});/g, (_m, hex: string) =>
    validUnicode(Number.parseInt(hex, 16)) ? `&#x${hex.replace(/^0+/, "")};` : `&amp;#x${hex};`,
  );
  return c.replace(/&amp;([A-Za-z]{2,8}[0-9]{0,2});/g, (_m, name: string) =>
    KSES_ENTITIES.has(name) ? `&${name};` : `&amp;${name};`,
  );
}

/** PCRE's `$` without the multiline flag: the end, or just before a last newline. */
const END = "(?=\\n?(?![\\s\\S]))";

const KSES_TOKEN = new RegExp(
  `((<!--[^\\n]*?(-->|${END}))|<\\/[^a-zA-Z][^>]*>|<![^>]*>)|(<[^>]*(>|${END})|>)`,
  "g",
);

/**
 * `wp_kses( $content, [ 'p' => [] ] )`, the only call Rank Math makes on content: a `<p>` stays (with no
 * attribute), a `</p>` stays, and every other tag, with whatever sits inside a `<…` that never closes, goes.
 */
function ksesParagraphs(content: string): string {
  // oxlint-disable-next-line no-control-regex -- wp_kses_no_null() removes exactly these control characters
  const prepared = ksesEntities(content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ""));
  return prepared.replace(KSES_TOKEN, (token) => ksesToken(token));
}

/**
 * `while ( ( $newstring = wp_kses( $content ) ) != $content )`: what is inside a comment or a `<!…>` is
 * filtered until the filter changes nothing more. For a few inputs (`<p><!--></<i></p>`) WordPress never gets
 * there and the page never finishes; a bound keeps the converter from following it.
 */
function ksesFixedPoint(content: string): string {
  let inner = content;
  for (let round = 0; round < 64; round++) {
    const next = ksesParagraphs(inner);
    if (next === inner) break;
    inner = next;
  }
  return inner;
}

function ksesToken(raw: string): string {
  const content = raw.replace(/\\"/g, '"');
  if (!content.startsWith("<")) return "&gt;";
  if (/^(?:<\/[^a-zA-Z][^>]*>|<![a-z][^>]*>)$/.test(content)) {
    const opener = content[1]!;
    return `<${opener}${ksesFixedPoint(content.slice(2, -1))}>`;
  }
  if (content.startsWith("<!--")) {
    const inner = ksesFixedPoint(content.replaceAll("<!--", "").replaceAll("-->", ""));
    if (inner === "") return "";
    return `<!--${inner.replace(/--+/g, "-").replace(/-$/, "")}-->`;
  }
  const m = new RegExp(`^<${S}*(\\/${S}*)?([a-zA-Z0-9-]+)([^>]*)>?$`).exec(content);
  if (!m) return "";
  if (m[2]!.toLowerCase() !== "p") return "";
  if (phpTrim(m[1] ?? "") !== "") return `</${m[2]}>`;
  return `<${m[2]}${new RegExp(`${S}*\\/${S}*$`).test(m[3]!) ? " /" : ""}>`;
}

/**
 * `preg_replace('/&[^;\s]{0,6}$/', '', $text)`: the leftmost `&` that is followed by at most six BYTES (the
 * pattern has no `u` flag, so "ñandú" is seven) of anything but `;` and ASCII whitespace (`\s` is ASCII only
 * here too: a byte order mark or no-break space counts as part of a half entity) goes, with the rest.
 */
function withoutHalfEntity(text: string): string {
  for (let at = text.indexOf("&"); at !== -1; at = text.indexOf("&", at + 1)) {
    const rest = text.slice(at + 1);
    if (Buffer.byteLength(rest) <= 6 && !/[; \t\n\v\f\r]/.test(rest)) return text.slice(0, at);
  }
  return text;
}

/** Rank Math's `Str::truncate()`: at most `length` characters, cut at the last space, never inside an entity. */
function truncate(input: string, length = 110): string {
  const str = stripAllTags(input, true);
  const chars = Array.from(str);
  let excerpt = chars.slice(0, length).join("");
  excerpt = withoutHalfEntity(excerpt);
  if (str !== excerpt) {
    const trimmed = Array.from(phpTrim(excerpt));
    const at = trimmed.lastIndexOf(" ");
    excerpt = at === -1 ? "" : chars.slice(0, at).join("");
  }
  return excerpt;
}

/**
 * Rank Math's `Str::mb_ucwords()`: the first letter of every word, and only an ASCII one. The plugin tests
 * `$word[0]`, which is the first byte, so a word that starts with a multibyte letter ("élan") is left as it is.
 */
function ucwords(value: string): string {
  return value
    .split(new RegExp(`([${US}]+)`, "u"))
    .map((word) => {
      if (word === "" || new RegExp(`^[${US}]+$`, "u").test(word)) return word;
      if (Number.isFinite(Number(word))) return word;
      return /^[A-Za-z]/.test(word) ? word[0]!.toUpperCase() + word.slice(1) : word;
    })
    .join("");
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface Wall {
  /** A date whose UTC fields are the wall clock of the zone. */
  date: Date;
  /** The UTC instant in ms. */
  utcMs: number;
  /** The zone's name, as WordPress holds it (`America/New_York`), or `UTC`. */
  zone: string;
  /** Seconds the wall clock is ahead of UTC (a zone's local mean time before the 1900s has seconds in it). */
  offset: number;
}

/** Locales whose short zone names are the ones tzdata uses: the US ones, then Britain, Australia, New Zealand, India, South Africa, Canada, Ireland. */
const ABBREVIATION_LOCALES = [
  "en-US",
  "en-GB",
  "en-AU",
  "en-NZ",
  "en-IN",
  "en-ZA",
  "en-CA",
  "en-IE",
];

/** What tzdata prints for a zone with no letters of its own: the hours, and the minutes when there are any (`+05`, `+0530`). */
function numericAbbreviation(offsetSeconds: number): string {
  const minutes = Math.trunc(Math.abs(offsetSeconds) / 60);
  return `${offsetSeconds < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}${minutes % 60 === 0 ? "" : String(minutes % 60).padStart(2, "0")}`;
}

/**
 * PHP's `T`: tzdata's abbreviation of the zone (`EST`, `BST`, `+04`). The runtime has no tzdata, only
 * localised names, so the abbreviation is the first of several English locales that gives letters; the
 * zones none of them names (about one in ten of the zones that have letters in tzdata: `Asia/Tokyo`,
 * `Asia/Shanghai`, `Europe/Moscow`) print as their offset instead.
 */
function zoneAbbreviation(zone: string, utcMs: number, offset: number): string {
  if (zone === "UTC") return "UTC";
  if (!zone.startsWith("+") && !zone.startsWith("-")) {
    for (const locale of ABBREVIATION_LOCALES) {
      const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" })
        .formatToParts(utcMs)
        .find((p) => p.type === "timeZoneName");
      if (part && /^[A-Z]+$/.test(part.value)) return part.value;
    }
  }
  // PHP's own name for a zone that is only an offset: `GMT+0530`.
  if (zone.startsWith("+") || zone.startsWith("-")) return `GMT${zone.replace(":", "")}`;
  return numericAbbreviation(offset);
}

/**
 * PHP's `I`: whether the zone is on daylight saving time at the instant. The runtime has no such flag,
 * so it is read from the offsets: a zone whose offset differs between 1 January and 1 July is on
 * daylight time while it is on the larger one (Ireland's "negative" daylight time, with the smaller
 * offset in winter, is the one exception).
 */
function isDaylightSaving(wall: Wall): boolean {
  const clock = zoneClock(wall.zone);
  const year = new Date(wall.utcMs).getUTCFullYear();
  const january = clock.toLocal(Date.UTC(year, 0, 1)) - Date.UTC(year, 0, 1);
  const july = clock.toLocal(Date.UTC(year, 6, 1)) - Date.UTC(year, 6, 1);
  if (january === july) return false;
  const now = wall.offset * 1000;
  return wall.zone === "Europe/Dublin"
    ? now === Math.min(january, july)
    : now === Math.max(january, july);
}

/** Midnight UTC of a day, with `Date.UTC`'s habit of reading the years 0 to 99 as 1900 to 1999 left out. */
function utcDay(year: number, month: number, day: number): number {
  const t = new Date(0);
  t.setUTCFullYear(year, month, day);
  return t.getTime();
}

/** PHP's `x` and `X`: the year as `Y` prints it, with a sign when it needs one (`X`: always for years after 0). */
function expandedYear(year: number, always: boolean): string {
  const digits = String(Math.abs(year)).padStart(4, "0");
  return year < 0 ? `-${digits}` : always || year > 9999 ? `+${digits}` : digits;
}

/** PHP's `date()` for the format characters that appear in WordPress's date formats. */
function phpDate(format: string, wall: Wall): string {
  const d = wall.date;
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const dow = d.getUTCDay();
  const hours = d.getUTCHours();
  const dayOfYear = Math.round((utcDay(year, month, day) - utcDay(year, 0, 1)) / 86_400_000);
  const isoDow = dow === 0 ? 7 : dow;
  // ISO-8601 week: the week of the Thursday of this week.
  const thursday = new Date(utcDay(year, month, day + 4 - isoDow));
  const isoYear = thursday.getUTCFullYear();
  const isoWeek =
    Math.floor(
      (utcDay(isoYear, thursday.getUTCMonth(), thursday.getUTCDate()) - utcDay(isoYear, 0, 1)) /
        86_400_000 /
        7,
    ) + 1;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const offsetText = (colon: boolean): string => {
    const minutes = Math.trunc(Math.abs(wall.offset) / 60);
    return `${wall.offset < 0 ? "-" : "+"}${pad2(Math.floor(minutes / 60))}${colon ? ":" : ""}${pad2(minutes % 60)}`;
  };
  // `Y` writes a sign and four digits; `c` and `r` write `%04d`, in which the sign is one of the four.
  const longYear = (y: number): string =>
    y < 0 ? `-${String(-y).padStart(4, "0")}` : String(y).padStart(4, "0");
  const dateYear = (y: number): string =>
    y < 0 ? `-${String(-y).padStart(3, "0")}` : String(y).padStart(4, "0");
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const c = format[i]!;
    switch (c) {
      case "d":
        out += pad2(day);
        break;
      case "D":
        out += DAYS[dow]!.slice(0, 3);
        break;
      case "j":
        out += String(day);
        break;
      case "l":
        out += DAYS[dow]!;
        break;
      case "N":
        out += String(isoDow);
        break;
      case "S":
        out +=
          day % 10 === 1 && day !== 11
            ? "st"
            : day % 10 === 2 && day !== 12
              ? "nd"
              : day % 10 === 3 && day !== 13
                ? "rd"
                : "th";
        break;
      case "w":
        out += String(dow);
        break;
      case "z":
        out += String(dayOfYear);
        break;
      case "W":
        out += pad2(isoWeek);
        break;
      case "F":
        out += MONTHS[month]!;
        break;
      case "m":
        out += pad2(month + 1);
        break;
      case "M":
        out += MONTHS[month]!.slice(0, 3);
        break;
      case "n":
        out += String(month + 1);
        break;
      case "t":
        out += String(new Date(utcDay(year, month + 1, 0)).getUTCDate());
        break;
      case "L":
        out += leap ? "1" : "0";
        break;
      case "o":
        out += String(isoYear);
        break;
      case "Y":
        out += longYear(year);
        break;
      case "x":
      case "X":
        out += expandedYear(year, c === "X");
        break;
      case "y":
        out += pad2(year % 100);
        break;
      case "a":
        out += hours < 12 ? "am" : "pm";
        break;
      case "A":
        out += hours < 12 ? "AM" : "PM";
        break;
      case "B":
        out += String(
          Math.floor(
            ((((wall.utcMs + 3_600_000) % 86_400_000) + 86_400_000) % 86_400_000) / 86_400,
          ),
        ).padStart(3, "0");
        break;
      case "g":
        out += String(hours % 12 === 0 ? 12 : hours % 12);
        break;
      case "G":
        out += String(hours);
        break;
      case "h":
        out += pad2(hours % 12 === 0 ? 12 : hours % 12);
        break;
      case "H":
        out += pad2(hours);
        break;
      case "i":
        out += pad2(d.getUTCMinutes());
        break;
      case "s":
        out += pad2(d.getUTCSeconds());
        break;
      case "u":
        out += `${String(d.getUTCMilliseconds()).padStart(3, "0")}000`;
        break;
      case "v":
        out += String(d.getUTCMilliseconds()).padStart(3, "0");
        break;
      case "e":
        out += wall.zone;
        break;
      case "I":
        out += isDaylightSaving(wall) ? "1" : "0";
        break;
      case "O":
        out += offsetText(false);
        break;
      case "P":
        out += offsetText(true);
        break;
      case "p":
        out +=
          wall.zone === "UTC" || (wall.zone.startsWith("+") && wall.offset === 0)
            ? "Z"
            : offsetText(true);
        break;
      case "T":
        out += zoneAbbreviation(wall.zone, wall.utcMs, wall.offset);
        break;
      case "Z":
        out += String(wall.offset);
        break;
      case "c":
        out += `${dateYear(year)}${phpDate("-m-d\\TH:i:sP", wall)}`;
        break;
      case "r":
        out += `${phpDate("D, d M ", wall)}${dateYear(year)}${phpDate(" H:i:s O", wall)}`;
        break;
      case "U":
        out += String(Math.floor(wall.utcMs / 1000));
        break;
      case "\\":
        i++;
        // A backslash that ends the format escapes the C string's terminator, which PHP prints.
        out += i < format.length ? format[i]! : "\0";
        break;
      default:
        out += c;
    }
  }
  return out;
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

/** Rank Math's `Settings::normalize_it()`: `on`/`true` and `off`/`false` become booleans, `"0"`/`"1"` numbers, recursively. */
function normalizeSetting(value: unknown): unknown {
  if (value === "true" || value === "on") return true;
  if (value === "false" || value === "off") return false;
  if (value === "0") return 0;
  if (value === "1") return 1;
  if (Array.isArray(value)) return value.map(normalizeSetting);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeSetting(v)]));
  }
  return value;
}

interface Settings {
  titles: Record<string, unknown>;
}

const settingsCache = new WeakMap<WpModel, Settings>();
const acfCache = new WeakMap<WpModel, AcfModel>();
const filed = new WeakMap<object, Set<string>>();

function loadSettings(model: WpModel): Settings {
  const cached = settingsCache.get(model);
  if (cached) return cached;
  const read = (name: string): Record<string, unknown> => {
    const raw = model.options.get(name);
    const parsed = raw === undefined ? undefined : maybeUnserialize(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (normalizeSetting(parsed) as Record<string, unknown>)
      : {};
  };
  // `rank-math-options-general` is not read: nothing in it changes what a page prints in its head.
  const settings = { titles: read("rank-math-options-titles") };
  settingsCache.set(model, settings);
  return settings;
}

/** Rank Math is active but its options are not in the model: its templates are then guesses, and the report says so, once. */
function checkSettings(model: WpModel, settings: Settings, report: Report | undefined): void {
  if (!report || Object.keys(settings.titles).length > 0) return;
  const active = model.site.activePlugins.some((p) => p.startsWith("seo-by-rank-math"));
  if (active && once(report, "seo.settings-missing")) {
    report.add({
      severity: "warn",
      code: "seo.settings-missing",
      message:
        "Rank Math is active but the rank-math-options-titles option is not in the model, so the site-wide title and description templates are unknown and Rank Math's own defaults stand in.",
      where: "option:rank-math-options-titles",
    });
  }
}

function once(owner: object, key: string): boolean {
  let set = filed.get(owner);
  if (!set) filed.set(owner, (set = new Set()));
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

const setting = (s: Settings, id: string): unknown => s.titles[id];

/** The text of a setting, or `fallback` when the key is not there (a key that holds an empty string is there). */
const settingOr = (s: Settings, id: string, fallback: string): string => {
  const value = s.titles[id];
  return value === undefined || value === null ? fallback : text(value);
};

/** PHP truthiness of a normalised setting. */
function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === "" || v === 0 || v === "0")
    return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** PHP's string of a setting: `true` (an `on` switch) is "1", `false` is "". Lists and maps are not text. */
const text = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : v === true ? "1" : "";

// ── Meta ─────────────────────────────────────────────────────────────────────────────────────────

/** A post's meta as WordPress's `get_post_meta( $id, $key, true )` has it: the first row. */
const postMeta = (model: WpModel, id: number, key: string): unknown =>
  model.postMeta.get(id)?.[key]?.[0];

/** The text of a meta value, or "" when there is none (an array or a number is not a title). */
const metaText = (v: unknown): string => (typeof v === "string" ? v : "");

const termMeta = (term: WpTerm, key: string): unknown =>
  Object.hasOwn(term.meta, key) ? term.meta[key] : undefined;

// ── Template variables ───────────────────────────────────────────────────────────────────────────

/** The variables Rank Math registers (`rank_math()->variables`), so an unknown name can be told from one with no value here. */
const KNOWN_VARIABLES = new Set([
  "sep",
  "search_query",
  "count",
  "filename",
  "sitename",
  "sitedesc",
  "currentdate",
  "currentday",
  "currentmonth",
  "currentyear",
  "currenttime",
  "org_name",
  "org_logo",
  "org_url",
  "title",
  "parent_title",
  "excerpt",
  "excerpt_only",
  "seo_title",
  "seo_description",
  "url",
  "post_thumbnail",
  "date",
  "modified",
  "category",
  "categories",
  "primary_taxonomy_terms",
  "tag",
  "tags",
  "term",
  "term_description",
  "customterm",
  "customterm_desc",
  "userid",
  "name",
  "post_author",
  "user_description",
  "id",
  "focuskw",
  "keywords",
  "customfield",
  "page",
  "pagenumber",
  "pagetotal",
  "pt_single",
  "pt_plural",
]);

/** Variables that read the clock: the live site fills them in per request, a migrated page cannot. */
const CLOCK_VARIABLES = new Set([
  "currentdate",
  "currentday",
  "currentmonth",
  "currentyear",
  "currenttime",
]);

interface TemplateOptions {
  report?: Report | undefined;
  where?: string | undefined;
  url?: string | undefined;
}

/**
 * Rank Math's `Replacer::replace()`: `%variable%` and `%variable(argument)%` in a template become their
 * values. `vars` holds the values (or, for a variable that takes an argument, a function of it). A name
 * Rank Math does not know is replaced by nothing, as Rank Math does, and reported as `seo.unknown-variable`;
 * a known name with no value here is replaced by nothing silently, as Rank Math does for a variable
 * that has none in its context (`%term%` on a post). Tags in the template are stripped first, a trailing
 * ` %sep%` loses its separator (and, as in the plugin, keeps the space before it), repeated separators
 * collapse, and runs of whitespace become one space.
 */
export function renderRankMathTemplate(
  template: string,
  vars: RankMathVars,
  opts: TemplateOptions = {},
): string {
  let variable = stripAllTags(template);
  if (!variable.includes("%")) return variable;
  if (variable.endsWith(" %sep%")) variable = variable.slice(0, -5);

  const replacements = new Map<string, string>();
  for (const match of variable.matchAll(
    new RegExp(`%(([a-z0-9_-]+)\\(([^)]*)\\)|[^${US}]+)%`, "giu"),
  )) {
    const [whole, id, name, arg] = match as unknown as [
      string,
      string,
      string | undefined,
      string | undefined,
    ];
    const hasArgs = name !== undefined && name !== "" && arg !== undefined && arg !== "";
    const key = hasArgs ? name! : id;
    const entry = Object.hasOwn(vars, key)
      ? vars[key]
      : Object.hasOwn(vars, `${key}_args`) && hasArgs
        ? vars[`${key}_args`]
        : undefined;
    const known =
      KNOWN_VARIABLES.has(key) ||
      Object.hasOwn(vars, key) ||
      (hasArgs && Object.hasOwn(vars, `${key}_args`));
    if (!known) {
      if (opts.report) {
        opts.report.add({
          severity: "warn",
          code: "seo.unknown-variable",
          message: `The SEO template uses %${key}%, which Rank Math does not know (a variable another plugin registered, or a typo); it prints nothing.`,
          ...(opts.where === undefined ? {} : { where: opts.where }),
          ...(opts.url === undefined ? {} : { url: opts.url }),
          data: { variable: key, template },
        });
      }
      replacements.set(whole, "");
      continue;
    }
    if (
      CLOCK_VARIABLES.has(key) &&
      opts.report &&
      opts.where !== undefined &&
      once(opts.report, `seo.dynamic-variable|${opts.where}|${key}`)
    ) {
      opts.report.add({
        severity: "info",
        code: "seo.dynamic-variable",
        message: `The SEO template uses %${key}%, which the live site fills in for the moment of each request; the migrated value is the one of the migration.`,
        where: opts.where,
        ...(opts.url === undefined ? {} : { url: opts.url }),
        data: { variable: key },
      });
    }
    const value = typeof entry === "function" ? entry(hasArgs ? arg! : "") : entry;
    replacements.set(whole, value === null || value === undefined ? "" : String(value));
  }
  // str_replace with arrays applies the pairs one after the other, each to the result of the last.
  // (A function replacer: a string one gives `$$`, `$&`, `$'` and `` $` `` in a value a meaning PHP's does not have.)
  for (const [from, to] of replacements) variable = variable.replaceAll(from, () => to);

  const sep = vars.sep;
  const sepText = typeof sep === "string" ? sep : "";
  if (replacements.has("%sep%") && sepText !== "") {
    const quoted = sepText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    variable = variable.replace(new RegExp(`${quoted}(?:[${US}]*${quoted})*`, "gu"), () => sepText);
  }
  return variable.replace(new RegExp(`${S}${S}+`, "g"), " ");
}

// ── Building the page's SEO ──────────────────────────────────────────────────────────────────────

interface Ctx {
  model: WpModel;
  settings: Settings;
  opts: SeoOptions;
  report: Report | undefined;
  clock: SiteClock;
  acf: AcfModel;
  post?: WpPost;
  term?: WpTerm;
  /** The post type of an archive page. */
  archive?: string;
  where: string;
  url: string | undefined;
}

const SEP_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function wallOf(clock: SiteClock, zone: string, iso: string): Wall | undefined {
  const utcMs = Date.parse(iso);
  if (Number.isNaN(utcMs)) return undefined;
  const local = clock.toLocal(utcMs);
  return { date: new Date(local), utcMs, zone, offset: Math.round((local - utcMs) / 1000) };
}

/** The zone WordPress works in (`wp_timezone_string()`): the named zone when the runtime knows it, else the offset, else UTC. */
function zoneName(model: WpModel): string {
  const zone = (model.options.get("timezone_string") ?? "").trim();
  if (zone !== "") {
    try {
      zoneClock(zone);
      return zone;
    } catch {
      // A zone the runtime does not know: the offset stands in, as it does in siteClock.
    }
  }
  const offset = Number((model.options.get("gmt_offset") ?? "").trim());
  if (!Number.isFinite(offset) || offset === 0) return "UTC";
  const minutes = Math.round(Math.abs(offset) * 60);
  return `${offset < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * The first paragraph of a post's content, or the one with its focus keyword: what `%excerpt%` says for
 * a post that has no excerpt (Rank Math's `Post_Variables::get_post_content()`).
 */
function excerptFromContent(content: string, focusKeywords: string): string {
  const stripped = stripShortcodes(content);
  if (stripped === "" || stripped === "0") return "";
  let c = stripped.replace(/<!--[\s\S]*?-->/giu, "");
  c = wpautop(stripShortcodes(c));
  c = ksesParagraphs(c);
  c = c.replace(new RegExp(`<p[^>]*>(${S}|&nbsp;)*<\\/p>`, "g"), "");
  if (focusKeywords !== "") {
    const primary = phpTrim(focusKeywords.split(",")[0]!);
    try {
      const re = new RegExp(
        `<p>(.*${primary.replaceAll(",", "|").replaceAll(" ", ".").replaceAll("/", "\\/")}.*)<\\/p>`,
        "giu",
      );
      const hit = [...c.matchAll(re)][0]?.[1];
      if (hit !== undefined) return hit;
    } catch {
      // A keyword that is not a valid pattern matches nothing, as in PHP (where it also warns).
    }
  }
  return [...c.matchAll(/<p>(.*)<\/p>/giu)][0]?.[1] ?? c;
}

/** The terms of a taxonomy a post has, in the order `get_the_terms` gives them: by name. */
function termsByName(model: WpModel, postId: number, taxonomy: string): WpTerm[] {
  // `ORDER BY t.name` runs under the column's collation, utf8mb4_unicode_ci: case and accents do not order, so
  // `apple` sorts before `Banana` and `Éclair` ties with `eclair` (the database then answers in its own order, here the id's).
  return termsOf(model, postId, taxonomy).sort(
    (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.termId - b.termId,
  );
}

function postTypeLabels(ctx: Ctx, type: string): { singular: string; plural: string } {
  const acf = ctx.acf.postTypes.get(type);
  if (acf) return { singular: acf.singular, plural: acf.plural };
  const core: Record<string, [string, string]> = {
    post: ["Post", "Posts"],
    page: ["Page", "Pages"],
    attachment: ["Media", "Media"],
  };
  const [singular, plural] = Object.hasOwn(core, type) ? core[type]! : [type, type];
  return { singular, plural };
}

/** The variables of one post, term or the blog index, as functions so nothing is worked out unless a template asks. */
function variablesFor(
  ctx: Ctx,
): Record<
  string,
  string | number | null | undefined | ((arg: string) => string | number | null | undefined)
> {
  const { model, settings, post, term } = ctx;
  const zone = zoneName(model);
  const dateFormat = text(model.options.get("date_format")) || "F j, Y";
  const timeFormat = text(model.options.get("time_format")) || "g:i a";
  const now = ctx.opts.now ?? new Date();
  const nowWall: Wall = (() => {
    const utcMs = now.getTime();
    const local = ctx.clock.toLocal(utcMs);
    return { date: new Date(local), utcMs, zone, offset: Math.round((local - utcMs) / 1000) };
  })();
  const postWall = (iso: string): Wall | undefined => wallOf(ctx.clock, zone, iso);

  const sepRaw = text(settings.titles.title_separator);
  // htmlentities( $sep, ENT_COMPAT, 'UTF-8', false ): a separator that already is an entity (`&raquo;`) stays one.
  const sep = sepRaw.replace(/&(?!#?[A-Za-z0-9]+;)|[<>"]/g, (c) => SEP_ESCAPES[c]!);
  const author = post ? model.users.get(post.authorId) : undefined;
  const focus = post
    ? metaText(postMeta(model, post.id, "rank_math_focus_keyword"))
    : term
      ? text(termMeta(term, "rank_math_focus_keyword"))
      : "";
  const termNames = (taxonomy: string, args: string, single: boolean): string => {
    if (!post) return "";
    const parsed = new URLSearchParams(args);
    const limit = Number(parsed.get("limit") ?? 99);
    const separator = parsed.get("separator") ?? ", ";
    const exclude = (parsed.get("exclude") ?? "").split(",").filter(Boolean).map(Number);
    const terms = termsByName(model, post.id, taxonomy)
      .slice(0, limit)
      .filter((t) => !exclude.includes(t.termId));
    if (terms.length === 0) return "";
    return single ? terms[0]!.name : terms.map((t) => t.name).join(separator);
  };
  const paragraphs = (): number =>
    post ? (post.content.match(/<!--nextpage-->/g)?.length ?? 0) + 1 : 1;

  const excerpt = (): string => {
    if (!post) return "";
    const own = stripShortcodes(post.excerpt);
    return own !== "" && own !== "0" ? stripAllTags(own) : excerptFromContent(post.content, focus);
  };

  return {
    sep,
    search_query: "",
    count: () => "1",
    filename: "",
    sitename: stripAllTags(model.site.name, true),
    sitedesc: stripAllTags(model.site.description),
    currentdate: () => phpDate(dateFormat, nowWall),
    currentday: () => phpDate("j", nowWall),
    currentmonth: () => phpDate("F", nowWall),
    currentyear: () => phpDate("Y", nowWall),
    currenttime: (format) => phpDate(format === "" ? timeFormat : format, nowWall),
    // `Settings::get( $id, $default )` answers the default only for a key that is absent: an empty name stays empty.
    org_name: settingOr(settings, "knowledgegraph_name", stripAllTags(model.site.name, true)),
    org_logo: text(settings.titles.knowledgegraph_logo),
    org_url: settingOr(settings, "url", model.site.home),
    title: () =>
      ctx.archive !== undefined
        ? postTypeLabels(ctx, ctx.archive).plural
        : post && post.title !== ""
          ? stripSlashes(post.title)
          : null,
    parent_title: () =>
      post && post.parent !== 0 ? (model.posts.get(post.parent)?.title ?? null) : null,
    excerpt,
    excerpt_only: () =>
      post && post.excerpt !== "" && !post.passwordProtected ? stripAllTags(post.excerpt) : null,
    seo_title: () => (post ? "" : null),
    seo_description: () => (post ? "" : null),
    url: () =>
      ctx.opts.permalink?.(
        post ? { kind: "post", post } : term ? { kind: "term", term } : { kind: "home" },
      ) ?? null,
    post_thumbnail: () => {
      const id = post ? Number(postMeta(model, post.id, "_thumbnail_id")) : 0;
      return id > 0 ? (model.attachments.get(id)?.url ?? "") : "";
    },
    date: (format) => {
      const wall = post ? postWall(post.date) : undefined;
      return wall ? phpDate(format === "" ? dateFormat : format, wall) : null;
    },
    modified: (format) => {
      if (!post) return null;
      const later = Date.parse(post.date) > Date.parse(post.modified) ? post.date : post.modified;
      const wall = postWall(later);
      return wall ? phpDate(format === "" ? dateFormat : format, wall) : null;
    },
    category: () => termNames("category", "", true) || null,
    categories: (args) => termNames("category", args, false) || null,
    primary_taxonomy_terms: () => {
      if (!post) return null;
      const main = text(setting(settings, `pt_${post.type}_primary_taxonomy`));
      return main ? termNames(main, "", false) || null : null;
    },
    tag: () => termNames("post_tag", "", true) || null,
    tags: (args) => termNames("post_tag", args, false) || null,
    term: () => (term ? term.name : null),
    term_description: () => (term && term.description !== "" ? term.description : null),
    customterm: (taxonomy) => (taxonomy === "" ? null : termNames(taxonomy, "", true) || null),
    customterm_desc: (taxonomy) => {
      if (!post || taxonomy === "") return null;
      return termsByName(model, post.id, taxonomy)[0]?.description || null;
    },
    userid: () => (post && post.authorId > 0 ? String(post.authorId) : null),
    name: () => (author && author.displayName !== "" ? author.displayName : null),
    post_author: () => (author && author.displayName !== "" ? author.displayName : null),
    user_description: () => null,
    id: () => (post ? String(post.id) : null),
    focuskw: () => focus.split(",")[0] || null,
    keywords: () => focus,
    customfield: (name) => {
      if (name === "") return null;
      if (term) {
        const v = termMeta(term, name);
        return typeof v === "string" || typeof v === "number" ? String(v) : "";
      }
      if (!post) return null;
      const v = postMeta(model, post.id, name);
      return typeof v === "string" || typeof v === "number" ? String(v) : "";
    },
    page: "",
    pagenumber: "1",
    pagetotal: () => String(paragraphs()),
    pt_single: () => {
      const t = post?.type ?? ctx.archive;
      return t === undefined ? null : postTypeLabels(ctx, t).singular;
    },
    pt_plural: () => {
      const t = post?.type ?? ctx.archive;
      return t === undefined ? null : postTypeLabels(ctx, t).plural;
    },
  };
}

/** `Helper::replace_vars()` through `Metadata::maybe_replace_vars()`: the stored `%seo_title%`/`%seo_description%` are the title and excerpt. */
function replaceVars(ctx: Ctx, template: string, vars: RankMathVars): string {
  const swapped = template
    .replaceAll("%seo_title%", "%title%")
    .replaceAll("%seo_description%", "%excerpt%");
  return renderRankMathTemplate(swapped, vars, {
    report: ctx.report,
    where: ctx.where,
    url: ctx.url,
  });
}

/** `Paper::get_from_options()`: a template out of the titles options, rendered; `fallback` when it is empty. */
function fromOptions(ctx: Ctx, id: string, vars: RankMathVars, fallback = ""): string {
  // A key that is not there reads as false, which `str_replace` turns into "" before the comparison: like an empty one.
  const value = text(setting(ctx.settings, id));
  const template = value === "" ? fallback : value;
  return template === "" ? "" : replaceVars(ctx, template, vars);
}

// ── Robots ───────────────────────────────────────────────────────────────────────────────────────

/** An ordered PHP array of string keys. */
type Pairs = [string, string][];

const getKey = (pairs: Pairs, key: string): string | undefined =>
  pairs.find(([k]) => k === key)?.[1];

function setKey(pairs: Pairs, key: string, value: string): Pairs {
  const out = pairs.map(([k, v]): [string, string] => (k === key ? [k, value] : [k, v]));
  if (!pairs.some(([k]) => k === key)) out.push([key, value]);
  return out;
}

/** PHP's `[ key => value ] + $array`: the new pair first, and nothing of the array's own that has its key. */
const prepend = (pairs: Pairs, key: string, value: string): Pairs => [
  [key, value],
  ...pairs.filter(([k]) => k !== key),
];

/** Rank Math's `Paper::robots_combine()`. */
function robotsCombine(robots: unknown, withDefault = false): Pairs {
  if (!Array.isArray(robots) || robots.length === 0)
    return withDefault
      ? [
          ["index", "index"],
          ["follow", "follow"],
        ]
      : [];
  let pairs: Pairs = [];
  for (const r of robots) {
    const value = typeof r === "string" ? r : String(r);
    if (!pairs.some(([k]) => k === value)) pairs.push([value, value]);
  }
  const noindex = getKey(pairs, "noindex");
  if (noindex !== undefined)
    pairs = prepend(
      pairs.filter(([k]) => k !== "noindex"),
      "index",
      noindex,
    );
  const nofollow = getKey(pairs, "nofollow");
  if (nofollow !== undefined)
    pairs = prepend(
      pairs.filter(([k]) => k !== "nofollow"),
      "follow",
      nofollow,
    );
  return pairs;
}

/** Rank Math's `Paper::advanced_robots_combine()`: `null` for nothing, else the directives that are set. */
function advancedCombine(advanced: unknown): Pairs | null {
  if (!truthy(advanced)) return null;
  // `foreach` over a string only warns: what is left to combine is nothing, which is not the same as no answer.
  if (typeof advanced !== "object") return [];
  const out: Pairs = [];
  for (const [key, data] of Object.entries(advanced as Record<string, unknown>)) {
    if (truthy(data)) out.push([key, `${key}:${String(data)}`]);
  }
  return out;
}

interface PaperRobots {
  robots: Pairs;
  /** `undefined` (PHP's null): use the site-wide default; an array: use exactly that. */
  advanced: Pairs | null;
}

/** The robots meta as `Paper::get_robots()` prints it, from what the paper says (and the site-wide settings). */
function printRobots(ctx: Ctx, paper: PaperRobots): string {
  let robots =
    paper.robots.length > 0 ? paper.robots : robotsCombine(setting(ctx.settings, "robots_global"));
  // validate_robots(): only these directives, with an index and a follow always present.
  if (robots.length === 0) {
    robots = [
      ["index", "index"],
      ["follow", "follow"],
    ];
  } else {
    robots = robots.filter(([k]) =>
      ["index", "follow", "noarchive", "noimageindex", "nosnippet"].includes(k),
    );
    if (getKey(robots, "index") === undefined) robots = prepend(robots, "index", "index");
    if (getKey(robots, "follow") === undefined) robots = prepend(robots, "follow", "follow");
  }
  // respect_settings_for_robots(): a site that asks search engines to stay away says so everywhere.
  const blogPublic = ctx.model.options.get("blog_public");
  if (blogPublic !== undefined && Number(blogPublic) === 0) {
    robots = setKey(setKey(robots, "index", "noindex"), "follow", "nofollow");
  }
  // (`array_unique()` follows in the plugin; every value here is its own key's, so it changes nothing.)

  if (getKey(robots, "index") !== "noindex" && getKey(robots, "nosnippet") !== "nosnippet") {
    let advanced = paper.advanced;
    if (advanced === null) {
      const global = (setting(ctx.settings, "advanced_robots_global") ?? {}) as Record<
        string,
        unknown
      >;
      advanced = advancedCombine({
        "max-snippet": -1,
        "max-video-preview": -1,
        "max-image-preview": "large",
        ...global,
      })!;
    }
    const wanted = ["max-snippet", "max-video-preview", "max-image-preview"];
    // (`$robots + $advanced`: the keys never meet, the directives of one are the other's `max-*`.)
    robots = [...robots, ...advanced.filter(([k]) => wanted.includes(k))];
  }
  return robots.map(([, v]) => v).join(", ");
}

// ── Images ───────────────────────────────────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set(["jpeg", "jpg", "gif", "png", "webp", "avif"]);

/**
 * The address of an attachment's file. The guid shows where the uploads folder is (a media host, a CDN), but it names the
 * file the attachment was made from, and the attached file can be another (`-scaled`, `-e1719665859529`): so the host and
 * folder come from the guid, when the guid sits in the file's own folder, and the name from the attached file.
 */
function attachmentUrl(model: WpModel, att: WpAttachment): string {
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(att.file)) return att.file;
  const slash = att.file.lastIndexOf("/");
  const folder = att.file.slice(0, slash + 1);
  const guid = /^https?:\/\/[^/?#]+\/(?:[^?#]*\/)?(?=[^/?#]*(?:[?#]|$))/i.exec(att.url)?.[0];
  if (guid !== undefined && guid.endsWith(`/${folder}`))
    return `${guid}${att.file.slice(slash + 1)}`;
  return `${model.site.url}/wp-content/uploads/${att.file}`;
}

/**
 * Rank Math's `Image::get_variations()`: the full size, else `large`, else `medium_large`, whichever is the first to be
 * between 200 and 2000 pixels each way, as WordPress's `wp_get_attachment_image_src()` answers it.
 */
function imageFor(model: WpModel, id: number): SeoImage | undefined {
  const att = model.attachments.get(id);
  if (!att || !att.mime.startsWith("image/")) return undefined;
  const base = attachmentUrl(model, att);
  const usable = (w: number | undefined, h: number | undefined): boolean =>
    w !== undefined && h !== undefined && w >= 200 && w <= 2000 && h >= 200 && h <= 2000;
  const opt = (name: string, fallback: number): number => {
    const n = Number(model.options.get(name));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const candidates: { url: string; width: number | undefined; height: number | undefined }[] = [
    { url: base, width: att.width, height: att.height },
  ];
  for (const [name, w, h] of [
    ["large", opt("large_size_w", 1024), opt("large_size_h", 1024)],
    ["medium_large", opt("medium_large_size_w", 768), 0],
  ] as const) {
    const size = att.sizes.find((s) => s.name === name);
    if (size) {
      const slash = base.lastIndexOf("/");
      candidates.push({
        url: `${base.slice(0, slash + 1)}${size.file}`,
        width: size.width,
        height: size.height,
      });
    } else if (att.width !== undefined && att.height !== undefined) {
      // No such size: the full file, with dimensions scaled to fit the size's limits (`image_constrain_size_for_editor`).
      const maxW = w;
      const maxH = h === 0 ? 9999 : h;
      const ratio = Math.min(1, maxW / att.width, maxH / att.height);
      candidates.push({
        url: base,
        width: Math.round(att.width * ratio),
        height: Math.round(att.height * ratio),
      });
    }
  }
  const ext = (url: string): string =>
    (/\.([a-z0-9]+)(?:\?.*)?$/i.exec(url)?.[1] ?? "").toLowerCase();
  const pick = candidates.find((c) => usable(c.width, c.height));
  if (!pick || !IMAGE_EXTENSIONS.has(ext(pick.url))) return undefined;
  return {
    id,
    url: pick.url.split("?")[0]!,
    ...(pick.width === undefined ? {} : { width: pick.width }),
    ...(pick.height === undefined ? {} : { height: pick.height }),
    ...(att.alt === "" ? {} : { alt: att.alt }),
    type: att.mime,
  };
}

/** The attachment a meta row names, as an image; an id that is not in the model is reported. */
function metaImage(ctx: Ctx, value: unknown, label: string): SeoImage | undefined {
  const id = typeof value === "string" || typeof value === "number" ? Number(value) : 0;
  if (!(id > 0)) return undefined;
  const image = imageFor(ctx.model, id);
  if (!image && !ctx.model.attachments.has(id) && ctx.report) {
    ctx.report.add({
      severity: "warn",
      code: "seo.image-unresolved",
      message: `The ${label} points at attachment ${id}, which is not in the model; the page's image falls back to the next choice.`,
      where: ctx.where,
      ...(ctx.url === undefined ? {} : { url: ctx.url }),
      data: { attachment: id },
    });
  }
  return image;
}

/** `Attachment::get_by_url()`: the attachment whose file an address names (a resized copy names its original), or 0. */
function attachmentByUrl(model: WpModel, address: string): number {
  const url = address.split("?")[0]!.replace(/(.*)-\d+x\d+\.(jpg|png|gif)$/, "$1.$2");
  let host = "";
  let path = url;
  try {
    const parsed = new URL(url, model.site.home);
    host = parsed.host;
    path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  } catch {
    return 0;
  }
  const relative = path.replace(/^(?:.*?\/)?wp-content\/uploads\//, "");
  for (const att of model.attachments.values()) {
    if (att.url === url || att.file === relative) return att.id;
  }
  // A media host (a CDN or bucket) names the file at its root: the attachment's own address is on that host.
  for (const att of model.attachments.values()) {
    try {
      if (new URL(att.url).host === host && att.file === path) return att.id;
    } catch {
      // A guid that is not an address names no host.
    }
  }
  return 0;
}

const isExternal = (model: WpModel, address: string): boolean => {
  try {
    return new URL(address, model.site.home).host !== new URL(model.site.home).host;
  } catch {
    return false;
  }
};

/** The image Rank Math falls back to when a page has no social image and no featured image: the first usable `<img>` of its content. */
function contentImage(ctx: Ctx, post: WpPost): SeoImage | undefined {
  const { model } = ctx;
  const content = post.content;
  if (content === "" || !content.includes("<img")) return undefined;
  // Rank Math remembers what it found, keyed by the content's md5, and trusts that while the content is unchanged.
  const cache = postMeta(model, post.id, "rank_math_og_content_image");
  let found: (number | string)[] | undefined;
  if (cache !== null && typeof cache === "object" && !Array.isArray(cache)) {
    const c = cache as { check?: unknown; images?: unknown };
    if (c.check === createHash("md5").update(content).digest("hex") && Array.isArray(c.images)) {
      found = c.images.filter(
        (x): x is number | string => typeof x === "number" || typeof x === "string",
      );
    }
  }
  if (found === undefined) {
    found = [];
    const srcs = new Set<string>();
    for (const m of content.matchAll(/<img [^>]+>/gu)) {
      const src = /src=(["'])(.*?)\1/u.exec(m[0])?.[2];
      if (src) srcs.add(src);
    }
    for (const src of srcs) {
      if (isExternal(model, src)) found.push(src);
      else {
        const id = attachmentByUrl(model, src);
        found.push(id > 0 ? id : src);
      }
    }
  }
  for (const entry of found) {
    if (typeof entry === "number") {
      const image = imageFor(model, entry);
      if (image) return image;
    } else {
      // An address that is not a media-library file is used as it is, when it names an image.
      const clean = entry.split("?")[0]!;
      const ext = (/\.([a-z0-9]+)$/i.exec(clean)?.[1] ?? "").toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      try {
        return { url: new URL(clean, model.site.home).href };
      } catch {
        // An address that is not one (`http://[x.jpg`) is no image.
      }
    }
  }
  return undefined;
}

// ── Titles, descriptions ─────────────────────────────────────────────────────────────────────────

/** WordPress's `smilies_init()` table: what each text smiley is shown as (an emoji, or for `:mrgreen:` an image of the site's own). */
const SMILIES: Readonly<Record<string, string>> = {
  ":mrgreen:": "mrgreen.png",
  ":neutral:": "\u{1F610}",
  ":twisted:": "\u{1F608}",
  ":arrow:": "\u27A1",
  ":shock:": "\u{1F62F}",
  ":smile:": "\u{1F642}",
  ":???:": "\u{1F615}",
  ":cool:": "\u{1F60E}",
  ":evil:": "\u{1F47F}",
  ":grin:": "\u{1F600}",
  ":idea:": "\u{1F4A1}",
  ":oops:": "\u{1F633}",
  ":razz:": "\u{1F61B}",
  ":roll:": "\u{1F644}",
  ":wink:": "\u{1F609}",
  ":cry:": "\u{1F625}",
  ":eek:": "\u{1F62E}",
  ":lol:": "\u{1F606}",
  ":mad:": "\u{1F621}",
  ":sad:": "\u{1F641}",
  "8-)": "\u{1F60E}",
  "8-O": "\u{1F62F}",
  ":-(": "\u{1F641}",
  ":-)": "\u{1F642}",
  ":-?": "\u{1F615}",
  ":-D": "\u{1F600}",
  ":-P": "\u{1F61B}",
  ":-o": "\u{1F62E}",
  ":-x": "\u{1F621}",
  ":-|": "\u{1F610}",
  ";-)": "\u{1F609}",
  "8O": "\u{1F62F}",
  ":(": "\u{1F641}",
  ":)": "\u{1F642}",
  ":?": "\u{1F615}",
  ":D": "\u{1F600}",
  ":P": "\u{1F61B}",
  ":o": "\u{1F62E}",
  ":x": "\u{1F621}",
  ":|": "\u{1F610}",
  ";)": "\u{1F609}",
  ":!:": "\u2757",
  ":?:": "\u2753",
};

/** The pattern `smilies_init()` builds: longest keys first (a reverse key sort), each only between spaces or at an end. */
const SMILIES_PATTERN: RegExp = (() => {
  const spaces = "[\\r\\n\\t \\u00A0]";
  const quote = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  const keys = Object.keys(SMILIES).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const groups: string[] = [];
  let first = "";
  for (const key of keys) {
    const c = key[0]!;
    if (c !== first) {
      first = c;
      groups.push(`${quote(c)}(?:${quote(key.slice(1))}`);
    } else groups[groups.length - 1] += `|${quote(key.slice(1))}`;
  }
  return new RegExp(groups.map((g) => `(?<=${spaces}|^)${g})(?=${spaces}|$)`).join("|"), "g");
})();

/**
 * `convert_smilies()` over a title's text. Rank Math runs it on the escaped title, where no tag survives, so the whole
 * string is text; the pattern is worked out on the decoded text instead, which differs only for a no-break space written
 * as `&nbsp;`, and that decodes to the character the pattern also accepts as a space.
 */
function convertSmilies(siteUrl: string, text: string): string {
  return text.replace(SMILIES_PATTERN, (match) => {
    const shown = SMILIES[match.trim()]!;
    if (!/\.(?:jpe?g|jpe|gif|png|webp|avif)$/i.test(shown)) return shown;
    return `<img src="${siteUrl}/wp-includes/images/smilies/${shown}" alt="${match.trim()}" class="wp-smiley" style="height: 1em; max-height: 1em;" />`;
  });
}

// ── wptexturize ──────────────────────────────────────────────────────────────────────────────────

/** `wp_spaces_regexp()`: PCRE works on bytes there, so the no-break space is its two bytes; here it is its one character. */
const TX_SPACES = "[\\r\\n\\t \\u00A0]|&nbsp;";
const TX_OPEN_Q = "<!--oq-->";
const TX_OPEN_SQ = "<!--osq-->";
const TX_APOS = "<!--apos-->";
const TX_NO_TEXTURIZE = ["pre", "code", "kbd", "style", "script", "tt"];

const TX_STATIC: readonly (readonly [string, string])[] = [
  ["...", "&#8230;"],
  ["``", "&#8220;"],
  ["''", "&#8221;"],
  [" (tm)", " &#8482;"],
  ...["tain't", "twere", "twas", "tis", "twill", "til", "bout", "nuff", "round", "cause", "em"].map(
    (w): [string, string] => [`'${w}`, `&#8217;${w.replace("'", "&#8217;")}`],
  ),
];

const tx = (source: string, replacement: string): [RegExp, string] => [
  new RegExp(source, "g"),
  replacement,
];
// (`\Z` is `$` here: a trailing line feed is one of the spaces every such pattern also allows.)
const TX_APOSTROPHES: readonly [RegExp, string][] = [
  tx(`'(\\d\\d)'(?=$|[.,:;!?)}\\-\\]]|&gt;|${TX_SPACES})`, `${TX_APOS}$1&#8217;`),
  tx(`'(\\d\\d)"(?=$|[.,:;!?)}\\-\\]]|&gt;|${TX_SPACES})`, `${TX_APOS}$1&#8221;`),
  tx(`'(?=\\d\\d(?:$|(?![%\\d]|[.,]\\d)))`, TX_APOS),
  tx(`(?<=^|${TX_SPACES})'(\\d[.,\\d]*)'`, `${TX_OPEN_SQ}$1&#8217;`),
  tx(`(?<=^|[([{"\\-]|&lt;|${TX_SPACES})'`, TX_OPEN_SQ),
  tx(`(?<!${TX_SPACES})'(?!$|[.,:;!?"'(){}[\\]\\-]|&[lg]t;|${TX_SPACES})`, TX_APOS),
];
const TX_QUOTES: readonly [RegExp, string][] = [
  tx(`(?<=^|${TX_SPACES})"(\\d[.,\\d]*)"`, `${TX_OPEN_Q}$1&#8221;`),
  tx(`(?<=^|[([{\\-]|&lt;|${TX_SPACES})"(?!${TX_SPACES})`, TX_OPEN_Q),
];
const TX_DASHES: readonly [RegExp, string][] = [
  tx("---", "&#8212;"),
  tx(`(?<=^|${TX_SPACES})--(?=$|${TX_SPACES})`, "&#8212;"),
  tx("(?<!xn)--", "&#8211;"),
  tx(`(?<=^|${TX_SPACES})-(?=$|${TX_SPACES})`, "&#8211;"),
];
// An HTML comment, else an element up to its `>`: the pieces `wptexturize()` leaves alone.
const TX_SPLIT = /(<(?:(?=!--)!(?:-(?!->)[^-]*)*(?:-->)?|(?!!--)[^>]*>?))/;
const TX_AMPERSAND = /&(?!#(?:\d+|x[a-f0-9]+);|[a-z1-4]{1,8};)/gi;

const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** `wptexturize_primes()`: is `7'.` seven feet or a closing quote? */
function texturizePrimes(
  haystack: string,
  needle: string,
  prime: string,
  openQuote: string,
  closeQuote: string,
): string {
  const flag = "<!--wp-prime-or-quote-->";
  const quotePattern = new RegExp(`${needle}(?=$|[.,:;!?)}\\-\\]]|&gt;|${TX_SPACES})`, "g");
  const primePattern = new RegExp(`(?<=\\d)${needle}`, "g");
  const flagAfterDigit = new RegExp(`(?<=\\d)${flag}`, "g");
  const flagNoDigit = new RegExp(`(?<!\\d)${flag}`, "g");
  const sentences = haystack.split(openQuote);
  for (const [key, original] of sentences.entries()) {
    let sentence = original;
    if (!sentence.includes(needle)) continue;
    if (key !== 0 && countOf(sentence, closeQuote) === 0) {
      let count = 0;
      sentence = sentence.replace(quotePattern, () => {
        count++;
        return flag;
      });
      if (count > 1) {
        // Several closing quotes: those after no digit are quotes; failing that, the rightmost is.
        let none = 0;
        sentence = sentence.replace(flagNoDigit, () => {
          none++;
          return closeQuote;
        });
        if (none === 0) {
          const pos = sentence.includes(`${flag}.`)
            ? sentence.lastIndexOf(`${flag}.`)
            : sentence.lastIndexOf(flag);
          sentence = sentence.slice(0, pos) + closeQuote + sentence.slice(pos + flag.length);
        }
        sentence = sentence.replace(primePattern, () => prime);
        sentence = sentence.replace(flagAfterDigit, () => prime);
        sentence = sentence.replaceAll(flag, () => closeQuote);
      } else if (count === 1) {
        sentence = sentence.replaceAll(flag, () => closeQuote);
        sentence = sentence.replace(primePattern, () => prime);
      } else {
        sentence = sentence.replace(primePattern, () => prime);
      }
    } else {
      sentence = sentence.replace(primePattern, () => prime);
      sentence = sentence.replace(quotePattern, () => closeQuote);
    }
    if (needle === '"' && sentence.includes('"'))
      sentence = sentence.replaceAll('"', () => closeQuote);
    sentences[key] = sentence;
  }
  return sentences.join(openQuote);
}

/** `_wptexturize_pushpop_element()`: tracks the open elements texturizing is switched off inside. */
function texturizePushPop(element: string, stack: string[]): void {
  let opening: boolean;
  let nameOffset: number;
  if (element.length > 1 && element[1] !== "/") {
    opening = true;
    nameOffset = 1;
  } else if (stack.length === 0) return;
  else {
    opening = false;
    nameOffset = 2;
  }
  const space = element.indexOf(" ");
  const tag =
    space === -1
      ? element.slice(nameOffset, element.length - 1)
      : element.slice(nameOffset, nameOffset + Math.max(0, space - nameOffset));
  if (!TX_NO_TEXTURIZE.includes(tag)) return;
  if (opening) stack.push(tag);
  else if (stack[stack.length - 1] === tag) stack.pop();
}

/**
 * WordPress's `wptexturize()` as it runs on a title in an English site: straight quotes and apostrophes become curly
 * ones, ` - ` an en dash, `...` an ellipsis, `9x9` a times sign, each as a numeric character reference. A site whose
 * language translates the quote characters texturizes differently; shortcodes are not known here, so none is skipped.
 */
function wptexturize(text: string): string {
  if (text === "" || text === "0") return text;
  const stack: string[] = [];
  const pieces = text.split(TX_SPLIT).filter((p) => p !== "");
  for (const [i, piece] of pieces.entries()) {
    let curl = piece;
    if (curl[0] === "<") {
      if (curl.startsWith("<!--")) continue;
      curl = curl.replace(TX_AMPERSAND, "&#038;");
      texturizePushPop(curl, stack);
    } else if (phpTrim(curl) === "") continue;
    else if (stack.length === 0) {
      for (const [from, to] of TX_STATIC) curl = curl.replaceAll(from, () => to);
      if (curl.includes("'")) {
        for (const [pattern, to] of TX_APOSTROPHES) curl = curl.replace(pattern, to);
        curl = texturizePrimes(curl, "'", "&#8242;", TX_OPEN_SQ, "&#8217;");
        curl = curl.replaceAll(TX_APOS, "&#8217;").replaceAll(TX_OPEN_SQ, "&#8216;");
      }
      if (curl.includes('"')) {
        for (const [pattern, to] of TX_QUOTES) curl = curl.replace(pattern, to);
        curl = texturizePrimes(curl, '"', "&#8243;", TX_OPEN_Q, "&#8221;");
        curl = curl.replaceAll(TX_OPEN_Q, "&#8220;");
      }
      if (curl.includes("-"))
        for (const [pattern, to] of TX_DASHES) curl = curl.replace(pattern, to);
      // 9x9 (times), but never 0x9999.
      if (/(?<=\d)x\d/.test(curl)) {
        curl = curl.replace(/\b(\d(?:(?<=0)[\d.,]+|(?<!0)[\d.,]*))x(\d[\d.,]*)\b/g, "$1&#215;$2");
      }
      curl = curl.replace(TX_AMPERSAND, "&#038;");
    }
    pieces[i] = curl;
  }
  return pieces.join("");
}

/**
 * What `get_the_title()` makes of a stored title: the `the_title` filters, which are `wptexturize`, `convert_chars`,
 * `trim` and the title form of `capital_P_dangit`. (The "Protected:" and "Private:" prefixes belong to pages that are
 * not public and are not added.) The result is still entity-encoded, as WordPress prints it.
 */
function theTitle(stored: string): string {
  const converted = wptexturize(stored).replace(/&([^#])(?![a-z1-4]{1,8};)/gi, "&#038;$1");
  return phpTrim(converted).replaceAll("Wordpress", "WordPress");
}

/** `Paper::get_title()` after the title is chosen: whitespace, capitals, tags, and the escape the browser undoes. */
function finishTitle(ctx: Ctx, raw: string): string {
  let t = raw.replace(new RegExp(`${S}${S}+`, "g"), " ");
  if (truthy(setting(ctx.settings, "capitalize_titles"))) t = ucwords(t);
  const title = decodeEntities(stripAllTags(stripSlashes(t), true));
  // `use_smilies` is a WordPress option: with no row, `get_option()` is false and nothing is converted.
  return truthy(ctx.model.options.get("use_smilies"))
    ? convertSmilies(ctx.model.site.url, title)
    : title;
}

/** `Paper::get_description()`. */
function finishDescription(raw: string): string {
  const t = phpTrim(raw);
  return t === "" ? "" : decodeEntities(stripAllTags(stripSlashes(t), true));
}

/** The value of a meta field that holds a template (`rank_math_title`), with its variables replaced. */
function metaTemplate(ctx: Ctx, value: unknown, vars: RankMathVars): string {
  const v = metaText(value);
  return v === "" ? "" : replaceVars(ctx, v, vars);
}

interface PageSeo {
  title: string;
  description: string;
  robots: PaperRobots;
  canonicalOverride: string;
  type: string;
  ogTitle: string;
  ogDescription: string;
  image?: SeoImage | undefined;
  twitterImage?: SeoImage | undefined;
  twitterCard: string;
  twitterTitle: string;
  twitterDescription: string;
}

/** A post or page as a `Singular` paper: it is also what a static front page and the posts page are. */
function singular(ctx: Ctx, post: WpPost, role: "post" | "home" | "posts-page"): PageSeo {
  const { settings, model } = ctx;
  const vars = variablesFor(ctx);
  const type = post.type;
  const meta = (key: string): unknown => postMeta(model, post.id, `rank_math_${key}`);

  let title = metaTemplate(ctx, meta("title"), vars);
  if (title === "") title = fromOptions(ctx, `pt_${type}_title`, vars, "%title% %sep% %sitename%");

  let description = metaTemplate(ctx, meta("description"), vars);
  if (description === "") description = post.excerpt;
  if (description === "")
    description = truncate(fromOptions(ctx, `pt_${type}_description`, vars), 160);

  // robots(): the post's own, else the type's when it has custom robots; a private or password-protected post is noindex.
  let robots = robotsCombine(meta("robots"));
  if (robots.length === 0 && truthy(setting(settings, `pt_${type}_custom_robots`))) {
    robots = robotsCombine(setting(settings, `pt_${type}_robots`), true);
  }
  if (
    post.status === "private" ||
    (post.passwordProtected && truthy(setting(settings, "noindex_password_protected")))
  ) {
    robots = setKey(robots, "index", "noindex");
  }
  let advanced = advancedCombine(meta("advanced_robots"));
  if (advanced === null && truthy(setting(settings, `pt_${type}_custom_robots`))) {
    advanced = advancedCombine(setting(settings, `pt_${type}_advanced_robots`));
  }

  const own = (
    prefix: string,
  ): { image?: SeoImage | undefined; title: string; description: string } => ({
    image: metaImage(ctx, meta(`${prefix}_image_id`), `${prefix} image`),
    title: metaTemplate(ctx, meta(`${prefix}_title`), vars),
    description: metaTemplate(ctx, meta(`${prefix}_description`), vars),
  });
  const fb = own("facebook");
  const useFacebook = truthy(meta("twitter_use_facebook"));
  const tw = own(useFacebook ? "facebook" : "twitter");

  const featured = (): SeoImage | undefined =>
    metaImage(ctx, postMeta(model, post.id, "_thumbnail_id"), "featured image");
  const fallbackImage = (): SeoImage | undefined => {
    const id = setting(settings, "open_graph_image_id");
    return id === undefined ? undefined : metaImage(ctx, id, "default social image");
  };
  const chooseImage = (own: SeoImage | undefined): SeoImage | undefined => {
    // Rank Math's `Image` and `Twitter` constructors look for images only `if ( ! post_password_required() )`.
    if (post.passwordProtected) return undefined;
    if (own) return own;
    const f = featured();
    if (f) return f;
    if (role === "home") {
      const home = metaImage(
        ctx,
        setting(settings, "homepage_facebook_image_id"),
        "homepage social image",
      );
      if (home) return home;
    }
    if (role === "post") {
      const c = contentImage(ctx, post);
      if (c) return c;
    }
    return fallbackImage();
  };

  const finishedTitle = finishTitle(ctx, title);
  const finishedDescription = finishDescription(description);
  const card = text(meta("twitter_card_type")) || text(setting(settings, "twitter_card_type"));
  // On a singular page an image with no alt of its own is described by the focus keyword, else the page's title.
  const withAlt = (image: SeoImage | undefined): SeoImage | undefined => {
    if (!image || image.alt !== undefined || role === "posts-page") return image;
    // (`get_the_title()`: the title as a visitor sees it, typography done.)
    const alt =
      metaText(meta("focus_keyword")).split(",")[0]! || decodeEntities(theTitle(post.title));
    return alt === "" ? image : { ...image, alt };
  };
  return {
    title: finishedTitle,
    description: finishedDescription,
    robots: { robots, advanced },
    canonicalOverride: metaText(meta("canonical_url")),
    type: role === "post" ? "article" : "website",
    ogTitle: fb.title !== "" ? decodeEntities(ucwordsIf(ctx, fb.title)) : finishedTitle,
    ogDescription: fb.description !== "" ? decodeEntities(fb.description) : finishedDescription,
    image: withAlt(chooseImage(fb.image)),
    twitterImage: withAlt(chooseImage(tw.image)),
    twitterCard: twitterCardOf(card),
    twitterTitle: tw.title !== "" ? decodeEntities(ucwordsIf(ctx, tw.title)) : finishedTitle,
    twitterDescription:
      tw.description !== "" ? decodeEntities(tw.description) : finishedDescription,
  };
}

/** The Twitter card types Rank Math knows; anything else is the small `summary` card. */
const twitterCardOf = (card: string): string =>
  ["summary", "summary_large_image", "app", "player"].includes(card) ? card : "summary";

const ucwordsIf = (ctx: Ctx, value: string): string =>
  truthy(setting(ctx.settings, "capitalize_titles")) ? ucwords(value) : value;

/** A taxonomy term archive as a `Taxonomy` paper. */
function taxonomyPage(ctx: Ctx, term: WpTerm): PageSeo {
  const { settings, model } = ctx;
  const vars = variablesFor(ctx);
  const tax = term.taxonomy;
  const meta = (key: string): unknown => termMeta(term, `rank_math_${key}`);

  let title = metaTemplate(ctx, meta("title"), vars);
  if (title === "") title = fromOptions(ctx, `tax_${tax}_title`, vars);
  let description = metaTemplate(ctx, meta("description"), vars);
  if (description === "") description = fromOptions(ctx, `tax_${tax}_description`, vars);

  let robots = robotsCombine(meta("robots"));
  if (robots.length === 0 && truthy(setting(settings, `tax_${tax}_custom_robots`))) {
    robots = robotsCombine(setting(settings, `tax_${tax}_robots`), true);
  }
  // An empty term with no child terms is noindex, when the site asks for that.
  const hasChildren = [...model.terms.values()].some(
    (t) => t.taxonomy === tax && t.parent === term.termId,
  );
  if (term.count === 0 && truthy(setting(settings, "noindex_empty_taxonomies")) && !hasChildren) {
    robots = setKey(robots, "index", "noindex");
  }
  let advanced = advancedCombine(meta("advanced_robots"));
  if (
    (advanced === null || advanced.length === 0) &&
    truthy(setting(settings, `tax_${tax}_custom_robots`))
  ) {
    advanced = advancedCombine(setting(settings, `tax_${tax}_advanced_robots`));
  }

  const own = (
    prefix: string,
  ): { image?: SeoImage | undefined; title: string; description: string } => ({
    image: metaImage(ctx, meta(`${prefix}_image_id`), `${prefix} image`),
    title: metaTemplate(ctx, meta(`${prefix}_title`), vars),
    description: metaTemplate(ctx, meta(`${prefix}_description`), vars),
  });
  const fb = own("facebook");
  const useFacebook = truthy(meta("twitter_use_facebook"));
  const tw = own(useFacebook ? "facebook" : "twitter");
  const fallback = (): SeoImage | undefined => {
    const id = setting(settings, "open_graph_image_id");
    return id === undefined ? undefined : metaImage(ctx, id, "default social image");
  };

  const finishedTitle = finishTitle(ctx, title);
  const finishedDescription = finishDescription(description);
  const card = text(meta("twitter_card_type")) || text(setting(settings, "twitter_card_type"));
  return {
    title: finishedTitle,
    description: finishedDescription,
    robots: { robots, advanced },
    canonicalOverride: metaText(meta("canonical_url")),
    type: "article",
    ogTitle: fb.title !== "" ? decodeEntities(ucwordsIf(ctx, fb.title)) : finishedTitle,
    ogDescription: fb.description !== "" ? decodeEntities(fb.description) : finishedDescription,
    image: fb.image ?? fallback(),
    twitterImage: tw.image ?? fallback(),
    twitterCard: twitterCardOf(card),
    twitterTitle: tw.title !== "" ? decodeEntities(ucwordsIf(ctx, tw.title)) : finishedTitle,
    twitterDescription:
      tw.description !== "" ? decodeEntities(tw.description) : finishedDescription,
  };
}

/** The archive of a custom post type as an `Archive` paper. */
function archivePage(ctx: Ctx, type: string): PageSeo {
  const { settings } = ctx;
  const vars = variablesFor(ctx);
  const fallback = "%pt_plural% Archive %page% %sep% %sitename%";
  const custom = truthy(setting(settings, `pt_${type}_custom_robots`));
  const title = fromOptions(ctx, `pt_${type}_archive_title`, vars, fallback);
  const description = fromOptions(ctx, `pt_${type}_archive_description`, vars, fallback);
  const archiveImage = setting(settings, `pt_${type}_facebook_image_id`);
  const image =
    (archiveImage === undefined
      ? undefined
      : metaImage(ctx, archiveImage, "archive social image")) ??
    (setting(settings, "open_graph_image_id") === undefined
      ? undefined
      : metaImage(ctx, setting(settings, "open_graph_image_id"), "default social image"));
  const finishedTitle = finishTitle(ctx, title);
  const finishedDescription = finishDescription(description);
  const card = text(setting(settings, "twitter_card_type"));
  return {
    title: finishedTitle,
    description: finishedDescription,
    robots: {
      robots: custom ? robotsCombine(setting(settings, `pt_${type}_robots`)) : [],
      advanced: custom ? advancedCombine(setting(settings, `pt_${type}_advanced_robots`)) : [],
    },
    canonicalOverride: "",
    type: "article",
    ogTitle: finishedTitle,
    ogDescription: finishedDescription,
    image,
    twitterImage: image,
    twitterCard: twitterCardOf(card),
    twitterTitle: finishedTitle,
    twitterDescription: finishedDescription,
  };
}

/** The front page of a site that shows its latest posts there: Rank Math's `Blog` paper. */
function blogPage(ctx: Ctx): PageSeo {
  const { settings } = ctx;
  const vars = variablesFor(ctx);
  const custom = truthy(setting(settings, "homepage_custom_robots"));
  const title = fromOptions(ctx, "homepage_title", vars);
  const description = fromOptions(ctx, "homepage_description", vars, ctx.model.site.description);
  const social = (id: string): string => {
    const v = setting(settings, id);
    return typeof v === "string" && v !== "" ? replaceVars(ctx, v, vars) : "";
  };
  const fbTitle = social("homepage_facebook_title");
  const fbDescription = social("homepage_facebook_description");
  const imageId = setting(settings, "homepage_facebook_image_id");
  const image =
    (imageId === undefined ? undefined : metaImage(ctx, imageId, "homepage social image")) ??
    (setting(settings, "open_graph_image_id") === undefined
      ? undefined
      : metaImage(ctx, setting(settings, "open_graph_image_id"), "default social image"));
  const finishedTitle = finishTitle(ctx, title);
  const finishedDescription = finishDescription(description);
  const card = text(setting(settings, "twitter_card_type"));
  return {
    title: finishedTitle,
    description: finishedDescription,
    robots: {
      robots: custom ? robotsCombine(setting(settings, "homepage_robots")) : [],
      advanced: custom ? advancedCombine(setting(settings, "homepage_advanced_robots")) : [],
    },
    canonicalOverride: "",
    type: "website",
    ogTitle: fbTitle !== "" ? decodeEntities(ucwordsIf(ctx, fbTitle)) : finishedTitle,
    ogDescription: fbDescription !== "" ? decodeEntities(fbDescription) : finishedDescription,
    image,
    twitterImage: image,
    twitterCard: twitterCardOf(card),
    twitterTitle: finishedTitle,
    twitterDescription: finishedDescription,
  };
}

const LOCALE = (model: WpModel): string => model.site.language.replace(/-/g, "_");

/**
 * What the live page prints in its head for a post, a term, the front page or the posts page: the title,
 * meta description, robots, canonical and image (the og:image), and the Open Graph and Twitter fields.
 * Plain text throughout.
 *
 * A static front page and the posts page are posts to Rank Math (their own meta, else the `page` template);
 * only a front page that lists the latest posts uses the homepage templates. Rank Math prints Slack
 * labels, `article:*` tags and structured data (JSON-LD) too; none of that is carried, and one report
 * entry per source (`seo.schema-not-migrated`) says so.
 */
export function seoFor(model: WpModel, target: SeoTarget, opts: SeoOptions = {}): Seo {
  const report = opts.report;
  const settings = loadSettings(model);
  checkSettings(model, settings, report);
  let acf = acfCache.get(model);
  if (!acf) acfCache.set(model, (acf = loadAcf(model)));
  const clock = siteClock(model);
  const base = { model, settings, opts, report, clock, acf };

  let page: PageSeo;
  let where: string;
  let post: WpPost | undefined;
  let term: WpTerm | undefined;
  // What a post is for the page: a static front page and the posts page are posts to Rank Math.
  const role: "post" | "home" | "posts-page" =
    target.kind === "home" ? "home" : target.kind === "posts-page" ? "posts-page" : "post";

  if (target.kind === "post") post = target.post;
  else if (target.kind === "term") term = target.term;
  else if (target.kind === "home") {
    if (model.site.showOnFront === "page") post = model.posts.get(model.site.pageOnFront);
  } else if (target.kind === "posts-page" && model.site.showOnFront === "page") {
    post = model.posts.get(model.site.pageForPosts);
  }

  if (target.kind === "archive") {
    where = `archive:${target.postType}`;
    page = archivePage(
      { ...base, archive: target.postType, where, url: undefined },
      target.postType,
    );
  } else if (target.kind === "home" && model.site.showOnFront !== "page") {
    where = "home";
    page = blogPage({ ...base, where, url: model.site.home });
  } else if (target.kind === "posts-page" && model.site.showOnFront !== "page") {
    // Without a posts page the index is the front page itself.
    where = "home";
    page = blogPage({ ...base, where, url: model.site.home });
  } else if (term) {
    where = `term:${term.termId}`;
    page = taxonomyPage({ ...base, term, where, url: undefined }, term);
  } else if (post) {
    where = `post:${post.id}`;
    const url = post.status === "publish" ? `${model.site.home}/?p=${post.id}` : undefined;
    page = singular({ ...base, post, where, url }, post, role);
  } else {
    // A front or posts page that is not in the model: the site-wide defaults are all there is.
    where = target.kind === "home" ? "home" : "posts-page";
    report?.add({
      severity: "warn",
      code: "seo.target-missing",
      message: `The ${target.kind === "home" ? "front page" : "posts page"} (${target.kind === "home" ? model.site.pageOnFront : model.site.pageForPosts}) is not in the model; the homepage templates stand in for its SEO.`,
      where: "option:" + (target.kind === "home" ? "page_on_front" : "page_for_posts"),
    });
    page = blogPage({ ...base, where, url: model.site.home });
  }

  if (
    report &&
    once(report, `seo.schema-not-migrated|${model.site.url}`) &&
    model.site.activePlugins.some((p) => p.startsWith("seo-by-rank-math"))
  ) {
    report.add({
      severity: "info",
      code: "seo.schema-not-migrated",
      message:
        "Rank Math prints structured data (JSON-LD), Slack sharing labels and article tags on every page, generated from its Schema settings; only the title, description, robots, canonical and the Open Graph and Twitter tags are carried over.",
      where: "option:rank-math-options-titles",
    });
  }

  const canonical =
    page.canonicalOverride !== "" ? page.canonicalOverride : opts.permalink?.(target);
  const robots = printRobots({ ...base, where, url: undefined }, page.robots);
  const noindex = /(^|, )noindex(,|$)/.test(robots);
  const siteName = decodeEntities(
    stripAllTags(text(settings.titles.website_name) || model.site.name, true),
  );
  const handle = text(settings.titles.twitter_author_names);
  const ogUrl = canonical;
  return {
    title: page.title,
    description: page.description,
    robots,
    ...(canonical === undefined || noindex ? {} : { canonical }),
    ...(page.image ? { image: page.image } : {}),
    openGraph: {
      type: page.type,
      locale: LOCALE(model),
      title: page.ogTitle,
      description: page.ogDescription,
      siteName,
      ...(ogUrl === undefined ? {} : { url: ogUrl }),
      ...(page.image ? { image: page.image } : {}),
    },
    twitter: {
      card: page.twitterCard,
      title: page.twitterTitle,
      description: page.twitterDescription,
      ...(handle === "" ? {} : { site: `@${handle}` }),
      ...(page.twitterImage ? { image: page.twitterImage } : {}),
    },
  };
}

/** The `seo` key of an entry's frontmatter, as the entry data contract has it (the image is an `EntryImage`, which has `src`). */
export interface EntrySeo {
  title: string;
  description: string;
  robots: string;
  image?: EntryImage;
}

/**
 * The page's SEO as the entry data contract carries it: `{title, description, robots, image}`. The image is the
 * project's own copy when `hooks.attachment` resolves the attachment (the emitter owns where media lands) and otherwise
 * the address the live page printed; either way it has a `src`, which {@link Seo.image} (with its `url`) does not.
 * The canonical, the Open Graph and the Twitter tags are not part of the contract and are left out.
 */
export function toEntrySeo(
  seo: Seo,
  hooks: { attachment?(id: number): EntryImage | undefined } = {},
): EntrySeo {
  const { image } = seo;
  let entryImage: EntryImage | undefined;
  if (image) {
    const own = image.id === undefined ? undefined : hooks.attachment?.(image.id);
    entryImage = own
      ? { ...own, alt: own.alt === "" ? (image.alt ?? "") : own.alt }
      : {
          src: image.url,
          ...(image.width === undefined ? {} : { width: image.width }),
          ...(image.height === undefined ? {} : { height: image.height }),
          alt: image.alt ?? "",
        };
  }
  return {
    title: seo.title,
    description: seo.description,
    robots: seo.robots,
    ...(entryImage === undefined ? {} : { image: entryImage }),
  };
}

/**
 * Ports of the WordPress and Rank Math functions the text above is made with. They are exported for the
 * tests, which hold each against PHP's own output; nothing else should call them.
 */
export const php = {
  date: (format: string, utcMs: number, zone: string): string => {
    const clock =
      zone === "UTC" ? { toLocal: (ms: number) => ms, toUtc: (ms: number) => ms } : zoneClock(zone);
    const local = clock.toLocal(utcMs);
    return phpDate(format, {
      date: new Date(local),
      utcMs,
      zone,
      offset: Math.round((local - utcMs) / 1000),
    });
  },
  wpautop,
  ksesParagraphs,
  stripTags,
  stripAllTags,
  stripShortcodes,
  truncate,
  ucwords,
  excerptFromContent,
  trim: phpTrim,
  stripSlashes,
  convertSmilies: (text: string) => convertSmilies("https://x.test", text),
  wptexturize,
  theTitle,
};
