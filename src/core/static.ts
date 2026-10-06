/**
 * Saved block markup to Jx nodes: the machinery every converter of a STATIC block shares.
 *
 * A static block's `save()` output is exactly what the site printed, so converting it is converting
 * HTML. Three things happen on the way that `htmlToNodes` cannot know about:
 *
 * - **Inner blocks.** The block's `innerContent` holds the saved markup with a `null` where each inner
 *   block goes. Each `null` becomes a marker element, the whole string is converted as one fragment
 *   (so the parent's elements nest around the markers exactly as the browser would build them), and
 *   each marker is replaced by what `ctx.convert` made of the inner block. An inner block whose marker
 *   did not survive (the parser moved it, or the build chose `innerHTML` for its parent) is appended
 *   rather than lost, and reported.
 * - **Addresses.** Every `href`, `src`, `poster`, `data`, `action` and CSS `url()` goes through
 *   `ctx.rewriteUrl`; an image that resolves through `ctx.mediaForUrl` gets the media plan's path and
 *   dimensions; `srcset` and `sizes` are dropped from an `img` because the Jx build regenerates them; a
 *   link that opens a new window gets `rel="noopener"`. An image with no size of its own gets the size
 *   of the file its address named (the `-300x300` derivative WordPress printed it at), not of the
 *   original the plan ships. For a post's content, what WordPress does when it prints it is done too:
 *   `wptexturize` over the text and, when Rank Math says so, `target="_blank"` on links to other sites
 *   ({@link contentOptions}). The markup is edited in the parse tree and
 *   written back before `htmlToNodes` reads it, which is the only place an attribute can be ADDED
 *   (`htmlToNodes`' own `attribute` hook can only rewrite or drop), and which reaches the markup that
 *   ends up inside an `innerHTML` string, a place no later pass can touch. The write-back is exact:
 *   `htmlToNodes` returns identical nodes for the markup of all 4,981 real fragments of both fixture
 *   sites before and after it.
 * - **Where the nodes go.** A Jx page keeps what it cannot build as `innerHTML`; a Markdown entry is
 *   written by a serializer that writes none. `targetOf` says which this conversion is for. For an
 *   entry the nodes are also put right for the serializer (see `markdownSafe`: a list or table with a
 *   class, text next to an inline element in a list item, a line break inside emphasis), by writing
 *   and reading back every converted block of both sites; what no node can fix (the space the build
 *   writes between inline siblings) is reported.
 *
 * Report codes: `block.inner-misplaced`, `block.inline-gap`, `block.markdown-attributes-dropped`,
 * `block.table-span-dropped`, `block.icon-dropped`, `block.line-break-dropped`,
 * `block.link-attributes-dropped`, `block.list-type-dropped`, `block.pre-flattened` and
 * `block.text-directive`, besides what `htmlToNodes` reports (`html.*`).
 */
import type { DefaultTreeAdapterMap } from "parse5";
import { parseFragment, serialize } from "parse5";
import valueParser from "postcss-value-parser";
import { htmlToContent, htmlToNodes } from "../html.ts";
import type { HtmlContent, HtmlOptions } from "../html.ts";
import { texturizeHtml } from "../cwicly/tokens.ts";
import { joinClass } from "../jx-util.ts";
import type { ConvertCtx, JxElement, JxNode, ReportEntry, Severity, WpBlock } from "../types.ts";
import { publicUrl } from "../wp/model.ts";
import { maybeUnserialize } from "../wp/phpser.ts";

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];
type P5Text = DefaultTreeAdapterMap["textNode"];
type P5Template = DefaultTreeAdapterMap["template"];

// ── Where a conversion is for, and where it reports ──────────────────────────────────────────────

/** What the converted nodes are written into: a Jx JSON page, or a Markdown content entry. */
export type NodeTarget = "page" | "markdown";

/**
 * Post types whose conversion is a JSON document. Everything else that is a post (a `post`, a custom
 * post type) is a Markdown entry; templates, parts, components and reusable blocks are never entries.
 */
const DOCUMENT_TYPES = new Set(["page", "wp_template", "wp_template_part", "cc_block", "wp_block"]);

/**
 * Where this conversion's nodes are going. A driver says so with `ctx.target`; without it the subject
 * decides, following the decisions the design records (pages are JSON pages, every other post type is a
 * Markdown entry). Guessing a page for an entry is the costly mistake, because the serializer writes no
 * `innerHTML`: the structured form is the one that is valid in both, so a conversion with no subject
 * to judge by is a page only when it cannot be an entry.
 */
export function targetOf(ctx: ConvertCtx): NodeTarget {
  const explicit = (ctx as ConvertCtx & { target?: NodeTarget }).target;
  if (explicit === "page" || explicit === "markdown") return explicit;
  if (ctx.subject.kind !== "post") return "page";
  const type = ctx.subject.post?.type;
  return type === undefined || DOCUMENT_TYPES.has(type) ? "page" : "markdown";
}

/** `post:5246`, `template:cwicly//header`: how every entry in the report locates its subject. */
export function whereOf(ctx: ConvertCtx): string {
  return `${ctx.subject.kind}:${ctx.subject.id}`;
}

/** Add a finding located at the subject being converted, with its public address when it has one. */
export function note(
  ctx: ConvertCtx,
  severity: Severity,
  code: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const url = ctx.subject.post ? publicUrl(ctx.model.site, ctx.subject.post) : undefined;
  const entry: ReportEntry = {
    severity,
    code,
    message,
    where: whereOf(ctx),
    ...(url === undefined ? {} : { url }),
    ...(data === undefined ? {} : { data }),
  };
  ctx.report.add(entry);
}

// ── Options ──────────────────────────────────────────────────────────────────────────────────────

