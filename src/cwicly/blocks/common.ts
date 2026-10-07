/**
 * What every Cwicly block converter needs, so that the layout, interactive and data converters build
 * their elements the same way.
 *
 * A converter does two things: it says what is INSIDE its block (children, text, an icon, an image's
 * attributes) and it hands that to {@link buildBlock}, which makes the ROOT. The root is where five
 * modules meet, and getting any of them wrong is silent, so it lives here once:
 *
 * - `styleBlock` (style.ts): the class list with the classID first, the block's own rule, the
 *   attributes the author added, the `id` the saved tag prints, the elements the saved markup puts
 *   around the styled one (a lightbox link, `wrappers`) and the rules that cannot live in an element's
 *   `style` (`hoisted`, handed to `ctx.hoist`).
 * - `blockVisibility` (conditions.ts): `omit` returns no nodes (and no inner blocks are converted),
 *   `hidden` is `attributes.hidden` with the `&[hidden]` rule that makes it win over the block's own
 *   `display`, `deviceHide` is `display: none` at the breakpoints.
 * - `blockLink` (links.ts): which element is the anchor. `self` makes the block's own element the
 *   `<a>`, `inner` wraps its content in one (a heading), `outer` wraps the element (an image), `button`
 *   leaves a `<button>`, `images` is the gallery's. A modal or popover opener cannot be an `<a>` (the
 *   popover attributes only work on a button), so it becomes one ({@link triggerOf}).
 * - the content, as markup. A block's text, an icon's SVG and a button's icon and label are ONE
 *   string of markup handed to `htmlContent` (core/static.ts) in one piece, because that is what
 *   decides between `children` and an `innerHTML` that keeps the gap-free spacing the page had
 *   (docs/design.md, "Jx emitter behaviour"), moves every address to where the Jx site has it and,
 *   for a Markdown entry, keeps the content structured. Bindings cross it as placeholders and are
 *   finished before anything is returned (docs/bindings.md, section 8.5).
 *
 * Decisions that are easy to get wrong:
 *
 * - **The `id` is an attribute, never the element's `id`.** The build writes an element's own style to
 *   `#id` when it has one, which moves every rule off `.classID` (specificity 1,0,0 beats the
 *   `:hover` rules of a global class); `attributes.id` is only an attribute (verified by a build in
 *   the tests), so anchors and `blockid` custom CSS keep working.
 * - **A style needs a scope.** Jx writes it to the first word of `className`. The classID is that word
 *   when the block prints it; an unstyled block prints `cc-sct`, which every section shares, so when
 *   the element still gets a style (the hidden rule) a `jx-<hash>` scope class goes first, the way
 *   `htmlToNodes` makes one.
 * - **The hide goes on the styled element**, not on the wrapper a lightbox adds: a wrapper's first
 *   class (`cc-lightbox`) is shared, and an anchor with nothing visible inside takes no room.
 * - **A Markdown entry cannot carry most nested style keys.** Jx Markdown writes a nested key as a directive
 *   attribute name (`style.& a.color="red"`), and the directive syntax reads only letters, digits and
 *   `_ : . @ -` there: `&:hover`, `& a`, `&[hidden]`, `:is(a)` end the attribute, and the whole directive is
 *   read back as a paragraph that shows its own source (measured: every `&` key, 4,400 elements of the
 *   fineline entries are affected). So for a Markdown target those keys, in the block's own style and
 *   inside its at-rules, leave the element and become rules of the project (`ctx.hoist`, selector
 *   `.<scope class> a`): the same selector, in the place project rules are emitted, which is before every
 *   element's own rules.
 * - **A binding is never in a class list or an id**; `blockLink` and `blockImage` already write
 *   attribute values that way (`${x || false}` leaves the attribute out).
 *
 * Report codes (the block's name, classID and uniqueID are in `data`): `block.unsupported`,
 * `block.hoist-unavailable`, and each converter's own. Everything the style, link, dynamic and
 * condition modules report arrives through the calls made here.
 */
