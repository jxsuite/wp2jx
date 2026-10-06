/**
 * HTML to Jx. `@jxsuite/markup`'s `htmlToJx` puts `class` and `id` under `attributes`, keeps style
 * keys kebab-case, drops the space between inline siblings and mangles SVG attribute names, so
 * wp2jx converts markup itself, on parse5 (the parser behind `hast-util-from-html`) read directly:
 * its attribute list is exactly what the source said, where hast's property layer re-parses
 * numbers and token lists and has no way back to `data-x-1`.
 *
 * What the Jx static build does to the nodes decides most of the shape here (verified by building):
 *
 * - It joins an element's `children` with a newline and two spaces. Between blocks, and wherever
 *   the text already has a space, that is invisible; between `<b>bold</b>` and the `.` after it,
 *   it is a space before the full stop. An element whose children would show that gap holds its
 *   content as `innerHTML` instead (`inlineGaps`), which the build writes verbatim.
 * - It HTML-escapes `textContent`, so a `<script>` or `<style>` (raw text, never decoded) can only
 *   carry its text in `innerHTML`.
 * - It scopes an element's own `style` to its `id`, else to its FIRST class, so inline styles on
 *   elements that share a class would restyle every one of them; such an element gets a generated
 *   first class (`scopeStyle`). A selector names every element that matches, so elements that
 *   share an id keep their styles as attributes, and so does one whose style repeats a property
 *   (a fallback, where a browser picks the declaration it can read and a rule cannot).
 * - It reads `${` in any string as a template, and has no escape that survives its own two passes
 *   except a character reference inside `innerHTML` (see `escapeTemplate`), so an element whose
 *   text or attribute holds a literal one carries its content that way.
 *
 * Which to call: `htmlToContent` when the HTML is the content of an element being built (a
 * heading's text, a paragraph's inline markup), because it picks `textContent`, `children` or
 * `innerHTML` for that element and so can guard the first and last of the rules above; `htmlToNodes`
 * for a whole fragment, where every element returned is exact but the boundary between the
 * top-level siblings is not, since the build places them in a parent it does not know.
 *
 * Where the nodes go decides what they may hold. A Jx page carries all of the above; a Markdown
 * entry is written by `serializeJxMarkdown`, which writes no `innerHTML` (`target: "markdown"`).
 * Markup nested deeper than a browser builds is kept whole (`MAX_DEPTH`), and `attribute` lets a
 * caller move media and links in every form the output takes.
 */
import { createHash } from "node:crypto";
import { booleanAttrValue } from "@jxsuite/runtime";
import { cssPropertyName } from "@jxsuite/runtime/css";
import type { DefaultTreeAdapterMap } from "parse5";
import { parseFragment } from "parse5";
import { find, html as htmlSchema, normalize } from "property-information";
import type { Info } from "property-information";
import { cssTextToStyle, escapeTemplate, isBinding, isEmptyStyle, joinClass } from "./jx-util.ts";
import type { JxElement, JxNode, JxStyle, Report } from "./types.ts";

export { escapeTemplate };

/**
 * Called for every attribute of every element in the markup, once, in document order, before
 * anything is converted, so what it returns is what every path into the output sees: an element's
 * own attributes, the markup of an element that holds its content as `innerHTML`, an svg's markup,
 * the text of an inline style. `tag` is the element's tag name, `name` the attribute as written
 * (`xlink:href`), `value` its decoded value. Return the value to use, `null` to drop the attribute,
 * `undefined` to leave it. This is where media and links are moved to where the Jx site has them:
 * two in five of the links in real block markup end up inside `innerHTML`, a string a caller
 * cannot reach any other way short of rewriting the source with a regular expression.
 *
 * Markup too deeply nested to convert (`html.too-deep`) is kept exactly as written, so the hook
 * never sees it.
 */
export type AttributeHook = (tag: string, name: string, value: string) => string | null | undefined;

export interface HtmlOptions {
  /**
   * Where the nodes are going. `page` (default): a Jx JSON page, which carries every shape this
   * module produces. `markdown`: a content entry, written by `serializeJxMarkdown`. That writes no
   * `innerHTML` at all (an element that holds its content that way comes out empty, and nothing
   * says so), so the content stays structured whatever `inlineGaps` and `svg` say: the first is
   * `children` and the second `tree`. The Jx build then shows the gap it would have shown, a space
   * before the full stop after `<b>bold</b>`, which a Markdown entry cannot avoid. What still has to
   * be markup (the text of a script or style, a literal `${`, a pre that starts with a newline,
   * markup nested too deeply) stays `innerHTML` and is reported as `html.innerhtml-unserialisable`:
   * it is missing from the entry. Also dropped by the serializer, and not reported here: the
   * attributes of an `a`, `img` or `ol` other than the ones Markdown has a place for (`href`,
   * `src`, `alt`, `title`, `start`) unless the element has a class, id or style, and a style's
   * custom properties, which it reads back as media queries.
   */
  target?: "page" | "markdown";
  /** Rewrites or drops attributes; see {@link AttributeHook}. */
  attribute?: AttributeHook;
  /**
   * `innerHTML` (default): an inline `<svg>` or `<math>` keeps its children as markup, which the
   * build writes verbatim. `tree`: its elements become nodes, with their real attribute names.
   */
  svg?: "innerHTML" | "tree";
  /**
   * `raw` (default): an element whose children the build would separate with a visible space holds
   * its content as `innerHTML`, so the page shows what the source showed. `children`: always keep
   * structured children, and accept the space.
   */
  inlineGaps?: "raw" | "children";
  /**
   * `object` (default): an inline style becomes a Jx style object, which the build writes as a rule
   * on the element's `id` or first class. `attribute`: it stays a `style` attribute. A rule gives
   * up what an inline style has: it beats every selector, a class rule beats none that is more
   * specific or `!important`, so a theme rule such as `.entry p { font-size: 1rem }` that lost to
   * the inline style on the source site wins against the converted one.
   *
   * With `object`, a style that a rule cannot carry stays an attribute anyway: the elements of one
   * call that share an id (`#id` selects all of them), a style that declares a property twice (a
   * fallback, which a browser reads declaration by declaration), and an id or first class that is
   * not a selector. An id is a name on the whole page, and only one call is seen at a time: two
   * fragments of a page that reuse an id with different styles need `attribute`.
   */
  inlineStyle?: "object" | "attribute";
  /**
   * Default true: an element with an inline style and a class but no id gets a generated first
   * class, because the build would otherwise write the style onto every element with that class.
   * (Not used with `inlineStyle: "attribute"`.)
   */
  scopeStyle?: boolean;
  /** Receives everything that could not be carried over; `where` and `url` locate it. */
  report?: Report;
  where?: string;
  url?: string;
}

