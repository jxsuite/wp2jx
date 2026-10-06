/**
 * Converters for the WordPress core blocks.
 *
 * Almost every core block is STATIC: its `save()` output is the HTML the site printed, so the block IS
 * its saved markup and `staticBlock` (static.ts) converts it, inner blocks and addresses included. What
 * a converter adds on top is what WordPress adds when it RENDERS a block, which the stored markup does
 * not hold and the live pages do (measured against the rendered fixtures), and only where a rule of
 * the block library needs it: `wp-block-list` on a list with a background, and the `is-layout-*`
 * classes of a block that has a layout. (`wp-block-paragraph`, which every rendered paragraph has, is
 * styled by nothing, and on a paragraph in a Markdown entry a class turns plain text into a directive
 * container, so it is not added.) Every class the markup carries is kept as it is: a sibling module turns the
 * `wp-block-*`, `has-*` and `align*` classes into project-level rules, so they must survive in
 * `className`.
 *
 * A few blocks are DYNAMIC: they save nothing (or little) and WordPress builds their markup per
 * request from attributes and the database (post title, terms, footnotes, search, template parts). Those
 * are built here from their attributes, with the same class list WordPress builds, and take values
 * from the subject (static mode) or bind to the entry (entry mode, the data contract in
 * docs/design.md). What cannot be carried is reported with a stable code and the subject's location.
 *
 * Report codes: `block.unsupported` (a block nothing here knows; its saved markup is kept),
 * `block.shortcode`, `block.html-script`, `block.embed-unresolved`, `block.embed-reconstructed`,
 * `block.image-lightbox`, `block.search`, `block.navigation`, `block.dynamic-dropped`,
 * `block.footnotes-missing`, `block.style-dropped`, `block.more-dropped`, `block.nextpage-dropped`,
 * `block.reusable-missing`, `block.reusable-unpublished`, `block.date-format`, `block.social-icon`,
 * `block.dynamic-placeholder`, `block.template-literal`, `block.archive-prefix`,
 * and static.ts's `block.inner-misplaced`, `block.inline-gap`, `block.markdown-attributes-dropped`,
 * `block.table-span-dropped` and `block.icon-dropped`.
 */
import { createHash } from "node:crypto";
import { escapeTemplate } from "../html.ts";
import { joinClass } from "../jx-util.ts";
import type {
  BlockConverter,
  ConvertCtx,
  JxElement,
  JxNode,
  JxStyle,
  WpBlock,
  WpPost,
} from "../types.ts";
import { parseBlocks } from "../wp/blocks.ts";
import { decodeEntities, termsOf } from "../wp/model.ts";
import { php } from "../wp/seo.ts";
import {
  contentOptions,
  elementsOf,
  htmlContent,
  htmlNodes,
  note,
  staticBlock,
  targetOf,
} from "./static.ts";
import type { RootChanges, StaticOptions } from "./static.ts";
import { imageCompareBlock } from "./image-compare.ts";
import type { HtmlContent } from "../html.ts";

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────

