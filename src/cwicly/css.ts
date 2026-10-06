/**
 * Cwicly's generated stylesheets, read back into Jx style objects.
 *
 * Cwicly compiles every block's style attributes to flat `.classID` rules inside the editor and
 * saves the text as files; nothing about the attributes survives in the CSS except what a browser
 * needs. This module is the inverse. It is deliberately a reader of CSS, not of the attribute
 * objects, because the CSS is what the live site actually renders (cascade quirks included) and the
 * attribute-to-CSS generator is 135 KB of minified editor code that is not worth re-deriving.
 *
 * What the real corpus contains (155 files: 105 fineline + 50 ap; 11,370 rules, 32,095
 * declarations, no comments, one empty file), counted per selector after splitting selector lists on
 * their top-level commas (11,484 selectors):
 *
 *   one class, nothing else                       9,907   `.section-default`
 *   one class + pseudo-class/element/attribute       63   `.button-default:hover`, `.section-hero:before`
 *   class + descendant combinator + more            982   `.icon-large svg`, `.menu-c0 .cc-menu-dropdown`
 *   class + child combinator + more                 372   `.columns-c0 > div:nth-of-type(1)`
 *   tag-qualified class                              26   `a.paragraph-c8f5985`, `a.button-default:hover`
 *   other (24 distinct selectors)                    34   two classes in the first compound (21:
 *                                                          `.div-cf3ac5e.cs-bmuh8n`, `.list-c0.cc-icon-list li::before`),
 *                                                          `fieldset#give_cc_fields` (7), `:where(.a .b)` (5), `body`
 *   `undefined` selectors (artifacts)                96   `.undefined{}` (90), `undefinedsection-c0c88bd p` (6)
 *   empty class name (artifacts)                      4   `.{align-items:center;…}` (a block whose classID is empty)
 *
 * `bun test tests/cwicly/css.test.ts` pins these figures. Every media query is `screen and
 * (max-width: 992px|576px)`; the only at-rules besides `@media` are two Google Fonts `@import`s.
 * The generator's bugs are visible in the output and are reported, never emitted: the 100 selectors
 * above (`.undefined{}` and `.{}` for a block that has no classID, and `undefined` standing where `.`
 * + a classID belongs in the later members of a comma-joined list), and 138 values a browser throws
 * away: 63 `width:[object Object]px` and 24 `polygon(undefined% undefined%,…)` clip paths (a JS value
 * stringified into CSS), 35 empty (`column-gap:  ;`, `background-image: ;`), 14
 * `repeat(auto-fit, minmax(, 1fr))` (a template variable that was empty) and 2 `padding:
 * 0px!important 2px`. One `fill:!var=9d4k1!` is a palette reference the generator did not resolve (the
 * colour exists: White, `--cc-color-5`). Compiled-CSS options add native CSS Nesting:
 * `cwicly_global_css` puts its palette classes inside `:root, .light {…}`.
 *
 * Decisions that are not obvious from the code:
 *
 * - `.a .b` (the class IS first) nests under `a` as `& .b`: the rule is about a descendant of that
 *   block, so it travels with the block's style. Only a first compound that is not exactly one
 *   class (optionally tag-qualified, optionally with pseudo-classes/attributes) goes to `other`,
 *   with the selector as its key.
 * - Cwicly's `.cls.cs-<variant>` rules (component variants) have two classes in the first compound,
 *   so they land in `other` under the raw selector, as the contract says.
 * - A selector no browser accepts is not placed: an empty class name (`.`), a name that is not an
 *   identifier (`.1a`, `.-`), an attribute selector with no name (`[]`). The parser reads them all
 *   as selectors, and a rule a browser throws away would otherwise be applied.
 * - Property names follow `camelToKebab` in `@jxsuite/runtime/css`, which only restores a leading
 *   dash from a capital letter: `-webkit-line-clamp` is `WebkitLineClamp`, `-ms-x` is `MsX` (React's
 *   `msX` would come back as `ms-x`). Every key this module writes survives that round trip, and a
 *   name that cannot is reported instead of emitted.
 * - Autoprefixer output is collapsed: a vendor-prefixed property whose unprefixed twin is in the
 *   same rule is dropped, and so is a vendor-prefixed value that a later declaration of the same
 *   property supersedes (`width:-moz-fit-content;width:fit-content`). Prefixed-only properties
 *   (`-webkit-line-clamp`, `-moz-column-break-inside`) are kept.
 * - Repeated declarations merge in source order, as the cascade resolves them, with one exception
 *   the cascade also makes: an `!important` declaration is not overridden by a later plain one. A
 *   replacement keeps the first declaration's place, except beside a shorthand or longhand of the same
 *   property (`padding-top` and `padding`), where the order IS the cascade and it moves to the end.
 * - A declaration a browser discards (an empty value, an empty function argument, `u002d` for `--`,
 *   an `!important` mid-value) is reported and dropped like the generator's other artifacts. Kept, it
 *   would replace the earlier valid declaration, which the browser never lets it do.
 * - Main-breakpoint rules are unwrapped; `@media screen and (max-width: 992px)` becomes `"@--md"`
 *   (the key `$media` declares), and any other query survives as a literal at-rule key and is
 *   reported. `screen and` is dropped on the way, as `$media` does.
 * - `@supports`, `@container`, `@layer` and friends nest the same way `@media` does, because Jx
 *   emits any `@` key it does not recognise verbatim around the rules inside.
 * - Nested rules (CSS Nesting) are flattened against each member of the parent's selector list, so
 *   `:root, .light { .x {…} }` is `:root .x` (kept under `other`) and `.light .x` (`"& .x"` on `light`).
 * - A class's tree is in the order Jx emits it: its own declarations (one rule, written first), then
 *   nested selectors, then at-rules, each group in the order of first appearance. Cwicly writes a
 *   file the same way (main breakpoint first, then one block per breakpoint), but a breakpoint rule
 *   can open a class early (the nav's `.cc-nav-toggle` rule, written before the base rules), and
 *   the base rules written after it must still be emitted before the block that overrides them. A
 *   base rule that FOLLOWS a responsive rule for the same property cannot be a tree and is reported
 *   (`css.cascade-order`); `projectStyles` has no such limit.
 * - Source order between classes, and between files, is not in the trees: `.a{x} .b{y} .a{z}` is
 *   `.a{x z} .b{y}`, which puts `.a`'s late rule before `.b`'s and gives an element carrying both the
 *   wrong value; so does `.featured-columns{padding:2rem}` at 576px against
 *   `.columns-c3975bf{padding-top:0px}` (two real posts, at 576px). The index also keeps `rules`, one
 *   entry per rule in file order, and `projectStyles` lays them out as `project.json` `style`
 *   objects in Cwicly's own layout (base rules, then one block per breakpoint), starting a new object
 *   only where that layout would put a declaration ahead of one that overrides it. That is the
 *   cascade of the files, for every real file and page here; per-class trees are not, and are right
 *   only where an element carries one class of a stylesheet.
 * - Stylesheets are per page, not per site: classIDs repeat across posts (a duplicated page keeps
 *   its block ids) with different declarations, so one index must be built from the stylesheets
 *   one page loads, in its load order, never from every file at once. Merged, the trees say "the
 *   later file wins" (a later file's base rule beats an earlier file's media rule in the cascade,
 *   and a tree emits base rules first); the merged `rules` keep one layer per file, and
 *   `projectStyles` emits the layers one after the other.
 * - A stylesheet postcss refuses is read rule by rule, as a browser reads it: a stray `}` costs the
 *   rule after it, a block left open at the end of the file is closed there, a bad declaration costs
 *   itself. Everything lost is reported with its line. Nesting deeper than 64 blocks is skipped.
 * - An index owns its style objects and hands them out as they are: clone one before editing it.
 *   `mergeCssIndexes` always returns copies, so merging is also how to take a private index.
 */
