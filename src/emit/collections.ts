/**
 * Markdown content collections: every post and every custom post type becomes
 * `content/<collection>/<entry id>.md`, the entry's data as YAML frontmatter and its body as Jx
 * Markdown. {@link buildCollections} returns the files, the `content` section of `project.json`, what
 * the bodies use (components, classes, hoisted rules) and the report.
 *
 * ## What an entry is
 *
 * - **The frontmatter is the Entry data contract of docs/design.md**, which is `postData` of
 *   `cwicly/tokens.ts` (so a template that binds `state.entry.data.<key>` and a static page that reads
 *   the post cannot disagree: the title, excerpt and ACF text are what WordPress prints, texturized and
 *   `wpautop`ed), with the dates in RFC 3339 UTC, `authorUrl` (the key `dynamic.ts` asks for), `seo`
 *   from Rank Math, `hasExcerpt`, `postType` (a list of several types asks each entry what it is), and every key of every object in order (`sortDeep`): the same site
 *   writes the same bytes. A string that holds `${` is spelled with a zero-width space between the two
 *   characters (`md.literal-template`): the build evaluates it wherever it is written.
 * - **Only published, routed posts get a file**, at the route's `file`. Drafts, private, pending and
 *   scheduled posts are `collection.excluded` (the build does not filter drafts), a password protected
 *   post is `collection.protected`, a post that lost its address or never had one is
 *   `collection.no-route`, and a post type no route knows (a plugin's) is `collection.unrouted`
 *   unless `routeTypes` gives it its rewrite rule.
 * - **Addresses are the Jx site's.** A value that is one address (an ACF `url` or `link` field) and
 *   the `href` and `src` of the markup in a wysiwyg value go through the same `rewriteUrl` the bodies
 *   use ({@link rewriteAddresses}): an internal permalink is its route, an upload its `/media` path,
 *   anything else is left as written and reported (`url.unresolved`). So the `format: "uri"` that
 *   `acfSchema` gives a `url` field is `"uri-reference"` here ({@link relaxAddressFormats}): a route
 *   is not a URI.
 * - **The schema** of a collection is `BASE_PROPERTIES`, `authorUrl`, `hasExcerpt`, `postType` and `acfSchema` of
 *   the fields of every group that applies to one of its entries. A field is `required` only when every
 *   entry has a group that requires it (a group applies to the entries its location rules say, and
 *   requires nothing of the others). Each entry is checked against it (`schemaProblems` is what the
 *   loader's `validateEntries` checks; `entry.schema-invalid`). `authorUrl` and `hasExcerpt` are not
 *   reserved by ACF's own list of keys: a field of that name has taken the key, and is said
 *   (`entry.key-collision`).
 * - **`$elements`** lists the component files the bodies instantiate. The parser parses directives
 *   only for a collection whose `$elements` is not empty and reads nothing else from it, so a
 *   collection whose bodies hold directives and no component lists {@link DIRECTIVES_SWITCH}. That is a
 *   dependency on behaviour no spec gives: specs/parser.md says `$elements` are to become the allowed
 *   names of directives, and a package specifier is not a tag name. The tests build an entry of `div`,
 *   `sup` and `img` under the switch and read the parser's version, and go red the day that changes.
 * - **Placeholders** (`wp2jx-block`, `wp2jx-shortcode`) have nothing to become in a Markdown entry:
 *   a shortcode keeps what it enclosed, every other one is left out, `entry.placeholder-dropped`.
 *   Neither has an element that needs the page's own state (a repeater over a query, a `$switch`): an
 *   entry has none, so it is left out, `entry.dynamic-dropped`.
 *
 * ## The body, and what Markdown cannot say
 *
 * The body is `convertSubject(post, {target: "markdown"})`, put in the form the serializer writes and
 * the reader reads back unchanged ({@link fitBody}), written by `serializeJxMarkdown` (mode
 * `roundtrip`; the frontmatter is written here, because the serializer collapses three line breaks
 * to two across the whole file, frontmatter included), and **read back by `transpileJxMarkdown`**:
 * {@link verifyFile} compares the tree it was written from with the tree read back, the way a browser
 * would see them ({@link canonNodes}), and a difference is `md.lossy`. Over both fixture sites no
 * entry differs; each of these is why, and each is reported per entry (`md.normalized`):
 *
 * - **A colon before a digit or letter is damaged (Jx bug).** The reader takes `:16` in `Luke 3:16`
 *   and `:30pm` in `12:30pm` for a text directive; the serializer escapes a colon only before an ASCII
 *   letter and not after emphasis. 64 of the 208 anabaptistperspectives entries are damaged. A colon
 *   that a reader would take for a directive is written `\:` (a character escape, which reads back as
 *   the colon, prints as the colon and leaves no space around it): the serializer is given a
 *   private-use stand-in ({@link Sentinels}), replaced after. The core converters wrote a `span` around
 *   such a colon instead (`block.text-directive`), which the build separates from its neighbours with a
 *   space; those spans are put back into the text first. `md.colon-escaped` counts them. The same
 *   escape is written for a colon before an astral code point (the reader's name rule takes `c:😀` for
 *   a directive), a colon that ends a text before an element written as a text directive (`Note:` and
 *   `:sup[1]` would be `::sup[1]`, a leaf directive, and the element is lost), the colons of a run that
 *   starts a line before a name (`::note[x]` is a leaf directive), and the colons in an image's alt text
 *   and a title. Adjacent strings are one text, so a colon at the end of one meets the digit that
 *   starts the next.
 * - **A top-level custom property in an element's `style` is lost (Jx bug).** `style.--cc-gallery-height`
 *   reads back as the media query `@--cc-gallery-height` and the build drops it without a word. The
 *   declaration is moved to a rule of the element's own scope (`#id`, else the first class: where the
 *   build writes the element's own style) in `used.hoisted`, which the project assembler writes into the
 *   project's `style`.
 * - **A component instance reads back wrong (Jx bug).** For a custom element the reader makes
 *   `className`, `id` and every other key but `style`, `children` and the `$` ones an HTML attribute of
 *   that name: `<wp-icon-card className="jx-… cs-…">`, so the variant classes the component's CSS needs
 *   are lost, and its `style`, scoped to a class of its own beside the `class` attribute, gives the
 *   element two `class` attributes. The element is given `class` and `id` as attributes and its style
 *   moves to a rule of the scope the build would have used (`#id`, else the first class), in
 *   `used.hoisted`. A `$props` value is the text a directive attribute holds (every one is a string):
 *   a number and `true` are their text, `false`, `null` and a list have no form and are left out
 *   (`md.props-lost`: the string `"false"` is true).
 * - **An `id` given as an attribute is read back as the element's own**, which scopes the element's
 *   style by `#id`, where the converters (docs/design.md) keep it off the id on purpose: the style moves
 *   to the element's class first. **So does a heading's**: the build gives every heading of a Markdown
 *   entry an id of its text and writes the heading's own style to `#that-id`, which outweighs every
 *   class rule and, when the text starts with a digit, is no selector at all.
 * - **A class id repeats from post to post with different declarations** (docs/design.md), and the
 *   rules above that move to the project's `style` have one body per selector. When entries disagree
 *   about a selector, each entry's rule is written for `selector:where(.jx-<hash of its declarations>)`
 *   and its element carries that class (`style.scoped-per-entry`; `:where` adds no specificity, so the
 *   cascade is the live page's). A clash among the converters' own rules is not this module's to
 *   resolve and is said (`style.conflict`).
 * - **A class the pages style otherwise is written to win** (`classStyles`, `emit/class-styles.ts`). The
 *   live page prints the template's stylesheet and then the post's, so on a project page the post's
 *   rule wins every property it sets. A Jx page orders rules by the elements' places in the tree, and
 *   the template's element after the body wins; and a rule an entry moved to the project's `style`
 *   reaches every page that uses the class (`.heading-c235f2d { @--sm { font-size: 20px } }` from the
 *   projects restyled the blog's cards). An element whose class a page, layout or component styles
 *   with other declarations has its whole `style` written as `.class.jx-<hash>`: one class more
 *   specific, reaching only the elements that carry the hash class (`style.scoped-per-entry`).
 * - **A table the author fixed keeps its columns.** The figure carries `has-fixed-layout`, which
 *   WordPress's rule (written for the table inside `.wp-block-table`) never matches; the project's
 *   style carries the rule for the figure (`collection.fixed-layout-rule`).
 * - **The paragraph a list item or table cell is read back with takes no space** when no page of the
 *   site holds a paragraph there (`collection.item-paragraph-rule`: `li > p { margin: 0 !important }`;
 *   WordPress prints the text of an item bare, and a theme's `.content p` margins made every list of
 *   a post 8px longer per item).
 * - **A run of three line breaks in code is collapsed (Jx bug)**, which the serializer does across the
 *   whole file; the break is a stand-in while the serializer runs.
 * - **Text and inline markup directly in a container are read back as a paragraph**: a list item, a
 *   caption, a table cell, a `div`. The paragraph is made here, so the tree written is the tree read.
 * - **The first row of a Markdown table is a header row, a cell has no spans, attributes or blocks.**
 *   A table that is not exactly that (no `thead`, a class, a span) is written as directives, which carry
 *   all of it; so is a list with a class on it or on an item (a Markdown item inside a directive reads
 *   back as a list in a list), an image with attributes a Markdown image has no place for (width,
 *   height, a class), a link with no address, and a block inside a link (the serializer writes the
 *   content of a link, emphasis, paragraph or heading as one line, whatever it is).
 * - **An inline element alone in a container that is a directive** (the image in a `figure`) is a
 *   directive too, so that the reader makes no paragraph, with its margins, around it.
 * - **A Markdown hard break at the end of a block reads back as a backslash**, and an empty paragraph
 *   has no spelling. The last break of a block shows nothing and goes, as an empty paragraph does; a
 *   break before it, and a paragraph that is nothing but breaks, show blank lines: each is written as a
 *   line holding a no-break space (`&#xA0;`, a third stand-in, because the serializer trims a block's
 *   text), which the reader gives back and a browser shows as a line.
 * - **Emphasis next to a space is written as character references** (`*sound&#x20;*&#x6F;f`): CommonMark
 *   does not open emphasis before one. The space moves out of the emphasis, beside it, which the
 *   browser shows the same.
 * - **`innerHTML` is written by no serializer.** A directive's attribute reads back as one, so an
 *   element that has it carries it as `data-wp2jx-innerhtml`, renamed after the serializer has run. A
 *   Markdown tag that holds its content that way (a paragraph, an item, emphasis, a link or code whose
 *   HTML has a literal `${`, which no other form can carry) is written as a directive for it, with its
 *   list as directives too; only an element that holds children and `innerHTML` both loses the latter
 *   (`md.innerhtml-lost`).
 * - **The reader puts a paragraph around the text of every list item** (and the cells of a table
 *   written as directives): `<li><p>`, which the live pages never have, and a theme rule such as
 *   `.content p {margin; padding}` then reaches. Said with a count (`md.item-paragraphs`).
 * - **An address in text is read back as a link** (GFM's autolink literals; no spelling prevents it):
 *   `md.autolinked`. The reader does not count a no-break space as white space either, so an address
 *   followed by one is linked with the space and the next word in its `href`: it is written with a
 *   plain space.
 *
 * ## The space between inline siblings (`block.inline-gap`)
 *
 * The Jx build joins the children of an element with a newline and two spaces, so `20<sup>th</sup>`
 * shows as `20 th` and `link</a>.` as `link .` wherever the two have no space of their own.
 * {@link inlineGaps} counts those boundaries on the tree that is written (a boundary beside a space or a
 * line break loses nothing); an entry that has any is `block.inline-gap`, with examples. Markdown has
 * no other spelling for such a paragraph, **except one**: an element's `innerHTML`, which the build
 * writes as it is. `inlineGaps: "innerHTML"` writes each paragraph that has a boundary as
 * `:::p{innerHTML="…"}`. Measured on 24 live anabaptistperspectives essays (fetched for the check; the
 * fixtures hold the live pages of 3, which the tests use): with the default every essay has the live
 * page's text but for the space, and 6 of 24 are word for word the live page's (the others are 1 to
 * 22 words apart, a word split by the build's space); with `"innerHTML"` 23 of 24 are word for word
 * the live page's, and the 24th has one split word, in a heading (which has no such form). The cost is
 * that those paragraphs are HTML in an attribute, not Markdown a person edits, which is why it is
 * opt-in (headings and the other containers keep the gap and the report).
 *
 * Report codes: `collection.excluded`, `collection.protected`, `collection.no-route`,
 * `collection.unrouted`, `collection.duplicate-file`, `collection.inline-gap-summary`,
 * `collection.item-paragraph-rule`, `collection.fixed-layout-rule`,
 * `entry.date-invalid`, `entry.seo-failed`, `entry.key-collision`, `entry.placeholder-dropped`,
 * `entry.dynamic-dropped`, `entry.failed`, `entry.schema-invalid`, `md.colon-escaped`, `md.normalized`,
 * `md.lossy`, `md.autolinked`, `md.literal-template`, `md.style-lost`, `md.props-lost`,
 * `md.attributes-dropped`, `md.innerhtml-lost`, `md.item-paragraphs`, `md.frontmatter-mismatch`,
 * `style.scoped-per-entry` (which also covers a class the pages style otherwise), `style.conflict`,
 * `block.inline-gap`; everything the conversions of the
 * bodies and the data reported is passed on (`block.*`, `html.*`, `url.*`, `acf.*`, `seo.*`,
 * `dynamic.*`), except `block.text-directive`, the converters' own `block.inline-gap` (which this
 * module counts again after its own pass) and `html.innerhtml-unserialisable` (which its `innerHTML`
 * directives answer).
 */
import { createHash } from "node:crypto";
import { transpileJxMarkdown } from "@jxsuite/parser";
import { MD_ALL, serializeJxMarkdown } from "@jxsuite/parser/serialize";
import { Document, visit } from "yaml";
import { collectWpClasses } from "../core/block-css.ts";
import { postData } from "../cwicly/tokens.ts";
import { userProfiles } from "../wp/profiles.ts";
import { recipeData } from "../wp/lazyblocks.ts";
import { convertSubject } from "../convert.ts";
import { replacePlaceholders, walkElements, type Placeholder } from "../placeholders.ts";
import { fluentFormFor } from "./fluentform.ts";
import { sortedJson, type ClassStyles } from "./class-styles.ts";
import { rewriteStyleUrls } from "./style-urls.ts";
import { createReport } from "../report.ts";
import { buildRoutes, createUrlTools } from "../routes.ts";
import type { Route, RouteOptions } from "../routes.ts";
import { subjectCtx } from "../site.ts";
import type { HoistedRule, SiteContext } from "../site.ts";
import type { JxElement, JxNode, Report, ReportEntry, Severity, WpPost } from "../types.ts";
import {
  acfSchema,
  acfValues,
  BASE_PROPERTIES,
  BASE_REQUIRED,
  fieldsFor,
  postTarget,
} from "../wp/acf.ts";
import type { AcfPostTarget, JsonSchema } from "../wp/acf.ts";
import { decodeEntities, DEFAULT_EXCLUDED_POST_TYPES, publicUrl } from "../wp/model.ts";
import { seoFor, toEntrySeo } from "../wp/seo.ts";

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const isEl = (n: JxNode | undefined): n is JxElement => n !== undefined && typeof n !== "string";
const tagOf = (el: JxElement): string => (typeof el.tagName === "string" ? el.tagName : "");
const kidsOf = (el: JxElement): JxNode[] => (Array.isArray(el.children) ? el.children : []);

// ── The body: what the serializer can write, and what it reads back ─────────────────────────────

/** Elements that sit inside a line of text. A run of them (and loose text) is what a paragraph holds. */
const PHRASING = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "br",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "img",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr",
]);

/**
 * Elements whose own children are inline content as far as Markdown is concerned: a paragraph or
 * heading holds its text, the emphasis and link elements hold theirs, and the reader unwraps the
 * paragraph a directive of any of the others (`PHRASING_ELEMENTS` in the parser's transpile.ts) would
 * hold. Every other element puts a paragraph around loose text and inline markup.
 */
const INLINE_HOSTS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "abbr",
  "b",
  "button",
  "cite",
  "code",
  "data",
  "dfn",
  "dt",
  "del",
  "em",
  "i",
  "kbd",
  "label",
  "legend",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "td",
  "th",
  "time",
  "u",
  "var",
]);

/** The keys of a Jx element the serializer writes without making the element a directive. */
const PLAIN_KEYS = new Set(["tagName", "children", "textContent", "innerHTML", "attributes"]);

