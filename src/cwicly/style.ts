/**
 * What a Cwicly block's root element needs in Jx: its class list, its style and its attributes.
 *
 * `styleBlock(block, ctx)` is the one call every block converter makes for the element a block
 * becomes. It answers four questions, each from the source that actually decides it:
 *
 * 1. **className** is the class attribute of the block's SAVED opening tag with its class tokens
 *    resolved. The tokens are Cwicly's (`render.php`, `cc_parser` and `cc_get_dyn`): `{class}` is the
 *    classID, `{gcl}` the names of the block's global classes, `{acl}` / `{sacl}` its additional
 *    classes and their wrappers, `{cs-index}` / `{aclv}` / `{gclv}` the classes of the selected
 *    component variants, `{cccomp}` the classIDs of the component instances around it,
 *    `{darkmode_force=…}` the site's dark or light classes. `{currentpageclass=…}` is "this link points
 *    at the page being shown" and has no static value, so it is dropped (and reported). Every other
 *    token is the dynamic-data module's: `opts.resolveTokens` is how it is called, and a token nobody
 *    resolves is dropped with a report, because a literal `{…}` in a class list is never a class.
 *    The real saved tags use `{gcl}` (933), `{currentpageclass}` (308), `{cs-index}` (17) and
 *    `{class}` (4); the others are ported from the PHP and exercised by hand-made blocks.
 *
 *    The classID is FIRST. Jx writes an element's own `style` to the selector of the FIRST word of
 *    its className, so the unique classID is what keeps the block's rules on `.classID` (Cwicly's own
 *    selector, and the same specificity) and off every shared class that follows it. The saved tag
 *    already puts it first (`${classID}{cs-index}…`); when a block has a style and the tag printed no
 *    classID, it is put first anyway (`style.classid-not-printed`), because a style written to
 *    `.global-class` would leak onto every element that has it.
 *
 *    Why a classID is sometimes not in the root's class list (the editor's `isStyling` rule, module
 *    25407 of the plugin's `build/index.js`): the editor prints it only when the block is styled
 *    (`isStyling`), or `forceShowClass` is set, or the site's `removeIDsClasses` optimisation is off.
 *    A block with no style of its own prints `{gcl} cc-sct` and nothing else, so it has no rule to
 *    lose: 357 real blocks print none, and one of them has a rule (a page edited after its stylesheet
 *    was written). Two shapes put it on an element that is not the root (10 real blocks): a link-wrapped image is `<a class="cc-lightbox"><img
 *    class="<classID> …"/></a>`, and a modal is a shell of `cc-mdl` divs around the element that
 *    carries it. `styleBlock` finds the element that carries the classID (`styledDepth`), styles THAT
 *    one, and hands the elements above it back in `wrappers`. A `cwicly/component` instance has no
 *    element at all (its saved `<div></div>` is ignored by the server, which prints only the
 *    component's own blocks), so it styles nothing; a block that is styled but has an empty classID
 *    (3 real headings) has nothing to scope to and `style.no-classid` says so.
 *
 *    `editorClassTokens` is the same class list computed from the attributes, a port of the editor's
 *    own builder. It agrees with the saved tag of every one of the 5,929 real blocks that has one,
 *    and is the answer for a block whose markup carries no tag.
 *
 * 2. **style** is the block's own rule from `ctx.css` (the stylesheets of the block's subject),
 *    cloned, because the index shares its objects. Beyond the rule at `.classID`, the rules that
 *    name the classID in a compound of their own are folded in as nested keys that keep their
 *    specificity: `.classID.cs-<variant>` (a component variant) becomes `"&.cs-<variant>"`, and
 *    `.ancestor .classID` becomes `"&:is(.ancestor *)"`. A key that does not start with `&` cannot
 *    say "the ancestor of this element": Jx splices only a key that starts with `&`, appends one that
 *    starts with `:`, `.` or `[`, and treats the rest as a descendant, so the ancestor goes inside an
 *    `:is()` on the element itself (verified by a real build in the tests). A rule that names the
 *    classID only inside a functional selector (`:where(.nav .x)`) cannot be a key at all: it comes
 *    back in `hoisted`, whole, for the project's `style`, which emits selectors unscoped.
 *
 *    `customCSS` is never in the stylesheet files: `scss.ts` reproduces what `render.php` prints
 *    (which attribute, which words replaced), compiles the SCSS subset a block's author may have
 *    written, and the result is read like any stylesheet and merged the same way. At-rules
 *    (`@keyframes`) and rules for other classes are `hoisted`. The saved inline `style` of the
 *    element is merged last: it won on the page and wins here, within the rule. A declaration of it
 *    whose value is a `${…}` binding (an entry template's hero image, a loop's avatar) is per element
 *    and per render, so it is NOT merged into the shared class rule: it comes back as `boundStyle`,
 *    CSS text for the element's `style` attribute. One that cannot be read is `style.dropped`.
 *
 *    The index has a rule for a block unless its stylesheet is missing from the source (436 real
 *    blocks in 23 subjects whose file the live pages never loaded, so the fixtures lack it) or
 *    does not cover the block (135 real blocks of files that exist but lack them). The fixtures are
 *    not one snapshot: the database rows and the stylesheets were exported at different moments, and
 *    for some fineline subjects (post 1716) the file is the NEWER of the two, so this is drift
 *    between two exports, not attributes edited after their CSS was written. A block that is
 *    styled (`isStyling`) with no rule gets its style from its own
 *    attributes (`attr-style.ts`), and that is `style.fallback`; an unstyled one gets none. The
 *    index's per-class trees and its file-order layers say the same about a block's own selector
 *    (a classID is declared in one file: checked on all 5,929 blocks), so the tree is what is used.
 *
 * 3. **attributes** are what the block's author added: `htmlAttributes[]` (the saved tag already
 *    carries them, tokens included; a hidden one is skipped, one the tag lacks falls back to its
 *    static value), and `title` for a tooltip (Cwicly's tooltip is a script; its text survives as
 *    the native one). `element` is the styled element as saved, every attribute included, for the
 *    block's own converter (`src`, `href`, `data-ccgallery`…). The `id` the saved tag prints (a
 *    query, a nav, a block with `forceShowID`) is returned as `id` and is NOT in `attributes`: Jx
 *    writes a style to `#id` when the element has one, which would give the block's rules a
 *    specificity of (1,0,0) and move them off `.classID`. `anchor` is the editor's layer name and is
 *    never printed, so it is not an HTML anchor and nothing here emits it.
 *
 * 4. **dropped** features (`animateOnScroll*`, `interactions`, tilt, scroll direction, a tooltip's
 *    options) have no static equivalent: each is reported as `style.dropped` with the block's
 *    location and never emitted.
 *
 * Where the styled element sits: `wrappers` are the elements it is INSIDE (a link around an image,
 * a modal's shell and container), `inner` the ones inside it, and `beside` every other saved element
 * (a modal's close anchor, the container's sibling), each with its depth. A relative style's `class`
 * selector in the attribute fallback holds the uniqueID of the block it targets, which `opts.blockClasses`,
 * the block's descendants and the site's posts resolve to a classID (`style.selector-unsupported`
 * when none does). A classID Jx cannot use as a scope selector unescaped (a dot, a colon, a digit
 * first) is `style.no-scope`.
 *
 * Report codes (all located at the subject, with the block's name and classID in `data`):
 * `class.dangling-global`, `class.token-dropped`, `class.current-page`, `style.classid-not-printed`,
 * `style.no-classid`, `style.no-scope`, `style.fallback`, `style.attr-unsupported`,
 * `style.palette-unresolved`, `style.hoisted`, `style.selector-unsupported`, `style.scss-compiled`,
 * `style.scss-unsupported`, `style.blockid-not-printed`, `style.token-unresolved`, `style.dropped`,
 * and `css.artifact` for what the reader found wrong in a block's custom CSS.
 */
import { parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import selectorParser from "postcss-selector-parser";
import { cssTextToStyle, isEmptyStyle, mergeStyle } from "../jx-util.ts";
import { attrStyleDetailed } from "./attr-style.ts";
import { parseCwiclyCss } from "./css.ts";
import { compileScss, customCssSource, expandCustomCssTokens, usesScss } from "./scss.ts";
import type { ConvertCtx, JxStyle, WpBlock } from "../types.ts";

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];

// ── Public shapes ────────────────────────────────────────────────────────────────────────────────

export interface StyleOptions {
  /**
   * Resolves the render-time tokens that are not about classes (`{imagealt=785}`, `{title}`,
   * `{bgfeaturedimage}`) in text this module passes through: the attributes of the saved tag, the
   * inline style, the values of `htmlAttributes`. It gets the text as saved, one attribute value (or
   * one inline style) per call, and is where a value's literal `${` is dealt with: pass
   * `(text) => resolveTokens(text, ctx, block, { where: "attribute" })` from `cwicly/tokens.ts`.
   * Without it those tokens stay as written, and a token in a value this module emits into a style
   * is reported as `style.token-unresolved` and dropped.
   */
  resolveTokens?: (text: string) => string;
  /**
   * The component variants selected for the instance that is being converted (the ids in
   * `cs-<id>`), which is what `{cs-index}`, `{aclv}` and `{gclv}` print. Absent, they print
   * nothing, `BlockStyling.variantClasses` says the element needs them, and the rules of every
   * variant are in `style` under `"&.cs-<id>"` keys, ready for the class to switch them on.
   */
  variants?: readonly string[];
  /**
   * uniqueID → classID of the blocks of the subject. A relative style's `class` selector holds the
   * uniqueID of the block it targets (the editor swaps in that block's classID when it compiles),
   * and the converter has the tree. Without an entry the block's own descendants are searched, then
   * every post of the site (a duplicated page keeps its blocks' ids, so the target is often in
   * another post), and an id nobody has is reported as `style.selector-unsupported`.
   */
  blockClasses?: ReadonlyMap<string, string>;
  /** The classIDs of the component instances around the block, outermost first: what `{cccomp}` prints. */
  componentClasses?: readonly string[];
  /**
   * The class list the element gets from a connected class property (`{component=class=<ref>}`),
   * as a Jx expression or literal text. By default it is `${state.<key>}` through `ctx.props`.
   */
  connectedClass?: (ref: string) => string | undefined;
}

/** One element of the block's saved markup, with its class tokens resolved. */
export interface ElementShape {
  tag: string;
  className: string;
  /** Every attribute except `class`, `style` and `id`, as saved (tokens passed through `resolveTokens`). */
  attributes: Record<string, string>;
  /** The element's `id`, with `{idadd}` removed; undefined when it has none. */
  id?: string;
  /** Its inline `style`, as a style object: the declarations whose value is known (no `${…}` binding in them). */
  inlineStyle?: JxStyle;
  /**
   * Its inline declarations whose value is a `${…}` binding (an entry template's hero image,
   * `--background-image:url(${state.entry.data.featuredImage?.src ?? ''})`, or a comment's avatar in
   * a loop), as CSS text with the bindings intact. They are per element and per render, so they are not merged
   * into `style` (a class rule is shared by every element that has the class): the converter puts the
   * text on the element, as its `style` attribute.
   */
  boundStyle?: string;
  /**
   * The rule the stylesheets (or the attributes) give THIS element, when it is one of the block's own
   * extra elements rather than the styled one: the old section layout's `<div class="<classID>-wrapper
   * cc-wrapper">`, whose layout lives on `.<classID>-wrapper`. Its class is first in `className`.
   */
  style?: JxStyle;
}

export interface BlockStyling {
  /** The class list of the element that carries the classID, classID first. Empty when the block has no element. */
  className: string;
  /**
   * What goes in the element's `style`: its rules, nested keys and breakpoints included, and its
   * saved inline style (declarations of `inlineStyle` that name no unresolved token), which win as
   * they did on the page.
   */
  style: JxStyle;
  /** Author-added attributes (`htmlAttributes`, a tooltip's `title`), never `class`, `style` or `id`. */
  attributes: Record<string, string>;
  /** The block's classID; undefined when it has none. */
  classID?: string;
  /** The `id` the saved tag prints, resolved. Not in `attributes`: see the module comment. */
  id?: string;
  /** The tag the saved markup gives the styled element (`section`, `a`, `h2`…); undefined when the block has no tag. */
  tag?: string;
  /**
   * The styled element's inline declarations that are `${…}` bindings, as CSS text for its `style`
   * attribute (`element.boundStyle`); absent when there are none. `style` never holds them.
   */
  boundStyle?: string;
  /**
   * How many saved elements the classID-carrying one sits inside: 0 is the root, -1 when no element
   * carries it (the root is used).
   */
  styledDepth: number;
  /**
   * The saved elements the styled one sits inside, outermost first: link wrappers, modal shells. Only
   * its ancestors: an element that comes before it in the markup without containing it is in `beside`.
   * A modal shell's wrappers carry the rules the stylesheets give `modal-<classID>`, which name the
   * shell and its container, with that class first in their `className`.
   */
  wrappers: ElementShape[];
  /**
   * The saved elements that are neither the styled one, nor inside it, nor around it, in document
   * order (a modal's close anchor, which is the container's sibling). `depth` is how many elements
   * each sits inside, so it is a child of the nearest earlier element one level up (`wrappers[depth -
   * 1]` for the first of them); `after` says it follows the styled element.
   */
  beside: (ElementShape & { depth: number; after: boolean })[];
  /** The styled element as saved: every attribute the block's markup gives it, and its inline style. */
  element?: ElementShape;
  /**
   * The saved elements inside the styled one, in document order, each with the rule of its own when
   * the block's classID names it (`<classID>-wrapper`). Static content the block holds (a list's
   * `<ul>`, an icon's `<svg>`) is in here too: the block's own converter decides what to do with it.
   */
  inner: ElementShape[];
  /** Where `style` came from: the stylesheet index, the block's attributes, or nowhere (the block has none). */
  source: "index" | "attributes" | "none";
  /**
   * The saved class list asks for the instance's variant classes (`{cs-index}`, `{aclv}`,
   * `{gclv}`) and `opts.variants` was not given: the element must receive `cs-<id>` classes at
   * run time.
   */
  variantClasses: boolean;
  /** The variant ids this block has rules for (`"&.cs-<id>"` keys of `style`). */
  variants: string[];
  /**
   * Rules `customCSS` and the stylesheets give that cannot live in an element's `style`: at-rules
   * (`@keyframes`, with the at-rule head as `selector`) and selectors that do not name the block,
   * or name it where a nested key cannot say so (`:where(.<classID> .x)`). The converter hoists them
   * to the page or the project, in this order.
   */
  hoisted: { selector: string; style: JxStyle }[];
}

// ── The saved markup ─────────────────────────────────────────────────────────────────────────────

/** One element of saved markup: tag name and attributes, entity-decoded. */
export interface SavedTag {
  tag: string;
  attrs: readonly (readonly [name: string, value: string])[];
  /** Index (in the list `savedTags` returns) of the element this one is inside; -1 for a top-level element. */
  parent: number;
}

const isElement = (node: P5Node): node is P5Element => "tagName" in node;

/**
 * The elements of a block's saved markup in document order, each with the element it sits in. The
 * markup has the block's own tags and whatever static content it holds (a list's `<ul>`), and nested
 * blocks are already cut out of it.
 */