import postcss from "postcss";
import type { AtRule, Declaration, Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";
import type { Breakpoint, ClassStyle, CssIndex, CssSource, JxStyle } from "../types.ts";

type Artifact = CssIndex["artifacts"][number];

/** Stable artifact codes, as they reach the migration report. */
export const CSS_ARTIFACT = {
  /**
   * `!var=<id>!`: the generator wrote a palette reference and never resolved it. The declaration is
   * dropped, unless the caller supplied the palette and it names the id (then it becomes the
   * colour's custom property).
   */
  unresolvedPaletteVar: "css.unresolved-palette-var",
  /**
   * A selector built from the literal word `undefined`, or from nothing at all (`.`): a block
   * without a classID. Dropped.
   */
  undefinedSelector: "css.undefined-selector",
  /**
   * A declaration a browser would throw away, so it must not reach the index (where it would replace
   * an earlier valid value): a value built from `undefined` or `[object Object]` (a JS value
   * stringified into CSS), an empty value, an empty function argument (`minmax(, 1fr)`), a `u002d`
   * where `--` was written, an `!important` in the middle of a value. Dropped.
   */
  invalidValue: "css.invalid-value",
  /** An unresolved render-time token (`{imagesrc=12}`, `<ccd>…</ccd>`) in a value or selector. Dropped. */
  token: "css.token",
  /** A selector, at-rule, nested rule or property name this module has no representation for. Dropped. */
  unclassified: "css.unclassified",
  /** A media query that names no declared breakpoint. Kept under a literal at-rule key. */
  mediaUnmapped: "css.media-unmapped",
  /** A stylesheet the source did not have. Reported by `loadCssIndex`. */
  missingFile: "css.missing-file",
  /**
   * Text postcss could not parse. The rest of the stylesheet is kept (browsers recover rule by
   * rule), and each rule or declaration that was lost, and each block closed at the end of the
   * file, is reported with its line.
   */
  syntaxError: "css.syntax-error",
  /**
   * A rule outside every at-rule that follows a responsive rule of the same selector and sets the
   * same property to another value. A browser keeps the later rule. A class's tree emits its base
   * rules before its responsive ones, so there the responsive value wins at its breakpoint instead.
   * The tree is kept as it is, and this reports it; `projectStyles` lays the rules out in the order
   * of the file and does not have the problem.
   */
  cascadeOrder: "css.cascade-order",
} as const;

/** A palette colour, in the shape `CwiclyOptions.globalStyles.colors` already has. */
export interface PaletteColour {
  /** The id a stylesheet refers to as `!var=<id>!`. */
  id: string;
  /** The custom property, with or without its dashes: `cc-color-5` or `--cc-color-5`. */
  variable: string;
}

export interface ParseOptions {
  /**
   * The stylesheet's name: set as `file` on every artifact, and appended to its `detail` so that a
   * report line read on its own says which file it came from.
   */
  file?: string | undefined;
  /**
   * The site's palette. A `!var=<id>!` the generator left unresolved is replaced by the colour's
   * custom property when the id is in it, and reported (as unknown) only when it is not. Without a
   * palette the module cannot tell a deleted colour from one the generator merely forgot to
   * resolve, so it reports every one as unresolved and says nothing more.
   */
  palette?: readonly PaletteColour[] | undefined;
}

/**
 * One rule of a stylesheet: a selector, the at-rules around it, and the declarations it carries.
 * The unit of the cascade, and the only thing that keeps the source order the trees give up.
 */
export interface CssRulePart {
  /**
   * Which stylesheet it came from, counting the stylesheets merged together from 0. A rule of a
   * later layer follows every rule of an earlier one, whatever media query either sits in.
   */
  layer: number;
  /** The whole selector, escaped as CSS: `.section-hero`, `.a:hover svg`, `body`, `:root .x`. */
  selector: string;
  /** The at-rule keys it sits inside, outermost first: `@--md`, `@supports (display: grid)`. */
  context: readonly string[];
  /** Jx style keys and values, in source order, artifacts and autoprefixer twins already removed. */
  declarations: readonly (readonly [key: string, value: string])[];
}

/**
 * A `CssIndex` that also keeps the rules in source order.
 *
 * The trees in `classes` and `other` merge every rule of a selector into one place, which is what a
 * converter wants per block and cannot carry the order BETWEEN classes (`.a{x} .b{y} .a{z}`) or
 * between a base rule and a responsive one of another class. `rules` can: it is the stylesheet, one
 * entry per rule. `projectStyles` lays it out for Jx; `mergeCssIndexes` and `loadCssIndex` keep it
 * across files, with one layer per file.
 *
 * `rules` is the stylesheet as it was read: edit an index's trees and it does not follow. (An
 * index with no `rules` at all, such as one built by hand, is read from its trees instead.)
 */
export interface OrderedCssIndex extends CssIndex {
  rules: readonly CssRulePart[];
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────

/** Trim and collapse whitespace runs to one space, leaving quoted strings (URLs, font names) exactly as written. */
const collapse = (text: string): string =>
  text
    .trim()
    .replace(
      /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\s+/g,
      (_, quoted: string | undefined) => quoted ?? " ",
    );

/** Quoted CSS in a report is cut to a readable length: a hostile file can make one value or selector as long as itself. */
const clip = (text: string, limit = 300): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const isBlock = (value: unknown): value is JxStyle =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isImportant = (value: unknown): boolean =>
  typeof value === "string" && /!\s*important\s*$/i.test(value);

/** The inverse Jx applies to a style key (`camelToKebab` in `@jxsuite/runtime/css`). */
const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const EDGES = ["top", "right", "bottom", "left"];
/**
 * Shorthands and the longhands they set, where a longhand's name does not simply extend the
 * shorthand's (`padding` sets `padding-top`, which needs no entry; `gap` sets `row-gap`, and `font`
 * sets `line-height`, which do).
 */
const LONGHANDS: Record<string, readonly string[]> = {
  inset: EDGES,
  gap: ["row-gap", "column-gap"],
  "grid-gap": ["grid-row-gap", "grid-column-gap"],
  "border-width": EDGES.map((edge) => `border-${edge}-width`),
  "border-style": EDGES.map((edge) => `border-${edge}-style`),
  "border-color": EDGES.map((edge) => `border-${edge}-color`),
  "border-radius": ["top-left", "top-right", "bottom-right", "bottom-left"].map(
    (corner) => `border-${corner}-radius`,
  ),
  "flex-flow": ["flex-direction", "flex-wrap"],
  "place-content": ["align-content", "justify-content"],
  "place-items": ["align-items", "justify-items"],
  "place-self": ["align-self", "justify-self"],
  columns: ["column-width", "column-count"],
  "grid-area": ["grid-row-start", "grid-column-start", "grid-row-end", "grid-column-end"],
  font: ["line-height"],
};

/** Longhand to the shorthands `LONGHANDS` lists for it. */
const LISTED_SHORTHANDS = new Map<string, string[]>();
for (const [shorthand, longhands] of Object.entries(LONGHANDS)) {
  for (const longhand of longhands) {
    LISTED_SHORTHANDS.set(longhand, [...(LISTED_SHORTHANDS.get(longhand) ?? []), shorthand]);
  }
}

const shorthandCache = new Map<string, readonly string[]>();
/** Caches keyed by CSS text are cleared when they grow past this, so a hostile file cannot grow them without end. */
const CACHE_LIMIT = 50_000;

/**
 * The shorthands that set a property (kebab-case): the ones its name extends, `border-top` and
 * `border` for `border-top-color`, and the listed ones, `border-color` for the same. A vendor prefix
 * is ignored, so `-webkit-box-orient` is `box-orient`; a custom property has none.
 */
function shorthandsOf(name: string): readonly string[] {
  let found = shorthandCache.get(name);
  if (found === undefined) {
    if (shorthandCache.size > CACHE_LIMIT) shorthandCache.clear();
    const bare = name.replace(/^-(?:webkit|moz|ms|o)-/, "");
    const words = bare.split("-");
    const own: string[] = [...(LISTED_SHORTHANDS.get(bare) ?? [])];
    if (!name.startsWith("--")) {
      for (let count = words.length - 1; count >= 1; count -= 1)
        own.push(words.slice(0, count).join("-"));
    }
    found = own;
    shorthandCache.set(name, found);
  }
  return found;
}

/** The property as the cascade knows it: kebab-case, without a vendor prefix (custom properties untouched). */
const propertyOf = (key: string): string =>
  key.startsWith("--") ? key : kebab(key).replace(/^-(?:webkit|moz|ms|o)-/, "");

/** Whether one of two properties (kebab-case) is a shorthand of the other, or they are the same: `padding` and `padding-top`. */
function related(a: string, b: string): boolean {
  return a === b || shorthandsOf(a).includes(b) || shorthandsOf(b).includes(a);
}

/**
 * Write one declaration into a style block. A later declaration replaces an earlier one in place (so
 * key order stays that of first appearance), except that a plain declaration never displaces an
 * `!important` one: that is what the cascade does with the same two lines.
 *
 * The exception to "in place" is a property that shares a shorthand with another key of the block
 * (`padding-top` beside `padding`): there the order of the declarations IS the cascade, so the
 * replacement moves to the end, where the later declaration was written. `padding-top:1px;
 * padding:2px;` then `padding-top:3px` is `padding:2px; padding-top:3px`, not the other way round.
 */
function setDeclaration(target: JxStyle, key: string, value: string | number): void {
  const previous = hasOwn(target, key) ? target[key] : undefined;
  if (isImportant(previous) && !isImportant(value)) return;
  if (previous !== undefined && !key.startsWith("--")) {
    const name = propertyOf(key);
    const entangled = Object.keys(target).some(
      (other) => other !== key && !other.startsWith("--") && related(name, propertyOf(other)),
    );
    if (entangled) delete target[key];
  }
  target[key] = value;
}

/**
 * Put the keys of a style block, and of every block in it, in the order Jx emits them: the block's
 * own declarations (Jx writes those as one rule before anything nested), then nested selectors,
 * then at-rules. Cwicly writes its files the same way, base rules first and one block per
 * breakpoint after them, so for its own output this changes nothing; it matters where a block was
 * opened early, by a `@media` rule that preceded the base rules of other nested selectors, and
 * those would otherwise be emitted after a breakpoint block that they must come before. Order
 * within each group is that of first appearance.
 */
function normaliseOrder(style: JxStyle): void {
  const entries = Object.entries(style);
  const rank = (value: unknown, key: string): number =>
    !isBlock(value) ? 0 : key.startsWith("@") ? 2 : 1;
  const ranked = entries.map(([key, value]) => [rank(value, key), key, value] as const);
  const inOrder = ranked.every((entry, i) => i === 0 || ranked[i - 1]![0] <= entry[0]);
  if (!inOrder) {
    for (const [key] of entries) delete style[key];
    // `sort` is stable, so each group keeps the order it had.
    for (const [, key, value] of ranked.toSorted((a, b) => a[0] - b[0])) style[key] = value;
  }
  for (const [, value] of entries) if (isBlock(value)) normaliseOrder(value);
}

/** The nested block at `path` under `style`, created on the way. */
function descend(style: JxStyle, path: readonly string[]): JxStyle {
  let current = style;
  for (const key of path) {
    const next = hasOwn(current, key) ? current[key] : undefined;
    if (isBlock(next)) {
      current = next;
    } else {
      const created: JxStyle = {};
      current[key] = created;
      current = created;
    }
  }
  return current;
}

function cloneStyle(style: JxStyle): JxStyle {
  const copy: JxStyle = {};
  mergeStyle(copy, style);
  return copy;
}

/** Deep-merge `source` into `target`: blocks merge, scalars go through `setDeclaration`, arrays replace. */
function mergeStyle(target: JxStyle, source: JxStyle): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      target[key] = value.map(cloneStyle);
    } else if (isBlock(value)) {
      const existing = hasOwn(target, key) ? target[key] : undefined;
      let block: JxStyle;
      if (isBlock(existing)) {
        block = existing;
      } else {
        block = {};
        target[key] = block;
      }
      mergeStyle(block, value);
    } else {
      setDeclaration(target, key, value);
    }
  }
}

// ── Property names ───────────────────────────────────────────────────────────────────────────────