/** The serializer writes an element of a Markdown tag as a directive when it carries any other key (`className`, `id`, `style`, `$props`…). */
const hasJxProps = (el: JxElement): boolean => Object.keys(el).some((key) => !PLAIN_KEYS.has(key));

/** The attributes the Markdown form of a tag carries; the others are lost unless the element is a directive. */
const NATIVE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "title"],
  img: ["src", "alt", "title"],
  ol: ["start"],
};

/** Private-use characters that stand in for text while the serializer runs: see {@link Sentinels}. */
const SENTINELS = ["\u{F0A01}", "\u{F0A02}", "\u{F0A03}", "\u{F0A04}", "\u{F0A05}"] as const;

/**
 * Two characters that appear nowhere in a body, chosen per entry. The serializer cannot be told to
 * write a colon as `\:` or to leave a run of blank lines in code alone, so each is a character it
 * passes through and the file's text is rewritten afterwards: `colon` becomes the escape that keeps
 * the colon text, `newline` becomes the line break the serializer would have collapsed.
 */
export interface Sentinels {
  colon: string;
  newline: string;
  /**
   * A blank line: written `&#xA0;`, a no-break space that a browser does not collapse and that the
   * serializer, which trims the text of a block, would otherwise remove. Absent when the body has
   * left no third character free; the blank lines are then dropped, and said.
   */
  blank?: string;
}

/** The attribute that carries an element's `innerHTML` through the serializer, which writes none. */
const INNER_KEY = "data-wp2jx-innerhtml";

/**
 * The reader decodes the character references of an attribute value and the serializer writes none,
 * so `&lt;` in the HTML would come back as `<`: every ampersand is written as a reference of its own.
 */
const escapeInner = (html: string): string => html.replaceAll("&", "&amp;");
const unescapeInner = (value: string): string => value.replaceAll("&amp;", "&");

/** The attribute where the serializer wrote it: the first of a directive's, or a later one. */
const INNER_ATTRIBUTE = new RegExp(`([{ ])${INNER_KEY}=`, "g");

/** What was done to a body so that it can be written as Markdown and read back as the same tree. */
export interface BodyNotes {
  /** Colons that a reader would take for a text directive, written `\:`. */
  colons: number;
  /** The spans the core converters wrote around a colon (`:span[:]`), put back into the text. */
  colonSpans: number;
  /** Empty paragraphs removed: Markdown has no spelling for one, and one shows nothing. */
  emptyBlocks: number;
  /** Loose text and inline markup put into a paragraph, by the element that held it. */
  wrapped: Record<string, number>;
  /** Tables written as directives (spans, classes, or a first row of data cells). */
  tables: number;
  /** Images written as directives (they carry attributes a Markdown image has no place for). */
  images: number;
  /** Links written as directives (they hold blocks, which a Markdown link cannot). */
  links: number;
  /** Elements written as directives because they carry attributes a Markdown element has no place for (a `data-*` on a paragraph). */
  attributes: number;
  /** Paragraphs, lists and other blocks inside a link or emphasis, written as directives so that they survive. */
  inlineBlocks: number;
  /** Lists and items written as directives (a class on the list or on one item). */
  lists: number;
  /** Inline elements alone in a container written as a directive, written as directives themselves so that no paragraph is made around them. */
  alone: number;
  /** Line breaks removed from the end of a block, where a Markdown hard break reads back as a backslash. */
  breaks: number;
  /** Custom properties moved from an element's `style` to a rule of its own scope. */
  hoisted: number;
  /** Custom properties of an element with no scope to move them to: lost. */
  styleLost: string[];
  /** Elements whose whole style moved to a rule of their class (see {@link prepare}). */
  scoped: number;
  /** Rules written for a class of their own declarations, because entries disagree about the selector (see {@link ruleFor}). */
  scopedPerEntry: number;
  /** Rules written to win over the rule a page, layout or component has for the same class (see {@link ruleFor}). */
  isolated: number;
  /** `tag:name` of every attribute a Markdown element has no place for and that was left out. */
  attributesDropped: string[];
  /** Component properties written as the text a directive attribute holds (numbers, `true`). */
  propsStringified: number;
  /** Component properties a directive attribute cannot hold (`false`, a list): the component's default applies. */
  propsLost: string[];
  /** Elements whose `innerHTML` was carried in an attribute. */
  innerHtml: number;
  /** Paragraphs written as their HTML (`inlineGaps: "innerHTML"`), so that the build puts no space between their inline pieces. */
  innerHtmlParagraphs: number;
  /** Elements with `innerHTML` that a Markdown tag cannot carry: lost. */
  innerHtmlLost: string[];
  /** Literal `${` spelled with a zero-width space, since the build evaluates it. */
  templates: number;
  /** Runs of three or more line breaks inside code, which the serializer collapses to two. */
  codeBreaks: number;
  /** Emphasis and links whose first or last character was a space, moved out to the text beside them. */
  edgeSpaces: number;
  /** Line breaks that showed a blank line and were written as a line holding a no-break space. */
  breaksKept: number;
  /** A no-break space after an address, written as a space: the reader's autolink would swallow it into the address. */
  addressSpaces: number;
}

export const emptyNotes = (): BodyNotes => ({
  colons: 0,
  colonSpans: 0,
  emptyBlocks: 0,
  wrapped: {},
  tables: 0,
  images: 0,
  links: 0,
  attributes: 0,
  inlineBlocks: 0,
  lists: 0,
  alone: 0,
  breaks: 0,
  hoisted: 0,
  styleLost: [],
  scoped: 0,
  scopedPerEntry: 0,
  isolated: 0,
  attributesDropped: [],
  propsStringified: 0,
  propsLost: [],
  innerHtml: 0,
  innerHtmlParagraphs: 0,
  innerHtmlLost: [],
  templates: 0,
  codeBreaks: 0,
  edgeSpaces: 0,
  breaksKept: 0,
  addressSpaces: 0,
});

/** The Jx build evaluates `${…}` in every text of an entry, however it is spelled; a zero-width space between the two characters ends that. */
export const degradeTemplate = (text: string): string => text.replaceAll("${", "$\u200b{");

/**
 * What can begin a directive's name after its colon: anything but whitespace, punctuation and
 * symbols (`12:30`, `Luke 3:16`, `x:y`), and every astral code point, symbols and emoji included (the
 * reader's name rule reads a surrogate pair as name characters, so `c:😀` is a directive called `😀`).
 */
const NAME_AHEAD = "(?=[^\\s\\p{P}\\p{S}]|[\\u{10000}-\\u{10FFFF}])";

/**
 * The colons of `text` that the Markdown reader takes for the start of a text directive: a colon
 * (not right after another) followed by anything that can begin a name ({@link NAME_AHEAD}).
 *
 * The serializer escapes such a colon only before an ASCII letter and not after emphasis, so every
 * `N:M` damages the entry. Written `\:` the colon is a character escape, which the reader cannot
 * begin a directive with, and which reads back as the colon.
 */
const DIRECTIVE_COLON = new RegExp(`(?<!:):${NAME_AHEAD}`, "gu");

/**
 * A run of colons that starts a line and is followed by a name: `::note[x]` is a leaf directive and
 * `:::note` a container, wherever the line sits (the start of a paragraph, after a break, after a
 * newline in the text). The run is not caught by {@link DIRECTIVE_COLON}, which leaves a colon that
 * follows another alone because a text directive cannot start there.
 */
const DIRECTIVE_RUN = new RegExp(`(^|\n)(:{2,})${NAME_AHEAD}`, "gu");

/**
 * An address followed by a no-break space. The reader's autolink literal ends at white space but does
 * not count a no-break space as any, so it would link the address, the space and the next word
 * (`href="https://example.org/page.&nbsp;and"`); a plain space ends it.
 */
const ADDRESS_NBSP = /((?:https?:\/\/|www(?=\.))[-.\w]+[^\s<]*)\u00a0/gi;

/**
 * Text the way it is written: no `${`, and the colons a reader would take for a directive replaced by
 * the colon sentinel (not in code, where a colon is code, and where a run of blank lines is kept by the
 * newline sentinel). `lineStart` says the text begins a line, where a run of colons before a name is a
 * block directive.
 */
export function fixText(
  text: string,
  sentinels: Sentinels,
  notes: BodyNotes,
  scan: { code: boolean; lineStart?: boolean } = { code: false },
): string {
  let out = text;
  if (out.includes("${")) {
    notes.templates += out.split("${").length - 1;
    out = degradeTemplate(out);
  }
  if (scan.code) {
    if (out.includes("\n\n\n")) {
      out = out.replace(/\n{3,}/g, (run) => {
        notes.codeBreaks++;
        return sentinels.newline.repeat(run.length);
      });
    }
  } else {
    if (out.includes("\u00a0")) {
      out = out.replace(ADDRESS_NBSP, (_match, address: string) => {
        notes.addressSpaces++;
        return `${address} `;
      });
    }
    if (out.includes(":")) {
      out = out.replace(DIRECTIVE_COLON, () => {
        notes.colons++;
        return sentinels.colon;
      });
      out = out.replace(DIRECTIVE_RUN, (match, start: string, colons: string) => {
        if (start === "" && scan.lineStart !== true) return match;
        notes.colons += colons.length;
        return start + sentinels.colon.repeat(colons.length);
      });
    }
  }
  return out;
}

/** A text whose characters are all collapsible whitespace. */
const BLANK = /^[ \t\n\r\f]*$/;

/** Whether `node` is inline content: loose text, or an element that sits in a line of text. */
const isInline = (node: JxNode): boolean => typeof node === "string" || PHRASING.has(tagOf(node));

const isColonSpan = (node: JxNode): boolean =>
  isEl(node) &&
  tagOf(node) === "span" &&
  node.textContent === ":" &&
  Object.keys(node).length === 2;

/** The span `splitColons` (core/static.ts) writes around a colon that a reader would take for a directive. */
function mergeColonSpans(children: JxNode[], notes: BodyNotes): JxNode[] {
  if (!children.some(isColonSpan)) return children;
  const out: JxNode[] = [];
  for (const child of children) {
    const text = isColonSpan(child) ? ":" : child;
    if (isColonSpan(child)) notes.colonSpans++;
    const last = out[out.length - 1];
    if (typeof text === "string" && typeof last === "string") out[out.length - 1] = last + text;
    else out.push(text);
  }
  return out;
}

/** Whether a table is one a Markdown table writes: a header row of `th`, rows of `td`, one inline line in each cell, nothing else. */
export function tableIsNative(table: JxElement): boolean {
  if (hasJxProps(table) || Object.keys(table.attributes ?? {}).length > 0) return false;
  const sections = kidsOf(table);
  if (sections.length === 0 || sections.length > 2) return false;
  const [head, body] = sections;
  if (!isEl(head) || tagOf(head) !== "thead" || hasJxProps(head)) return false;
  if (body !== undefined && (!isEl(body) || tagOf(body) !== "tbody" || hasJxProps(body)))
    return false;
  const rows = (section: JxElement | undefined, cell: string): JxElement[] | undefined => {
    if (!section) return [];
    const out: JxElement[] = [];
    for (const row of kidsOf(section)) {
      if (!isEl(row) || tagOf(row) !== "tr" || hasJxProps(row)) return undefined;
      if (Object.keys(row.attributes ?? {}).length > 0) return undefined;
      for (const c of kidsOf(row)) {
        if (!isEl(c) || tagOf(c) !== cell || hasJxProps(c)) return undefined;
        if (Object.keys(c.attributes ?? {}).length > 0) return undefined;
        if (c.innerHTML !== undefined) return undefined;
        if (!kidsOf(c).every(isInline)) return undefined;
      }
      out.push(row);
    }
    return out;
  };
  const header = rows(head, "th");
  const data = rows(body, "td");
  if (!header || !data || header.length !== 1) return false;
  const width = kidsOf(header[0]!).length;
  return width > 0 && data.every((row) => kidsOf(row).length === width);
}

/** Whether an element is an `img` the Markdown image cannot carry whole. */
const imageNeedsDirective = (el: JxElement): boolean =>
  tagOf(el) === "img" &&
  !hasJxProps(el) &&
  Object.keys(el.attributes ?? {}).some((name) => !NATIVE_ATTRIBUTES.img!.includes(name));

/** Tags whose attributes the module leaves out when Markdown has no place for them: the core converters report each (`block.link-attributes-dropped`, `block.list-type-dropped`), and code keeps its language in the class. */
const ATTRIBUTES_MAY_GO = new Set([
  "a",
  "ol",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
]);

/** Whether a Markdown element has attributes that only a directive can carry (a `data-*` on a paragraph). */
const hasExtraAttributes = (el: JxElement): boolean =>
  MD_ALL.has(tagOf(el)) &&
  !ATTRIBUTES_MAY_GO.has(tagOf(el)) &&
  !hasJxProps(el) &&
  Object.keys(el.attributes ?? {}).length > 0;

/** The parts of a table, which are directives together when the table is one (see {@link tableIsNative}). */
const TABLE_PARTS = new Set([
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
]);

/** Elements that end in a line break nobody sees: a Markdown hard break at the end of a block reads back as a backslash. */
const LINE_HOSTS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "td",
  "th",
  "dt",
  "dd",
  "figcaption",
  "summary",
]);

/** Blocks that show blank lines for the breaks they end in, and are removed when they are empty. */
const DROP_WHEN_EMPTY = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** A rule that cannot live in one element's `style` (the shape of `HoistedRule` in site.ts). */
export interface BodyRule {
  selector: string;
  style: Record<string, unknown>;
}

const VOID_TAGS = new Set(["br", "img", "hr", "wbr", "input", "source", "col"]);

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (text: string): string => escapeText(text).replaceAll('"', "&quot;");
const kebab = (name: string): string => name.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * Inline nodes as the HTML a browser would parse back into them, or undefined when HTML cannot say it
 * as it is: an element with a nested style rule or a `$props` (which are not attributes). A flat style
 * becomes an inline `style` attribute.
 */
export function nodesToHtml(nodes: readonly JxNode[]): string | undefined {
  let html = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      html += escapeText(node);
      continue;
    }
    const tag = tagOf(node);
    if (tag === "") return undefined;
    let attrs = "";
    for (const [key, value] of Object.entries(node)) {
      if (key === "tagName" || key === "children" || key === "textContent" || key === "innerHTML")
        continue;
      if (key === "attributes" && isRec(value)) {
        for (const [name, v] of Object.entries(value)) {
          if (v === false || v === null || v === undefined) continue;
          attrs += v === true || v === "" ? ` ${name}` : ` ${name}="${escapeAttribute(String(v))}"`;
        }
      } else if (key === "className" && typeof value === "string") {
        attrs += ` class="${escapeAttribute(value)}"`;
      } else if (["id", "title", "lang", "dir"].includes(key) && typeof value === "string") {
        attrs += ` ${key}="${escapeAttribute(value)}"`;
      } else if (key === "style" && isRec(value)) {
        if (Object.values(value).some((v) => isRec(v))) return undefined;
        const css = Object.entries(value)
          .map(([k, v]) => `${k.startsWith("--") ? k : kebab(k)}: ${String(v)}`)
          .join("; ");
        if (css !== "") attrs += ` style="${escapeAttribute(css)}"`;
      } else return undefined;
    }
    if (VOID_TAGS.has(tag)) {
      html += `<${tag}${attrs}>`;
      continue;
    }
    let inner = "";
    if (typeof node.innerHTML === "string") inner = node.innerHTML;
    else if (typeof node.textContent === "string") inner = escapeText(node.textContent);
    else {
      const kids = nodesToHtml(kidsOf(node));
      if (kids === undefined) return undefined;
      inner = kids;
    }
    html += `<${tag}${attrs}>${inner}</${tag}>`;
  }
  return html;
}

interface FitState {
  notes: BodyNotes;
  sentinels: Sentinels;
  hoisted: BodyRule[];
  /** What to do about the space the build writes between inline siblings: see {@link CollectionsOptions.inlineGaps}. */
  gaps: "report" | "innerHTML";
  /** Selectors whose rules differ from one entry to another: each entry's rule is scoped by a class of its own (see {@link ruleFor}). */
  scoped: ReadonlySet<string>;
  /** What the pages, layouts and components say about each class (see {@link ClassStyles}): an entry's rule that disagrees is written to win over theirs. */
  foreign: ReadonlyMap<string, ReadonlySet<string>>;
  /** The classes (`.name`) that some element of the body carries as other than its first: a rule for one reaches those elements too. */
  shared: ReadonlySet<string>;
}

/** The classes that an element carries after its first (`.featured-columns` in `columns-c474385 featured-columns`). */
function sharedClasses(nodes: readonly JxNode[]): Set<string> {
  const found = new Set<string>();
  const walk = (list: readonly JxNode[]): void => {
    for (const node of list) {
      if (!isEl(node)) continue;
      if (typeof node.className === "string") {
        for (const name of node.className.trim().split(/\s+/).slice(1)) found.add(`.${name}`);
      }
      walk(kidsOf(node));
    }
  };
  walk(nodes);
  return found;
}