export function savedTags(html: string): SavedTag[] {
  const out: SavedTag[] = [];
  const visit = (nodes: readonly P5Node[], parent: number): void => {
    for (const node of nodes) {
      if (!isElement(node)) continue;
      const index = out.push({
        tag: node.tagName,
        attrs: node.attrs.map((a) => [a.name, a.value] as const),
        parent,
      });
      visit(node.childNodes, index - 1);
    }
  };
  visit(parseFragment(html).childNodes, -1);
  return out;
}

const attrOf = (tag: SavedTag, name: string): string | undefined =>
  tag.attrs.find(([n]) => n === name)?.[1];

// ── Class tokens ─────────────────────────────────────────────────────────────────────────────────

/** Cwicly's own matcher (`cc_parser`): a brace pair that does not start a JSON string, up to the first `}`. */
const TOKEN = /\{(?!"|&quot;)([^{}]*)\}/g;

const SPLIT = /[ \t\n\f\r]+/;

/** `where` for the report: where the block was found. */
export function whereOf(ctx: ConvertCtx): string {
  return `${ctx.subject.kind}:${ctx.subject.id}`;
}

const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** `cwicly_classes_add`: the editor's name for an additional class that is not "linked" (a CSS class of its own). Read lazily, once per ctx. */
const classesAdd = new WeakMap<ConvertCtx["model"], Record<string, string>>();
function additionalClassNames(ctx: ConvertCtx): Record<string, string> {
  let names = classesAdd.get(ctx.model);
  if (names === undefined) {
    names = {};
    const raw = ctx.model.options.get("cwicly_classes_add");
    if (raw) {
      try {
        const parsed = recordOf(JSON.parse(raw));
        for (const [key, value] of Object.entries(parsed ?? {})) {
          if (typeof value === "string") names[key] = value;
        }
      } catch {
        // An option PHP could not decode adds no classes there either.
      }
    }
    classesAdd.set(ctx.model, names);
  }
  return names;
}

/** `Helpers::additional_classes`: the visible additional classes of a block, the linked ones by name and the others through `cwicly_classes_add`. */
function additionalClasses(attrs: Record<string, unknown>, ctx: ConvertCtx): string[] {
  const names = additionalClassNames(ctx);
  const out: string[] = [];
  for (const entry of listOf(attrs.additionalClass)) {
    const item = recordOf(entry);
    if (!item || item.visibility) continue;
    const value = stringOf(item.value);
    if (item.isLinked) {
      if (value) out.push(value);
    } else if (value && names[value]) {
      out.push(names[value]);
    }
  }
  return out;
}

interface TokenEnv {
  block: WpBlock;
  ctx: ConvertCtx;
  opts: StyleOptions;
  /** Findings of this resolution, in order; the caller decides whether they are reported. */
  findings: {
    code: string;
    severity: "info" | "warn";
    message: string;
    data: Record<string, unknown>;
  }[];
}

/** `Helpers::global_classes`, with the dangling ids kept apart: the live site prints no class for them. */
function globalClassNames(ids: readonly unknown[], env: TokenEnv): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const name = env.ctx.cwicly.globalClassNames.get(id);
    if (name) {
      out.push(name);
    } else {
      env.findings.push({
        code: "class.dangling-global",
        severity: "warn",
        message: `global class ${id} no longer exists; the live page prints no class for it`,
        data: { globalClass: id },
      });
    }
  }
  return out;
}

/** The ref a `!ref=<id>!` value names (the editor's `z6`). */
const refOf = (value: string): string => /!ref=([\w-]+)!/.exec(value)?.[1] ?? "";

/**
 * What one class token prints, per `cc_get_dyn`. Returns `undefined` for a token this module does
 * not own, so the caller can offer it to the dynamic-data module.
 */
function classToken(name: string, args: string[], env: TokenEnv): string | undefined {
  const { block, ctx, opts } = env;
  const attrs = block.attrs;
  switch (name) {
    case "class":
      return stringOf(attrs.classID);
    case "acl":
      return additionalClasses(attrs, ctx).join(" ");
    case "sacl": {
      const names = additionalClasses(attrs, ctx);
      return names.map((n) => `${n}-wrapper`).join(" ");
    }
    case "gcl":
      return globalClassNames(listOf(attrs.globalClass), env).join(" ");
    case "idadd":
    case "loop-id":
      return "";
    case "cs-index": {
      const ids = opts.variants ?? [];
      return ids.map((id) => ` cs-${id}`).join("");
    }
    case "aclv":
    case "gclv": {
      const ids = opts.variants ?? [];
      const source = recordOf(
        name === "aclv" ? attrs.additionalClassesVariantsR : attrs.globalClassVariant,
      );
      const picked: string[] = [];
      for (const id of ids) {
        const value = source?.[id];
        if (name === "aclv") {
          if (Array.isArray(value))
            picked.push(...value.filter((v): v is string => typeof v === "string"));
          else if (typeof value === "string" && value) picked.push(value);
        } else if (Array.isArray(value)) {
          picked.push(...globalClassNames(value, env));
        }
      }
      const joined = [...new Set(picked)].join(" ");
      if (!joined) return "";
      return args[0] === "true" ? joined : ` ${joined}`;
    }
    case "darkmode_force": {
      const mode = args[0];
      if (mode === "dark") return ctx.cwicly.darkMode.darkClasses.join(" ");
      if (mode === "light") return ctx.cwicly.darkMode.lightClasses.join(" ");
      return "";
    }
    case "currentpageclass":
      env.findings.push({
        code: "class.current-page",
        severity: "info",
        message: `the class that marks a link to the current page ({currentpageclass=${args.join("=")}}) has no static value and is dropped`,
        data: { link: args.slice(args[0] === "static" || args[0] === "dynamic" ? 1 : 0).join("=") },
      });
      return "";
    case "component": {
      if (args[0] !== "class" || !args[1]) return undefined;
      const ref = args[1];
      const given = opts.connectedClass?.(ref);
      if (given !== undefined) return given;
      const key = ctx.props?.get(ref);
      return key === undefined ? undefined : `\${state.${key}}`;
    }
    case "cccomp":
      return (opts.componentClasses ?? []).join("-");
    default:
      return undefined;
  }
}

/**
 * Resolve every `{…}` in a class attribute and return the class names, in order, duplicates kept
 * (the caller decides what to do with them). A token this module does not own goes to
 * `opts.resolveTokens`; one that nobody resolves is dropped.
 */
function resolveClassAttribute(raw: string, env: TokenEnv): string[] {
  const text = raw.replace(TOKEN, (whole: string, inner: string) => {
    if (inner === "") return whole;
    const parts = inner.includes("=") && inner.indexOf("=") > 0 ? inner.split("=") : [inner];
    const [name = "", ...args] = parts;
    const own = classToken(name, args, env);
    if (own !== undefined) return own;
    const given = env.opts.resolveTokens?.(whole);
    if (given !== undefined && given !== whole) return given;
    env.findings.push({
      code: "class.token-dropped",
      severity: "info",
      message: `the class token ${whole} has no static value and is dropped`,
      data: { token: whole },
    });
    return "";
  });
  return text.split(SPLIT).filter((name) => name !== "");
}

// ── The editor's own class list ──────────────────────────────────────────────────────────────────

/** The `cc-*` class a block type gets when the site has Cwicly's built-in defaults switched off. */
const DEFAULT_CLASS: Readonly<Record<string, string>> = {
  button: "cc-btn",
  icon: "cc-icn",
  svg: "cc-svg",
  image: "cc-img",
  accordion: "cc-acd",
  accordioncontent: "cc-acdc",
  maps: "cc-maps",
  tabcontent: "cc-tbc",
  video: "cc-vid",
  column: "cc-clmn",
};