/** What a CSS property name looks like once lower-cased, apart from custom properties. */
const PROPERTY_NAME = /^-?[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/;

/**
 * The Jx style key for a CSS property name, or null when no key would round-trip.
 *
 * Custom properties pass through untouched (they are case-sensitive). Everything else is
 * camelCased; a vendor prefix keeps its leading dash by capitalising the first letter, because
 * `camelToKebab` only ever produces a dash from a capital.
 */
export function jxStyleKey(property: string): string | null {
  if (property.startsWith("--")) return property.length > 2 ? property : null;
  const name = property.toLowerCase();
  if (!PROPERTY_NAME.test(name)) return null;
  const vendor = name.startsWith("-");
  const camel = (vendor ? name.slice(1) : name).replace(/-([a-z0-9])/g, (_, c: string) =>
    c.toUpperCase(),
  );
  const key = vendor ? camel.charAt(0).toUpperCase() + camel.slice(1) : camel;
  return kebab(key) === name ? key : null;
}

// ── Autoprefixer collapse ────────────────────────────────────────────────────────────────────────

const VENDOR_PROPERTY = /^-(?:webkit|moz|ms|o)-(.+)$/;
const VENDOR_VALUE = /(?:^|[\s,(])-(?:webkit|moz|ms|o)-[a-z]/i;

interface PreparedDeclaration {
  /** Lower-cased property (custom properties untouched). */
  property: string;
  /** Trimmed value, with ` !important` appended when flagged. */
  value: string;
}

/**
 * Drop what autoprefixer added: a vendor-prefixed property whose unprefixed twin is in the same
 * rule, and a vendor-prefixed value that a later declaration of the same property supersedes.
 * Both are judged inside one rule, because that is the unit autoprefixer works on.
 */
function dropAutoprefixed(declarations: PreparedDeclaration[]): PreparedDeclaration[] {
  const properties = new Set(declarations.map((d) => d.property));
  // The properties that a plain (unprefixed-value) declaration sets from some point to the end of
  // the rule, collected backwards in one pass: asking "is there a later one?" per declaration
  // would be quadratic in the size of the rule, and a rule can be as large as a file.
  const plainAfter = Array.from({ length: declarations.length }, () => false);
  const plain = new Set<string>();
  for (let index = declarations.length - 1; index >= 0; index -= 1) {
    const d = declarations[index]!;
    plainAfter[index] = plain.has(d.property);
    if (!VENDOR_VALUE.test(d.value)) plain.add(d.property);
  }
  return declarations.filter((d, index) => {
    const twin = VENDOR_PROPERTY.exec(d.property)?.[1];
    if (twin !== undefined && properties.has(twin)) return false;
    if (!VENDOR_VALUE.test(d.value)) return true;
    return !plainAfter[index];
  });
}

// ── Artifact detection ───────────────────────────────────────────────────────────────────────────

/** `!var=<id>!` inside a value: the editor wrote a palette reference that never resolved. */
const PALETTE_VAR = /!var=([^!\s]*)!/g;
/** Render-time tokens: `{name}` / `{name=arg=arg}` and `<ccd>…</ccd>`. */
const TOKEN = /\{[a-z][\w-]*(?:=[^{}]*)?\}|<ccd>[^<]*<\/ccd>/i;
/** A JS value stringified into CSS. The lookbehind keeps `.is-undefined-state`-style names out. */
const INVALID_VALUE = /(?<![\w-])undefined|\[object Object\]/;
/** The literal word `undefined` starting an identifier: Cwicly's `undefined` + classID. */
const UNDEFINED_SELECTOR = /(?<![\w-])undefined/;

/** Functions that may be written with nothing between the parentheses. */
const EMPTY_FUNCTIONS = new Set(["url", "circle", "ellipse"]);
/** Functions whose last argument may be empty: `var(--x,)` is a fallback of nothing. */
const EMPTY_FALLBACK = new Set(["var", "env"]);

/**
 * Why a browser would throw this declaration away, or null when nothing is wrong that can be told
 * without a grammar of every property. These are the shapes a generator leaves behind when a
 * variable in its template was empty (`column-gap:  ;`, `minmax(, 1fr)`), and they matter more
 * than a bad value should: a declaration the browser discards leaves the earlier one in force, and
 * the index would let it replace that one instead.
 *
 * Custom properties are exempt from the empty-value rule (`--x: ;` is valid and means "empty").
 */
function invalidValueReason(property: string, value: string): string | null {
  if (!property.startsWith("--") && value.trim() === "") return "the value is empty";
  let reason: string | null = null;
  // Every word of the value, outside strings and URLs, in order: `!` and `important` are two words
  // when the author left a space between them.
  const words: string[] = [];
  valueParser(value).walk((node) => {
    if (reason !== null) return false;
    if (node.type === "function") {
      const name = node.value.toLowerCase();
      // What a URL holds is opaque, and `url()` may be empty.
      if (name === "url") return false;
      const args = node.nodes.filter((child) => child.type !== "space" && child.type !== "comment");
      const first = args[0];
      const last = args[args.length - 1];
      const comma = (child: valueParser.Node | undefined): boolean =>
        child?.type === "div" && child.value === ",";
      if (first === undefined || last === undefined) {
        if (!EMPTY_FUNCTIONS.has(name)) reason = `${name}() has no arguments`;
      } else if (comma(first)) {
        reason = `${name}() starts with an empty argument`;
      } else if (comma(last) && !EMPTY_FALLBACK.has(name)) {
        reason = `${name}() ends with an empty argument`;
      } else if (args.some((arg, i) => i > 0 && comma(arg) && comma(args[i - 1]))) {
        reason = `${name}() has an empty argument`;
      }
    } else if (node.type === "word") {
      words.push(node.value);
    }
    return undefined;
  });
  if (reason !== null) return reason;
  const text = words.join(" ");
  if (/u002d/i.test(text)) return "`u002d` stands where `--` was written";
  if (/!\s*important/i.test(text)) return "`!important` in the middle of the value";
  return null;
}

/** What a CSS identifier looks like (escapes included): the test a class or id name has to pass. */
const IDENT = (() => {
  const escape = String.raw`\\(?:[0-9a-fA-F]{1,6}[ \t\n\f\r]?|[^\n\r\f0-9a-fA-F])`;
  const start = String.raw`(?:[A-Za-z_]|[^\x00-\x7F]|${escape})`;
  const part = String.raw`(?:[A-Za-z0-9_-]|[^\x00-\x7F]|${escape})`;
  return new RegExp(`^(?:--|-?${start})${part}*$`);
})();

// ── Selectors ────────────────────────────────────────────────────────────────────────────────────

const LEGACY_PSEUDO_ELEMENTS = new Set([":before", ":after", ":first-line", ":first-letter"]);

type SelectorNode = selectorParser.Node;

interface SplitSelector {
  /** The compounds of the selector, in order; each is its simple selectors. */
  compounds: SelectorNode[][];
  /** The combinators between them (`compounds.length - 1` of them). */
  combinators: selectorParser.Combinator[];
}

/** One simple selector as text. Legacy single-colon pseudo-elements are written with two colons. */
function simpleText(node: SelectorNode): string {
  if (node.type === "pseudo") {
    const lower = node.value.toLowerCase();
    if (LEGACY_PSEUDO_ELEMENTS.has(lower)) return `:${lower}`;
  }
  return node.toString().trim();
}

/** A combinator with one space either side, or a single space for the descendant combinator. */
function combinatorText(combinator: selectorParser.Combinator): string {
  const value = combinator.value.trim();
  return value === "" ? " " : ` ${value} `;
}

function splitSelector(selector: selectorParser.Selector): SplitSelector | null {
  const compounds: SelectorNode[][] = [[]];
  const combinators: selectorParser.Combinator[] = [];
  for (const node of selector.nodes) {
    if (node.type === "comment") continue;
    if (node.type === "combinator") {
      combinators.push(node);
      compounds.push([]);
    } else {
      compounds[compounds.length - 1]!.push(node);
    }
  }
  return compounds.some((compound) => compound.length === 0) ? null : { compounds, combinators };
}

function compoundText(compound: SelectorNode[]): string {
  return compound.map(simpleText).join("");
}

/** Everything after the first compound, combinators normalised. */
function restText(split: SplitSelector): string {
  let text = "";
  for (let i = 1; i < split.compounds.length; i += 1) {
    text += combinatorText(split.combinators[i - 1]!) + compoundText(split.compounds[i]!);
  }
  return text;
}

/** Where a rule's selector puts its declarations in the index. */
export type SelectorPlacement =
  | {
      kind: "class";
      /** The class, unescaped, without the dot. */
      name: string;
      /** Nested key under the class's style: `""` for the class itself, else `":hover"`, `"& svg"`… */
      key: string;
    }
  | {
      kind: "other";
      /** The selector, whitespace around combinators normalised. */
      selector: string;
    };

/** What the classifier says about a selector it cannot place. */
interface SelectorProblem {
  kind: "invalid";
  /** An empty class name (`.`): a block without a classID, which is the generator's bug, not the CSS's. */
  emptyClass: boolean;
  message: string;
}

/** Pseudo-classes whose arguments are selectors of their own. */
const SELECTOR_ARGUMENTS = new Set([":is", ":where", ":not", ":has", ":matches"]);

/**
 * What no browser would accept in a selector that postcss-selector-parser let through: an empty or
 * malformed class or id name (`.`, `.1a`, `.-`, `#`), an attribute selector with no name (`[]`), a
 * type selector that is not an identifier (`%`, `@`). The parser reads all of these as selectors, so
 * they would become keys of the index, and a rule a browser throws away would be applied.
 */
function problemIn(selector: selectorParser.Selector): SelectorProblem | null {
  const invalid = (message: string, emptyClass = false): SelectorProblem => ({
    kind: "invalid",
    emptyClass,
    message,
  });
  for (const node of selector.nodes) {
    if (node.type === "class" || node.type === "id") {
      const raw = (node as { raws?: { value?: string } }).raws?.value ?? node.value;
      const what = node.type === "class" ? "class" : "id";
      if (raw === "") return invalid(`has an empty ${what} name`, node.type === "class");
      if (!IDENT.test(raw)) return invalid(`"${raw}" is not a valid ${what} name`);
    } else if (node.type === "attribute") {
      if (typeof node.attribute !== "string" || node.attribute === "") {
        return invalid("has an attribute selector with no name");
      }
    } else if (node.type === "tag") {
      if (!IDENT.test(node.value)) return invalid(`"${node.value}" is not a valid type selector`);
    } else if (node.type === "pseudo" && SELECTOR_ARGUMENTS.has(node.value.toLowerCase())) {
      for (const argument of node.nodes) {
        const problem = problemIn(argument);
        if (problem !== null) return problem;
      }
    }
  }
  return null;
}

/** Place one selector, or say why it cannot be placed. */
function placeSelector(member: string): SelectorPlacement | SelectorProblem {
  const unreadable = (): SelectorProblem => ({
    kind: "invalid",
    emptyClass: false,
    message: "cannot be parsed",
  });
  let root: selectorParser.Root;
  try {
    root = selectorParser().astSync(member);
  } catch {
    return unreadable();
  }
  if (root.nodes.length !== 1) return unreadable();
  const problem = problemIn(root.nodes[0]!);
  if (problem !== null) return problem;
  const split = splitSelector(root.nodes[0]!);
  if (split === null) return unreadable();

  const first = split.compounds[0]!;
  const classes = first.filter((node): node is selectorParser.ClassName => node.type === "class");
  const tags = first.filter((node): node is selectorParser.Tag => node.type === "tag");
  const tail = first.filter((node) => node.type !== "class" && node.type !== "tag");
  const rooted =
    classes.length === 1 &&
    tags.length <= 1 &&
    tail.every((node) => node.type === "pseudo" || node.type === "attribute") &&
    tags.every((tag) => !tag.namespace && first[0] === tag);

  if (!rooted) {
    return { kind: "other", selector: compoundText(first) + restText(split) };
  }
  const tag = tags[0]?.toString().trim();
  const qualifier = tag === undefined ? "" : `:is(${tag})`;
  const rest = restText(split);
  const tailText = compoundText(tail);
  const key = rest === "" && tag === undefined ? tailText : `&${qualifier}${tailText}${rest}`;
  return { kind: "class", name: classes[0]!.value, key };
}

/**
 * Classify ONE selector (no top-level commas). Null when it cannot be parsed, or when no browser
 * would accept it (an empty or malformed class name, an attribute selector with no name).
 *
 * The first compound decides. Exactly one class, optionally qualified by a tag and optionally
 * carrying pseudo-classes, pseudo-elements and attributes, roots the selector at that class:
 *
 *   `.c`            → `""`          (declarations go on the class)
 *   `.c:hover`      → `":hover"`    `.c:before` → `"::before"`
 *   `.c svg`        → `"& svg"`     `.c > div:nth-of-type(1)` → `"& > div:nth-of-type(1)"`
 *   `a.c`           → `"&:is(a)"`   (same specificity as `a.c`)  `a.c:hover svg` → `"&:is(a):hover svg"`
 *
 * Anything else (`.a.b`, `body`, `:root`, `#id`, `:where(.a .b)`) is keyed by the selector itself.
 */
export function classifySelector(member: string): SelectorPlacement | null {
  const placed = placeSelector(member);
  return placed.kind === "invalid" ? null : placed;
}

/** A rule's selector list split on its top-level commas (parentheses, brackets and quotes respected). */
function selectorMembers(selector: string): string[] {
  return postcss.list
    .comma(selector)
    .map((member) => member.trim())
    .filter((member) => member !== "");
}

/**
 * What a selector nested in a rule means under one member of the parent's list (CSS Nesting).
 *
 * No `&` and no leading combinator is a descendant, as `& x` would be. A single `&` leading the
 * selector is the parent itself, and whatever follows attaches to it. Any other use of `&` stands
 * for the whole parent, which must stay one compound, so it becomes `:is(parent)`.
 */
function nestSelector(parent: string, nested: string): string {
  if (/^[>+~]/.test(nested)) return `${parent} ${nested}`;
  let ampersands: number[] = [];
  try {
    const found: number[] = [];
    selectorParser((root) => {
      root.walkNesting((node) => {
        found.push(node.sourceIndex);
      });
    }).processSync(nested);
    ampersands = found;
  } catch {
    // An unparseable nested selector is reported when the combined selector is classified.
  }
  if (ampersands.length === 0) return `${parent} ${nested}`;
  if (ampersands.length === 1 && ampersands[0] === 0) return parent + nested.slice(1);
  let text = nested;
  for (const index of ampersands.toReversed()) {
    text = `${text.slice(0, index)}:is(${parent})${text.slice(index + 1)}`;
  }
  return text;
}

// ── The index ────────────────────────────────────────────────────────────────────────────────────

/** An index with nothing in it: the identity of `mergeCssIndexes`. */
export function emptyCssIndex(): OrderedCssIndex {
  return { classes: new Map(), other: new Map(), atRules: [], artifacts: [], rules: [] };
}

/** `.name`, escaped as CSS. postcss-selector-parser escapes through the `value` setter only. */
function classSelectorText(name: string): string {
  const node = selectorParser.className({ value: "x" });
  node.value = name;
  return node.toString();
}

/** The selector a nested key stands for under `selector`, the way Jx resolves it. */
function resolveKey(selector: string, key: string): string {
  if (key === "") return selector;
  if (key.startsWith("&")) return key.replaceAll("&", selector);
  if (key.startsWith(":") || key.startsWith(".") || key.startsWith("[")) return selector + key;
  return `${selector} ${key}`;
}

/** The whole selector a placement stands for. */
function placementSelector(placement: SelectorPlacement): string {
  return placement.kind === "other"
    ? placement.selector
    : resolveKey(classSelectorText(placement.name), placement.key);
}

/** At-rules that wrap rules (and so nest under a class's style the way `@media` does). */
const CONDITIONAL_AT_RULES = new Set(["supports", "container", "layer", "starting-style", "scope"]);
/** At-rules whose body is a list of declarations. Jx knows these four. */
const DECLARATION_AT_RULES = new Set(["font-face", "property", "counter-style", "position-try"]);
const KEYFRAMES = /^(?:-(?:webkit|moz|o)-)?keyframes$/;
const MEDIA_TYPES = new Set(["all", "print", "screen", "speech"]);

/** Whitespace-, case- and `screen and`-insensitive spelling of a media query. */
function normaliseQuery(query: string): string {
  return collapse(query)
    .toLowerCase()
    .replace(/\s*:\s*/g, ": ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

class Reader {
  readonly classes = new Map<string, ClassStyle>();
  readonly other = new Map<string, JxStyle>();
  readonly atRules: CssIndex["atRules"] = [];
  readonly artifacts: Artifact[] = [];
  /** Every rule placed, in source order. */
  readonly rules: CssRulePart[] = [];
  /** Declarations the scan found to be artifacts; they never reach the index. */
  private readonly dropped = new WeakSet<Declaration>();
  /** `(max-width: 992px)` → `@--md`. */
  private readonly mediaKeys = new Map<string, string>();
  /** Palette id → `var(--cc-color-5)`, when the caller supplied a palette. */
  private readonly palette: Map<string, string> | undefined;
  private readonly file: string | undefined;

  constructor(breakpoints: readonly Breakpoint[], options: ParseOptions) {
    this.file = options.file;
    if (options.palette !== undefined) {
      this.palette = new Map(
        options.palette.map(({ id, variable }) => [
          id,
          `var(${variable.startsWith("--") ? variable : `--${variable}`})`,
        ]),
      );
    }
    for (const bp of breakpoints) {
      if (bp.isMain || bp.direction === "none") continue;
      this.mediaKeys.set(`(${bp.direction}-width: ${bp.width}px)`, `@--${bp.key}`);
    }
  }

  report(code: string, detail: string, selector?: string): void {
    const text = this.file === undefined ? detail : `${detail} (in ${this.file})`;
    this.artifacts.push({
      code,
      ...(selector === undefined ? {} : { selector }),
      detail: text,
      ...(this.file === undefined ? {} : { file: this.file }),
    });
  }

  read(root: postcss.Root): void {
    root.walkDecls((declaration) => this.scan(declaration));
    this.walk(root, []);
  }

  // ── Declarations ──

  /** Report, and mark for dropping, every declaration that is a generator artifact. */
  private scan(declaration: Declaration): void {
    const owner = this.owner(declaration) || undefined;
    const { prop } = declaration;
    let value = declaration.value;
    let drop = false;
    if (this.palette !== undefined) {
      const resolved = value.replace(
        PALETTE_VAR,
        (whole, id: string) => this.palette?.get(id) ?? whole,
      );
      if (resolved !== value) {
        declaration.value = resolved;
        value = resolved;
      }
    }
    for (const match of value.matchAll(PALETTE_VAR)) {
      this.report(
        CSS_ARTIFACT.unresolvedPaletteVar,
        this.palette === undefined
          ? `${prop}: the generator left the palette reference "${match[1]}" unresolved`
          : `${prop}: no colour with the id "${match[1]}" exists in the palette`,
        owner,
      );
      drop = true;
    }
    if (TOKEN.test(value)) {
      this.report(
        CSS_ARTIFACT.token,
        `${prop}: unresolved token in "${clip(collapse(value))}"`,
        owner,
      );
      drop = true;
    }
    if (INVALID_VALUE.test(value)) {
      this.report(
        CSS_ARTIFACT.invalidValue,
        `${prop}: invalid value "${clip(collapse(value))}"`,
        owner,
      );
      drop = true;
    } else {
      let reason: string | null;
      try {
        reason = invalidValueReason(prop, value);
      } catch {
        // The value parser recurses: a value nested tens of thousands of functions deep overflows it.
        reason = "the value is nested too deeply to read";
      }
      if (reason !== null) {
        this.report(
          CSS_ARTIFACT.invalidValue,
          `${prop}: invalid value "${clip(collapse(value))}" (${reason})`,
          owner,
        );
        drop = true;
      }
    }
    // postcss files `*zoom` and `_height` (IE hacks, invalid everywhere else) under the plain name.
    const hack = /[*_]/.exec(declaration.raws.before ?? "")?.[0];
    if (hack !== undefined) {
      this.report(CSS_ARTIFACT.unclassified, `"${hack}${prop}" is an IE property hack`, owner);
      drop = true;
    } else if (jxStyleKey(prop) === null) {
      this.report(
        CSS_ARTIFACT.unclassified,
        `property name "${prop}" cannot be a Jx style key`,
        owner,
      );
      drop = true;
    }
    if (drop) this.dropped.add(declaration);
  }

  private owner(declaration: Declaration): string {
    const parent = declaration.parent;
    if (parent?.type === "rule") return clip(collapse((parent as Rule).selector));
    if (parent?.type === "atrule") return atRuleHead(parent as AtRule);
    return "";
  }

  /** The surviving declarations of one rule body, as [Jx key, value] pairs in source order. */
  private declarations(nodes: readonly postcss.ChildNode[]): [string, string][] {
    const prepared: PreparedDeclaration[] = [];
    for (const node of nodes) {
      if (node.type !== "decl" || this.dropped.has(node)) continue;
      const property = node.prop.startsWith("--") ? node.prop : node.prop.toLowerCase();
      prepared.push({ property, value: node.value.trim() + (node.important ? " !important" : "") });
    }
    const kept: [string, string][] = [];
    for (const { property, value } of dropAutoprefixed(prepared)) {
      const key = jxStyleKey(property);
      if (key !== null) kept.push([key, value]);
    }
    return kept;
  }

  // ── Walking ──

  private walk(container: postcss.Container, context: readonly string[]): void {
    for (const node of container.nodes ?? []) {
      if (node.type === "rule") this.rule(node, null, context);
      else if (node.type === "atrule") this.atRule(node, context, container);
    }
  }

  /**
   * One style rule. `parents` is the enclosing rule's resolved selector list when this rule is
   * nested in one (CSS Nesting, which Cwicly's compiled global CSS uses for its palette classes).
   * Artifacts are judged once per resolved member, here, so a nested at-rule body can reuse the
   * placements without reporting them again.
   */
  private rule(rule: Rule, parents: readonly string[] | null, context: readonly string[]): void {
    const own = selectorMembers(rule.selector);
    const members =
      parents === null
        ? own
        : parents.flatMap((parent) => own.map((member) => nestSelector(parent, member)));
    const placements: SelectorPlacement[] = [];
    // The generator writes an empty `.undefined{}` for every block without a classID: nothing is
    // lost by dropping those, and a report reader should be able to tell.
    const empty = rule.nodes.every((child) => child.type === "comment");
    for (const member of members) {
      let artifact = false;
      if (UNDEFINED_SELECTOR.test(member)) {
        this.report(
          CSS_ARTIFACT.undefinedSelector,
          `selector "${clip(member)}" contains "undefined"${empty ? " and the rule is empty" : ""}`,
          clip(member),
        );
        artifact = true;
      }
      if (TOKEN.test(member)) {
        this.report(
          CSS_ARTIFACT.token,
          `unresolved token in selector "${clip(member)}"`,
          clip(member),
        );
        artifact = true;
      }
      if (artifact) continue;
      const placed = placeSelector(member);
      if (placed.kind === "invalid") {
        if (placed.emptyClass) {
          this.report(
            CSS_ARTIFACT.undefinedSelector,
            `selector "${clip(member)}" has no class name (a block without a classID)${empty ? " and the rule is empty" : ""}`,
            clip(member),
          );
        } else {
          this.report(
            CSS_ARTIFACT.unclassified,
            `selector "${clip(member)}" ${placed.message}`,
            clip(member),
          );
        }
        continue;
      }
      placements.push(placed);
    }
    this.body(rule, members, placements, context);
  }

  /** A rule's (or a nested conditional at-rule's) own declarations, then whatever is nested in it. */
  private body(
    node: Rule | AtRule,
    members: readonly string[],
    placements: readonly SelectorPlacement[],
    context: readonly string[],
  ): void {
    const children = node.nodes ?? [];
    const declarations = this.declarations(children);
    if (declarations.length > 0) {
      for (const placement of placements) this.place(placement, context, declarations);
    }
    for (const child of children) {
      if (child.type === "rule") {
        this.rule(child, members, context);
      } else if (child.type === "atrule") {
        const key = this.conditionKey(child);
        if (key === null) {
          this.report(
            CSS_ARTIFACT.unclassified,
            `at-rule "${atRuleHead(child)}" inside a rule has no Jx equivalent`,
            atRuleHead(child),
          );
        } else {
          this.body(child, members, placements, [...context, key]);
        }
      }
    }
  }

  private place(
    placement: SelectorPlacement,
    context: readonly string[],
    declarations: readonly [string, string][],
  ): void {
    let root: JxStyle;
    if (placement.kind === "class") {
      let entry = this.classes.get(placement.name);
      if (entry === undefined) {
        entry = { style: {} };
        this.classes.set(placement.name, entry);
      }
      root = entry.style;
    } else {
      let style = this.other.get(placement.selector);
      if (style === undefined) {
        style = {};
        this.other.set(placement.selector, style);
      }
      root = style;
    }
    const path =
      placement.kind === "class" && placement.key !== "" ? [...context, placement.key] : context;
    const target = descend(root, path);
    for (const [key, value] of declarations) setDeclaration(target, key, value);
    this.rules.push({
      layer: 0,
      selector: placementSelector(placement),
      context: [...context],
      declarations: declarations.map(([key, value]) => [key, value] as const),
    });
  }

  // ── At-rules ──

  /** The at-rule's key when it wraps rules (so it nests like `@media` does), else null. */
  private conditionKey(at: AtRule): string | null {
    if (at.nodes === undefined) return null;
    const name = at.name.toLowerCase();
    if (name === "media") return this.mediaKey(at.params, atRuleHead(at));
    return CONDITIONAL_AT_RULES.has(name) ? atRuleHead(at) : null;
  }

  private atRule(at: AtRule, context: readonly string[], parent: postcss.Container): void {
    const key = this.conditionKey(at);
    if (key !== null) {
      this.walk(at, [...context, key]);
      return;
    }
    const name = at.name.toLowerCase();
    if (name === "charset") return;
    const topLevel = context.length === 0;
    if (topLevel && name === "import" && at.nodes === undefined) {
      this.atRules.push({ key: atRuleHead(at), style: {} });
      return;
    }
    if (topLevel && DECLARATION_AT_RULES.has(name) && at.nodes !== undefined) {
      this.declarationAtRule(at);
      return;
    }
    if (topLevel && KEYFRAMES.test(name) && at.nodes !== undefined) {
      this.keyframes(at, parent);
      return;
    }
    this.report(
      CSS_ARTIFACT.unclassified,
      `at-rule "${atRuleHead(at)}" has no Jx equivalent`,
      atRuleHead(at),
    );
  }

  private mediaKey(params: string, head: string): string {
    const query = normaliseQuery(params);
    const bare = query.replace(/^screen and (?=\()/, "");
    const mapped = this.mediaKeys.get(bare);
    if (mapped !== undefined) return mapped;
    this.report(
      CSS_ARTIFACT.mediaUnmapped,
      `media query "${collapse(params)}" names no breakpoint`,
      head,
    );
    if (bare.startsWith("(")) return `@${bare}`;
    if (MEDIA_TYPES.has(bare)) return `@(${bare})`;
    return `@media ${query}`;
  }

  private declarationAtRule(at: AtRule): void {
    const body = at.nodes ?? [];
    for (const child of body) {
      if (child.type === "rule" || child.type === "atrule") {
        this.report(
          CSS_ARTIFACT.unclassified,
          `nested rule inside "${atRuleHead(at)}"`,
          atRuleHead(at),
        );
      }
    }
    const style: JxStyle = {};
    for (const [key, value] of this.declarations(body)) setDeclaration(style, key, value);
    if (Object.keys(style).length > 0) this.atRules.push({ key: atRuleHead(at), style });
  }

  private keyframes(at: AtRule, parent: postcss.Container): void {
    const name = collapse(at.params);
    // Autoprefixer writes `@-webkit-keyframes x` before `@keyframes x`; the second makes the first
    // redundant, and Jx only recognises the unprefixed spelling.
    if (at.name.toLowerCase() !== "keyframes") {
      const twin = parent.nodes?.some(
        (sibling) =>
          sibling.type === "atrule" &&
          sibling.name.toLowerCase() === "keyframes" &&
          collapse(sibling.params) === name,
      );
      if (twin) return;
    }
    const style: JxStyle = {};
    for (const stop of at.nodes ?? []) {
      if (stop.type !== "rule") {
        if (stop.type !== "decl" && stop.type !== "comment") {
          this.report(
            CSS_ARTIFACT.unclassified,
            `nested at-rule inside "@keyframes ${name}"`,
            `@keyframes ${name}`,
          );
        }
        continue;
      }
      const declarations = this.declarations(stop.nodes);
      if (declarations.length === 0) continue;
      const block = descend(style, [selectorMembers(stop.selector).join(", ")]);
      for (const [key, value] of declarations) setDeclaration(block, key, value);
    }
    if (Object.keys(style).length > 0) this.atRules.push({ key: `@keyframes ${name}`, style });
  }
}

/** `@import url(…)`, `@font-face`, `@keyframes spin`: the at-rule's name and parameters. */
function atRuleHead(at: AtRule): string {
  const params = collapse(at.params);
  return params === "" ? `@${at.name}` : `@${at.name} ${params}`;
}

// ── Recovery ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The deepest block nesting that is read. Real files nest three or four levels (`@media` in
 * `@supports` in a rule); the limit exists so that a file cannot exhaust the stack, and the time,
 * of everything that walks it.
 */
const MAX_NESTING = 64;

/** One top-level rule or statement of a stylesheet, cut where CSS error recovery would cut it. */
interface Chunk {
  /** Offsets into the text, `end` exclusive. */
  start: number;
  end: number;
  /** Offset of the first thing in it that is neither space nor a comment. */
  first: number;
  /** Deepest `{` nesting inside it. */
  depth: number;
  /** `{` still open at the end of the text (only the last chunk can have any). */
  unclosedBlocks: number;
  /** Why nothing in it can be read (a parenthesis or bracket that never closes), else null. */
  problem: string | null;
}

interface Scan {
  chunks: Chunk[];
  maxDepth: number;
  /** Offset of a comment that never closes, else null. */
  unclosedComment: number | null;
}

const isSpace = (ch: string): boolean =>
  ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f";

/** Offset just past the string that starts at `at`: at its closing quote, or where it breaks off (newline, end of text). */
function skipString(css: string, at: number): number {
  const quote = css[at];
  let i = at + 1;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === "\\") i += 2;
    else if (ch === quote) return i + 1;
    else if (ch === "\n" || ch === "\r" || ch === "\f") return i;
    else i += 1;
  }
  return css.length;
}

/**
 * Cut a stylesheet into its top-level rules the way a browser's tokenizer sees them, without
 * judging what is inside: comments, strings (which end at a newline when left open), escapes, `url(`
 * with an unquoted body, and nested `{}` `()` `[]` are all skipped over correctly. A qualified rule
 * ends at the `}` that closes its block, a statement at-rule at its `;`. A `}` with nothing open is
 * not special: it is part of the next rule's prelude, which makes that rule invalid, exactly as it
 * does in a browser.
 */
function scanChunks(css: string, collect: boolean): Scan {
  const chunks: Chunk[] = [];
  const open: string[] = [];
  let maxDepth = 0;
  let braces = 0;
  let start = 0;
  let first = -1;
  let depth = 0;
  let atRule = false;
  let unclosedComment: number | null = null;
  const flush = (end: number): void => {
    if (collect && first !== -1) {
      chunks.push({ start, end, first, depth, unclosedBlocks: braces, problem: null });
    }
    start = end;
    first = -1;
    depth = 0;
    atRule = false;
  };
  let at = 0;
  while (at < css.length) {
    const ch = css[at]!;
    if (ch === "/" && css[at + 1] === "*") {
      const close = css.indexOf("*/", at + 2);
      if (close === -1) {
        unclosedComment = at;
        break;
      }
      at = close + 2;
      continue;
    }
    if (isSpace(ch)) {
      at += 1;
      continue;
    }
    if (first === -1) {
      first = at;
      atRule = ch === "@";
    }
    if (ch === '"' || ch === "'") {
      at = skipString(css, at);
    } else if (ch === "\\") {
      at += 2;
    } else if (ch === "(" && /(?:^|[^\w-])url$/i.test(css.slice(Math.max(0, at - 4), at))) {
      // `url(` followed by anything but a quote is one opaque token that runs to the next `)`.
      let inner = at + 1;
      while (inner < css.length && isSpace(css[inner]!)) inner += 1;
      if (css[inner] === '"' || css[inner] === "'") {
        open.push("(");
        at += 1;
      } else {
        while (inner < css.length && css[inner] !== ")") inner += css[inner] === "\\" ? 2 : 1;
        at = inner + 1;
      }
    } else if (ch === "{") {
      open.push("{");
      braces += 1;
      depth = Math.max(depth, braces);
      maxDepth = Math.max(maxDepth, braces);
      at += 1;
    } else if (ch === "}") {
      at += 1;
      if (open[open.length - 1] === "{") {
        open.pop();
        braces -= 1;
        if (open.length === 0) flush(at);
      }
    } else if (ch === "(" || ch === "[") {
      open.push(ch);
      at += 1;
    } else if (ch === ")" || ch === "]") {
      if (open[open.length - 1] === (ch === ")" ? "(" : "[")) open.pop();
      at += 1;
    } else if (ch === ";" && atRule && open.length === 0) {
      at += 1;
      flush(at);
    } else {
      at += 1;
    }
  }
  if (first !== -1) {
    const last = open.findLast((entry) => entry !== "{");
    if (collect) {
      chunks.push({
        start,
        end: css.length,
        first,
        depth,
        unclosedBlocks: braces,
        problem:
          last === undefined
            ? null
            : `a ${last === "(" ? "parenthesis" : "bracket"} that is never closed`,
      });
    }
  }
  return { chunks, maxDepth, unclosedComment };
}

/** The 1-based line of an offset, by binary search over the newlines (built once, on first use). */
function lineFinder(css: string): (offset: number) => number {
  let newlines: number[] | undefined;
  return (offset) => {
    if (newlines === undefined) {
      newlines = [];
      for (let i = css.indexOf("\n"); i !== -1; i = css.indexOf("\n", i + 1)) newlines.push(i);
    }
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (newlines[mid]! < offset) low = mid + 1;
      else high = mid;
    }
    return low + 1;
  };
}

/** The significant characters of a piece of CSS, with their offsets: not the ones inside comments, strings or escapes. */
function* significant(text: string): Generator<[number, string]> {
  let at = 0;
  while (at < text.length) {
    const ch = text[at]!;
    if (ch === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2);
      at = close === -1 ? text.length : close + 2;
    } else if (ch === '"' || ch === "'") {
      at = skipString(text, at);
    } else if (ch === "\\") {
      at += 2;
    } else {
      yield [at, ch];
      at += 1;
    }
  }
}