/** The content half of an element: at most one of the three is set. */
export interface HtmlContent {
  textContent?: string;
  children?: JxNode[];
  innerHTML?: string;
}

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];
type P5Text = DefaultTreeAdapterMap["textNode"];
type P5Template = DefaultTreeAdapterMap["template"];

const NS_HTML = "http://www.w3.org/1999/xhtml";

// ── What the elements are ────────────────────────────────────────────────────────────────────────

/** Tag names Jx accepts (`jx validate`): letters first, then letters, digits, `.`, `_` and `-`. */
const VALID_TAG = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

const VOID = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Whitespace-significant by default. The Jx emitter adds no separators inside these either. */
const PREFORMATTED = new Set(["pre", "textarea", "listing", "plaintext", "xmp"]);

/** Raw-text elements: their content is never decoded, so it cannot be `textContent`. */
const RAW_TEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

type Display = "block" | "inline" | "atomic" | "br" | "none";

/** The default `display` of an HTML element, reduced to what whitespace handling needs. */
const BLOCK = new Set(
  (
    "address article aside blockquote body caption center col colgroup dd details dir div dl dt " +
    "fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr html legend li " +
    "listing main menu nav ol optgroup option p plaintext pre search section summary table " +
    "tbody td tfoot th thead tr ul xmp"
  ).split(" "),
);
const NOT_RENDERED = new Set(
  (
    "area base basefont datalist head link meta noembed noframes noscript param rp script " +
    "source style template title track"
  ).split(" "),
);
/** Inline-level boxes that are one unit to the line they sit in, and lay their own content out. */
const ATOMIC = new Set(
  "audio button canvas embed iframe img input math meter object progress select svg textarea video".split(
    " ",
  ),
);
/** SVG elements whose text is content, so whitespace between their children can matter. */
const SVG_TEXT = new Set(["text", "tspan", "textPath", "title", "desc", "a", "foreignObject"]);

const ASCII_WS = /[ \t\n\f\r]+/g;
const asciiWs = (s: string): string => s.replaceAll(ASCII_WS, " ");

// ── Intermediate tree ────────────────────────────────────────────────────────────────────────────

interface IrText {
  kind: "text";
  value: string;
  /** Whitespace is significant: inside `pre`, `textarea`, or an element styled `white-space: pre`. */
  keep: boolean;
}

interface IrEl {
  kind: "el";
  tag: string;
  display: Display;
  /** Whitespace in the content is significant (preformatted by tag or by an inline style). */
  pre: boolean;
  /** The build writes no separators between its children: it only knows the tags. */
  compilerPre: boolean;
  /** `display: flex|grid` from an inline style: whitespace between its children is ignored. */
  flexLike: boolean;
  /** An SVG/MathML element that holds shapes, not text: whitespace between its children is ignored. */
  shapes: boolean;
  /** The element draws something of its own at both ends (`q` and its quotation marks). */
  framed: boolean;
  /** A `pre`, `textarea` or `listing`: the parser drops a newline that starts its content. */
  dropsNewline: boolean;
  /** An own attribute holds a literal `${`. */
  tainted: boolean;
  id?: string;
  className?: string;
  style?: JxStyle;
  /** The `style` attribute as written, for an element whose style cannot be a rule. */
  styleText?: string;
  /** The style must stay a `style` attribute: as a rule it would be shared with, or beaten by, another. */
  keepStyle: boolean;
  attributes: Record<string, string>;
  children: Ir[];
  /** Content that is `innerHTML` whatever else is true of it (a foreign root, script, style). */
  raw?: string;
  /** The parse5 element itself (null for the fragment root), for exact re-serialisation. */
  node: P5Element | null;
  /** The parse5 nodes its content came from, likewise. */
  source: P5Node[];
}

type Ir = IrText | IrEl;

const isText = (node: P5Node): node is P5Text => node.nodeName === "#text";
const isElement = (node: P5Node): node is P5Element => "tagName" in node;

const childrenOf = (el: P5Element): P5Node[] =>
  el.tagName === "template" && NS_HTML === el.namespaceURI
    ? (el as P5Template).content.childNodes
    : el.childNodes;

// ── Serialising what stays markup ────────────────────────────────────────────────────────────────

const escText = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// Angle brackets in a value are written as references too, as the compiler writes them: Jx's image
// pass finds an `<img>` in innerHTML with `/<img\b([^>]*)>/`, which ends the tag at the first `>`
// even inside quotes, so `alt="Q&A -> answers"` would be cut in two.
const escAttr = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * Parse5 nodes back to HTML. Comments are dropped, as everywhere else. With `escape`, a literal
 * `${` in text and attribute values is written as a character reference (not inside raw text,
 * which the HTML parser does not decode; that content is written as it is). `hostIsPre` says the
 * nodes are the content of a `<pre>`, `<textarea>` or `<listing>` the caller writes around them.
 */