/** The `cc-*` class of a block type, whatever the site's options. */
const STRUCTURAL_CLASS: Readonly<Record<string, string>> = {
  section: "cc-sct",
  container: "cc-cntr",
  sliderchild: "cc-sldc",
  nav: "cc-nav",
  navitems: "cc-nav-items",
  navlink: "cc-nav-link",
  navdropdown: "cc-nav-dropdown",
};

/** `{currentpageclass=…}` as the editor writes it for a link wrapper that points at a page. */
function currentPageToken(attrs: Record<string, unknown>): string | undefined {
  if (!attrs.linkWrapperActive || attrs.linkWrapperType !== "url") return undefined;
  if (attrs.linkWrapperSourceType === "static") {
    const object = recordOf(attrs.linkWrapperStaticObject);
    if (object) {
      return `{currentpageclass=${stringOf(object.id)}=${stringOf(object.type)}=${stringOf(object.kind)}}`;
    }
    if (attrs.linkWrapperUrl) return `{currentpageclass=static=${stringOf(attrs.linkWrapperUrl)}}`;
  } else if (attrs.linkWrapperSourceType === "dynamic") {
    const source = stringOf(attrs.linkWrapperSourceDynamic);
    if (source === "homeurl" || source === "siteurl" || source === "posturl") {
      return `{currentpageclass=dynamic=${source}}`;
    }
  }
  return undefined;
}

/**
 * The class attribute the plugin's editor writes into a block's saved markup, computed from the
 * block's attributes (module 25407 of `build/index.js`; the options it reads are `cwicly_info`'s,
 * which `ctx.cwicly.optimise` mirrors). Tokens are left unresolved, as the editor leaves them.
 * `name` is the block type without its namespace (`section`, `navlink`).
 */
export function editorClassTokens(
  attrs: Record<string, unknown>,
  name: string,
  ctx: ConvertCtx,
): string[] {
  const out: string[] = [];
  const classID = stringOf(attrs.classID);
  const optimise = ctx.cwicly.optimise;
  const aclv = Boolean(attrs.additionalClassVariant);
  const gclv = Boolean(attrs.globalClassVariant);
  if (classID && (attrs.isStyling || !optimise.removeIDsClasses || attrs.forceShowClass)) {
    out.push(
      `${classID}${attrs.isComponentChild ? "{cs-index}" : ""}${aclv ? "{aclv}" : ""}${gclv ? "{gclv}" : ""}`,
    );
  } else if (gclv && aclv) {
    out.push("{aclv=true}{gclv}");
  } else if (gclv) {
    out.push("{gclv=true}");
  } else if (aclv) {
    out.push("{aclv=true}");
  }
  if (attrs.align) out.push(`align${stringOf(attrs.align)}`);
  if (attrs.additionalClassesR) out.push(stringOf(attrs.additionalClassesR));
  if (listOf(attrs.globalClass).length > 0) out.push("{gcl}");
  if (attrs.fontGlobalStyleControl && attrs.fontGlobalStyle) {
    out.push(`cc-block-typo-font-${String(attrs.fontGlobalStyle)}`);
  }
  if (name !== "slider" && name !== "slide" && attrs.sliderAnimation)
    out.push(stringOf(attrs.sliderAnimation));
  if (name === "image" && attrs.imageAnimation) out.push(stringOf(attrs.imageAnimation));
  if (attrs.hoverAnimation) out.push(stringOf(attrs.hoverAnimation));
  if (name === "list") {
    const ref = stringOf(recordOf(recordOf(attrs.componentConnectors)?.iconActive)?.ref);
    if (ref) out.push(`{component=parameter=${ref}=listIconActive}`);
    else if (attrs.listIconActive) out.push("cc-icon-list");
  }
  if (name === "modal") out.push("cc-modaler");
  if (attrs.repeaterMasonry) out.push("cc-masonry");
  const dynamicLink = stringOf(attrs.linkWrapperSourceDynamic);
  if (dynamicLink === "commentreplyurl") out.push("comment-reply-link");
  if (dynamicLink === "removecartitemajax") out.push("remove remove_from_cart_button");
  const action =
    attrs.linkWrapperActive && attrs.linkWrapperType === "action"
      ? stringOf(attrs.linkWrapperAction)
      : "";
  if (name !== "heading" && action === "lightbox") out.push("cc-lightbox");
  if (attrs.formAction === "addtocart") out.push("{watc}");
  if (action === "addcartajax") out.push("cc-ajax-add-to-cart");
  if (action === "addcart") out.push("single_add_to_cart_button");
  if (action === "filter") out.push("{filterstatus}");
  if (name === "accordion") {
    if (attrs.accordionOpenComp) {
      out.push(`{component=parameter=${refOf(stringOf(attrs.accordionOpenComp))}=accordionopen}`);
    } else {
      out.push(attrs.accordionOpen ? "cc-accordion-active" : "cc-accordion-hidden");
    }
  }
  if (name === "tab") out.push("{tab_state}");
  if (name === "tabcontent") out.push("{tab_content_state}");
  const builtin = DEFAULT_CLASS[name];
  if (builtin && !optimise.cwiclyDefaults) out.push(builtin);
  const structural = STRUCTURAL_CLASS[name];
  if (structural) out.push(structural);
  if (attrs.darkModeForce) out.push(`{darkmode_force=${stringOf(attrs.darkModeForce)}}`);
  if (name === "gallery") {
    // `galleryType` has a default (`grid`), which a comment that omits it means.
    const type = stringOf(attrs.galleryType) || "grid";
    if (type === "masonry") out.push("cc-masonry");
    else if (type === "grid") out.push("cc-grid");
    else if (type.includes("!ref=")) out.push(`cc-{component=parameter=${refOf(type)}}`);
  }
  const connected = stringOf(recordOf(attrs.connectedClass)?.ref);
  if (connected) out.push(`{component=class=${connected}}`);
  const current = currentPageToken(attrs);
  if (current) out.push(current);
  const overlayGradient = recordOf(attrs.backgroundOverlayGradientSelected);
  const overlayColor = recordOf(attrs.backgroundOverlayColor);
  const gradientOn = Object.values(overlayGradient ?? {}).some(Boolean);
  const colourOn = Object.values(overlayColor ?? {}).some(Boolean) && !overlayGradient?.[0];
  if (gradientOn || colourOn) out.push("cc-ovrl");
  return out;
}

/**
 * The class list of a block computed from its attributes alone, tokens resolved: what the saved
 * tag says, without the saved tag. A cross-check for tests and the answer for a block whose
 * markup has no tag.
 */