/** Split a block's content on its top-level `;` (nothing open, braces included), with each piece's offset. */
function splitDeclarations(body: string): { text: string; offset: number }[] {
  const pieces: { text: string; offset: number }[] = [];
  let depth = 0;
  let from = 0;
  for (const [at, ch] of significant(body)) {
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if ((ch === ")" || ch === "]" || ch === "}") && depth > 0) depth -= 1;
    else if (ch === ";" && depth === 0) {
      pieces.push({ text: body.slice(from, at), offset: from });
      from = at + 1;
    }
  }
  pieces.push({ text: body.slice(from), offset: from });
  return pieces.filter((piece) => piece.text.trim() !== "");
}

/**
 * Whether a block's content holds rules (`.b{…}`, `@media{…}`) rather than declarations. The first
 * top-level `{` decides: a declaration whose value is a block (`background-image:{token}`) has a
 * colon right before it, which no selector can end in.
 */
function holdsRules(inner: string): boolean {
  let depth = 0;
  for (const [at, ch] of significant(inner)) {
    if (ch === "(" || ch === "[") depth += 1;
    else if ((ch === ")" || ch === "]") && depth > 0) depth -= 1;
    else if (ch === "{" && depth === 0) return !/:\s*$/.test(inner.slice(0, at));
  }
  return false;
}