export interface StaticOptions {
  /**
   * Markup to convert instead of the block's own `innerContent`, for a converter that has corrected or
   * built the markup. Inner blocks are then not stitched (there is no `null` to mark where they go).
   */
  html?: string;
  /**
   * `object` (default): an inline style becomes a style object, the only form a Markdown entry can
   * carry. `attribute`: it stays a `style` attribute, which keeps beating every selector as it did on
   * the source site (see `HtmlOptions.inlineStyle`); only a JSON page can hold one.
   */
  inlineStyle?: "object" | "attribute";
  /** Passed through to `htmlToNodes`. */
  scopeStyle?: boolean;
  /**
   * Changes to the block's root element (the first element of the markup), made in the parse tree
   * before the markup is converted, so the conversion scopes any style it ends up holding to the right
   * class. A class the root already has is not added twice; a declaration it already has is not
   * overridden, because the markup's own inline style is the author's.
   */
  root?: RootChanges;
  /**
   * Passed through to `htmlToNodes` (`InlineGaps`). `staticBlock` sets `children` itself for a block
   * whose inner blocks the default would swallow into an `innerHTML` string.
   */
  inlineGaps?: "raw" | "children";
  /** Overrides {@link targetOf}. */
  target?: NodeTarget;
  /**
   * Run `wptexturize` over the markup's text (curly quotes, en dashes, ellipses), as WordPress does to
   * everything `the_content` prints. On for saved content (`staticBlock`, raw HTML and classic blocks, see
   * {@link contentOptions}), off for text a converter builds itself, which WordPress prints another way.
   */
  texturize?: boolean;
  /**
   * Open links to other sites in a new window, as Rank Math's `new_window_external_links` does at render
   * time. See {@link contentOptions}.
   */
  externalLinks?: boolean;
}

export interface RootChanges {
  /**
   * Make the changes to the first element inside the root that has this class (a cover's inner
   * container, where WordPress puts the layout classes of a block that wraps its inner blocks) instead
   * of the root; the root itself when there is none.
   */
  within?: string;
  classes?: readonly (string | false | undefined)[];
  /** `[property, value]` pairs, kebab-case, as a `style` attribute writes them. */
  style?: readonly (readonly [string, string])[];
  attributes?: Readonly<Record<string, string>>;
}

function htmlOptions(ctx: ConvertCtx, opts: StaticOptions): HtmlOptions {
  const url = ctx.subject.post ? publicUrl(ctx.model.site, ctx.subject.post) : undefined;
  return {
    target: opts.target ?? targetOf(ctx),
    ...(opts.inlineStyle === undefined ? {} : { inlineStyle: opts.inlineStyle }),
    ...(opts.scopeStyle === undefined ? {} : { scopeStyle: opts.scopeStyle }),
    ...(opts.inlineGaps === undefined ? {} : { inlineGaps: opts.inlineGaps }),
    report: ctx.report,
    where: whereOf(ctx),
    ...(url === undefined ? {} : { url }),
  };
}

// ── Addresses ────────────────────────────────────────────────────────────────────────────────────

const NS_HTML = "http://www.w3.org/1999/xhtml";

/** The attributes that hold an address, by element. `srcset` and `style` are handled apart. */
const ADDRESS_ATTRS: ReadonlyMap<string, readonly string[]> = new Map([
  ["a", ["href"]],
  ["area", ["href"]],
  ["link", ["href"]],
  ["img", ["src"]],
  ["video", ["src", "poster"]],
  ["audio", ["src"]],
  ["source", ["src"]],
  ["track", ["src"]],
  ["iframe", ["src"]],
  ["embed", ["src"]],
  ["script", ["src"]],
  ["input", ["src"]],
  ["object", ["data"]],
  ["form", ["action"]],
]);

/**
 * An address worth asking about: absolute, protocol-relative or root-relative. A fragment, a `mailto:`
 * or `tel:` link, a `data:` URL and a bare `page.html` (no base to resolve against) are none of those.
 */
const ADDRESS = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i;

interface Rewriter {
  /** `url` as the Jx site has it, or the same string when nothing accounts for it. */
  address(url: string): string;
  /** The same for an image: the media plan's path and size when it knows the file. */
  image(url: string): { src: string; width?: number; height?: number } | undefined;
}

function rewriter(ctx: ConvertCtx): Rewriter {
  const usable = (url: string): boolean => ADDRESS.test(url.trim());
  return {
    address: (url) => (usable(url) ? ctx.rewriteUrl(url.trim()) : url),
    image: (url) => (usable(url) ? ctx.mediaForUrl(url.trim()) : undefined),
  };
}

/** Every `url(...)` in CSS text goes through `fn`; text with none is returned as it is. */
function mapCssUrls(css: string, fn: (url: string) => string): string {
  if (!/url\(/i.test(css)) return css;
  const parsed = valueParser(css);
  let changed = false;
  parsed.walk((node) => {
    if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
    const arg = node.nodes[0];
    if (!arg || (arg.type !== "word" && arg.type !== "string")) return;
    const next = fn(arg.value);
    if (next !== arg.value) {
      arg.value = next;
      changed = true;
    }
  });
  return changed ? parsed.toString() : css;
}

/** `srcset` candidates (`url 2x, url 300w`) with each address rewritten. */
function mapSrcset(srcset: string, fn: (url: string) => string): string {
  return srcset
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (trimmed === "") return trimmed;
      const at = trimmed.search(/\s/);
      return at === -1 ? fn(trimmed) : `${fn(trimmed.slice(0, at))}${trimmed.slice(at)}`;
    })
    .join(", ");
}

const childNodes = (node: P5Node): P5Node[] => {
  if ("tagName" in node && node.tagName === "template" && node.namespaceURI === NS_HTML) {
    return (node as P5Template).content.childNodes;
  }
  return "childNodes" in node ? node.childNodes : [];
};

const attr = (el: P5Element, name: string): string | undefined =>
  el.attrs.find((a) => a.name === name && !a.prefix)?.value;

function setAttr(el: P5Element, name: string, value: string): void {
  const existing = el.attrs.find((a) => a.name === name && !a.prefix);
  if (existing) existing.value = value;
  else el.attrs.push({ name, value });
}

const hasDeclaration = (style: string, property: string): boolean =>
  style.split(";").some((d) => d.slice(0, d.indexOf(":")).trim().toLowerCase() === property);