function serialize(nodes: P5Node[], escape: boolean, hostIsPre = false): string {
  const text = (value: string): string =>
    escape ? escapeTemplate(escText(value)) : escText(value);
  const attribute = (value: string): string =>
    escape ? escapeTemplate(escAttr(value)) : escAttr(value);
  const walk = (list: P5Node[], rawParent: boolean, firstNewline: boolean): string => {
    let out = "";
    // Text either side of a dropped comment is one run: `$<!-- -->{x}` must be escaped as `${x}`.
    let pending = "";
    const flush = (): void => {
      if (pending === "") return;
      // The parser drops one newline that follows <pre>, <textarea> and <listing>, so a text that
      // really starts with one, and is first once comments are gone, needs a second to survive.
      const lead = firstNewline && out === "" && pending.startsWith("\n") ? "\n" : "";
      out += lead + (rawParent ? pending : text(pending));
      pending = "";
    };
    for (const node of list) {
      if (isText(node)) {
        pending += node.value;
      } else if (isElement(node)) {
        flush();
        const html = node.namespaceURI === NS_HTML;
        let open = `<${node.tagName}`;
        for (const attr of node.attrs) {
          const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
          open += ` ${name}="${attribute(attr.value)}"`;
        }
        out += `${open}>`;
        if (html && VOID.has(node.tagName)) continue;
        out += walk(
          childrenOf(node),
          html && RAW_TEXT.has(node.tagName),
          html &&
            (node.tagName === "pre" || node.tagName === "textarea" || node.tagName === "listing"),
        );
        out += `</${node.tagName}>`;
      }
    }
    flush();
    return out;
  };
  return walk(nodes, false, hostIsPre);
}

// ── Building the intermediate tree ───────────────────────────────────────────────────────────────

interface Ctx {
  opts: HtmlOptions;
  /** The markup being converted, which positions in the parse tree index into. */
  html: string;
  /** How many elements of the fragment carry each id (as the hook left it). */
  ids: ReadonlyMap<string, number>;
  /** Inside a whitespace-significant element. */
  pre: boolean;
  /** Inside an element the build itself knows to be preformatted. */
  compilerPre: boolean;
  /** The namespace of the element being filled: `html`, or `foreign` inside an SVG/MathML tree. */
  foreign: boolean;
  parent: string;
  note: (code: string, severity: "info" | "warn" | "error", message: string, data?: object) => void;
}

/** `style` may force a display type or preserve whitespace regardless of the tag. */
function displayFrom(style: JxStyle | undefined): {
  display?: Display;
  flexLike: boolean;
  pre: boolean;
} {
  const word = (key: string): string => {
    const raw = style?.[key];
    return typeof raw === "string"
      ? raw
          .replace(/\s*!important$/i, "")
          .trim()
          .toLowerCase()
      : "";
  };
  const value = word("display");
  const space = style?.whiteSpace;
  const pre =
    typeof space === "string" && /^(pre|pre-wrap|pre-line|break-spaces)\b/i.test(space.trim());
  const flexLike = /^(inline-)?(flex|grid)$/.test(value);
  // Out of the flow, so not part of any line: it separates nothing, like an element not rendered.
  const floating =
    /^(absolute|fixed)$/.test(word("position")) || /^(left|right)$/.test(word("float"));
  if (value === "none" || floating) return { display: "none", flexLike, pre };
  if (value.startsWith("inline-")) return { display: "atomic", flexLike, pre };
  if (value === "inline" || value === "contents") return { display: "inline", flexLike, pre };
  if (value !== "") return { display: "block", flexLike, pre };
  return { flexLike, pre };
}

function displayOf(tag: string, el: P5Element, foreign: boolean): Display {
  if (foreign) return "inline";
  if (tag === "br") return "br";
  if (el.attrs.some((a) => a.name === "hidden" && a.value.toLowerCase() !== "until-found")) {
    return "none";
  }
  if (tag === "dialog") return el.attrs.some((a) => a.name === "open") ? "block" : "none";
  if (tag === "input") {
    return el.attrs.some((a) => a.name === "type" && a.value.toLowerCase() === "hidden")
      ? "none"
      : "atomic";
  }
  if (NOT_RENDERED.has(tag)) return "none";
  if (ATOMIC.has(tag)) return "atomic";
  return BLOCK.has(tag) ? "block" : "inline";
}