import { contentOptions, htmlContent, htmlNodes, targetOf } from "../../core/static.ts";
import type { HtmlContent } from "../../html.ts";
import { finishNodes, joinClass, mergeStyle, isEmptyStyle } from "../../jx-util.ts";
import type { ConvertCtx, JxElement, JxNode, JxStyle, WpBlock } from "../../types.ts";
import { createHash } from "node:crypto";
import { blockVisibility, type Visibility, type VisibilityOptions } from "../conditions.ts";
import { contentToken } from "../dynamic.ts";
import { blockLink, type LinkAction, type LinkSpec } from "../links.ts";
import {
  styleBlock,
  whereOf,
  type BlockStyling,
  type ElementShape,
  type StyleOptions,
} from "../style.ts";
import { escapeHtml, literalTemplate, report, resolveMarked, resolveTokens } from "../tokens.ts";

export { targetOf, whereOf };

// ── Small readers ────────────────────────────────────────────────────────────────────────────────

export type Attrs = Record<string, unknown>;

/** A non-empty string (or a number, as text), or undefined. */
export const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined;

export const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** A block's short name: `cwicly/heading` is `heading`. */
export const baseName = (block: WpBlock): string =>
  (block.name ?? "freeform").replace(/^cwicly\//, "");

/** The value of an attribute written on an element. */
export type AttrValue = string | number | boolean;

// ── Reporting ────────────────────────────────────────────────────────────────────────────────────

/**
 * Report something about one block. Located at the subject (`post:195`) like every other entry, with
 * the block's name, classID and uniqueID in `data`; a block repeated in a loop is reported once
 * (`report` keeps one entry per subject, code and `data.detail`).
 */
export function say(
  ctx: ConvertCtx,
  block: WpBlock,
  code: string,
  severity: "info" | "warn" | "error",
  message: string,
  data: Record<string, unknown> = {},
): void {
  const attrs = block.attrs;
  const who = text(attrs.classID) ?? text(attrs.uniqueID) ?? "";
  report(ctx, code, severity, message, {
    block: block.name ?? "freeform",
    ...(text(attrs.classID) ? { classID: text(attrs.classID) } : {}),
    ...(text(attrs.uniqueID) ? { uniqueID: text(attrs.uniqueID) } : {}),
    ...data,
    detail: `${who}|${String(data.detail ?? message)}`,
  });
}

// ── Addresses ────────────────────────────────────────────────────────────────────────────────────

/**
 * An address `ctx.rewriteUrl` should be asked about: absolute, protocol-relative or root-relative.
 * A fragment, `mailto:`, `tel:`, a binding and a bare file name are none of those. The same test
 * core/static.ts applies to the markup of a core block.
 */
const ADDRESS = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i;

/**
 * An address that is already the Jx site's own: a file of the media plan (`/media/2023/03/a.jpg`). The
 * style module resolves the image tokens of a saved tag into these before an attribute is read, and
 * `ctx.rewriteUrl` would take the path for a same-site link no route accounts for and report it.
 */
const MEDIA_FILE = /^\/media\/[^?#]*\.[a-z0-9]{2,5}(?:[?#].*)?$/i;

/** Attributes that hold an address, whatever the element. */
const ADDRESS_ATTRIBUTES = new Set(["href", "src", "poster", "action", "data"]);

/** Move an address found in saved markup to where the Jx site has it; anything else is returned as it is. */
export function rewriteAddress(ctx: ConvertCtx, value: string): string {
  const v = value.trim();
  return ADDRESS.test(v) && !MEDIA_FILE.test(v) && !v.includes("${") ? ctx.rewriteUrl(v) : value;
}

// ── The block's environment ──────────────────────────────────────────────────────────────────────

export interface PrepareOptions {
  /** Passed to `styleBlock`: component variants, the uniqueID → classID map, a connected class. */
  style?: StyleOptions;
  /** Passed to `blockVisibility`: `{queryCount}` for a block inside a query. */
  visibility?: VisibilityOptions;
}

/** Everything the modules that read a block's attributes say about it, computed once. */
export interface BlockEnv {
  block: WpBlock;
  ctx: ConvertCtx;
  styling: BlockStyling;
  visibility: Visibility;
  link: LinkSpec | undefined;
}

/** Hand a rule that cannot live in one element's `style` to the page or project, or say that nothing takes it. */
export function hoistRule(
  ctx: ConvertCtx,
  block: WpBlock,
  rule: { selector: string; style: JxStyle },
): void {
  if (ctx.hoist) {
    ctx.hoist(rule);
    return;
  }
  say(
    ctx,
    block,
    "block.hoist-unavailable",
    "warn",
    `The rule ${rule.selector} cannot live in an element's style and this conversion has nowhere to put it: it is lost.`,
    { detail: rule.selector, selector: rule.selector },
  );
}

/**
 * Ask the style, visibility and link modules about a block. `undefined` means the block is never
 * shown (`omit`): the converter returns no nodes and must not convert its inner blocks, which would
 * only add reports for content nobody sees.
 */
export function prepare(
  block: WpBlock,
  ctx: ConvertCtx,
  opts: PrepareOptions = {},
): BlockEnv | undefined {
  const visibility = blockVisibility(block, ctx, opts.visibility);
  if (visibility.omit) return undefined;
  const styling = styleBlock(block, ctx, {
    resolveTokens: (t) => resolveTokens(t, ctx, block, { where: "attribute" }),
    ...opts.style,
  });
  for (const rule of styling.hoisted) hoistRule(ctx, block, rule);
  return { block, ctx, styling, visibility, link: blockLink(block, ctx) };
}

// ── Links ────────────────────────────────────────────────────────────────────────────────────────

const POPOVER_MODE: Record<string, "show" | "hide" | "toggle"> = {
  open: "show",
  show: "show",
  close: "hide",
  hide: "hide",
  toggle: "toggle",
  showHide: "toggle",
};

export interface Trigger {
  /** The element is a `<button>`: the popover attributes only work on one. */
  tag: "button";
  attributes: Record<string, AttrValue>;
}

/**
 * A modal or popover opener as the one thing a static page can do with it: a button that targets the
 * element by id (`popovertarget`). The modal and popover converters give their element that id, so the
 * target is the block's own `id` attribute, as the editor wrote it into the link (`linkWrapperActionModalBlockId`).
 */
export function triggerOf(action: LinkAction | undefined): Trigger | undefined {
  if (!action || (action.kind !== "modal" && action.kind !== "popover")) return undefined;
  return {
    tag: "button",
    attributes: {
      type: "button",
      popovertarget: action.target,
      popovertargetaction: POPOVER_MODE[action.mode] ?? "toggle",
    },
  };
}

/** The attributes a link puts on its anchor, in final form (`${x || false}` leaves one out). */
export function linkAttributes(link: LinkSpec): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  if (link.href !== undefined) out.href = link.href;
  if (link.target !== undefined) out.target = link.target;
  if (link.rel !== undefined) out.rel = link.rel;
  if (link.title !== undefined) out.title = link.title;
  if (link.ariaLabel !== undefined) out["aria-label"] = link.ariaLabel;
  return out;
}

// ── Content ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The markup a block's text is, with its tokens still in it: the dynamic token between its static
 * texts, or its saved `content`. The same string `blockText` and `blockContent` (dynamic.ts) start
 * from, written out here because they hand back finished strings, and a converter needs the markup
 * itself to put an icon beside it before it is converted in one piece.
 */
export function contentMarkup(block: WpBlock): { markup: string; dynamic: boolean } | undefined {
  const a = block.attrs;
  const connector = record(record(a.componentConnectors)?.content);
  const token =
    connector && text(connector.ref)
      ? `{component=content=${text(connector.ref)}}`
      : contentToken(a);
  if (token === undefined && text(a.dynamic) !== undefined) {
    // A dynamic source the editor writes no token for (a filter's selection): its `content` is the editor's preview.
    return { markup: "", dynamic: true };
  }
  if (token !== undefined) {
    const before = text(a.dynamicStaticBefore);
    const after = text(a.dynamicStaticAfter);
    return {
      markup: `${before === undefined ? "" : escapeHtml(before)}${token}${after === undefined ? "" : escapeHtml(after)}`,
      dynamic: true,
    };
  }
  const content = text(a.content);
  return content === undefined ? undefined : { markup: content, dynamic: false };
}

/**
 * Markup (tokens and all) as the content of one element: tokens resolved, the markup converted
 * (`htmlContent`: addresses moved, `target` honoured) and every binding finished. Text WordPress
 * prints is texturized by the token resolver, so the conversion does not do it twice, and Rank
 * Math's new-window rule for the external links of a post's content is applied as it is to a core
 * block's.
 */
export function markupContent(
  markup: string,
  ctx: ConvertCtx,
  block: WpBlock | undefined,
): HtmlContent {
  const marked = resolveMarked(markup, ctx, block, true);
  const { externalLinks } = contentOptions(ctx);
  return finishNodes(
    htmlContent(marked, ctx, externalLinks === undefined ? {} : { externalLinks }),
    () => literalTemplate(ctx),
  );
}

/** Markup as nodes (a block with no single owner element: code), its addresses moved like any markup's. */
export function markupNodes(markup: string, ctx: ConvertCtx, block: WpBlock | undefined): JxNode[] {
  const marked = resolveMarked(markup, ctx, block, true);
  const { externalLinks } = contentOptions(ctx);
  return finishNodes(
    htmlNodes(marked, ctx, externalLinks === undefined ? {} : { externalLinks }),
    () => literalTemplate(ctx),
  );
}

/**
 * A block's text as the content of its element, with `before` and `after` markup (an icon) put around
 * it so the whole is converted as one piece. `undefined` when the block has neither text nor markup
 * around it.
 */
export function inlineContent(
  block: WpBlock,
  ctx: ConvertCtx,
  around: { before?: string; after?: string } = {},
): HtmlContent | undefined {
  const found = contentMarkup(block);
  const markup = `${around.before ?? ""}${found?.markup ?? ""}${around.after ?? ""}`;
  if (found === undefined && markup === "") return undefined;
  return markupContent(markup, ctx, block);
}

// ── SVG ──────────────────────────────────────────────────────────────────────────────────────────

/** The first `<svg>…</svg>` of a block's saved markup, as the page printed it. */
export function savedSvg(block: WpBlock): string | undefined {
  return /<svg\b[\s\S]*?<\/svg>/i.exec(block.innerHTML)?.[0];
}

/**
 * The SVG of an icon attribute (`iconIcon`, `buttonIcon`, `listIcon`: `{viewBox, paths: [null, {d}]}`),
 * for a block whose saved markup has none (a block copied into a component keeps its attributes and
 * loses its markup). Only the plain shapes the editor's icon libraries use: `d` paths with the
 * attributes they carry.
 */
export function iconSvg(icon: unknown): string | undefined {
  const i = record(icon);
  const viewBox = text(i?.viewBox);
  const paths = Array.isArray(i?.paths) ? (i.paths as unknown[]) : [];
  const parts: string[] = [];
  for (const raw of paths) {
    const p = record(raw);
    if (!p) continue;
    const attrs = Object.entries(p)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => `${k}="${escapeHtml(String(v)).replaceAll('"', "&quot;")}"`)
      .join(" ");
    if (attrs !== "") parts.push(`<path ${attrs}></path>`);
  }
  if (viewBox === undefined || parts.length === 0) return undefined;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${escapeHtml(viewBox).replaceAll('"', "&quot;")}">${parts.join("")}</svg>`;
}