/** The first element at or under `el` (document order) that has the class `name`. */
function firstWithClass(el: P5Element, name: string): P5Element | undefined {
  for (const node of childNodes(el)) {
    if (!("tagName" in node)) continue;
    const child = node as P5Element;
    if ((attr(child, "class") ?? "").split(/\s+/).includes(name)) return child;
    const inner = firstWithClass(child, name);
    if (inner) return inner;
  }
  return undefined;
}

function changeRoot(el: P5Element, change: RootChanges): void {
  const classes = joinClass(attr(el, "class"), ...(change.classes ?? []));
  if (classes !== "") setAttr(el, "class", classes);
  if (change.style && change.style.length > 0) {
    let style = (attr(el, "style") ?? "").trim().replace(/;$/, "");
    for (const [property, value] of change.style) {
      if (!hasDeclaration(style, property))
        style += `${style === "" ? "" : ";"}${property}:${value}`;
    }
    setAttr(el, "style", style);
  }
  for (const [name, value] of Object.entries(change.attributes ?? {})) {
    if (attr(el, name) === undefined) setAttr(el, name, value);
  }
}

/** The host of an address, without a leading `www.`, or undefined for anything that is not http(s). */
function hostOf(url: string): string | undefined {
  if (!/^(?:https?:)?\/\//i.test(url.trim())) return undefined;
  try {
    return new URL(url.trim(), "https://placeholder.invalid").hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** The hosts the site answers on: an address elsewhere is an external link. */
function siteHosts(ctx: ConvertCtx): Set<string> {
  const out = new Set<string>();
  for (const url of [ctx.model.site.url, ctx.model.site.home]) {
    const host = hostOf(url);
    if (host !== undefined) out.add(host);
  }
  return out;
}

const rankMathNewWindow = new WeakMap<object, boolean>();

/**
 * Whether Rank Math is set to open external links in a new window (`new_window_external_links` in
 * `rank-math-options-general`, read only while the plugin is active, as WordPress does). It does so
 * when it filters `the_content`, so only a post's own content is affected, never a template.
 */
function opensExternalLinksInNewWindow(ctx: ConvertCtx): boolean {
  if (ctx.subject.kind !== "post") return false;
  const known = rankMathNewWindow.get(ctx.model.options);
  if (known !== undefined) return known;
  const raw = ctx.model.options.get("rank-math-options-general");
  const general = raw === undefined ? undefined : maybeUnserialize(raw);
  const on =
    ctx.model.site.activePlugins.some((p) => p.startsWith("seo-by-rank-math")) &&
    typeof general === "object" &&
    general !== null &&
    (general as Record<string, unknown>).new_window_external_links === "on";
  rankMathNewWindow.set(ctx.model.options, on);
  return on;
}

/**
 * What WordPress does to the markup of a post's content when it prints it, as options for the
 * conversion: `wptexturize` always, and Rank Math's external-link filter when it is on. A template's
 * blocks get the first only (their text is texturized by the block that prints it, not by a filter).
 */
export function contentOptions(
  ctx: ConvertCtx,
): Pick<StaticOptions, "texturize" | "externalLinks"> {
  return { texturize: true, externalLinks: opensExternalLinksInNewWindow(ctx) };
}

/**
 * The size an `img` is SHOWN at, which its file name says when it is a derivative: WordPress prints
 * `width` and `height` of the size slug at render time (`-300x300` for `size-medium`), never of the
 * original the media plan ships. A file the plan ships under its own name is the original, whatever
 * digits that name ends in.
 */
function shownSize(url: string, shipped: string): { width: number; height: number } | undefined {
  const file = (url.split(/[?#]/)[0] ?? "").split("/").pop() ?? "";
  const m = /-(\d+)x(\d+)\.[a-z0-9]+$/i.exec(file);
  if (!m || shipped.split("/").pop() === file) return undefined;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * Move every address in `html` to where the Jx site has it (see the module header) and return the
 * markup. Comments are kept; `htmlToNodes` drops them as it always does.
 */
export function rewriteMarkup(
  html: string,
  ctx: ConvertCtx,
  root?: RootChanges,
  extra: Pick<StaticOptions, "texturize" | "externalLinks"> = {},
): string {
  if (!/[<]/.test(html)) return html;
  const fix = rewriter(ctx);
  const hosts = extra.externalLinks === true ? siteHosts(ctx) : undefined;
  // On the markup as WordPress has it, where a no-break space is still `&nbsp;` and an ASCII space is
  // the only separator ` - ` and `--` look for.
  const fragment = parseFragment(extra.texturize === true ? texturizeHtml(html) : html, {
    scriptingEnabled: false,
  });
  const first = fragment.childNodes.find((n): n is P5Element => "tagName" in n);
  if (root && first)
    changeRoot(root.within ? (firstWithClass(first, root.within) ?? first) : first, root);
  const stack: P5Node[] = [...fragment.childNodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!("tagName" in node)) continue;
    stack.push(...childNodes(node));
    const el = node as P5Element;
    if (el.namespaceURI !== NS_HTML) continue;
    const tag = el.tagName;

    if (tag === "pre" || tag === "textarea" || tag === "listing") {
      // The parser swallows one line feed right after these start tags and the serializer does not
      // write it back, so a blank line at the top of the content would be lost on the next read.
      const lead = childNodes(el)[0];
      if (lead?.nodeName === "#text" && (lead as P5Text).value.startsWith("\n")) {
        (lead as P5Text).value = `\n${(lead as P5Text).value}`;
      }
    }

    for (const name of ADDRESS_ATTRS.get(tag) ?? []) {
      const value = attr(el, name);
      if (value === undefined) continue;
      if (tag === "img" && name === "src") {
        const media = fix.image(value);
        if (media) {
          setAttr(el, "src", media.src);
          // The markup's own width and height (a block resized in the editor) say how big it is
          // shown and win. Without them the image is shown at the size of the file the markup named
          // (a `-300x300` derivative), not at the original's: the plan's size is the shipped file's.
          const size =
            shownSize(value, media.src) ??
            (media.width !== undefined && media.height !== undefined
              ? { width: media.width, height: media.height }
              : undefined);
          if (size && attr(el, "width") === undefined && attr(el, "height") === undefined) {
            setAttr(el, "width", String(size.width));
            setAttr(el, "height", String(size.height));
          }
          continue;
        }
      }
      setAttr(el, name, fix.address(value));
    }

    if (tag === "img") {
      // The build writes its own srcset and sizes from the shipped original.
      el.attrs = el.attrs.filter(
        (a) => a.prefix !== undefined || (a.name !== "srcset" && a.name !== "sizes"),
      );
    } else if (tag === "source") {
      const srcset = attr(el, "srcset");
      if (srcset !== undefined) setAttr(el, "srcset", mapSrcset(srcset, fix.address));
    }

    if (tag === "a" && hosts && attr(el, "target") === undefined) {
      const host = hostOf(attr(el, "href") ?? "");
      if (host !== undefined && !hosts.has(host)) setAttr(el, "target", "_blank");
    }

    if (tag === "a" && attr(el, "target")?.toLowerCase() === "_blank") {
      const rel = (attr(el, "rel") ?? "").split(/\s+/).filter(Boolean);
      if (!rel.some((token) => token.toLowerCase() === "noopener")) {
        setAttr(el, "rel", [...rel, "noopener"].join(" "));
      }
    }

    const style = attr(el, "style");
    if (style !== undefined) {
      const next = mapCssUrls(style, (url) => {
        const media = fix.image(url);
        return media ? media.src : fix.address(url);
      });
      if (next !== style) setAttr(el, "style", next);
    }

    if (tag === "style") {
      for (const child of el.childNodes) {
        if (child.nodeName !== "#text") continue;
        const text = child as P5Text;
        text.value = mapCssUrls(text.value, (url) => {
          const media = fix.image(url);
          return media ? media.src : fix.address(url);
        });
      }
    }
  }
  return serialize(fragment);
}

// ── Inner blocks ─────────────────────────────────────────────────────────────────────────────────

/** The element standing in for an inner block while the markup is parsed. Block-level, so that no whitespace logic treats it as inline text. */
const MARKER = "wp2jx-inner";
const marker = (index: number): string =>
  `<${MARKER} data-i="${index}" style="display:block"></${MARKER}>`;
const MARKER_MARKUP = new RegExp(`<${MARKER}\\b[^>]*></${MARKER}>`, "g");

/**
 * The block's saved markup with a marker at every position an inner block goes. `innerContent` is the
 * parser's own: one `null` per inner block, in order. A block built by hand without it is its
 * `innerHTML` with the inner blocks at the end.
 */
function joinInner(block: WpBlock): string {
  const parts = block.innerContent ?? [block.innerHTML];
  let at = 0;
  let html = "";
  for (const part of parts) html += part === null ? marker(at++) : part;
  for (; at < block.innerBlocks.length; at++) html += marker(at);
  return html;
}

function stitch(nodes: JxNode[], inner: JxNode[][], placed: Set<number>): JxNode[] {
  const out: JxNode[] = [];
  for (const node of nodes) {
    if (typeof node === "string") {
      out.push(node);
      continue;
    }
    if (node.tagName === MARKER) {
      const index = Number(node.attributes?.["data-i"]);
      const content = inner[index];
      if (content !== undefined) {
        placed.add(index);
        out.push(...content);
      }
      continue;
    }
    if (Array.isArray(node.children)) node.children = stitch(node.children, inner, placed);
    out.push(node);
  }
  return out;
}

/**
 * Remove the marker markup from every `innerHTML` and `textContent` string of a tree; returns whether
 * any was there. A marker inside an element whose content is raw text (`script`, `style`, `textarea`)
 * never becomes an element: the parser keeps its markup as that element's text.
 */
function stripMarkers(nodes: JxNode[]): boolean {
  let found = false;
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (typeof node.innerHTML === "string" && node.innerHTML.includes(`<${MARKER}`)) {
      found = true;
      node.innerHTML = node.innerHTML.replaceAll(MARKER_MARKUP, "");
    }
    if (typeof node.textContent === "string" && node.textContent.includes(`<${MARKER}`)) {
      found = true;
      node.textContent = node.textContent.replaceAll(MARKER_MARKUP, "");
    }
    if (Array.isArray(node.children)) found = stripMarkers(node.children) || found;
  }
  return found;
}

// ── Conversion ───────────────────────────────────────────────────────────────────────────────────

/**
 * Whether top-level inline content in the nodes would show a gap the build does not mean: two
 * siblings with nothing but a separator between them, in a place the build does not know the parent of.
 * Asked of `htmlToContent`, which makes that very judgement for an element's own children.
 */
function needsContainer(html: string, nodes: JxNode[], options: HtmlOptions): boolean {
  if (nodes.length < 2 || options.target === "markdown") return false;
  // Asked quietly: the conversion itself reports, and a second one would report everything twice.
  const { report: _report, ...quiet } = options;
  return htmlToContent(html, quiet).innerHTML !== undefined;
}

// ── Markdown entries ─────────────────────────────────────────────────────────────────────────────

/** Elements whose content is phrasing: what a run of loose text and inline markup is made of. */
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

/** Wrappers that say nothing but how the text inside them looks. */
const EMPHASIS = new Set(["b", "em", "i", "mark", "s", "small", "strong", "u"]);

/**
 * Elements the Markdown serializer writes as a container directive whose children are flow content:
 * loose text and inline markup in one of them comes back as separate paragraphs with the inline
 * element between them (`20<sup>th</sup> century` in a list item reads back as `20`, `th`, `century`),
 * and `p` is what the serializer's own reading of a list item makes of its text anyway.
 */
const FLOW_HOSTS = new Set(["li", "dd", "dt", "figcaption", "blockquote", "summary", "caption"]);

/** The class the block library prints on every list and styles only together with `has-background`. */
const LIST_CLASS = "wp-block-list";

/** The class on a table whose columns the author fixed: `table-layout: fixed`, which the Markdown table cannot carry. */
const FIXED_LAYOUT = "has-fixed-layout";

interface Found {
  /** What the entry cannot carry, by element: reported once per conversion. */
  dropped: Map<string, { classes: Set<string>; id: boolean; style: boolean; count: number }>;
  /** Table cells that span more than one column or row. */
  spans: number;
  /** Decorative icons dropped. */
  icons: number;
  /** Line breaks at the end of a block, dropped (the paragraph or heading that held only one goes too). */
  breaks: number;
  /** Plain links whose `target`, `rel` or `aria-label` the Markdown link has no place for. */
  links: { count: number; names: Set<string> };
  /** Ordered lists whose `type` or `reversed` the Markdown list has no place for. */
  listTypes: number;
  /** Lines of verse written as plain text, and how many of their spans had attributes. */
  flattened: { count: number; styled: number };
  /** Colons before a digit (`12:42`) that the Markdown reader would take for a text directive. */
  colons: number;
}

const newFound = (): Found => ({
  dropped: new Map(),
  spans: 0,
  icons: 0,
  breaks: 0,
  links: { count: 0, names: new Set() },
  listTypes: 0,
  flattened: { count: 0, styled: 0 },
  colons: 0,
});

/** Whether an element carries nothing but its tag (no class, id, style or attribute). */
const isBare = (el: JxElement): boolean =>
  el.className === undefined &&
  el.id === undefined &&
  el.style === undefined &&
  el.attributes === undefined &&
  el.textContent === undefined &&
  el.innerHTML === undefined;

const hasSpan = (cell: JxElement): boolean =>
  ["colspan", "rowspan"].some((name) => Number(cell.attributes?.[name]) > 1);

/**
 * The link icon the old Drupal site's `extlink` module put after every external link
 * (`<svg class="ext" aria-label="(link is external)">` with a Save For Web metadata block in it). A
 * Markdown entry writes it as a text directive that the URL before it swallows.
 */
const isExternalLinkIcon = (svg: JxElement): boolean =>
  (svg.className ?? "").split(/\s+/).some((c) => c === "ext" || c === "mailto") &&
  /^\((?:link|email|mail)/i.test(String(svg.attributes?.["aria-label"] ?? ""));

/**
 * An emphasis element, as the elements it holds in between its line breaks: `<strong>a<br>b</strong>`
 * is `<strong>a</strong><br><strong>b</strong>`, and `<strong><br></strong>` is `<br>`. The serializer
 * writes a break inside emphasis as an entity-escaped newline, which prints as `&#xA;`; an empty
 * emphasis shows nothing and is written as four asterisks, which print.
 */
function splitAtBreaks(el: JxElement): JxNode[] {
  const children = Array.isArray(el.children) ? el.children : [];
  const out: JxNode[] = [];
  let run: JxNode[] = [];
  const flush = (): void => {
    if (run.length > 0) out.push({ ...el, children: run });
    run = [];
  };
  for (const child of children) {
    if (typeof child !== "string" && child.tagName === "br") {
      flush();
      out.push(child);
    } else run.push(child);
  }
  flush();
  return out;
}

function dropAttributes(el: JxElement, found: Found, keepClasses: readonly string[] = []): void {
  const classes = (el.className ?? "")
    .split(/\s+/)
    .filter((c) => c !== "" && !keepClasses.includes(c));
  const lost = classes.length > 0 || el.id !== undefined || el.style !== undefined;
  if (lost) {
    const key = el.tagName === "ul" || el.tagName === "ol" ? "list" : "table";
    const entry = found.dropped.get(key) ?? {
      classes: new Set<string>(),
      id: false,
      style: false,
      count: 0,
    };
    for (const c of classes) entry.classes.add(c);
    entry.id ||= el.id !== undefined;
    entry.style ||= el.style !== undefined;
    entry.count++;
    found.dropped.set(key, entry);
  }
  delete el.className;
  delete el.id;
  delete el.style;
}

/**
 * A list the serializer writes as a Markdown list: every item is plain. One item with a class makes
 * each item, and so the list, a directive of its own, which carries its attributes faithfully.
 */
function isPlainList(list: JxElement): boolean {
  return (
    Array.isArray(list.children) &&
    list.children.every(
      (item) =>
        typeof item !== "string" &&
        item.tagName === "li" &&
        item.className === undefined &&
        item.id === undefined &&
        item.style === undefined,
    )
  );
}

/**
 * Runs of loose text and inline markup among `children` that hold both text and an element, each
 * wrapped in a `p`. An element on its own (a `cite` after a quote's paragraphs, a link that is the whole
 * item) is written and read back as it is, so it is left alone.
 */
function wrapRuns(children: readonly JxNode[]): JxNode[] {
  const out: JxNode[] = [];
  let run: JxNode[] = [];
  const flush = (): void => {
    if (run.some((n) => typeof n === "string") && run.some((n) => typeof n !== "string")) {
      out.push({ tagName: "p", children: run });
    } else out.push(...run);
    run = [];
  };
  for (const child of children) {
    if (
      typeof child === "string" ||
      (typeof child.tagName === "string" && PHRASING.has(child.tagName))
    ) {
      run.push(child);
    } else {
      flush();
      out.push(child);
    }
  }
  flush();
  return out;
}

/** Elements that end in a line break the reader never shows: a trailing `<br>` is how the Classic editor ends a line. */
const LINE_HOSTS = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "td",
  "th",
  "dt",
  "dd",
  "figcaption",
  "summary",
]);

/** A block that has nothing to say once its breaks are gone is removed rather than left empty. */
const DROP_WHEN_EMPTY = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

const BLANK = /^[\s\u00a0]*$/;

const isBreak = (node: JxNode): boolean => typeof node !== "string" && node.tagName === "br";

/**
 * Take the line breaks off the end of `children` (with the blank text before them), which a Markdown
 * hard break cannot be: written as a backslash at the end of a block it reads back as that backslash.
 * Returns how many breaks went.
 */
function trimTrailingBreaks(children: JxNode[]): number {
  let at = children.length;
  let breaks = 0;
  for (; at > 0; at--) {
    const last = children[at - 1]!;
    if (isBreak(last)) breaks++;
    else if (!(typeof last === "string" && BLANK.test(last))) break;
  }
  if (breaks === 0) return 0;
  children.length = at;
  const last = children[at - 1];
  if (typeof last === "string") {
    const trimmed = last.replace(/[\s\u00a0]+$/, "");
    if (trimmed === "") children.length = at - 1;
    else children[at - 1] = trimmed;
  }
  return breaks;
}

/**
 * The lines a verse is made of, when its content is a `span` per line, line breaks and inline markup: a
 * `core/verse` saved with a `span` per line and a newline between them. The serializer writes each
 * `span` as a container directive and drops the whitespace between them, so the lines run together; as
 * the lines of one paragraph (the text with its newlines, an inline element such as a note marker
 * kept) they come back as they were. `undefined` when anything else is in there.
 */
function verseLines(children: readonly JxNode[], found: Found): JxNode[] | undefined {
  const out: JxNode[] = [];
  const push = (text: string): void => {
    const last = out[out.length - 1];
    if (typeof last === "string") out[out.length - 1] = last + text;
    else out.push(text);
  };
  for (const child of children) {
    if (typeof child === "string") push(child);
    else if (child.tagName === "br") push("\n");
    else if (child.tagName === "span" && child.innerHTML === undefined) {
      if (
        child.className !== undefined ||
        child.id !== undefined ||
        child.style !== undefined ||
        child.attributes !== undefined
      ) {
        found.flattened.styled++;
      }
      const inner =
        typeof child.textContent === "string"
          ? [child.textContent]
          : Array.isArray(child.children)
            ? verseLines(child.children, found)
            : [];
      if (inner === undefined) return undefined;
      for (const node of inner) {
        if (typeof node === "string") push(node);
        else out.push(node);
      }
    } else if (
      typeof child.tagName === "string" &&
      PHRASING.has(child.tagName) &&
      child.tagName !== "code"
    ) {
      out.push(child);
    } else return undefined;
  }
  return out;
}

/** What the serializer ends with `*`, `~` or a backtick, after which it does not escape a colon either. */
const MARK_ENDING = new Set(["em", "i", "strong", "b", "del", "s", "code"]);

/** The colons of `text` the reader would take for a directive, as positions. `afterMark`: the text follows emphasis. */
function directiveColons(text: string, afterMark: boolean): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(":"); i !== -1; i = text.indexOf(":", i + 1)) {
    const next = text[i + 1] ?? "";
    if (/\d/.test(next) || (afterMark && i === 0 && /[A-Za-z]/.test(next))) at.push(i);
  }
  return at;
}

/**
 * `Luke 12:42` written as Markdown reads back as `Luke 12` and an element named `<42>`: the reader takes
 * `:42` for a text directive, and the serializer escapes a colon only before a letter (and not even
 * then right after emphasis, `*given*:For`). The colon is written as a directive of its own
 * (`:span[:]`), which reads back as the colon in a `span`.
 */
function splitColons(text: string, at: readonly number[], found: Found): JxNode[] {
  const out: JxNode[] = [];
  let from = 0;
  for (const i of at) {
    if (i > from) out.push(text.slice(from, i));
    out.push({ tagName: "span", textContent: ":" });
    found.colons++;
    from = i + 1;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/**
 * What a Markdown entry cannot hold, put right in the tree before the serializer sees it. Measured
 * by writing and reading back every converted block of both sites: each of these lost content or
 * changed the structure, and none of them is something the serializer reports.
 *
 * - A list or a table with a class, id or style is written as a container directive around a
 *   Markdown list or table, which reads back as a list inside a list, and a classed table reads back
 *   EMPTY. Their own attributes are dropped (the figure around a table keeps its classes), and
 *   reported unless they were only the `wp-block-list` class, which nothing styles by itself.
 * - Text next to an inline element inside a list item, definition, caption or quote reads back as
 *   separate paragraphs, so the run is wrapped in the paragraph it is read back as.
 * - An empty emphasis element (`<strong></strong>` at the end of a heading, which the editor leaves
 *   behind) shows nothing and is written as four asterisks, which print: it is dropped.
 * - An emphasis element that holds only line breaks (`<strong><br></strong>`, a Classic editor
 *   habit) is written as its entity-escaped newline and prints `&#xA;`: the breaks are kept, the
 *   wrapper is not.
 * - A line break at the end of a block (`<p>text<br></p>`, `<p><br></p>`) is written as a backslash and
 *   reads back as one, visible. The live page showed one blank line at most: the break is dropped, and a
 *   paragraph or heading that held nothing else goes with it.
 * - Verse written as a `span` per line, with newlines between, would run together (the serializer
 *   writes each span as a block and drops the whitespace): the lines are written as the text they are.
 * - A colon before a digit (`Luke 12:42`) is read as a text directive: see {@link splitColons}.
 * - A link's `target`, `rel` and `aria-label`, and an ordered list's `type`, have no Markdown form and
 *   are reported (the markup of the Markdown link and list is the whole of what it writes).
 */
function markdownSafe(nodes: JxNode[], found: Found, literal = false): JxNode[] {
  const out: JxNode[] = [];
  for (const [index, node] of nodes.entries()) {
    if (typeof node === "string") {
      const before = nodes[index - 1];
      const at = literal
        ? []
        : directiveColons(
            node,
            before !== undefined &&
              typeof before !== "string" &&
              typeof before.tagName === "string" &&
              MARK_ENDING.has(before.tagName),
          );
      if (at.length > 0) out.push(...splitColons(node, at, found));
      else out.push(node);
      continue;
    }
    const tag = node.tagName;
    if (
      tag === "pre" &&
      Array.isArray(node.children) &&
      node.children.some((c) => typeof c !== "string")
    ) {
      const lines = verseLines(node.children, found);
      if (lines !== undefined) {
        found.flattened.count++;
        if (lines.every((l) => typeof l === "string")) {
          delete node.children;
          node.textContent = lines.join("");
        } else node.children = [{ tagName: "p", children: lines }];
      }
    }
    if (
      tag === "figure" &&
      Array.isArray(node.children) &&
      node.children.some(
        (c) =>
          typeof c !== "string" &&
          c.tagName === "table" &&
          (c.className ?? "").split(/\s+/).includes(FIXED_LAYOUT),
      )
    ) {
      // The table's own class is dropped below; the figure, which the serializer keeps, carries it on.
      node.className = joinClass(node.className, FIXED_LAYOUT);
    }
    if (!literal && tag !== "code" && typeof node.textContent === "string") {
      const at = directiveColons(node.textContent, false);
      if (at.length > 0) {
        node.children = splitColons(node.textContent, at, found);
        delete node.textContent;
      }
    }
    if (Array.isArray(node.children)) {
      node.children = markdownSafe(node.children, found, literal || tag === "code");
    }
    if (tag === "svg" && isExternalLinkIcon(node)) {
      found.icons++;
      continue;
    }
    if ((tag === "td" || tag === "th") && hasSpan(node)) {
      // Said once: the attributes go, so a parent that walks the stitched tree again finds none.
      found.spans++;
      delete node.attributes?.colspan;
      delete node.attributes?.rowspan;
    }
    if (typeof tag === "string" && EMPHASIS.has(tag) && isBare(node)) {
      out.push(...splitAtBreaks(node));
      continue;
    }
    if (typeof tag === "string" && LINE_HOSTS.has(tag) && Array.isArray(node.children)) {
      const breaks = trimTrailingBreaks(node.children);
      if (breaks > 0) {
        found.breaks += breaks;
        if (node.children.length === 0) {
          delete node.children;
          if (
            DROP_WHEN_EMPTY.has(tag) &&
            node.textContent === undefined &&
            node.innerHTML === undefined
          ) {
            continue;
          }
        }
      }
    }
    if (
      tag === "a" &&
      node.className === undefined &&
      node.id === undefined &&
      node.style === undefined
    ) {
      const lost = Object.keys(node.attributes ?? {}).filter(
        (name) => name !== "href" && name !== "title",
      );
      if (lost.length > 0) {
        found.links.count++;
        for (const name of lost) found.links.names.add(name);
      }
    }
    if ((tag === "ul" || tag === "ol") && isPlainList(node)) {
      if (
        tag === "ol" &&
        (node.attributes?.type !== undefined || node.attributes?.reversed !== undefined)
      ) {
        found.listTypes++;
      }
      dropAttributes(node, found, [LIST_CLASS]);
    } else if (tag === "table") dropAttributes(node, found);
    if (typeof tag === "string" && FLOW_HOSTS.has(tag) && Array.isArray(node.children)) {
      node.children = wrapRuns(node.children);
    }
    out.push(node);
  }
  return out;
}

/** One entry per subject, counted up as the entry's blocks are converted. */
const gapEntries = new WeakMap<object, Map<string, { entry: ReportEntry; blocks: number }>>();

function noteGap(ctx: ConvertCtx): void {
  const where = whereOf(ctx);
  const perReport = gapEntries.get(ctx.report) ?? new Map();
  gapEntries.set(ctx.report, perReport);
  const known = perReport.get(where);
  if (known) {
    known.blocks++;
    known.entry.data = { ...known.entry.data, blocks: known.blocks };
    return;
  }
  const before = ctx.report.entries().length;
  note(
    ctx,
    "warn",
    "block.inline-gap",
    "Inline markup (a link, emphasis, a note marker) sits flush against text here, and the Jx build writes a space at each such boundary of a Markdown entry (`20 th`, `link .`); a JSON page would keep the text exact.",
    { blocks: 1 },
  );
  const entry = ctx.report.entries()[before];
  if (entry) perReport.set(where, { entry, blocks: 1 });
}

/** {@link markdownSafe} with what it dropped reported; safe to run again on a tree it has already made safe. */
function markdownEntry(nodes: JxNode[], ctx: ConvertCtx): JxNode[] {
  const found = newFound();
  const safe = markdownSafe(nodes, found);
  reportDropped(ctx, found);
  if (found.colons > 0) noteGap(ctx);
  return safe;
}

function reportDropped(ctx: ConvertCtx, found: Found): void {
  if (found.spans > 0) {
    note(
      ctx,
      "warn",
      "block.table-span-dropped",
      `${found.spans} table ${found.spans > 1 ? "cells span" : "cell spans"} several columns or rows; a Markdown table has none, so the cell takes one column and the row is padded with empty cells.`,
      { cells: found.spans },
    );
  }
  if (found.icons > 0) {
    note(
      ctx,
      "info",
      "block.icon-dropped",
      `${found.icons} external-link ${found.icons > 1 ? "icons" : "icon"} from the old Drupal site ${found.icons > 1 ? "were" : "was"} dropped: a Markdown entry writes an inline svg as a directive that the address before it swallows.`,
      { icons: found.icons },
    );
  }
  if (found.breaks > 0) {
    note(
      ctx,
      "info",
      "block.line-break-dropped",
      `${found.breaks} line ${found.breaks > 1 ? "breaks" : "break"} at the end of a block ${found.breaks > 1 ? "were" : "was"} dropped: a Markdown hard break there reads back as a visible backslash, and the live page showed at most one blank line.`,
      { breaks: found.breaks },
    );
  }
  if (found.links.count > 0) {
    const names = [...found.links.names];
    note(
      ctx,
      "info",
      "block.link-attributes-dropped",
      `${found.links.count} ${found.links.count > 1 ? "links lose" : "link loses"} ${names.join(", ")}: a Markdown link carries an address and a title and nothing else (a link that opened in a new window opens in the same one).`,
      { links: found.links.count, attributes: names },
    );
  }
  if (found.listTypes > 0) {
    note(
      ctx,
      "info",
      "block.list-type-dropped",
      `${found.listTypes} ordered ${found.listTypes > 1 ? "lists lose" : "list loses"} the numbering type or direction (\`type\`, \`reversed\`): a Markdown list is numbered 1, 2, 3.`,
      { lists: found.listTypes },
    );
  }
  if (found.flattened.count > 0) {
    note(
      ctx,
      "info",
      "block.pre-flattened",
      `${found.flattened.count} preformatted ${found.flattened.count > 1 ? "blocks (verse) were" : "block (verse) was"} written as plain lines: a Markdown entry writes a \`span\` per line as a block and the line breaks between them are lost${found.flattened.styled > 0 ? `; ${found.flattened.styled} of those spans carried a class, id or style, which is not carried` : ""}.`,
      { blocks: found.flattened.count, styledSpans: found.flattened.styled },
    );
  }
  if (found.colons > 0) {
    note(
      ctx,
      "warn",
      "block.text-directive",
      `${found.colons} ${found.colons > 1 ? "colons" : "colon"} before a digit (\`12:42\`) would be read back as a text directive and the digits lost; each is written as a \`span\`, and the Jx build writes a space around it.`,
      { colons: found.colons },
    );
  }
  for (const [element, d] of found.dropped) {
    const classes = [...d.classes];
    if (classes.length === 0 && !d.id && !d.style) continue;
    const fixed = element === "table" && classes.includes(FIXED_LAYOUT);
    note(
      ctx,
      fixed ? "warn" : "info",
      "block.markdown-attributes-dropped",
      `A Markdown ${element} cannot carry attributes, and writing them wraps it in a second ${element === "list" ? "list" : "(empty) table"}; ${[
        ...(classes.length > 0 ? [`the class ${classes.join(" ")}`] : []),
        ...(d.id ? ["its id"] : []),
        ...(d.style ? ["its inline style"] : []),
      ].join(
        ", ",
      )} ${d.count > 1 ? "were" : "was"} not carried${fixed ? `; without ${FIXED_LAYOUT} the columns size to their content instead of sharing the width evenly (the figure keeps the class, and an entry's project style carries the rule for it)` : ""}.`,
      { element, classes, id: d.id, style: d.style, count: d.count },
    );
  }
}

/**
 * Markup to nodes with its addresses rewritten. A fragment whose top-level siblings are inline (loose
 * text and phrasing elements, as a raw HTML block can hold) is wrapped in an element that lays out as
 * nothing and carries it as one piece, because the build would otherwise put its separator between
 * them; a fragment of blocks needs no such care. For a Markdown entry the nodes are first put right
 * for the serializer ({@link markdownSafe}), and the one thing no node can fix, the space the build
 * writes between inline siblings, is reported.
 */
export function htmlNodes(html: string, ctx: ConvertCtx, opts: StaticOptions = {}): JxNode[] {
  const options = htmlOptions(ctx, opts);
  const markup = rewriteMarkup(html, ctx, opts.root, opts);
  const nodes = htmlToNodes(markup, options);
  if (options.target === "markdown") {
    const { report: _report, ...quiet } = options;
    const raw = htmlToNodes(markup, { ...quiet, target: "page", inlineGaps: "raw" });
    const structured = htmlToNodes(markup, { ...quiet, target: "page", inlineGaps: "children" });
    if (JSON.stringify(raw) !== JSON.stringify(structured)) noteGap(ctx);
    return markdownEntry(nodes, ctx);
  }
  if (options.inlineGaps === "children") {
    // Chosen for the inner blocks' sake (see staticBlock): the gap it accepts is said.
    const { report: _report, ...quiet } = options;
    const raw = htmlToNodes(markup, { ...quiet, inlineGaps: "raw" });
    if (JSON.stringify(raw) !== JSON.stringify(nodes)) noteGap(ctx);
  }
  if (!needsContainer(markup, nodes, options)) return nodes;
  const content = htmlToContent(markup, options);
  return [{ tagName: "div", style: { display: "contents" }, ...content }];
}

/** The same for the inline content of an element the caller builds: spread the result into it. */
export function htmlContent(html: string, ctx: ConvertCtx, opts: StaticOptions = {}): HtmlContent {
  return htmlToContent(rewriteMarkup(html, ctx, opts.root, opts), htmlOptions(ctx, opts));
}

/**
 * Whether converting `markup` the usual way would hold an inner block's marker inside an `innerHTML`
 * string, where it cannot be replaced by the nodes of the block: an element whose children the build
 * would separate with a space (a cover's empty span and image, next to its inner container) keeps its
 * content as markup. The inner block would then land after its parent instead of inside it.
 */
function swallowsMarkers(markup: string, ctx: ConvertCtx, opts: StaticOptions): boolean {
  const { report: _report, ...quiet } = htmlOptions(ctx, opts);
  if (quiet.target === "markdown") return false;
  const nodes = htmlToNodes(rewriteMarkup(markup, ctx, opts.root, opts), quiet);
  return JSON.stringify(nodes).includes(`<${MARKER}`);
}

/**
 * Convert a static block's saved markup, with its inner blocks stitched in at the positions of the
 * `null`s of `block.innerContent`. Reusable by every converter that works from saved markup; the
 * returned elements are exact (`htmlToNodes`), so a converter can adjust the first one.
 */
export function staticBlock(block: WpBlock, ctx: ConvertCtx, given: StaticOptions = {}): JxNode[] {
  let opts: StaticOptions = { ...contentOptions(ctx), ...given };
  const fixed = opts.html !== undefined;
  const html = fixed ? opts.html! : joinInner(block);
  const inner = fixed ? [] : block.innerBlocks.map((child) => ctx.convert([child]));
  if (inner.length > 0 && opts.inlineGaps === undefined && swallowsMarkers(html, ctx, opts)) {
    opts = { ...opts, inlineGaps: "children" };
  }
  const nodes = htmlNodes(html, ctx, opts);
  if (fixed || inner.length === 0) return nodes;

  const placed = new Set<number>();
  const out = stitch(nodes, inner, placed);
  const stripped = stripMarkers(out);
  const lost = inner.map((_, i) => i).filter((i) => !placed.has(i));
  if (lost.length > 0 || stripped) {
    for (const i of lost) out.push(...inner[i]!);
    note(
      ctx,
      "warn",
      "block.inner-misplaced",
      `The inner blocks of ${block.name ?? "freeform"} could not be put where the markup had them; ${lost.length} of ${inner.length} were appended after it.`,
      { block: block.name, lost: lost.length, total: inner.length },
    );
  }
  // What was stitched in changes what the parent's elements hold (the items of a list).
  return (opts.target ?? targetOf(ctx)) === "markdown" ? markdownEntry(out, ctx) : out;
}

// ── Editing the result ───────────────────────────────────────────────────────────────────────────

/** The elements among `nodes`, skipping loose text. */
export const elementsOf = (nodes: readonly JxNode[]): JxElement[] =>
  nodes.filter((n): n is JxElement => typeof n !== "string");