/** Where an element sits: inside code (its colons are code), inside a table written as directives (its cells hold blocks). */
interface Where {
  literal: boolean;
  table: boolean;
  /** Inside a link, emphasis, paragraph or heading: the serializer writes everything below one as inline content, whatever it is. */
  inline: boolean;
  /** A child of a list written as a directive: its items are directives too (a Markdown item inside a directive reads back as a list in a list). */
  list: boolean;
}

/** The elements whose content the serializer writes as one line of text, even when it is blocks (`INLINE_CONTENT_TAGS` in the parser's serialize.ts). */
const INLINE_MODEL = new Set(["a", "em", "strong", "del", "p", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** The Markdown tags that are blocks: written inside a line of text they are lost, so they are written as directives there. */
const BLOCK_NATIVE = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "hr",
  "table",
]);

/** Whether the serializer writes `el` as Markdown (emphasis, a link, an image, a break) and not as a directive. */
const writtenNative = (el: JxElement): boolean => MD_ALL.has(tagOf(el)) && !hasJxProps(el);

/**
 * Whether a Markdown tag holds its content as `innerHTML` and nothing else. The serializer writes no
 * `innerHTML`, and a directive's attribute carries it, so such an element is written as a directive
 * (a paragraph or item whose HTML has a literal `${`, which no other form can carry).
 */
const carriesInnerHtml = (el: JxElement): boolean =>
  typeof el.innerHTML === "string" &&
  el.children === undefined &&
  el.textContent === undefined &&
  writtenNative(el);

/**
 * Put each run of inline nodes among `children` in a paragraph, where the reader would. Loose text and
 * Markdown inline markup directly inside a container are read back as a paragraph; an inline element
 * written as a directive is a block of its own there, and stays as it is when nothing but directives
 * is around it. An inline element that is alone in a container written as a directive (the image in a
 * `figure`) is written as a directive too, so that no paragraph, with its margins, is made around it.
 * Returns the children, how many paragraphs were made and how many elements were made directives.
 */
function wrapRuns(
  children: JxNode[],
  directiveHost: boolean,
): { out: JxNode[]; wrapped: number; alone: number } {
  const out: JxNode[] = [];
  let run: JxNode[] = [];
  let wrapped = 0;
  let alone = 0;
  const flush = (): void => {
    if (run.length === 0) return;
    const only = run.length === 1 && typeof run[0] !== "string" ? (run[0] as JxElement) : undefined;
    const needs = run.some((n) => (typeof n === "string" ? !BLANK.test(n) : writtenNative(n)));
    if (only && needs && directiveHost) {
      out.push({ ...only, style: isRec(only.style) ? only.style : {} } as JxElement);
      alone++;
    } else if (needs) {
      out.push({ tagName: "p", children: run });
      wrapped++;
    } else {
      // Blank text between blocks shows nothing, and the build puts its own between them.
      out.push(...run.filter((n) => typeof n !== "string"));
    }
    run = [];
  };
  for (const child of children) {
    if (isInline(child)) run.push(child);
    else {
      flush();
      out.push(child);
    }
  }
  flush();
  return { out, wrapped, alone };
}

/** Take the line breaks (and the blank text around them) off the end of `kids`; how many breaks went. */
function trimTrailingBreaks(kids: JxNode[]): number {
  let breaks = 0;
  for (;;) {
    const last = kids[kids.length - 1];
    if (last === undefined) break;
    if (typeof last === "string" ? BLANK.test(last) : tagOf(last) === "br") {
      if (typeof last !== "string") breaks++;
      kids.pop();
    } else break;
  }
  return breaks;
}

const HEADING = /^h[1-6]$/;

/** The selector the build writes an element's own `style` to: its `id`, else the first of its classes. */
const scopeOf = (el: JxElement): string | undefined => {
  if (typeof el.id === "string" && el.id !== "") return `#${el.id}`;
  const first = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  return first ? `.${first}` : undefined;
};

/** The class that names one set of declarations: the same declarations are the same class in every entry. */
const styleClass = (style: unknown): string =>
  `jx-${createHash("sha1").update(sortedJson(style)).digest("hex").slice(0, 10)}`;

/**
 * Whether the pages, layouts and components style `selector` (one class) otherwise than `style`. The live
 * page prints the template's stylesheet first and the post's after it, so a post's rule wins every
 * property it sets, on the template's elements as on its own; a Jx page orders the two by where their
 * elements are in the tree, and the template's element that comes after the body wins. And a rule an
 * entry moved to the project's `style` reaches every page that uses the class, where the live post's
 * stylesheet reached its own page only ({@link ruleFor}).
 */
const clashesWithPages = (state: FitState, selector: string, style: unknown): boolean => {
  // A class an element of this entry carries beside its own is shared: the rule of the one that owns it
  // reaches the others on the live page, which a class of the owner's alone would not.
  if (state.shared.has(selector)) return false;
  const theirs = state.foreign.get(selector);
  // A class they style one way and the entry the same way is no clash only when no other element of theirs styles it differently: a project rule reaches all of them.
  return theirs !== undefined && (theirs.size > 1 || !theirs.has(sortedJson(style)));
};

/** Whether two property names are one declaration at different widths (`padding`, `paddingBottom`). */
const sameFamily = (a: string, b: string): boolean =>
  a === b ||
  (b.startsWith(a) && /[A-Z]/.test(b[a.length] ?? "")) ||
  (a.startsWith(b) && /[A-Z]/.test(a[b.length] ?? ""));

/**
 * `own` cut in two against the styles the pages give the same class: `win` holds the declarations that a
 * page's rule also sets to another value (or at another width: `padding` against `paddingBottom`), which
 * the entry's must win; `keep` the rest, which nothing of theirs contradicts. Nested blocks (`@--sm`,
 * `& a`) are cut the same way, inside; a media block is read against the page's own block of that name
 * and against its top-level declarations too.
 */
function splitAgainst(own: Rec, theirs: readonly Rec[]): { win: Rec; keep: Rec } {
  const win: Rec = {};
  const keep: Rec = {};
  for (const [key, value] of Object.entries(own)) {
    if (isRec(value)) {
      // A media block of the entry's is also read against the page's rules written without one: they
      // come later in the page and, at the same specificity, beat a block of the project's style.
      const nested = theirs.flatMap((t) => {
        const own = t[key];
        const base = key.startsWith("@")
          ? Object.fromEntries(Object.entries(t).filter(([, v]) => !isRec(v)))
          : {};
        return [...(isRec(own) ? [own] : []), ...(hasKeys(base) ? [base] : [])];
      });
      if (nested.length === 0) {
        keep[key] = value;
        continue;
      }
      const inner = splitAgainst(value, nested);
      if (Object.keys(inner.win).length > 0) win[key] = inner.win;
      if (Object.keys(inner.keep).length > 0) keep[key] = inner.keep;
      continue;
    }
    const contradicted = theirs.some((t) =>
      Object.entries(t).some(
        ([name, v]) =>
          !isRec(v) && sameFamily(name, key) && (name !== key || String(v) !== String(value)),
      ),
    );
    if (contradicted) win[key] = value;
    else keep[key] = value;
  }
  return { win, keep };
}

/**
 * A declaration that won at the top level wins in the blocks too: the rule that holds it is one class
 * more specific than the element's own, so a media block of the same property left behind would never
 * override it (`display: grid` in the winning rule, `@--sm { display: flex }` below the media
 * threshold in the element's: the grid stays).
 */
function withBlocksOfWinners(win: Rec, keep: Rec): { win: Rec; keep: Rec } {
  const winners = Object.entries(win)
    .filter(([, v]) => !isRec(v))
    .map(([name]) => name);
  if (winners.length === 0) return { win, keep };
  const nextWin: Rec = { ...win };
  const nextKeep: Rec = {};
  for (const [key, value] of Object.entries(keep)) {
    if (!isRec(value)) {
      nextKeep[key] = value;
      continue;
    }
    const moved: Rec = {};
    const stays: Rec = {};
    for (const [name, v] of Object.entries(value)) {
      if (!isRec(v) && winners.some((w) => sameFamily(w, name))) moved[name] = v;
      else stays[name] = v;
    }
    if (hasKeys(moved)) nextWin[key] = { ...(isRec(nextWin[key]) ? nextWin[key] : {}), ...moved };
    if (hasKeys(stays)) nextKeep[key] = stays;
  }
  return { win: nextWin, keep: nextKeep };
}

/** `part` with its keys in the order `whole` has them, at every depth: a media block later in the object overrides one before it. */
function inOrderOf(part: Rec, whole: Rec): Rec {
  const out: Rec = {};
  for (const key of Object.keys(whole)) {
    if (!(key in part)) continue;
    const value = part[key];
    const model = whole[key];
    out[key] = isRec(value) && isRec(model) ? inOrderOf(value, model) : value;
  }
  return out;
}

function cutAgainst(own: Rec, theirs: readonly Rec[]): { win: Rec; keep: Rec } {
  const cut = splitAgainst(own, theirs);
  const closed = withBlocksOfWinners(cut.win, cut.keep);
  return { win: inOrderOf(closed.win, own), keep: inOrderOf(closed.keep, own) };
}

const stylesOf = (state: FitState, selector: string): Rec[] =>
  [...(state.foreign.get(selector) ?? [])].map((json) => JSON.parse(json) as Rec);

const hasKeys = (value: Rec): boolean => Object.keys(value).length > 0;

/**
 * The rules that hold an element's `style` at `selector`, and the classes the element needs for them. A
 * class id repeats from post to post with different declarations (a duplicated page keeps its block
 * ids), and project-level rules have one body per selector, so a selector that the entries disagree
 * about ({@link CollectionsOutput}'s `style.conflict`) is written for `selector:where(.jx-<hash of
 * the declarations>)`: `:where` adds no specificity, so the cascade is the one the live page had,
 * and each entry's element carries the class of its own declarations.
 *
 * A class that a page, layout or component also styles, with other declarations, is cut in two
 * ({@link splitAgainst}). What the pages' rule contradicts is written for `selector.jx-<hash>`, one
 * class more specific, so that the entry's wins it as the post's stylesheet does on the live page,
 * whatever the order of the elements. The rest keeps the specificity of a class, and is written for
 * `selector:where(.jx-<hash>)` so that it reaches the elements of this entry only (a rule of the
 * project's style reaches every page that has the class, and the live post's stylesheet reached its
 * own). `whole` is false for a part of an element's style, a custom property, which has no such clash.
 */
function ruleFor(
  state: FitState,
  selector: string,
  style: Rec,
  whole = true,
): { rules: BodyRule[]; classes: string[] } {
  const clash = whole && clashesWithPages(state, selector, style);
  const { win, keep } = clash
    ? cutAgainst(style, stylesOf(state, selector))
    : { win: {}, keep: style };
  const rules: BodyRule[] = [];
  const classes: string[] = [];
  if (hasKeys(win)) {
    const scopeClass = styleClass(win);
    rules.push({ selector: `${selector}.${scopeClass}`, style: win });
    classes.push(scopeClass);
    state.notes.isolated++;
  }
  if (hasKeys(keep) || !hasKeys(win)) {
    if (clash || state.scoped.has(selector)) {
      const scopeClass = styleClass(keep);
      rules.push({ selector: `${selector}:where(.${scopeClass})`, style: keep });
      classes.push(scopeClass);
      if (clash) state.notes.isolated++;
      else state.notes.scopedPerEntry++;
    } else rules.push({ selector, style: keep });
  }
  return { rules, classes };
}

/**
 * An element whose class a page, layout or component styles otherwise: the declarations of its `style`
 * that theirs contradicts move to a rule that wins over theirs ({@link ruleFor}), and the element
 * carries the class that rule needs. The rest stays on the element, where the build writes it to the
 * page's own style, which is where the live post's stylesheet put it.
 */
function isolateStyle(el: JxElement, out: Rec, state: FitState): void {
  const style = out.style;
  if (!isRec(style) || !hasKeys(style) || state.foreign.size === 0) return;
  const selector = scopeOf(el);
  if (selector === undefined || !selector.startsWith(".")) return;
  if (!clashesWithPages(state, selector, style)) return;
  const { win, keep } = cutAgainst(style, stylesOf(state, selector));
  if (!hasKeys(win)) return;
  const scopeClass = styleClass(win);
  state.hoisted.push({ selector: `${selector}.${scopeClass}`, style: win });
  state.notes.isolated++;
  out.className = withClass(out.className, scopeClass);
  if (hasKeys(keep)) out.style = keep;
  else delete out.style;
}

const withClass = (className: unknown, add: string): string =>
  typeof className === "string" && className !== "" ? `${className} ${add}` : add;

/**
 * A custom property in an element's `style` (`--cc-gallery-height`, `--background-image`) cannot be
 * written as Markdown: the reader takes every top-level `--name` for a media query (`$media` keys are
 * written the same way), so the value is lost without a word. The declaration moves to a rule of the
 * element's own scope, which is where the build would have written it, and the project's style carries it.
 */
function hoistCustomProperties(el: JxElement, out: Rec, state: FitState): void {
  if (!isRec(el.style)) return;
  const entries = Object.entries(el.style);
  const isCustom = ([key, value]: [string, unknown]): boolean =>
    key.startsWith("--") && !isRec(value);
  const custom = entries.filter(isCustom);
  if (custom.length === 0) return;
  const rest = Object.fromEntries(entries.filter((entry) => !isCustom(entry)));
  const selector = scopeOf(el);
  if (selector === undefined) {
    state.notes.styleLost.push(...custom.map(([key]) => key));
  } else {
    const { rules, classes } = ruleFor(
      state,
      selector,
      Object.fromEntries(custom.map(([key, value]) => [key, String(value)])),
      false,
    );
    state.hoisted.push(...rules);
    if (classes.length > 0) out.className = withClass(out.className, classes.join(" "));
    state.notes.hoisted += custom.length;
  }
  if (Object.keys(rest).length > 0) out.style = rest;
  else delete out.style;
}

/**
 * Component properties as a directive writes them: every value is a string. A number and `true` are
 * the text they print as; `false`, `null` and a list have no such form and are left out (the
 * component's default applies), and said.
 */
function fitProps(props: Rec, state: FitState, path = "props"): Rec {
  const out: Rec = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string") out[key] = degradeTemplate(value);
    else if (typeof value === "number" || value === true) {
      out[key] = String(value);
      state.notes.propsStringified++;
    } else if (Array.isArray(value) || value === false || value === null || value === undefined)
      state.notes.propsLost.push(`${path}.${key}`);
    else if (isRec(value)) {
      const inner = fitProps(value, state, `${path}.${key}`);
      if (Object.keys(inner).length > 0) out[key] = inner;
    }
  }
  return out;
}

/** The attributes of a directive: a `false` or empty value is no attribute, `true` is a bare one. */
function fitAttributes(attributes: Rec): Rec {
  const out: Rec = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    out[name] = value === true ? "" : value;
  }
  return out;
}

/**
 * What the reader does to an element that a directive writes, which the element has to be put in the
 * form of first. For a custom element (a component instance) the reader makes `className`, `id` and
 * every other key but `style`, `children` and the `$` ones an HTML attribute, so the element is given
 * them as attributes (`class`, `id`), and its `style`, which the build would write to a class of its
 * own beside the `class` attribute (two `class` attributes, of which the browser keeps the first), moves
 * to a rule of the element's own scope. For any other element an `id` or `className` given as an
 * attribute is read back as the element's own, which scopes its style by `#id`: a style the element has
 * moves to its class first. A component's properties are strings (see {@link fitProps}).
 */