type Attrs = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A non-empty string attribute, or undefined. */
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const baseName = (block: WpBlock): string => (block.name ?? "freeform").replace(/^core\//, "");

/** The first 10 hex digits of a style's hash: the scope class `html.ts` gives an element with an inline style. */
const scopeOf = (style: JxStyle): string =>
  `jx-${createHash("sha1").update(JSON.stringify(style)).digest("hex").slice(0, 10)}`;

/** An identifier a CSS selector can start with: html.ts's own test, for the same reason. */
const CSS_IDENT = /^(?:-?[_a-zA-Z\u0080-\uFFFF]|--)[_a-zA-Z0-9\u0080-\uFFFF-]*$/;

/**
 * An element built by hand. Its own style is written to the selector of its first class, so one that
 * has a style gets a scope class first, exactly as `htmlToNodes` makes one, and leaks nowhere. An element
 * whose id the build would write the style to (`#id`) keeps it only when the id is a selector: an
 * anchor like `2024-report` is not, and the style would be silently lost, so the id stays an attribute
 * and the scope class carries the style, as `html.ts` does for the same input.
 */
function element(
  tagName: string,
  classes: string,
  rest: Omit<JxElement, "tagName" | "className"> = {},
): JxElement {
  const style = rest.style as JxStyle | undefined;
  const hasStyle = style !== undefined && Object.keys(style).length > 0;
  const { style: _style, id: _id, attributes: _attributes, ...others } = rest;
  const id = rest.id as string | undefined;
  const attributes = rest.attributes as JxElement["attributes"];
  // The build writes the style to `#id` when there is one, so an id that is not a selector cannot hold it.
  const idHoldsStyle = id !== undefined && (!hasStyle || CSS_IDENT.test(id));
  const className = hasStyle && !idHoldsStyle ? joinClass(scopeOf(style), classes) : classes;
  const written = id === undefined || idHoldsStyle ? attributes : { ...attributes, id };
  return {
    tagName,
    ...(className === "" ? {} : { className }),
    ...(idHoldsStyle ? { id } : {}),
    ...(written === undefined ? {} : { attributes: written }),
    ...others,
    ...(hasStyle ? { style } : {}),
  };
}

/**
 * A string that goes into a class list or an attribute of an element built by hand, where Jx has no
 * escape for a literal `${` (it would become a binding and the attribute would be lost). The dollar
 * sign is followed by a zero-width space, which no selector or reader of the value notices, and the
 * report says so; a value that is not text (the block's attributes) is carried by {@link dataAttrs}.
 */
function literal(ctx: ConvertCtx, value: string): string {
  if (!value.includes("${")) return value;
  note(
    ctx,
    "info",
    "block.template-literal",
    `A value of the page holds a literal \`\${\`, which Jx would read as a template and lose; a zero-width space was put after the dollar sign.`,
    { value },
  );
  return value.replaceAll("${", "$\u200b{");
}

/** A block's attributes as the JSON an element carries them in: the dollar sign of a `${` is `\u0024`, so it is never spelled out. */
const dataAttrs = (attrs: Attrs): string => JSON.stringify(attrs).replaceAll("${", "\\u0024{");

/** An entry binding: the template that reads `path` of the entry the template renders. */
const bind = (ctx: ConvertCtx, path: string): string => `\${${ctx.entryExpr}.${path}}`;

/**
 * The same, for a value an entry may not have (an excerpt, a date): a template string that evaluates to
 * `undefined` is not resolved at build time and ships the client runtime for it, so it is coalesced to
 * the empty string, as the Jx binding rules say a binding always is.
 */
const bindOr = (ctx: ConvertCtx, path: string): string => `\${${ctx.entryExpr}.${path} ?? ''}`;

const slugOf = (value: string): string => value.replaceAll(/[^a-z0-9-]/gi, "-");

// ── Text that is markup: what WordPress prints raw, filtered, or escaped ─────────────────────────

/**
 * Escape text for markup the way `esc_html` and `esc_attr` do: the characters that open a tag or close
 * an attribute become entities, and an ampersand that already starts an entity is left alone, because
 * WordPress does not encode twice (`Missions &amp; Evangelism` is shown with one ampersand).
 */
const escOnce = (s: string): string =>
  s
    .replaceAll(/&(?!(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** The inline elements `wp_kses_post` lets a label or a link text keep. */
const KSES_TAGS = new Set([
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

const KSES_ATTRS =
  /^(?:href|src|title|alt|class|id|lang|dir|rel|target|width|height|datetime|role|aria-[\w-]+|data-[\w-]+)$/i;

/**
 * `wp_kses_post` for the RichText attributes of a block (a menu label, a button's text): inline markup
 * stays markup, anything else is shown as the text it was typed as, and no attribute can run a script.
 * The label is HTML in the block's attributes, so `Q <em>and</em> A` has an emphasis and
 * `Study &amp; Education` an ampersand.
 */
function ksesPost(html: string): string {
  return html.replaceAll(
    /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (whole, close: string, name: string, rest: string) => {
      const tag = name.toLowerCase();
      if (!KSES_TAGS.has(tag)) return whole.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      if (close === "/") return `</${tag}>`;
      const attrs = [...rest.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)]
        .filter(([, n, v]) => {
          if (!KSES_ATTRS.test(n!)) return false;
          const value = (v ?? "").replaceAll(/^["']|["']$/g, "").trim();
          // The reader decodes entities in a value, so the scheme is judged after it, with no blank in it.
          const scheme = Array.from(decodeEntities(value))
            .filter((c) => c.charCodeAt(0) > 32)
            .join("");
          return !/^(?:javascript|vbscript|data):/i.test(scheme);
        })
        .map(([, n, v]) => (v === undefined ? n! : `${n}=${v}`));
      return `<${tag}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}${rest.trimEnd().endsWith("/") ? " /" : ""}>`;
    },
  );
}

/** The text a piece of RichText shows, for an attribute that cannot hold markup (`aria-label`). */
const plainOf = (html: string): string => decodeEntities(html.replaceAll(/<[^>]*>/g, ""));

// ── Block supports: what WordPress turns attributes into ────────────────────────────────────────

/** `var:preset|spacing|40` is `var(--wp--preset--spacing--40)`; anything else is a CSS value as written. */
function presetValue(value: string): string {
  const m = /^var:preset\|([a-z-]+)\|(.+)$/i.exec(value);
  return m ? `var(--wp--preset--${m[1]}--${m[2]})` : value;
}

const SIDES = ["top", "right", "bottom", "left"] as const;

/** A length as WordPress writes it: a bare number (the original, unitless form of a border width) is pixels. */
const lengthOf = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value}px`
    : typeof value === "string" && value !== ""
      ? presetValue(value)
      : undefined;

/** A box value (`padding`, `margin`, `border-width`) as longhand declarations. */
function box(prefix: string, value: unknown, out: [string, string][], suffix = ""): void {
  if (typeof value === "string" || typeof value === "number") {
    const v = lengthOf(value);
    if (v !== undefined) out.push([`${prefix}${suffix}`, v]);
  } else if (isRecord(value)) {
    for (const side of SIDES) {
      const v = lengthOf(value[side]);
      if (v !== undefined) out.push([`${prefix}-${side}${suffix}`, v]);
    }
  }
}

const TYPOGRAPHY: Readonly<Record<string, string>> = {
  fontSize: "font-size",
  lineHeight: "line-height",
  fontWeight: "font-weight",
  fontStyle: "font-style",
  textTransform: "text-transform",
  letterSpacing: "letter-spacing",
  textDecoration: "text-decoration",
  fontFamily: "font-family",
  writingMode: "writing-mode",
};

export interface Supports {
  classes: string[];
  /** Kebab-case declarations, in the order WordPress writes them. */
  style: [string, string][];
  id?: string;
}

/**
 * What `get_block_wrapper_attributes()` and the block-support filters make of a block's attributes:
 * the classes (`alignwide`, `has-text-align-center`, `has-primary-color`, `has-large-font-size`, the
 * author's `className`), the inline declarations of the `style` attribute (colour, typography,
 * spacing, border, dimensions) and the `anchor` as the id. A `style` key this does not translate (link
 * colours, shadows, block gaps) is reported once as `block.style-dropped`, because WordPress writes
 * those into a generated stylesheet this conversion does not have.
 */
export function supportsOf(block: WpBlock, ctx: ConvertCtx): Supports {
  const attrs = block.attrs;
  const classes: string[] = [];
  const style: [string, string][] = [];
  const dropped: string[] = [];

  const align = str(attrs.align);
  if (align) classes.push(`align${align}`);
  const textAlign = str(attrs.textAlign);
  if (textAlign) classes.push(`has-text-align-${textAlign}`);
  const textColor = str(attrs.textColor);
  if (textColor) classes.push(`has-${textColor}-color`, "has-text-color");
  const background = str(attrs.backgroundColor);
  if (background) classes.push(`has-${background}-background-color`, "has-background");
  const gradient = str(attrs.gradient);
  if (gradient) classes.push(`has-${gradient}-gradient-background`, "has-background");
  const fontSize = str(attrs.fontSize);
  if (fontSize) classes.push(`has-${fontSize}-font-size`);
  const fontFamily = str(attrs.fontFamily);
  if (fontFamily) classes.push(`has-${fontFamily}-font-family`);

  const s = isRecord(attrs.style) ? attrs.style : {};
  const color = isRecord(s.color) ? s.color : {};
  if (str(color.text)) {
    classes.push("has-text-color");
    style.push(["color", presetValue(color.text as string)]);
  }
  if (str(color.background)) {
    classes.push("has-background");
    style.push(["background-color", presetValue(color.background as string)]);
  }
  if (str(color.gradient)) {
    classes.push("has-background");
    style.push(["background", presetValue(color.gradient as string)]);
  }
  const typography = isRecord(s.typography) ? s.typography : {};
  for (const [key, property] of Object.entries(TYPOGRAPHY)) {
    const v = typography[key];
    if (typeof v === "string" && v !== "") style.push([property, presetValue(v)]);
    // A line height and a weight are numbers as often as strings (`1.6`, `700`), and need no unit.
    else if (typeof v === "number" && (key === "lineHeight" || key === "fontWeight")) {
      style.push([property, String(v)]);
    } else if (v !== undefined && v !== null && typeof v !== "string") {
      dropped.push(`typography.${key}`);
    }
  }
  if (str(typography.textAlign)) style.push(["text-align", typography.textAlign as string]);
  const spacing = isRecord(s.spacing) ? s.spacing : {};
  box("padding", spacing.padding, style);
  box("margin", spacing.margin, style);
  const border = isRecord(s.border) ? s.border : {};
  const radius = lengthOf(border.radius);
  if (radius !== undefined) style.push(["border-radius", radius]);
  else if (isRecord(border.radius)) {
    const corners = {
      topLeft: "border-top-left-radius",
      topRight: "border-top-right-radius",
      bottomLeft: "border-bottom-left-radius",
      bottomRight: "border-bottom-right-radius",
    } as const;
    for (const [key, property] of Object.entries(corners)) {
      const v = lengthOf(border.radius[key]);
      if (v !== undefined) style.push([property, v]);
    }
  }
  // `has-border-color` is the class of a border that has a colour (the style engine adds it for a
  // colour, never for a width alone), and a named colour also names itself.
  const borderColor = str(attrs.borderColor);
  if (borderColor) classes.push("has-border-color", `has-${borderColor}-border-color`);
  else if (str(border.color)) classes.push("has-border-color");
  box("border", border.width, style, "-width");
  if (!borderColor && typeof border.color === "string" && border.color !== "") {
    style.push(["border-color", presetValue(border.color)]);
  }
  if (typeof border.style === "string") style.push(["border-style", border.style]);
  // Each side has a width, a colour and a style of its own.
  for (const side of SIDES) {
    const own = border[side];
    if (!isRecord(own)) continue;
    const width = lengthOf(own.width);
    if (width !== undefined) style.push([`border-${side}-width`, width]);
    if (str(own.color)) style.push([`border-${side}-color`, presetValue(own.color as string)]);
    if (str(own.style)) style.push([`border-${side}-style`, own.style as string]);
    for (const key of Object.keys(own)) {
      if (!["width", "color", "style"].includes(key)) dropped.push(`border.${side}.${key}`);
    }
  }
  const dimensions = isRecord(s.dimensions) ? s.dimensions : {};
  if (typeof dimensions.minHeight === "string") {
    style.push(["min-height", presetValue(dimensions.minHeight)]);
  }
  if (typeof dimensions.aspectRatio === "string")
    style.push(["aspect-ratio", dimensions.aspectRatio]);

  const handled = new Set(["color", "typography", "spacing", "border", "dimensions"]);
  for (const key of Object.keys(s)) if (!handled.has(key)) dropped.push(key);
  for (const key of Object.keys(color))
    if (!["text", "background", "gradient"].includes(key)) dropped.push(`color.${key}`);
  for (const key of Object.keys(spacing))
    if (!["padding", "margin"].includes(key)) dropped.push(`spacing.${key}`);
  for (const key of Object.keys(border)) {
    if (!["radius", "width", "color", "style", ...SIDES].includes(key))
      dropped.push(`border.${key}`);
  }
  for (const key of Object.keys(typography)) {
    if (!(key in TYPOGRAPHY) && key !== "textAlign") dropped.push(`typography.${key}`);
  }
  for (const key of Object.keys(dimensions)) {
    if (!["minHeight", "aspectRatio"].includes(key)) dropped.push(`dimensions.${key}`);
  }
  if (dropped.length > 0) {
    note(
      ctx,
      "warn",
      "block.style-dropped",
      `A ${block.name ?? "freeform"} block carries style settings that WordPress writes into a generated stylesheet (${[...new Set(dropped)].join(", ")}); they are not carried.`,
      { block: block.name, keys: [...new Set(dropped)] },
    );
  }

  const custom = str(attrs.className);
  if (custom) classes.push(custom);
  const anchor = str(attrs.anchor);
  return {
    classes: classes.map((c) => literal(ctx, c)),
    style,
    ...(anchor ? { id: literal(ctx, anchor) } : {}),
  };
}

/** A hand-built element for a dynamic block: the base class, the supports, extra classes and content. */
function dynamicElement(
  tagName: string,
  base: string,
  supports: Supports,
  extra: readonly string[],
  rest: Omit<JxElement, "tagName" | "className" | "id" | "style"> = {},
  extraStyle: JxStyle = {},
): JxElement {
  const style: JxStyle = {};
  for (const [property, value] of supports.style) style[toCamel(property)] = value;
  Object.assign(style, extraStyle);
  return element(tagName, joinClass(base, ...supports.classes, ...extra), {
    ...(supports.id ? { id: supports.id } : {}),
    ...(Object.keys(style).length > 0 ? { style } : {}),
    ...rest,
  });
}

function toCamel(property: string): string {
  if (property.startsWith("--")) return property;
  return property.replaceAll(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ── Layout ───────────────────────────────────────────────────────────────────────────────────────

type LayoutType = "flow" | "constrained" | "flex" | "grid" | "default";

/**
 * The layout a block type has when its attributes name none (`supports.layout.default` in each
 * block.json). A block that supports a layout and declares no default (a cover, a details) has the
 * default one, which is `flow`.
 */
const DEFAULT_LAYOUT: ReadonlyMap<string, LayoutType> = new Map([
  ["group", "flow"],
  ["column", "flow"],
  ["columns", "flex"],
  ["buttons", "flex"],
  ["social-links", "flex"],
  ["post-content", "flow"],
  ["cover", "flow"],
  ["details", "flow"],
]);

/**
 * The classes WordPress's layout support adds at render time (`wp_render_layout_support_flag`), in the
 * order it adds them: `is-vertical` (the orientation), `is-content-justification-<x>` and `is-nowrap`,
 * which come from the attributes whatever the type is, then `is-layout-<type>` and
 * `wp-block-<name>-is-layout-<type>`. A layout with `inherit` takes the site's content width, which is
 * the `constrained` type.
 *
 * Only the classes: what they select (`.is-layout-flex{display:flex}`) and the `wp-container-*` rule
 * that carries a flex layout's orientation and justification come from WordPress's global styles and
 * block-supports stylesheets, and neither fixture site serves them (the rendered pages carry no
 * `global-styles-inline-css` and no `core-block-supports-inline-css`: Cwicly removes them), so the
 * live groups and columns are not flex containers and writing the declarations would invent a layout
 * the site never had.
 */
export function layoutClasses(name: string, attrs: Attrs): string[] {
  const fallback = DEFAULT_LAYOUT.get(name);
  if (fallback === undefined) return [];
  const layout = isRecord(attrs.layout) ? attrs.layout : {};
  const declared = str(layout.type);
  const type: LayoutType =
    declared === "constrained" || declared === "flex" || declared === "grid" || declared === "flow"
      ? declared
      : layout.inherit === true || layout.contentSize !== undefined
        ? "constrained"
        : fallback;
  const slug = (value: string): string =>
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "");
  const orientation = str(layout.orientation);
  const justify = str(layout.justifyContent);
  return [
    ...(orientation ? [`is-${slug(orientation)}`] : []),
    ...(justify ? [`is-content-justification-${slug(justify)}`] : []),
    ...(layout.flexWrap === "nowrap" ? ["is-nowrap"] : []),
    `is-layout-${type}`,
    `wp-block-${name}-is-layout-${type}`,
  ];
}

/** The root changes for a block that has a layout. A cover wraps its inner blocks, and its layout classes go on the wrapper. */
function layoutRoot(block: WpBlock): RootChanges {
  const name = baseName(block);
  return {
    classes: layoutClasses(name, block.attrs),
    ...(name === "cover" ? { within: "wp-block-cover__inner-container" } : {}),
  };
}

// ── Shortcodes ───────────────────────────────────────────────────────────────────────────────────

/**
 * What the shortcodes of the two fixture sites are, by name (a trailing `*` is a prefix). A shortcode
 * is a call into a plugin that runs on every request; none of them can run on a static site, so each
 * becomes a placeholder and an entry in the report. The label says what the page lost.
 */
const SHORTCODES: readonly (readonly [string, string])[] = [
  ["trustindex", "Trustindex review widget"],
  ["fluentform", "Fluent Forms form"],
  ["display-map", "Interactive Geo Maps map"],
  ["rank_math_breadcrumb", "Rank Math breadcrumbs"],
  ["give_*", "GiveWP donation form"],
  ["dkpdf-*", "DK PDF marker"],
  ["nextend_*", "Nextend Social Login"],
  ["su_*", "Shortcodes Ultimate"],
  ["caption", "WordPress image caption"],
  ["wp_caption", "WordPress image caption"],
  ["gallery", "WordPress gallery"],
  ["playlist", "WordPress playlist"],
  ["audio", "WordPress audio player"],
  ["video", "WordPress video player"],
  ["embed", "WordPress embed"],
];

/**
 * What the shortcode `name` is, when it is one of the known ones. WordPress's registry is case
 * sensitive (`[Video]` is text, `[video]` is the player), so the name is compared as written.
 */
function shortcodeLabel(name: string): string | undefined {
  for (const [pattern, label] of SHORTCODES) {
    if (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern)
      return label;
  }
  return undefined;
}

export interface Shortcode {
  name: string;
  /** The text between the name and the closing bracket, as written. */
  attributes: string;
  /** What an enclosing shortcode encloses; undefined for a self-closing one. */
  content?: string;
  /** The whole thing as written. */
  raw: string;
  start: number;
  end: number;
}

const OPENING = /\[(\[?)([A-Za-z0-9_-]+)(?![A-Za-z0-9_-])([^\]]*)\]/g;

/**
 * The shortcodes in `text`, outermost first, in order. An opening tag with a closing `[/name]` after
 * it encloses what is between; one without is self-closing; a doubled bracket (`[[name]]`) is WordPress's
 * escape for the literal text and is not one. `accept` says which names count: bracketed text in prose
 * is not a shortcode unless something registered the name (`[Jesus]` in an essay is an editorial note).
 */
export function findShortcodes(
  text: string,
  accept: (name: string) => boolean = () => true,
): Shortcode[] {
  const out: Shortcode[] = [];
  let from = 0;
  while (from < text.length) {
    OPENING.lastIndex = from;
    const m = OPENING.exec(text);
    if (!m) break;
    const [raw, escaped, name, rest] = m as unknown as [string, string, string, string];
    if (escaped !== "") {
      // `[[name]]` is WordPress's way to print `[name]`: nothing inside it is a shortcode.
      from = m.index + raw.length;
      continue;
    }
    if (!accept(name)) {
      from = m.index + 1;
      continue;
    }
    const selfClosing = rest.trimEnd().endsWith("/");
    const attributes = (selfClosing ? rest.trimEnd().slice(0, -1) : rest).trim();
    let end = m.index + raw.length;
    let content: string | undefined;
    if (!selfClosing) {
      const close = text.indexOf(`[/${name}]`, end);
      if (close !== -1) {
        content = text.slice(end, close);
        end = close + name.length + 3;
      }
    }
    out.push({
      name,
      attributes,
      ...(content === undefined ? {} : { content }),
      raw: text.slice(m.index, end),
      start: m.index,
      end,
    });
    from = end;
  }
  return out;
}

/** `key="value"`, `key='value'`, `key=value` and bare words, as WordPress's `shortcode_parse_atts` reads them. */
export function shortcodeAttributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let positional = 0;
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))|"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
    else out[String(positional++)] = m[5] ?? m[6] ?? m[7] ?? "";
  }
  return out;
}

const escAttr = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** The marker markup of one shortcode (and, recursively, the shortcodes it encloses). */
function shortcodeMarkup(sc: Shortcode, accept: (name: string) => boolean): string {
  const attrs = shortcodeAttributes(sc.attributes);
  const inner =
    sc.content === undefined ? "" : replaceShortcodes(sc.content, accept, () => undefined);
  return (
    `<wp2jx-shortcode data-shortcode="${escAttr(sc.name)}"` +
    (Object.keys(attrs).length > 0 ? ` data-attributes="${escAttr(JSON.stringify(attrs))}"` : "") +
    ` data-source="${escAttr(sc.raw)}">${inner}</wp2jx-shortcode>`
  );
}

/**
 * `text` with each accepted shortcode replaced by its placeholder element, as markup. `seen` hears each
 * outermost one, to report it.
 */
function replaceShortcodes(
  text: string,
  accept: (name: string) => boolean,
  seen: (sc: Shortcode) => void,
): string {
  const found = findShortcodes(text, accept);
  if (found.length === 0) return text;
  let out = "";
  let at = 0;
  for (const sc of found) {
    out += text.slice(at, sc.start) + shortcodeMarkup(sc, accept);
    at = sc.end;
    seen(sc);
  }
  return out + text.slice(at);
}

function reportShortcode(block: WpBlock, ctx: ConvertCtx, sc: Shortcode): void {
  const label = shortcodeLabel(sc.name);
  note(
    ctx,
    "warn",
    "block.shortcode",
    `The shortcode [${sc.name}]${label ? ` (${label})` : ""} runs on every WordPress request and has no static form; a wp2jx-shortcode placeholder marks its place.`,
    {
      block: block.name,
      shortcode: sc.name,
      attributes: shortcodeAttributes(sc.attributes),
      ...(label === undefined ? {} : { label }),
    },
  );
}

const knownShortcode = (name: string): boolean => shortcodeLabel(name) !== undefined;

/** `core/shortcode`: every shortcode in it is a placeholder, known or not. */
const shortcodeBlock: BlockConverter = (block, ctx) => {
  const text = block.innerHTML;
  const html = replaceShortcodes(
    text,
    () => true,
    (sc) => reportShortcode(block, ctx, sc),
  );
  if (html === text) {
    // Text with no shortcode in it: markup (the loader script of a review widget, pasted into the
    // block) is markup, and bare text is text. WordPress runs `wpautop` over the block's output, so a
    // lone script is printed as `<p><script …></script></p>`, a paragraph whose margins the layout
    // keeps (the live page's Trustindex container is 32px taller for it).
    const markup = /<[a-z!/]/i.test(text);
    note(
      ctx,
      "warn",
      "block.shortcode",
      markup
        ? "A shortcode block holds markup and no shortcode; it is kept as raw HTML."
        : "A shortcode block holds no shortcode; its text is kept as a paragraph.",
      { block: block.name },
    );
    if (text.trim() === "") return [];
    return markup
      ? rawMarkup(block, ctx, php.wpautop(text))
      : htmlNodes(`<p>${escAttr(text.trim())}</p>`, ctx);
  }
  return htmlNodes(html, ctx);
};

// ── Raw HTML and classic content ─────────────────────────────────────────────────────────────────

/** The `<script>` elements of a piece of markup: what WordPress printed, kept as it was, and reported. */
function scriptsIn(html: string): { src?: string; length: number }[] {
  const out: { src?: string; length: number }[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of html.matchAll(re)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1] ?? "");
    const value = src?.[1] ?? src?.[2] ?? src?.[3];
    out.push({ ...(value === undefined ? {} : { src: value }), length: (m[2] ?? "").length });
  }
  return out;
}

/** Raw markup as a block: shortcodes become placeholders, scripts are kept and reported, the rest is converted as it is. */
function rawMarkup(
  block: WpBlock,
  ctx: ConvertCtx,
  html: string,
  opts: StaticOptions = {},
): JxNode[] {
  for (const script of scriptsIn(html)) {
    note(
      ctx,
      "warn",
      "block.html-script",
      script.src === undefined
        ? "A raw HTML block holds an inline script; it is kept as written and runs on the migrated page."
        : `A raw HTML block loads the script ${script.src}; it is kept as written and runs on the migrated page.`,
      {
        block: block.name,
        ...(script.src === undefined ? { length: script.length } : { src: script.src }),
      },
    );
  }
  const withShortcodes = replaceShortcodes(html, knownShortcode, (sc) =>
    reportShortcode(block, ctx, sc),
  );
  return htmlNodes(withShortcodes, ctx, { ...contentOptions(ctx), ...opts });
}

const htmlBlock: BlockConverter = (block, ctx) => rawMarkup(block, ctx, block.innerHTML);

/**
 * Classic-editor content: HTML as the editor saved it, with line breaks standing in for paragraphs.
 * WordPress runs `wpautop` over it at render time, so it is run here (a port of the function itself,
 * `php.wpautop` in seo.ts), and what is left is ordinary markup. Not every page runs it: a page whose
 * template prints the content through Cwicly's own `content` block gets the text as it was saved (a
 * line of bare text is no paragraph there), and a driver that knows that sets `wpautop: false` on the
 * context.
 */
const freeformBlock: BlockConverter = (block, ctx) => {
  const html = block.innerHTML;
  if (html.trim() === "") return [];
  if ((ctx as ConvertCtx & { wpautop?: boolean }).wpautop === false) {
    return rawMarkup(block, ctx, html);
  }
  // `autoembed` runs before `wpautop`, on a line that is only an address.
  const embedded = php
    .wpautop(html)
    .replaceAll(/<p>\s*(https?:\/\/[^\s<>"]+)\s*<\/p>/g, (whole, url: string) => {
      const player = autoEmbedPlayer(ctx, block, decodeEntities(url));
      return player === undefined ? whole : `<p>${player}</p>`;
    });
  return rawMarkup(block, ctx, embedded);
};

// ── Embeds ───────────────────────────────────────────────────────────────────────────────────────

const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

/** What a YouTube video, playlist or Vimeo id is made of: nothing that could close an attribute. */
const VIDEO_ID = /^[\w-]+$/;

/**
 * The id a YouTube or Vimeo address names, and the player URL for it. The ids come out of the address
 * (`?v=` is percent-decoded), so one that is not made of word characters and dashes is not an id: an
 * address like `watch?v=abc%22%20onload%3D…` would put its tail into the player's attributes.
 */
function videoOf(
  url: string,
): { provider: "youtube" | "vimeo"; id: string; list?: string } | undefined {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase().replace(/^(?:www|m)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const valid = (id: string | null | undefined): id is string => !!id && VIDEO_ID.test(id);
  if (host === "youtu.be" && valid(parts[0])) return { provider: "youtube", id: parts[0] };
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const asked = u.searchParams.get("list");
    const list = valid(asked) ? asked : undefined;
    const v = u.searchParams.get("v");
    if (valid(v)) return { provider: "youtube", id: v, ...(list ? { list } : {}) };
    if (["embed", "shorts", "live", "v"].includes(parts[0] ?? "") && parts[1]) {
      if (parts[1] === "videoseries" && list) return { provider: "youtube", id: "", list };
      if (valid(parts[1])) return { provider: "youtube", id: parts[1], ...(list ? { list } : {}) };
    }
    if (parts[0] === "playlist" && list) return { provider: "youtube", id: "", list };
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = parts.find((p) => /^\d+$/.test(p));
    if (id) return { provider: "vimeo", id };
  }
  return undefined;
}

/**
 * The player WordPress's oEmbed would have returned, built from the address alone: the shape of the
 * iframes the two fixture sites' own oEmbed caches hold (the title, which the provider supplies, is
 * generic).
 */
function playerMarkup(video: NonNullable<ReturnType<typeof videoOf>>): string {
  if (video.provider === "vimeo") {
    return `<iframe title="Vimeo video" src="https://player.vimeo.com/video/${video.id}?dnt=1&amp;app_id=122963" width="500" height="281" frameborder="0" allow="autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
  }
  const src =
    video.id === ""
      ? `https://www.youtube.com/embed/videoseries?list=${video.list}&amp;feature=oembed`
      : `https://www.youtube.com/embed/${video.id}?${video.list ? `list=${video.list}&amp;` : ""}feature=oembed`;
  return `<iframe title="YouTube video player" width="500" height="281" src="${src}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
}

/**
 * The oEmbed HTML WordPress cached for an address in the post's own meta (`_oembed_<md5>`), which is
 * what it printed the first time the page was viewed, title and all. The key is
 * `md5(url . serialize(["width" => 500, "height" => 750]))` for the fineline site; the other site's
 * keys were made with arguments that cannot be recovered from the data, so the cache is also searched
 * for an entry that names the same video, the newest first (`_oembed_time_<same suffix>`).
 */
function cachedOembed(ctx: ConvertCtx, url: string): string | undefined {
  const post = ctx.subject.post;
  if (!post) return undefined;
  const meta = ctx.model.postMeta.get(post.id);
  if (!meta) return undefined;
  const value = (key: string): string | undefined => {
    const v = meta[key]?.[0];
    return typeof v === "string" && v.trim() !== "" && v !== "{{unknown}}" ? v : undefined;
  };
  const exact = value(`_oembed_${md5(`${url}a:2:{s:5:"width";i:500;s:6:"height";i:750;}`)}`);
  if (exact !== undefined) return exact;
  const video = videoOf(url);
  const needle = video?.id || video?.list || url;
  let best: { html: string; time: number } | undefined;
  for (const key of Object.keys(meta)) {
    if (!key.startsWith("_oembed_") || key.startsWith("_oembed_time_")) continue;
    const html = value(key);
    if (html === undefined || !html.includes(needle)) continue;
    const time = Number(meta[`_oembed_time_${key.slice("_oembed_".length)}`]?.[0] ?? 0) || 0;
    if (best === undefined || time > best.time) best = { html, time };
  }
  return best?.html;
}

const WRAPPER =
  /(<div\b[^>]*\bclass="[^"]*\bwp-block-embed__wrapper\b[^"]*"[^>]*>)([\s\S]*?)(<\/div>)/;

/**
 * The player WordPress's `autoembed` makes of an address that stands on a line of its own in content:
 * the cached oEmbed response, or a YouTube or Vimeo player built from the address. Undefined for any
 * other address, which stays the text it is.
 */
function autoEmbedPlayer(ctx: ConvertCtx, block: WpBlock, url: string): string | undefined {
  const cached = cachedOembed(ctx, url);
  if (cached !== undefined) return cached;
  const video = videoOf(url);
  if (video === undefined) return undefined;
  note(
    ctx,
    "info",
    "block.embed-reconstructed",
    `The address ${url} stands alone on a line, where WordPress embeds it; the ${video.provider} player was rebuilt from the address (its title is generic).`,
    { block: block.name, url, provider: video.provider },
  );
  return playerMarkup(video);
}

/**
 * `core/paragraph`: its saved markup. A paragraph that is only an address is what `autoembed` turns into
 * the player (a YouTube link pasted in the editor), and the live page shows the player.
 */
const paragraphBlock: BlockConverter = (block, ctx) => {
  const bare = /^\s*(<p\b[^>]*>)\s*([^<\s][^<]*?)\s*<\/p>\s*$/i.exec(block.innerHTML);
  if (bare) {
    const url = decodeEntities(bare[2]!);
    const player = /^https?:\/\/\S+$/i.test(url) ? autoEmbedPlayer(ctx, block, url) : undefined;
    if (player !== undefined) return staticBlock(block, ctx, { html: `${bare[1]}${player}</p>` });
  }
  return staticBlock(block, ctx);
};

/**
 * `core/embed` and its pre-5.6 `core-embed/<provider>` names. The block saves only the address; the
 * player is what WordPress's oEmbed made of it when the page was first viewed, and that response is in
 * the post's meta. Without a cached response a YouTube or Vimeo address is turned into the player an
 * oEmbed would return (reported, because the title is lost); any other provider is left as the link
 * WordPress itself prints when oEmbed fails.
 */
const embedBlock: BlockConverter = (block, ctx) => {
  const saved = block.innerHTML;
  const wrapper = WRAPPER.exec(saved);
  const url =
    str(block.attrs.url) ?? (wrapper ? decodeEntities((wrapper[2] ?? "").trim()) : undefined);
  if (!wrapper || url === undefined) return staticBlock(block, ctx);

  let player = cachedOembed(ctx, url);
  const video = videoOf(url);
  if (player === undefined && video) {
    player = playerMarkup(video);
    note(
      ctx,
      "info",
      "block.embed-reconstructed",
      `No cached oEmbed response for ${url}; the ${video.provider} player was rebuilt from the address (its title is generic).`,
      { block: block.name, url, provider: video.provider },
    );
  }
  if (player === undefined) {
    note(
      ctx,
      "warn",
      "block.embed-unresolved",
      `The embed ${url} has no cached oEmbed response and no player this conversion can build; it is kept as a link.`,
      { block: block.name, url, provider: str(block.attrs.providerNameSlug) ?? null },
    );
    player = `<a href="${escAttr(url)}">${escAttr(url)}</a>`;
  }
  const html = saved.replace(
    WRAPPER,
    (_, open: string, _inner: string, close: string) => `${open}${player}${close}`,
  );
  return staticBlock(block, ctx, { html });
};

// ── Static blocks ────────────────────────────────────────────────────────────────────────────────

/** A static block: its saved markup, with what WordPress adds on the root element when it renders. */
const saved =
  (root?: (block: WpBlock) => RootChanges): BlockConverter =>
  (block, ctx) =>
    staticBlock(block, ctx, root ? { root: root(block) } : {});

/**
 * `core/column`'s `flex-basis` comes with `flex-grow: 0` from the block's stylesheet
 * (`.wp-block-column[style*=flex-basis]`), a selector on the very attribute this conversion turns into
 * a style object, so the declaration is written on the element instead.
 */
const columnBlock: BlockConverter = (block, ctx) => {
  const open = block.innerContent?.[0] ?? block.innerHTML;
  const sized = /^\s*<[a-z][^>]*\bstyle="[^"]*\bflex-basis\s*:/i.test(open);
  const layout = layoutRoot(block);
  return staticBlock(block, ctx, {
    root: { ...layout, ...(sized ? { style: [["flex-grow", "0"]] as const } : {}) },
  });
};

/** `core/image`: the figure as saved. A lightbox is WordPress's script, which a static page has not got. */
const imageBlock: BlockConverter = (block, ctx) => {
  const lightbox = block.attrs.lightbox;
  if (isRecord(lightbox) && lightbox.enabled === true) {
    note(
      ctx,
      "info",
      "block.image-lightbox",
      "The image opens in WordPress's lightbox; the converted image is shown in place and links where its link points.",
      { block: block.name, id: block.attrs.id ?? null },
    );
  }
  return staticBlock(block, ctx);
};

/** `core/more` and `core/nextpage` save a comment; neither has an element. */
const dropped =
  (code: string, what: string): BlockConverter =>
  (block, ctx) => {
    note(
      ctx,
      "info",
      code,
      `${what} is dropped: the migrated content is one page with no break at that point.`,
      {
        block: block.name,
      },
    );
    return [];
  };

// ── Placeholders ─────────────────────────────────────────────────────────────────────────────────

/**
 * The element a later stage replaces: `wp2jx-<what>` with the block's name and attributes as data, and
 * its own classes. Nothing about it is visible on a built page that was not replaced.
 */
function placeholder(
  ctx: ConvertCtx,
  block: WpBlock,
  what: string,
  classes: string,
  attributes: Record<string, string> = {},
  children?: JxNode[],
): JxElement {
  const attrs = Object.keys(block.attrs).length > 0 ? { "data-attrs": dataAttrs(block.attrs) } : {};
  const own = Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, literal(ctx, v)]));
  return element(`wp2jx-${what}`, literal(ctx, classes), {
    attributes: { "data-block": literal(ctx, block.name ?? "freeform"), ...attrs, ...own },
    ...(children && children.length > 0 ? { children } : {}),
  });
}

/** `core/template-part`: the template emitter replaces it with the part, whose markup is its own subject. */
const templatePartBlock: BlockConverter = (block, ctx) => {
  const slug = str(block.attrs.slug);
  const attributes: Record<string, string> = {
    ...(slug ? { slug } : {}),
    theme: str(block.attrs.theme) ?? ctx.model.site.theme,
    ...(str(block.attrs.area) ? { area: str(block.attrs.area)! } : {}),
    ...(str(block.attrs.tagName) ? { tag: str(block.attrs.tagName)! } : {}),
  };
  return [
    placeholder(
      ctx,
      block,
      "template-part",
      joinClass("wp-block-template-part", str(block.attrs.className)),
      attributes,
    ),
  ];
};

/** The menus: a placeholder for the menu converter, with the links the block itself holds. */
const navigationBlock: BlockConverter = (block, ctx) => {
  note(
    ctx,
    "info",
    "block.navigation",
    "A navigation block is a menu WordPress renders per request; it is a placeholder for the menu converter.",
    { block: block.name, ref: block.attrs.ref ?? null },
  );
  const ref = block.attrs.ref;
  const classes = joinClass("wp-block-navigation", str(block.attrs.className));
  return [
    placeholder(
      ctx,
      block,
      "navigation",
      classes,
      typeof ref === "number" || typeof ref === "string" ? { "data-ref": String(ref) } : {},
      ctx.convert(block.innerBlocks),
    ),
  ];
};

/**
 * `core/navigation-link` and `core/navigation-submenu`: one menu item, from its attributes. The label is
 * RichText (`wp_kses_post`), so `Missions &amp; Evangelism` shows one ampersand and `Q <em>and</em> A` an
 * emphasis; an item with no label is not printed at all.
 */
const navigationItem: BlockConverter = (block, ctx) => {
  const a = block.attrs;
  const label = str(a.label);
  if (label === undefined) return [];
  const id = typeof a.id === "number" ? a.id : undefined;
  const kind = a.kind === "taxonomy" ? "term" : "post";
  const target = str(a.url) ?? (id === undefined ? undefined : ctx.urlFor(kind, id));
  const submenu = block.name === "core/navigation-submenu";
  const className = joinClass(
    "wp-block-navigation-item",
    submenu ? "has-child wp-block-navigation-submenu" : "wp-block-navigation-link",
    str(a.className),
  );
  const link = `<a class="wp-block-navigation-item__content"${
    target === undefined ? "" : ` href="${escOnce(ctx.rewriteUrl(target))}"`
  }${a.opensInNewTab === true ? ' target="_blank" rel="noopener"' : ""}><span class="wp-block-navigation-item__label">${ksesPost(label)}</span></a>`;
  const [li] = elementsOf(htmlNodes(`<li class="${escOnce(className)}">${link}</li>`, ctx));
  if (!li) return [];
  if (submenu && block.innerBlocks.length > 0) {
    const children = ctx.convert(block.innerBlocks);
    const list = element("ul", "wp-block-navigation__submenu-container", { children });
    li.children = [...(Array.isArray(li.children) ? li.children : []), list];
  }
  return [li];
};

/**
 * The ids of the search inputs of a run: WordPress numbers them per request (`wp_unique_id`), and two
 * search blocks on one page (the search template and the mobile menu part it includes) must not share
 * one. Counted per report, so every search the report hears of has an id of its own.
 */
const searchIds = new WeakMap<object, number>();

/**
 * `core/search`: the form WordPress prints. Jx's search is client-side, so the form needs a page to go
 * to. The label and the button text are RichText (`wp_kses_post`), the placeholder an attribute
 * (`esc_attr`, which does not encode an entity twice).
 */
const searchBlock: BlockConverter = (block, ctx) => {
  note(
    ctx,
    "warn",
    "block.search",
    "A search form is kept as markup; its action is /search/, which needs a page built on @jxsuite/search to answer it.",
    { block: block.name },
  );
  const a = block.attrs;
  const supports = supportsOf(block, ctx);
  const label = ksesPost(str(a.label) ?? "Search");
  const button = str(a.buttonText) ?? "Search";
  const position = str(a.buttonPosition) ?? "button-outside";
  const useIcon = a.buttonUseIcon === true;
  const placeholderText = typeof a.placeholder === "string" ? a.placeholder : "";
  const classes = joinClass(
    position === "button-inside"
      ? "wp-block-search__button-inside"
      : position === "no-button"
        ? "wp-block-search__no-button"
        : "wp-block-search__button-outside",
    useIcon && position !== "no-button" ? "wp-block-search__icon-button" : "",
    "wp-block-search",
    ...supports.classes,
  );
  const n = (searchIds.get(ctx.report) ?? 0) + 1;
  searchIds.set(ctx.report, n);
  const id = `wp-block-search__input-${n}`;
  const icon = `<svg class="search-icon" viewBox="0 0 24 24" width="24" height="24"><path d="M13 5c-3.3 0-6 2.7-6 6 0 1.4.5 2.7 1.3 3.7l-3.8 3.8 1.1 1.1 3.8-3.8c1 .8 2.3 1.3 3.7 1.3 3.3 0 6-2.7 6-6S16.3 5 13 5zm0 10.5c-2.5 0-4.5-2-4.5-4.5s2-4.5 4.5-4.5 4.5 2 4.5 4.5-2 4.5-4.5 4.5z"></path></svg>`;
  const submit =
    position === "no-button"
      ? ""
      : `<button ${useIcon ? `aria-label="${escOnce(plainOf(button))}" ` : ""}class="wp-block-search__button${useIcon ? " has-icon" : ""} wp-element-button" type="submit">${useIcon ? icon : ksesPost(button)}</button>`;
  const field = `<input class="wp-block-search__input" id="${id}" placeholder="${escOnce(placeholderText)}" value="" type="search" name="s" required>`;
  const markup =
    `<form role="search" method="get" action="/search/" class="${escOnce(classes)}" data-wp2jx="search">` +
    `<label class="wp-block-search__label${a.showLabel === false ? " screen-reader-text" : ""}" for="${id}">${label}</label>` +
    `<div class="wp-block-search__inside-wrapper">${field}${submit}</div></form>`;
  return htmlNodes(markup, ctx, {
    root: { ...(supports.id ? { attributes: { id: supports.id } } : {}), style: supports.style },
  });
};

/**
 * What `core/social-links` tells the links inside it (`openInNewTab`, `showLabels`: block context in
 * WordPress), keyed by the child block itself, which is the object the converter of the child is given.
 */
const socialParents = new WeakMap<WpBlock, { openInNewTab: boolean; showLabels: boolean }>();

/** `core/social-links`: the list, with its links told what it says of them. */
const socialLinksBlock: BlockConverter = (block, ctx) => {
  const parent = {
    openInNewTab: block.attrs.openInNewTab === true,
    showLabels: block.attrs.showLabels === true,
  };
  walkInner(block, (child) => socialParents.set(child, parent));
  return withLayout(block, ctx);
};

/** Every inner block of `block`, at any depth, but not the ones of another `core/social-links`. */
function walkInner(block: WpBlock, visit: (child: WpBlock) => void): void {
  for (const child of block.innerBlocks) {
    visit(child);
    if (child.name !== "core/social-links") walkInner(child, visit);
  }
}

/**
 * `core/social-link`: a dynamic block, one list item. The service's icon is WordPress's own SVG and is not
 * carried. What WordPress does with the link is done here: no address, no link; an e-mail address is a
 * `mailto:`; an address with no scheme gets `https://`; the parent's `openInNewTab` adds `target` and
 * `rel="noopener nofollow"`, and its `showLabels` shows the label (the text is escaped, never twice).
 */
const socialLinkBlock: BlockConverter = (block, ctx) => {
  const a = block.attrs;
  const service = slugOf(str(a.service) ?? "link");
  const label = str(a.label)?.trim() || service.charAt(0).toUpperCase() + service.slice(1);
  const parent = socialParents.get(block);
  let url = str(a.url);
  note(
    ctx,
    "info",
    "block.social-icon",
    `The ${service} social link keeps its address and label; WordPress's icon for the service is not carried.`,
    { block: block.name, service },
  );
  if (url === undefined) return [];
  if (/^[^\s@:/]+@[^\s@:/]+\.[^\s@:/]+$/.test(url)) url = `mailto:${url}`;
  else if (!/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) url = `https://${url}`;
  const rel = joinClass(str(a.rel), parent?.openInNewTab ? "noopener nofollow" : undefined);
  const markup =
    `<li class="wp-social-link wp-social-link-${service} wp-block-social-link${str(a.className) ? ` ${escOnce(str(a.className)!)}` : ""}">` +
    `<a href="${escOnce(ctx.rewriteUrl(url))}"${rel ? ` rel="${escOnce(rel)}"` : ""}${parent?.openInNewTab ? ' target="_blank"' : ""} class="wp-block-social-link-anchor">` +
    `<span class="wp-block-social-link-label${parent?.showLabels ? "" : " screen-reader-text"}">${escOnce(label)}</span></a></li>`;
  return htmlNodes(markup, ctx);
};

// ── Reusable blocks ──────────────────────────────────────────────────────────────────────────────

const activeReusable = new Set<number>();

/**
 * `core/block`: a reusable block is a `wp_block` post, and WordPress prints its content in place. It is
 * converted in place the same way (its stylesheet, `cc-rb-<id>`, is part of the subject's CSS index).
 * A reusable block that contains itself would never end, so a reference already being expanded is
 * reported and left out.
 */
const reusableBlock: BlockConverter = (block, ctx) => {
  const ref = Number(block.attrs.ref);
  const post = ctx.model.posts.get(ref);
  if (!post || post.type !== "wp_block") {
    note(
      ctx,
      "warn",
      "block.reusable-missing",
      `The reusable block ${String(block.attrs.ref)} does not exist in the export; nothing was printed for it.`,
      {
        block: block.name,
        ref: block.attrs.ref ?? null,
      },
    );
    return [];
  }
  // WordPress prints a reusable block only when it is published and not behind a password.
  if (post.status !== "publish" || post.passwordProtected) {
    note(
      ctx,
      "warn",
      "block.reusable-unpublished",
      `The reusable block ${ref} is ${post.passwordProtected ? "password protected" : `not published (${post.status})`}; WordPress prints nothing for it, so nothing was printed here.`,
      { block: block.name, ref, status: post.status, passwordProtected: post.passwordProtected },
    );
    return [];
  }
  if (activeReusable.has(ref)) {
    note(
      ctx,
      "error",
      "block.reusable-missing",
      `The reusable block ${ref} contains itself; the inner reference is left out.`,
      { block: block.name, ref },
    );
    return [];
  }
  activeReusable.add(ref);
  try {
    return ctx.convert(parseBlocks(post.content));
  } finally {
    activeReusable.delete(ref);
  }
};

// ── Dynamic blocks: the post's own data ──────────────────────────────────────────────────────────

/** What a block that shows the current post can read: its entry (entry mode), its post (static), or neither. */
type Source = { kind: "entry" } | { kind: "post"; post: WpPost } | { kind: "none" };

function sourceOf(ctx: ConvertCtx): Source {
  if (ctx.mode === "entry") return { kind: "entry" };
  const post = ctx.subject.post;
  if (ctx.subject.kind === "post" && post) return { kind: "post", post };
  return { kind: "none" };
}

/** A dynamic block with no data to read: a placeholder for the template emitter, reported as info. */
function unresolved(block: WpBlock, ctx: ConvertCtx, what: string, classes: string): JxNode[] {
  note(
    ctx,
    "info",
    "block.dynamic-placeholder",
    `${block.name ?? "A block"} shows data of the page it is on, and this template has none to read; a placeholder marks its place.`,
    { block: block.name },
  );
  return [placeholder(ctx, block, what, classes)];
}

/** Text as the content of an element built by hand: the characters, or markup where a `${` must be spelled. */
function textOf(value: string): Pick<JxElement, "textContent" | "innerHTML"> {
  return value.includes("${")
    ? {
        innerHTML: escapeTemplate(
          value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
        ),
      }
    : { textContent: value };
}

/** What `htmlToContent` returned, as the content half of an element (its optional keys are never undefined). */
function contentOf(
  content: HtmlContent,
): Pick<JxElement, "textContent" | "children" | "innerHTML"> {
  return {
    ...(content.textContent === undefined ? {} : { textContent: content.textContent }),
    ...(content.children === undefined ? {} : { children: content.children }),
    ...(content.innerHTML === undefined ? {} : { innerHTML: content.innerHTML }),
  };
}

/** The link attributes of a block with `isLink`, `linkTarget` and `rel`. */
function linkAttributes(ctx: ConvertCtx, block: WpBlock, href: string): Record<string, string> {
  const target = str(block.attrs.linkTarget);
  const rel = str(block.attrs.rel);
  return {
    href,
    ...(target ? { target: literal(ctx, target) } : {}),
    ...(rel || target === "_blank" ? { rel: literal(ctx, rel ?? "noopener") } : {}),
  };
}

const postTitleBlock: BlockConverter = (block, ctx) => {
  const level = typeof block.attrs.level === "number" ? block.attrs.level : 2;
  const tag = level >= 1 && level <= 6 ? `h${level}` : "p";
  const supports = supportsOf(block, ctx);
  const source = sourceOf(ctx);
  if (source.kind === "none")
    return unresolved(
      block,
      ctx,
      "post-title",
      joinClass("wp-block-post-title", ...supports.classes),
    );
  const title =
    source.kind === "entry" ? bindOr(ctx, "data.title") : decodeEntities(source.post.title);
  const href =
    source.kind === "entry" ? bindOr(ctx, "data.url") : ctx.urlFor("post", source.post.id);
  // An entry's title is a binding the build evaluates; a literal one may hold a `${` that must stay text.
  const text = source.kind === "entry" ? { textContent: title } : textOf(title);
  const content: Partial<JxElement> =
    block.attrs.isLink === true && href !== undefined
      ? { children: [{ tagName: "a", attributes: linkAttributes(ctx, block, href), ...text }] }
      : text;
  return [dynamicElement(tag, "wp-block-post-title", supports, [], content)];
};

const postContentBlock: BlockConverter = (block, ctx) => {
  const supports = supportsOf(block, ctx);
  const extra = ["entry-content", ...layoutClasses("post-content", block.attrs)];
  const wrapper = (content: Pick<JxElement, "children">): JxElement =>
    dynamicElement("div", "wp-block-post-content", supports, extra, content);
  const source = sourceOf(ctx);
  // A template string is how Jx names the rendered body of an entry (`children: "${state.entry.$children}"`),
  // which the element type does not list among its forms.
  if (source.kind === "entry") {
    return [
      wrapper({
        children: bind(ctx, "$children") as unknown as NonNullable<JxElement["children"]>,
      }),
    ];
  }
  if (source.kind === "post") {
    // The post's own body, printed where the block stands. A body that holds this block again would
    // never end, so a reference being expanded is not expanded twice.
    if (activeReusable.has(-source.post.id)) return [];
    activeReusable.add(-source.post.id);
    try {
      return [wrapper({ children: ctx.convert(parseBlocks(source.post.content)) })];
    } finally {
      activeReusable.delete(-source.post.id);
    }
  }
  // A template: the body of whatever page is rendered goes where the layout's slot is.
  return [wrapper({ children: [{ tagName: "slot" }] })];
};

/**
 * The declarations WordPress derives from a featured image's attributes (`render_block_core_post_featured_image`):
 * an aspect ratio other than `auto` and the full width it needs; a height, or `auto` when only a width is
 * given; the width; and `object-fit`, whose `scale` default is `cover`.
 */
function featuredImageStyle(a: Attrs): JxStyle {
  const size = (value: unknown): string | undefined =>
    typeof value === "number" ? `${value}px` : str(value);
  const width = size(a.width);
  const height = size(a.height);
  const out: JxStyle = {};
  const ratio = str(a.aspectRatio);
  if (ratio) {
    if (ratio !== "auto") out.aspectRatio = ratio;
    out.width = "100%";
  }
  if (height) out.height = height;
  else if (width) out.height = "auto";
  if (width) out.width = width;
  out.objectFit = str(a.scale) ?? "cover";
  return out;
}

/** The overlay span of a featured image with `dimRatio` (`get_block_core_post_featured_image_overlay_element_markup`), if it has one. */
function featuredImageOverlay(ctx: ConvertCtx, a: Attrs): JxElement | undefined {
  const dim = a.dimRatio;
  if (typeof dim !== "number" || dim <= 0) return undefined;
  const gradient = str(a.gradient);
  const customGradient = str(a.customGradient);
  const color = str(a.overlayColor);
  const style: JxStyle = {
    ...(customGradient ? { backgroundImage: customGradient } : {}),
    ...(str(a.customOverlayColor) ? { backgroundColor: str(a.customOverlayColor)! } : {}),
  };
  return element(
    "span",
    joinClass(
      "wp-block-post-featured-image__overlay",
      "has-background-dim",
      `has-background-dim-${dim}`,
      color ? literal(ctx, `has-${color}-background-color`) : "",
      gradient || customGradient ? "has-background-gradient" : "",
      gradient ? literal(ctx, `has-${gradient}-gradient-background`) : "",
    ),
    { attributes: { "aria-hidden": "true" }, ...(Object.keys(style).length > 0 ? { style } : {}) },
  );
}

/** `post-featured-image`: the thumbnail, from the entry's `featuredImage` or the post's `_thumbnail_id`. */
const featuredImageBlock: BlockConverter = (block, ctx) => {
  const a = block.attrs;
  const supports = supportsOf(block, ctx);
  const source = sourceOf(ctx);
  const imgStyle = featuredImageStyle(a);
  const overlay = featuredImageOverlay(ctx, a);
  const img = (attributes: Record<string, string>): JxElement =>
    element("img", "attachment-post-thumbnail size-post-thumbnail wp-post-image", {
      attributes,
      style: imgStyle,
    });
  const wrap = (
    image: JxElement,
    href: string | undefined,
    extraStyle: JxStyle = {},
  ): JxElement => {
    const inside: JxNode[] = overlay ? [image, overlay] : [image];
    const children: JxNode[] =
      a.isLink === true && href !== undefined
        ? [{ tagName: "a", attributes: linkAttributes(ctx, block, href), children: inside }]
        : inside;
    return dynamicElement(
      "figure",
      "wp-block-post-featured-image",
      supports,
      [],
      { children },
      extraStyle,
    );
  };
  if (source.kind === "none")
    return unresolved(block, ctx, "post-featured-image", "wp-block-post-featured-image");
  if (source.kind === "entry") {
    const image = `${ctx.entryExpr}.data.featuredImage`;
    return [
      wrap(
        img({
          src: `\${${image}?.src ?? ''}`,
          width: `\${${image}?.width ?? ''}`,
          height: `\${${image}?.height ?? ''}`,
          // A linked image is described by the post's title, as WordPress does.
          alt: a.isLink === true ? bindOr(ctx, "data.title") : `\${${image}?.alt ?? ''}`,
        }),
        bindOr(ctx, "data.url"),
        // An entry without a featured image has `src=""`, and the figure is hidden by CSS: a `hidden`
        // binding would ship the client runtime on every page for this one attribute.
        { ':has(img[src=""])': { display: "none" } },
      ),
    ];
  }
  const thumbnail = Number(ctx.model.postMeta.get(source.post.id)?._thumbnail_id?.[0]);
  const media = Number.isFinite(thumbnail) && thumbnail > 0 ? ctx.mediaFor(thumbnail) : undefined;
  if (!media) return [];
  return [
    wrap(
      img({
        ...(media.width !== undefined && media.height !== undefined
          ? { width: String(media.width), height: String(media.height) }
          : {}),
        src: media.src,
        alt: a.isLink === true ? plainOf(decodeEntities(source.post.title)).trim() : media.alt,
      }),
      ctx.urlFor("post", source.post.id),
    ),
  ];
};

/** PHP date formats that `Intl` writes exactly, for a binding that must format the entry's date itself. */
const INTL_FORMATS: Readonly<Record<string, [string, Intl.DateTimeFormatOptions]>> = {
  "F j, Y": ["en-US", { year: "numeric", month: "long", day: "numeric" }],
  "M j, Y": ["en-US", { year: "numeric", month: "short", day: "numeric" }],
  "m/d/Y": ["en-US", { year: "numeric", month: "2-digit", day: "2-digit" }],
  "j F Y": ["en-GB", { year: "numeric", month: "long", day: "numeric" }],
  "d/m/Y": ["en-GB", { year: "numeric", month: "2-digit", day: "2-digit" }],
};

/** The zone WordPress works in: the `timezone_string` option, else `gmt_offset` as `+HH:MM`, else UTC. */
function siteZone(ctx: ConvertCtx): string {
  const zone = (ctx.model.options.get("timezone_string") ?? "").trim();
  if (zone !== "") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return zone;
    } catch {
      // An unknown zone: the offset stands in.
    }
  }
  const offset = Number((ctx.model.options.get("gmt_offset") ?? "").trim());
  if (!Number.isFinite(offset) || offset === 0) return "UTC";
  const minutes = Math.round(Math.abs(offset) * 60);
  return `${offset < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * `core/post-date`. The date shown is the one the block is bound to (`metadata.bindings.datetime`, WordPress
 * 6.9: the post's `date` or `modified`), else the `datetime` the block holds, else, in a block saved before
 * either existed, the post's date, or its modified date for `displayType: "modified"` (which also has a
 * class of its own). A relative format (`human-diff`) depends on the day the page is read, and a static
 * page has no such day: it is written in the site's own format, and reported.
 */
const postDateBlock: BlockConverter = (block, ctx) => {
  const supports = supportsOf(block, ctx);
  const source = sourceOf(ctx);
  const a = block.attrs;
  const bindings = isRecord(a.metadata) && isRecord(a.metadata.bindings) ? a.metadata.bindings : {};
  const binding = isRecord(bindings.datetime) ? bindings.datetime : undefined;
  const args = binding && str(binding.source) && isRecord(binding.args) ? binding.args : undefined;
  const given = args === undefined ? str(a.datetime) : undefined;
  const legacy = args === undefined && given === undefined;
  const modified =
    args === undefined ? legacy && a.displayType === "modified" : args.field === "modified";
  const field = modified ? "modified" : "date";
  const siteFormat = (ctx.model.options.get("date_format") ?? "").trim() || "F j, Y";
  const asked = str(a.format);
  const relative = asked === "human-diff";
  const format = relative ? siteFormat : (asked ?? siteFormat);
  const classes = legacy && modified ? ["wp-block-post-date__modified-date"] : [];
  if (source.kind === "none" && given === undefined)
    return unresolved(
      block,
      ctx,
      "post-date",
      joinClass("wp-block-post-date", ...classes, ...supports.classes),
    );
  if (relative) {
    note(
      ctx,
      "info",
      "block.date-format",
      `The date format "human-diff" prints the time since the post ("2 days ago") and depends on the day the page is read, which a static page has none of; the date is written in the site's format (${JSON.stringify(siteFormat)}).`,
      { block: block.name, format: "human-diff" },
    );
  }
  const wrap = (time: JxElement, href: string | undefined): JxElement =>
    dynamicElement("div", "wp-block-post-date", supports, classes, {
      children: [
        a.isLink === true && href !== undefined
          ? { tagName: "a", attributes: linkAttributes(ctx, block, href), children: [time] }
          : time,
      ],
    });
  const iso =
    given ??
    (source.kind === "post" ? (modified ? source.post.modified : source.post.date) : undefined);
  if (iso !== undefined) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return [];
    const zone = siteZone(ctx);
    const href =
      source.kind === "post"
        ? ctx.urlFor("post", source.post.id)
        : source.kind === "entry"
          ? bindOr(ctx, "data.url")
          : undefined;
    return [
      wrap(
        {
          tagName: "time",
          attributes: { datetime: given ?? php.date("c", ms, zone) },
          textContent: php.date(format, ms, zone),
        },
        href,
      ),
    ];
  }
  const known = INTL_FORMATS[format];
  const value = bind(ctx, `data.${field}`).slice(2, -1);
  let text: string;
  if (known) {
    // The offset form (`-04:00`) is a time zone `Intl` knows: UTC would print another day near midnight.
    const options = { ...known[1], timeZone: siteZone(ctx) };
    text = `\${${value} ? new Date(${value}).toLocaleDateString('${known[0]}', ${JSON.stringify(options)}) : ''}`;
  } else {
    note(
      ctx,
      "info",
      "block.date-format",
      `The date format ${JSON.stringify(format)} has no equivalent in a binding; the entry's date is shown as YYYY-MM-DD.`,
      { block: block.name, format },
    );
    text = `\${String(${value} ?? '').slice(0, 10)}`;
  }
  return [
    wrap(
      {
        tagName: "time",
        attributes: { datetime: bindOr(ctx, `data.${field}`) },
        textContent: text,
      },
      bindOr(ctx, "data.url"),
    ),
  ];
};