/** `prelude { body }` taken apart, or null when the text is not exactly one block. */
function splitBlock(text: string): { prelude: string; body: string; bodyOffset: number } | null {
  let depth = 0;
  let open = -1;
  for (const [at, ch] of significant(text)) {
    if (ch === "(" || ch === "[") depth += 1;
    else if ((ch === ")" || ch === "]") && depth > 0) depth -= 1;
    else if (ch === "{" && depth === 0) {
      open = at;
      break;
    }
  }
  const close = text.trimEnd().lastIndexOf("}");
  if (open === -1 || close < open) return null;
  return {
    prelude: text.slice(0, open).trim(),
    body: text.slice(open + 1, close),
    bodyOffset: open + 1,
  };
}

/**
 * Read what can be read of a stylesheet postcss refused (or that nests deeper than `MAX_NESTING`).
 *
 * Browsers recover rule by rule, so this does too: every top-level rule is parsed on its own, and
 * only the ones that fail are lost. A rule that fails is opened up and read piece by piece, so
 * `.a{color red; margin:0}` keeps its margin and a `@media` block keeps the rules in it that are
 * sound. A block still open at the end of the file is closed there, as a browser does. What was
 * lost, and what was closed, is reported with its line.
 */
function recover(css: string, reader: Reader, cause: string | null): postcss.Root {
  const scan = scanChunks(css, true);
  const root = postcss.root();
  const lineAt = lineFinder(css);
  let reported = false;
  const fail = (message: string): void => {
    reader.report(CSS_ARTIFACT.syntaxError, message);
    reported = true;
  };
  const adopt = (text: string): void => {
    root.append(postcss.parse(text, { from: undefined }).nodes);
  };
  const reasonOf = (error: unknown): string =>
    (error as { reason?: string }).reason ?? (error as Error).message;
  const shorten = (text: string): string => {
    const shown = collapse(text);
    return shown.length > 60 ? `${shown.slice(0, 60)}…` : shown;
  };

  /**
   * Adopt the pieces of `inner`, the content of a block that failed to parse whole. `wrap` puts a
   * piece back inside every block that encloses it, so that a piece keeps its meaning (a nested
   * rule stays nested, a declaration stays in its rule). `offset` is where `inner` starts in `css`.
   */
  const salvage = (
    wrap: (piece: string) => string,
    inner: string,
    offset: number,
    depth: number,
  ): void => {
    const pieces = holdsRules(inner)
      ? scanChunks(inner, true).chunks.map((chunk) => ({
          text: inner.slice(chunk.start, chunk.end),
          offset: chunk.start,
        }))
      : splitDeclarations(inner);
    for (const piece of pieces) {
      const line = lineAt(
        offset + piece.offset + (piece.text.length - piece.text.trimStart().length),
      );
      try {
        adopt(wrap(piece.text));
      } catch (error) {
        const block = splitBlock(piece.text);
        if (block === null || depth >= MAX_NESTING || /:\s*$/.test(block.prelude)) {
          fail(
            `the declaration "${shorten(piece.text)}" at line ${line} cannot be parsed (${reasonOf(error)}) and is skipped`,
          );
          continue;
        }
        const nested = (text: string): string => wrap(`${block.prelude}{${text}}`);
        try {
          adopt(nested(""));
        } catch (preludeError) {
          fail(
            `the rule at line ${line} cannot be parsed (${reasonOf(preludeError)}) and is skipped`,
          );
          continue;
        }
        salvage(nested, block.body, offset + piece.offset + block.bodyOffset, depth + 1);
      }
    }
  };

  for (const chunk of scan.chunks) {
    const where = `line ${lineAt(chunk.first)}`;
    if (chunk.depth > MAX_NESTING) {
      fail(`the rule at ${where} nests blocks more than ${MAX_NESTING} deep and is skipped`);
      continue;
    }
    if (chunk.problem !== null) {
      fail(`the rule at ${where} is cut off by ${chunk.problem} and is skipped`);
      continue;
    }
    // A comment that never closes swallows the rest of the file, including the last chunk's closers.
    const commentInside =
      scan.unclosedComment !== null &&
      scan.unclosedComment >= chunk.first &&
      scan.unclosedComment < chunk.end;
    const text = `${css.slice(chunk.start, chunk.end)}${commentInside ? "*/" : ""}${"}".repeat(chunk.unclosedBlocks)}`;
    try {
      adopt(text);
      if (chunk.unclosedBlocks > 0) {
        fail(
          `the block that opens at ${where} is never closed; it is closed at the end of the stylesheet, as a browser does`,
        );
      }
    } catch (error) {
      const block = splitBlock(text);
      if (block === null) {
        fail(`the rule at ${where} cannot be parsed (${reasonOf(error)}) and is skipped`);
        continue;
      }
      const wrap = (inner: string): string => `${block.prelude}{${inner}}`;
      try {
        adopt(wrap(""));
      } catch (preludeError) {
        fail(`the rule at ${where} cannot be parsed (${reasonOf(preludeError)}) and is skipped`);
        continue;
      }
      salvage(wrap, block.body, chunk.start + block.bodyOffset, 1);
    }
  }
  if (scan.unclosedComment !== null) {
    fail(
      `the comment at line ${lineAt(scan.unclosedComment)} is never closed, so the rest of the stylesheet is comment`,
    );
  }
  if (!reported) fail(`the stylesheet cannot be parsed: ${cause ?? "unknown error"}`);
  return root;
}