function prepare(input: JxElement, state: FitState): JxElement {
  const tag = tagOf(input);
  const custom = tag.includes("-");
  const attributes = isRec(input.attributes) ? input.attributes : undefined;
  // The build gives every heading of an entry an id of its own, made of its text, and writes the
  // heading's own style to `#that-id` (an id that starts with a digit is no selector at all, and it
  // outweighs every class rule): a styled heading keeps its style on its class, as an element with an id does.
  const styledHeading =
    HEADING.test(tag) &&
    typeof input.className === "string" &&
    input.className.trim() !== "" &&
    (typeof input.id !== "string" || input.id === "") &&
    isRec(input.style) &&
    Object.keys(input.style).length > 0;
  if (!custom && !attributes && !isRec(input.$props) && !styledHeading) return input;
  const out: Rec = { ...input };
  const attrs: Rec = attributes ? { ...attributes } : {};
  /** Moves the style to the rule of `scope`'s selector; the class that rule needs, if any, is returned. */
  const scopeStyle = (scope: JxElement): string | undefined => {
    if (!isRec(out.style) || Object.keys(out.style).length === 0) return undefined;
    const selector = scopeOf(scope);
    if (selector === undefined) return undefined;
    const { rules, classes } = ruleFor(state, selector, out.style);
    state.hoisted.push(...rules);
    state.notes.scoped++;
    delete out.style;
    return classes.length > 0 ? classes.join(" ") : undefined;
  };
  if (custom) {
    if (typeof out.className === "string" && out.className !== "") {
      attrs.class =
        typeof attrs.class === "string" ? `${out.className} ${attrs.class}` : out.className;
    }
    delete out.className;
    if (typeof out.id === "string" && out.id !== "") attrs.id = out.id;
    delete out.id;
    for (const key of ["lang", "dir", "title", "hidden", "tabIndex"]) {
      if (key in out) {
        attrs[key === "tabIndex" ? "tabindex" : key] = out[key];
        delete out[key];
      }
    }
    // The rule the build would have written for the element as it was: `#id` for an element's own id, else its first class.
    const scopeClass = scopeStyle(input);
    if (scopeClass !== undefined) attrs.class = withClass(attrs.class, scopeClass);
  } else {
    let movedId = false;
    for (const key of ["id", "className"] as const) {
      if (typeof attrs[key] === "string" && attrs[key] !== "" && out[key] === undefined) {
        out[key] = attrs[key];
        movedId ||= key === "id";
        delete attrs[key];
      }
    }
    if ((movedId || styledHeading) && typeof out.className === "string" && out.className !== "") {
      const scopeClass = scopeStyle({ tagName: tag, className: out.className });
      if (scopeClass !== undefined) out.className = withClass(out.className, scopeClass);
    }
  }
  const kept = fitAttributes(attrs);
  if (Object.keys(kept).length > 0) out.attributes = kept;
  else delete out.attributes;
  if (isRec(out.$props)) out.$props = fitProps(out.$props, state);
  return out as JxElement;
}

/**
 * One element, put in the form the serializer writes and the reader reads back unchanged. A copy: the
 * input is not touched.
 */
function fitElement(input: JxElement, state: FitState, where: Where): JxElement | undefined {
  const el = prepare(input, state);
  const tag = tagOf(el);
  const out: Rec = { ...el };
  const fence = tag === "pre" && !hasJxProps(el);
  const literal = where.literal || tag === "code" || fence;
  let table = where.table;
  let force = false;
  if (tag === "table") {
    table = !tableIsNative(el);
    if (table) {
      force = true;
      state.notes.tables++;
    }
  } else if (table && TABLE_PARTS.has(tag)) force = true;
  if (imageNeedsDirective(el)) {
    force = true;
    state.notes.images++;
  }
  if (hasExtraAttributes(el)) {
    force = true;
    state.notes.attributes++;
  }
  // The serializer writes no `innerHTML`, and a directive's attribute carries it: a Markdown tag that
  // holds its content that way (a paragraph or item whose HTML has a literal `${`) is a directive.
  if (carriesInnerHtml(el)) force = true;
  if (tag === "a" && !hasJxProps(el) && kidsOf(el).some((kid) => !isInline(kid))) {
    force = true;
    state.notes.links++;
  }
  // A link with no address has no Markdown form (`[text]()` reads back with an empty `href`).
  if (tag === "a" && !hasJxProps(el) && el.attributes?.href === undefined) force = true;
  // One item with a class, or a class on the list, makes the list and every item directives.
  const listDirect =
    (tag === "ul" || tag === "ol") &&
    (hasJxProps(el) ||
      kidsOf(el).some(
        (item) =>
          isEl(item) &&
          tagOf(item) === "li" &&
          (hasJxProps(item) || hasExtraAttributes(item) || carriesInnerHtml(item)),
      ));
  if ((listDirect && !hasJxProps(el)) || (where.list && tag === "li" && !hasJxProps(el))) {
    force = true;
    state.notes.lists++;
  }
  if (where.inline && BLOCK_NATIVE.has(tag) && !hasJxProps(el)) {
    force = true;
    state.notes.inlineBlocks++;
  }

  hoistCustomProperties(el, out, state);
  isolateStyle(el, out, state);
  // An empty `style` is a property the serializer counts: it writes the element as a directive, which
  // carries every attribute, and writes no attribute for it.
  if (force && !isRec(out.style)) out.style = {};

  // Below a link or emphasis the serializer writes every element as a text directive, whose content
  // is inline: nothing there is put in a paragraph, and the reader makes none.
  let carried: string | undefined;
  const inlineHost = INLINE_HOSTS.has(tag) || fence || where.inline;
  // A cell of a table written as directives holds blocks, like every container.
  const cell = table && (tag === "td" || tag === "th");

  if (typeof el.textContent === "string") {
    const text = fixText(el.textContent, state.sentinels, state.notes, {
      code: literal,
      lineStart: true,
    });
    if ((!inlineHost || cell) && !BLANK.test(text) && el.children === undefined) {
      // The serializer writes the text of a container as a paragraph, and the reader reads one back.
      delete out.textContent;
      out.children = [{ tagName: "p", textContent: text }];
      state.notes.wrapped[tag] = (state.notes.wrapped[tag] ?? 0) + 1;
    } else out.textContent = text;
  }

  if (Array.isArray(el.children)) {
    let kids = fitList(mergeColonSpans(el.children, state.notes), state, {
      literal,
      table,
      inline: where.inline || INLINE_MODEL.has(tag),
      list: listDirect,
    });
    if (LINE_HOSTS.has(tag) && !fence) {
      const breaks = trimTrailingBreaks(kids);
      if (breaks > 0) {
        // The last break of a block shows nothing; each one before it shows a blank line, and a block
        // that is nothing but breaks shows one line for each. A Markdown hard break at the end of a
        // block reads back as a backslash, so those lines are written as lines holding a no-break space.
        const showsLines = DROP_WHEN_EMPTY.has(tag) && el.textContent === undefined;
        const blank = state.sentinels.blank;
        const lines =
          showsLines && blank !== undefined ? (kids.length === 0 ? breaks : breaks - 1) : 0;
        for (let line = 0; line < lines; line++) {
          if (kids.length > 0) kids.push({ tagName: "br" });
          kids.push(blank!);
        }
        state.notes.breaks += breaks - lines;
        state.notes.breaksKept += lines;
        if (kids.length === 0 && showsLines) {
          state.notes.emptyBlocks++;
          return undefined;
        }
      }
    }
    if (!inlineHost || cell) {
      // (A cell is a directive whose content the serializer writes as one line, like a paragraph's.)
      const container =
        (hasJxProps(out as JxElement) || !MD_ALL.has(tag)) &&
        !INLINE_MODEL.has(tag) &&
        tag !== "td" &&
        tag !== "th";
      const wrapped = wrapRuns(kids, container);
      kids = wrapped.out;
      if (wrapped.wrapped > 0) {
        state.notes.wrapped[tag] = (state.notes.wrapped[tag] ?? 0) + wrapped.wrapped;
      }
      state.notes.alone += wrapped.alone;
    }
    const html =
      state.gaps === "innerHTML" &&
      tag === "p" &&
      !where.inline &&
      kids.length > 0 &&
      kids.every(isInline) &&
      inlineGaps(kids).length > 0
        ? nodesToHtml(expectedTree(kids, state.sentinels))
        : undefined;
    if (html === undefined) out.children = kids;
    else {
      // The paragraph keeps its text and markup as one piece of HTML, which the build writes as it is.
      delete out.children;
      carried = html;
      state.notes.innerHtmlParagraphs++;
      if (!isRec(out.style)) out.style = {};
    }
  }

  if (isRec(el.attributes)) {
    const attributes: Rec = {};
    for (const [name, value] of Object.entries(el.attributes)) {
      attributes[name] = typeof value === "string" ? degradeTemplate(value) : value;
    }
    out.attributes = attributes;
  }
  if (typeof out.className === "string") out.className = degradeTemplate(out.className);
  if (typeof el.id === "string") out.id = degradeTemplate(el.id);

  // The serializer carries a Markdown link's address and title and an image's source, alt and title; an
  // element that has any other key is written as a directive, which carries every attribute.
  const directive = hasJxProps(out as JxElement) || !MD_ALL.has(tag);
  if (!directive && isRec(out.attributes)) {
    const native = NATIVE_ATTRIBUTES[tag];
    const kept: Rec = {};
    for (const [name, value] of Object.entries(out.attributes)) {
      if (!native?.includes(name)) state.notes.attributesDropped.push(`${tag}:${name}`);
      else if (typeof value === "string" && (name === "alt" || name === "title")) {
        // A Markdown image's alt text and a title are text the reader reads directives in.
        kept[name] = fixText(value, state.sentinels, state.notes);
      } else kept[name] = value;
    }
    if (Object.keys(kept).length > 0) out.attributes = kept;
    else delete out.attributes;
  }

  // The serializer writes no `innerHTML`; a directive's attribute reads back as one.
  if (typeof el.innerHTML === "string") {
    if (directive && el.children === undefined && el.textContent === undefined) {
      state.notes.innerHtml++;
      delete out.innerHTML;
      out.attributes = {
        ...(isRec(out.attributes) ? out.attributes : {}),
        [INNER_KEY]: escapeInner(el.innerHTML),
      };
    } else {
      state.notes.innerHtmlLost.push(tag);
      delete out.innerHTML;
    }
  }
  if (carried !== undefined) {
    out.attributes = {
      ...(isRec(out.attributes) ? out.attributes : {}),
      [INNER_KEY]: escapeInner(carried),
    };
  }
  // An element with nothing in it, as an editor leaves behind, shows nothing: Markdown has no spelling for it.
  if (
    tag === "p" &&
    !hasJxProps(out as JxElement) &&
    (out.children === undefined ||
      (out.children as JxNode[]).every((kid) => typeof kid === "string" && BLANK.test(kid))) &&
    out.textContent === undefined &&
    out.innerHTML === undefined &&
    out.attributes === undefined
  ) {
    state.notes.emptyBlocks++;
    return undefined;
  }
  return out as JxElement;
}

/** Adjacent strings are one text: a browser shows them as one, and the reader makes them one. */
function mergeStrings(nodes: readonly JxNode[]): JxNode[] {
  const out: JxNode[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (typeof node === "string" && typeof last === "string") out[out.length - 1] = last + node;
    else out.push(node);
  }
  return out;
}

function fitList(nodes: JxNode[], state: FitState, where: Where): JxNode[] {
  const out: JxNode[] = [];
  const list = mergeStrings(nodes);
  for (const [i, node] of list.entries()) {
    if (typeof node === "string") {
      // Text begins a line at the start of its container, after a block and after a break.
      const before = list[i - 1];
      const lineStart =
        before === undefined || !isInline(before) || (isEl(before) && tagOf(before) === "br");
      out.push(fixText(node, state.sentinels, state.notes, { code: where.literal, lineStart }));
      continue;
    }
    const fitted = fitElement(node, state, where);
    if (!fitted) continue;
    // A colon that ends a text is followed by `:name` where the element is written as a text
    // directive, and `::name` is a leaf directive to the reader: the colon is the escape that reads
    // back as a colon, which a directive may follow.
    const last = out[out.length - 1];
    if (
      typeof last === "string" &&
      last.endsWith(":") &&
      !where.literal &&
      !writtenNative(fitted) &&
      (isInline(fitted) || where.inline)
    ) {
      out[out.length - 1] = last.slice(0, -1) + state.sentinels.colon;
      state.notes.colons++;
    }
    out.push(fitted);
  }
  return out;
}

/**
 * A body in the form the serializer writes and the reader reads back as the same tree (see
 * {@link BodyNotes} for what that takes), and the rules that could not stay on their elements.
 */
export function fitBody(
  nodes: readonly JxNode[],
  sentinels: Sentinels = { colon: SENTINELS[0], newline: SENTINELS[1] },
  gaps: "report" | "innerHTML" = "report",
  scoped: ReadonlySet<string> = new Set(),
  foreign: ClassStyles = new Map(),
): { nodes: JxNode[]; notes: BodyNotes; hoisted: BodyRule[] } {
  const notes = emptyNotes();
  const state: FitState = {
    notes,
    sentinels,
    hoisted: [],
    gaps,
    scoped,
    foreign,
    shared: foreign.size === 0 ? new Set() : sharedClasses(nodes),
  };
  const merged = hoistEdgeSpace(mergeColonSpans(structuredClone(nodes) as JxNode[], notes), notes);
  const fitted = fitList(merged, state, {
    literal: false,
    table: false,
    inline: false,
    list: false,
  });
  const { out, wrapped } = wrapRuns(fitted, false);
  if (wrapped > 0) notes.wrapped.root = (notes.wrapped.root ?? 0) + wrapped;
  return { nodes: out, notes, hoisted: state.hoisted };
}

/** Elements the serializer writes between two stars or tildes: a space beside the marker ends the emphasis (CommonMark), so it would be written as a character reference. */
const EMPHASIS = new Set(["em", "strong", "del"]);

/**
 * Space characters, a no-break space included (CommonMark does not open emphasis before one either),
 * and not the byte order mark or a zero-width space, which JavaScript counts as white space and which
 * show nothing: an emphasis that holds only one keeps it.
 */
const SPACES = "[ \\t\\n\\r\\f\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const LEADING_SPACE = new RegExp(`^${SPACES}+`);
const TRAILING_SPACE = new RegExp(`${SPACES}+$`);

/**
 * Emphasis with a space at its edge (`<em>sound </em>of`), written with the space outside it: the
 * browser shows the same, and the serializer, which cannot put a space beside a star, would write a
 * character reference for it and for the letter after it (`*sound&#x20;*&#x6F;f`), which no one can
 * edit by hand. Returns the list with each such element's edge spaces as text beside it. Code is left
 * as it is (its white space is content).
 */
function hoistEdgeSpace(list: readonly JxNode[], notes: BodyNotes): JxNode[] {
  const out: JxNode[] = [];
  const push = (text: string): void => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (typeof last === "string") out[out.length - 1] = last + text;
    else out.push(text);
  };
  for (const node of list) {
    if (!isEl(node) || tagOf(node) === "pre") {
      out.push(node);
      continue;
    }
    let el = node;
    if (Array.isArray(el.children)) {
      el = { ...el, children: hoistEdgeSpace(el.children, notes) };
    }
    if (!EMPHASIS.has(tagOf(el)) || hasJxProps(el)) {
      out.push(el);
      continue;
    }
    let lead = "";
    let trail = "";
    if (typeof el.textContent === "string" && el.children === undefined) {
      const text = el.textContent;
      lead = LEADING_SPACE.exec(text)?.[0] ?? "";
      trail = lead === text ? "" : (TRAILING_SPACE.exec(text)?.[0] ?? "");
      el = { ...el, textContent: text.slice(lead.length, text.length - trail.length) };
    } else if (Array.isArray(el.children)) {
      const kids = [...el.children];
      while (typeof kids[0] === "string") {
        const found = LEADING_SPACE.exec(kids[0])?.[0] ?? "";
        lead += found;
        kids[0] = kids[0].slice(found.length);
        if (kids[0] !== "") break;
        kids.shift();
      }
      while (typeof kids[kids.length - 1] === "string") {
        const text = kids[kids.length - 1] as string;
        const found = TRAILING_SPACE.exec(text)?.[0] ?? "";
        trail = found + trail;
        kids[kids.length - 1] = text.slice(0, text.length - found.length);
        if (kids[kids.length - 1] !== "") break;
        kids.pop();
      }
      el = { ...el, children: kids };
    }
    if (lead === "" && trail === "") {
      out.push(el);
      continue;
    }
    notes.edgeSpaces++;
    push(lead);
    const empty =
      (el.textContent === undefined || el.textContent === "") &&
      (el.children === undefined || (Array.isArray(el.children) && el.children.length === 0));
    if (!empty) out.push(el);
    push(trail);
  }
  return out;
}

/** Sentinels that appear nowhere in the body, so replacing them afterwards can only touch what {@link fixText} put there. */
export function sentinelsFor(nodes: readonly JxNode[]): Sentinels {
  const text = JSON.stringify(nodes);
  const free = SENTINELS.filter((candidate) => !text.includes(candidate));
  if (free.length < 2)
    throw new Error(
      "the body uses the private-use characters the serializer's stand-ins come from",
    );
  return { colon: free[0]!, newline: free[1]!, ...(free.length > 2 ? { blank: free[2]! } : {}) };
}