export function editorClassNames(
  block: WpBlock,
  ctx: ConvertCtx,
  opts: StyleOptions = {},
): string[] {
  const name = (block.name ?? "").replace(/^cwicly\//, "");
  const env: TokenEnv = { block, ctx, opts, findings: [] };
  return resolveClassAttribute(editorClassTokens(block.attrs, name, ctx).join(" "), env);
}

// ── Finding the styled element ───────────────────────────────────────────────────────────────────

/** The saved elements of a block, the one that carries the classID found, and what is above it. */
interface Located {
  tags: SavedTag[];
  /** Index into `tags` of the element that carries the classID; -1 when none does (the root is used). */
  styled: number;
  /** Index of the element the block's style goes on: `styled`, or the root when none carries the classID. */
  at: number;
  /** The elements the styled one sits inside, outermost first (indexes into `tags`). */
  ancestors: number[];
  /** The resolved class names of every tag. */
  classes: string[][];
  /** What resolving the classes of the styled element and the ones above it found. */
  findings: TokenEnv["findings"];
}

function locate(block: WpBlock, ctx: ConvertCtx, opts: StyleOptions): Located {
  const tags = savedTags(block.innerHTML);
  const classID = stringOf(block.attrs.classID);
  let styled = -1;
  if (classID) {
    for (const [index, tag] of tags.entries()) {
      const probe: TokenEnv = { block, ctx, opts, findings: [] };
      if (resolveClassAttribute(attrOf(tag, "class") ?? "", probe).includes(classID)) {
        styled = index;
        break;
      }
    }
  }
  // No element carries the classID: the root is the block's element, and what is above it is nothing.
  const at = styled === -1 ? 0 : styled;
  // What is above the styled element is its ancestors, not the elements that merely come before it
  // in the markup: a modal's close button is the SIBLING of the container that holds the modal.
  const ancestors: number[] = [];
  for (let up = tags[at]?.parent ?? -1; up !== -1; up = tags[up]?.parent ?? -1)
    ancestors.unshift(up);
  const chain = new Set([...ancestors, at]);
  const findings: TokenEnv["findings"] = [];
  const classes = tags.map((tag, index) =>
    resolveClassAttribute(attrOf(tag, "class") ?? "", {
      block,
      ctx,
      opts,
      findings: chain.has(index) ? findings : [],
    }),
  );
  return { tags, styled, at, ancestors, classes, findings };
}

/** The class names of the element a block's style goes on, and the elements above it, without the rest of `styleBlock`. */
export function classListOf(
  block: WpBlock,
  ctx: ConvertCtx,
  opts: StyleOptions = {},
): { className: string[]; styledDepth: number; tag?: string; wrappers: string[][] } {
  const located = locate(block, ctx, opts);
  const root = located.tags[located.at];
  return {
    className: located.classes[located.at] ?? [],
    styledDepth: located.styled === -1 ? -1 : located.ancestors.length,
    ...(root ? { tag: root.tag } : {}),
    wrappers: located.ancestors.map((index) => located.classes[index] ?? []),
  };
}

// ── Rules that name the classID outside the first compound ───────────────────────────────────────

type Placement =
  | { kind: "nested"; key: string }
  | { kind: "hoist" }
  | { kind: "skip"; reason: string };

interface Compound {
  nodes: selectorParser.Node[];
}

const textOf = (node: selectorParser.Node): string => node.toString().trim();

const isPseudoElement = (node: selectorParser.Node): boolean =>
  node.type === "pseudo" &&
  (node.value.startsWith("::") || /^:(?:before|after|first-line|first-letter)$/i.test(node.value));

/** `.a .b` → compounds `.a`, `.b` and the combinators between them. */
function splitComplex(
  selector: selectorParser.Selector,
): { compounds: Compound[]; combinators: string[] } | undefined {
  const compounds: Compound[] = [{ nodes: [] }];
  const combinators: string[] = [];
  for (const node of selector.nodes) {
    if (node.type === "comment") continue;
    if (node.type === "combinator") {
      const value = node.value.trim();
      combinators.push(value === "" ? " " : ` ${value} `);
      compounds.push({ nodes: [] });
    } else {
      compounds.at(-1)!.nodes.push(node);
    }
  }
  return compounds.some((c) => c.nodes.length === 0) ? undefined : { compounds, combinators };
}

/**
 * How a rule whose selector names `classID` somewhere other than a lone first compound is written
 * relative to the element that has the class. `.<id>.cs-v` is `&.cs-v`; `.a .<id> svg` is
 * `&:is(.a *) svg`: Jx splices only a key that starts with `&`, and `:is()` keeps the ancestor's
 * specificity (its most specific argument, here one class) so the rule weighs what it weighed.
 */
function placeSelector(selector: string, classID: string): Placement {
  let root: selectorParser.Root;
  try {
    root = selectorParser().astSync(selector);
  } catch {
    return { kind: "skip", reason: "the selector cannot be parsed" };
  }
  const only = root.nodes[0];
  if (root.nodes.length !== 1 || only === undefined)
    return { kind: "skip", reason: "the selector is a list" };
  const parts = splitComplex(only);
  if (!parts) return { kind: "skip", reason: "the selector has an empty compound" };
  const { compounds, combinators } = parts;
  const holders: number[] = [];
  compounds.forEach((compound, index) => {
    if (compound.nodes.some((n) => n.type === "class" && n.value === classID)) holders.push(index);
  });
  if (holders.length === 0) {
    // The class is inside a functional pseudo (`:where(.a .b)`): only the rule itself can say it.
    return { kind: "hoist" };
  }
  if (holders.length > 1)
    return { kind: "skip", reason: "the selector names the class in more than one compound" };
  const at = holders[0]!;
  const compound = compounds[at]!;
  const dropped = compound.nodes.findIndex((n) => n.type === "class" && n.value === classID);
  const rest = compound.nodes.filter((_, i) => i !== dropped);
  const plain: string[] = [];
  const elements: string[] = [];
  for (const node of rest) {
    if (isPseudoElement(node)) elements.push(textOf(node));
    else if (node.type === "tag") plain.push(`:is(${textOf(node)})`);
    else plain.push(textOf(node));
  }
  let ancestor = "";
  if (at > 0) {
    let text = "";
    for (let i = 0; i < at; i++)
      text += (i > 0 ? combinators[i - 1]! : "") + compounds[i]!.nodes.map(textOf).join("");
    ancestor = `:is(${text}${combinators[at - 1]!}*)`;
  }
  let after = "";
  for (let i = at + 1; i < compounds.length; i++)
    after += combinators[i - 1]! + compounds[i]!.nodes.map(textOf).join("");
  return { kind: "nested", key: `&${ancestor}${plain.join("")}${elements.join("")}${after}` };
}

/** Every class name a selector mentions, however deep. */
function classesIn(selector: string): string[] {
  const found = new Set<string>();
  try {
    selectorParser((root) => {
      root.walkClasses((node) => {
        found.add(node.value);
      });
    }).processSync(selector);
  } catch {
    // An unparseable key names nothing.
  }
  return [...found];
}

/** For one index: class name → the `other` selectors that mention it. Built once per index. */
const mentions = new WeakMap<ReadonlyMap<string, JxStyle>, Map<string, string[]>>();
function selectorsMentioning(other: ReadonlyMap<string, JxStyle>, classID: string): string[] {
  let byClass = mentions.get(other);
  if (byClass === undefined) {
    byClass = new Map();
    for (const selector of other.keys()) {
      for (const name of classesIn(selector)) {
        const list = byClass.get(name);
        if (list) list.push(selector);
        else byClass.set(name, [selector]);
      }
    }
    mentions.set(other, byClass);
  }
  return byClass.get(classID) ?? [];
}

const isBlock = (value: unknown): value is JxStyle =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Own declarations first, then nested selectors, then at-rules: the order Cwicly's files and Jx's emitters share. */
function normalise(style: JxStyle): void {
  const entries = Object.entries(style);
  const rank = (key: string, value: unknown): number =>
    !isBlock(value) ? 0 : key.startsWith("@") ? 2 : 1;
  const sorted = entries.toSorted((a, b) => rank(a[0], a[1]) - rank(b[0], b[1]));
  for (const [key] of entries) delete style[key];
  for (const [key, value] of sorted) style[key] = value;
}

/** A private copy of a style: the index shares its objects. */
const copy = (style: JxStyle): JxStyle => mergeStyle({}, style);

interface Gathered {
  /** Nested keys to add under the block's own style. */
  nested: [string, JxStyle][];
  hoisted: { selector: string; style: JxStyle }[];
  skipped: { selector: string; reason: string }[];
}

/** The rules of an index that name `classID` outside a lone first compound, placed relative to it. */
function gatherOthers(other: ReadonlyMap<string, JxStyle>, classID: string): Gathered {
  const out: Gathered = { nested: [], hoisted: [], skipped: [] };
  for (const selector of selectorsMentioning(other, classID)) {
    const style = other.get(selector);
    if (style === undefined) continue;
    const placed = placeSelector(selector, classID);
    if (placed.kind === "nested") out.nested.push([placed.key, copy(style)]);
    else if (placed.kind === "hoist") out.hoisted.push({ selector, style: copy(style) });
    else out.skipped.push({ selector, reason: placed.reason });
  }
  return out;
}

// ── Reporting ────────────────────────────────────────────────────────────────────────────────────

type Severity = "info" | "warn";

interface Reporter {
  add(severity: Severity, code: string, message: string, data?: Record<string, unknown>): void;
}

function reporter(ctx: ConvertCtx, block: WpBlock): Reporter {
  const classID = typeof block.attrs.classID === "string" ? block.attrs.classID : undefined;
  return {
    add(severity, code, message, data = {}) {
      ctx.report.add({
        severity,
        code,
        message,
        where: whereOf(ctx),
        data: { block: block.name, ...(classID ? { classID } : {}), ...data },
      });
    },
  };
}

// ── The saved elements ───────────────────────────────────────────────────────────────────────────

/** Features with no static equivalent: the saved attribute or block attribute that carries each, and what to call it. */
const DROPPED: readonly { feature: string; attrs: readonly string[]; saved: readonly string[] }[] =
  [
    { feature: "animateOnScroll", attrs: ["animateOnScrollType"], saved: ["data-aos"] },
    { feature: "interactions", attrs: [], saved: ["data-interaction"] },
    { feature: "tilt", attrs: ["effectsTiltControl"], saved: [] },
    { feature: "scrollDirection", attrs: ["scrollDirectionActive"], saved: [] },
  ];

/** Interactions are an object of lists keyed by event: it has one when any list does. */
function hasInteractions(value: unknown): boolean {
  const bag = isBlock(value) ? value : undefined;
  return (
    bag !== undefined && Object.values(bag).some((list) => Array.isArray(list) && list.length > 0)
  );
}

// ── `${…}` bindings ──────────────────────────────────────────────────────────────────────────────

/** The `[start, end)` spans of the `${…}` bindings in text: balanced braces, quoted strings respected. */
function bindingSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("${", from);
    if (start === -1) return spans;
    let depth = 0;
    let quote = "";
    let end = -1;
    for (let i = start + 1; i < text.length && end === -1; i++) {
      const ch = text.charAt(i);
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) end = i + 1;
    }
    // A `${` that never closes is text, not a binding.
    if (end === -1) return spans;
    spans.push([start, end]);
    from = end;
  }
}

