/**
 * A Cwicly block's style from its OWN attributes: the fallback for a block whose classID has no rule
 * in the stylesheets (a file the source did not have, or one that does not cover the block).
 *
 * Cwicly keeps each CSS property as a block attribute (`marginTop: {lg: "3rem", lghover: "1rem"}`)
 * and compiles the text in the editor's JavaScript, which is saved as the `cc-*.css` files
 * `cwicly/css.ts` reads back. This module is the compiler's other half: a port, family by family,
 * of the generator's per-property helpers and of the order it concatenates them in, read from the
 * plugin's editor bundle (`build/index.js`, the style generator module and the helper modules it
 * imports) for semantics only. It writes CSS text for the block, and that text goes through the
 * same reader the real files do, so the two agree on everything the reader normalises (autoprefixer
 * twins, `!var=` repair, nesting, `@--md` keys) and a comparison between this module's output and a
 * real rule compares like with like.
 *
 * What a key means (the generator's `e`): a breakpoint key, optionally followed by a pseudo
 * (`lg`, `mdhover`, `smbefore`). Breakpoints come from the site's list (`ctx.cwicly.breakpoints`);
 * the main one is unwrapped and every other is a media query, exactly as the stylesheets have it. The
 * built-in pseudos are `hover active focus before after`; a block adds its own in `pseudoClasses`.
 *
 * Defaults: Gutenberg omits an attribute equal to its default when it saves a block, so a block
 * whose comment has no `containerLayoutDisplay` has the block type's default (`flex` for a section).
 * The ones that decide CSS are in `blockDefaults`, from the plugin's `block.json` files (1.4.7); an
 * attribute the comment does carry replaces the default as a whole, an empty `{lg: ""}` included
 * (which is how an author turns a default off). A site with `cwiclyDefaults` off (the second fixture
 * site) has most of them stripped: the plugin re-registers the blocks without them
 * (`filter_metadata_registration`), and the built-in `cc-*` classes style the blocks instead.
 *
 * The old section layout (`deprecated.oldSectionLayout`, also the second site): a section's
 * layout, size and padding are written to `.<classID>-wrapper`, the inner element its saved markup
 * has, and the rest to the section. `wrapper` of the result is that rule.
 *
 * Relative styles (`relativeStyles`, keys `rs<bp><id>`) are rules for descendants of the block (a
 * `class` selector holds the uniqueID of the block it targets, which `opts.classOf` turns into its
 * classID, and one nothing resolves is `unresolvedSelectors`, never an invalid selector), and a
 * component's variants (`cs<bp><variant>`) rules for `.classID.cs-<variant>`; both are ported, with
 * the author's own extra CSS for them. Rules the reader files beside the class's tree (a second
 * class in the first compound) come back in `other`, as `ctx.css.other` has them.
 *
 * Where the real files carry the generator's bugs the port writes what was meant, not the bug: the
 * later members of a relative style's selector list are `undefined…` in the real files (the reader
 * drops them), here they are `.classID …`.
 *
 * What is NOT here, reported rather than guessed (`unsupported` of `attrStyleDetailed`, and
 * `style.attr-unsupported` through `styleBlock`): every attribute that is shaped like a style
 * (an object keyed by breakpoint and pseudo) and has a value, that no ported family read and that
 * is not inert for the block (`INERT`). Missing: the menu and nav blocks' own families
 * (`menu*`, `nav*`: their CSS custom properties and descendant rules), a gallery's filter bar,
 * modals, sliders, query pagination, fluid font sizes, and the clip-path blob's SVG. The families
 * that are ported:
 *
 *   spacing           margin, padding, scroll margin (shorthand collapsing as the editor does it)
 *   sizing            width/height, min and max, aspect ratio, object fit, object position
 *   layout            display, position and offsets, z-index, overflow, visibility, flex (direction,
 *                     wrap, grow/shrink/basis, order, gaps, alignment), grid (templates, auto
 *                     tracks, areas, item placement), columns (control and auto items, gaps, rows)
 *   typography        colour, size, weight, spacing, line height, decoration, style, transform,
 *                     stretch, variation settings, alignment, wrapping, family; link colour
 *   background        colour, image (static and dynamic), gradient, size, position, repeat,
 *                     attachment, blend mode, clip, filters on the backdrop, overlay (`:before`)
 *   border            width, style, colour, radius, outline, box shadow
 *   effects           opacity, filters, drop shadow, text shadow, blend mode, transition, animation
 *   transforms        translate, scale, rotate, skew, perspective, origin, backface
 *   interaction       cursor, pointer events, user select
 *   block specifics   icon and button svg size, list (bullets, spacing, indent, icon), gallery
 *                     grid and height, column order, masonry, stroke and fill, clip-path
 *
 * Measured against the plugin's own stylesheets (every block that has a rule, `tests/cwicly/
 * attr-style.test.ts`): 99.06% of fineline's 23,953 declarations and 96.4% of ap's 2,834 (99.0% of
 * those of blocks every attribute of which a family read). What differs is drift between the two
 * exports (the rows and the stylesheets are not one snapshot: post 1716 alone is nearly half of
 * fineline's misses, and its file is the newer) and the families above that are not ported.
 */
import { parseCwiclyCss } from "./css.ts";
import { resolvePaletteRefs } from "./options.ts";
import type { ConvertCtx, JxStyle } from "../types.ts";

// ── Defaults ─────────────────────────────────────────────────────────────────────────────────────

/** What every block that has style defaults has: an empty hover picture type and `position: relative`. */
const COMMON: Readonly<Record<string, unknown>> = {
  backgroundImageTypePseudo: { lghover: "static" },
  containerLayoutPosition: { lg: "relative" },
};

/** The blocks whose `block.json` does not have all of `COMMON`: their rows below are complete. */
const NO_COMMON = new Set(["columns", "content", "filter", "rangeslider"]);

/** The grid blocks' default `columnsItems` and `columnsAutoItems`: three items in a row at every breakpoint. */
const THREE_ITEMS = {
  lg: [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 1, y: 0, w: 1, h: 1 },
    { x: 2, y: 0, w: 1, h: 1 },
  ],
  md: [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 1, y: 0, w: 1, h: 1 },
    { x: 2, y: 0, w: 1, h: 1 },
  ],
  sm: [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 1, y: 0, w: 1, h: 1 },
    { x: 2, y: 0, w: 1, h: 1 },
  ],
};

/**
 * The attributes a block has when its comment omits them, for the ones that decide CSS (from the
 * `block.json` of each block in `core/includes/blocks`, Cwicly 1.4.7: every attribute whose default
 * is not empty and whose name starts like a family the generator reads), without what `COMMON`
 * already says. Keyed by the block name without its namespace. `columnsControl: true` on the grid
 * blocks is why a query template with no `columnsControl` in its comment takes its columns from
 * `columnsAutoItems`.
 */
const DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  accordioncontent: { containerLayoutDisplay: { lg: "flex" } },
  accordionheader: { containerLayoutDisplay: { lg: "flex" } },
  accordion: { containerLayoutDisplay: { lg: "flex" } },
  accordions: { containerLayoutDisplay: { lg: "flex" } },
  button: {
    containerLayoutAlignItems: { lg: "center" },
    containerLayoutDisplay: { lg: "flex" },
    containerLayoutFlexDirection: { lg: "row" },
  },
  column: { containerLayoutDisplay: { lg: "flex" } },
  columns: {
    containerSizeWidth: { lg: "100%" },
    containerLayoutPosition: { lg: "relative" },
    columnsControl: true,
    columnsMinimumColumnsWidth: { lg: 250 },
    columnsAutoFitControl: true,
    columnsColumnGap: { lg: 10 },
    columnsRowGap: { lg: 10 },
    columnsRowHeight: { lg: 100 },
    columnsItems: THREE_ITEMS,
    columnsAutoItems: THREE_ITEMS,
  },
  component: { containerLayoutDisplay: { lg: "flex" } },
  container: { containerLayoutDisplay: { lg: "flex" } },
  content: { containerLayoutPosition: { lg: "relative" }, containerLayoutDisplay: { lg: "block" } },
  div: { containerLayoutDisplay: { lg: "flex" } },
  filter: { backgroundImageTypePseudo: { lghover: "static" } },
  gallery: {
    containerLayoutDisplay: { lg: "block" },
    galleryColumns: { lg: 3 },
    galleryHeight: { lg: "300px" },
    galleryVerticalGutter: { lg: "10" },
    galleryHorizontalGutter: { lg: "10" },
    galleryFilterSpacing: { lg: "10px" },
  },
  heading: { containerLayoutDisplay: { lg: "block" } },
  icon: { containerSizeWidth: { lg: "fit-content" }, containerLayoutDisplay: { lg: "block" } },
  image: {
    containerSizeHeight: { lg: "auto" },
    containerSizeWidth: { lg: "100%" },
    containerLayoutDisplay: { lg: "block" },
  },
  innerblocks: { containerLayoutDisplay: { lg: "flex" } },
  input: { containerLayoutDisplay: { lg: "block" } },
  list: { listStyleUl: "disc", listStyleOl: "decimal", containerLayoutDisplay: { lg: "block" } },
  maps: {
    containerSizeHeight: { lg: "500px" },
    containerSizeWidth: { lg: "100%" },
    containerLayoutDisplay: { lg: "flex" },
  },
  menu: {
    menuLayout: { lg: "horizontal" },
    menuMainMenuAlign: { lg: "center" },
    menuSubMenuAlign: { lg: "center" },
    containerLayoutDisplay: { lg: "flex" },
  },
  modal: { containerSizeWidth: { lg: "100%" }, containerLayoutDisplay: { lg: "flex" } },
  navdropdown: { containerLayoutDisplay: { lg: "flex" } },
  navitems: { containerLayoutDisplay: { lg: "flex" } },
  navlink: {
    containerLayoutAlignItems: { lg: "center" },
    containerLayoutDisplay: { lg: "flex" },
    containerLayoutFlexDirection: { lg: "row" },
  },
  navmenu: { containerLayoutDisplay: { lg: "block" } },
  nav: { containerLayoutDisplay: { lg: "flex" } },
  paragraph: { containerLayoutDisplay: { lg: "block" } },
  popover: { containerLayoutDisplay: { lg: "flex" } },
  "query-pagination-numbers": { containerLayoutDisplay: { lg: "flex" } },
  "query-pagination": { containerLayoutDisplay: { lg: "flex" } },
  "query-template": {
    containerLayoutDisplay: { lg: "grid" },
    columnsControl: true,
    columnsTemplateColumns: { lg: "3" },
    columnsMinimumColumnsWidth: { lg: 250 },
    columnsAutoFitControl: true,
    columnsColumnGap: { lg: 10 },
    columnsRowGap: { lg: 10 },
    columnsRowHeight: { lg: 100 },
    columnsItems: THREE_ITEMS,
    columnsAutoItems: THREE_ITEMS,
  },
  query: { containerLayoutDisplay: { lg: "block" } },
  rangeslider: { backgroundImageTypePseudo: { lghover: "static" } },
  repeater: {
    containerLayoutDisplay: { lg: "grid" },
    columnsControl: true,
    columnsTemplateColumns: { lg: "3" },
    columnsMinimumColumnsWidth: { lg: 250 },
    columnsAutoFitControl: true,
    columnsColumnGap: { lg: 10 },
    columnsRowGap: { lg: 10 },
    columnsRowHeight: { lg: 100 },
    columnsItems: THREE_ITEMS,
    columnsAutoItems: THREE_ITEMS,
  },
  section: { containerLayoutDisplay: { lg: "flex" } },
  sliderchild: {
    containerSizeHeight: { lg: "100%" },
    containerSizeWidth: { lg: "100%" },
    containerLayoutDisplay: { lg: "flex" },
  },
  slider: {
    containerSizeWidth: { lg: "100%" },
    containerLayoutDisplay: { lg: "flex" },
    sliderNumberPerWindow: { lg: 3 },
    sliderSpaceBetween: { lg: 10 },
    slidesWidth: { lg: 100 },
  },
  styler: { backgroundType: { lg: "image" }, containerLayoutDisplay: { lg: "flex" } },
  svg: { containerLayoutDisplay: { lg: "block" } },
  swatch: {},
  tabcontent: { containerLayoutDisplay: { lg: "flex" } },
  tabcontents: { containerLayoutDisplay: { lg: "flex" } },
  tablist: { containerLayoutDisplay: { lg: "flex" } },
  tab: { containerLayoutDisplay: { lg: "flex" } },
  taxonomyterms: {
    containerLayoutDisplay: { lg: "grid" },
    columnsControl: true,
    columnsTemplateColumns: { lg: "3" },
    columnsMinimumColumnsWidth: { lg: 250 },
    columnsAutoFitControl: true,
    columnsColumnGap: { lg: 10 },
    columnsRowGap: { lg: 10 },
    columnsRowHeight: { lg: 100 },
    columnsItems: THREE_ITEMS,
    columnsAutoItems: THREE_ITEMS,
  },
  video: { containerSizeWidth: { lg: "100%" }, containerLayoutDisplay: { lg: "block" } },
};