/** The Markdown of a fitted body: the serializer's output with the sentinels written as the escape that keeps a colon text, and the `innerHTML` attribute named as the reader expects. */
export function writeBody(nodes: readonly JxNode[], sentinels: Sentinels): string {
  if (nodes.length === 0) return "";
  const md = serializeJxMarkdown(
    { children: nodes as JxNode[] },
    { mode: "roundtrip", frontmatter: false },
  );
  const written = md
    .replaceAll(sentinels.colon, "\\:")
    .replaceAll(sentinels.newline, "\n")
    .replaceAll(INNER_ATTRIBUTE, "$1innerHTML=");
  return sentinels.blank === undefined ? written : written.replaceAll(sentinels.blank, "&#xA0;");
}

/** The tree a fitted body means: the sentinels are colons again and the carried `innerHTML` is back on its element. */
export function expectedTree(nodes: readonly JxNode[], sentinels: Sentinels): JxNode[] {
  const text = (s: string): string => {
    const plain = s.replaceAll(sentinels.colon, ":").replaceAll(sentinels.newline, "\n");
    return sentinels.blank === undefined ? plain : plain.replaceAll(sentinels.blank, "\u00a0");
  };
  const walk = (node: JxNode): JxNode => {
    if (typeof node === "string") return text(node);
    const out: Rec = { ...node };
    if (typeof node.textContent === "string") out.textContent = text(node.textContent);
    if (Array.isArray(node.children)) out.children = node.children.map(walk);
    if (isRec(node.attributes)) {
      // (A native image's alt and title are text too: they carry the colon stand-in.)
      const { [INNER_KEY]: html, ...rest } = node.attributes;
      for (const [name, value] of Object.entries(rest)) {
        if (typeof value === "string") rest[name] = text(value);
      }
      if (INNER_KEY in node.attributes) out.innerHTML = unescapeInner(String(html));
      if (Object.keys(rest).length > 0) out.attributes = rest;
      else delete out.attributes;
    }
    return out as JxElement;
  };
  return nodes.map(walk);
}

// ── Comparing two trees the way a browser would ─────────────────────────────────────────────────

/** A node reduced to what a reader sees: see {@link canonNodes}. */
export type CNode = string | CEl;

export interface CEl {
  tag: string;
  id?: string;
  cls?: string;
  attrs?: Record<string, string>;
  style?: unknown;
  other?: Rec;
  kids: CNode[];
}

const COLLAPSE = /[ \t\n\r\f]+/g;

const stringLeaves = (value: unknown): unknown =>
  isRec(value)
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stringLeaves(v)]))
    : Array.isArray(value)
      ? value.map(stringLeaves)
      : String(value);

/** A link whose text is its own address: what the reader makes of an address in text (GFM's autolink literal). */
const isAutolink = (el: CEl): string | undefined => {
  if (el.tag !== "a" || el.id !== undefined || el.cls !== undefined || el.style !== undefined)
    return undefined;
  if (el.other !== undefined || el.kids.length !== 1 || typeof el.kids[0] !== "string")
    return undefined;
  const keys = Object.keys(el.attrs ?? {});
  if (keys.length !== 1 || keys[0] !== "href") return undefined;
  const text = el.kids[0];
  const href = el.attrs!.href!;
  return href === text || href === `http://${text}` || href === `mailto:${text}` ? text : undefined;
};

/**
 * Nodes as a browser would show them, for comparing the tree a body was written from with the tree
 * read back from the file. Text content and a single text child are the same; runs of white space are
 * one space (outside `pre` and `code`) and the white space at the edges of a block, or between blocks,
 * shows nothing; every attribute value is a string; a link whose text is its address is that text.
 */
export function canonNodes(nodes: readonly JxNode[], block = true, raw = false): CNode[] {
  const items: CNode[] = [];
  const push = (node: CNode): void => {
    const last = items[items.length - 1];
    if (typeof node === "string" && typeof last === "string") items[items.length - 1] = last + node;
    else items.push(node);
  };
  for (const node of nodes) {
    if (typeof node === "string") {
      push(raw ? node : node.replace(COLLAPSE, " "));
      continue;
    }
    const el = canonEl(node, raw);
    const text = isAutolink(el);
    if (text === undefined) push(el);
    else push(text);
  }
  const out = items.filter((n) => n !== "");
  if (block && !raw) {
    // The white space of a block's edges, and white space between its blocks, is not shown.
    const isBlockEl = (n: CNode | undefined): boolean =>
      n !== undefined && typeof n !== "string" && !PHRASING.has(n.tag);
    const kept: CNode[] = [];
    for (const [i, n] of out.entries()) {
      if (typeof n === "string") {
        let text = n;
        if (i === 0 || isBlockEl(out[i - 1])) text = text.replace(/^[ \u00a0]+/, "");
        if (i === out.length - 1 || isBlockEl(out[i + 1])) text = text.replace(/[ \u00a0]+$/, "");
        if (text !== "") kept.push(text);
      } else kept.push(n);
    }
    return kept;
  }
  return out;
}

function canonEl(el: JxElement, rawParent: boolean): CEl {
  const tag = tagOf(el);
  const raw = rawParent || tag === "pre" || tag === "code";
  const kids: JxNode[] = [];
  if (el.textContent != null) kids.push(String(el.textContent));
  kids.push(...kidsOf(el));
  const out: CEl = {
    tag,
    kids: canonNodes(kids, !PHRASING.has(tag), raw),
  };
  const attrs: Record<string, string> = {};
  if (isRec(el.attributes)) {
    for (const [k, v] of Object.entries(el.attributes)) attrs[k] = String(v);
  }
  if (el.title != null) attrs.title = String(el.title);
  if (Object.keys(attrs).length > 0) out.attrs = attrs;
  if (typeof el.id === "string" && el.id !== "") out.id = el.id;
  if (typeof el.className === "string" && el.className !== "") out.cls = el.className;
  if (isRec(el.style) && Object.keys(el.style).length > 0) out.style = stringLeaves(el.style);
  const other: Rec = {};
  for (const [k, v] of Object.entries(el)) {
    if (!PLAIN_KEYS.has(k) && k !== "id" && k !== "className" && k !== "style" && k !== "title") {
      other[k] = v;
    }
  }
  if (typeof el.innerHTML === "string") other.innerHTML = el.innerHTML;
  if (Object.keys(other).length > 0) out.other = other;
  return out;
}

export interface TreeDiff {
  /** Where, as tags and sibling positions: `p[3]>a[1]`. */
  path: string;
  kind: "text" | "tag" | "attribute" | "style" | "children" | "other";
  detail: string;
}

const short = (text: string): string => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

const sameJson = (a: unknown, b: unknown): boolean => sortedJson(a) === sortedJson(b);

/** What differs between two canonical trees. A parent whose children differ in number is one difference: its children no longer line up. */
export function treeDiff(a: readonly CNode[], b: readonly CNode[], at = ""): TreeDiff[] {
  if (a.length !== b.length) {
    return [
      {
        path: at === "" ? "(root)" : at,
        kind: "children",
        detail: `${a.length} children became ${b.length}: ${short(describeKids(a))} / ${short(describeKids(b))}`,
      },
    ];
  }
  const out: TreeDiff[] = [];
  for (const [i, x] of a.entries()) {
    const y = b[i]!;
    const here = `${at === "" ? "" : `${at}>`}${typeof x === "string" ? "text" : x.tag}[${i}]`;
    if (typeof x === "string" || typeof y === "string") {
      if (x !== y) {
        out.push({
          kind: typeof x === "string" && typeof y === "string" ? "text" : "tag",
          path: here,
          detail:
            typeof x === "string" && typeof y === "string"
              ? `"${short(x)}" became "${short(y)}"`
              : `${typeof x === "string" ? "text" : `<${x.tag}>`} became ${typeof y === "string" ? "text" : `<${y.tag}>`}`,
        });
      }
      continue;
    }
    if (x.tag !== y.tag) {
      out.push({ kind: "tag", path: here, detail: `<${x.tag}> became <${y.tag}>` });
      continue;
    }
    if (!sameJson(x.attrs ?? {}, y.attrs ?? {}) || x.id !== y.id || x.cls !== y.cls) {
      out.push({
        kind: "attribute",
        path: here,
        detail: `${short(JSON.stringify({ a: x.attrs, id: x.id, cls: x.cls }))} became ${short(JSON.stringify({ a: y.attrs, id: y.id, cls: y.cls }))}`,
      });
    }
    if (!sameJson(x.style ?? null, y.style ?? null)) {
      out.push({ kind: "style", path: here, detail: "style differs" });
    }
    if (!sameJson(x.other ?? null, y.other ?? null)) {
      out.push({ kind: "other", path: here, detail: short(JSON.stringify(x.other)) });
    }
    out.push(...treeDiff(x.kids, y.kids, here));
  }
  return out;
}

const describeKids = (kids: readonly CNode[]): string =>
  kids.map((k) => (typeof k === "string" ? JSON.stringify(k) : `<${k.tag}>`)).join(" ");

// ── The space the build writes between inline siblings ──────────────────────────────────────────

/** A white-space character the browser collapses; the build's own separator is one. */
const COLLAPSIBLE = /[ \t\n\r\f]/;

/** The character at one edge of what a node shows: a space for a break, a placeholder for something with no text (an image), undefined for nothing at all. */
function edge(node: JxNode, which: "first" | "last"): string | undefined {
  if (typeof node === "string")
    return node === "" ? undefined : node[which === "first" ? 0 : node.length - 1];
  const tag = tagOf(node);
  if (tag === "br" || tag === "wbr") return " ";
  if (typeof node.textContent === "string" && node.textContent !== "")
    return edge(node.textContent, which);
  const kids = kidsOf(node);
  const order = which === "first" ? kids : [...kids].reverse();
  for (const kid of order) {
    const found = edge(kid, which);
    if (found !== undefined) return found;
  }
  if (typeof node.innerHTML === "string") {
    const text = node.innerHTML.replace(/<[^>]*>/g, "");
    if (text !== "") return text[which === "first" ? 0 : text.length - 1];
  }
  return "\u0000";
}

export interface InlineGap {
  /** The text on both sides of the boundary: `…the 20|th century…`. */
  at: string;
}

/**
 * The boundaries between inline siblings that have no white space on either side. The Jx build joins
 * the children of an element with a newline and two spaces, which a browser shows as one space: `20`
 * and `<sup>th</sup>` come out as `20 th`, and `link</a>.` as `link .`. A boundary that already has
 * white space on one side loses nothing, and neither does one beside a line break or between blocks.
 */
export function inlineGaps(nodes: readonly JxNode[]): InlineGap[] {
  const gaps: InlineGap[] = [];
  const check = (children: readonly JxNode[]): void => {
    for (let i = 0; i + 1 < children.length; i++) {
      const a = children[i]!;
      const b = children[i + 1]!;
      if (!isInline(a) || !isInline(b)) continue;
      const last = edge(a, "last");
      const first = edge(b, "first");
      if (last === undefined || first === undefined) continue;
      if (COLLAPSIBLE.test(last) || COLLAPSIBLE.test(first)) continue;
      gaps.push({ at: `${textTail(a)}|${textHead(b)}` });
    }
  };
  const walk = (list: readonly JxNode[]): void => {
    check(list);
    for (const node of list) if (isEl(node)) walk(kidsOf(node));
  };
  walk(nodes);
  return gaps;
}

const textOf = (node: JxNode): string =>
  typeof node === "string"
    ? node
    : typeof node.textContent === "string"
      ? node.textContent
      : kidsOf(node).map(textOf).join("");
const textTail = (node: JxNode): string => textOf(node).slice(-14);
const textHead = (node: JxNode): string => textOf(node).slice(0, 14);

// ── Reading a file back ─────────────────────────────────────────────────────────────────────────

/**
 * An address, an `www.` name or an e-mail address in text: the reader makes each a link (GFM's autolink
 * literals). An e-mail address is read from the start of a run of word characters only (a match that
 * began inside the run would have to read to its end again, which is quadratic in the length of a long
 * token: a pasted base64 blob).
 */
const AUTOLINK =
  /(?:https?:\/\/|www(?=\.))[-.\w]+[^\s<]*|(?<![-.\w+])[-.\w+]+@[-\w]+(?:\.[-\w]+)+/gi;

/** How many addresses sit in the text of `nodes` outside links and code: each is read back as a link. */
export function autolinkable(nodes: readonly JxNode[]): number {
  let n = 0;
  const walk = (list: readonly JxNode[], skip: boolean): void => {
    for (const node of list) {
      if (typeof node === "string") {
        if (!skip) n += node.match(AUTOLINK)?.length ?? 0;
        continue;
      }
      const tag = tagOf(node);
      const inside = skip || tag === "a" || tag === "code" || tag === "pre";
      if (typeof node.textContent === "string" && !inside)
        n += node.textContent.match(AUTOLINK)?.length ?? 0;
      walk(kidsOf(node), inside);
    }
  };
  walk(nodes, false);
  return n;
}

// ── The file: frontmatter, then the body ────────────────────────────────────────────────────────

const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** A value with the keys of every object in order and nothing undefined: the same data always writes the same bytes. */
export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isRec(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(byKey)
        .map(([k, v]): [string, unknown] => [k, sortDeep(v)]),
    );
  }
  return value;
}

/** A string `js-yaml` (the reader's parser) would take for something that is not text if it were written plain: a number, a date, a flag, a null. */
const NEEDS_QUOTES = /^[-+.~0-9<=\s]|\s$|^(?:true|false|null|yes|no|on|off|y|n)$/i;

/** A line that ends in a space or tab: a block scalar keeps it, an editor that trims lines does not. */
const TRAILING_BLANK = /[ \t]$/m;

/**
 * The YAML of an entry's data. Plain where that reads back as the same string, double-quoted where it
 * would not (`2024-02-15` is a `Date` to the reader, `1_000` a number); `quoted` quotes every string,
 * the fallback when a value still does not read back.
 */
export function frontmatterYaml(data: Rec, quoted = false): string {
  const doc = new Document(sortDeep(data));
  visit(doc, {
    Scalar(key, node) {
      if (key === "key" || typeof node.value !== "string") return;
      if (quoted || NEEDS_QUOTES.test(node.value) || TRAILING_BLANK.test(node.value)) {
        node.type = "QUOTE_DOUBLE";
      }
    },
  });
  // A double-quoted string longer than 40 characters is otherwise folded over lines, an escaped space
  // standing in for a blank one, which `js-yaml` does not read back as it was written.
  return doc.toString({
    lineWidth: 0,
    doubleQuotedAsJSON: true,
    doubleQuotedMinMultiLineLength: Number.MAX_SAFE_INTEGER,
  });
}

/** The entry file: frontmatter between `---` lines, a blank line, then the body (nothing at all for an entry the template renders from its data). */
export const entryFile = (yaml: string, body: string): string =>
  `---\n${yaml}---\n${body === "" ? "" : `\n${body}`}`;

/** A date the reader gave back as a `Date` is the instant it was written as (the loader makes it RFC 3339 the same way). */
const plainData = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (Array.isArray(value)) return value.map(plainData);
  if (isRec(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]): [string, unknown] => [k, plainData(v)]),
    );
  }
  return value;
};

/** Where two frontmatter objects differ, as key paths (the first few). */
function dataDiff(a: unknown, b: unknown, at = ""): string[] {
  if (isRec(a) && isRec(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].sort().flatMap((k) => dataDiff(a[k], b[k], `${at}/${k}`));
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((v, i) => dataDiff(v, b[i], `${at}/${i}`));
  }
  return sortedJson(a) === sortedJson(b) ? [] : [at === "" ? "(root)" : at];
}

/** What reading an entry file back gives, to hold against what it was written from. */
export interface ReadBack {
  frontmatter: Rec;
  body: JxNode[];
}

export function readBack(file: string): ReadBack {
  const doc = transpileJxMarkdown(file) as Rec;
  const { children, ...frontmatter } = doc;
  return {
    frontmatter: plainData(frontmatter) as Rec,
    body: Array.isArray(children) ? (children as JxNode[]) : [],
  };
}

export interface Verdict {
  /** What differs between the tree the body was written from and the one read back. */
  tree: TreeDiff[];
  /** The frontmatter keys that do not read back as written. */
  frontmatter: string[];
  /** The gaps the build will write in the tree read back, which is the tree it builds (an address in text is a link there, with a boundary of its own). */
  gaps: InlineGap[];
}

/** Read `file` back and say what differs from the data and body it was written from, and how many list items and cells of the tree read back hold a paragraph. */
function checkFile(
  file: string,
  data: Rec,
  expected: readonly JxNode[],
): { verdict: Verdict; itemParagraphs: number } {
  let back: ReadBack;
  try {
    back = readBack(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      verdict: {
        tree: [{ path: "(file)", kind: "other", detail: `unreadable: ${message}` }],
        frontmatter: [],
        gaps: [],
      },
      itemParagraphs: 0,
    };
  }
  return {
    verdict: {
      tree: treeDiff(canonNodes(expected), canonNodes(back.body)),
      frontmatter: dataDiff(sortDeep(data), sortDeep(back.frontmatter)).slice(0, 12),
      gaps: inlineGaps(back.body),
    },
    itemParagraphs: itemParagraphs(back.body),
  };
}