// ── Placeholders ─────────────────────────────────────────────────────────────────────────────────

/** A block's attributes as the JSON a placeholder carries them in: the dollar sign of a `${` is written `\u0024`, so it is never spelled out. */
export const dataAttrs = (attrs: Attrs): string =>
  JSON.stringify(attrs).replaceAll("${", "\\u0024{");

/**
 * The element a later stage replaces: `wp2jx-<what>`, with the block's name and attributes as data (the
 * same shape core/blocks.ts gives its own, so one emitter replaces both).
 */
export function placeholder(
  block: WpBlock,
  what: string,
  classes = "",
  attributes: Record<string, string> = {},
  children?: JxNode[],
): JxElement {
  const own = Object.keys(block.attrs).length > 0 ? { "data-attrs": dataAttrs(block.attrs) } : {};
  return {
    tagName: `wp2jx-${what}`,
    ...(classes === "" ? {} : { className: classes }),
    attributes: { "data-block": block.name ?? "freeform", ...own, ...attributes },
    ...(children && children.length > 0 ? { children } : {}),
  };
}

// ── The root element ─────────────────────────────────────────────────────────────────────────────

export interface RootSpec {
  /** The tag when the block's saved markup names none. */
  tag?: string;
  /** The tag whatever the saved markup says. */
  forceTag?: string;
  /** Nested nodes, or the block's text, an icon, a figure grid: at most one of `children` and `content`. */
  children?: JxNode[];
  content?: HtmlContent;
  /** Attributes written on the element after the saved ones; `undefined` removes one. */
  attributes?: Record<string, AttrValue | undefined>;
  /** Classes added after the block's own. */
  classes?: readonly string[];
  /** Style merged over the block's own. */
  style?: JxStyle;
  /** `none`: the converter handles the block's link itself (a gallery's images). */
  link?: "block" | "none";
}