/**
 * What the plugin does to the registered defaults when the site has `cwiclyDefaults` off
 * (`filter_metadata_registration` in `class-actions.php`): it replaces these attributes by a bare
 * type, so they have no default (the built-in `cc-*` classes style the blocks instead). A name here
 * is dropped for every block, `only` limits it to the blocks that have it listed, and `except` skips one.
 * The plugin tests names with `strpos($name, 'cwicly/slide')`, a substring, which is `slider` and
 * `sliderchild` (no block is named `slide`).
 */
const STRIPPED: readonly { names: readonly string[]; only?: readonly string[]; except?: string }[] =
  [
    { names: ["containerLayoutDisplay"], except: "query-template" },
    {
      names: [
        "containerLayoutPosition",
        "backgroundImageTypePseudo",
        "containerLayoutAlignItems",
        "containerLayoutFlexDirection",
      ],
    },
    {
      names: ["containerSizeWidth"],
      only: ["columns", "image", "modal", "icon", "section", "maps", "slider", "sliderchild"],
    },
    {
      names: [
        "columnsControl",
        "columnsTemplateColumns",
        "columnsMinimumColumnsWidth",
        "columnsAutoFitControl",
        "columnsColumnGap",
        "columnsRowGap",
        "columnsRowHeight",
        "columnsItems",
        "columnsAutoItems",
      ],
      only: ["columns"],
    },
    {
      names: ["columnsColumnGap", "columnsRowGap"],
      only: ["repeater", "query-template", "taxonomyterms"],
    },
    {
      names: ["containerSizeWidth", "containerSizeHeight"],
      only: ["image", "slider", "sliderchild"],
    },
    { names: ["listStyleUl", "listStyleOl"], only: ["list"] },
    { names: ["containerSizeMaxWidth"], only: ["section"] },
  ];

/**
 * The defaults of a block type (its name without the namespace), `COMMON` included, for a site with
 * `cwiclyDefaults` on (the plugin's own setting) or off.
 */
export function blockDefaults(
  name: string,
  cwiclyDefaults = true,
): Readonly<Record<string, unknown>> {
  const own = DEFAULTS[name];
  if (own === undefined) return {};
  const all: Record<string, unknown> = NO_COMMON.has(name) ? { ...own } : { ...COMMON, ...own };
  if (cwiclyDefaults) return all;
  for (const rule of STRIPPED) {
    if (rule.only && !rule.only.includes(name)) continue;
    if (rule.except === name) continue;
    for (const attribute of rule.names) delete all[attribute];
  }
  return all;
}

// ── JavaScript's idea of "there is a value" ──────────────────────────────────────────────────────

type Attrs = Record<string, unknown>;
type Bag = Record<string, unknown>;

/** The generator tests values with `a && a[e] ? a[e] : ""`: JavaScript truthiness, where `"0"` and `[]` are true. */
const truthy = (value: unknown): boolean => Boolean(value);

/** `x != ""` and friends in the shorthand collapser: loose, so `0`, `false` and `[]` count as empty. */
const empty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  value === 0 ||
  value === false ||
  (Array.isArray(value) && value.length === 0);

/** `/^\d+$/.test(e) ? e + "px" : e` (`h` in the generator). */
const px = (value: unknown): string => {
  const text = String(value);
  return /^\d+$/.test(text) ? `${text}px` : text;
};

const str = (value: unknown): string =>
  value === undefined || value === null ? "" : String(value);

/** `!isNaN(x)`: JavaScript's `isNaN` coerces. */
const numeric = (value: unknown): boolean => !Number.isNaN(Number(value));

const record = (value: unknown): Bag | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Bag) : undefined;

// ── The generator ────────────────────────────────────────────────────────────────────────────────

interface Gen {
  /** The block's attributes, defaults applied, reads recorded. */
  n: Attrs;
  /** The block's name without its namespace. */
  name: string;
  /** The main breakpoint key. */
  main: string;
  /** Breakpoint keys in cascade order. */
  keys: readonly string[];
  /** Built-in plus the block's own pseudos. */
  pseudos: readonly string[];
  /** Resolves `!var=<id>!` to `var(--…)`. */
  palette: (text: string) => string;
  /** Things this port met and has no equivalent for. */
  notes: Set<string>;
  /** The breakpoints whose overlay has had its box declared. */
  overlayBox: Set<string>;
  /** The old section layout: a section's layout and size live on an inner `<classID>-wrapper` element. */
  oldSection: boolean;
  /** Names a relative style's class selector as an id, which only the block tree can turn into a class. */
  classOf: (id: string) => string | undefined;
  /** Ids no source resolved: the relative styles that name them are left out and reported. */
  unresolvedSelectors: Set<string>;
}

/** `n[name][key]`, the way every helper reads it. */
function at(g: Gen, name: string, key: string): unknown {
  const bag = g.n[name];
  return bag === undefined || bag === null ? undefined : (bag as Bag)[key];
}

/** `y` / `A` / `Y` in the generator: a palette reference becomes the colour's variable. */
const colour = (g: Gen, value: unknown): string => g.palette(str(value));

type Piece = string | undefined;

/** `margin`, `scroll-margin`: the generator's `T`. */
function box4(g: Gen, key: string, prefix: string, property: "margin" | "padding"): Piece {
  const top = at(g, `${prefix}Top`, key);
  const right = at(g, `${prefix}Right`, key);
  const bottom = at(g, `${prefix}Bottom`, key);
  const left = at(g, `${prefix}Left`, key);
  const t = truthy(top) ? top : "";
  const r = truthy(right) ? right : "";
  const b = truthy(bottom) ? bottom : "";
  const l = truthy(left) ? left : "";
  const name = property === "margin" && prefix.includes("scroll") ? "scroll-margin" : property;
  const short = collapse(t, b, l, r);
  if (short !== undefined) return `${name}:${short};`;
  let out = "";
  if (truthy(t)) out += `${name}-top:${str(t)};`;
  if (truthy(b)) out += `${name}-bottom:${str(b)};`;
  if (truthy(r)) out += `${name}-right:${str(r)};`;
  if (truthy(l)) out += `${name}-left:${str(l)};`;
  return out || undefined;
}