/** Read `file` back and say what differs from the data and body it was written from. */
export const verifyFile = (file: string, data: Rec, expected: readonly JxNode[]): Verdict =>
  checkFile(file, data, expected).verdict;

/** Elements the reader puts a paragraph in when they hold text, and the theme's rules for `p` then reach. */
const ITEM_TAGS = new Set(["li", "td", "th", "dd"]);

/** How many list items and table cells in `nodes` hold a paragraph. */
export function itemParagraphs(nodes: readonly JxNode[]): number {
  let n = 0;
  const walk = (list: readonly JxNode[]): void => {
    for (const node of list) {
      if (!isEl(node)) continue;
      if (ITEM_TAGS.has(tagOf(node)) && kidsOf(node).some((k) => isEl(k) && tagOf(k) === "p")) n++;
      walk(kidsOf(node));
    }
  };
  walk(nodes);
  return n;
}

// ── The collections ─────────────────────────────────────────────────────────────────────────────

export interface CollectionsOptions {
  /**
   * The rewrite rules of post types registered in code, which neither ACF nor the site's own route
   * table knows (`RouteOptions.postTypes`): a type named here is routed, and so gets a collection.
   * Without it a plugin's type is reported `collection.unrouted` and left out.
   */
  routeTypes?: RouteOptions["postTypes"];
  /** The instant Rank Math's `%currentyear%` and kin are rendered at. Default: now. */
  now?: Date;
  /** Leave out the posts this says no to (a partial run, a test). */
  include?: (post: WpPost) => boolean;
  /**
   * The Jx build joins the children of an element with a newline and two spaces, which shows between
   * inline siblings that have no space of their own (`20<sup>th</sup>` is `20 th`, `link</a>.` is
   * `link .`). `"report"` (the default) keeps the Markdown as people write it and reports each entry
   * that has such a boundary (`block.inline-gap`). `"innerHTML"` writes each paragraph that has one as
   * a directive whose `innerHTML` attribute is the paragraph's HTML, which the build writes as it is:
   * the text comes out exact, and the paragraph is HTML in an attribute, not Markdown a person edits.
   * (Headings and the other containers keep the gap and the report: only paragraphs have the form.)
   */
  inlineGaps?: "report" | "innerHTML";
  /**
   * What the pages, layouts and components style, class by class ({@link collectClassStyles}): an entry's
   * rule for a class they style otherwise is written to win over theirs, as the post's stylesheet does
   * on the live page. Default: nothing known, so no rule is written for that reason.
   */
  classStyles?: ClassStyles;
}

/** What a collection's `$elements` lists: a component file, or the name that only switches directives on. */
export type ElementRef = string | { $ref: string };

export interface CollectionSchema {
  type: "object";
  properties: Record<string, JsonSchema>;
  required: string[];
}

/** One value of project.json's `content` section. */
export interface CollectionDef {
  source: string;
  format: "Markdown";
  schema: CollectionSchema;
  $elements: ElementRef[];
}

export interface CollectionEntry {
  collection: string;
  /** The entry id: the path below the collection, as the build derives it from the file. */
  id: string;
  /** Project-relative: `content/<collection>/<id>.md`. */
  file: string;
  /** The entry's public path in the Jx site. */
  route: string;
  /** The WordPress post id. */
  postId: number;
  /** The frontmatter as written (keys sorted). */
  frontmatter: Record<string, unknown>;
}

export interface CollectionsOutput {
  /** The `content` value of project.json, by collection name. */
  collections: Record<string, CollectionDef>;
  /** The entries, as files to write. */
  files: { path: string; content: string }[];
  entries: CollectionEntry[];
  used: {
    /** The tags of the components (and parts, reusable blocks) the bodies instantiate. */
    components: Set<string>;
    /** Every class the bodies carry. */
    wpClasses: Set<string>;
    /** Rules that could not stay on an element: the converters' hoisted rules, and the custom properties the Markdown cannot write. For the project's `style`. */
    hoisted: HoistedRule[];
  };
  /** Everything the conversion of the entries could not carry over, and what this module did to carry the rest. */
  report: Report;
}

/**
 * The name that switches directives on in a collection with no component of its own to list. The
 * parser parses directives only for a collection whose `$elements` is not empty and reads nothing but
 * whether it is (`processMarkdown` in md.ts), so an entry that holds a `div`, a `figure` or a `sup`
 * would otherwise show `:::div{…}` as text.
 */
export const DIRECTIVES_SWITCH = "@jxsuite/parser";

/** Post types that are structure or bookkeeping, never entries. */
const NOT_ENTRY_TYPES = new Set([
  ...DEFAULT_EXCLUDED_POST_TYPES,
  "page",
  "attachment",
  "nav_menu_item",
  "wp_navigation",
  "wp_template",
  "wp_template_part",
  "wp_block",
  "wp_global_styles",
  "wp_font_face",
  "wp_font_family",
  "custom_css",
  "cc_block",
]);

const isEntryType = (type: string): boolean =>
  !NOT_ENTRY_TYPES.has(type) && !type.startsWith("acf-");

/** RFC 3339 in UTC, no fractional seconds: the form the loader keeps a `date-time` in. */
export function rfc3339(iso: string): string | undefined {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `value` with `${` spelled so the build cannot evaluate it, and how many there were. */
function degradeStrings(value: unknown, count: { n: number }): unknown {
  if (typeof value === "string") {
    if (!value.includes("${")) return value;
    count.n += value.split("${").length - 1;
    return degradeTemplate(value);
  }
  if (Array.isArray(value)) return value.map((v) => degradeStrings(v, count));
  if (isRec(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]): [string, unknown] => [k, degradeStrings(v, count)]),
    );
  }
  return value;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What the Jx loader would say about an entry's data against its collection's schema
 * (`validateEntries` in the parser's content-loader.ts): a required field that is missing or null, a
 * value of the wrong type, a date that is not one. Nothing else in the schema is read by the build.
 */
export function schemaProblems(data: Rec, schema: CollectionSchema): string[] {
  const problems: string[] = [];
  for (const field of schema.required) {
    if (data[field] === undefined || data[field] === null) {
      problems.push(`missing required field "${field}"`);
    }
  }
  for (const [field, def] of Object.entries(schema.properties)) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    const types = Array.isArray(def.type)
      ? (def.type as string[])
      : def.type
        ? [def.type as string]
        : [];
    const kind = Array.isArray(value) ? "array" : typeof value;
    const ok =
      types.length === 0 ||
      types.some(
        (t) =>
          t === kind ||
          (t === "integer" && typeof value === "number" && Number.isInteger(value)) ||
          (t === "number" && typeof value === "number"),
      );
    if (!ok) problems.push(`field "${field}" expected ${types.join("|")}, got ${kind}`);
    else if (typeof value === "string" && def.format === "date-time" && !DATE_TIME.test(value)) {
      problems.push(`field "${field}" is declared date-time but "${value}" is not RFC 3339`);
    } else if (typeof value === "string" && def.format === "date" && !DATE_ONLY.test(value)) {
      problems.push(`field "${field}" is declared date but "${value}" is not YYYY-MM-DD`);
    }
  }
  return problems;
}

/** Whether a body holds anything the serializer writes as a directive. */
function usesDirectives(nodes: readonly JxNode[]): boolean {
  return nodes.some(
    (node) =>
      isEl(node) && (!MD_ALL.has(tagOf(node)) || hasJxProps(node) || usesDirectives(kidsOf(node))),
  );
}

interface Built {
  entry: CollectionEntry;
  content: string;
  components: Set<string>;
  classes: Set<string>;
  /** Every rule the entry could not keep on an element. */
  hoisted: HoistedRule[];
  /** The part of `hoisted` this module made (the converters' own rules are not its to scope). */
  fitRules: HoistedRule[];
  directives: boolean;
  /** Paragraphs in list items and table cells as the entry is written (the converter's and the reader's: no page of WordPress has them there). */
  itemParagraphs: number;
  target: AcfPostTarget;
  post: WpPost;
  route: Route;
  /** What the entry's conversion and writing said: kept apart until the entries are final, because an entry whose rules clash with another's is written again. */
  report: Report;
}

/**
 * A schema with `format: "uri"` written `"uri-reference"`: the address in an ACF `url` field is a
 * route or a `/media` path of the Jx site once {@link rewriteAddresses} has been through it, and a
 * path is a URI reference, not a URI (Ajv, Studio and every other validator that reads the format
 * would refuse it). The loader reads the format only to remap a content-relative path, which a value
 * with a leading slash is not.
 */
export function relaxAddressFormats<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(relaxAddressFormats) as T;
  if (!isRec(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([k, v]): [string, unknown] => [
      k,
      k === "format" && v === "uri" ? "uri-reference" : relaxAddressFormats(v),
    ]),
  ) as T;
}

/** The first `n` of a list, with how many more there were. */
const sample = <T>(list: readonly T[], n = 5): T[] => list.slice(0, n);

function add(
  report: Report,
  severity: Severity,
  code: string,
  message: string,
  where: string,
  url: string | undefined,
  data?: Record<string, unknown>,
): void {
  const entry: ReportEntry = {
    severity,
    code,
    message,
    where,
    ...(url === undefined ? {} : { url }),
    ...(data === undefined ? {} : { data }),
  };
  report.add(entry);
}

/** The findings of the converters this module takes over from (it knows more, and counts after its own pass). */
const REPLACED_CODES = new Set([
  "block.inline-gap",
  "block.text-directive",
  // An element's innerHTML is carried in a directive attribute; `md.innerhtml-lost` says when it cannot be.
  "html.innerhtml-unserialisable",
]);

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The names and biography an author's profile holds, for `{authorinfo}`; undefined for an author with none. */
function authorInfoOf(model: SiteContext["model"], id: number): Rec | undefined {
  const meta = userProfiles(model).get(id)?.meta;
  if (meta === undefined) return undefined;
  const out: Rec = {};
  for (const key of ["description", "first_name", "last_name"]) {
    const value = meta[key];
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The entry data of a post, as the collection stores it: the contract's keys, in order, as WordPress prints them. */
async function entryData(
  work: SiteContext,
  post: WpPost,
  report: Report,
  seoReport: Report,
  now: Date | undefined,
): Promise<Rec> {
  const ctx = await subjectCtx(work, { kind: "post", id: post.id }, { target: "markdown", report });
  const data: Rec = { ...postData(ctx, post) };
  const where = `post:${post.id}`;
  const url = publicUrl(work.model.site, post);

  for (const key of ["date", "modified"] as const) {
    const stated = rfc3339(String(data[key] ?? ""));
    if (stated === undefined) {
      delete data[key];
      add(
        report,
        "warn",
        "entry.date-invalid",
        `The ${key} of the post (${JSON.stringify(post[key])}) is not a date; the entry has none.`,
        where,
        url,
      );
    } else data[key] = stated;
  }

  // ACF's own findings about the values (a field deleted since, a group switched off) belong to the entry that has them.
  const fields = acfValues(work.model, work.acf, postTarget(work.model, post), { report });
  // The two keys this module adds to the contract are not reserved by ACF's own list (`BASE_KEYS`), so a field of that name has taken the key.
  for (const key of ["authorUrl", "hasExcerpt", "postType", "authorInfo"]) {
    if (!Object.hasOwn(fields, key)) continue;
    add(
      report,
      "warn",
      "entry.key-collision",
      `An ACF field is called \`${key}\`, which is also a key of the entry data contract (${key === "authorUrl" ? "the address of the author's page" : key === "postType" ? "the post's type" : key === "authorInfo" ? "the author's names and biography" : "whether the post has an excerpt"}): the entry holds the field's value under it, and a template that reads the contract's key gets that. Rename the field to keep both.`,
      where,
      url,
      { key },
    );
  }

  // The contract has no key for the author's page; the templates ask for `authorUrl`.
  const authorUrl = work.urls.urlForAuthor(post.authorId);
  if (authorUrl !== undefined && data.authorUrl === undefined) data.authorUrl = authorUrl;
  // A list that mixes types (a tag's posts and episodes) asks each entry what it is (`postType`).
  if (data.postType === undefined) data.postType = post.type;
  // What `{authorinfo}` prints of the author (the biography box of an essay's "Essay Author" section, the names):
  // the profile's fields, for an author who has any.
  const info = authorInfoOf(work.model, post.authorId);
  if (info !== undefined && data.authorInfo === undefined) data.authorInfo = info;

  // The data an embedded player's template reads from a linked post (`wp/lazyblocks.ts`): nothing for a gated entry.
  for (const [key, value] of Object.entries(recipeData(work.model, post))) {
    if (data[key] === undefined) data[key] = value;
  }

  try {
    const seo = seoFor(
      work.model,
      { kind: "post", post },
      { report: seoReport, ...(now === undefined ? {} : { now }) },
    );
    data.seo = toEntrySeo(seo, {
      attachment: (id) => {
        const media = ctx.mediaFor(id);
        return media
          ? {
              src: media.src,
              ...(media.width === undefined ? {} : { width: media.width }),
              ...(media.height === undefined ? {} : { height: media.height }),
              alt: media.alt,
            }
          : undefined;
      },
    });
  } catch (error) {
    add(
      report,
      "error",
      "entry.seo-failed",
      `Rank Math's SEO could not be read for the post (${error instanceof Error ? error.message : String(error)}); the entry has no seo.`,
      where,
      url,
    );
  }
  return rewriteAddresses(data, ctx.rewriteUrl) as Rec;
}

/** A string that is one address and nothing else. */
const WHOLE_ADDRESS = /^https?:\/\/\S+$/i;

/** The `href` and `src` of markup in a string. */
const MARKUP_ADDRESS = /\b(href|src)=(?:"([^"]*)"|'([^']*)')/gi;

/**
 * The addresses in entry data, for the Jx site: a value that is one address (an ACF `url` or `link`
 * field) and the `href` and `src` of the markup in a wysiwyg value, through the same `rewriteUrl` the
 * bodies use (an internal permalink becomes its route, an upload its `/media` path, anything else is
 * left as written). A text that merely mentions an address is text and is left alone.
 */
export function rewriteAddresses(value: unknown, rewrite: (url: string) => string): unknown {
  if (typeof value === "string") {
    if (WHOLE_ADDRESS.test(value)) return rewrite(value);
    if (!value.includes("<") || !/\b(?:href|src)=/i.test(value)) return value;
    return value.replace(
      MARKUP_ADDRESS,
      (match, attribute: string, double?: string, single?: string) => {
        const written = double ?? single ?? "";
        const address = decodeEntities(written);
        if (!/^(?:https?:)?\/\//i.test(address)) return match;
        const next = rewrite(address);
        if (next === address) return match;
        return `${attribute}="${next.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`;
      },
    );
  }
  if (Array.isArray(value)) return value.map((v) => rewriteAddresses(v, rewrite));
  if (isRec(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]): [string, unknown] => [k, rewriteAddresses(v, rewrite)]),
    );
  }
  return value;
}

/**
 * What a Markdown entry cannot hold because it needs the page's own state: an element that is a
 * `$prototype` (a repeater over a query), a `$switch`, a reference, or has a mapped list for children.
 * An entry has no state of its own, and the template that renders it does not know what the body asks for.
 */
function dropDynamic(
  nodes: JxNode[],
  state: Record<string, unknown>,
  report: Report,
  where: string,
  url: string | undefined,
): JxNode[] {
  const dropped = new Map<string, number>();
  const walk = (list: readonly JxNode[]): JxNode[] =>
    list.flatMap((node): JxNode[] => {
      if (!isEl(node)) return [node];
      const kind =
        "$prototype" in node
          ? "$prototype"
          : "$switch" in node
            ? "$switch"
            : "$ref" in node
              ? "$ref"
              : isRec(node.children)
                ? "children"
                : undefined;
      if (kind !== undefined) {
        dropped.set(kind, (dropped.get(kind) ?? 0) + 1);
        return [];
      }
      return Array.isArray(node.children) ? [{ ...node, children: walk(node.children) }] : [node];
    });
  const out = walk(nodes);
  const keys = Object.keys(state);
  if (dropped.size > 0 || keys.length > 0) {
    const count = [...dropped.values()].reduce((a, b) => a + b, 0);
    add(
      report,
      "warn",
      "entry.dynamic-dropped",
      `${count > 0 ? `${plural(count, "element")} of the body need the page's own state (a query, a switch)` : "The body registered page state"}, which a Markdown entry has none of${keys.length > 0 ? ` (${keys.join(", ")})` : ""}; ${count > 0 ? "they were left out" : "it was not carried"}.`,
      where,
      url,
      { elements: Object.fromEntries([...dropped].sort()), state: keys },
    );
  }
  return out;
}