/**
 * `post-excerpt`. WordPress trims the excerpt to `excerptLength` words (55 when the block does not say)
 * whether the post wrote it or not, and puts the more link in a paragraph of its own unless the block
 * says `showMoreOnNewLine: false`. The more text is RichText.
 */
const postExcerptBlock: BlockConverter = (block, ctx) => {
  const supports = supportsOf(block, ctx);
  const source = sourceOf(ctx);
  const moreText = str(block.attrs.moreText);
  const classes = joinClass("wp-block-post-excerpt", ...supports.classes);
  if (source.kind === "none") return unresolved(block, ctx, "post-excerpt", classes);
  const length = typeof block.attrs.excerptLength === "number" ? block.attrs.excerptLength : 55;
  const more = (href: string): JxElement => ({
    tagName: "a",
    className: "wp-block-post-excerpt__more-link",
    attributes: { href },
    ...contentOf(htmlContent(ksesPost(moreText ?? ""), ctx)),
  });
  let excerpt: string;
  let href: string | undefined;
  if (source.kind === "entry") {
    excerpt = bindOr(ctx, "data.excerpt");
    href = bindOr(ctx, "data.url");
  } else {
    const own = source.post.excerpt.trim();
    excerpt = decodeEntities(trimWords(own !== "" ? own : source.post.content, length));
    href = ctx.urlFor("post", source.post.id);
  }
  const text = source.kind === "entry" ? { textContent: excerpt } : textOf(excerpt);
  const onNewLine = block.attrs.showMoreOnNewLine !== false;
  const paragraph: JxElement = {
    tagName: "p",
    className: "wp-block-post-excerpt__excerpt",
    ...(moreText && !onNewLine && href !== undefined
      ? { children: [{ ...text, tagName: "span" }, " ", more(href)] }
      : text),
  };
  const children: JxNode[] = [paragraph];
  if (moreText && onNewLine && href !== undefined) {
    children.push({
      tagName: "p",
      className: "wp-block-post-excerpt__more-text",
      children: [more(href)],
    });
  }
  return [dynamicElement("div", "wp-block-post-excerpt", supports, [], { children })];
};