/** An own property, so that a name like `__proto__` is an attribute and not a prototype assignment. */
function setOwn(record: Record<string, string>, name: string, value: string): void {
  Object.defineProperty(record, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Whether an HTML attribute is a boolean one (`disabled`, `hidden`). `find` looks the name up in plain
 * objects, so `constructor` and `__proto__` find what every object has and come back with nothing.
 */
function booleanAttribute(name: string): Info | undefined {
  const info = find(htmlSchema, name) as Info | undefined;
  return info?.boolean || info?.overloadedBoolean ? info : undefined;
}

function mapAttributes(
  el: P5Element,
  ctx: Ctx,
): Pick<IrEl, "id" | "className" | "style" | "styleText" | "keepStyle" | "attributes" | "tainted"> {
  let id: string | undefined;
  let className: string | undefined;
  let style: JxStyle | undefined;
  let styleText: string | undefined;
  let keepStyle = false;
  let tainted = false;
  const attributes: Record<string, string> = {};
  const isHtml = el.namespaceURI === NS_HTML;
  const markdown = ctx.opts.target === "markdown";
  /**
   * A style that would be shared with, or beaten by, another on the page stays a `style` attribute,
   * which is exact. Not in an entry: the serializer writes an attribute as a string and Jx reads it
   * back as an element-level `style`, which must be an object, so the style stays an object there
   * and the finding is a warning. Nothing to settle when every style stays an attribute anyway.
   */
  const settle = (code: string, page: string, entry: string, data: object): void => {
    if (ctx.opts.inlineStyle === "attribute") return;
    if (!markdown) keepStyle = true;
    ctx.note(code, markdown ? "warn" : "info", markdown ? entry : page, data);
  };
  for (const attr of el.attrs) {
    const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
    let value = attr.value;
    if (isBinding(value)) tainted = true;
    if (name === "class") {
      const joined = value.split(ASCII_WS).filter(Boolean).join(" ");
      if (joined) className = joined;
    } else if (name === "id") {
      if (value !== "") id = value;
    } else if (name === "style") {
      const skipped: string[] = [];
      const repeated = new Set<string>();
      const parsed = cssTextToStyle(
        value,
        (declaration) => skipped.push(declaration),
        (property) => repeated.add(property),
      );
      if (skipped.length > 0) {
        ctx.note(
          "html.style-skipped",
          "warn",
          `Skipped ${skipped.length} unreadable inline style declaration(s) on <${el.tagName}>.`,
          { tag: el.tagName, skipped },
        );
      }
      if (!isEmptyStyle(parsed)) {
        style = parsed;
        styleText = value;
        // A browser throws away a declaration it cannot read, so the first of two survives when the
        // second is a hack or a prefix it does not know. A style object holds one value per property
        // and the text does not say which a browser would read.
        for (const property of repeated) {
          const what = `<${el.tagName}> declares \`${property}\` more than once with different values, which is how a fallback is written`;
          settle(
            "html.style-fallback",
            `${what}; its style stays a style attribute, since only a browser can tell which value it reads.`,
            `${what}; only the last is kept.`,
            { tag: el.tagName, property },
          );
        }
      }
    } else {
      if (isHtml) {
        const info = booleanAttribute(name);
        if (info && normalize(value) === normalize(info.attribute)) value = "";
      }
      setOwn(attributes, name, value);
    }
  }
  const count = id === undefined ? 0 : (ctx.ids.get(id) ?? 0);
  if (style !== undefined && id !== undefined && count > 1) {
    const what = `${count} elements have the id "${id}", and the build writes an element's style to \`#${id}\` for all of them`;
    settle(
      "html.id-duplicate",
      `${what}; the style of each stays a style attribute.`,
      `${what}; an entry cannot keep them as style attributes, so each gets the last.`,
      { id, count },
    );
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(className === undefined ? {} : { className }),
    ...(style === undefined ? {} : { style }),
    ...(styleText === undefined ? {} : { styleText }),
    keepStyle,
    attributes,
    tainted,
  };
}

function build(nodes: P5Node[], ctx: Ctx): Ir[] {
  const out: Ir[] = [];
  for (const node of nodes) {
    if (isText(node)) {
      // Between SVG shapes whitespace means nothing; only text-bearing elements keep it.
      if (ctx.foreign && !SVG_TEXT.has(ctx.parent) && node.value.trim() === "") continue;
      out.push({ kind: "text", value: node.value, keep: ctx.pre });
    } else if (isElement(node)) {
      out.push(...buildElement(node, ctx));
    }
  }
  return out;
}

/**
 * The markup between an element's tags exactly as the source wrote it, when that can be used as it
 * is: comments are dropped everywhere else, and a literal `${` has to be spelled for the build, so
 * either of those means writing the tree out again. So does an `<img>`, whose attribute values
 * would otherwise keep a `>` that Jx's image pass cannot read past.
 */
function originalContent(el: P5Element, ctx: Ctx): string | undefined {
  // The source says nothing of what a hook rewrote, and its quoted `>` would cut an img in two.
  if (ctx.opts.attribute) return undefined;
  const at = el.sourceCodeLocation;
  if (!at?.startTag || !at.endTag) return undefined;
  const slice = ctx.html.slice(at.startTag.endOffset, at.endTag.startOffset);
  return slice.includes("<!--") || isBinding(slice) || /<img[\s/>]/i.test(slice)
    ? undefined
    : slice;
}

function buildElement(el: P5Element, ctx: Ctx): Ir[] {
  const tag = el.tagName;
  const html = el.namespaceURI === NS_HTML;
  const foreignRoot = !html && !ctx.foreign;
  if (!VALID_TAG.test(tag)) {
    ctx.note(
      "html.tag-invalid",
      "warn",
      `<${tag}> is not a valid Jx tag name; its children were kept and the element dropped.`,
      { tag },
    );
    return build(childrenOf(el), ctx);
  }

  const head = mapAttributes(el, ctx);
  const forced = displayFrom(head.style);
  const compilerPre = ctx.compilerPre || (html && PREFORMATTED.has(tag));
  const pre = ctx.pre || compilerPre || forced.pre;
  const display: Display = forced.display ?? (foreignRoot ? "atomic" : displayOf(tag, el, !html));
  const source = childrenOf(el);
  const ir: IrEl = {
    kind: "el",
    tag,
    display,
    pre,
    compilerPre,
    flexLike: forced.flexLike,
    shapes: !html && !SVG_TEXT.has(tag),
    framed: html && tag === "q",
    dropsNewline: html && (tag === "pre" || tag === "textarea" || tag === "listing"),
    ...head,
    children: [],
    node: el,
    source,
  };

  if (html && VOID.has(tag)) return [ir];

  if (html && RAW_TEXT.has(tag)) {
    const text = source
      .filter(isText)
      .map((n) => n.value)
      .join("");
    if (text !== "") {
      if (isBinding(text)) {
        ctx.note(
          "html.template-raw-text",
          "error",
          `<${tag}> contains a literal \${ that cannot be escaped there; the build may evaluate it.`,
          { tag },
        );
      }
      ir.raw = text;
    }
    return [ir];
  }

  if (foreignRoot && ctx.opts.svg !== "tree") {
    if (source.length > 0) ir.raw = originalContent(el, ctx) ?? serialize(source, true);
    return [ir];
  }

  ir.children = build(source, { ...ctx, pre, compilerPre, foreign: !html, parent: tag });
  return [ir];
}

// ── Whitespace ───────────────────────────────────────────────────────────────────────────────────

/**
 * Where the inline flow stands: `space` when the last thing in it was a collapsible space or the
 * line has just begun (the next space collapses into it), `last` the text that ends in that space,
 * so a flow's closing space can be taken back off.
 */
interface Flow {
  space: boolean;
  last: IrText | null;
}

function trim(flow: Flow): void {
  if (flow.last) {
    flow.last.value = flow.last.value.slice(0, -1);
    flow.last = null;
  }
}

function markKept(items: Ir[]): void {
  for (const item of items) {
    if (item.kind === "text") item.keep = true;
    else markKept(item.children);
  }
}

const hasText = (items: Ir[]): boolean =>
  items.some((i) => (i.kind === "text" ? i.value !== "" : hasText(i.children)));

/**
 * Whitespace as a browser renders it: runs collapse to one space, a space at the start or end of a
 * line (block boundary, `<br>`) disappears, and two spaces that meet across an inline boundary
 * become one. The tree is edited in place and empty text left for `tidy` to remove.
 */
function flowItems(items: Ir[], flow: Flow): void {
  for (const item of items) {
    if (item.kind === "text") {
      if (item.keep) {
        if (item.value !== "") {
          flow.space = false;
          flow.last = null;
        }
        continue;
      }
      let value = asciiWs(item.value);
      if (flow.space && value.startsWith(" ")) value = value.slice(1);
      item.value = value;
      if (value === "") continue;
      flow.space = value.endsWith(" ");
      flow.last = flow.space ? item : null;
      continue;
    }
    switch (item.display) {
      case "none":
        flowRoot(item);
        break;
      case "br":
        trim(flow);
        flow.space = true;
        break;
      case "block":
        trim(flow);
        flowRoot(item);
        flow.space = true;
        flow.last = null;
        break;
      case "atomic":
        flowRoot(item);
        flow.space = false;
        flow.last = null;
        break;
      case "inline":
        if (item.pre) {
          markKept(item.children);
          if (hasText(item.children)) {
            flow.space = false;
            flow.last = null;
          }
        } else if (item.children.length === 0) {
          // It may draw something (an icon font's ::before), so it is not nothing.
          flow.space = false;
          flow.last = null;
        } else {
          if (item.framed) {
            flow.space = false;
            flow.last = null;
          }
          flowItems(item.children, flow);
          if (item.framed) {
            flow.space = false;
            flow.last = null;
          }
        }
        break;
    }
  }
}

/** An element whose content is a line of its own: block, atomic inline, or not rendered. */
function flowRoot(el: IrEl): void {
  if (el.pre) {
    markKept(el.children);
    return;
  }
  // A framed element (`q`) draws before its first line and after its last, so neither edge is a
  // line edge, even when the element is a block.
  const flow: Flow = { space: !el.framed, last: null };
  flowItems(el.children, flow);
  if (!el.framed) trim(flow);
}

/** Drop empty text and merge neighbours, everywhere. Adjacent strings would get a separator. */
function tidy(items: Ir[]): Ir[] {
  const out: Ir[] = [];
  for (const item of items) {
    if (item.kind === "text") {
      if (item.value === "") continue;
      const prev = out.at(-1);
      if (prev?.kind === "text" && prev.keep === item.keep) prev.value += item.value;
      else out.push(item);
    } else {
      item.children = tidy(item.children);
      out.push(item);
    }
  }
  return out;
}

// ── Choosing how an element carries its content ──────────────────────────────────────────────────

type Edge = "break" | "space" | "visible" | "zwsp";

const ZWSP = "\u200b";

/**
 * What the line sees at one end of an item: a break, a space, something visible, or a zero-width
 * space (`wbr` is one to Blink), which the build's separator treats differently from any other
 * character. `null` means the item is not rendered and the boundary is really between its
 * neighbours.
 */
function edgeOf(item: Ir, side: "start" | "end"): Edge | null {
  if (item.kind === "text") {
    if (item.keep) return "visible";
    // A collapsible space between the character and the edge is removed with the segment break.
    const bare = side === "start" ? item.value.replace(/^ /, "") : item.value.replace(/ $/, "");
    if ((side === "start" ? bare.at(0) : bare.at(-1)) === ZWSP) return "zwsp";
    const ch = side === "start" ? item.value.at(0) : item.value.at(-1);
    return ch === " " ? "space" : "visible";
  }
  if (item.display === "none") return null;
  if (item.display === "block" || item.display === "br") return "break";
  if (item.tag === "wbr") return "zwsp";
  if (item.display === "atomic" || item.framed) return "visible";
  const kids = side === "start" ? item.children : [...item.children].reverse();
  for (const kid of kids) {
    const edge = edgeOf(kid, side);
    if (edge !== null) return edge;
  }
  // An empty inline element can still draw something (an icon font's ::before).
  return "visible";
}

/**
 * Whether the build's separator between these siblings would change what the page shows. It is
 * invisible next to a break and next to a space that is already there, and it is a new space
 * between two things that touched. It also moves a space: in front of one that starts an inline
 * element (`Interior<a> Painting</a>`) it comes first and wins, so the space ends up outside the
 * link and the link's box is a space narrower. A space that starts a text sibling is the same
 * space either way.
 *
 * Beside U+200B the separator is nothing: CSS Text removes a segment break that touches one, and
 * the spaces next to the break go with it, so a space the source wrote there is lost.
 */
function hasVisibleGap(items: Ir[]): boolean {
  let before: Ir | undefined;
  for (const item of items) {
    if (item.kind === "el" && item.display === "none") continue;
    if (before) {
      const left = edgeOf(before, "end");
      const right = edgeOf(item, "start");
      if ((left === "zwsp" || right === "zwsp") && left !== "break" && right !== "break") {
        return true;
      }
      if (left === "visible" && right !== "break" && !(right === "space" && item.kind === "text")) {
        return true;
      }
    }
    before = item;
  }
  return false;
}

/**
 * The build puts its separator between every two children, rendered or not. After the last one
 * that is rendered it lands at the end of an inline element, where it shows whenever anything
 * visible follows: it joins the element's box and takes the place of the space after it, so a link
 * is a space wider. (Before the first child it meets whatever precedes the element, which
 * `hasVisibleGap` judges at that level.) A block ends its line there, and an atom lays out its own.
 */
function endsHidden(el: IrEl, items: Ir[]): boolean {
  const last = items.at(-1);
  return (
    el.display === "inline" && items.length > 1 && last?.kind === "el" && last.display === "none"
  );
}

const hashOf = (style: JxStyle): string =>
  createHash("sha1").update(JSON.stringify(style)).digest("hex").slice(0, 10);

/** What the conversion hands back to emit with: the options, and the report with its de-duplication. */
interface Emit {
  opts: HtmlOptions;
  note: Ctx["note"];
}

/** Why an element's content had to stay `innerHTML` when no other form could carry it. */
type Unserialisable = "raw-text" | "template" | "pre-newline" | "too-deep";

const UNSERIALISABLE: Record<Unserialisable, string> = {
  "raw-text": "its text is raw text, which no other form can carry",
  template: "it holds a literal ${, which no other form can carry",
  "pre-newline": "its text starts with a newline that no other form can carry",
  "too-deep": "it is nested too deeply to convert",
};

function emitContent(el: IrEl, em: Emit): HtmlContent {
  const markup = (innerHTML: string, reason: Unserialisable): HtmlContent => {
    if (em.opts.target === "markdown") {
      const who = el.tag === "" ? "The content" : `<${el.tag}>`;
      em.note(
        "html.innerhtml-unserialisable",
        "warn",
        `${who} stays innerHTML because ${UNSERIALISABLE[reason]}, and the Markdown serializer does not write innerHTML: it is missing from the entry.`,
        { ...(el.tag === "" ? {} : { tag: el.tag }), reason },
      );
    }
    return { innerHTML };
  };
  if (el.raw !== undefined) return markup(el.raw, "raw-text");
  const items = el.children;
  if (items.length === 0) return {};
  const tainted = items.some((i) => (i.kind === "text" ? isBinding(i.value) : i.tainted));
  // The build writes a pre's text as it is, and the parser then drops a newline that starts it.
  const first = items[0];
  const newline = el.dropsNewline && first?.kind === "text" && first.value.startsWith("\n");
  // Where the build adds separators but whitespace is significant, any boundary shows.
  const gap =
    em.opts.inlineGaps !== "children" &&
    !el.compilerPre &&
    !el.flexLike &&
    !el.shapes &&
    (el.pre ? items.length > 1 : hasVisibleGap(items) || endsHidden(el, items));
  if (tainted || gap || newline) {
    const innerHTML = serialize(el.source, true, el.dropsNewline);
    // A gap is never kept for an entry (`inlineGaps` is `children` there), so it needs no reason.
    return tainted || newline
      ? markup(innerHTML, tainted ? "template" : "pre-newline")
      : { innerHTML };
  }
  const only = items[0];
  if (items.length === 1 && only?.kind === "text") return { textContent: only.value };
  return { children: items.map((item) => emitItem(item, em)) };
}

function emitItem(item: Ir, em: Emit): JxNode {
  return item.kind === "text" ? item.value : emitElement(item, em);
}

/** What a CSS selector can name without escaping: `#id` and `.class` need an identifier. */
const CSS_IDENT = /^(?:-?[_a-zA-Z\u0080-\uFFFF]|--)[_a-zA-Z0-9\u0080-\uFFFF-]*$/;

function emitElement(el: IrEl, em: Emit): JxElement {
  const { opts } = em;
  const node: JxElement = { tagName: el.tag };
  let className = el.className;
  let attributes = el.attributes;
  let style = el.style;
  if (style && el.styleText !== undefined) {
    // The build writes the rule to `#id`, else to the first class, else to a class of its own.
    if (
      opts.inlineStyle !== "attribute" &&
      el.id === undefined &&
      className !== undefined &&
      opts.scopeStyle !== false
    ) {
      className = joinClass(`jx-${hashOf(style)}`, className);
    }
    const target = el.id ?? className?.split(" ")[0];
    const usable = target === undefined || CSS_IDENT.test(target);
    if (
      opts.inlineStyle === "attribute" ||
      el.keepStyle ||
      (!usable && opts.target !== "markdown")
    ) {
      // Asked for, or shared with another element or beaten by one of its own declarations, or
      // `#cancel-comment-reply-link{idadd}` / `#1st`, which is not a selector: the browser would drop
      // the rule and the element would lose its style, so keep it inline.
      attributes = { ...attributes, style: el.styleText };
      style = undefined;
      className = el.className;
    } else if (!usable) {
      em.note(
        "html.style-selector",
        "warn",
        `The style of <${el.tag}> would be written to \`${el.id === undefined ? "." : "#"}${target}\`, which is not a selector, and an entry cannot keep it as a style attribute: the style is lost.`,
        { tag: el.tag, target },
      );
    }
  }
  if (el.id !== undefined) node.id = el.id;
  if (className !== undefined) node.className = className;
  if (style) node.style = style;
  if (Object.keys(attributes).length > 0) node.attributes = attributes;
  Object.assign(node, emitContent(el, em));
  return node;
}

// ── Public API ───────────────────────────────────────────────────────────────────────────────────

/** Add a finding to the caller's report, if there is one, located as the caller asked. */
function report(
  opts: HtmlOptions,
  severity: "info" | "warn" | "error",
  code: string,
  message: string,
  data?: object,
): void {
  opts.report?.add({
    severity,
    code,
    message,
    ...(opts.where === undefined ? {} : { where: opts.where }),
    ...(opts.url === undefined ? {} : { url: opts.url }),
    ...(data === undefined ? {} : { data: data as Record<string, unknown> }),
  });
}

/**
 * No browser builds a tree deeper than this (Blink stops at 512; the rest of the markup lands at
 * that depth). Jx's build overflows its stack at about 1,300 levels and `jx validate` at 39, so a
 * deeper fragment is kept whole as markup rather than converted into something they cannot read.
 */
const MAX_DEPTH = 512;

/**
 * What happens to the parsed tree before anything reads it. Refuse what is nested deeper than
 * `MAX_DEPTH`, found with an explicit stack: waiting for a recursion to overflow only finds out
 * at 7,000 levels. Then apply the attribute hook to every attribute in document order, in the tree
 * itself, so every later reading (an element's own attributes, markup written out afterwards) sees
 * the same values and the hook hears each attribute once. And count each id, which the build turns
 * into one `#id` rule per element that has a style.
 */
function survey(nodes: P5Node[], hook: AttributeHook | undefined): Map<string, number> {
  const elements: P5Element[] = [];
  const frames: { list: P5Node[]; at: number }[] = [{ list: nodes, at: 0 }];
  for (let frame = frames.at(-1); frame; frame = frames.at(-1)) {
    const node = frame.list[frame.at++];
    if (node === undefined) {
      frames.pop();
    } else if (isElement(node)) {
      if (frames.length > MAX_DEPTH)
        throw new RangeError(`markup nested more than ${MAX_DEPTH} deep`);
      elements.push(node);
      frames.push({ list: childrenOf(node), at: 0 });
    }
  }
  const ids = new Map<string, number>();
  for (const el of elements) {
    if (hook) {
      el.attrs = el.attrs.filter((attr) => {
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        const value = hook(el.tagName, name, attr.value);
        if (typeof value === "string") attr.value = value;
        return value !== null;
      });
    }
    const id = el.attrs.find((attr) => attr.name === "id" && !attr.prefix)?.value;
    if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  return ids;
}

function parse(html: string, opts: HtmlOptions): { root: IrEl; em: Emit } {
  const seen = new Set<string>();
  const note: Ctx["note"] = (code, severity, message, data) => {
    // One declaration or tag repeated through a fragment is one finding.
    const key = `${code}\0${message}\0${JSON.stringify(data)}`;
    if (seen.has(key)) return;
    seen.add(key);
    report(opts, severity, code, message, data);
  };
  const fragment = parseFragment(html, { scriptingEnabled: false, sourceCodeLocationInfo: true });
  const ids = survey(fragment.childNodes, opts.attribute);
  const root: IrEl = {
    kind: "el",
    tag: "",
    display: "block",
    pre: false,
    compilerPre: false,
    flexLike: false,
    shapes: false,
    framed: false,
    dropsNewline: false,
    tainted: false,
    keepStyle: false,
    attributes: {},
    children: [],
    node: null,
    source: fragment.childNodes,
  };
  root.children = build(fragment.childNodes, {
    opts,
    html,
    ids,
    pre: false,
    compilerPre: false,
    foreign: false,
    parent: "",
    note,
  });
  flowRoot(root);
  root.children = tidy(root.children);
  return { root, em: { opts, note } };
}

/**
 * Markup nested thousands deep (a post whose unclosed `<div>`s were repeated by a plugin) is more
 * than a browser would build and more than Jx can read, and a recursion over it would overflow the
 * stack. Such a fragment is kept whole as markup rather than aborting a run. Only a `RangeError` is
 * that: anything else is a caller's mistake, or a bug, and is thrown.
 */
function tooDeep(error: unknown, html: string, opts: HtmlOptions): string {
  if (!(error instanceof RangeError)) throw error;
  report(
    opts,
    "warn",
    "html.too-deep",
    "Markup nested too deeply to convert as elements; kept as one innerHTML.",
    {
      length: html.length,
    },
  );
  if (opts.target === "markdown") {
    report(
      opts,
      "warn",
      "html.innerhtml-unserialisable",
      `The markup stays innerHTML because ${UNSERIALISABLE["too-deep"]}, and the Markdown serializer does not write innerHTML: it is missing from the entry.`,
      { reason: "too-deep" },
    );
  }
  return escapeTemplate(html);
}

/** What `target: "markdown"` means for the other options: structure, since nothing else survives. */
const forTarget = (opts: HtmlOptions): HtmlOptions =>
  opts.target === "markdown"
    ? { ...opts, inlineGaps: "children", inlineStyle: "object", svg: "tree" }
    : opts;

/**
 * Convert HTML to Jx nodes. Every element it returns is exact. What it cannot make exact is the
 * boundary between the returned siblings, because the build places them in a parent it does not
 * know: when they are the inline content of an element (`<b>bold</b>.`), fill the element with
 * `htmlToContent` instead.
 */
export function htmlToNodes(html: string, opts: HtmlOptions = {}): JxNode[] {
  const options = forTarget(opts);
  try {
    return convertNodes(html, options);
  } catch (error) {
    return [
      {
        tagName: "div",
        style: { display: "contents" },
        innerHTML: tooDeep(error, html, options),
      },
    ];
  }
}

function convertNodes(html: string, opts: HtmlOptions): JxNode[] {
  const { root, em } = parse(html, opts);
  return root.children.map((item): JxNode => {
    const literal = item.kind === "text" ? isBinding(item.value) : item.tainted;
    if (!literal) return emitItem(item, em);
    // Nothing above it can hold this one raw: wrap it in an element that lays out as nothing.
    report(
      opts,
      "warn",
      "html.template-wrapped",
      "A literal ${ at the top of a fragment can only be kept inside an innerHTML; it was wrapped in a display: contents element.",
    );
    if (opts.target === "markdown") {
      report(
        opts,
        "warn",
        "html.innerhtml-unserialisable",
        `The wrapper holds its content as innerHTML because ${UNSERIALISABLE.template}, and the Markdown serializer does not write innerHTML: it is missing from the entry.`,
        { reason: "template" },
      );
    }
    const block = item.kind === "el" && (item.display === "block" || item.display === "br");
    return {
      tagName: block ? "div" : "span",
      style: { display: "contents" },
      innerHTML:
        item.kind === "text"
          ? escapeTemplate(escText(item.value))
          : serialize(item.node ? [item.node] : [], true),
    };
  });
}

/**
 * Convert HTML that is the content of one element, and say how that element should hold it:
 * `textContent` for a single string, `children` for structured content, `innerHTML` where the
 * build would otherwise show a gap or evaluate a literal `${`. Spread the result into the element.
 */
export function htmlToContent(html: string, opts: HtmlOptions = {}): HtmlContent {
  const options = forTarget(opts);
  try {
    const { root, em } = parse(html, options);
    return emitContent(root, em);
  } catch (error) {
    return { innerHTML: tooDeep(error, html, options) };
  }
}

// ── Rendering Jx back to HTML ────────────────────────────────────────────────────────────────────

/**
 * A static rendering of Jx nodes as HTML, for tests and verification: `className` becomes `class`,
 * flat style declarations become an inline `style`, `attributes` are written as given, and
 * `innerHTML` is written raw. It does what the HTML means, not what the Jx emitter does: no
 * separators between children, and `<script>`/`<style>` text is not escaped. A boolean attribute is
 * written the way the emitter writes it (`booleanAttrValue`): its presence for `disabled`, its
 * word for `aria-hidden`, `draggable`, `contenteditable` and `spellcheck`, where a bare attribute
 * or none would mean something else. Nested style keys (`:hover`, `@--md`) have no inline form and
 * are left out.
 */
export function nodesToHtml(nodes: JxNode[]): string {
  return nodes.map((node) => renderNode(node, false)).join("");
}

function declarationsOf(style: JxStyle): string {
  return Object.entries(style)
    .filter((entry): entry is [string, string | number] => {
      const value = entry[1];
      return typeof value === "string" || typeof value === "number";
    })
    .map(([key, value]) => `${cssPropertyName(key)}: ${value}`)
    .join("; ");
}

function renderNode(node: JxNode, rawParent: boolean): string {
  if (typeof node === "string") return rawParent ? node : escText(node);
  const tag = node.tagName ?? "div";
  if (typeof tag !== "string") throw new Error("nodesToHtml cannot render a computed tagName");
  let open = `<${tag}`;
  const put = (name: string, value: string | number | boolean | null | undefined): void => {
    if (value === undefined || value === null) return;
    const text = typeof value === "boolean" ? booleanAttrValue(name, value) : String(value);
    if (text === null) return;
    open += typeof value === "boolean" && text === "" ? ` ${name}` : ` ${name}="${escAttr(text)}"`;
  };
  put("id", node.id);
  put("class", node.className);
  const inline = node.style ? declarationsOf(node.style) : "";
  if (inline) put("style", inline);
  put("hidden", node.hidden);
  put("tabindex", node.tabIndex);
  put("title", node.title);
  put("lang", node.lang);
  put("dir", node.dir);
  for (const [name, value] of Object.entries(node.attributes ?? {})) {
    if (typeof value !== "object") put(name, value);
  }
  open += ">";
  if (VOID.has(tag)) return open;
  const raw = RAW_TEXT.has(tag);
  // innerHTML is the markup between the tags, as the Jx emitter writes it, so a newline that starts
  // it is already doubled where it must be (htmlToNodes does that). Text is not: the parser drops
  // the first newline after <pre>, so text that starts with one needs a second to survive.
  if (node.innerHTML !== undefined) return `${open}${node.innerHTML}</${tag}>`;
  let inner = "";
  if (typeof node.textContent === "string") {
    inner = raw ? node.textContent : escText(node.textContent);
  } else if (Array.isArray(node.children)) {
    inner = node.children.map((c) => renderNode(c, raw)).join("");
  }
  const lead =
    inner.startsWith("\n") && (tag === "pre" || tag === "textarea" || tag === "listing")
      ? "\n"
      : "";
  return `${open}${lead}${inner}</${tag}>`;
}