/** A body's placeholders have nothing to become in a Markdown entry: the shortcode keeps what it enclosed, the rest goes, and each is said. */
function resolvePlaceholders(
  site: SiteContext,
  nodes: JxNode[],
  report: Report,
  where: string,
  url: string | undefined,
): JxNode[] {
  const dropped = new Map<string, { count: number; blocks: Set<string> }>();
  const note = (tag: string, block: string | undefined): void => {
    const found = dropped.get(tag) ?? { count: 0, blocks: new Set<string>() };
    found.count++;
    if (block !== undefined) found.blocks.add(block);
    dropped.set(tag, found);
  };
  // A Fluent Forms form is static markup (a div with its HTML), which an entry carries as a directive.
  const form = (placeholder: Placeholder): JxElement | undefined =>
    fluentFormFor(site, placeholder, (entry) =>
      add(report, entry.severity, entry.code, entry.message, where, url, entry.data),
    );
  const drop = (placeholder: Placeholder): JxNode[] | null => {
    note(placeholder.tag, placeholder.block ?? placeholder.attrs["data-shortcode"]);
    const kept = placeholder.element.children;
    return placeholder.kind === "shortcode" && Array.isArray(kept) ? kept : null;
  };
  const out = replacePlaceholders(nodes, {
    shortcode: (placeholder) => form(placeholder) ?? drop(placeholder),
    block: (placeholder) => form(placeholder) ?? drop(placeholder),
    "*": drop,
  });
  for (const [tag, { count, blocks }] of [...dropped].sort(([a], [b]) => (a < b ? -1 : 1))) {
    add(
      report,
      "warn",
      "entry.placeholder-dropped",
      `${plural(count, `<${tag}> placeholder`)} stood for something a Markdown entry cannot hold (${[...blocks].sort().join(", ") || tag}); ${plural(count, "was", "were")} left out of the entry.`,
      where,
      url,
      { tag, count, blocks: [...blocks].sort() },
    );
  }
  return out;
}