export interface Built {
  /** Outermost first: the wrappers a lightbox adds, then the element. Empty when the block is not shown. */
  nodes: JxNode[];
  /** The styled element: the block's own. */
  element: JxElement;
}

/** The scope Jx gives an element whose first class is shared: `htmlToNodes`'s own, so equal styles share a rule. */
const scopeOf = (style: unknown): string =>
  `jx-${createHash("sha1").update(JSON.stringify(style)).digest("hex").slice(0, 10)}`;

/** A scope class `scopeOf` made: the one first class that is already unique to its declarations. */
const HASH_SCOPE = /^jx-[0-9a-f]{10}$/;

/**
 * A class name that is also a CSS identifier (the test the style module reports `style.no-scope` by). Jx
 * writes an element's style to `.` + its first class without escaping it, so a classID like `1abc`,
 * `a.b` or `a{b}c` makes a rule that is invalid or matches another element, and the style is lost with
 * no error: such an element is scoped to a generated class instead, as a shared structural class is.
 */
const IDENTIFIER = /^-?[_a-zA-Z][\w-]*$/;

/**
 * Put the class Jx writes the element's style to first. The classID is that when the block prints it;
 * anything else (a structural `cc-sct` every section shares) would receive the rule on every
 * element that has the class.
 */
function scoped(
  className: string,
  style: JxStyle,
  scopes: readonly (string | undefined)[],
): string {
  if (isEmptyStyle(style)) return className;
  const first = className.split(/\s+/)[0] ?? "";
  const mine =
    IDENTIFIER.test(first) &&
    scopes.some((s) => s !== undefined && s !== "" && (first === s || first.startsWith(`${s}-`)));
  if (mine) return className;
  // A class that is not an identifier may hold a template's start (`${x}`), which a class list must never carry (docs/bindings.md).
  const names = className
    .split(/\s+/)
    .filter((name) => !name.includes("${"))
    .join(" ");
  return joinClass(scopeOf(style), names);
}