const hasBinding = (text: string): boolean => bindingSpans(text).length > 0;

/** Text with its bindings replaced by a placeholder, and the way back: a binding's own `;`, `)` and quotes are not CSS's. */
function protectBindings(text: string): {
  text: string;
  restore: (protectedText: string) => string;
} {
  const spans = bindingSpans(text);
  if (spans.length === 0) return { text, restore: (t) => t };
  let out = "";
  let last = 0;
  for (const [index, [start, end]] of spans.entries()) {
    out += `${text.slice(last, start)}\uE000${index}\uE001`;
    last = end;
  }
  out += text.slice(last);
  return {
    text: out,
    restore: (t) =>
      t.replaceAll(/\uE000(\d+)\uE001/g, (_, n: string) => {
        const [start, end] = spans[Number(n)] ?? [0, 0];
        return text.slice(start, end);
      }),
  };
}

/** A `{token}` nothing resolved. A `${…}` binding is a value, whatever braces it holds. */
function unresolvedToken(text: string): boolean {
  let bare = text;
  for (const [start, end] of bindingSpans(text).toReversed())
    bare = `${bare.slice(0, start)}${bare.slice(end)}`;
  return /\{[^{}]+\}/.test(bare);
}

/** `backgroundImage` → `background-image`; custom properties are case-sensitive and stay as they are. */
const cssName = (key: string): string =>
  key.startsWith("--") ? key : key.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

interface ShapeHooks {
  /** An inline declaration holds a `{token}` nothing resolved and is dropped. */
  unresolved?: (what: string) => void;
  /** An inline declaration could not be read at all and is dropped. */
  skipped?: (declaration: string) => void;
}

function shapeOf(
  tag: SavedTag,
  names: string[],
  opts: StyleOptions,
  hooks: ShapeHooks = {},
): ElementShape {
  const resolve = opts.resolveTokens ?? ((text: string): string => text);
  const attributes: Record<string, string> = {};
  let id: string | undefined;
  let inlineStyle: JxStyle | undefined;
  let boundStyle: string | undefined;
  for (const [name, value] of tag.attrs) {
    if (name === "class") continue;
    if (name === "id") {
      id = value.replaceAll(/\{(?:idadd|loop-id)\}/g, "");
      continue;
    }
    if (name === "style") {
      // The bindings are set aside while the declarations are split: a binding is JavaScript, and its
      // own `;`, `)` and `||` would make a declaration unreadable to a CSS reader.
      const guarded = protectBindings(resolve(value));
      const style = cssTextToStyle(guarded.text, (declaration) =>
        hooks.skipped?.(guarded.restore(declaration)),
      );
      const bound: string[] = [];
      for (const [key, v] of Object.entries(style)) {
        if (typeof v !== "string") continue;
        const real = guarded.restore(v);
        if (unresolvedToken(real)) {
          delete style[key];
          hooks.unresolved?.(`style ${key}`);
        } else if (hasBinding(real)) {
          delete style[key];
          bound.push(`${cssName(key)}:${real}`);
        } else {
          style[key] = real;
        }
      }
      if (!isEmptyStyle(style)) inlineStyle = style;
      if (bound.length > 0) boundStyle = bound.join(";");
      continue;
    }
    attributes[name] = resolve(value);
  }
  return {
    tag: tag.tag,
    className: names.join(" "),
    attributes,
    ...(id ? { id } : {}),
    ...(inlineStyle ? { inlineStyle } : {}),
    ...(boundStyle ? { boundStyle } : {}),
  };
}

// ── styleBlock ───────────────────────────────────────────────────────────────────────────────────

/** PHP truthiness of the SCSS option: `"0"` and the empty string are off, every other stored value is on. */
const scssOn = (ctx: ConvertCtx): boolean => {
  const value = ctx.model.options.get("cwicly_scss_compiler");
  return value !== undefined && value !== "" && value !== "0";
};

const emptyStyling = (classID: string | undefined): BlockStyling => ({
  className: "",
  style: {},
  attributes: {},
  ...(classID ? { classID } : {}),
  styledDepth: -1,
  wrappers: [],
  beside: [],
  inner: [],
  source: "none",
  variantClasses: false,
  variants: [],
  hoisted: [],
});