/** WordPress's `wp_trim_words(strip_shortcodes(content), n)` on block content: tags and comments gone, `n` words, then an ellipsis. */
function trimWords(content: string, count: number): string {
  const plain = decodeEntities(
    php.stripAllTags(php.stripShortcodes(content.replaceAll(/<!--[\s\S]*?-->/g, ""))),
  );
  const words = plain.split(/\s+/).filter(Boolean);
  return words.length > count ? `${words.slice(0, count).join(" ")}…` : words.join(" ");
}

/** A string as a JavaScript literal that is safe inside a `${…}` template: braces and the dollar sign are escapes. */
const jsString = (value: string): string =>
  JSON.stringify(value).replaceAll(
    new RegExp("[{}$\\u2028\\u2029]", "g"),
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/**
 * `core/post-terms`. WordPress separates the terms with `, ` unless the block says otherwise (the
 * attribute's default, which is not saved in the block comment), lists them in the order
 * `get_the_terms` returns them, which is by name, and prints the prefix and suffix as the markup they
 * are.
 */
const postTermsBlock: BlockConverter = (block, ctx) => {
  const taxonomy = str(block.attrs.term) ?? "category";
  const supports = supportsOf(block, ctx);
  const base = literal(ctx, `taxonomy-${slugOf(taxonomy)}`);
  const separator =
    typeof block.attrs.separator === "string"
      ? block.attrs.separator === ""
        ? " "
        : block.attrs.separator
      : ", ";
  const prefix = str(block.attrs.prefix);
  const suffix = str(block.attrs.suffix);
  const source = sourceOf(ctx);
  const bits = (text: string | undefined, cls: string): string =>
    text === undefined ? "" : `<span class="wp-block-post-terms__${cls}">${ksesPost(text)}</span>`;
  const sep = `<span class="wp-block-post-terms__separator">${escOnce(separator)}</span>`;
  if (source.kind === "none")
    return unresolved(
      block,
      ctx,
      "post-terms",
      joinClass(base, "wp-block-post-terms", ...supports.classes),
    );
  const byName = (a: string, b: string): number =>
    a.localeCompare(b, "en", { sensitivity: "base", numeric: true });
  if (source.kind === "post") {
    const terms = [...termsOf(ctx.model, source.post.id, taxonomy)]
      .map((t) => ({ t, name: decodeEntities(t.name) }))
      .sort((x, y) => byName(x.name, y.name));
    if (terms.length === 0) return [];
    const links = terms
      .map(({ t, name }) => {
        const href = ctx.urlFor("term", t.termId);
        return `<a href="${escOnce(href ?? "")}" rel="tag">${escOnce(name)}</a>`;
      })
      .join(sep);
    const content = htmlContent(`${bits(prefix, "prefix")}${links}${bits(suffix, "suffix")}`, ctx);
    return [dynamicElement("div", base, supports, ["wp-block-post-terms"], contentOf(content))];
  }
  // The key is a string literal, not a property name: `3d_tag` is a taxonomy and `terms?.3d_tag` is not JavaScript.
  const list = `(${ctx.entryExpr}.data.terms?.[${jsString(taxonomy)}] ?? [])`;
  const links =
    `[...${list}].sort((a, b) => a.name.localeCompare(b.name, 'en', {sensitivity: 'base', numeric: true}))` +
    `.map(t => '<a href="' + t.url + '" rel="tag">' + t.name.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</a>')` +
    `.join(${jsString(sep)})`;
  return [
    dynamicElement("div", base, supports, ["wp-block-post-terms"], {
      innerHTML: `\${${list}.length ? ${jsString(bits(prefix, "prefix"))} + ${links} + ${jsString(bits(suffix, "suffix"))} : ''}`,
    }),
  ];
};

/**
 * What `get_the_archive_title()` puts before the name of a term: `Category: `, `Tag: `, or a custom
 * taxonomy's singular label. The archive template says which it is (`category`, `tag`,
 * `taxonomy-series`); the generic `archive` shows more than one kind, so it has no single label.
 */
function archiveLabel(ctx: ConvertCtx): string | undefined {
  const slug = ctx.subject.id.split("//").pop() ?? "";
  if (slug === "category") return "Category";
  if (slug === "tag") return "Tag";
  const taxonomy = /^taxonomy-(.+)$/.exec(slug)?.[1];
  return taxonomy === undefined ? undefined : ctx.acf.taxonomies.get(taxonomy)?.singular;
}

/** `core/query-title`: an archive's heading, from the term the archive template shows. */
const queryTitleBlock: BlockConverter = (block, ctx) => {
  const supports = supportsOf(block, ctx);
  const level = typeof block.attrs.level === "number" ? block.attrs.level : 1;
  const tag = level >= 1 && level <= 6 ? `h${level}` : "p";
  if (block.attrs.type === "archive" && ctx.termExpr !== undefined) {
    // `showPrefix` defaults to true: the archive title is `Category: Theology`, not `Theology`.
    const label = block.attrs.showPrefix === false ? undefined : archiveLabel(ctx);
    if (label === undefined && block.attrs.showPrefix !== false) {
      note(
        ctx,
        "info",
        "block.archive-prefix",
        "WordPress prints the kind of archive before its name (`Category: Theology`), and this template shows more than one kind (or none it can name), so only the name is printed.",
        { block: block.name },
      );
    }
    return [
      dynamicElement(tag, "wp-block-query-title", supports, [], {
        textContent: `${label === undefined ? "" : `${literal(ctx, label)}: `}\${${ctx.termExpr}.name}`,
      }),
    ];
  }
  return unresolved(
    block,
    ctx,
    "query-title",
    joinClass("wp-block-query-title", ...supports.classes),
  );
};

/** `core/loginout`: a login link, which a static site has nothing to log in to. */
const loginoutBlock: BlockConverter = (block, ctx) => {
  note(
    ctx,
    "warn",
    "block.dynamic-dropped",
    "The login/logout link has no static equivalent and is dropped.",
    {
      block: block.name,
    },
  );
  return [];
};

// ── Footnotes ────────────────────────────────────────────────────────────────────────────────────

/**
 * `core/footnotes`: a dynamic block whose list WordPress builds from the post's `footnotes` meta (a
 * JSON array of `{id, content}`). The markers in the text are saved markup (`<sup data-fn="…" class="fn">
 * <a href="#…" id="…-link">1</a></sup>`) and are kept by the paragraphs that hold them; this is the
 * list they point at, as WordPress prints it: an `ol` of `li#<id>` with the note's own HTML and a link
 * back to the marker.
 */
const footnotesBlock: BlockConverter = (block, ctx) => {
  const post = ctx.subject.post;
  const raw = post ? ctx.model.postMeta.get(post.id)?.footnotes?.[0] : undefined;
  let notes: { id: string; content: string }[] = [];
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        notes = parsed.filter(
          (n): n is { id: string; content: string } =>
            isRecord(n) && typeof n.id === "string" && typeof n.content === "string",
        );
      }
    } catch {
      // Reported below, with the other way this block ends up empty.
    }
  }
  if (notes.length === 0) {
    note(
      ctx,
      "warn",
      "block.footnotes-missing",
      "A footnotes block has no footnotes to list: the post has no `footnotes` meta, or it is not the JSON WordPress writes.",
      { block: block.name },
    );
    return [];
  }
  const supports = supportsOf(block, ctx);
  const items = notes
    .map(
      (n, i) =>
        `<li id="${escAttr(n.id)}">${n.content} <a href="#${escAttr(n.id)}-link" aria-label="Jump to footnote reference ${i + 1}">↩︎</a></li>`,
    )
    .join("");
  const [list] = elementsOf(htmlNodes(`<ol>${items}</ol>`, ctx));
  if (!list) return [];
  const own = dynamicElement("ol", "wp-block-footnotes", supports, [], {});
  return [
    {
      ...list,
      className: joinClass(own.className, list.className),
      ...(own.style ? { style: own.style } : {}),
      ...(own.id ? { id: own.id } : {}),
    },
  ];
};