/** The stylesheet as a postcss tree: parsed whole when it is sound, recovered rule by rule when it is not. */
function parseRoot(css: string, reader: Reader): postcss.Root {
  const deep = scanChunks(css, false).maxDepth > MAX_NESTING;
  let cause: string | null = null;
  if (!deep) {
    try {
      return postcss.parse(css, { from: undefined });
    } catch (error) {
      cause = (error as Error).message;
    }
  }
  return recover(css, reader, cause);
}

// ── Public API ───────────────────────────────────────────────────────────────────────────────────

/**
 * Parse one Cwicly stylesheet (a generated file, or a compiled-CSS option) into a `CssIndex`.
 *
 * `breakpoints` decides which media queries become `"@--<key>"`. `opts.file` is appended to every
 * artifact's `detail` so a report can say which file it came from, and `opts.palette` lets `!var=`
 * references that the generator left behind resolve to the colour they name.
 *
 * Never throws on bad CSS. A stylesheet postcss cannot parse is read rule by rule instead, as a
 * browser reads it (what cannot be read is reported with its line); a file nested deeper than 64
 * levels loses the rules that are; anything unforeseen ends the read there and is reported.
 */
export function parseCwiclyCss(
  css: string,
  breakpoints: readonly Breakpoint[],
  opts: ParseOptions = {},
): OrderedCssIndex {
  const reader = new Reader(breakpoints, opts);
  const root = parseRoot(css, reader);
  try {
    reader.read(root);
  } catch (error) {
    reader.report(
      CSS_ARTIFACT.syntaxError,
      `the stylesheet could not be read to the end: ${(error as Error).message}`,
    );
  }
  return finish(reader);
}