/** The classID of the block a uniqueID names, in this block's own tree. */
function descendantClass(blocks: readonly WpBlock[], uniqueID: string): string | undefined {
  for (const inner of blocks) {
    if (inner.attrs.uniqueID === uniqueID && typeof inner.attrs.classID === "string")
      return inner.attrs.classID || undefined;
    const found = descendantClass(inner.innerBlocks, uniqueID);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** uniqueID → classID found in the site's posts, per model: `undefined` is remembered too. */
const siteClasses = new WeakMap<ConvertCtx["model"], Map<string, string | undefined>>();

/**
 * The classID of the block a uniqueID names anywhere in the site's content: the block comment that
 * carries the id says it (`<!-- wp:cwicly/heading {"uniqueID":"…","classID":"heading-red"} -->`).
 */
function siteClass(ctx: ConvertCtx, uniqueID: string): string | undefined {
  let known = siteClasses.get(ctx.model);
  if (known === undefined) {
    known = new Map();
    siteClasses.set(ctx.model, known);
  }
  if (known.has(uniqueID)) return known.get(uniqueID);
  let found: string | undefined;
  const needle = `"uniqueID":"${uniqueID}"`;
  for (const post of ctx.model.posts.values()) {
    const hit = post.content.indexOf(needle);
    if (hit === -1) continue;
    const start = post.content.lastIndexOf("<!-- wp:", hit);
    const end = post.content.indexOf(" -->", hit);
    if (start === -1 || end === -1) continue;
    try {
      const attrs = recordOf(JSON.parse(post.content.slice(post.content.indexOf("{", start), end)));
      if (attrs?.uniqueID === uniqueID && typeof attrs.classID === "string" && attrs.classID) {
        found = attrs.classID;
        break;
      }
    } catch {
      // A comment that is not JSON names no block.
    }
  }
  known.set(uniqueID, found);
  return found;
}

/** Whether the saved class attribute asks for a component instance's variant classes. */
const asksForVariants = (html: string): boolean =>
  /\{(?:cs-index|aclv(?:=[^}]*)?|gclv(?:=[^}]*)?)\}/.test(html);

/**
 * The root element of a Cwicly block: its class list, its style and its attributes. See the module
 * comment for what each is and where it comes from.
 */