/** One entry: its data, its body, the file, and everything the two of them left unsaid. */
async function buildEntry(
  work: SiteContext,
  post: WpPost,
  route: Route,
  opts: CollectionsOptions,
  report: Report,
  scoped: ReadonlySet<string> = new Set(),
): Promise<Built> {
  const where = `post:${post.id}`;
  const url = publicUrl(work.model.site, post);
  const entryReport = createReport();
  // Rank Math's own findings are about the site (a plugin it cannot port), so they are said once, by the report that is kept.
  const data = await entryData(work, post, entryReport, report, opts.now);
  const literal = { n: 0 };
  const clean = degradeStrings(data, literal) as Rec;

  const converted = await convertSubject(
    work,
    { kind: "post", id: post.id },
    { target: "markdown" },
  );
  for (const found of [...entryReport.entries(), ...converted.report.entries()]) {
    if (!REPLACED_CODES.has(found.code)) report.add(found);
  }

  const placed = resolvePlaceholders(
    work,
    dropDynamic(converted.nodes, converted.state, report, where, url),
    report,
    where,
    url,
  );
  // A `url()` in a style (a background image) holds the live address of an upload unless something
  // rewrote it; the elements and rules are this entry's own copies, so they are edited in place.
  const nodes = structuredClone(placed);
  const convertedRules = structuredClone(converted.hoisted);
  const tools = work.urls.bind(report, where);
  for (const element of walkElements(nodes)) {
    rewriteStyleUrls(element.style, (address) => tools.rewriteUrl(address));
  }
  for (const rule of convertedRules) {
    rewriteStyleUrls(rule.style, (address) => tools.rewriteUrl(address));
  }
  const sentinels = sentinelsFor(nodes);
  const fit = fitBody(nodes, sentinels, opts.inlineGaps ?? "report", scoped, opts.classStyles);
  const body = writeBody(fit.nodes, sentinels);
  const expected = expectedTree(fit.nodes, sentinels);

  let yaml = frontmatterYaml(clean);
  let content = entryFile(yaml, body);
  let checked = checkFile(content, clean, expected);
  if (checked.verdict.frontmatter.length > 0) {
    yaml = frontmatterYaml(clean, true);
    content = entryFile(yaml, body);
    checked = checkFile(content, clean, expected);
  }
  const verdict = checked.verdict;
  if (verdict.frontmatter.length > 0) {
    add(
      report,
      "error",
      "md.frontmatter-mismatch",
      `The frontmatter does not read back as written (${verdict.frontmatter.join(", ")}).`,
      where,
      url,
      { keys: verdict.frontmatter },
    );
  }

  const notes = fit.notes;
  if (notes.colons > 0) {
    add(
      report,
      "info",
      "md.colon-escaped",
      `${plural(notes.colons, "colon")} before a digit or letter (\`Luke 3:16\`, \`12:30pm\`) would be read as a text directive and the text after it lost (a bug in the Jx Markdown reader and serializer); each is written \`\\:\`, which reads back as the colon and leaves no space around it.`,
      where,
      url,
      { colons: notes.colons, spansMerged: notes.colonSpans },
    );
  }
  const gaps = verdict.gaps;
  if (gaps.length > 0) {
    add(
      report,
      "warn",
      "block.inline-gap",
      `${plural(gaps.length, "boundary", "boundaries")} between inline siblings have no space on either side (a note marker after a word, a link before a full stop); the Jx build writes a space at each, so \`20<sup>th</sup>\` shows as \`20 th\`. The one spelling that avoids it is a paragraph whose innerHTML is its own HTML (the inlineGaps: "innerHTML" option): the text is then exact, and the paragraph is HTML in an attribute, not Markdown a person edits.`,
      where,
      url,
      { boundaries: gaps.length, examples: sample(gaps).map((g) => g.at) },
    );
  }
  const losses = verdict.tree;
  if (losses.length > 0) {
    add(
      report,
      "warn",
      "md.lossy",
      `The body does not read back as the tree it was written from in ${plural(losses.length, "place")}: ${losses[0]!.path} ${losses[0]!.detail}.`,
      where,
      url,
      {
        differences: sample(losses, 8).map((d) => `${d.kind} at ${d.path}: ${d.detail}`),
        count: losses.length,
      },
    );
  }
  const linked = autolinkable(expected);
  if (linked > 0) {
    add(
      report,
      "info",
      "md.autolinked",
      `${plural(linked, "address")} written as plain text (a URL, a \`www.\` name or an e-mail address) will read back as ${linked === 1 ? "a link" : "links"}: the Markdown reader links every address, and no spelling prevents it.${notes.addressSpaces > 0 ? ` ${plural(notes.addressSpaces, "address")} had a no-break space after it, which the reader would have linked along with the next word: it is written as a plain space.` : ""}`,
      where,
      url,
      {
        addresses: linked,
        ...(notes.addressSpaces > 0 ? { spacesAfterAddress: notes.addressSpaces } : {}),
      },
    );
  }
  const items = Math.max(0, checked.itemParagraphs - itemParagraphs(nodes));
  if (items > 0) {
    add(
      report,
      "warn",
      "md.item-paragraphs",
      `${plural(items, "list item or table cell", "list items and table cells")} will hold a paragraph the page did not have (the reader puts one around the text of each): a theme rule for paragraphs inside the content (margins, padding) now reaches ${items === 1 ? "it" : "them"}. The project's style takes their space away (\`collection.item-paragraph-rule\`) unless a page of the site has such a paragraph itself; a rule of the theme that names a class still reaches them.`,
      where,
      url,
      { count: items },
    );
  }
  const wrapped = Object.values(notes.wrapped).reduce((a, b) => a + b, 0);
  const normalized: Record<string, unknown> = {
    ...(wrapped > 0 ? { paragraphsAdded: notes.wrapped } : {}),
    ...(notes.emptyBlocks > 0 ? { emptyBlocksDropped: notes.emptyBlocks } : {}),
    ...(notes.breaks > 0 ? { trailingBreaksDropped: notes.breaks } : {}),
    ...(notes.tables > 0 ? { tablesAsDirectives: notes.tables } : {}),
    ...(notes.images > 0 ? { imagesAsDirectives: notes.images } : {}),
    ...(notes.links > 0 ? { linksAsDirectives: notes.links } : {}),
    ...(notes.attributes > 0 ? { elementsWithAttributesAsDirectives: notes.attributes } : {}),
    ...(notes.inlineBlocks > 0 ? { blocksInLinesAsDirectives: notes.inlineBlocks } : {}),
    ...(notes.lists > 0 ? { listsAsDirectives: notes.lists } : {}),
    ...(notes.alone > 0 ? { aloneAsDirectives: notes.alone } : {}),
    ...(notes.hoisted > 0 ? { customPropertiesHoisted: notes.hoisted } : {}),
    ...(notes.breaksKept > 0 ? { blankLinesKept: notes.breaksKept } : {}),
    ...(notes.edgeSpaces > 0 ? { emphasisSpacesMoved: notes.edgeSpaces } : {}),
    ...(notes.scopedPerEntry > 0 ? { stylesScopedPerEntry: notes.scopedPerEntry } : {}),
    ...(notes.isolated > 0 ? { stylesWonOverPages: notes.isolated } : {}),
    ...(notes.codeBreaks > 0 ? { codeBlankLinesKept: notes.codeBreaks } : {}),
    ...(notes.scoped > 0 ? { stylesMovedToClass: notes.scoped } : {}),
    ...(notes.propsStringified > 0 ? { propertiesAsText: notes.propsStringified } : {}),
    ...(notes.innerHtml > 0 ? { innerHtmlAsAttribute: notes.innerHtml } : {}),
    ...(notes.innerHtmlParagraphs > 0 ? { paragraphsAsInnerHtml: notes.innerHtmlParagraphs } : {}),
  };
  if (Object.keys(normalized).length > 0) {
    const said: string[] = [];
    if (wrapped > 0) {
      said.push(
        `${plural(wrapped, "paragraph")} put around text and inline markup that sat directly in ${Object.keys(
          notes.wrapped,
        )
          .sort()
          .map((t) => (t === "root" ? "the body" : `<${t}>`))
          .join(", ")} (the reader makes one there)`,
      );
    }
    if (notes.emptyBlocks > 0) said.push(`${plural(notes.emptyBlocks, "empty block")} dropped`);
    if (notes.breaks > 0)
      said.push(
        `${plural(notes.breaks, "trailing line break")} dropped (the last break of a block shows nothing, and a Markdown hard break at the end of a block reads back as a backslash)`,
      );
    if (notes.breaksKept > 0)
      said.push(
        `${plural(notes.breaksKept, "blank line")} that trailing line breaks showed written as a line holding a no-break space`,
      );
    if (notes.edgeSpaces > 0)
      said.push(
        `${plural(notes.edgeSpaces, "space")} at the edge of emphasis moved out beside it (the browser shows the same; Markdown cannot put a space next to its marker)`,
      );
    if (notes.scopedPerEntry > 0)
      said.push(
        `${plural(notes.scopedPerEntry, "rule")} written for a class of its own declarations (style.scoped-per-entry)`,
      );
    if (notes.isolated > 0)
      said.push(
        `${plural(notes.isolated, "rule")} written for a class that a page, layout or component styles otherwise (the post's stylesheet follows the template's on the live page: what the template's rule contradicts is written one class more specific, so that the entry's wins, and the rest reaches this entry's elements only)`,
      );
    if (notes.tables > 0)
      said.push(
        `${plural(notes.tables, "table")} written as directives (spans, classes, or no header row)`,
      );
    if (notes.images > 0)
      said.push(
        `${plural(notes.images, "image")} written as directives (a Markdown image has no place for their attributes)`,
      );
    if (notes.attributes > 0)
      said.push(
        `${plural(notes.attributes, "element")} with attributes a Markdown element has no place for written as directives`,
      );
    if (notes.links > 0)
      said.push(`${plural(notes.links, "link")} that hold blocks written as directives`);
    if (notes.alone > 0)
      said.push(
        `${plural(notes.alone, "inline element")} alone in a container written as directives (no paragraph is made around ${notes.alone === 1 ? "it" : "them"})`,
      );
    if (notes.lists > 0)
      said.push(
        `${plural(notes.lists, "list or item")} written as directives (a class on a list or one of its items)`,
      );
    if (notes.inlineBlocks > 0)
      said.push(
        `${plural(notes.inlineBlocks, "block")} inside a link or line of text written as directives`,
      );
    if (notes.codeBreaks > 0)
      said.push(
        `${plural(notes.codeBreaks, "run")} of blank lines inside code kept (the serializer collapses three line breaks to two)`,
      );
    if (notes.hoisted > 0)
      said.push(
        `${plural(notes.hoisted, "custom property", "custom properties")} moved from an element's style to a rule of its own (the reader turns a top-level \`--name\` into a media query)`,
      );
    if (notes.innerHtml > 0)
      said.push(
        `${plural(notes.innerHtml, "element")} with innerHTML carried in a directive attribute`,
      );
    if (notes.innerHtmlParagraphs > 0)
      said.push(
        `${plural(notes.innerHtmlParagraphs, "paragraph")} written as HTML in an innerHTML attribute, so that the build puts no space between their inline pieces`,
      );
    add(
      report,
      "info",
      "md.normalized",
      `The body was put in the form Markdown writes and reads back unchanged: ${said.join("; ")}.`,
      where,
      url,
      normalized,
    );
  }
  if (notes.styleLost.length > 0) {
    add(
      report,
      "warn",
      "md.style-lost",
      `Custom properties (${[...new Set(notes.styleLost)].join(", ")}) sit on an element with no id or class to scope a rule by; Markdown cannot write them and they were lost.`,
      where,
      url,
      { properties: [...new Set(notes.styleLost)] },
    );
  }
  if (notes.innerHtmlLost.length > 0) {
    add(
      report,
      "warn",
      "md.innerhtml-lost",
      `The innerHTML of ${[...new Set(notes.innerHtmlLost)].map((t) => `<${t}>`).join(", ")} cannot be written in a Markdown entry (the serializer writes none, and a Markdown tag has no attribute for it); it is missing.`,
      where,
      url,
      { tags: notes.innerHtmlLost },
    );
  }
  // What the core converters reported (a link's `target`, `rel`, `data-*`, an ordered list's `type`) is not said again.
  const dropped = [...new Set(notes.attributesDropped)].filter(
    (name) => !name.startsWith("a:") && !name.startsWith("ol:"),
  );
  if (dropped.length > 0) {
    add(
      report,
      "warn",
      "md.attributes-dropped",
      `Attributes a Markdown element has no place for were left out (${dropped.join(", ")}).`,
      where,
      url,
      { attributes: dropped },
    );
  }
  if (notes.propsLost.length > 0) {
    add(
      report,
      "warn",
      "md.props-lost",
      `${plural(notes.propsLost.length, "component property", "component properties")} (${notes.propsLost.join(", ")}) ${notes.propsLost.length === 1 ? "is" : "are"} a boolean false or a list, which a directive attribute cannot hold (every value is a string, and the string "false" is true): the component's default applies instead.`,
      where,
      url,
      { properties: notes.propsLost },
    );
  }
  const templates = notes.templates + literal.n;
  if (templates > 0) {
    add(
      report,
      "warn",
      "md.literal-template",
      `${plural(templates, "literal `${`")} in the text of the entry: the Jx build evaluates it wherever it is written, so it is spelled with a zero-width space between the two characters.`,
      where,
      url,
      { count: templates },
    );
  }

  const components = new Set(converted.used.components);
  // Over the tree the body means: a component's classes are an attribute, and a paragraph's HTML an attribute too.
  const classes = collectWpClasses(expected);
  const hoisted: HoistedRule[] = [...convertedRules, ...(fit.hoisted as HoistedRule[])];
  const entryId = route.entryId ?? "";
  return {
    entry: {
      collection: route.collection ?? post.type,
      id: entryId,
      file: route.file,
      route: route.jxRoute,
      postId: post.id,
      frontmatter: sortDeep(clean) as Rec,
    },
    content,
    components,
    classes,
    hoisted,
    fitRules: fit.hoisted as HoistedRule[],
    directives: usesDirectives(fit.nodes),
    itemParagraphs: items + itemParagraphs(nodes),
    target: postTarget(work.model, post),
    post,
    route,
    report,
  };
}

/** The selectors that more than one rule is written for with different declarations, and who wants which. */
function conflictsOf(
  builts: readonly Built[],
): Map<string, { variants: Set<string>; posts: Set<number> }> {
  const seen = new Map<string, { variants: Set<string>; posts: Set<number> }>();
  for (const b of builts) {
    for (const rule of b.hoisted) {
      const found = seen.get(rule.selector) ?? {
        variants: new Set<string>(),
        posts: new Set<number>(),
      };
      found.variants.add(sortedJson(rule.style));
      found.posts.add(b.post.id);
      seen.set(rule.selector, found);
    }
  }
  return new Map([...seen].filter(([, found]) => found.variants.size > 1));
}

/**
 * A class id repeats from post to post with different declarations (a duplicated page keeps its block
 * ids; docs/design.md), and a rule that moved from an element to the project's `style` has one body per
 * selector, so two entries that disagree would restyle each other. The entries that wrote such a rule
 * are written again with it scoped to their own declarations ({@link ruleFor}); a clash among the
 * converters' own rules is not this module's to resolve, and is said.
 */
async function scopeConflicts(
  work: SiteContext,
  built: Built[],
  opts: CollectionsOptions,
  report: Report,
): Promise<void> {
  const clashes = conflictsOf(built);
  if (clashes.size === 0) return;
  const selectors = new Set(clashes.keys());
  const scopedSelectors = new Set<string>();
  for (const [i, b] of built.entries()) {
    const mine = new Set(b.fitRules.map((r) => r.selector).filter((sel) => selectors.has(sel)));
    if (mine.size === 0) continue;
    try {
      const again = await buildEntry(work, b.post, b.route, opts, createReport(), selectors);
      built[i] = again;
      for (const sel of mine) scopedSelectors.add(sel);
    } catch {
      // The entry as it was written stays: the clash is reported below.
    }
  }
  const left = conflictsOf(built);
  for (const [selector, found] of [...clashes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const resolved = scopedSelectors.has(selector) && !left.has(selector);
    add(
      report,
      resolved ? "info" : "warn",
      resolved ? "style.scoped-per-entry" : "style.conflict",
      resolved
        ? `\`${selector}\` is written with different declarations by ${plural(found.posts.size, "entry", "entries")} (${plural(found.variants.size, "variant")}): a project rule has one body per selector, so each entry's rule is written for \`${selector}:where(.jx-<hash>)\` and its element carries that class. \`:where\` adds no specificity, so the cascade is unchanged.`
        : `\`${selector}\` is written with different declarations by ${plural(found.posts.size, "entry", "entries")} (${plural(found.variants.size, "variant")}), and a project rule has one body per selector: the entries restyle each other. The rule comes from a converter, which scopes it per declaration or does not.`,
      `style:${selector}`,
      undefined,
      {
        selector,
        variants: found.variants.size,
        posts: sample(
          [...found.posts].sort((a, b) => a - b),
          20,
        ),
      },
    );
  }
}

/** How many entries show the space the Jx build writes between inline siblings: one line, so that the per-entry findings do not have to be counted by hand. */
function inlineGapSummary(built: readonly Built[], report: Report): void {
  const entries = built.filter((b) =>
    b.report.entries().some((e) => e.code === "block.inline-gap"),
  );
  if (entries.length === 0) return;
  add(
    report,
    "info",
    "collection.inline-gap-summary",
    `${plural(entries.length, "entry", "entries")} of ${built.length} show a space the source does not have between inline siblings (\`20 th\`, \`link .\`): the Jx build joins them with a newline. Each is a \`block.inline-gap\` finding; the inlineGaps option "innerHTML" writes the paragraphs among them as HTML, which the build prints as it is.`,
    "collection:*",
    undefined,
    { entries: entries.length, of: built.length },
  );
}

const FIXED_LAYOUT_CLASS = "has-fixed-layout";

/** WordPress's `.wp-block-table .has-fixed-layout` rules, for the figure that carries the class in an entry. */
const FIXED_LAYOUT_RULES: HoistedRule[] = [
  {
    selector: `.wp-block-table.${FIXED_LAYOUT_CLASS} table`,
    style: { tableLayout: "fixed", width: "100%" },
  },
  {
    selector: `.wp-block-table.${FIXED_LAYOUT_CLASS} td, .wp-block-table.${FIXED_LAYOUT_CLASS} th`,
    style: { wordBreak: "break-word" },
  },
];

/** A paragraph straight inside this item tag in saved markup, a block comment between them allowed. */
const itemParagraphIn = (tag: string): RegExp =>
  new RegExp(`<${tag}\\b[^>]*>(?:\\s|<!--[\\s\\S]*?-->)*<p[\\s>]`, "i");

/**
 * What the paragraph of an item gives up: its spacing, and the type the theme sets on paragraphs (the
 * pilot's `.content-post p { line-height: 1.85rem }` against the item's own 1.5 made each of a list's
 * items 0.4px short, and a post's headings 6px high by its third list). Every declaration is
 * `!important` because the theme's `.content p` rules are more specific than a tag selector.
 */
const ITEM_PARAGRAPH_STYLE = {
  margin: "0 !important",
  padding: "0 !important",
  font: "inherit !important",
  color: "inherit !important",
  textAlign: "inherit !important",
  letterSpacing: "inherit !important",
};

/**
 * The rule that takes the paragraph a Markdown list item or table cell is written with out of the
 * page's spacing (`md.item-paragraphs`): `li > p { margin: 0; padding: 0 }` (`!important`: the theme's `.content p` rules are more specific than a tag selector, and none of them was written for this paragraph), for each item tag that no
 * saved page, template or post of the site holds a paragraph in (WordPress prints the text of an item
 * bare, and the pages show it bare). A tag the site does put paragraphs in is left out: the rule would
 * strip theirs too. Nothing when no entry holds such a paragraph.
 */
function itemParagraphRule(work: SiteContext, built: readonly Built[]): HoistedRule | undefined {
  if (!built.some((b) => b.itemParagraphs > 0)) return undefined;
  const posts = [...work.model.posts.values()];
  const tags = [...ITEM_TAGS].filter(
    (tag) => !posts.some((p) => itemParagraphIn(tag).test(p.content)),
  );
  if (tags.length === 0) return undefined;
  return {
    selector: tags.map((tag) => `${tag} > p`).join(", "),
    style: ITEM_PARAGRAPH_STYLE,
  };
}

const componentRef = (tag: string): ElementRef => ({ $ref: `./components/${tag}.json` });

const dedupeRules = (rules: readonly HoistedRule[]): HoistedRule[] => {
  const seen = new Set<string>();
  const out: HoistedRule[] = [];
  for (const rule of rules) {
    const key = `${rule.selector}\0${sortedJson(rule.style)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
};

/** The site with `routeTypes` added to its rewrite rules: its routes and URL tools are made again. */
function withRoutes(
  site: SiteContext,
  routeTypes: RouteOptions["postTypes"],
  report: Report,
): SiteContext {
  const own = createReport();
  const routes = buildRoutes(site.model, site.acf, {
    report: own,
    media: site.media,
    postTypes: routeTypes,
  });
  const urls = createUrlTools(site.model, routes, site.media, { report: own });
  // What the site's own load already said is not said twice.
  const said = new Set(
    site.report.entries().map((e) => `${e.code}\0${e.where ?? ""}\0${e.message}`),
  );
  for (const found of own.entries()) {
    if (!said.has(`${found.code}\0${found.where ?? ""}\0${found.message}`)) report.add(found);
  }
  return { ...site, routes, urls };
}

/**
 * Posts and custom post types as Markdown content collections (see the module header).
 */
export async function buildCollections(
  site: SiteContext,
  opts: CollectionsOptions = {},
): Promise<CollectionsOutput> {
  const report = createReport();
  const work = opts.routeTypes === undefined ? site : withRoutes(site, opts.routeTypes, report);
  const { model } = work;

  const entryRoutes = new Map<number, Route>();
  const routedTypes = new Set<string>();
  for (const route of work.routes.all()) {
    if (route.kind !== "entry") continue;
    entryRoutes.set(Number(route.id), route);
    if (route.type !== undefined) routedTypes.add(route.type);
  }

  const byType = new Map<string, WpPost[]>();
  for (const post of model.posts.values()) {
    if (!isEntryType(post.type)) continue;
    if (opts.include && !opts.include(post)) continue;
    const list = byType.get(post.type) ?? [];
    list.push(post);
    byType.set(post.type, list);
  }

  const built: Built[] = [];
  const claimed = new Map<string, number>();
  for (const type of [...byType.keys()].sort()) {
    const posts = byType.get(type)!.sort((a, b) => a.id - b.id);
    const excluded = new Map<string, number[]>();
    const published: WpPost[] = [];
    for (const post of posts) {
      if (post.status !== "publish") {
        const list = excluded.get(post.status) ?? [];
        list.push(post.id);
        excluded.set(post.status, list);
      } else published.push(post);
    }
    for (const [status, ids] of [...excluded].sort(([a], [b]) => (a < b ? -1 : 1))) {
      add(
        report,
        "info",
        "collection.excluded",
        `${plural(ids.length, `${type} ${status === "publish" ? "post" : status}`)} ${ids.length === 1 ? "is" : "are"} not published, and the Jx build does not filter drafts, so ${ids.length === 1 ? "it was" : "they were"} left out.`,
        `collection:${type}`,
        undefined,
        { type, status, count: ids.length, ids: sample(ids, 20) },
      );
    }
    if (published.length === 0) continue;

    if (!routedTypes.has(type)) {
      add(
        report,
        "warn",
        "collection.unrouted",
        `${plural(published.length, `published ${type} post`)} ${published.length === 1 ? "has" : "have"} no address on the migrated site: the post type is registered by a plugin or in code, so neither ACF nor the permalink structure says where its posts live. ${published.length === 1 ? "It was" : "They were"} left out; give the type its rewrite rule (the routeTypes option) to migrate ${published.length === 1 ? "it" : "them"}.`,
        `collection:${type}`,
        undefined,
        {
          type,
          count: published.length,
          ids: sample(
            published.map((p) => p.id),
            20,
          ),
        },
      );
      continue;
    }

    for (const post of published) {
      const where = `post:${post.id}`;
      const url = publicUrl(model.site, post);
      if (post.passwordProtected) {
        add(
          report,
          "warn",
          "collection.protected",
          `The ${type} post is password protected: the live page shows a form, not the content, so the content is not published as an entry.`,
          where,
          url,
          { type },
        );
        continue;
      }
      const route = entryRoutes.get(post.id);
      if (!route) {
        const winner = work.routes.forPost(post.id);
        add(
          report,
          "warn",
          "collection.no-route",
          winner
            ? `The ${type} post has no route of its own: it lost its address (${winner.wpPath}) to another object, which WordPress serves instead. It has no entry.`
            : `The ${type} post has no address on the migrated site (no slug, or a date its permalink structure needs and does not have). It has no entry.`,
          where,
          url,
          {
            type,
            ...(winner ? { winner: `${winner.kind}:${winner.id}`, path: winner.wpPath } : {}),
          },
        );
        continue;
      }
      const taken = claimed.get(route.file);
      if (taken !== undefined) {
        add(
          report,
          "error",
          "collection.duplicate-file",
          `Post ${taken} already has the file ${route.file}; this post's entry was not written.`,
          where,
          url,
          { file: route.file, other: taken },
        );
        continue;
      }
      claimed.set(route.file, post.id);
      const entryReport = createReport();
      try {
        built.push(await buildEntry(work, post, route, opts, entryReport));
      } catch (error) {
        // One post that cannot be written (a tag chosen at render time, which Markdown cannot say) is not a failed site.
        for (const found of entryReport.entries()) report.add(found);
        claimed.delete(route.file);
        add(
          report,
          "error",
          "entry.failed",
          `The ${type} post could not be written as an entry (${error instanceof Error ? error.message : String(error)}); it has no entry.`,
          where,
          url,
          { type },
        );
      }
    }
  }

  await scopeConflicts(work, built, opts, report);
  for (const b of built) for (const found of b.report.entries()) report.add(found);
  inlineGapSummary(built, report);

  built.sort((a, b) =>
    a.entry.collection === b.entry.collection
      ? a.entry.id < b.entry.id
        ? -1
        : a.entry.id > b.entry.id
          ? 1
          : 0
      : a.entry.collection < b.entry.collection
        ? -1
        : 1,
  );

  const collections: Record<string, CollectionDef> = {};
  const names = [...new Set(built.map((b) => b.entry.collection))].sort();
  for (const name of names) {
    const mine = built.filter((b) => b.entry.collection === name);
    const where = `collection:${name}`;
    const fields = acfSchema(
      fieldsFor(
        work.acf,
        mine.map((b) => b.target),
      ),
      { report, where },
    );
    const properties: Record<string, JsonSchema> = {
      ...BASE_PROPERTIES,
      authorUrl: { type: "string" },
      hasExcerpt: { type: "boolean" },
      postType: { type: "string" },
      ...(mine.some((b) => b.entry.frontmatter.authorInfo !== undefined)
        ? { authorInfo: { type: "object" } }
        : {}),
      // Only a collection whose entries carry an embedded player's data (`wp/lazyblocks.ts`) names it.
      ...(mine.some((b) => b.entry.frontmatter.captivate !== undefined)
        ? { captivate: { type: "object" } }
        : {}),
      ...relaxAddressFormats(fields.properties as Record<string, JsonSchema> | undefined),
    };
    // A group applies to some of the entries and not to others (a location rule on a taxonomy term, a
    // template): its required fields are required of the entries it applies to, and of no others.
    const requiredBy = new Map<string, ReadonlySet<string>>();
    const requiredOf = (b: Built): ReadonlySet<string> => {
      const own = fieldsFor(work.acf, [b.target]);
      const key = own.map((f) => f.key).join(",");
      let found = requiredBy.get(key);
      if (!found) {
        const schema = acfSchema(own, { report: createReport() });
        found = new Set((schema.required as string[] | undefined) ?? []);
        requiredBy.set(key, found);
      }
      return found;
    };
    const everywhere = ((fields.required as string[] | undefined) ?? []).filter((name) =>
      mine.every((b) => requiredOf(b).has(name)),
    );
    const required = [...new Set([...BASE_REQUIRED, ...everywhere])];
    const schema: CollectionSchema = {
      type: "object",
      properties: Object.fromEntries(Object.entries(properties).sort(byKey)),
      required,
    };
    const tags = [...new Set(mine.flatMap((b) => [...b.components]))].sort();
    const elements: ElementRef[] = tags.map(componentRef);
    if (elements.length === 0 && mine.some((b) => b.directives)) elements.push(DIRECTIVES_SWITCH);
    collections[name] = {
      source: `content/${name}`,
      format: "Markdown",
      schema,
      $elements: elements,
    };

    for (const b of mine) {
      const problems = schemaProblems(b.entry.frontmatter, schema);
      if (problems.length > 0) {
        add(
          report,
          "error",
          "entry.schema-invalid",
          `The entry does not satisfy the schema of its collection: ${problems.join("; ")}.`,
          `post:${b.entry.postId}`,
          undefined,
          { collection: name, problems },
        );
      }
    }
  }

  const hoisted = dedupeRules(built.flatMap((b) => b.hoisted));
  const itemRule = itemParagraphRule(work, built);
  if (itemRule !== undefined) {
    hoisted.push(itemRule);
    add(
      report,
      "info",
      "collection.item-paragraph-rule",
      `Every entry's list items and table cells hold a paragraph the pages do not have (a Markdown item is read back with one around its text), and no page of this site has such a paragraph itself: the project's style carries \`${itemRule.selector} { margin: 0 !important; padding: 0 !important }\`, so that a paragraph takes no space of its own there.`,
      "collection:*",
      undefined,
      { selector: itemRule.selector },
    );
  }
  // A Markdown table has no class, so the figure carries the table's `has-fixed-layout` (core/static.ts)
  // and WordPress's rule for it, written for the table inside `.wp-block-table`, matches nothing.
  const fixedTables = built.filter((b) => b.content.includes(FIXED_LAYOUT_CLASS));
  if (fixedTables.length > 0) {
    hoisted.push(...FIXED_LAYOUT_RULES);
    add(
      report,
      "info",
      "collection.fixed-layout-rule",
      `${plural(fixedTables.length, "entry", "entries")} hold a table whose columns the author fixed (\`${FIXED_LAYOUT_CLASS}\`): a Markdown table has no class, so the figure carries it and the project's style carries WordPress's rule for it, written for the figure's own class.`,
      "collection:*",
      undefined,
      { entries: fixedTables.length },
    );
  }
  const used: CollectionsOutput["used"] = {
    components: new Set(built.flatMap((b) => [...b.components])),
    wpClasses: new Set(built.flatMap((b) => [...b.classes])),
    hoisted,
  };
  return {
    collections,
    files: built.map((b) => ({ path: b.entry.file, content: b.content })),
    entries: built.map((b) => b.entry),
    used,
    report,
  };
}