/** Report every base rule that follows a responsive rule of the same selector and property with another value. */
function reportCascadeOrder(reader: Reader): void {
  const responsive = new Map<string, { value: string; context: string }>();
  const reported = new Set<string>();
  for (const part of reader.rules) {
    for (const [key, value] of part.declarations) {
      const id = `${part.selector}\0${key}`;
      if (part.context.length > 0) {
        responsive.set(id, { value, context: part.context.join(" ") });
        continue;
      }
      const earlier = responsive.get(id);
      if (earlier === undefined || earlier.value === value || reported.has(id)) continue;
      reported.add(id);
      const property = key.startsWith("--") ? key : kebab(key);
      reader.report(
        CSS_ARTIFACT.cascadeOrder,
        `${property}: "${part.selector}" sets "${value}" after ${earlier.context} set "${earlier.value}"; a class tree emits base rules before responsive ones, so there ${earlier.context} keeps "${earlier.value}" (\`projectStyles\` keeps the file's order)`,
        part.selector,
      );
    }
  }
}

function finish(reader: Reader): OrderedCssIndex {
  for (const entry of reader.classes.values()) normaliseOrder(entry.style);
  for (const style of reader.other.values()) normaliseOrder(style);
  reportCascadeOrder(reader);
  return {
    classes: reader.classes,
    other: reader.other,
    atRules: reader.atRules,
    artifacts: reader.artifacts,
    rules: reader.rules,
  };
}

/** The rules a style tree stands for, in the order Jx emits them: own declarations, nested selectors, at-rules. */
function flattenStyle(
  selector: string,
  style: JxStyle,
  context: readonly string[],
  out: CssRulePart[],
): void {
  const declarations: (readonly [string, string])[] = [];
  for (const [key, value] of Object.entries(style)) {
    if (typeof value === "string" || typeof value === "number") {
      declarations.push([key, String(value)] as const);
    }
  }
  if (declarations.length > 0)
    out.push({ layer: 0, selector, context: [...context], declarations });
  for (const [key, value] of Object.entries(style)) {
    if (!isBlock(value)) continue;
    if (key.startsWith("@")) flattenStyle(selector, value, [...context, key], out);
    else flattenStyle(resolveKey(selector, key), value, context, out);
  }
}

/**
 * The rules of an index in source order: its own `rules`, or, for an index that has none (one built
 * by hand, or by an older version of this module), its trees read as a stylesheet, which is the
 * order a converter that emits class by class would write them in.
 */
export function cssRules(index: CssIndex): readonly CssRulePart[] {
  const own = (index as Partial<OrderedCssIndex>).rules;
  if (own !== undefined) return own;
  const parts: CssRulePart[] = [];
  for (const [name, entry] of index.classes) {
    flattenStyle(classSelectorText(name), entry.style, [], parts);
  }
  for (const [selector, style] of index.other) flattenStyle(selector, style, [], parts);
  return parts;
}

/**
 * Merge indexes, later ones winning: a later declaration replaces an earlier one (unless the earlier
 * is `!important` and the later is not), blocks merge recursively, at-rules concatenate with exact
 * duplicates dropped, artifacts concatenate. The inputs are not modified and nothing is shared with
 * the result.
 *
 * The trees are a merge, so they say "the later file wins" even where the later file only has a
 * base rule and the earlier one a responsive rule for the same selector (which a browser resolves
 * for the later file, and the tree, which emits base rules before responsive ones, for the earlier
 * one). The merged `rules` keep every file's rules apart, one layer per input, in order; lay them
 * out with `projectStyles`, which emits one layer after another, and the cascade is the files'.
 */
export function mergeCssIndexes(...indexes: CssIndex[]): OrderedCssIndex {
  const merged = emptyCssIndex();
  const classes = merged.classes as Map<string, ClassStyle>;
  const other = merged.other as Map<string, JxStyle>;
  const rules: CssRulePart[] = [];
  const seen = new Set<string>();
  let layers = 0;
  for (const index of indexes) {
    for (const [name, entry] of index.classes) {
      let target = classes.get(name);
      if (target === undefined) {
        target = { style: {} };
        classes.set(name, target);
      }
      mergeStyle(target.style, entry.style);
    }
    for (const [selector, style] of index.other) {
      let target = other.get(selector);
      if (target === undefined) {
        target = {};
        other.set(selector, target);
      }
      mergeStyle(target, style);
    }
    for (const rule of index.atRules) {
      const fingerprint = JSON.stringify([rule.key, rule.style]);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      merged.atRules.push({ key: rule.key, style: cloneStyle(rule.style) });
    }
    merged.artifacts.push(...index.artifacts.map((artifact) => ({ ...artifact })));
    let top = -1;
    for (const part of cssRules(index)) {
      top = Math.max(top, part.layer);
      rules.push({
        layer: layers + part.layer,
        selector: part.selector,
        context: [...part.context],
        declarations: part.declarations.map(([key, value]) => [key, value] as const),
      });
    }
    layers += top + 1;
  }
  for (const entry of classes.values()) normaliseOrder(entry.style);
  for (const style of other.values()) normaliseOrder(style);
  merged.rules = rules;
  return merged;
}

/**
 * Load, parse and merge stylesheets by name, in the order given (which is the cascade order).
 * Fetches overlap, so a source that limits its own concurrency is what keeps a large list polite.
 * A name the source does not have is skipped and reported as `css.missing-file`; a source that
 * throws makes the whole load throw. `opts.palette` is passed to every parse.
 *
 * The result is `mergeCssIndexes` of the files, so its `rules` hold one layer per file.
 */
export async function loadCssIndex(
  source: CssSource,
  names: readonly string[],
  breakpoints: readonly Breakpoint[],
  opts: Pick<ParseOptions, "palette"> = {},
): Promise<OrderedCssIndex> {
  const unique = [...new Set(names)];
  const indexes = await Promise.all(
    unique.map(async (name): Promise<CssIndex> => {
      const css = await source.get(name);
      if (css === null) {
        const index = emptyCssIndex();
        index.artifacts.push({
          code: CSS_ARTIFACT.missingFile,
          detail: `stylesheet ${name} was not found`,
          file: name,
        });
        return index;
      }
      return parseCwiclyCss(css, breakpoints, { file: name, palette: opts.palette });
    }),
  );
  return mergeCssIndexes(...indexes);
}

// ── Laying the rules out for Jx ──────────────────────────────────────────────────────────────────

/** `@--md`… in the order Cwicly writes its responsive blocks: `min` breakpoints ascending, then `max` descending. */
function breakpointOrder(breakpoints: readonly Breakpoint[]): string[] {
  const own = breakpoints.filter((bp) => !bp.isMain && bp.direction !== "none");
  const mins = own.filter((bp) => bp.direction === "min").toSorted((a, b) => a.width - b.width);
  const maxes = own.filter((bp) => bp.direction === "max").toSorted((a, b) => b.width - a.width);
  return [...mins, ...maxes].map((bp) => `@--${bp.key}`);
}

/** Where a declaration is emitted from inside one stylesheet: the group, the selector's block in it, the nested chain in that. */
type Slot = readonly [group: number, block: number, chain: number];

const slotBefore = (a: Slot, b: Slot): boolean =>
  a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

const laterOf = (a: Slot | undefined, b: Slot): Slot =>
  a === undefined || slotBefore(a, b) ? b : a;

/** What decides whether two selectors can override one another's declarations. */
interface Target {
  /** `a`, `h1`… of the last compound; empty when it names no element type, which any element can have. */
  tag: string;
  /** `::before`…, which only a rule for the same pseudo-element can override. */
  pseudoElement: string;
  /** `0,2,1`: the cascade orders by this before it orders by position. Null when the selector could not be read. */
  specificity: string | null;
}

type Specificity = readonly [number, number, number];