export function styleBlock(block: WpBlock, ctx: ConvertCtx, opts: StyleOptions = {}): BlockStyling {
  const attrs = block.attrs;
  const classID =
    typeof attrs.classID === "string" && attrs.classID !== "" ? attrs.classID : undefined;
  const say = reporter(ctx, block);
  if (
    block.name === null ||
    !block.name.startsWith("cwicly/") ||
    block.name === "cwicly/component"
  ) {
    return emptyStyling(classID);
  }
  const located = locate(block, ctx, opts);
  for (const finding of located.findings)
    say.add(finding.severity, finding.code, finding.message, finding.data);

  // The element that carries the classID, or the root when none does; no tag at all, the editor's own list.
  const at = located.at;
  const tag = located.tags[at];
  let names = tag ? [...(located.classes[at] ?? [])] : editorClassNames(block, ctx, opts);

  // ── style ──────────────────────────────────────────────────────────────────────────────────────
  let style: JxStyle = {};
  let source: BlockStyling["source"] = "none";
  const hoisted: BlockStyling["hoisted"] = [];
  const variants = new Set<string>();
  let fromAttributes: ReturnType<typeof attrStyleDetailed> | undefined;
  const rule = classID ? ctx.css.classes.get(classID) : undefined;
  const classOf = (uniqueID: string): string | undefined =>
    opts.blockClasses?.get(uniqueID) ??
    descendantClass(block.innerBlocks, uniqueID) ??
    siteClass(ctx, uniqueID);
  if (classID && rule && !isEmptyStyle(rule.style)) {
    style = copy(rule.style);
    source = "index";
  } else if (!classID && attrs.isStyling) {
    // Cwicly wrote this block's rules under an empty class name (`.{…}`), which no browser applies,
    // so the live page does not style it either; there is nothing to scope a style to.
    const lost = attrStyleDetailed(attrs, ctx, {
      blockName: block.name,
      scssCompiler: scssOn(ctx),
      classOf,
    });
    if (!isEmptyStyle(lost.style)) {
      say.add(
        "info",
        "style.no-classid",
        "the block is styled but has no classID: its rules were written under an empty class name and match nothing on the live site",
        { css: lost.css.slice(0, 300) },
      );
    }
  } else if (classID && attrs.isStyling) {
    const ref = typeof attrs.isComponentChild === "string" ? attrs.isComponentChild : "";
    const result = attrStyleDetailed(attrs, ctx, {
      blockName: block.name,
      classID,
      variants: (ctx.components.get(ref)?.variants ?? []).map((variant) => variant.id),
      scssCompiler: scssOn(ctx),
      classOf,
    });
    if (!isEmptyStyle(result.style) || result.other.size > 0 || result.wrapper) {
      style = copy(result.style);
      fromAttributes = result;
      source = "attributes";
      say.add(
        "info",
        "style.fallback",
        "no stylesheet rule for this block: its style is computed from its attributes",
        {},
      );
    }
    if (result.unsupported.length > 0) {
      say.add(
        "warn",
        "style.attr-unsupported",
        `style attributes the converter cannot read: ${result.unsupported.join(", ")}`,
        {
          attributes: result.unsupported,
        },
      );
    }
    for (const id of result.unresolvedSelectors) {
      say.add(
        "warn",
        "style.selector-unsupported",
        `a relative style targets the block ${id}, which is in no post of the site: its rules are left out`,
        { selector: id },
      );
    }
    for (const id of result.unresolvedPalette) {
      say.add("warn", "style.palette-unresolved", `palette colour ${id} does not exist`, {
        palette: id,
      });
    }
    for (const note of result.notes)
      say.add("info", "style.attr-unsupported", `approximated: ${note}`, { note });
  }

  // Rules that name the classID in a compound of their own, in the stylesheets and in customCSS.
  const addGathered = (gathered: Gathered): void => {
    for (const [key, value] of gathered.nested) {
      const existing = style[key];
      style[key] = isBlock(existing) ? mergeStyle(existing, value) : value;
      const variant = /^&\.cs-([\w-]+)/.exec(key)?.[1];
      if (variant) variants.add(variant);
    }
    for (const item of gathered.hoisted) {
      hoisted.push(item);
      say.add(
        "info",
        "style.hoisted",
        `a rule that names the block inside a functional selector is hoisted: ${item.selector}`,
        {
          selector: item.selector,
        },
      );
    }
    for (const item of gathered.skipped) {
      say.add("warn", "style.selector-unsupported", `${item.selector}: ${item.reason}`, {
        selector: item.selector,
      });
    }
  };
  if (classID) {
    const gathered = gatherOthers(ctx.css.other, classID);
    addGathered(gathered);
    // A block whose only rules are compound ones (`.a.b .<classID>`) still gets its style from the index.
    if (source === "none" && gathered.nested.length > 0) source = "index";
  }
  if (classID && fromAttributes) addGathered(gatherOthers(fromAttributes.other, classID));

  // ── customCSS ──────────────────────────────────────────────────────────────────────────────────
  if (classID) {
    const custom = customCssSource(attrs, ctx.model.options.get("cwicly_scss_compiler"));
    if (custom && custom.css.trim() !== "") {
      const vars = {
        classID,
        id: typeof attrs.id === "string" ? attrs.id : "",
        breakpoints: ctx.cwicly.breakpoints,
      };
      let text: string;
      if (usesScss(custom.css)) {
        const compiled = compileScss(expandCustomCssTokens(custom.css, vars, { php: false }));
        text = compiled.css;
        say.add(
          "info",
          "style.scss-compiled",
          "custom CSS written as SCSS was compiled; the live site prints it uncompiled",
          {},
        );
        for (const problem of compiled.unsupported) {
          say.add("warn", "style.scss-unsupported", `${problem.feature}: ${problem.detail}`, {
            ...problem,
          });
        }
      } else {
        text = expandCustomCssTokens(custom.css, vars);
      }
      if (custom.css.includes("blockid") && !tag?.attrs.some(([name]) => name === "id")) {
        say.add(
          "info",
          "style.blockid-not-printed",
          "custom CSS names the block by `blockid`, and the block prints no id: those rules match nothing",
          {},
        );
      }
      const index = parseCwiclyCss(text, ctx.cwicly.breakpoints, {
        file: `${custom.source} of ${classID}`,
        palette: [...ctx.cwicly.globalStyles.colorRefs.values()],
      });
      for (const artifact of index.artifacts) {
        say.add("warn", "css.artifact", artifact.detail, {
          artifact: artifact.code,
          ...(artifact.selector ? { selector: artifact.selector } : {}),
        });
      }
      const own = index.classes.get(classID);
      if (own) style = mergeStyle(style, own.style);
      for (const [name, entry] of index.classes) {
        if (name !== classID) hoisted.push({ selector: `.${name}`, style: copy(entry.style) });
      }
      addGathered(gatherOthers(index.other, classID));
      for (const [selector, value] of index.other) {
        if (!classesIn(selector).includes(classID)) hoisted.push({ selector, style: copy(value) });
      }
      for (const rule of index.atRules)
        hoisted.push({ selector: rule.key, style: copy(rule.style) });
      if (source === "none" && !isEmptyStyle(style)) source = "index";
    }
  }

  // ── attributes, inline style, what is dropped ─────────────────────────────────────────────────
  const unresolved: string[] = [];
  const unreadable: string[] = [];
  const elements = located.tags.map((saved, index) =>
    shapeOf(saved, located.classes[index] ?? [], opts, {
      unresolved: (what) => unresolved.push(what),
      skipped: (declaration) => unreadable.push(declaration),
    }),
  );
  const element = elements[at];
  const attributes: Record<string, string> = {};
  const listed = Array.isArray(attrs.htmlAttributes) ? attrs.htmlAttributes : [];
  for (const entry of listed) {
    const item = isBlock(entry) ? (entry as Record<string, unknown>) : undefined;
    const name = typeof item?.name === "string" ? item.name : "";
    if (!item || !name || item.hide) continue;
    if (name === "class" || name === "style" || name === "id") continue;
    const saved = element?.attributes[name];
    if (saved !== undefined) attributes[name] = saved;
    else if (item.attributeType === "static")
      attributes[name] = typeof item.value === "string" ? item.value : "";
  }
  const tooltip = element?.attributes["data-tooltip"];
  if (tooltip !== undefined && tooltip !== "") attributes.title = tooltip;
  if (
    element &&
    Object.keys(element.attributes).some(
      (name) => name.startsWith("data-tooltip") && name !== "data-tooltip",
    )
  ) {
    say.add(
      "info",
      "style.dropped",
      "tooltip options (arrow, animation, theme) have no static equivalent; the tooltip text is kept as `title`",
      { feature: "tooltip" },
    );
  }
  for (const feature of DROPPED) {
    const byAttr = feature.attrs.some((name) =>
      feature.feature === "interactions" ? hasInteractions(attrs[name]) : Boolean(attrs[name]),
    );
    const bySaved = elements.some((e) =>
      feature.saved.some((name) =>
        Object.keys(e.attributes).some((k) => k === name || k.startsWith(`${name}-`)),
      ),
    );
    const byInteractions =
      feature.feature === "interactions" && hasInteractions(attrs.interactions);
    if (byAttr || bySaved || byInteractions) {
      say.add(
        "info",
        "style.dropped",
        `${feature.feature} has no static equivalent and is dropped`,
        { feature: feature.feature },
      );
    }
  }
  for (const what of unresolved) {
    say.add(
      "warn",
      "style.token-unresolved",
      `${what} holds a render-time token nothing resolved; it is dropped`,
      { what },
    );
  }

  for (const declaration of unreadable) {
    say.add(
      "warn",
      "style.dropped",
      `an inline style declaration could not be read and is dropped: ${declaration}`,
      { feature: "inline-style", declaration },
    );
  }

  // The inline style wins, as it did on the page.
  if (element?.inlineStyle) style = mergeStyle(style, element.inlineStyle);

  // ── the class list ─────────────────────────────────────────────────────────────────────────────
  names = [...new Set(names)];
  if (classID && !isEmptyStyle(style)) {
    if (!names.includes(classID)) {
      say.add(
        "info",
        "style.classid-not-printed",
        "the saved markup prints no class for this block, and it has a style: the classID is added first",
        {},
      );
    }
    // Jx writes the scope selector unescaped, so anything but a plain identifier (a dot, a colon, a
    // digit first) is an invalid rule there and the element's style is lost.
    if (!/^-?[A-Za-z_][\w-]*$/.test(classID)) {
      say.add(
        "warn",
        "style.no-scope",
        `the classID ${classID} cannot serve as a style scope (it is not a plain class name)`,
        {},
      );
    }
    names = [classID, ...names.filter((name) => name !== classID)];
  } else if (classID && names.includes(classID)) {
    names = [classID, ...names.filter((name) => name !== classID)];
  }

  // ── what is inside the styled element, and what sits beside it ────────────────────────────────
  const inner: ElementShape[] = [];
  const beside: BlockStyling["beside"] = [];
  const ancestors = new Set(located.ancestors);
  const depthOf = (index: number): number => {
    let depth = 0;
    for (let up = located.tags[index]?.parent ?? -1; up !== -1; up = located.tags[up]?.parent ?? -1)
      depth++;
    return depth;
  };
  const insideStyled = (index: number): boolean => {
    for (let up = located.tags[index]?.parent ?? -1; up !== -1; up = located.tags[up]?.parent ?? -1)
      if (up === at) return true;
    return false;
  };
  for (const index of located.tags.keys()) {
    if (index === at || ancestors.has(index)) continue;
    const resolved = located.classes[index] ?? [];
    const shape = elements[index]!;
    if (!insideStyled(index)) {
      beside.push({ ...shape, depth: depthOf(index), after: index > at });
      continue;
    }
    const own = classID ? resolved.find((name) => name.startsWith(`${classID}-`)) : undefined;
    const ownRule = own ? ctx.css.classes.get(own) : undefined;
    const computed = own === `${classID}-wrapper` ? fromAttributes?.wrapper : undefined;
    const ownStyle = ownRule && !isEmptyStyle(ownRule.style) ? ownRule.style : computed;
    if (own && ownStyle && !isEmptyStyle(ownStyle)) {
      shape.style = copy(ownStyle);
      shape.className = [own, ...resolved.filter((name) => name !== own)].join(" ");
    }
    inner.push(shape);
  }

  normalise(style);
  // A modal's shell is styled by `modal-<classID>` (its container's alignment), on an element whose
  // first class is the structural `cc-mdl` every modal shares: the rule goes on the shell, with its
  // own class first, because Jx scopes an element's style to the first word of its className.
  const shell = classID ? `modal-${classID}` : undefined;
  const shellRule = shell ? ctx.css.classes.get(shell) : undefined;
  const wrappers = located.ancestors.map((index) => {
    const shape = elements[index]!;
    const classes = shape.className.split(SPLIT);
    if (!shell || !shellRule || isEmptyStyle(shellRule.style) || !classes.includes(shell))
      return shape;
    return {
      ...shape,
      className: [shell, ...classes.filter((name) => name !== shell)].join(" "),
      style: copy(shellRule.style),
    };
  });
  return {
    className: names.join(" "),
    style,
    attributes,
    ...(classID ? { classID } : {}),
    ...(element?.id ? { id: element.id } : {}),
    ...(tag ? { tag: tag.tag } : {}),
    ...(element?.boundStyle ? { boundStyle: element.boundStyle } : {}),
    styledDepth: located.styled === -1 ? -1 : located.ancestors.length,
    wrappers,
    beside,
    ...(element ? { element } : {}),
    inner,
    source,
    variantClasses: asksForVariants(block.innerHTML) && opts.variants === undefined,
    variants: [...variants],
    hoisted,
  };
}