// ── The registry ─────────────────────────────────────────────────────────────────────────────────

/**
 * `core/list`: WordPress prints `wp-block-list` on every list, and the block library's only rule that
 * needs it is `.wp-block-list.has-background`, so a list with a background gets the class a list saved
 * before the class existed lacks. Adding it to every list would turn each one in a Markdown entry
 * from a plain list into a directive container for nothing.
 */
function listRoot(block: WpBlock): RootChanges {
  const open = block.innerContent?.[0] ?? block.innerHTML;
  return /^\s*<[a-z][^>]*\bclass="[^"]*\bhas-background\b/i.test(open)
    ? { classes: ["wp-block-list"] }
    : {};
}

const text = saved();
const withLayout = saved(layoutRoot);

/**
 * Every core block this module converts, by name. Another module merges it with the Cwicly registry.
 * A name that is not here is {@link convertCoreBlock}'s business: unknown blocks are reported and keep
 * their saved markup.
 */
export const coreConverters: Record<string, BlockConverter> = {
  "core/paragraph": paragraphBlock,
  "core/heading": text,
  "core/list": saved(listRoot),
  "core/list-item": text,
  "core/quote": text,
  "core/pullquote": text,
  "core/verse": text,
  "core/code": text,
  "core/preformatted": text,
  "core/image": imageBlock,
  "core/gallery": text,
  "core/table": text,
  "core/embed": embedBlock,
  "core/video": text,
  "core/audio": text,
  "core/file": text,
  "core/group": withLayout,
  "core/columns": withLayout,
  "core/column": columnBlock,
  "core/buttons": withLayout,
  "core/button": text,
  "core/separator": text,
  "core/spacer": text,
  "icb/image-compare": imageCompareBlock,
  "core/html": htmlBlock,
  "core/shortcode": shortcodeBlock,
  "core/freeform": freeformBlock,
  "core/more": dropped("block.more-dropped", "The read-more marker"),
  "core/nextpage": dropped("block.nextpage-dropped", "The page break"),
  "core/cover": withLayout,
  "core/media-text": text,
  "core/details": withLayout,
  "core/social-links": socialLinksBlock,
  "core/social-link": socialLinkBlock,
  "core/search": searchBlock,
  "core/navigation": navigationBlock,
  "core/navigation-link": navigationItem,
  "core/navigation-submenu": navigationItem,
  "core/template-part": templatePartBlock,
  "core/post-content": postContentBlock,
  "core/post-title": postTitleBlock,
  "core/post-featured-image": featuredImageBlock,
  "core/post-date": postDateBlock,
  "core/post-excerpt": postExcerptBlock,
  "core/post-terms": postTermsBlock,
  "core/query-title": queryTitleBlock,
  "core/loginout": loginoutBlock,
  "core/footnotes": footnotesBlock,
  "core/block": reusableBlock,
};