/** Module 93380: four sides to the shortest `top right bottom left` shorthand, only when all four are set. */
function collapse(
  top: unknown,
  bottom: unknown,
  left: unknown,
  right: unknown,
): string | undefined {
  if (empty(top) || empty(bottom) || empty(left) || empty(right)) return undefined;
  const t = str(top);
  const b = str(bottom);
  const l = str(left);
  const r = str(right);
  if (new Set([top, bottom, left, right]).size === 1) return t;
  if (top === bottom && left === right) return `${t} ${l}`;
  if (top !== bottom && left === right) return `${t} ${l} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

function borderRadius(g: Gen, key: string, prefix = "radius"): Piece {
  const right = truthy(at(g, `${prefix}Right`, key)) ? str(at(g, `${prefix}Right`, key)) : "";
  const top = truthy(at(g, `${prefix}Top`, key)) ? str(at(g, `${prefix}Top`, key)) : "";
  const bottom = truthy(at(g, `${prefix}Bottom`, key)) ? str(at(g, `${prefix}Bottom`, key)) : "";
  const left = truthy(at(g, `${prefix}Left`, key)) ? str(at(g, `${prefix}Left`, key)) : "";
  const short = collapse(top, bottom, left, right);
  if (short !== undefined) return `border-radius:${short};`;
  let out = "";
  if (right) out += `border-top-right-radius:${right};`;
  if (top) out += `border-top-left-radius:${top};`;
  if (bottom) out += `border-bottom-right-radius:${bottom};`;
  if (left) out += `border-bottom-left-radius:${left};`;
  return out || undefined;
}

function borderWidth(g: Gen, key: string, prefix = "border"): Piece {
  const top = truthy(at(g, `${prefix}WidthTop`, key)) ? str(at(g, `${prefix}WidthTop`, key)) : "";
  const right = truthy(at(g, `${prefix}WidthRight`, key))
    ? str(at(g, `${prefix}WidthRight`, key))
    : "";
  const bottom = truthy(at(g, `${prefix}WidthBottom`, key))
    ? str(at(g, `${prefix}WidthBottom`, key))
    : "";
  const left = truthy(at(g, `${prefix}WidthLeft`, key))
    ? str(at(g, `${prefix}WidthLeft`, key))
    : "";
  const short = collapse(top, bottom, left, right);
  if (short !== undefined) return `border-width:${short};`;
  let out = "";
  if (top) out += `border-top-width:${top};`;
  if (right) out += `border-right-width:${right};`;
  if (bottom) out += `border-bottom-width:${bottom};`;
  if (left) out += `border-left-width:${left};`;
  return out || undefined;
}

function borderColour(g: Gen, key: string, prefix: string): Piece {
  const value = at(g, `${prefix}Color`, key);
  const resolved = truthy(value) ? colour(g, value) : "";
  const property = prefix.includes("outline") ? "outline" : "border";
  return resolved ? `${property}-color:${resolved};` : undefined;
}

function borderStyle(g: Gen, key: string, prefix: string): Piece {
  const value = at(g, `${prefix}Style`, key);
  const property = prefix.includes("outline") ? "outline" : "border";
  return truthy(value) ? `${property}-style:${str(value)};` : undefined;
}

const outlineWidth = (g: Gen, key: string): Piece => {
  const value = at(g, "outlineWidth", key);
  return truthy(value) ? `outline-width:${str(value)};` : undefined;
};

const outlineOffset = (g: Gen, key: string): Piece => {
  const value = at(g, "outlineOffset", key);
  return truthy(value) ? `outline-offset:${str(value)};` : undefined;
};

/** One shadow's length: a number is pixels, `0` too. */
function shadowLength(value: unknown): string {
  if ((truthy(value) && numeric(value)) || value === 0) return `${str(value)}px`;
  return truthy(value) ? str(value) : "";
}

function shadowColour(g: Gen, value: unknown): string {
  if (!truthy(value)) return "";
  const text =
    typeof value === "string"
      ? value
      : (() => {
          const c = record(value) ?? {};
          return `rgba(${str(c.r)},${str(c.g)},${str(c.b)},${str(c.a)})`;
        })();
  return colour(g, text);
}

function boxShadow(g: Gen, key: string, prefix = "border"): Piece {
  const out: string[] = [];
  const add = (name: string, inset: boolean): void => {
    const group = at(g, `${prefix}${name}`, key);
    if (!truthy(group)) return;
    for (const entry of Object.values(group as Bag)) {
      const shadow = record(entry);
      if (!shadow) continue;
      if (shadow.isSingle) {
        if (truthy(shadow.single)) out.push(str(shadow.single));
        continue;
      }
      const x = shadowLength(shadow.horizontal);
      const spread = shadowLength(shadow.spread);
      const blur = shadowLength(shadow.blur);
      const y = shadowLength(shadow.vertical);
      const color = shadowColour(g, shadow.color);
      if (
        (!x && x !== "0") ||
        (!spread && spread !== "0") ||
        (!blur && blur !== "0") ||
        (!y && y !== "0") ||
        !color
      ) {
        continue;
      }
      out.push(`${inset ? "inset " : ""}${x} ${y} ${blur} ${spread} ${color}`);
    }
  };
  add("OuterShadow", false);
  add("InnerShadow", true);
  return out.length > 0 ? `box-shadow:${out.join(",")};` : undefined;
}

// Layout ─────────────────────────────────────────────────────────────────────────────────────────

const prop =
  (name: string, css: string) =>
  (g: Gen, key: string): Piece => {
    const value = at(g, name, key);
    return truthy(value) ? `${css}:${str(value)};` : undefined;
  };

const alignItems = prop("containerLayoutAlignItems", "align-items");
const alignContent = prop("containerLayoutAlignContent", "align-content");
const justifyItems = prop("containerLayoutJustifyItems", "justify-items");
const justifyContent = prop("containerLayoutJustifyContent", "justify-content");
const positionOf = prop("containerLayoutPosition", "position");
const visibility = prop("containerLayoutVisibility", "visibility");
const display = prop("containerLayoutDisplay", "display");
const flexWrap = prop("containerLayoutChildren", "flex-wrap");
const zIndex = prop("containerLayoutZIndex", "z-index");

function flexDirection(g: Gen, key: string): Piece {
  const value = at(g, "containerLayoutFlexDirection", key);
  if (!truthy(value)) return undefined;
  const reverse = at(g, "containerLayoutFlexDirectionReverse", key);
  return `flex-direction:${truthy(reverse) ? `${str(value)}-reverse` : str(value)};`;
}

function flexItem(g: Gen, key: string): Piece {
  const pick = (name: string): string => {
    const value = at(g, name, key);
    return truthy(value) ? str(value) : "";
  };
  let out = "";
  const shrink = pick("containerLayoutFlexShrink");
  const grow = pick("containerLayoutFlexGrow");
  const basis = pick("containerLayoutFlexBasis");
  const rowGap = pick("containerLayoutFlexRowGap");
  const columnGap = pick("containerLayoutFlexColumnGap");
  const alignSelf = pick("containerLayoutAlignSelf");
  const justifySelf = pick("containerLayoutJustifySelf");
  const order = pick("containerLayoutFlexOrder");
  if (shrink) out += `flex-shrink:${shrink};`;
  if (grow) out += `flex-grow:${grow};`;
  if (basis) out += `flex-basis:${basis};`;
  if (rowGap) out += `row-gap:${rowGap};`;
  if (columnGap) out += `column-gap:${columnGap};`;
  if (alignSelf) out += `align-self:${alignSelf};`;
  if (justifySelf) out += `justify-self:${justifySelf};`;
  if (order) out += `order:${order};`;
  return out || undefined;
}

const UNIT_ONLY = new Set(["px", "%", "em", "rem", "vh", "vw"]);

function offsets(g: Gen, key: string): Piece {
  const pick = (name: string): string => {
    const value = at(g, name, key);
    return truthy(value) && !UNIT_ONLY.has(str(value)) ? str(value) : "";
  };
  const top = pick("containerLayoutPositionTop");
  const bottom = pick("containerLayoutPositionBottom");
  const left = pick("containerLayoutPositionLeft");
  const right = pick("containerLayoutPositionRight");
  let out = "";
  if (top) out += `top:${top};`;
  if (bottom) out += `bottom:${bottom};`;
  if (left) out += `left:${left};`;
  if (right) out += `right:${right};`;
  return out || undefined;
}

function overflow(g: Gen, key: string): Piece {
  const value = at(g, "containerLayoutOverflow", key);
  if (truthy(value) && value !== "scroll-y" && value !== "scroll-x")
    return `overflow:${str(value)};`;
  if (truthy(value) && value === "scroll-y") return "overflow-y:scroll;";
  if (truthy(value) && value === "scroll-x") return "overflow-x:scroll;";
  return undefined;
}

// Grid ───────────────────────────────────────────────────────────────────────────────────────────

/** One entry of a grid template (`r` in the grid module). */
function gridTrack(entry: Bag): string | undefined {
  const { value, type, autoSize, min, max } = entry;
  const lower = truthy(min) ? str(min) : "0";
  const upper = truthy(max) ? str(max) : "1fr";
  if (truthy(autoSize)) {
    if (truthy(type)) {
      return type === "minmax"
        ? `repeat(${str(autoSize)},${str(type)}(${lower},${upper}))`
        : undefined;
    }
    return truthy(value) ? `repeat(${str(autoSize)},${str(value)})` : undefined;
  }
  if (truthy(value)) {
    if (!truthy(type)) return str(value);
    if (type === "minmax") return `${str(type)}(${lower},${upper})`;
  }
  return undefined;
}

function gridTemplate(g: Gen, key: string, name: string, css: string): Piece {
  const list = at(g, name, key);
  if (!Array.isArray(list)) return undefined;
  const tracks = list.map((item) => gridTrack(record(item) ?? {}));
  const joined = tracks.map((t) => (t === undefined ? "" : t)).join(" ");
  // `Array.map(...).join(" ")` writes `undefined` entries as nothing; a template with none is no template.
  return joined.trim() === "" && tracks.every((t) => t === undefined)
    ? undefined
    : `${css}:${joined};`;
}

function gridAreas(g: Gen, key: string): Piece {
  const areas = at(g, "containerLayoutGridTemplateAreas", key);
  const rows = at(g, "containerLayoutGridTemplateRows", key);
  const columns = at(g, "containerLayoutGridTemplateColumns", key);
  if (!Array.isArray(areas) || areas.length === 0) return undefined;
  const rowCount = Array.isArray(rows) ? rows.length : undefined;
  const columnCount = Array.isArray(columns) ? columns.length : undefined;
  let maxRow = 0;
  let maxColumn = 0;
  for (const item of areas) {
    const position = (record(item)?.position ?? []) as number[];
    const [, , rowEnd = 0, columnEnd = 0] = position;
    if (rowEnd - 1 > maxRow) maxRow = rowEnd - 1;
    if (columnEnd - 1 > maxColumn) maxColumn = columnEnd - 1;
  }
  if ((rowCount ?? 0) > maxRow) maxRow = rowCount ?? 0;
  if ((columnCount ?? 0) > maxColumn) maxColumn = columnCount ?? 0;
  const grid: string[][] = Array.from({ length: maxRow }, () =>
    Array.from({ length: maxColumn }, () => "."),
  );
  for (const item of areas) {
    const area = record(item);
    const position = (area?.position ?? []) as number[];
    const [top = 1, left = 1, bottom = 1, right = 1] = position;
    for (let y = top - 1; y < bottom - 1; y++) {
      for (let x = left - 1; x < right - 1; x++) {
        const row = grid[y];
        if (row) row[x] = str(area?.name);
      }
    }
  }
  return `grid-template-areas:${grid.map((row) => `"${row.join(" ")}"`).join(" ")};`;
}

/** The per-item placement rules (`gt`): one `:nth-child` rule per template item. */
function gridItems(g: Gen, key: string): string[] {
  const items = at(g, "containerLayoutGridTemplateItems", key);
  if (!Array.isArray(items)) return [];
  return items.map((entry) => {
    const item = record(entry) ?? {};
    let out = "";
    if (truthy(item.specific)) out += `grid-area:${str(item.specific)};`;
    else if (Array.isArray(item.position)) {
      const p = item.position as number[];
      out += `grid-column:${str(p[1])} / ${str(p[3])};`;
      out += `grid-row:${str(p[0])} / ${str(p[2])};`;
    }
    return out;
  });
}

const gridProps = (g: Gen, key: string): Piece[] => [
  gridTemplate(g, key, "containerLayoutGridTemplateColumns", "grid-template-columns"),
  gridTemplate(g, key, "containerLayoutGridTemplateRows", "grid-template-rows"),
  gridAreas(g, key),
  prop("containerLayoutGridAutoFlow", "grid-auto-flow")(g, key),
  prop("containerLayoutGridAutoRows", "grid-auto-rows")(g, key),
  prop("containerLayoutGridAutoColumns", "grid-auto-columns")(g, key),
  prop("containerLayoutGridItemArea", "grid-area")(g, key),
  prop("containerLayoutGridItemColumnStart", "grid-column-start")(g, key),
  prop("containerLayoutGridItemColumnEnd", "grid-column-end")(g, key),
  prop("containerLayoutGridItemRowStart", "grid-row-start")(g, key),
  prop("containerLayoutGridItemRowEnd", "grid-row-end")(g, key),
  prop("containerLayoutGridItemAlignSelf", "align-self")(g, key),
  prop("containerLayoutGridItemJustifySelf", "justify-self")(g, key),
];

// Size ───────────────────────────────────────────────────────────────────────────────────────────

const sizeOf =
  (name: string, css: string) =>
  (g: Gen, key: string): Piece => {
    const value = at(g, name, key);
    return truthy(value) ? `${css}:${str(value)};` : undefined;
  };

function objectFit(g: Gen, key: string): Piece {
  if (truthy(g.n.imageObjectFit) && key === g.main) return `object-fit:${str(g.n.imageObjectFit)};`;
  const value = at(g, "containerObjectFit", key);
  return truthy(value) ? `object-fit:${str(value)};` : undefined;
}

// Typography ─────────────────────────────────────────────────────────────────────────────────────

const fontColour = (g: Gen, key: string, prefix = "font"): Piece => {
  const value = at(g, `${prefix}TextColor`, key);
  const resolved = truthy(value) ? colour(g, value) : "";
  return resolved ? `color:${resolved};` : undefined;
};

const fontLinkColour = (g: Gen, key: string, prefix = "font"): Piece => {
  const value = at(g, `${prefix}TextLinkColor`, key);
  const resolved = truthy(value) ? colour(g, value) : "";
  return resolved ? `color:${resolved};` : undefined;
};

function fontSize(g: Gen, key: string, prefix = "font"): Piece {
  const value = at(g, `${prefix}Size`, key);
  const object = record(value);
  if (object && object.type === "fluid") {
    g.notes.add(`${prefix}Size (fluid)`);
    return undefined;
  }
  return truthy(value) ? `font-size:${str(value)};` : undefined;
}

const fontProp =
  (suffix: string, css: string) =>
  (g: Gen, key: string, prefix = "font"): Piece => {
    const value = at(g, `${prefix}${suffix}`, key);
    return truthy(value) ? `${css}:${str(value)};` : undefined;
  };

const fontWeight = fontProp("Weight", "font-weight");
const fontSpacing = fontProp("Spacing", "letter-spacing");
const fontHeight = fontProp("Height", "line-height");
const fontDecoration = fontProp("Decoration", "text-decoration");
const fontStyle = fontProp("Style", "font-style");
const fontTransform = fontProp("Transform", "text-transform");
const fontStretch = fontProp("Stretch", "font-stretch");

function fontText(g: Gen, key: string, prefix = "font"): Piece {
  const pick = (suffix: string): string => {
    const value = at(g, `${prefix}${suffix}`, key);
    return truthy(value) ? str(value) : "";
  };
  let out = "";
  const align = pick("Align");
  const wrap = pick("OverflowWrap");
  const space = pick("WhiteSpace");
  const breaks = pick("WordBreak");
  const words = pick("WordSpacing");
  if (align) out += `text-align:${align};`;
  if (wrap) out += `overflow-wrap:${wrap};`;
  if (space) out += `white-space:${space};`;
  if (breaks) out += `word-break:${breaks};`;
  if (words) out += `word-spacing:${words};`;
  return out || undefined;
}

function fontVariation(g: Gen, key: string, prefix = "font"): Piece {
  const axes = g.n[`${prefix}CustomAxes`];
  const slant = g.n[`${prefix}Slant`];
  if (!truthy(axes) && !truthy(slant)) return undefined;
  const stretch = g.n[`${prefix}Stretch`];
  const parts: string[] = [];
  if (truthy(axes)) {
    for (const [axis, values] of Object.entries(axes as Bag)) {
      const value = (values as Bag | undefined)?.[key];
      if (axis === "wdth" && truthy(value) && !(truthy(stretch) && truthy((stretch as Bag)[key]))) {
        parts.push(`'${axis}' ${str(value)}`);
      }
      if (axis === "slnt" && truthy(value) && !(truthy(slant) && truthy((slant as Bag)[key]))) {
        parts.push(`'${axis}' ${str(value)}`);
      }
      if (axis !== "wdth" && axis !== "slnt" && truthy(value))
        parts.push(`'${axis}' ${str(value)}`);
    }
  }
  if (truthy(slant) && truthy((slant as Bag)[key]))
    parts.push(`'slnt' ${str((slant as Bag)[key])}`);
  return parts.length > 0 ? `font-variation-settings: ${parts.join(", ")};` : undefined;
}

// Background ─────────────────────────────────────────────────────────────────────────────────────

function backgroundColour(g: Gen, key: string, prefix = "background"): Piece {
  const gradient = at(g, `${prefix}GradientSelected`, key);
  const value = at(g, `${prefix}Color`, key);
  const chosen =
    (!truthy(g.n[`${prefix}GradientSelected`]) || !truthy(gradient)) && truthy(value) ? value : "";
  const resolved = truthy(chosen) ? colour(g, chosen) : "";
  return resolved ? `background-color:${resolved};` : undefined;
}

/** Whether the block has a background picture at `key` (the editor's `a`). */
function hasPicture(g: Gen, key: string, prefix: string): boolean {
  const n = g.n;
  const type = at(g, `${prefix}Type`, key);
  const dynamicType = n[`${prefix}ImageType`] === "dynamic";
  return Boolean(
    (type === "image" && truthy(n[`${prefix}PictureURL`])) ||
    (dynamicType &&
      key === g.main &&
      (truthy(n.backgroundDynamicWordpressType) ||
        (truthy(n.backgroundDynamicACFField) && truthy(n.backgroundDynamicACFGroup)) ||
        truthy(n.backgroundDynamicRepeaterField))),
  );
}

function pictureValue(g: Gen, prefix: string): string {
  return g.n[`${prefix}ImageType`] === "dynamic"
    ? "var(--background-image)"
    : `url(${str(g.n[`${prefix}PictureURL`])})`;
}

/** `background-image` for a non-pseudo key (`vl`). */
function backgroundImage(g: Gen, key: string, prefix = "background"): Piece {
  const n = g.n;
  const picture = hasPicture(g, key, prefix);
  const url = pictureValue(g, prefix);
  const selected = n[`${prefix}GradientSelected`];
  const gradientOn = truthy(selected) ? (selected as Bag)[key] : undefined;
  const colourList = n[`${prefix}GradientColor`];
  const gradient = truthy(colourList) ? (colourList as Bag)[key] : undefined;
  let value = "";
  if ((truthy(selected) ? gradientOn === false : true) && picture) {
    value = url;
  } else if (truthy(selected) && gradientOn === true) {
    const type = at(g, `${prefix}Type`, key);
    if (truthy(type) && type !== "image") {
      value = truthy(gradient) ? str(gradient) : "";
    } else if (!truthy(colourList) || !truthy(gradient)) {
      value = picture ? `${url} ` : " ";
    } else {
      value = `${picture ? `${str(gradient)},` : str(gradient)}${picture ? url : ""} `;
    }
  }
  if (!value) return undefined;
  const resolved = g.palette(value);
  return `background-image:${resolved};`;
}

/** `background-image` for a pseudo key (`$Z`), which can have its own picture. */
function backgroundImagePseudo(g: Gen, key: string, prefix = "background"): Piece {
  const n = g.n;
  const picture = hasPicture(g, key, prefix);
  const url = pictureValue(g, prefix);
  const type = at(g, "backgroundImageTypePseudo", key);
  let own: string | false | undefined;
  if (type === "dynamic") own = `var(--background-image-${key}, unset)`;
  else if (type === "static") {
    const hover = at(g, "backgroundPictureURLHover", key);
    own = truthy(hover) ? `url(${str(hover)})` : false;
  }
  const selected = n[`${prefix}GradientSelected`];
  const gradientOn = truthy(selected) ? (selected as Bag)[key] : undefined;
  const colourList = n[`${prefix}GradientColor`];
  const gradient = truthy(colourList) ? (colourList as Bag)[key] : undefined;
  const fallback = truthy(own) ? str(own) : picture ? url : "";
  let c: string;
  if (!truthy(selected) || gradientOn === false || !truthy(gradientOn)) {
    c = fallback;
  } else if (gradientOn === true) {
    const mainType = at(g, "backgroundType", g.main);
    if (truthy(mainType) && mainType !== "image") {
      c = !truthy(colourList) || !truthy(gradient) ? "" : str(gradient);
    } else if (!truthy(colourList) || !truthy(gradient)) {
      c = fallback;
    } else {
      c = truthy(own) || picture ? `${str(gradient)}, ${fallback}` : str(gradient);
    }
  } else {
    c = "";
  }
  let value: string;
  if (!truthy(selected) || !truthy(gradientOn)) {
    value = truthy(own) ? c : "";
  } else {
    value = truthy(gradient)
      ? truthy(own)
        ? `${str(gradient)},${str(own)}`
        : picture
          ? `${str(gradient)},${url}`
          : str(gradient)
      : "";
  }
  if (!value) return undefined;
  return `background-image:${g.palette(value)};`;
}

function backgroundSize(g: Gen, key: string): Piece {
  const size = at(g, "backgroundSize", key);
  const width = at(g, "backgroundManualWidth", key);
  const height = at(g, "backgroundManualHeight", key);
  let value = "";
  if (truthy(size) && size !== "manual") value = str(size);
  else if (!truthy(width) && truthy(height)) value = `auto ${str(height)}`;
  else if (truthy(width) && !truthy(height)) value = `${str(width)} auto`;
  else if (truthy(width) && truthy(height)) value = `${str(width)} ${str(height)}`;
  return value ? `background-size:${value};` : undefined;
}

function backgroundPosition(g: Gen, key: string): Piece {
  const point = record(at(g, "backgroundFocalPoint", key));
  if (!point || !(truthy(point.x) || truthy(point.y))) return undefined;
  const axis = (v: unknown): string => {
    if (!truthy(v)) return "0%";
    if (typeof v === "string" && v.includes("var(--")) return v;
    return `${100 * Number(v)}%`;
  };
  return `background-position:${axis(point.x)} ${axis(point.y)};`;
}

const backgroundRepeat = prop("backgroundRepeat", "background-repeat");
const backgroundAttachment = prop("backgroundAttachment", "background-attachment");
const backgroundBlend = prop("backgroundBlendMode", "background-blend-mode");

function backgroundClip(g: Gen, key: string): Piece {
  const value = at(g, "backgroundClip", key);
  return truthy(value)
    ? `background-clip:${str(value)};-webkit-background-clip:${str(value)};`
    : undefined;
}

/** `blur(4px) brightness(…)` and so on, for the background's own backdrop filter and for effects. */
function filterList(g: Gen, key: string, prefix: string): string {
  let out = "";
  const get = (suffix: string): unknown => at(g, `${prefix}${suffix}`, key);
  const withUnit = (value: unknown, unit: string): string =>
    typeof value === "string" && value.includes("var(--") ? value : `${str(value)}${unit}`;
  if (truthy(get("Blur"))) out += `blur(${withUnit(get("Blur"), "px")})`;
  if (truthy(get("Brightness"))) out += `brightness(${str(get("Brightness"))})`;
  if (truthy(get("Contrast"))) out += `contrast(${withUnit(get("Contrast"), "%")})`;
  if (truthy(get("Grayscale"))) out += `grayscale(${withUnit(get("Grayscale"), "%")})`;
  if (truthy(get("HueRotate"))) out += `hue-rotate(${withUnit(get("HueRotate"), "deg")})`;
  if (truthy(get("Invert"))) out += `invert(${withUnit(get("Invert"), "%")})`;
  if (truthy(get("Saturate"))) out += `saturate(${str(get("Saturate"))}%)`;
  if (truthy(get("Sepia"))) out += `sepia(${withUnit(get("Sepia"), "%")})`;
  return out;
}

function backgroundBackdrop(g: Gen, key: string): Piece {
  const filter = filterList(g, key, "background");
  return filter ? `backdrop-filter:${filter};-webkit-backdrop-filter:${filter};` : undefined;
}

function overlayGradient(g: Gen, key: string, prefix = "background"): Piece {
  const selected = at(g, `${prefix}OverlayGradientSelected`, key);
  const value = at(g, `${prefix}GradientOverlayColor`, key);
  const chosen = truthy(selected) && truthy(value) ? str(value) : "";
  return chosen ? `background-image:${g.palette(chosen)};` : undefined;
}

function overlayColour(g: Gen, key: string, prefix = "background"): Piece {
  const selected = g.n[`${prefix}OverlayGradientSelected`];
  const value = at(g, `${prefix}OverlayColor`, key);
  const on = !truthy(selected) || !truthy((selected as Bag)[key]);
  const chosen = on && truthy(value) ? value : "";
  return truthy(chosen) ? `background-color:${colour(g, chosen)};` : undefined;
}

// Effects ────────────────────────────────────────────────────────────────────────────────────────

function opacity(g: Gen, key: string, prefix = "effects"): Piece {
  const value = at(g, `${prefix}Opacity`, key);
  return truthy(value) || value === 0 ? `opacity:${str(value)};` : undefined;
}

const mixBlend = (g: Gen, key: string, prefix = "effects"): Piece => {
  const value = at(g, `${prefix}MixBlendMode`, key);
  return truthy(value) ? `mix-blend-mode:${str(value)};` : undefined;
};

function effectFilter(g: Gen, key: string, prefix = "effects", property = "filter"): Piece {
  let out = filterList(g, key, prefix);
  const shadow = record(at(g, `${prefix}DropShadow`, key));
  if (shadow) {
    const lengthOf = (v: unknown): string => (truthy(v) || v === 0 ? str(v) : "");
    const x = lengthOf(shadow.x);
    const blur = lengthOf(shadow.blur);
    const y = lengthOf(shadow.y);
    const colourText = shadowColour(g, shadow.color);
    if (!(!x && x !== "0") && !(!blur && blur !== "0") && !(!y && y !== "0") && colourText) {
      out += `drop-shadow(${x} ${y} ${blur} ${colourText})`;
    }
  }
  return out ? `${property}:${out};` : undefined;
}

function textShadow(g: Gen, key: string): Piece {
  const colourValue = at(g, "effectsTextShadowColor", key);
  const resolved = truthy(colourValue) ? colour(g, colourValue) : "";
  const part = (name: string): string => {
    const value = at(g, name, key);
    if (!truthy(value)) return "0";
    return typeof value === "string" && value.includes("var(--") ? value : `${str(value)}px`;
  };
  const any = [
    "effectsTextShadowHorizontal",
    "effectsTextShadowVertical",
    "effectsTextShadowBlur",
  ].some((name) => truthy(at(g, name, key)));
  if (!any) return undefined;
  return `text-shadow:${part("effectsTextShadowHorizontal")} ${part("effectsTextShadowVertical")} ${part("effectsTextShadowBlur")} ${resolved};`;
}

function transition(g: Gen, key: string, name = "effectsTransition"): Piece {
  const n = g.n;
  const duration = truthy(at(g, "effectsTransitionDuration", key))
    ? `${str(at(g, "effectsTransitionDuration", key))}s`
    : "";
  const timing = truthy(at(g, "effectsTransitionTiming", key))
    ? str(at(g, "effectsTransitionTiming", key))
    : "";
  const delay = truthy(at(g, "effectsTransitionDelay", key))
    ? `${str(at(g, "effectsTransitionDelay", key))}s`
    : "";
  const css = truthy(at(g, "effectsTransitionCSS", key))
    ? str(at(g, "effectsTransitionCSS", key))
    : "";
  let out = "";
  const list: string[] = [];
  if (truthy(n.effectsTransition)) {
    const entries = at(g, name, key);
    if (truthy(entries)) {
      for (const entry of Object.values(entries as Bag)) {
        const item = record(entry);
        if (!item) continue;
        if (item.isSingle) {
          if (truthy(item.single)) list.push(str(item.single));
          continue;
        }
        const length =
          (truthy(item.duration) && numeric(item.duration)) || item.duration === 0
            ? `${parseFloat(str(item.duration))}s`
            : truthy(item.duration)
              ? str(item.duration)
              : "";
        const timingText = truthy(item.timing) ? str(item.timing) : "";
        const property = truthy(item.property) ? str(item.property) : "all";
        const wait =
          (truthy(item.delay) && numeric(item.delay)) || item.delay === 0
            ? `${parseFloat(str(item.delay))}s`
            : truthy(item.delay)
              ? str(item.delay)
              : "";
        if (length) list.push(`${property} ${length} ${timingText} ${wait}`);
      }
    }
    if (list.length > 0) out += `transition:${list.join(",")};`;
  } else if (truthy(at(g, "effectsTransitionDuration", key))) {
    if (duration) out += `transition-duration:${duration};`;
    if (timing) out += `transition-timing-function:${timing};`;
    if (delay) out += `transition-delay:${delay};`;
    if (css) out += `transition-property:${css};`;
  }
  return out || undefined;
}

function animation(g: Gen, key: string): Piece {
  const pick = (name: string, unit = ""): string => {
    const value = at(g, name, key);
    return truthy(value) ? `${str(value)}${unit}` : "";
  };
  const duration = pick("effectsAnimationDuration", "s");
  const timing = pick("effectsAnimationTiming");
  const delay = pick("effectsAnimationDelay", "s");
  const count = pick("effectsAnimationItiration");
  const direction = pick("effectsAnimationDirection");
  const fill = pick("effectsAnimationFillMode");
  const animationName = pick("effectsAnimationName");
  let out = "";
  if (duration) out += `animation-duration:${duration};`;
  if (timing) out += `animation-timing-function:${timing};`;
  if (delay) out += `animation-delay:${delay};`;
  if (count) out += `animation-iteration-count:${count};`;
  if (direction) out += `animation-direction:${direction};`;
  if (fill) out += `animation-fill-mode:${fill};`;
  if (animationName) out += `animation-name:${animationName};`;
  return out || undefined;
}

// Transforms ─────────────────────────────────────────────────────────────────────────────────────

function transforms(g: Gen, key: string): Piece {
  const n = g.n;
  const control = (name: string): unknown => {
    const spec = n[`${name}Spec`];
    return truthy(spec) && Object.keys(spec as Bag).length > 0 ? (spec as Bag)[key] : n[name];
  };
  const translate = control("transformsTranslateControl");
  const skew = control("transformsSkewControl");
  const rotate = control("transformsRotateControl");
  const perspective = control("transformsPerspectiveControl");
  const rotate3d = control("transformsRotate3DControl");
  const scale = control("transformsScaleControl");
  const angle = (name: string, fn: string): string => {
    const value = at(g, name, key);
    if ((truthy(value) && numeric(value)) || value === 0) return `${fn}(${str(value)}deg)`;
    return truthy(value) ? `${fn}(${str(value)})` : "";
  };
  const rx = truthy(rotate) ? angle("transformsRotateX", "rotateX") : "";
  const ry = truthy(rotate) ? angle("transformsRotateY", "rotateY") : "";
  const rz = truthy(rotate) ? angle("transformsRotateZ", "rotateZ") : "";
  const r = truthy(rotate) ? angle("transformsRotate", "rotate") : "";
  const skewAxis = (name: string, comma: boolean): string => {
    const value = at(g, name, key);
    if ((truthy(value) && numeric(value)) || value === 0)
      return `${comma ? "," : ""}${str(value)}deg`;
    return truthy(value) ? `${comma ? "," : ""}${str(value)}` : "";
  };
  const skewX = skewAxis("transformsSkewX", false);
  const skewY = skewAxis("transformsSkewY", true);
  const sk = truthy(skew) && skewX ? `skew(${skewX}${skewY})` : "";
  const tr = (name: string, fn: string): string => {
    const value = at(g, name, key);
    return truthy(translate) && truthy(value) ? `${fn}(${str(value)})` : "";
  };
  const tx = tr("transformsTranslateX", "translateX");
  const ty = tr("transformsTranslateY", "translateY");
  const tz = tr("transformsTranslateZ", "translateZ");
  const persp =
    truthy(perspective) && truthy(at(g, "transformsPerspective", key))
      ? `perspective:${str(at(g, "transformsPerspective", key))};`
      : "";
  const perspIndividual =
    truthy(perspective) && truthy(at(g, "transformsPerspectiveIndividual", key))
      ? `perspective(${str(at(g, "transformsPerspectiveIndividual", key))})`
      : "";
  const preserve =
    truthy(n.transformsPreserve3D) && key === g.main ? "transform-style: preserve-3d;" : "";
  const r3 =
    truthy(rotate3d) &&
    truthy(at(g, "transformsRotate3DX", key)) &&
    truthy(at(g, "transformsRotate3DY", key)) &&
    truthy(at(g, "transformsRotate3DZ", key)) &&
    truthy(at(g, "transformsRotate3DAngle", key))
      ? `rotate3d(${str(at(g, "transformsRotate3DX", key))},${str(at(g, "transformsRotate3DY", key))},${str(at(g, "transformsRotate3DZ", key))},${
          numeric(at(g, "transformsRotate3DAngle", key))
            ? `${str(at(g, "transformsRotate3DAngle", key))}deg`
            : str(at(g, "transformsRotate3DAngle", key))
        })`
      : "";
  const sx =
    truthy(scale) && truthy(at(g, "transformsScaleX", key))
      ? `scaleX(${str(at(g, "transformsScaleX", key))})`
      : "";
  const sy =
    truthy(scale) && truthy(at(g, "transformsScaleY", key))
      ? `scaleY(${str(at(g, "transformsScaleY", key))})`
      : "";
  const sz =
    truthy(scale) && truthy(at(g, "transformsScaleZ", key))
      ? `scaleZ(${str(at(g, "transformsScaleZ", key))})`
      : "";
  const list = [perspIndividual, rx, ry, rz, r, sk, tx, ty, tz, r3, sx, sy, sz];
  if (!(preserve || persp || list.some(Boolean))) return undefined;
  const hasTransform = [rx, ry, rz, r, sk, perspIndividual, tx, ty, tz, r3, sx, sy, sz].some(
    Boolean,
  );
  return `${preserve}${persp}${hasTransform ? "transform:" : ""}${list.join("")};`;
}

const transformOrigin = (g: Gen, key: string): Piece => {
  const value = at(g, "transformsOrigin", key);
  return truthy(value) ? `transform-origin:${str(value)};` : undefined;
};

// ── One rule ─────────────────────────────────────────────────────────────────────────────────────

/** The text of one `.classID{…}` rule for a key, in the generator's order for a base key. */
function baseBody(g: Gen, key: string): { own: string; wrapper: string } {
  const n = g.n;
  const out: Piece[] = [];
  // The old section layout keeps its layout and size on an inner wrapper element.
  const wrapperOut: Piece[] = [];
  const W = g.oldSection ? wrapperOut : out;
  const objectPosition = at(g, "imageObjectPosition", key);
  out.push(truthy(objectPosition) ? `object-position: ${str(objectPosition)};` : undefined);
  out.push(prop("interactionsCursor", "cursor")(g, key));
  out.push(prop("interactionsUserSelect", "user-select")(g, key));
  out.push(prop("interactionsPointerEvents", "pointer-events")(g, key));
  out.push(backgroundImage(g, key));
  out.push(backgroundColour(g, key));
  out.push(backgroundAttachment(g, key));
  out.push(backgroundBlend(g, key));
  out.push(backgroundClip(g, key));
  out.push(backgroundSize(g, key));
  out.push(backgroundPosition(g, key));
  out.push(backgroundRepeat(g, key));
  out.push(borderColour(g, key, "border"));
  out.push(borderRadius(g, key));
  out.push(borderWidth(g, key));
  out.push(boxShadow(g, key));
  out.push(borderStyle(g, key, "border"));
  out.push(outlineWidth(g, key));
  out.push(outlineOffset(g, key));
  out.push(borderStyle(g, key, "outline"));
  out.push(offsets(g, key));
  out.push(visibility(g, key));
  out.push(zIndex(g, key));
  out.push(overflow(g, key));
  out.push(...gridProps(g, key));
  out.push(fontColour(g, key));
  out.push(fontSize(g, key));
  out.push(fontWeight(g, key));
  out.push(fontSpacing(g, key));
  out.push(fontHeight(g, key));
  out.push(fontDecoration(g, key));
  out.push(fontStyle(g, key));
  out.push(fontTransform(g, key));
  out.push(fontStretch(g, key));
  out.push(fontVariation(g, key));
  out.push(fontText(g, key));
  out.push(box4(g, key, "margin", "margin"));
  out.push(box4(g, key, "scrollMargin", "margin"));
  out.push(transforms(g, key));
  out.push(transformOrigin(g, key));
  W.push(alignItems(g, key));
  out.push(alignContent(g, key));
  W.push(justifyContent(g, key));
  out.push(justifyItems(g, key));
  W.push(flexItem(g, key));
  out.push(positionOf(g, key));
  if (g.name !== "slider") W.push(display(g, key));
  W.push(flexDirection(g, key));
  W.push(flexWrap(g, key));
  W.push(sizeOf("containerSizeHeight", "height")(g, key));
  W.push(sizeOf("containerSizeMaxHeight", "max-height")(g, key));
  W.push(sizeOf("containerSizeMinHeight", "min-height")(g, key));
  W.push(sizeOf("containerSizeWidth", "width")(g, key));
  W.push(sizeOf("containerSizeMaxWidth", "max-width")(g, key));
  W.push(sizeOf("containerSizeMinWidth", "min-width")(g, key));
  W.push(sizeOf("containerAspectRatio", "aspect-ratio")(g, key));
  W.push(objectFit(g, key));
  out.push(opacity(g, key));
  out.push(mixBlend(g, key));
  out.push(effectFilter(g, key));
  out.push(effectFilter(g, key, "effectsBackdrop", "backdrop-filter"));
  out.push(textShadow(g, key));
  out.push(transition(g, key));
  out.push(animation(g, key));
  W.push(box4(g, key, "padding", "padding"));
  if (truthy(at(g, "transformsBackfaceVisibility", key))) {
    const value = str(at(g, "transformsBackfaceVisibility", key));
    out.push(`-webkit-backface-visibility:${value};backface-visibility:${value};`);
  }
  const skeletonWidth = at(g, "skeletonSizeWidth", key);
  if (truthy(skeletonWidth)) out.push(`--cc-skeleton-width:${str(skeletonWidth)};`);
  const skeletonHeight = at(g, "skeletonSizeHeight", key);
  if (truthy(skeletonHeight)) out.push(`--cc-skeleton-height:${str(skeletonHeight)};`);
  if (truthy(at(g, "buttonSpacing", key)))
    out.push(`column-gap:${px(at(g, "buttonSpacing", key))};`);
  if (truthy(at(g, "strokeWidth", key)))
    out.push(`stroke-width:${str(at(g, "strokeWidth", key))};`);
  if (truthy(at(g, "iconFill", key))) out.push(`fill:${colour(g, at(g, "iconFill", key))};`);
  if (truthy(at(g, "stroke", key))) out.push(`stroke:${colour(g, at(g, "stroke", key))};`);
  if (truthy(at(g, "listStylePosition", key)))
    out.push(`list-style-position:${str(at(g, "listStylePosition", key))};`);
  if (truthy(at(g, "listStyleType", key)))
    out.push(`list-style-type:${str(at(g, "listStyleType", key))};`);
  if (g.name !== "list" && truthy(at(g, "columnsCount", key)))
    out.push(`column-count:${str(at(g, "columnsCount", key))};`);
  void n;
  const join = (pieces: Piece[]): string =>
    pieces.filter((piece): piece is string => piece !== undefined).join("");
  return { own: join(out), wrapper: join(wrapperOut) };
}

/** The same for a pseudo key: the generator writes display and flex first. */
function pseudoBody(g: Gen, key: string): { own: string; wrapper: string } {
  const out: Piece[] = [];
  // The old section layout keeps its layout and size on an inner wrapper element.
  const wrapperOut: Piece[] = [];
  const W = g.oldSection ? wrapperOut : out;
  const objectPosition = at(g, "imageObjectPosition", key);
  out.push(truthy(objectPosition) ? `object-position: ${str(objectPosition)};` : undefined);
  W.push(display(g, key));
  W.push(alignItems(g, key));
  out.push(alignContent(g, key));
  W.push(justifyContent(g, key));
  out.push(justifyItems(g, key));
  W.push(flexItem(g, key));
  out.push(positionOf(g, key));
  W.push(flexDirection(g, key));
  W.push(flexWrap(g, key));
  out.push(prop("interactionsCursor", "cursor")(g, key));
  out.push(prop("interactionsUserSelect", "user-select")(g, key));
  out.push(prop("interactionsPointerEvents", "pointer-events")(g, key));
  out.push(backgroundImagePseudo(g, key));
  out.push(backgroundColour(g, key));
  out.push(backgroundAttachment(g, key));
  out.push(backgroundBlend(g, key));
  out.push(backgroundClip(g, key));
  out.push(backgroundSize(g, key));
  out.push(backgroundPosition(g, key));
  out.push(backgroundRepeat(g, key));
  out.push(borderColour(g, key, "border"));
  out.push(borderRadius(g, key));
  out.push(borderWidth(g, key));
  out.push(boxShadow(g, key));
  out.push(borderStyle(g, key, "border"));
  out.push(outlineWidth(g, key));
  out.push(borderStyle(g, key, "outline"));
  out.push(outlineOffset(g, key));
  out.push(offsets(g, key));
  out.push(visibility(g, key));
  out.push(zIndex(g, key));
  out.push(...gridProps(g, key));
  if (g.name !== "list") out.push(fontColour(g, key));
  out.push(fontSize(g, key));
  out.push(fontWeight(g, key));
  out.push(fontSpacing(g, key));
  out.push(fontHeight(g, key));
  out.push(fontDecoration(g, key));
  out.push(fontStyle(g, key));
  out.push(fontTransform(g, key));
  out.push(fontStretch(g, key));
  out.push(fontVariation(g, key));
  out.push(fontText(g, key));
  out.push(box4(g, key, "margin", "margin"));
  out.push(box4(g, key, "scrollMargin", "margin"));
  out.push(transforms(g, key));
  out.push(transformOrigin(g, key));
  W.push(sizeOf("containerSizeHeight", "height")(g, key));
  W.push(sizeOf("containerSizeMaxHeight", "max-height")(g, key));
  W.push(sizeOf("containerSizeMinHeight", "min-height")(g, key));
  W.push(sizeOf("containerSizeWidth", "width")(g, key));
  W.push(sizeOf("containerSizeMaxWidth", "max-width")(g, key));
  W.push(sizeOf("containerSizeMinWidth", "min-width")(g, key));
  W.push(sizeOf("containerAspectRatio", "aspect-ratio")(g, key));
  W.push(objectFit(g, key));
  out.push(opacity(g, key));
  out.push(mixBlend(g, key));
  out.push(effectFilter(g, key));
  out.push(effectFilter(g, key, "effectsBackdrop", "backdrop-filter"));
  out.push(textShadow(g, key));
  out.push(transition(g, key));
  out.push(animation(g, key));
  W.push(box4(g, key, "padding", "padding"));
  if (truthy(at(g, "buttonSpacing", key)))
    out.push(`column-gap:${px(at(g, "buttonSpacing", key))};`);
  if (truthy(at(g, "strokeWidth", key)))
    out.push(`stroke-width:${str(at(g, "strokeWidth", key))};`);
  if (truthy(at(g, "iconFill", key))) out.push(`fill:${colour(g, at(g, "iconFill", key))};`);
  if (truthy(at(g, "stroke", key))) out.push(`stroke:${colour(g, at(g, "stroke", key))};`);
  if (truthy(at(g, "listStylePosition", key)))
    out.push(`list-style-position:${str(at(g, "listStylePosition", key))};`);
  if (truthy(at(g, "listStyleType", key)))
    out.push(`list-style-type:${str(at(g, "listStyleType", key))};`);
  if (g.name !== "list" && truthy(at(g, "columnsCount", key)))
    out.push(`column-count:${str(at(g, "columnsCount", key))};`);
  const join = (pieces: Piece[]): string =>
    pieces.filter((piece): piece is string => piece !== undefined).join("");
  return { own: join(out), wrapper: join(wrapperOut) };
}

// Rules beyond the element's own ─────────────────────────────────────────────────────────────────

/** Blocks the generator treats as a grid of items. */
const COLUMN_LIKE = new Set(["columns", "query-template", "repeater", "taxonomyterms"]);

/** The rules the generator writes after the element's own, for a base key. */
function baseExtras(g: Gen, key: string, selector: string): string[] {
  const n = g.n;
  const out: string[] = [];
  const rule = (target: string, body: Piece): void => {
    if (body) out.push(`${target}{${body}}`);
  };
  // Columns: the grid, then one placement rule per item. The blocks that repeat their children only
  // lay them out as a grid when their display is one, at this breakpoint or at the main one.
  const isGrid = (k: string): boolean => display(g, k) === "display:grid;";
  if (COLUMN_LIKE.has(g.name) && (g.name === "columns" || isGrid(key) || isGrid(g.main))) {
    const template = at(g, "columnsTemplateColumns", key);
    const rowHeight = at(g, "columnsRowHeight", key);
    const rowGap = at(g, "columnsRowGap", key);
    const columnGap = at(g, "columnsColumnGap", key);
    // Masonry (`repeaterMasonry`, which a repeater, a query template and a term list have) is its own
    // rule on `.<classID>.cc-masonry`: equal tracks from the column count, the gaps, and none of the
    // grid builder's template, auto rows or item placement (the editor hides them for it).
    if (truthy(n.repeaterMasonry) && g.name !== "columns") {
      let masonry = "";
      if (truthy(template))
        masonry += `grid-template-columns: repeat(${str(template)}, minmax(0, 1fr));`;
      if (truthy(columnGap)) masonry += `column-gap: ${px(columnGap)};`;
      if (truthy(rowGap)) masonry += `row-gap: ${px(rowGap)};`;
      rule(`${selector}.cc-masonry`, masonry);
    } else {
      let body = g.name === "columns" ? "display: grid;" : "";
      if (truthy(n.columnsControl)) {
        if (truthy(n.columnsAutoTemplateControl)) {
          const minimum = at(g, "columnsMinimumColumnsWidth", key);
          body += `grid-template-columns: repeat(${truthy(n.columnsAutoFitControl) ? "auto-fit" : "auto-fill"}, minmax(${truthy(minimum) ? px(minimum) : ""}, 1fr));`;
        } else {
          const auto = at(g, "columnsAutoItems", key);
          if (truthy(auto) && truthy(template) && Array.isArray(auto)) {
            body += `grid-template-columns: ${auto.map((item) => `${str(record(item)?.w)}fr`).join(" ")};`;
          }
        }
      } else if (truthy(template)) {
        body += `grid-template-columns: repeat(${str(template)}, 1fr);`;
      }
      if (truthy(rowHeight)) body += `grid-auto-rows: minmax(${px(rowHeight)}, auto);`;
      if (truthy(rowGap)) body += `row-gap: ${px(rowGap)};`;
      if (truthy(columnGap)) body += `column-gap: ${px(columnGap)};`;
      rule(selector, body);
      const items = at(g, "columnsItems", key);
      if (!truthy(n.columnsControl) && truthy(template) && Array.isArray(items)) {
        items.forEach((entry, index) => {
          const item = record(entry);
          if (!item) return;
          const x = Number(item.x);
          const y = Number(item.y);
          const w = Number(item.w);
          const h = Number(item.h);
          out.push(
            `${selector} > div:nth-of-type(${index + 1}){grid-column: ${x + 1} / ${x + 1 + w};grid-row: ${y + 1} / ${y + 1 + h};}`,
          );
        });
      }
    }
  }
  if (g.name === "gallery") {
    const columns = at(g, "galleryColumns", key);
    const horizontal = at(g, "galleryHorizontalGutter", key);
    const vertical = at(g, "galleryVerticalGutter", key);
    let body = "";
    if (truthy(columns)) body += `grid-template-columns: repeat(${str(columns)}, minmax(0, 1fr));`;
    if (truthy(horizontal)) body += `column-gap: ${px(horizontal)};`;
    if (truthy(vertical)) body += `row-gap: ${px(vertical)};`;
    rule(`${selector} .cc-gallery`, body);
  }
  if (
    (g.name === "query-template" || g.name === "repeater" || g.name === "taxonomyterms") &&
    truthy(at(g, "repeaterWrapperDisplay", key))
  ) {
    rule(`${selector} > div`, "display:contents;");
  }
  gridItems(g, key).forEach((body, index) => {
    if (body) out.push(`${selector} :nth-child(${index + 1}){${body}}`);
  });
  const link = fontLinkColour(g, key);
  if (link) {
    if (g.name !== "button" && g.name !== "paragraph") rule(`${selector} a`, link);
    else rule(`a${selector},${selector} a`, link);
  }
  // The overlay lives on `:before`; its box is declared once, at the first breakpoint that has one.
  const overlay = [overlayGradient(g, key), overlayColour(g, key), backgroundBackdrop(g, key)]
    .filter(Boolean)
    .join("");
  if (overlay) {
    const box =
      g.overlayBox.size === 0 || (g.overlayBox.has(key) && !g.overlayBox.has(g.main))
        ? 'position: absolute;content: "";top: 0;right: 0;left: 0;bottom: 0;width: 100%;height: 100%;pointer-events: none;'
        : "";
    g.overlayBox.add(key);
    rule(`${selector}:before`, box + overlay);
  }
  const moved = transition(g, key);
  if (moved) rule(`${selector}:before`, moved);
  if (g.name === "icon" && (truthy(at(g, "iconSize", key)) || truthy(at(g, "fontSize", key)))) {
    const size = truthy(at(g, "iconSize", key))
      ? str(at(g, "iconSize", key))
      : str(at(g, "fontSize", key));
    rule(`${selector} svg`, `height:${size};width:${size};`);
  }
  if (["button", "navlink", "navdropdown"].includes(g.name) && truthy(at(g, "buttonSize", key))) {
    const size = str(at(g, "buttonSize", key));
    rule(`${selector} svg`, `height:${size};width:${size};`);
  }
  if (g.name === "column" && truthy(at(g, "columnOrder", key)))
    rule(selector, `order:${str(at(g, "columnOrder", key))};`);
  if (truthy(at(g, "galleryHeight", key)))
    rule(selector, `--cc-gallery-height: ${str(at(g, "galleryHeight", key))};`);
  if (g.name === "list") {
    const spacing = at(g, "listSpacing", key);
    const inline = truthy(n.listInline);
    if (truthy(at(g, "columnsCount", key))) {
      rule(`${selector} ul, ${selector} ol`, `column-count: ${str(at(g, "columnsCount", key))};`);
    }
    if (truthy(spacing)) {
      rule(
        `${selector} li`,
        inline
          ? `margin-right: ${str(spacing)};`
          : `padding-top: calc(${str(spacing)}/2);padding-bottom: calc(${str(spacing)}/2);`,
      );
      if (!inline) {
        rule(
          `${selector} ul ul li, ${selector} ol ol li, ${selector} ol ul li, ${selector} ul ol li`,
          `padding-top: ${str(spacing)} !important;padding-bottom: 0 !important;`,
        );
      }
    }
    const indent = at(g, "listIndent", key);
    if (truthy(indent))
      rule(`${selector} ul > li, ${selector} ol > li`, `margin-left: ${str(indent)};`);
    if (
      truthy(n.listIconActive) ||
      truthy(record(record(n.componentConnectors)?.iconActive)?.ref)
    ) {
      const gap = at(g, "listIconSpacing", key);
      const top = at(g, "listVerticalPosition", key);
      const size = at(g, "listIconSize", key);
      const own = at(g, "fontSize", key);
      let body = "";
      if (truthy(gap)) body += `margin-right: ${str(gap)};`;
      if (truthy(top)) body += `top: ${str(top)};`;
      if (truthy(size)) body += `font-size: ${str(size)};`;
      const box = truthy(size) ? str(size) : truthy(own) ? str(own) : "";
      if (box) body += `min-width: ${box};min-height: ${box};`;
      rule(`${selector}.cc-icon-list li:before `, body);
      const align = at(g, "listFlexAlign", key);
      if (truthy(align)) rule(`${selector}.cc-icon-list li `, `align-items: ${str(align)};`);
    }
  }
  return out;
}

/** The rules the generator writes after the element's own, for a pseudo key. */
function pseudoExtras(g: Gen, key: string, selector: string, pseudo: string): string[] {
  const out: string[] = [];
  const at2 = pseudoSelector(pseudo);
  const link = fontLinkColour(g, key);
  if (link) {
    if (g.name === "list") out.push(`${selector} li${at2} a{${link}}`);
    if (g.name !== "button" && g.name !== "list") out.push(`${selector}${at2} a{${link}}`);
    if (["button", "navlink", "navdropdown"].includes(g.name))
      out.push(`a${selector}${at2}{${link}}`);
  }
  const overlay = [overlayGradient(g, key), overlayColour(g, key), backgroundBackdrop(g, key)]
    .filter(Boolean)
    .join("");
  if (overlay) out.push(`${selector}${at2}::before{${overlay}}`);
  return out;
}

// The rules that do not depend on a breakpoint ───────────────────────────────────────────────────

/** `"Reem Kufi"`: a family with a space in it is quoted (`y` in the generator). */
const quoted = (family: string): string => (family.includes(" ") ? `"${family}"` : family);

/** The family a `fontFamily` value names: a font id (`google-poppins`) is looked up, a name stands for itself. */
function familyOf(g: Gen, ctx: Pick<ConvertCtx, "cwicly">, value: string): string | undefined {
  if (!value.includes("google-") && !value.includes("custom-")) return value;
  const slug = (family: string): string => family.toLowerCase().replaceAll(/\s+/g, "-");
  const font = ctx.cwicly.globalStyles.fonts.find(
    (f) =>
      f.key === value ||
      `${f.source === "google" ? "google" : "custom"}-${slug(f.family)}` === value,
  );
  if (!font) g.notes.add(`fontFamily ${value} (a font this site does not list)`);
  return font?.family;
}

/** `list`: the rules that do not depend on a breakpoint (bullets, icons, inline items). */
function listRules(g: Gen, selector: string): string[] {
  const n = g.n;
  const out: string[] = [];
  const connected = record(record(n.componentConnectors)?.iconActive)?.ref;
  const iconColour = at(g, "listIconColor", g.main);
  if (truthy(n.listInline)) out.push(`${selector} li{float: left;}`);
  if (truthy(n.listIconActive) || truthy(connected)) {
    out.push(`${selector} li{break-inside: avoid;}`);
    const masks = (svg: string): string =>
      `mask-image: url('data:image/svg+xml;charset=utf8,${svg}');-webkit-mask-image: url('data:image/svg+xml;charset=utf8,${svg}');mask-repeat: no-repeat;-webkit-mask-repeat: no-repeat;-webkit-mask-position-x: center;`;
    const icons = record(n.listIcons) ?? {};
    Object.values(icons).forEach((raw, index) => {
      const icon = record(raw);
      if (!icon || !truthy(icon.active)) return;
      let body = "";
      if (truthy(icon.unicode)) {
        body += `content: "";${masks(str(icon.unicode))}`;
        const own = record(icon.color)?.[g.main];
        if (truthy(own))
          body += `background-color: ${typeof own === "string" ? colour(g, own) : ""};`;
      }
      out.push(`${selector}.cc-icon-list li:nth-child(${index + 1}):before {${body}}`);
    });
    let body = "position: relative;";
    if (truthy(n.listIconUnicode) || truthy(record(record(n.componentConnectors)?.icon)?.ref)) {
      body += 'content: "";';
      const ref = record(record(n.componentConnectors)?.icon)?.ref;
      body += truthy(ref)
        ? `mask-image: var(--comp-${str(ref)});-webkit-mask-image: var(--comp-${str(ref)});mask-repeat: no-repeat;-webkit-mask-repeat: no-repeat;-webkit-mask-position-x: center;`
        : masks(str(n.listIconUnicode));
    }
    if (truthy(iconColour)) body += `background-color: ${colour(g, iconColour)};`;
    out.push(`${selector}.cc-icon-list li:before {${body}}`);
  } else {
    const position = truthy(n.listPosition) ? `list-style-position: ${str(n.listPosition)};` : "";
    if (truthy(n.listStyleUl) || position) {
      out.push(
        `${selector} ul {${truthy(n.listStyleUl) ? `list-style-type: ${str(n.listStyleUl)};` : ""}${position}}`,
      );
    }
    if (truthy(n.listStyleOl) || position) {
      out.push(
        `${selector} ol {${truthy(n.listStyleOl) ? `list-style-type: ${str(n.listStyleOl)};` : ""}${position}}`,
      );
    }
  }
  return out;
}

/** The rule at `.classID` that is written once, from the main breakpoint's values. */
function blockWide(g: Gen, ctx: Pick<ConvertCtx, "cwicly">, selector: string): string[] {
  const n = g.n;
  const out: string[] = [];
  let body = borderColour(g, g.main, "outline") ?? "";
  if (truthy(n.fontFamily)) {
    const family = familyOf(g, ctx, str(n.fontFamily));
    if (family) {
      const fallbacks = Array.isArray(n.fontFallbackFonts)
        ? (n.fontFallbackFonts as unknown[]).map(str)
        : [];
      body += `font-family:${[quoted(family), ...fallbacks].join(", ")};`;
    }
  }
  if (truthy(n.fontOverflow)) body += `overflow-wrap: ${str(n.fontOverflow)};`;
  if (truthy(n.backgroundClipPath) && truthy(n.backgroundClipPathBlob)) {
    g.notes.add("backgroundClipPath (a blob: the generator writes its SVG elsewhere)");
  } else if (truthy(n.backgroundClipPath) && truthy(n.backgroundClipPathContent)) {
    body += `clip-path: ${str(n.backgroundClipPathContent)};`;
  }
  if (body) out.push(`${selector}{${body}}`);
  for (const pseudo of g.pseudos) {
    const content = record(n.pseudoContent)?.[pseudo];
    const outline = borderColour(g, `${g.main}${pseudo}`, "outline");
    if (truthy(content) || outline) {
      out.push(
        `${selector}${pseudoSelector(pseudo)}{${truthy(content) ? `content:${str(content)};` : ""}${outline ?? ""}}`,
      );
    }
  }
  return out;
}

/**
 * A class name as a selector (CSS.escape): anything that is not a word character or a hyphen is
 * backslash-escaped, and a digit at the start (or after a leading hyphen) is a code-point escape,
 * because `.3col` is not a selector.
 */
export function cssIdent(name: string): string {
  let out = "";
  for (const [index, ch] of [...name].entries()) {
    const code = ch.codePointAt(0)!;
    if (/[0-9]/.test(ch) && (index === 0 || (index === 1 && name.startsWith("-")))) {
      out += `\\${code.toString(16)} `;
    } else if (ch === "-" && name.length === 1) {
      out += "\\-";
    } else if (/[\w-]/.test(ch) || code > 127) {
      out += ch;
    } else {
      out += `\\${ch}`;
    }
  }
  return out;
}

// Relative styles and component variants ──────────────────────────────────────────────────────────

/** Where the editor puts the pseudo it is writing a rule for (`*\/*type*\/*`), and its editing twin. */
const TYPE = "\u0000type";
const EDIT_TYPE = "\u0000edittype";

/** One rule of a relative style as selector text (module 10400 of the editor). */
function relativeRule(rule: Bag, classID: string, g: Gen): string | undefined {
  const combinator = truthy(rule.combinator)
    ? rule.combinator !== " "
      ? str(rule.combinator)
      : " "
    : "";
  const type = rule.selectorType;
  const selector = truthy(rule.selector) ? str(rule.selector) : "";
  if (rule.combinator === " , ") return `, .${classID}${TYPE}`;
  if (type === "empty" && rule.combinator === " ") return " ";
  if (type === "empty" && truthy(rule.combinator)) return combinator;
  if (!truthy(type) && selector) return `${combinator}[data-ccid="${selector}"]`;
  if (type === "class" && selector) {
    // The editor stores the uniqueID of the block it points at, and swaps in that block's classID
    // when it compiles (`t[e.selector]?.classID ? … : e.selector`); a global class id is the same.
    const named = relativeClass(g, selector);
    if (named === null) return undefined;
    return `${combinator}.${named}`;
  }
  if (type === "*") return `${combinator}*`;
  if (type === "attribute" && selector) return `${combinator}[${selector}]`;
  if ((type === "pseudoclasses" || type === "pseudoelements") && selector) {
    return `${combinator}${selector}${truthy(rule.selectorAdd) ? `(${str(rule.selectorAdd)})` : ""}`;
  }
  if (type === "type" && selector) return `${combinator}${selector}`;
  return "";
}

/** What a block's uniqueID (a UUID) looks like. */
const UNIQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The class a relative style's `class` selector stands for: an id resolved to its class (escaped),
 * a class the author typed (as typed, the editor writes it unchanged), or `null` for a block id
 * nothing could resolve, which would otherwise become a selector that matches nothing.
 */
function relativeClass(g: Gen, selector: string): string | null {
  const named = g.classOf(selector);
  if (named !== undefined) return cssIdent(named);
  if (UNIQUE_ID.test(selector)) {
    g.unresolvedSelectors.add(selector);
    return null;
  }
  return selector;
}

interface RelativeSelector {
  /** A free-form selector (`customRule`), `.blockclass` already the classID, `:pseudos` a placeholder. */
  custom?: string;
  /** An id in the rules could not be resolved to a class: the style has no selector. */
  broken?: boolean;
  /** What follows the block's own class. */
  rules: string;
  /** What precedes it. */
  before: string;
}

function relativeSelector(style: Bag, classID: string, g: Gen): RelativeSelector {
  if (truthy(style.customRule)) {
    const custom = str(style.customRule)
      .replaceAll(/.blockclass/gi, `.${classID}${EDIT_TYPE}`)
      .replaceAll(/:pseudos/gi, TYPE);
    return { custom, rules: "", before: "" };
  }
  let broken = false;
  const join = (list: unknown): string => {
    if (!Array.isArray(list)) return "";
    let text = "";
    for (const item of list) {
      const part = relativeRule(record(item) ?? {}, classID, g);
      if (part === undefined) broken = true;
      else text += part;
    }
    return text;
  };
  const rules = join(style.rules);
  const before = join(style.beforeRules);
  return { rules, before, ...(broken ? { broken } : {}) };
}

/** The selector a relative-style rule is written under, for no pseudo or for one. */
function relativeTarget(
  sel: RelativeSelector,
  classID: string,
  pseudo: string | undefined,
  anchor = false,
): string {
  const plain = (text: string): string => text.replaceAll(EDIT_TYPE, "").replaceAll(TYPE, "");
  // A link colour is written on the anchor that is the block itself: `a.<classID>` (a custom rule
  // gets an `a` in front, which is how the editor writes it).
  const a = anchor ? "a" : "";
  if (sel.custom !== undefined) {
    if (pseudo === undefined) return `${a}${plain(sel.custom)}`;
    return `${a}${sel.custom.replaceAll(EDIT_TYPE, "").replaceAll(TYPE, pseudoSelector(pseudo))}`;
  }
  if (pseudo === undefined) return `${plain(sel.before)}${a}.${classID}${plain(sel.rules)}`;
  const state = pseudoSelector(pseudo);
  return `${sel.before.replaceAll(TYPE, state)}${a}.${classID}${state}${sel.rules.replaceAll(TYPE, state)}`;
}

/** The rules of one block's relative styles (`rs<bp><id>`) and component variants (`cs<bp><id>`). */
function relativeRules(
  g: Gen,
  classID: string,
  variants: readonly string[],
  preferScss: boolean,
): { css: string; media: string }[] {
  const out: { css: string; media: string }[] = [];
  const styles = Array.isArray(g.n.relativeStyles) ? (g.n.relativeStyles as unknown[]) : [];
  const targets: { id: string; prefix: "rs" | "cs"; selector?: RelativeSelector }[] = [];
  for (const raw of styles) {
    const style = record(raw);
    if (!style || style.visibility || !truthy(style.id)) continue;
    const selector = relativeSelector(style, classID, g);
    // A selector that cannot be written is left out whole: with its rules missing it would style the block itself.
    if (selector.broken) continue;
    targets.push({ id: str(style.id), prefix: "rs", selector });
  }
  for (const id of variants) targets.push({ id, prefix: "cs" });
  for (const key of g.keys) {
    for (const target of targets) {
      const full = `${target.prefix}${key}${target.id}`;
      const selectorFor = (pseudo: string | undefined, anchor = false): string =>
        target.selector
          ? relativeTarget(target.selector, classID, pseudo, anchor)
          : `${anchor ? "a" : ""}.${classID}.cs-${target.id}${pseudo === undefined ? "" : pseudoSelector(pseudo)}`;
      let css = "";
      const whole = baseBody(g, full);
      const base = whole.own + whole.wrapper;
      if (base) css += `${selectorFor(undefined)}{${base}}`;
      const link = fontLinkColour(g, full);
      if (link) css += `${selectorFor(undefined, true)}{${link}}`;
      if (target.prefix === "rs") {
        const size = at(g, "relativeStylesIconSize", full);
        const colourValue = at(g, "relativeStylesIconColor", full);
        if (truthy(colourValue))
          css += `${selectorFor(undefined)} svg{color:${colour(g, colourValue)};}`;
        if (truthy(size))
          css += `${selectorFor(undefined)} svg{height:${str(size)};width:${str(size)};}`;
      }
      for (const pseudo of g.pseudos) {
        const state = pseudoBody(g, `${full}${pseudo}`);
        const body = state.own + state.wrapper;
        if (body) css += `${selectorFor(pseudo)}{${body}}`;
        const pseudoLink = fontLinkColour(g, `${full}${pseudo}`);
        if (pseudoLink) css += `${selectorFor(pseudo, true)}{${pseudoLink}}`;
      }
      // The author's own CSS for the relative style, with `.relativestyle` standing for its selector.
      const compiled = record(g.n.customSCSSExtras)?.[full];
      const written = record(g.n.customCSSExtras)?.[full];
      // The editor tests the written CSS first, so an author who only has the compiled text has none.
      const extra = truthy(written)
        ? preferScss && truthy(compiled)
          ? compiled
          : written
        : undefined;
      if (target.prefix === "rs" && typeof extra === "string" && extra.trim() !== "") {
        css += extra.replaceAll(".relativestyle", selectorFor(undefined));
      }
      if (css) out.push({ css, media: key });
    }
  }
  return out;
}

// ── The whole block ──────────────────────────────────────────────────────────────────────────────

/** `:hover`, and `::before` for the two pseudo-elements. */
const pseudoSelector = (pseudo: string): string =>
  pseudo === "before" || pseudo === "after" ? `::${pseudo}` : `:${pseudo}`;

/** The media query a breakpoint key stands for, written the way Cwicly writes it. */
function mediaOf(g: Gen, breakpoints: readonly BreakpointLike[], key: string): string | undefined {
  if (key === g.main) return undefined;
  const bp = breakpoints.find((b) => b.key === key);
  if (!bp) return undefined;
  return `@media screen and (${bp.direction === "min" ? "min" : "max"}-width: ${bp.width}px)`;
}

interface BreakpointLike {
  key: string;
  width: number;
  isMain: boolean;
  direction: "min" | "max" | "none";
}

export interface AttrStyleOptions {
  /** The block's name (`cwicly/section` or `section`): decides the defaults it has. Without it no default applies. */
  blockName?: string;
  /** The class the rules are written for; any name will do when only the style is wanted. */
  classID?: string;
  /**
   * The ids of the component variants the block can be styled for (`cs<bp><id>` attributes, written
   * as `.<classID>.cs-<id>`): the `variants` of the component the block belongs to.
   */
  variants?: readonly string[];
  /** The site's SCSS option is on: `customSCSSExtras` (compiled) is printed rather than `customCSSExtras`. */
  scssCompiler?: boolean;
  /**
   * The classID of the block a uniqueID names. A relative style's `class` selector holds the target's
   * uniqueID, not a class (the editor swaps it for the block's classID when it compiles), and only
   * the block tree knows the answer: `styleBlock` supplies it. Without it an id (a UUID) the
   * block's global classes do not name is left out and listed in `unresolvedSelectors`.
   */
  classOf?: (uniqueID: string) => string | undefined;
}

export interface AttrStyleResult {
  /** The Jx style, in the shape the CSS reader gives a real rule. */
  style: JxStyle;
  /**
   * The old section layout's inner element (`<classID>-wrapper`): its layout, size and padding.
   * Absent for every other block.
   */
  wrapper?: JxStyle;
  /**
   * The rules the CSS reader files outside the class's own tree, keyed by selector, as `ctx.css.other`
   * is: the ones with a second class in the first compound (`.<classID>.cs-<variant>`,
   * `.<classID>.cc-icon-list li::before`). `styleBlock` places them as nested keys.
   */
  other: ReadonlyMap<string, JxStyle>;
  /** The CSS text the attributes compiled to (for tests and for inspection). */
  css: string;
  /** Attributes shaped like styles, with a value, that no ported family read. */
  unsupported: string[];
  /** Palette ids the attributes name that the palette does not have. */
  unresolvedPalette: string[];
  /**
   * Block ids a relative style's class selector names that nothing resolved to a class. The rules of
   * those styles are not in `style` (an id is not a class name, so any rule written for it matches nothing).
   */
  unresolvedSelectors: string[];
  /** Things the port met and could only approximate (`fontSize (fluid)`). */
  notes: string[];
}

/** An attribute value that looks like one of Cwicly's style attributes: an object keyed by breakpoint and pseudo. */
function looksLikeStyle(value: unknown, keys: readonly string[]): boolean {
  const bag = record(value);
  if (!bag) return false;
  const names = Object.keys(bag);
  if (names.length === 0) return false;
  return names.every((name) => /^(?:rs|cs)/.test(name) || keys.some((k) => name.startsWith(k)));
}

const hasValue = (value: unknown): boolean => {
  if (value === undefined || value === null || value === "" || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  const bag = record(value);
  if (bag) return Object.values(bag).some(hasValue);
  return true;
};

/**
 * Attributes that are not style however they look: a block's own data that happens to be keyed by
 * breakpoint, or by something that begins like one.
 */
const INERT = new Set([
  // Read by the generator only for the grid blocks and the layouts that use them; on any other
  // block, or with the other layout mode on, they change nothing.
  "columnsAutoItems",
  "columnsItems",
  "columnsTemplateColumns",
  "columnsColumnGap",
  "columnsRowGap",
  "columnsRowHeight",
  "columnsMinimumColumnsWidth",
  // Inputs of the clip-path blob generator, which writes an SVG, not CSS.
  "backgroundClipRandomn",
  "backgroundClipComplexity",
  "backgroundClipHeight",
]);

const NOT_STYLE = new Set([
  "interactions",
  "metadata",
  "lock",
  "componentConnectors",
  "properties",
  "listIcons",
]);

/** The attribute-to-CSS port, with its report. */
export function attrStyleDetailed(
  attrs: Attrs,
  ctx: Pick<ConvertCtx, "cwicly">,
  opts: AttrStyleOptions = {},
): AttrStyleResult {
  const name = (opts.blockName ?? "").replace(/^cwicly\//, "");
  const oldSection = name === "section" && ctx.cwicly.deprecated.oldSectionLayout;
  const defaults = blockDefaults(name, ctx.cwicly.optimise.cwiclyDefaults);
  const merged: Attrs = { ...defaults, ...attrs };
  const read = new Set<string>();
  const proxy = new Proxy(merged, {
    get(target, property, receiver) {
      if (typeof property === "string") read.add(property);
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const unresolved = new Set<string>();
  const palette = (text: string): string => {
    if (!text.includes("!var=")) return text;
    const result = resolvePaletteRefs(text, ctx.cwicly.globalStyles.colorRefs);
    for (const id of result.unresolved) unresolved.add(id);
    return result.text;
  };
  const breakpoints = ctx.cwicly.breakpoints;
  const main = breakpoints.find((bp) => bp.isMain)?.key ?? "lg";
  const keys = breakpoints.map((bp) => bp.key);
  const own = Array.isArray(merged.pseudoClasses)
    ? (merged.pseudoClasses as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  const pseudos = ["hover", "active", "focus", "before", "after", ...own];
  const gen: Gen = {
    n: proxy,
    name,
    main,
    keys,
    pseudos,
    palette,
    notes: new Set(),
    overlayBox: new Set(),
    oldSection,
    classOf: (id) => {
      // Only a UUID is a block's uniqueID; a global class id (15 characters) is not.
      const block = UNIQUE_ID.test(id) ? opts.classOf?.(id) : undefined;
      return block || ctx.cwicly.globalClassNames.get(id) || undefined;
    },
    unresolvedSelectors: new Set(),
  };
  const classID =
    opts.classID ?? (typeof attrs.classID === "string" && attrs.classID ? attrs.classID : "block");
  // A classID is a class name, and a name with a dot or a colon in it, or a digit first, is one only when escaped.
  const escaped = cssIdent(classID);
  const selector = `.${escaped}`;
  let css = blockWide(gen, ctx, selector).join("");
  if (name === "list") css += listRules(gen, selector).join("");
  const emit = (rules: string[], key: string): void => {
    const text = rules.join("");
    if (!text) return;
    const media = mediaOf(gen, breakpoints, key);
    css += media ? `${media}{${text}}` : text;
  };
  for (const key of keys) {
    const rules: string[] = [];
    const base = baseBody(gen, key);
    if (base.own) rules.push(`${selector}{${base.own}}`);
    if (base.wrapper) rules.push(`${selector}-wrapper{${base.wrapper}}`);
    rules.push(...baseExtras(gen, key, selector));
    for (const pseudo of pseudos) {
      const body = pseudoBody(gen, `${key}${pseudo}`);
      const state = `${selector}${pseudoSelector(pseudo)}`;
      if (body.own) rules.push(`${state}{${body.own}}`);
      if (body.wrapper) rules.push(`${state} ${selector}-wrapper{${body.wrapper}}`);
      rules.push(...pseudoExtras(gen, `${key}${pseudo}`, selector, pseudo));
    }
    emit(rules, key);
  }
  for (const rule of relativeRules(gen, escaped, opts.variants ?? [], opts.scssCompiler === true)) {
    const media = mediaOf(gen, breakpoints, rule.media);
    css += media ? `${media}{${rule.css}}` : rule.css;
  }
  const index = parseCwiclyCss(css, breakpoints, {
    palette: [...ctx.cwicly.globalStyles.colorRefs.values()],
  });
  const style = index.classes.get(classID)?.style ?? {};
  const wrapper = index.classes.get(`${classID}-wrapper`)?.style;
  const other = new Map<string, JxStyle>();
  for (const [selector, value] of index.other) other.set(selector, value);
  const unsupported: string[] = [];
  for (const [attribute, value] of Object.entries(attrs)) {
    if (read.has(attribute) || NOT_STYLE.has(attribute) || INERT.has(attribute)) continue;
    if (looksLikeStyle(value, keys) && hasValue(value)) unsupported.push(attribute);
  }
  return {
    style,
    ...(wrapper && Object.keys(wrapper).length > 0 ? { wrapper } : {}),
    other,
    css,
    unsupported,
    unresolvedPalette: [...unresolved],
    unresolvedSelectors: [...gen.unresolvedSelectors],
    notes: [...gen.notes],
  };
}

/**
 * The style a block's attributes compile to: `attrStyleDetailed(...).style`. Pass the block's name
 * in `opts` for the defaults its type has.
 */
export function attrStyle(
  attrs: Attrs,
  ctx: Pick<ConvertCtx, "cwicly">,
  opts: AttrStyleOptions = {},
): JxStyle {
  return attrStyleDetailed(attrs, ctx, opts).style;
}