/** The attributes of a saved element, addresses moved and the runtime-only ones dropped. */
function savedAttributes(
  ctx: ConvertCtx,
  shape: ElementShape | undefined,
): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const [name, value] of Object.entries(shape?.attributes ?? {})) {
    // The browser builds these two from the file; Jx regenerates them. `data-cc-comp` is a class token the component runtime reads.
    if (name === "srcset" || name === "sizes" || name === "data-cc-comp") continue;
    out[name] = ADDRESS_ATTRIBUTES.has(name) ? rewriteAddress(ctx, value) : value;
  }
  return out;
}

function withoutUndefined(
  into: Record<string, AttrValue>,
  from: Record<string, AttrValue | undefined> | undefined,
): void {
  for (const [name, value] of Object.entries(from ?? {})) {
    if (value === undefined) delete into[name];
    else into[name] = value;
  }
}

/** A saved element as a node: the link wrapper of an image, the inner `div` of a section. */
export function shapeElement(
  ctx: ConvertCtx,
  shape: ElementShape,
  extra: { attributes?: Record<string, AttrValue>; children?: JxNode[]; block?: WpBlock } = {},
): JxElement {
  const attributes = { ...savedAttributes(ctx, shape), ...extra.attributes };
  let style = mergeStyle(shape.style, shape.inlineStyle);
  // A rule the stylesheets give the element names a class of its own (`<classID>-wrapper`), which the saved tag puts first.
  const own = shape.style !== undefined && !isEmptyStyle(shape.style);
  let className = scoped(shape.className, style, own ? [shape.className.split(/\s+/)[0]] : []);
  if (extra.block) {
    const moved = moveDescendantRules(ctx, extra.block, className, style);
    className = moved.className;
    style = moved.style;
  }
  return {
    tagName: shape.tag,
    ...(className === "" ? {} : { className }),
    ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
    ...(isEmptyStyle(style) ? {} : { style }),
    ...(extra.children && extra.children.length > 0 ? { children: extra.children } : {}),
  };
}