/** The pre-5.6 spelling of an embed: `core-embed/youtube`. */
const isLegacyEmbed = (name: string): boolean => name.startsWith("core-embed/");

/**
 * Convert one block of any name. The registry decides; a freeform block is classic-editor HTML; a
 * name nothing here knows is reported (`block.unsupported`) and converted through its saved markup, so
 * no content is lost, with a placeholder where the block saved nothing (a dynamic block this module
 * has no renderer for).
 */
export function convertCoreBlock(block: WpBlock, ctx: ConvertCtx): JxNode[] {
  if (block.name === null) return freeformBlock(block, ctx);
  const converter = Object.hasOwn(coreConverters, block.name)
    ? coreConverters[block.name]
    : isLegacyEmbed(block.name)
      ? embedBlock
      : undefined;
  if (converter) return converter(block, ctx);
  const nodes = staticBlock(block, ctx);
  const kept = nodes.length > 0 || block.innerBlocks.length > 0;
  note(
    ctx,
    "warn",
    "block.unsupported",
    kept
      ? `The block ${block.name} has no converter; its saved markup is kept as it is.`
      : `The block ${block.name} has no converter and saved no markup (WordPress builds it per request); a wp2jx-block placeholder marks its place.`,
    { block: block.name, kept },
  );
  return kept ? nodes : [placeholder(ctx, block, "block", "")];
}

export { targetOf };