function specificityOf(selector: selectorParser.Selector): Specificity {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const node of selector.nodes) {
    if (node.type === "id") {
      a += 1;
    } else if (node.type === "class" || node.type === "attribute") {
      b += 1;
    } else if (node.type === "tag") {
      c += 1;
    } else if (node.type === "pseudo") {
      const name = node.value.toLowerCase();
      if (name.startsWith("::") || LEGACY_PSEUDO_ELEMENTS.has(name)) {
        c += 1;
      } else if (name === ":where") {
        // Specificity zero.
      } else if (SELECTOR_ARGUMENTS.has(name)) {
        // The most specific argument counts.
        let best: Specificity = [0, 0, 0];
        for (const argument of node.nodes) {
          const inner = specificityOf(argument);
          if (
            inner[0] > best[0] ||
            (inner[0] === best[0] &&
              (inner[1] > best[1] || (inner[1] === best[1] && inner[2] > best[2])))
          ) {
            best = inner;
          }
        }
        a += best[0];
        b += best[1];
        c += best[2];
      } else {
        b += 1;
      }
    }
  }
  return [a, b, c];
}

const targets = new Map<string, Target>();

function targetOf(selector: string): Target {
  let target = targets.get(selector);
  if (target === undefined) {
    if (targets.size > CACHE_LIMIT) targets.clear();
    target = { tag: "", pseudoElement: "", specificity: null };
    try {
      const parsed = selectorParser().astSync(selector).nodes[0];
      const split = parsed === undefined ? null : splitSelector(parsed);
      if (parsed !== undefined && split !== null) {
        const last = split.compounds[split.compounds.length - 1]!;
        const tag = last.find((node) => node.type === "tag");
        const pseudoElements = last
          .filter(
            (node) =>
              node.type === "pseudo" &&
              (node.value.startsWith("::") || LEGACY_PSEUDO_ELEMENTS.has(node.value.toLowerCase())),
          )
          .map(simpleText);
        target = {
          tag: tag === undefined ? "" : tag.value.toLowerCase(),
          pseudoElement: pseudoElements.join(""),
          specificity: specificityOf(parsed).join(","),
        };
      }
    } catch {
      // An unreadable selector overrides, and is overridden by, everything.
    }
    targets.set(selector, target);
  }
  return target;
}

/** The latest slot that sets one property (or, for a shorthand's entry, one of its longhands), at one specificity and importance. */
interface Latest {
  /** Over every element type. */
  any: Slot;
  byTag: Map<string, Slot>;
}

/** The state of the stylesheet being laid out. */
class Sheet {
  readonly base = new Map<string, JxStyle>();
  readonly conditional = new Map<string, Map<string, JxStyle>>();
  private readonly latest = new Map<string, Latest>();
  private readonly blocks = new Map<string, number>();
  private readonly blockCounts = new Map<string, number>();
  private readonly chains = new Map<string, number>();
  private readonly chainCounts = new Map<string, number>();

  constructor(private readonly rankOf: (group: string) => number) {}

  /** Where `part` would land, and what it takes to put it there. */
  slotOf(part: CssRulePart): Slot {
    const group = part.context[0] ?? "";
    const blockId = `${group}\0${part.selector}`;
    const block = this.blocks.get(blockId) ?? this.blockCounts.get(group) ?? 0;
    const chain = part.context.slice(1).join("\0");
    const chainId = `${blockId}\0${chain}`;
    return [
      this.rankOf(group),
      block,
      chain === "" ? 0 : (this.chains.get(chainId) ?? (this.chainCounts.get(blockId) ?? 0) + 1),
    ];
  }

  /**
   * What two declarations must share for their order to matter: the importance, the specificity and
   * the pseudo-element. `tag` is the element type the selector ends in, which two rules must not
   * contradict.
   */
  private bucket(part: CssRulePart, value: string): { prefix: string; tag: string } {
    const target = targetOf(part.selector);
    const important = /!\s*important\s*$/i.test(value) ? 1 : 0;
    return {
      prefix: `${important}\0${target.specificity ?? "?"}\0${target.pseudoElement}`,
      tag: target.tag,
    };
  }

  /**
   * Whether putting `part` at its slot would emit one of its declarations ahead of a declaration that
   * the file puts before it and that it overrides: the same property, or a shorthand and its
   * longhand, at the same importance and specificity, on selectors that can match one element.
   */
  invertsOrder(part: CssRulePart): boolean {
    const slot = this.slotOf(part);
    return part.declarations.some(([key, value]) => {
      const { prefix, tag } = this.bucket(part, value);
      const name = propertyOf(key);
      // The same property and the shorthands that set it (as declared), and the longhands of this one (as listed under it).
      const asked = [
        `${prefix}\0own\0${name}`,
        ...shorthandsOf(name).map((shorthand) => `${prefix}\0own\0${shorthand}`),
        `${prefix}\0members\0${name}`,
      ];
      return asked.some((id) => {
        const latest = this.latest.get(id);
        if (latest === undefined) return false;
        const rival =
          tag === ""
            ? latest.any
            : laterOf(latest.byTag.get(tag), latest.byTag.get("") ?? [-1, 0, 0]);
        return slotBefore(slot, rival);
      });
    });
  }

  private remember(id: string, tag: string, slot: Slot): void {
    let latest = this.latest.get(id);
    if (latest === undefined) {
      latest = { any: slot, byTag: new Map() };
      this.latest.set(id, latest);
    }
    latest.any = laterOf(latest.any, slot);
    latest.byTag.set(tag, laterOf(latest.byTag.get(tag), slot));
  }

  add(part: CssRulePart): void {
    const slot = this.slotOf(part);
    const [outer, ...inner] = part.context;
    const group = outer ?? "";
    const blockId = `${group}\0${part.selector}`;
    if (!this.blocks.has(blockId)) {
      this.blocks.set(blockId, slot[1]);
      this.blockCounts.set(group, slot[1] + 1);
    }
    if (inner.length > 0) {
      const chainId = `${blockId}\0${inner.join("\0")}`;
      if (!this.chains.has(chainId)) {
        this.chains.set(chainId, slot[2]);
        this.chainCounts.set(blockId, slot[2]);
      }
    }
    let target: JxStyle;
    if (outer === undefined) {
      target = this.base.get(part.selector) ?? {};
      this.base.set(part.selector, target);
    } else {
      let selectors = this.conditional.get(outer);
      if (selectors === undefined) {
        selectors = new Map();
        this.conditional.set(outer, selectors);
      }
      const tree = selectors.get(part.selector) ?? {};
      selectors.set(part.selector, tree);
      target = descend(tree, inner);
    }
    for (const [key, value] of part.declarations) {
      setDeclaration(target, key, value);
      const { prefix, tag } = this.bucket(part, value);
      const name = propertyOf(key);
      this.remember(`${prefix}\0own\0${name}`, tag, slot);
      for (const shorthand of shorthandsOf(name)) {
        this.remember(`${prefix}\0members\0${shorthand}`, tag, slot);
      }
    }
  }

  /** The stylesheet as a Jx style object: base blocks, then one block per at-rule in the order of `rankOf`. */
  toStyle(): Record<string, JxStyle> {
    const style: Record<string, JxStyle> = {};
    for (const [selector, block] of this.base) style[selector] = block;
    const keys = [...this.conditional.keys()].toSorted((a, b) => this.rankOf(a) - this.rankOf(b));
    for (const key of keys) style[key] = Object.fromEntries(this.conditional.get(key)!);
    return style;
  }
}

/**
 * The index as `project.json` `style` objects, laid out the way Cwicly writes a stylesheet and the
 * way Jx's site-style builder emits one: every base rule first, in the order of the selector's
 * first rule, then one top-level block per at-rule, `@--md` before `@--sm`, each holding the
 * selectors that have rules in it. Emit the objects in the order given.
 *
 * This is the cascade, where the per-class trees are not. A class's tree keeps its base rules and
 * its breakpoint blocks together, so emitting class by class puts class A's responsive rules before
 * class B's base rules, which is the opposite of the file when B's base rule came first, and an
 * element that carries both classes then gets the wrong padding at that breakpoint. Here, every
 * base rule of a stylesheet comes before every responsive rule of it, as in the file.
 *
 * Source order wins where the layout would break it. A rule that the layout would emit before a rule
 * that overrides it in the file (a base rule that follows a media rule for the same property, a
 * second rule of a class that follows another class's rule for the same property) starts a new
 * stylesheet, so the result is more than one object only for a file that needs it, and each object
 * is emitted after the one before. Stylesheets merged from several files never share an object: a
 * later file's rules, whatever they are, come after an earlier file's, so a global class's media
 * rule loses to a post's base rule, as on the site. A consumer that can hold only one object must
 * merge them, and takes on the ordering errors of the merge.
 *
 * Declaration-less entries (`atRules`: `@font-face`, `@keyframes`, `@import`) are not part of it.
 * `breakpoints` orders the `@--` blocks (`min` ascending, then `max` descending); without them the
 * blocks come in the order they first appear.
 */
export function projectStyles(
  index: CssIndex,
  breakpoints: readonly Breakpoint[] = [],
): Record<string, JxStyle>[] {
  const known = breakpointOrder(breakpoints);
  const sheets: Record<string, JxStyle>[] = [];
  let sheet: Sheet | undefined;
  let layer = Number.NaN;
  const fresh = (): Sheet => {
    // Groups rank by their place in `known`, unknown at-rules after them in the order they appear.
    const unknown: string[] = [];
    return new Sheet((group) => {
      if (group === "") return 0;
      const position = known.indexOf(group);
      if (position !== -1) return 1 + position;
      let place = unknown.indexOf(group);
      if (place === -1) place = unknown.push(group) - 1;
      return 1 + known.length + place;
    });
  };
  for (const part of cssRules(index)) {
    if (sheet === undefined || part.layer !== layer) {
      if (sheet !== undefined) sheets.push(sheet.toStyle());
      sheet = fresh();
      layer = part.layer;
    } else if (sheet.invertsOrder(part)) {
      sheets.push(sheet.toStyle());
      sheet = fresh();
    }
    sheet.add(part);
  }
  if (sheet !== undefined) sheets.push(sheet.toStyle());
  return sheets;
}