/**
 * Whether a nested style key cannot be written as a Markdown directive attribute. The attribute name is
 * `style.<key>.<property>`, and the directive syntax reads only letters, digits, `_`, `:`, `.`, `@` and `-`
 * in it (measured against `@jxsuite/parser`): `:hover`, `::before`, `.foo` and `@--md` survive; `&`, a space,
 * a parenthesis or a bracket (`&:hover`, `& a`, `&[hidden]`, `:is(a)`, `[data-x]`, `@(min-width: 1px)`) do not.
 */
const unsafeKey = (key: string): boolean => !/^[\w:.@-]+$/.test(key);

/** The selector of a nested key, written out for an element whose own style is scoped to `base` (a selector such as `.card`). */
function selectorOf(base: string, key: string): string {
  if (key.startsWith("&")) return `${base}${key.slice(1)}`;
  if (/^[:.[]/.test(key)) return `${base}${key}`;
  return `${base} ${key}`;
}

/** A rule taken out of an element's style: `key` is the nested key it was under, none for an at-rule block that is itself the rule of the element. */
interface MovedRule {
  key?: string;
  style: JxStyle;
}

/**
 * Take the rules a Markdown entry cannot hold out of a style: every nested key the directive syntax cannot
 * spell ({@link unsafeKey}), whether it is in the style itself or in one of its at-rule blocks (`@--md`).
 */
function splitDescendantRules(style: JxStyle): { kept: JxStyle; moved: MovedRule[] } {
  const kept: JxStyle = {};
  const moved: MovedRule[] = [];
  const isBlock = (v: unknown): v is JxStyle =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  for (const [key, value] of Object.entries(style)) {
    if (isBlock(value) && key.startsWith("@") && unsafeKey(key)) {
      moved.push({ style: { [key]: value } });
    } else if (isBlock(value) && unsafeKey(key) && !key.startsWith("@")) {
      moved.push({ key, style: value });
    } else if (isBlock(value) && key.startsWith("@")) {
      const inner: JxStyle = {};
      for (const [k, v] of Object.entries(value)) {
        if (isBlock(v) && unsafeKey(k)) moved.push({ key: k, style: { [key]: v } });
        else inner[k] = v;
      }
      if (Object.keys(inner).length > 0) kept[key] = inner;
    } else {
      kept[key] = value;
    }
  }
  return { kept, moved };
}

/**
 * The rules a Markdown entry cannot hold become rules of the PROJECT, and a project's rules are global:
 * classIDs repeat across posts with different declarations (a duplicated page keeps its block ids), so
 * `.gallery-c791a5b .cc-gallery` from one entry would be the same selector as another entry's with other
 * declarations, and whichever the project style held last would apply to both. The selector therefore
 * names the declarations as well as the block: the element carries a second class, `jx-<hash of what
 * was moved>`, and the rules are written for `.<classID>:where(.jx-<hash>)`. `:where` adds no
 * specificity, so the rule still weighs what `.<classID> a` weighed against a global class's rules, and
 * two entries whose rules are equal still write one rule. An element whose first class is already a
 * `jx-<hash>` scope (a shared structural class would otherwise have received its rules) is unique
 * already and takes none.
 */
function moveDescendantRules(
  ctx: ConvertCtx,
  block: WpBlock,
  className: string,
  style: JxStyle,
): { className: string; style: JxStyle } {
  const classes = className.split(/\s+/).filter(Boolean);
  const first = classes[0] ?? "";
  if (targetOf(ctx) !== "markdown" || first === "") return { className, style };
  const { kept, moved } = splitDescendantRules(style);
  if (moved.length === 0) return { className, style };
  if (!ctx.hoist) {
    // Nowhere to put them: they stay, where a Markdown serializer cannot write them, and the loss is said.
    say(
      ctx,
      block,
      "block.hoist-unavailable",
      "warn",
      "This Markdown entry's block has descendant style rules and this conversion has nowhere to hoist them: the entry cannot hold them.",
      { detail: "markdown-descendants" },
    );
    return { className, style };
  }
  let base = `.${first}`;
  let out = className;
  if (!HASH_SCOPE.test(first)) {
    const mark = scopeOf(
      moved
        .map((r) => [r.key ?? null, r.style])
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    );
    base = `.${first}:where(.${mark})`;
    out = joinClass(first, mark, ...classes.slice(1));
  }
  const merged = new Map<string, JxStyle>();
  for (const rule of moved) {
    const selector = rule.key === undefined ? base : selectorOf(base, rule.key);
    merged.set(selector, mergeStyle(merged.get(selector), rule.style));
  }
  for (const [selector, rule] of merged) hoistRule(ctx, block, { selector, style: rule });
  return { className: out, style: kept };
}

/** `display: none` at the breakpoints a `device` condition hides the block on. */
function deviceStyle(deviceHide: Record<string, true> | undefined): JxStyle {
  const out: JxStyle = {};
  for (const key of Object.keys(deviceHide ?? {})) out[`@--${key}`] = { display: "none" };
  return out;
}

/**
 * The text of a `<p>` that is one binding: the value of a field that may hold paragraphs of its own
 * (a rich-text field saves `<p>…</p>`). Printed inside a `<p>` the browser closes the box at the
 * first inner paragraph and the closing tag at the end then opens an empty paragraph of its own
 * (the page gets a stray box with its margin, and a flex parent a gap); the plugin's markup has the
 * paragraphs and no stray one, so the value gives up its last `</p>` to the box that holds it.
 * A value that is not paragraphs is printed as it is. (Measured on the live pages of the second pilot,
 * whose plugin is 1.6.0 though its data format says 1.4.7: the page has the paragraphs and no stray one.)
 */
export function paragraphValue(html: string): string {
  const m = /^\$\{([\s\S]*)\}$/.exec(html);
  if (!m || m[1]!.includes("${")) return html;
  return `\${((h) => /^\\s*<p[\\s>]/i.test(h) ? h.replace(/<\\/p>\\s*$/i, '') : h)(${m[1]})}`;
}

/**
 * The element a block becomes, from what the converter says is inside it. See the module comment for
 * how the five sources are combined.
 */
export function assemble(env: BlockEnv, spec: RootSpec = {}): Built {
  const { ctx, styling, visibility } = env;
  const link = spec.link === "none" ? undefined : env.link;
  const trigger = triggerOf(link?.action);
  const anchored = link?.anchor === "self" || link?.anchor === "button" ? link : undefined;

  let tag = spec.forceTag ?? styling.tag ?? spec.tag ?? (anchored?.anchor === "self" ? "a" : "div");
  const attributes = savedAttributes(ctx, styling.element);
  withoutUndefined(attributes, styling.attributes);
  if (styling.id !== undefined) attributes.id = styling.id;
  if (anchored) {
    if (trigger) {
      tag = trigger.tag;
      withoutUndefined(attributes, trigger.attributes);
      delete attributes.href;
      delete attributes.target;
      delete attributes.rel;
    } else if (anchored.anchor === "self") {
      // A destination nothing resolved leaves the anchor without an `href` rather than one that points at the page itself.
      delete attributes.href;
      withoutUndefined(attributes, linkAttributes(anchored));
    } else {
      const { href: _href, ...rest } = linkAttributes(anchored);
      withoutUndefined(attributes, rest);
    }
  }
  if (visibility.hidden !== undefined) attributes.hidden = visibility.hidden;
  if (styling.boundStyle !== undefined) attributes.style = styling.boundStyle;
  withoutUndefined(attributes, spec.attributes);

  let style = mergeStyle(styling.style, spec.style);
  if (visibility.hiddenStyle) style = mergeStyle(style, visibility.hiddenStyle);
  style = mergeStyle(style, deviceStyle(visibility.deviceHide));
  let className = scoped(joinClass(styling.className, ...(spec.classes ?? [])), style, [
    styling.classID,
  ]);
  const moved = moveDescendantRules(ctx, env.block, className, style);
  className = moved.className;
  style = moved.style;

  // The anchor inside a block (a heading's link) holds what the block holds.
  const nested = spec.content?.children ?? spec.children;
  let content: Pick<JxElement, "textContent" | "children" | "innerHTML"> = {
    ...(spec.content?.textContent === undefined ? {} : { textContent: spec.content.textContent }),
    ...(spec.content?.innerHTML === undefined
      ? {}
      : {
          // A component's own properties are its client template's to read: that one is left as it is.
          innerHTML:
            tag === "p" && ctx.props === undefined
              ? paragraphValue(spec.content.innerHTML)
              : spec.content.innerHTML,
        }),
    ...(nested === undefined || nested.length === 0 ? {} : { children: nested }),
  };
  if (link?.anchor === "inner" && Object.keys(content).length > 0) {
    const inner = trigger
      ? { tagName: trigger.tag, attributes: trigger.attributes }
      : { tagName: "a", attributes: linkAttributes(link) };
    content = { children: [{ ...inner, ...content } as JxElement] };
  }

  const element: JxElement = {
    tagName: tag,
    ...(className === "" ? {} : { className }),
    ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
    ...(isEmptyStyle(style) ? {} : { style }),
    ...content,
  };

  // What the saved markup puts around the element, outermost first; a link the block wraps around
  // an image is the one wrapper that may not be there to adopt.
  const wrappers = [...styling.wrappers];
  const outer = link?.anchor === "outer" ? link : undefined;
  const nodes: JxNode[] = [];
  let current: JxElement = element;
  const linkIndex = outer ? wrappers.findIndex((w) => w.tag === "a") : -1;
  if (outer && linkIndex === -1) {
    current = {
      tagName: trigger?.tag ?? "a",
      attributes: trigger ? trigger.attributes : linkAttributes(outer),
      children: [element],
    };
  }
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const shape = wrappers[i] as ElementShape;
    const isLink = i === linkIndex && outer !== undefined;
    const attrs = isLink ? (trigger ? trigger.attributes : linkAttributes(outer)) : {};
    current = shapeElement(ctx, isLink && trigger ? { ...shape, tag: trigger.tag } : shape, {
      attributes: attrs,
      children: [current],
      block: env.block,
    });
  }
  nodes.push(current);
  return { nodes, element };
}

/**
 * The whole job for a block whose root needs nothing else: ask the modules, let `make` say what is
 * inside (it is only called for a block that is shown, with everything the modules said), and build
 * the root. Returns no nodes for a block that is never shown.
 */
export function buildBlock(
  block: WpBlock,
  ctx: ConvertCtx,
  make: (env: BlockEnv) => RootSpec,
  opts: PrepareOptions = {},
): JxNode[] {
  const env = prepare(block, ctx, opts);
  if (!env) return [];
  return assemble(env, make(env)).nodes;
}
