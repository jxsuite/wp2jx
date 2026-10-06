/**
 * Cwicly's site-wide settings, read out of the WordPress options table.
 *
 * Everything the block and CSS converters need from Cwicly that is not stored in a post: the
 * breakpoint list that gives `lg`/`md`/`sm` their meaning, the palette that `!var=<id>!` points
 * into, the global classes that `globalClass[]` points into, font declarations, Cwicly's compiled
 * global CSS, custom code snippets, and the display rules of templates and fragments.
 *
 * Options arrive as raw strings in three dialects, and which one an option is in depends on which
 * code last wrote it: JSON (what the editor sends through the REST API), PHP-serialised arrays
 * (what `update_option()` makes of a PHP array) and plain text (CSS, HTML, flags). `decodeOption`
 * reads all three. No option's shape is trusted: a value that is missing, malformed or of the wrong
 * type falls back to an empty value and lands in the report, and `readCwiclyOptions` never throws.
 *
 * Semantics here were checked against the plugin source (the PHP that reads each option back on the
 * front end) and against both fixture sites' rendered pages, not guessed from the key names:
 *
 * - `cwicly_global_css` is exactly what the page prints in `<style id="cc-global-inline-css">`.
 * - `cwicly_global_stylesheets_rendered` is exactly the served `cc-global-stylesheets.css`.
 * - `cwicly_global_classes_rendered` is NOT the served `cc-global-classes.css`. It is the editor's
 *   per-class cache (a PHP array of `{fontCSS, common, responsive}` keyed by class id), it is not
 *   minified or autoprefixed, and it goes stale in two ways: classes added after its last save have
 *   no entry (8 of fineline's 34 styled classes, 14 of ap's 54), and an entry keeps the rules a
 *   class had when it was last cached (fineline's `.card-default img` is `height:10rem` in the cache
 *   and `20rem` in the served file; about half the cached classes on both sites differ somewhere).
 *   `compiledCss.classes` assembles the cache into one stylesheet in the layout
 *   `cc_make_global_css()` writes (font, common, main breakpoint, then `min` queries ascending, then
 *   `max` queries descending) so that a caller without the file has something to parse, and a
 *   report entry names the styled classes the cache is missing. The file is the authority for what
 *   the live site serves; prefer it whenever it is available.
 * - `cwicly_global_fonts` is HTML (`<link>` tags), printed verbatim into the head.
 * - `cwicly_tailwind` only switches the Tailwind stylesheet on when it is the string `true`; the
 *   plugin's own default is `1`, which does not. Every other flag the PHP reads (`cwicly_optimise`,
 *   `cwicly_deprecated`, a conditions rule's `all`) is the same strict `'true' ===` test, so a boolean
 *   or a `1` left there by a hand edit is off to Cwicly, and so to this module.
 * - The palette lives in `styles.style1.colors` whichever style is active: the plugin registers that
 *   list as the Gutenberg palette, and the editor's CSS generator walks it, replacing a colour's value
 *   with `styles[active].colors[<id>].color` when the active style is another one (whose `colors` is
 *   a map of such overrides, `{}` until one is set). Typography, fonts, elements, gradients and the
 *   background are read from the active style itself.
 *
 * Report entries, each located at `option:<name>`:
 *
 * - `option.missing`: an option every working Cwicly site has is absent (info; warn for the global
 *   styles, global classes and global CSS, whose absence leaves a converter without styles).
 * - `option.malformed` (warn): a value that is there but unusable, or a damaged part of one. The
 *   part is skipped and the rest is read.
 * - `option.default` (info): the breakpoint list is not usable, so the legacy option or Cwicly's
 *   defaults stand in for it.
 * - `option.stale` (warn, or info for orphans only): the per-class CSS cache lacks styled classes.
 * - `option.color-unnamed`, `option.color-duplicate`, `option.class-duplicate` (info): palette and
 *   class bookkeeping a person may want to tidy; `option.color-unresolved` (warn): a global class or
 *   a gradient points at a palette id the palette does not have.
 * - `option.font-unrecognised` (info): a font link or style block that declares no font here.
 * - `interaction.dropped` (warn): global interactions exist and are not carried over.
 */
import { unserialize } from "php-serialize";
import type { Breakpoint, CwiclyOptions, Report, Severity } from "../types.ts";

// ── Output types ─────────────────────────────────────────────────────────────────────────────────

export interface CwiclyBreakpoint extends Breakpoint {
  /** The editor's label for it (`Desktop`, `Tablet`). */
  name?: string;
}

export interface CwiclyColor {
  /** Random id that block attributes and compiled CSS refer to as `!var=<id>!`. */
  id: string;
  /** Empty when the editor never named it. */
  name: string;
  value: string;
  /** The CSS custom property, with its dashes: `--cc-color-1`, `--color-ruaij`. */
  variable: string;
}

export interface CwiclyFont {
  family: string;
  source: "google" | "local" | "system";
  /** Google: the stylesheet URL exactly as Cwicly links it, ready for a `<link>` in the head. */
  url?: string;
  /**
   * Local: the `@font-face` rules, with `{{CC_UPLOAD_URL}}` replaced by the site's uploads URL
   * when that is known. Parse them with `cwicly/css.ts`.
   */
  css?: string;
  /** Local: every font file the CSS refers to, resolved the same way, for the download step. */
  files?: string[];
  /** Local: the option key (`google-montserrat`), which is how blocks and elements name it. */
  key?: string;
  /** Local: the font is on Cwicly's list of fonts loaded on every page (`cwicly_global_css_fonts`). */
  global?: boolean;
}

/**
 * One entry of the active style's `globalElements`: the rule Cwicly compiles for something a site
 * styles globally. The Global Elements panel has five kinds, told apart by what the entry names:
 * headings and tags (`tag`), blocks (`class`, one of Cwicly's own such as `cc-cntr`), custom rules
 * (`customRuleBool` and a `customRule`) and tooltips (`isTooltip`).
 */
export interface CwiclyGlobalElement {
  id: string;
  name: string;
  /** The tag it styles (`h1`, `button`); empty for a block, a custom rule or a tooltip. */
  tag: string;
  /** The Cwicly block class it styles (`cc-sct`, `cc-cntr`, `cc-btn`…); empty when it has none. */
  class: string;
  /**
   * What its declarations are written in front of, built the way the editor's own selector builder
   * builds it (before any pseudo): a tooltip is `.tippy-box[data-theme~="<name>"]`; a custom rule is
   * `customRule` as written (its `:pseudos` placeholder dropped); otherwise the tag (an `input` with a
   * list of types is `input[type="text"],textarea…`) or else `.class`; then each additional class as
   * `.a.b` (`button.ff-btn`), except on a custom rule. It is what `compiledCss.global` has the
   * element's declarations under, so an additional class on a multi-type `input` lands on the last
   * selector only (`input[type="text"],textarea.x`), exactly as the editor writes it.
   */
  selector: string;
  /** Space-separated extra classes the selector carries (`ff-btn`). */
  additionalClass: string;
  /** The free-form selector of a custom rule, as stored (it may hold a `:pseudos` placeholder). */
  customRule: string;
  customRuleBool: boolean;
  isTooltip: boolean;
  /** Cwicly's own attribute names (`fontSize`, `paddingTop`, …), each `{<breakpoint><pseudo>: value}`. */
  value: Record<string, unknown>;
}

/**
 * What a `!var=<id>!` token can name. The editor's picker writes the id of a palette colour, of one
 * of its shades (`paletteColors[n]`, while the colour's `paletteState` is on) or of one of its
 * dynamic variants (`dynamic.<kind>[n]`), and its resolver turns each into the custom property the
 * compiled CSS declares for it.
 */
export interface CwiclyColorRef {
  id: string;
  /** `--cc-color-1`, a shade `--cc-color-1-500`, a variant `--cc-color-1-lt-10`. */
  variable: string;
  kind: "color" | "shade" | "variant";
  /** The palette colour it belongs to; its own id for a colour. */
  colorId: string;
}

/** One entry of the active style's `gradients`, which the editor compiles to `--cc-gradient-<n>`. */
export interface CwiclyGradient {
  name: string;
  /** `--cc-gradient-<n>`: `n` is the entry's 1-based position as stored, so skipped entries leave a gap. */
  variable: string;
  /** The gradient as stored; palette colours in it are `!var=<id>!` tokens (see `resolvePaletteRefs`). */
  value: string;
}

export interface CwiclyGlobalStyles {
  /** The palette: style1's list of colours, with the active style's overrides of their values applied. */
  colors: CwiclyColor[];
  /** The palette's colours by id (a repeated id keeps the last). Shades and variants are in `colorRefs`. */
  colorsById: ReadonlyMap<string, CwiclyColor>;
  /**
   * The colours a Gutenberg palette slug names on the live site. Cwicly registers `cc-<id>` and
   * nothing else, and its generated CSS has `.has-<slug>-color` classes for exactly those (WordPress
   * kebab-cases a slug into a class name, splitting at digits: `cc-xew3h` is `has-cc-xew-3-h-color`).
   */
  colorsBySlug: ReadonlyMap<string, CwiclyColor>;
  /**
   * The variable-named slugs (`textColor: "cc-color-1"`, class `has-cc-color-1-color`): the CSS
   * variable without its dashes. Every palette reference in both sites' core blocks is one of these,
   * so an earlier Cwicly registered them, but the plugin now registers only `cc-<id>` and the live
   * site styles nothing for them (a paragraph that names `cc-color-2` renders uncoloured). A converter
   * chooses between the live site's look (use `colorsBySlug` alone) and the author's intent (fall
   * back to this map, and report that it did).
   */
  colorsByLegacySlug: ReadonlyMap<string, CwiclyColor>;
  /**
   * Every id a `!var=<id>!` token can name: the palette's colours (as in `colorsById`), their shades
   * and their dynamic variants. Pass it to `resolvePaletteRefs`.
   */
  colorRefs: ReadonlyMap<string, CwiclyColorRef>;
  fonts: CwiclyFont[];
  /**
   * The style the site uses (`style1`). Its typography, fonts, elements, gradients and background
   * are read; the palette is style1's, with this style's per-colour overrides applied.
   */
  activeStyle: string;
  /** Its label (`Style 1`). */
  activeStyleName: string;
  /** `--cc-color-background`'s value, when the style sets one. */
  backgroundColor: string | undefined;
  /** Typography per element (`bodyTypography`, `h1Typography`…), raw. */
  themeFonts: Record<string, Record<string, unknown>>;
  /** The named typography presets that blocks pick with `fontGlobalStyle: <1-based index>`, raw. */
  typography: { name: string; value: Record<string, unknown> }[];
  /** Raw `themeElements` (paragraph margins, the button and input presets). */
  themeElements: Record<string, unknown>;
  globalElements: CwiclyGlobalElement[];
  gradients: CwiclyGradient[];
}

/** One class's slice of `cwicly_global_classes_rendered`: CSS text per breakpoint key. */
export interface CwiclyRenderedClass {
  fontCSS: string;
  common: string;
  responsive: Record<string, string>;
}

export interface CwiclyStylesheet {
  name: string;
  /** The source the editor holds, which may be SCSS; `compiledCss.stylesheets` is the compiled result. */
  css: string;
  active: boolean;
}

export interface CwiclyCodeSnippet {
  name: string;
  position: "head" | "bodyOpen" | "footer";
  code: string;
}

/** One list of conditions of a template rule, as `cwicly_conditions` stores it. */
export interface CwiclyConditionRule {
  /** `all: "true"`: the template applies to every request. */
  all: boolean;
  singular: unknown[];
  archive: unknown[];
  author: unknown[];
  acf: unknown[];
  custom: unknown[];
  /** How the lists combine (`includeCondition` / `excludeCondition`). */
  combine: "and" | "or";
  priority?: number;
  /** An HTTP status the template is served with. */
  statusCode?: number;
}

/** The editor's own model of a template's conditions (`cwicly_pre_conditions`), kept verbatim. */
export interface CwiclyPreCondition {
  conditions: unknown[];
  includeCombine: "and" | "or";
  excludeCombine: "and" | "or";
  overridePage?: boolean;
  priority?: number;
}

/** What `cwicly_conditions` and `cwicly_pre_conditions` say about one template, merged by its slug. */
export interface CwiclyTemplateRule {
  slug: string;
  include: CwiclyConditionRule | undefined;
  exclude: CwiclyConditionRule | undefined;
  pre: CwiclyPreCondition | undefined;
  /**
   * Cwicly assigns the template to some requests: its include rule is `all`, or lists conditions.
   * A rule that lists none leaves the choice to WordPress's template hierarchy and the post's own
   * template field.
   */
  assigned: boolean;
}

/** A named fragment of `cwicly_global_parts`: template parts Cwicly inserts where the fragment block is. */
export interface CwiclyFragment {
  id: string;
  name: string;
  /** Template-part slugs rendered, in order. */
  templates: { template: string; preConditions: unknown[] }[];
  conditions: {
    include: Record<string, CwiclyConditionRule>;
    exclude: Record<string, CwiclyConditionRule>;
  };
}

export interface CwiclyDarkMode {
  /** The selector string as stored (`.dark`); Cwicly's own default when unset. */
  darkSelectors: string;
  lightSelectors: string;
  /** The class names in those selectors, which is what `{darkmode_force=dark}` prints. */
  darkClasses: string[];
  lightClasses: string[];
}

/** `cwicly_optimise`: each flag is on only when the stored value is the string `true`. */
export interface CwiclyOptimise {
  /** Off: Cwicly strips the built-in default layout attributes from its blocks. */
  cwiclyDefaults: boolean;
  /** Blocks without styles are printed without their id and class. */
  removeIDsClasses: boolean;
  svgFilter: boolean;
  wordPressGlobalStyles: boolean;
  wordPressEmojis: boolean;
  /** Template parts print without WordPress's wrapper element. */
  templatePartWrapper: boolean;
  /**
   * "Remove Container Block Display Properties": the global CSS leaves out
   * `.cc-cntr{display:flex;flex-direction:column}` (it is also left out under `oldSectionLayout`).
   */
  removeContainerDisplay: boolean;
  /**
   * Legacy: some sites store it, but nothing in Cwicly 1.4.7 or 1.5.0 (PHP, editor or settings
   * screen) reads it, so it changes nothing; `removeContainerDisplay` is the flag that governs the
   * container's display. Fineline stores it on and still has the rule.
   */
  flexOptimisation: boolean;
}

/** `cwicly_deprecated`: blocks keep an older markup/layout generation while a flag is on. */
export interface CwiclyDeprecated {
  oldSectionLayout: boolean;
  oldButton: boolean;
}

/**
 * What the converters need from Cwicly's options: the `CwiclyOptions` contract plus the rest of
 * what the real data shows is used. A field holds an empty value (never `undefined`, unless its
 * type says so) when its option is missing or unusable.
 */
export interface CwiclyOptionsFull extends CwiclyOptions {
  /** `cwicly_db_version`, the generation of the data format (`1.4.7`). */
  version: string | undefined;
  /**
   * In cascade order: `min` breakpoints ascending, then the main one, then `max` breakpoints
   * descending. (Cwicly's own stylesheets write the main breakpoint's rules first, unwrapped.) This
   * is not the stored order that `CwiclyOptions.breakpoints` in src/types.ts describes: it is the
   * order `cc_make_global_css()` writes the media queries in, which `media` has to follow, and
   * `direction` still records the side of the main breakpoint each one was stored on.
   */
  breakpoints: CwiclyBreakpoint[];
  globalStyles: CwiclyGlobalStyles;
  /**
   * `cwicly_global_classes_rendered`, decoded: the editor's per-class CSS, keyed by class id. A
   * cache that predates later edits, so `cc-global-classes.css` wins wherever the two differ.
   */
  globalClassesRendered: ReadonlyMap<string, CwiclyRenderedClass>;
  globalStylesheets: CwiclyStylesheet[];
  /** `cwicly_global_fonts` as stored: the `<link>` tags Cwicly prints in every page's head. */
  globalFontsHtml: string;
  /** The snippets behind `customCode`, with the names the editor gave them. */
  customCodeSnippets: CwiclyCodeSnippet[];
  /** `cwicly_conditions` decoded: `{include: {<template slug>: rule}, exclude: {…}}`. */
  conditions: Record<string, unknown>;
  /** `cwicly_pre_conditions` decoded. */
  preConditions: Record<string, unknown>;
  templateRules: CwiclyTemplateRule[];
  /** `cwicly_global_parts` decoded. */
  globalParts: Record<string, unknown>;
  fragments: CwiclyFragment[];
  /** Pseudo-classes beyond hover, active, focus, before and after that attribute keys may carry. */
  customPseudos: string[];
  /** `cwicly_section_defaults` without its empty entries: property → breakpoint key → value. */
  sectionDefaults: Record<string, Record<string, string>>;
  darkMode: CwiclyDarkMode;
  /** The Tailwind stylesheet is on, which the front end decides by the stored value being `true`. */
  tailwind: boolean;
  optimise: CwiclyOptimise;
  deprecated: CwiclyDeprecated;
  /** `cwicly_global_interactions` decoded; empty on every site seen so far. */
  globalInteractions: unknown;
  /** WordPress's uploads URL, which `{{CC_UPLOAD_URL}}` stands for; undefined when it cannot be derived. */
  uploadsUrl: string | undefined;
}

/** The pseudo-classes Cwicly always offers; anything else comes from `cwicly_pseudos`. */
export const BUILTIN_PSEUDOS: readonly string[] = ["hover", "active", "focus", "before", "after"];

// ── Tolerant decoding ────────────────────────────────────────────────────────────────────────────

/** What a stored option value turned out to be. */
export type DecodedOption =
  /** No row for the option. */
  | { kind: "absent" }
  /** A row, but nothing in it (PHP's `false` is stored as the empty string). */
  | { kind: "empty" }
  /** `native` is a value the caller had already parsed; `text` is a string that is neither JSON nor PHP. */
  | { kind: "value"; format: "json" | "php" | "text" | "native"; value: unknown }
  /** It looked like JSON or PHP but did not parse. */
  | { kind: "invalid"; format: "json" | "php"; error: string; raw: string };

const PHP_HEAD =
  /^(?:a:\d+:\{|O:\d+:"|s:\d+:"|i:[-+]?\d+;|d:[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?;|b:[01];|N;)/;
const JSON_HEAD = /^[[{"]/;
const JSON_SCALAR = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/;

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    // A thrown object with no string form.
    return "unknown error";
  }
}

/**
 * PHP's `unserialize` hands back class instances and BigInts that JSON never has; flatten both so
 * every decoded value is JSON-shaped. Own properties only, and through `fromEntries` so a key named
 * `__proto__` stays data.
 */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function decodeText(raw: string, depth: number): DecodedOption {
  const text = raw.trim();
  let format: "json" | "php";
  let value: unknown;
  if (PHP_HEAD.test(text)) {
    format = "php";
    try {
      value = plain(unserialize(text, {}, { strict: false }));
    } catch (error) {
      return { kind: "invalid", format, error: messageOf(error), raw };
    }
  } else if (JSON_HEAD.test(text) || JSON_SCALAR.test(text)) {
    format = "json";
    try {
      value = JSON.parse(text);
    } catch (error) {
      return { kind: "invalid", format, error: messageOf(error), raw };
    }
  } else {
    return { kind: "value", format: "text", value: raw };
  }
  // A serialised string, or a JSON string literal, can itself hold one more layer (a REST client
  // that encoded an already-encoded value). Unwrap it, but only into something structured.
  if (typeof value === "string" && depth < 2) {
    const inner = value.trim();
    if (PHP_HEAD.test(inner) || JSON_HEAD.test(inner)) {
      const decoded = decodeText(value, depth + 1);
      if (decoded.kind === "value") return decoded;
    }
  }
  return { kind: "value", format, value };
}

/**
 * Decode a stored option value, whatever dialect wrote it. Never throws: a value that looks
 * structured but does not parse comes back as `invalid`, and anything that is neither JSON nor
 * PHP-serialised comes back as its own text.
 */
export function decodeOption(raw: unknown): DecodedOption {
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (typeof raw !== "string") {
    // A value the caller already parsed can still be hostile: a cycle, a getter that throws.
    try {
      return { kind: "value", format: "native", value: plain(raw) };
    } catch (error) {
      return { kind: "invalid", format: "json", error: messageOf(error), raw: "" };
    }
  }
  if (raw.trim() === "") return { kind: "empty" };
  return decodeText(raw, 0);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** An object, where PHP's empty array (`a:0:{}`) and JSON's `[]` both mean "no entries". */
function recordOf(v: unknown): Record<string, unknown> | undefined {
  if (isRecord(v)) return v;
  return Array.isArray(v) && v.length === 0 ? {} : undefined;
}

/** A list, where an object stands for its values (PHP arrays with integer keys, `{}` for none). */
function listOf(v: unknown): unknown[] | undefined {
  if (Array.isArray(v)) return v;
  return isRecord(v) ? Object.values(v) : undefined;
}

const textOf = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined;

function numberOf(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/**
 * The ways a checkbox gets stored where nothing in the PHP tests it strictly: a boolean, `1`, or the
 * strings `1` and `true`. That is the editor's own flags (a stylesheet's `active`, a palette's
 * `paletteState`, an element's `customRuleBool`) and `isMain`, which Cwicly tests by PHP truthiness.
 */
const isOn = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

/**
 * How the plugin tests every optimise and deprecated flag and a conditions rule's `all`:
 * `'true' === $value`. The settings screen writes the strings `true` and `false`, and a boolean or a
 * number stored there is off.
 */
const isTrue = (v: unknown): boolean => v === "true";

/**
 * A member the object itself holds. Names a site chose (a template slug, a CSS property, a font key)
 * can be `constructor` or `__proto__`, which a plain lookup answers from `Object.prototype`.
 */
function own(owner: object, key: string): unknown {
  return Object.hasOwn(owner, key) ? (owner as Record<string, unknown>)[key] : undefined;
}

const combineOf = (v: unknown): "and" | "or" => (v === "or" ? "or" : "and");

const unique = <T>(items: Iterable<T>): T[] => [...new Set(items)];

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// ── Reader ───────────────────────────────────────────────────────────────────────────────────────

/** The options table plus the report, so every section can say what it found wrong where it found it. */
interface Reader {
  raw(name: string): string | undefined;
  decode(name: string): DecodedOption;
  report(
    severity: Severity,
    code: string,
    message: string,
    option: string,
    data?: Record<string, unknown>,
  ): void;
  malformed(option: string, message: string, data?: Record<string, unknown>): void;
}

const NO_REPORT: Report = { add() {}, entries: () => [] };

function makeReader(options: ReadonlyMap<string, string>, report: Report | undefined): Reader {
  const sink = report ?? NO_REPORT;
  const decoded = new Map<string, DecodedOption>();
  const raw = (name: string): string | undefined => {
    try {
      const value: unknown = options.get(name);
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const add: Reader["report"] = (severity, code, message, option, data) => {
    try {
      sink.add({
        severity,
        code,
        message,
        where: `option:${option}`,
        ...(data ? { data } : {}),
      });
    } catch {
      // A broken report sink must not stop the read.
    }
  };
  return {
    raw,
    decode(name) {
      let value = decoded.get(name);
      if (!value) {
        let stored: unknown;
        try {
          stored = options.get(name);
        } catch {
          stored = undefined;
        }
        value = decodeOption(stored);
        decoded.set(name, value);
      }
      return value;
    },
    report: add,
    malformed: (option, message, data) =>
      add("warn", "option.malformed", `${option} ${message}`, option, data),
  };
}

/** Run one section; whatever it throws becomes a report entry and the section's empty value. */
function guard<T>(r: Reader, option: string, fallback: () => T, run: () => T): T {
  try {
    return run();
  } catch (error) {
    r.malformed(option, `could not be read (${messageOf(error)}); using an empty value`);
    return fallback();
  }
}

/**
 * An option expected to hold structured data. Absent and empty are not errors here (the caller
 * decides whether a missing option matters); anything that is not JSON or PHP is.
 */
function structured(r: Reader, option: string): unknown {
  const d = r.decode(option);
  if (d.kind === "absent" || d.kind === "empty") return undefined;
  if (d.kind === "invalid") {
    r.malformed(
      option,
      `is not valid ${d.format === "php" ? "PHP-serialised data" : "JSON"} (${d.error}); ignored`,
    );
    return undefined;
  }
  if (d.format === "text") {
    r.malformed(option, "is plain text where JSON or PHP-serialised data was expected; ignored");
    return undefined;
  }
  return d.value;
}

/** `structured`, where the value must be an object (PHP's empty array counts as one). */
function structuredRecord(r: Reader, option: string): Record<string, unknown> | undefined {
  const value = structured(r, option);
  if (value === undefined) return undefined;
  const record = recordOf(value);
  if (!record) r.malformed(option, "is not an object; ignored");
  return record;
}

/** `structured`, where the value must be a list (an object stands for its values). */
function structuredList(r: Reader, option: string): unknown[] | undefined {
  const value = structured(r, option);
  if (value === undefined) return undefined;
  const list = listOf(value);
  if (!list) r.malformed(option, "is not a list; ignored");
  return list;
}

/** One member of a decoded object that has to be of a given shape; a member of another shape is reported. */
function member<T>(
  r: Reader,
  option: string,
  owner: Record<string, unknown>,
  key: string,
  shape: (value: unknown) => T | undefined,
  expected: string,
): T | undefined {
  const value = owner[key];
  // `null` is how an unset field reaches JSON.
  if (value === undefined || value === null) return undefined;
  const found = shape(value);
  if (found === undefined)
    r.malformed(option, `has a ${key} entry that is not ${expected}; ignored`);
  return found;
}

/** An option expected to hold text (CSS, HTML), where a serialised string is unwrapped. */
function textOption(r: Reader, option: string): string {
  const d = r.decode(option);
  if (d.kind === "absent" || d.kind === "empty") return "";
  if (d.kind === "invalid") return d.raw;
  if (typeof d.value === "string") return d.value;
  // A value that parsed as JSON/PHP into something else was not text after all (`css` that happens
  // to be `[]`); the stored string is what the front end would print.
  const stored = r.raw(option);
  if (stored !== undefined && d.format !== "native") return stored;
  r.malformed(option, "is not text; ignored");
  return "";
}

/**
 * The options a working Cwicly site always has (it writes them on first use), with how much a
 * missing one costs. Options that exist only when a feature is used (dark-mode selectors, local
 * fonts, pseudos) are not listed: their absence means the feature is off.
 */
const EXPECTED: readonly [name: string, severity: Severity][] = [
  ["cwicly_global_styles", "warn"],
  ["cwicly_global_classes", "warn"],
  ["cwicly_global_css", "warn"],
  ["cwicly_global_classes_rendered", "info"],
  ["cwicly_global_stylesheets", "info"],
  ["cwicly_global_stylesheets_rendered", "info"],
  ["cwicly_custom_code", "info"],
  ["cwicly_conditions", "info"],
  ["cwicly_pre_conditions", "info"],
  ["cwicly_global_parts", "info"],
  ["cwicly_section_defaults", "info"],
  ["cwicly_optimise", "info"],
  ["cwicly_deprecated", "info"],
  ["cwicly_db_version", "info"],
];

// ── Breakpoints ──────────────────────────────────────────────────────────────────────────────────

interface BreakpointInput {
  key: string;
  width: number;
  isMain: boolean;
  name?: string;
}

/**
 * Put breakpoints in cascade order and give each its direction. Direction follows the stored
 * position, as `cc_make_global_css()` decides it: listed before the main breakpoint is `min-width`,
 * after is `max-width`. Within a direction Cwicly sorts by width (`ksort` for min, `krsort` for max).
 */
function arrangeBreakpoints(inputs: BreakpointInput[], notes: string[]): CwiclyBreakpoint[] {
  const flagged = inputs.flatMap((b, i) => (b.isMain ? [i] : []));
  let main: number;
  if (flagged.length === 1) {
    main = flagged[0] as number;
  } else if (flagged.length > 1) {
    main = flagged[flagged.length - 1] as number;
    notes.push(
      `has several breakpoints flagged main (${flagged.map((i) => inputs[i]?.key).join(", ")}); using the last, "${inputs[main]?.key}", as Cwicly does`,
    );
  } else {
    // Cwicly itself defaults to `lg` here. Failing that, the widest is the desktop-first main.
    const lg = inputs.findIndex((b) => b.key === "lg");
    main =
      lg >= 0
        ? lg
        : inputs.reduce((best, b, i) => (b.width > (inputs[best]?.width ?? -1) ? i : best), 0);
    notes.push(`flags no breakpoint as main; using "${inputs[main]?.key}"`);
  }
  const placed = inputs.map((b, i) => ({
    ...b,
    isMain: i === main,
    direction: (i === main ? "none" : i < main ? "min" : "max") as Breakpoint["direction"],
  }));
  const mins = placed.filter((b) => b.direction === "min").sort((a, b) => a.width - b.width);
  const maxes = placed.filter((b) => b.direction === "max").sort((a, b) => b.width - a.width);
  const mainBp = placed[main];
  return [...mins, ...(mainBp ? [mainBp] : []), ...maxes].map((b) => ({
    key: b.key,
    width: b.width,
    isMain: b.isMain,
    direction: b.direction,
    ...(b.name !== undefined ? { name: b.name } : {}),
  }));
}

/** The usable entries of `cwicly_breakpoints_list`, the keys skipped for lack of a width, and why none can be used. */
function breakpointInputs(value: unknown): {
  inputs: BreakpointInput[];
  skipped: string[];
  error: string | undefined;
} {
  const inputs: BreakpointInput[] = [];
  const skipped: string[] = [];
  const record = recordOf(value);
  if (!record) return { inputs, skipped, error: "is not an object keyed by breakpoint" };
  for (const [key, entry] of Object.entries(record)) {
    const e = recordOf(entry);
    const width = e ? numberOf(e.width) : undefined;
    const isMain = e ? isOn(e.isMain) : false;
    // The Tailwind preset's main breakpoint is `base` at width 0; any other must have a real width.
    if (key === "" || width === undefined || width < 0 || (width === 0 && !isMain)) {
      skipped.push(JSON.stringify(key));
      continue;
    }
    const name = e ? textOf(e.name) : undefined;
    inputs.push({ key, width, isMain, ...(name ? { name } : {}) });
  }
  const error =
    inputs.length > 0
      ? undefined
      : `has no usable breakpoint${skipped.length > 0 ? ` (no usable width for ${skipped.join(", ")})` : ""}`;
  return { inputs, skipped, error };
}

/** The `$media` map for a breakpoint list, in the list's order. */
function mediaMap(breakpoints: readonly Breakpoint[]): Record<string, string> {
  const media: Record<string, string> = {};
  for (const bp of breakpoints) {
    // A main breakpoint of width 0 (mobile-first) has no base width to declare.
    if (bp.direction === "none") {
      if (bp.width > 0) media["--"] = `${bp.width}px`;
    } else {
      media[`--${bp.key}`] = `(${bp.direction}-width: ${bp.width}px)`;
    }
  }
  return media;
}

/**
 * Cwicly's default breakpoints, written out rather than computed: this is also what a failed
 * section falls back to, and a fallback must not depend on the code that just failed. A fresh
 * object each time, so a caller may change it.
 */
function defaultBreakpoints(): { breakpoints: CwiclyBreakpoint[]; media: Record<string, string> } {
  return {
    breakpoints: [
      { key: "lg", width: 1366, isMain: true, direction: "none", name: "Desktop" },
      { key: "md", width: 992, isMain: false, direction: "max", name: "Tablet" },
      { key: "sm", width: 576, isMain: false, direction: "max", name: "Mobile" },
    ],
    media: { "--": "1366px", "--md": "(max-width: 992px)", "--sm": "(max-width: 576px)" },
  };
}

function readBreakpoints(r: Reader): {
  breakpoints: CwiclyBreakpoint[];
  media: Record<string, string>;
} {
  const LIST = "cwicly_breakpoints_list";
  const LEGACY = "cwicly_breakpoints";
  const notes: string[] = [];
  let inputs: BreakpointInput[] | undefined;
  let source = "";
  let reason = "is not set";

  const list = structured(r, LIST);
  if (list !== undefined) {
    const parsed = breakpointInputs(list);
    if (parsed.error) {
      r.malformed(LIST, `${parsed.error}; falling back`);
      reason = "is not usable";
    } else {
      inputs = parsed.inputs;
      if (parsed.skipped.length > 0) {
        r.malformed(
          LIST,
          `has breakpoints with no usable width (${parsed.skipped.join(", ")}); skipped them`,
        );
      }
    }
  } else if (r.decode(LIST).kind === "invalid" || r.decode(LIST).kind === "value") {
    // `structured` has already reported why it could not use a value that is there.
    reason = "is not usable";
  }

  if (!inputs) {
    // Cwicly's own migration builds the list from the old two-number option: `lg` is always the
    // 1366px main, and a missing `md` or `sm` takes its default.
    const legacy = structured(r, LEGACY);
    if (legacy !== undefined) {
      const record = recordOf(legacy);
      const md = record ? numberOf(record.md) : undefined;
      const sm = record ? numberOf(record.sm) : undefined;
      if (record && Object.keys(record).length === 0) {
        // An empty array is falsy to PHP, so Cwicly treats it as unset as well.
      } else if (record && (md !== undefined || sm !== undefined)) {
        inputs = [
          { key: "lg", width: 1366, isMain: true, name: "Desktop" },
          { key: "md", width: md ?? 992, isMain: false, name: "Tablet" },
          { key: "sm", width: sm ?? 576, isMain: false, name: "Mobile" },
        ];
        source = "the legacy cwicly_breakpoints option, as Cwicly's own migration reads it";
      } else {
        r.malformed(LEGACY, "has no md or sm width; ignored");
      }
    }
  }

  if (!inputs) {
    r.report(
      "info",
      "option.default",
      `${LIST} ${reason}; using Cwicly's defaults (lg 1366 main, md 992, sm 576)`,
      LIST,
    );
    return defaultBreakpoints();
  }
  if (source) r.report("info", "option.default", `${LIST} ${reason}; using ${source}`, LIST);

  const breakpoints = arrangeBreakpoints(inputs, notes);
  if (notes.length > 0) r.malformed(LIST, `${notes.join("; ")}`);
  for (const bp of breakpoints) {
    if (!/^[A-Za-z0-9_-]+$/.test(bp.key)) {
      r.malformed(
        LIST,
        `has a breakpoint key ${JSON.stringify(bp.key)} that is not a valid $media name`,
      );
    }
  }
  return { breakpoints, media: mediaMap(breakpoints) };
}

// ── Palette, typography and fonts ────────────────────────────────────────────────────────────────

const STYLES = "cwicly_global_styles";

interface ActiveStyle {
  key: string;
  name: string;
  /** The style the site uses: its typography, fonts, elements, gradients and background are read. */
  style: Record<string, unknown>;
  /** The style that holds the palette's list of colours: style1, which every style shares. */
  palette: Record<string, unknown>;
  /** The active style's overrides of those colours' values, keyed by colour id; none for style1 itself. */
  overrides: Record<string, unknown>;
}

const noStyle = (): ActiveStyle => ({
  key: "style1",
  name: "",
  style: {},
  palette: {},
  overrides: {},
});

/**
 * The style `activeStyle` names. A missing one falls back to `style1`, then to the first. The
 * palette is read from style1 whichever style that is (see the module doc); only when the styles
 * have no style1 at all does the active style's own list stand in, which Cwicly would not.
 */
function activeStyleOf(r: Reader): ActiveStyle {
  const value = structured(r, STYLES);
  const record = recordOf(value);
  if (!record || Object.keys(record).length === 0) {
    if (value !== undefined && !record) r.malformed(STYLES, "is not an object; ignored");
    return noStyle();
  }
  const styles = recordOf(record.styles);
  if (!styles) {
    r.malformed(STYLES, "has no styles object; ignored");
    return noStyle();
  }
  const styleOf = (k: string) => recordOf(own(styles, k));
  const wanted = textOf(record.activeStyle);
  let key = wanted !== undefined && styleOf(wanted) ? wanted : undefined;
  if (!key) {
    key = styleOf("style1") ? "style1" : Object.keys(styles).find((k) => styleOf(k));
    if (!key) {
      r.malformed(STYLES, "has no usable style; ignored");
      return noStyle();
    }
    r.malformed(
      STYLES,
      wanted === undefined
        ? `does not name an active style; using ${key}`
        : `names the active style ${JSON.stringify(wanted)}, which does not exist; using ${key}`,
    );
  }
  const style = styleOf(key) ?? {};
  const name = textOf(style.name) ?? "";
  if (key === "style1") return { key, name, style, palette: style, overrides: {} };
  const style1 = styleOf("style1");
  if (!style1) {
    r.malformed(
      STYLES,
      `has no style1, where Cwicly keeps the palette; reading the colours of ${JSON.stringify(key)} instead`,
    );
    return { key, name, style, palette: style, overrides: {} };
  }
  // A later style's `colors` is `{}` until it overrides a colour: `{<colour id>: {color}}`. The
  // editor looks it up by id, so a list there (which has no such keys) overrides nothing.
  const overrides = member(r, STYLES, style, "colors", recordOf, "an object keyed by colour id");
  return { key, name, style, palette: style1, overrides: overrides ?? {} };
}

/** A palette colour, with the stored entry it was read from (which may hold shades and variants). */
interface PaletteEntry {
  color: CwiclyColor;
  source: Record<string, unknown>;
}

function readColors(
  r: Reader,
  palette: Record<string, unknown>,
  overrides: Record<string, unknown>,
): PaletteEntry[] {
  // `{}` is how an empty PHP array reaches JSON, so both it and `[]` mean "no colours".
  const list = member(r, STYLES, palette, "colors", listOf, "a list");
  if (list === undefined) return [];
  const entries: PaletteEntry[] = [];
  list.forEach((entry, index) => {
    const e = recordOf(entry);
    const id = e ? textOf(e.id) : undefined;
    const stored = e ? (textOf(e.color) ?? textOf(e.value)) : undefined;
    const bare = e ? textOf(e.variable)?.replace(/^-+/, "") : undefined;
    if (!e || !id || !stored || !bare) {
      r.malformed(
        STYLES,
        `has a palette colour (#${index + 1}) without ${!id ? "an id" : !stored ? "a value" : "a variable"}; skipped`,
      );
      return;
    }
    // The editor's generator writes `overrides[id].color || <style1's colour>`, so an empty one
    // falls through to the palette's own value.
    const override = recordOf(own(overrides, id));
    const value = (override ? textOf(override.color) : undefined) || stored;
    entries.push({
      color: { id, name: textOf(e.name) ?? "", value, variable: `--${bare}` },
      source: e,
    });
  });
  const colors = entries.map((entry) => entry.color);

  const describe = (c: CwiclyColor) =>
    `${c.id} ${c.name ? JSON.stringify(c.name) : "unnamed"} ${c.value}`;
  const groupBy = (key: (c: CwiclyColor) => string | undefined) => {
    const groups = new Map<string, CwiclyColor[]>();
    for (const c of colors) {
      const k = key(c);
      if (k) groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    return [...groups].filter(([, g]) => g.length > 1);
  };
  for (const [id, group] of groupBy((c) => c.id)) {
    r.malformed(
      STYLES,
      `has ${group.length} palette colours with the id ${id}; the last one wins`,
      { id },
    );
  }
  for (const [variable, group] of groupBy((c) => c.variable)) {
    r.malformed(
      STYLES,
      `has ${group.length} palette colours that share ${variable}; the last one wins`,
      { variable },
    );
  }
  const unnamed = colors.filter((c) => c.name.trim() === "");
  if (unnamed.length > 0) {
    r.report(
      "info",
      "option.color-unnamed",
      `${unnamed.length} of ${colors.length} palette colours ${plural(unnamed.length, "has", "have")} no name (${unnamed.map((c) => c.id).join(", ")})`,
      STYLES,
      { ids: unnamed.map((c) => c.id) },
    );
  }
  for (const [name, group] of groupBy((c) => c.name.trim().toLowerCase() || undefined)) {
    r.report(
      "info",
      "option.color-duplicate",
      `${group.length} palette colours are named ${JSON.stringify(group[0]?.name ?? name)}: ${group.map(describe).join("; ")}`,
      STYLES,
      { name, ids: group.map((c) => c.id) },
    );
  }
  for (const [value, group] of groupBy((c) => c.value.trim().toLowerCase())) {
    r.report(
      "info",
      "option.color-duplicate",
      `${group.length} palette colours have the value ${value}: ${group.map(describe).join("; ")}`,
      STYLES,
      { value, ids: group.map((c) => c.id) },
    );
  }
  return entries;
}

/** The steps Cwicly names a colour's shades by, in the order `paletteColors` lists them. */
const SHADE_STEPS: readonly number[] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** What each kind of dynamic variant is called in its custom property (`--cc-color-1-lt-10`). */
const VARIANT_KINDS: ReadonlyMap<string, string> = new Map([
  ["opacity", "op"],
  ["lighten", "lt"],
  ["darken", "dk"],
  ["saturate", "sat"],
  ["desaturate", "desat"],
  ["spin", "sp"],
]);

/**
 * Every id a `!var=<id>!` token can name, as the editor's resolver finds them in style1's palette:
 * a colour's own id first; failing that the first colour (in order) that has a switched-on shade or a
 * dynamic variant with that id. A shade is named by its position among the eleven steps, a variant by
 * its kind's abbreviation and its value with a `.` turned into `-`.
 */
function readColorRefs(r: Reader, entries: readonly PaletteEntry[]): Map<string, CwiclyColorRef> {
  const refs = new Map<string, CwiclyColorRef>();
  for (const { color } of entries) {
    refs.set(color.id, {
      id: color.id,
      variable: color.variable,
      kind: "color",
      colorId: color.id,
    });
  }
  const add = (ref: CwiclyColorRef) => {
    if (!refs.has(ref.id)) refs.set(ref.id, ref);
  };
  for (const { color, source } of entries) {
    if (isOn(source.paletteState)) {
      (listOf(source.paletteColors) ?? []).forEach((shade, index) => {
        const id = textOf(recordOf(shade)?.id);
        if (!id) return;
        const step = SHADE_STEPS[index];
        if (step === undefined) {
          r.malformed(
            STYLES,
            `has a shade (${id}) of the palette colour ${color.id} beyond the ${SHADE_STEPS.length} steps Cwicly names; its token cannot be resolved`,
            { id, colorId: color.id },
          );
          return;
        }
        add({ id, variable: `${color.variable}-${step}`, kind: "shade", colorId: color.id });
      });
    }
    for (const [kind, variants] of Object.entries(recordOf(source.dynamic) ?? {})) {
      const abbreviation = VARIANT_KINDS.get(kind);
      if (abbreviation === undefined) {
        r.malformed(
          STYLES,
          `has dynamic variants of the palette colour ${color.id} of a kind Cwicly has no name for (${JSON.stringify(kind)}); skipped`,
          { colorId: color.id, kind },
        );
        continue;
      }
      for (const variant of listOf(variants) ?? []) {
        const v = recordOf(variant);
        const id = v ? textOf(v.id) : undefined;
        const value = v ? textOf(v.value) : undefined;
        // A variant with no value is a blank row of the editor's picker: it declares nothing.
        if (!id || value === undefined || value.trim() === "") continue;
        add({
          id,
          variable: `${color.variable}-${abbreviation}-${value.replace(".", "-")}`,
          kind: "variant",
          colorId: color.id,
        });
      }
    }
  }
  return refs;
}

const PALETTE_REF = /!var=([A-Za-z0-9_-]+)!/g;

/**
 * Replace every `!var=<id>!` in a string, which is how Cwicly writes a palette colour into a
 * block attribute (and, where its CSS generator forgot to resolve it, into compiled CSS), with
 * `var(--<variable>)`. Ids the palette does not know are left as written and listed in `unresolved`.
 *
 * The palette is `globalStyles.colorRefs` (colours, shades and variants), `colorsById`, or the list
 * `CwiclyOptions.globalStyles.colors` that src/types.ts hands every converter (a repeated id keeps
 * the last, as the map built from that list does).
 */
export function resolvePaletteRefs(
  text: string,
  palette:
    | ReadonlyMap<string, Pick<CwiclyColor, "variable">>
    | readonly Pick<CwiclyColor, "id" | "variable">[],
): { text: string; unresolved: string[] } {
  const lookup: ReadonlyMap<string, Pick<CwiclyColor, "variable">> = "get" in palette
    ? palette
    : new Map(palette.map((c) => [c.id, c]));
  const unresolved: string[] = [];
  const out = text.replace(PALETTE_REF, (whole, id: string) => {
    const color = lookup.get(id);
    if (!color) {
      unresolved.push(id);
      return whole;
    }
    return `var(${color.variable})`;
  });
  return { text: out, unresolved };
}

/** What the editor's selector builder (`x()` in its bundle) works from to write an element's selector. */
interface ElementParts {
  name: string;
  tag: string;
  klass: string;
  additionalClass: string;
  customRule: string;
  customRuleBool: boolean;
  isTooltip: boolean;
  /** The `type` values an `input` element lists, in order. */
  types: readonly string[];
}

/**
 * The selector an element's declarations are written in front of, without a pseudo: the editor's own
 * rules, in its order. Whitespace around and between additional classes is not a class (the editor
 * would write `button.a..b` for it, which is no selector).
 */
function elementSelector(el: ElementParts): string {
  let selector = "";
  if (el.isTooltip) {
    selector = `.tippy-box[data-theme~="${el.name}"]`;
  } else if (el.customRuleBool) {
    selector = el.customRule;
  } else if (el.tag) {
    selector =
      el.types.length > 0
        ? el.types.map((t) => (t === "textarea" ? "textarea" : `${el.tag}[type="${t}"]`)).join(",")
        : el.tag;
  } else if (el.klass) {
    selector = `.${el.klass}`;
  }
  // The placeholder is where a pseudo-class would go; the base rule has none.
  if (el.customRuleBool && el.customRule) selector = selector.replace(":pseudos", "");
  const extra = el.additionalClass.split(/\s+/).filter((c) => c !== "");
  if (extra.length > 0 && !el.customRuleBool) selector += `.${extra.join(".")}`;
  return selector;
}

function readGlobalElements(r: Reader, style: Record<string, unknown>): CwiclyGlobalElement[] {
  const elements: CwiclyGlobalElement[] = [];
  for (const entry of member(r, STYLES, style, "globalElements", listOf, "a list") ?? []) {
    const e = recordOf(entry);
    const value = (e ? recordOf(e.value) : undefined) ?? {};
    const text = (key: string) => (e ? textOf(e[key]) : undefined) ?? "";
    const parts: ElementParts = {
      name: text("name"),
      tag: text("tag"),
      klass: text("class"),
      additionalClass: text("additionalClass"),
      customRule: text("customRule"),
      customRuleBool: e ? isOn(e.customRuleBool) : false,
      isTooltip: e ? isOn(e.isTooltip) : false,
      types:
        text("tag") === "input"
          ? (listOf(value.type) ?? []).flatMap((t) => textOf(recordOf(t)?.value) ?? [])
          : [],
    };
    const selector = e ? elementSelector(parts) : "";
    // Nothing for the declarations to be written in front of: Cwicly's own output for it is no rule.
    if (!e || selector.trim() === "") {
      r.malformed(
        STYLES,
        `has a global element${parts.name ? ` (${JSON.stringify(parts.name)})` : ""} without a tag, class or custom rule, so it selects nothing; skipped`,
      );
      continue;
    }
    elements.push({
      id: text("id"),
      name: parts.name,
      tag: parts.tag,
      class: parts.klass,
      selector,
      additionalClass: parts.additionalClass,
      customRule: parts.customRule,
      customRuleBool: parts.customRuleBool,
      isTooltip: parts.isTooltip,
      value,
    });
  }
  return elements;
}

/** The active style's `gradients`, which the editor numbers by position into `--cc-gradient-<n>`. */
function readGradients(
  r: Reader,
  style: Record<string, unknown>,
  refs: ReadonlyMap<string, CwiclyColorRef>,
): CwiclyGradient[] {
  const gradients: CwiclyGradient[] = [];
  (member(r, STYLES, style, "gradients", listOf, "a list") ?? []).forEach((entry, index) => {
    const e = recordOf(entry);
    const value = e ? textOf(e.color) : undefined;
    if (!e || !value) {
      r.malformed(STYLES, `has a gradient (#${index + 1}) without a colour; skipped`);
      return;
    }
    gradients.push({
      name: textOf(e.name) ?? "",
      variable: `--cc-gradient-${index + 1}`,
      value,
    });
    const { unresolved } = resolvePaletteRefs(value, refs);
    if (unresolved.length > 0) {
      r.report(
        "warn",
        "option.color-unresolved",
        `gradient #${index + 1} refers to ${unique(unresolved).join(", ")}, which the palette no longer has`,
        STYLES,
        { gradient: index + 1, ids: unique(unresolved) },
      );
    }
  });
  return gradients;
}

function readTypography(r: Reader, style: Record<string, unknown>) {
  const themeFonts: [string, Record<string, unknown>][] = [];
  for (const [key, value] of Object.entries(
    member(r, STYLES, style, "themeFonts", recordOf, "an object") ?? {},
  )) {
    const record = recordOf(value);
    if (record) themeFonts.push([key, record]);
  }
  const typography: { name: string; value: Record<string, unknown> }[] = [];
  for (const entry of member(r, STYLES, style, "typography", listOf, "a list") ?? []) {
    const e = recordOf(entry);
    const value = e ? recordOf(e.value) : undefined;
    if (e && value) typography.push({ name: textOf(e.name) ?? "", value });
    else r.malformed(STYLES, "has a typography preset without a value; skipped");
  }
  return {
    // `fromEntries`, so a key named `__proto__` is a key.
    themeFonts: Object.fromEntries(themeFonts),
    typography,
    themeElements: member(r, STYLES, style, "themeElements", recordOf, "an object") ?? {},
    globalElements: readGlobalElements(r, style),
  };
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&#038;": "&",
  "&#38;": "&",
  "&quot;": '"',
  "&#034;": '"',
  "&#34;": '"',
  "&#039;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

const decodeEntities = (s: string): string =>
  s.replace(/&(?:#0?\d+|amp|quot|lt|gt);/g, (e) => ENTITIES[e] ?? e);

/** Font families named in a Google Fonts stylesheet URL: CSS2 (`family=A:wght@400&family=B`) or v1 (`family=A:400|B`). */
function googleFamilies(url: URL): string[] {
  return unique(
    url.searchParams
      .getAll("family")
      .flatMap((value) => value.split("|"))
      .map((value) => (value.split(":")[0] ?? "").trim())
      .filter((family) => family !== ""),
  );
}

/** The `<link>` tags of `cwicly_global_fonts`, which Cwicly prints in the head exactly as stored. */
function readGoogleFonts(r: Reader, html: string): CwiclyFont[] {
  const OPTION = "cwicly_global_fonts";
  const fonts: CwiclyFont[] = [];
  const seen = new Set<string>();
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attr = (name: string): string | undefined => {
      const m = new RegExp(
        `(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
        "i",
      ).exec(tag);
      const value = m?.[1] ?? m?.[2] ?? m?.[3];
      return value === undefined ? undefined : decodeEntities(value);
    };
    const href = attr("href");
    const rel = (attr("rel") ?? "").toLowerCase();
    // preconnect and dns-prefetch hints declare no font.
    if (!href || !rel.split(/\s+/).includes("stylesheet")) continue;
    let url: URL | undefined;
    try {
      url = new URL(href);
    } catch {
      // Not a URL; reported below with the other links nothing could read a font from.
    }
    const families = url?.hostname === "fonts.googleapis.com" ? googleFamilies(url) : [];
    if (families.length === 0) {
      r.report(
        "info",
        "option.font-unrecognised",
        `a stylesheet link in ${OPTION} is not a Google Fonts URL, so no font is declared from it (the link stays in globalFontsHtml): ${href}`,
        OPTION,
        { href },
      );
      continue;
    }
    for (const family of families) {
      if (seen.has(`${family}\n${href}`)) continue;
      seen.add(`${family}\n${href}`);
      fonts.push({ family, source: "google", url: href });
    }
  }
  if (/<style\b/i.test(html)) {
    r.report(
      "info",
      "option.font-unrecognised",
      `${OPTION} holds an inline <style> block, which declares no font here (it stays in globalFontsHtml)`,
      OPTION,
    );
  }
  return fonts;
}

/** WordPress's uploads URL: `upload_url_path` when it is absolute, else `<siteurl>/wp-content/uploads`. */
function uploadsUrlOf(r: Reader): string | undefined {
  const configured = r.raw("upload_url_path")?.trim();
  if (configured && /^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, "");
  const site = r.raw("siteurl")?.trim();
  return site && /^https?:\/\//i.test(site)
    ? `${site.replace(/\/+$/, "")}/wp-content/uploads`
    : undefined;
}

/**
 * Fonts Cwicly serves from the site's own uploads (`cwicly_local_fonts`, a map of `google-<name>` /
 * `custom-<name>` keys to the family and its `@font-face` CSS) and has switched on
 * (`cwicly_local_active_fonts`). The front end prefers `css` over `originalCSS`.
 */
function readLocalFonts(r: Reader, uploads: string | undefined): CwiclyFont[] {
  const defs = structuredRecord(r, "cwicly_local_fonts") ?? {};
  const active = (structuredList(r, "cwicly_local_active_fonts") ?? []).flatMap(
    (k) => textOf(k) ?? [],
  );
  const everyPage = new Set(
    (structuredList(r, "cwicly_global_css_fonts") ?? []).flatMap((k) => textOf(k) ?? []),
  );
  const fonts: CwiclyFont[] = [];
  for (const key of unique(active)) {
    const def = recordOf(own(defs, key));
    const family = def ? textOf(def.family) : undefined;
    const rawCss = def ? textOf(def.css)?.trim() || textOf(def.originalCSS)?.trim() : undefined;
    if (!def || !family || !rawCss) {
      r.malformed(
        "cwicly_local_active_fonts",
        `lists ${JSON.stringify(key)}, which cwicly_local_fonts ${!def ? "does not define" : !family ? "defines without a family" : "defines without any CSS"}; skipped`,
        { key },
      );
      continue;
    }
    const css = uploads ? rawCss.replaceAll("{{CC_UPLOAD_URL}}", () => uploads) : rawCss;
    const files = unique(
      [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi)]
        .map((m) => (m[1] ?? m[2] ?? m[3] ?? "").trim())
        .filter((u) => u !== "" && !u.startsWith("data:")),
    );
    fonts.push({ family, source: "local", css, files, key, global: everyPage.has(key) });
  }
  return fonts;
}

/** Families the active style's typography names that no link or local font declares: left to the system. */
function systemFonts(
  style: Record<string, unknown>,
  declared: readonly CwiclyFont[],
): CwiclyFont[] {
  const GENERIC = new Set([
    "inherit",
    "initial",
    "unset",
    "revert",
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "fangsong",
  ]);
  const known = new Set(declared.map((f) => f.family.toLowerCase()));
  const named: string[] = [];
  for (const typo of Object.values(recordOf(style.themeFonts) ?? {})) {
    const t = recordOf(typo);
    if (t && t.location !== "custom") named.push(textOf(t.family) ?? "");
  }
  for (const entry of listOf(style.typography) ?? []) {
    const value = recordOf(recordOf(entry)?.value);
    if (value && value.location !== "custom") named.push(textOf(value.family) ?? "");
  }
  for (const entry of listOf(style.globalElements) ?? []) {
    const value = recordOf(recordOf(entry)?.value);
    if (value && value.fontLocation !== "custom") named.push(textOf(value.fontFamily) ?? "");
  }
  const families = named
    // The first family of a stack is the one the author chose; the rest are fallbacks.
    .map((f) => (f.split(",")[0] ?? "").replace(/^\s*["']|["']\s*$/g, "").trim())
    .filter((f) => f !== "" && !GENERIC.has(f.toLowerCase()) && !known.has(f.toLowerCase()));
  return unique(families).map((family) => ({ family, source: "system" as const }));
}

function readGlobalStyles(
  r: Reader,
  uploads: string | undefined,
  fontsHtml: string,
): CwiclyGlobalStyles {
  const { key, name, style, palette, overrides } = activeStyleOf(r);
  const entries = readColors(r, palette, overrides);
  const colors = entries.map((entry) => entry.color);
  const colorRefs = readColorRefs(r, entries);
  const typography = readTypography(r, style);
  const declared = [...readGoogleFonts(r, fontsHtml), ...readLocalFonts(r, uploads)];
  return {
    colors,
    colorsById: new Map(colors.map((c) => [c.id, c])),
    // Cwicly registers `cc-<id>`; the variable-named slug is what blocks of an earlier version carry.
    colorsBySlug: new Map(colors.map((c) => [`cc-${c.id}`, c])),
    colorsByLegacySlug: new Map(colors.map((c) => [c.variable.slice(2), c])),
    colorRefs,
    fonts: [...declared, ...systemFonts(style, declared)],
    activeStyle: key,
    activeStyleName: name,
    backgroundColor: textOf(style.backgroundColor) || undefined,
    gradients: readGradients(r, style, colorRefs),
    ...typography,
  };
}

// ── Global classes and compiled CSS ──────────────────────────────────────────────────────────────

/**
 * Attributes every global class carries whether or not it styles anything (the editor writes them
 * as defaults), so a class with none other that holds a value is a class with no CSS.
 */
const BOOKKEEPING = new Set([
  "htmlAttributes",
  "relativeStyles",
  "classID",
  "backgroundImageType",
  "fontGlobalStyle",
  "fontLocation",
  "backgroundType",
  "id",
  "backgroundClipPathActive",
  "ccAClasses",
]);

function holdsValue(v: unknown, depth = 0): boolean {
  if (v === true || typeof v === "number") return true;
  if (typeof v === "string") return v.trim() !== "";
  if (depth > 6) return false;
  if (Array.isArray(v)) return v.some((x) => holdsValue(x, depth + 1));
  return isRecord(v) && Object.values(v).some((x) => holdsValue(x, depth + 1));
}

const hasStyleAttributes = (attrs: Record<string, unknown>): boolean =>
  Object.entries(attrs).some(([k, v]) => !BOOKKEEPING.has(k) && holdsValue(v));

/** `!var=<id>!` references anywhere inside a value, with the attribute path they were found at. */
function paletteRefs(
  value: unknown,
  path: string,
  out: { path: string; id: string }[],
  depth = 0,
): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(PALETTE_REF)) out.push({ path, id: m[1] as string });
  } else if (depth < 8 && value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value))
      paletteRefs(v, path ? `${path}.${k}` : k, out, depth + 1);
  }
}

interface GlobalClasses {
  names: Map<string, string>;
  attrs: Map<string, Record<string, unknown>>;
  styled: Set<string>;
}

function readGlobalClasses(r: Reader, colorRefs: ReadonlyMap<string, unknown>): GlobalClasses {
  const OPTION = "cwicly_global_classes";
  const out: GlobalClasses = { names: new Map(), attrs: new Map(), styled: new Set() };
  const value = structured(r, OPTION);
  if (value === undefined) return out;
  const record = recordOf(value);
  if (!record) {
    r.malformed(OPTION, "is not an object keyed by class id; ignored");
    return out;
  }
  const owners = new Map<string, string[]>();
  for (const [id, entry] of Object.entries(record)) {
    const attributes = recordOf(recordOf(entry)?.attributes);
    if (!attributes) {
      r.malformed(OPTION, `has a class (${id}) without an attributes object; skipped`, { id });
      continue;
    }
    // Cwicly prints no class for a global class without a classID, so there is no name to give it.
    const classID = textOf(attributes.classID);
    if (!classID || classID.trim() === "") {
      r.malformed(
        OPTION,
        `has a class (${id}) without a classID, so blocks using it get no class; skipped`,
        { id },
      );
      continue;
    }
    out.names.set(id, classID);
    out.attrs.set(id, attributes);
    owners.set(classID, [...(owners.get(classID) ?? []), id]);
    if (hasStyleAttributes(attributes)) out.styled.add(id);

    const refs: { path: string; id: string }[] = [];
    paletteRefs(attributes, "", refs);
    const missing = refs.filter((ref) => !colorRefs.has(ref.id));
    if (missing.length > 0) {
      r.report(
        "warn",
        "option.color-unresolved",
        `global class ${classID} refers to ${unique(missing.map((m) => m.id)).join(", ")}, which the palette no longer has (${missing.map((m) => m.path).join(", ")})`,
        OPTION,
        { id, classID, refs: missing },
      );
    }
  }
  for (const [classID, ids] of owners) {
    if (ids.length > 1) {
      r.report(
        "info",
        "option.class-duplicate",
        `${OPTION} has ${ids.length} classes (${ids.join(", ")}) with the classID ${classID}, so their rules share one selector`,
        OPTION,
        { classID, ids },
      );
    }
  }
  return out;
}

function readRendered(r: Reader): Map<string, CwiclyRenderedClass> | string {
  const OPTION = "cwicly_global_classes_rendered";
  const d = r.decode(OPTION);
  if (d.kind === "absent" || d.kind === "empty") return new Map();
  if (d.kind === "invalid") {
    r.malformed(
      OPTION,
      `is not valid ${d.format === "php" ? "PHP-serialised data" : "JSON"} (${d.error}); ignored`,
    );
    return new Map();
  }
  // Plain CSS text is what this option held before the editor started caching per class.
  if (d.format === "text" && typeof d.value === "string") return d.value;
  const record = recordOf(d.value);
  if (!record) {
    r.malformed(OPTION, "is not an object keyed by class id; ignored");
    return new Map();
  }
  const rendered = new Map<string, CwiclyRenderedClass>();
  for (const [id, entry] of Object.entries(record)) {
    const e = recordOf(entry);
    if (!e) continue;
    const responsive: [string, string][] = [];
    for (const [bp, css] of Object.entries(recordOf(e.responsive) ?? {})) {
      const text = textOf(css);
      if (text) responsive.push([bp, text]);
    }
    rendered.set(id, {
      fontCSS: textOf(e.fontCSS) ?? "",
      common: textOf(e.common) ?? "",
      // `fromEntries`, so a breakpoint named `__proto__` is a key.
      responsive: Object.fromEntries(responsive),
    });
  }
  return rendered;
}

/**
 * The stylesheet `cc_make_global_css()` writes from the aggregate of these pieces: fonts, then the
 * rules common to every breakpoint, then the main breakpoint's, then each `min` breakpoint wrapped
 * in a `min-width` query (ascending) and each `max` breakpoint in a `max-width` one (descending).
 * `breakpoints` is already in that order.
 */
function assembleRendered(
  rendered: ReadonlyMap<string, CwiclyRenderedClass>,
  breakpoints: readonly Breakpoint[],
): string {
  let font = "";
  let common = "";
  const fonts = new Set<string>();
  const perBreakpoint = new Map<string, string>();
  for (const c of rendered.values()) {
    // Every class that uses a font repeats its `@import`; one is enough.
    if (c.fontCSS && !fonts.has(c.fontCSS)) {
      fonts.add(c.fontCSS);
      font += c.fontCSS;
    }
    common += c.common;
    for (const [bp, css] of Object.entries(c.responsive))
      perBreakpoint.set(bp, (perBreakpoint.get(bp) ?? "") + css);
  }
  // The base rules come first, unwrapped, so every query after them can override them; the list
  // puts the main breakpoint between the min and max ones, which is the wrong place to write it.
  const main = breakpoints.find((bp) => bp.direction === "none");
  let css = font + common + (main ? (perBreakpoint.get(main.key) ?? "") : "");
  for (const bp of breakpoints) {
    const rules = perBreakpoint.get(bp.key);
    if (bp.direction === "none" || !rules) continue;
    css += `@media screen and (${bp.direction}-width: ${bp.width}px){${rules}}`;
  }
  return css;
}

/**
 * The cache goes stale in both directions: a class added after its last save has no entry, and a
 * deleted class keeps its entry. An entry with no CSS in it is not stale (the editor compiled the
 * class and found nothing to write); only a missing one is.
 */
function reportStaleRendered(
  r: Reader,
  rendered: ReadonlyMap<string, CwiclyRenderedClass>,
  classes: GlobalClasses,
): void {
  const OPTION = "cwicly_global_classes_rendered";
  const uncached = [...classes.styled]
    .filter((id) => !rendered.has(id))
    .map((id) => classes.names.get(id) ?? id);
  const orphaned = [...rendered.keys()].filter((id) => !classes.names.has(id));
  if (uncached.length === 0 && orphaned.length === 0) return;
  const found = [
    ...(uncached.length > 0
      ? [
          `${uncached.length} styled global ${plural(uncached.length, "class has", "classes have")} no entry (${uncached.join(", ")})`,
        ]
      : []),
    ...(orphaned.length > 0
      ? [
          `${orphaned.length} ${plural(orphaned.length, "entry belongs", "entries belong")} to ${plural(orphaned.length, "a class that no longer exists", "classes that no longer exist")}`,
        ]
      : []),
  ];
  r.report(
    uncached.length > 0 ? "warn" : "info",
    "option.stale",
    `${OPTION} is the editor's per-class cache and is out of date: ${found.join("; ")}. compiledCss.classes is incomplete, and entries can predate later edits too; cc-global-classes.css is what the site serves`,
    OPTION,
    { uncached, orphaned },
  );
}

function readCompiledCss(
  r: Reader,
  breakpoints: readonly Breakpoint[],
  classes: GlobalClasses,
): { compiledCss: CwiclyOptions["compiledCss"]; rendered: Map<string, CwiclyRenderedClass> } {
  const result = readRendered(r);
  const rendered = typeof result === "string" ? new Map<string, CwiclyRenderedClass>() : result;
  // An absent option is reported as missing; there is nothing to compare the classes against.
  if (typeof result !== "string" && r.decode("cwicly_global_classes_rendered").kind !== "absent") {
    reportStaleRendered(r, rendered, classes);
  }
  return {
    compiledCss: {
      global: textOption(r, "cwicly_global_css"),
      classes: typeof result === "string" ? result : assembleRendered(rendered, breakpoints),
      stylesheets: textOption(r, "cwicly_global_stylesheets_rendered"),
    },
    rendered,
  };
}

function readStylesheets(r: Reader): CwiclyStylesheet[] {
  const OPTION = "cwicly_global_stylesheets";
  const sheets: CwiclyStylesheet[] = [];
  for (const entry of structuredList(r, OPTION) ?? []) {
    const e = recordOf(entry);
    const name = e ? textOf(e.name) : undefined;
    const css = e ? textOf(e.css) : undefined;
    if (!e || name === undefined || css === undefined) {
      r.malformed(OPTION, "has a stylesheet without a name or css; skipped");
      continue;
    }
    sheets.push({ name, css, active: e.active === undefined ? true : isOn(e.active) });
  }
  return sheets;
}

// ── Custom code ──────────────────────────────────────────────────────────────────────────────────

const CODE_POSITIONS: ReadonlyMap<string, CwiclyCodeSnippet["position"]> = new Map([
  ["head", "head"],
  ["bodyStart", "bodyOpen"],
  ["bodyEnd", "footer"],
]);

function readCustomCode(r: Reader): {
  customCode: CwiclyOptions["customCode"];
  snippets: CwiclyCodeSnippet[];
} {
  const OPTION = "cwicly_custom_code";
  const snippets: CwiclyCodeSnippet[] = [];
  const record = structuredRecord(r, OPTION);
  for (const [name, entry] of Object.entries(record ?? {})) {
    const e = recordOf(entry);
    const position = e ? CODE_POSITIONS.get(textOf(e.position) ?? "") : undefined;
    const code = e ? textOf(e.code) : undefined;
    if (!position || code === undefined) {
      // Cwicly prints nothing for a snippet at any other position, so neither does the migration.
      r.malformed(
        OPTION,
        `has a snippet ${JSON.stringify(name)} with ${!position ? `the position ${JSON.stringify(e ? e.position : undefined)}` : "no code"}, which Cwicly never prints; skipped`,
        { name },
      );
      continue;
    }
    if (code.trim() !== "") snippets.push({ name, position, code });
  }
  // Cwicly joins a position's snippets with a space; both are whitespace between elements.
  const at = (position: CwiclyCodeSnippet["position"]) =>
    snippets
      .filter((s) => s.position === position)
      .map((s) => s.code)
      .join("\n");
  return {
    customCode: { head: at("head"), bodyOpen: at("bodyOpen"), footer: at("footer") },
    snippets,
  };
}

// ── Conditions and parts ─────────────────────────────────────────────────────────────────────────

function readRule(value: unknown, combineKey: string): CwiclyConditionRule | undefined {
  const e = recordOf(value);
  if (!e) return undefined;
  const list = (v: unknown) => listOf(v) ?? [];
  const priority = numberOf(e.priority);
  const statusCode = numberOf(e.statusCode);
  return {
    all: isTrue(e.all),
    singular: list(e.singular),
    archive: list(e.archive),
    author: list(e.author),
    acf: list(e.acf),
    custom: list(e.custom),
    combine: combineOf(e[combineKey]),
    ...(priority !== undefined ? { priority } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
}

const isAssigned = (rule: CwiclyConditionRule | undefined): boolean =>
  rule !== undefined &&
  (rule.all ||
    rule.singular.length +
      rule.archive.length +
      rule.author.length +
      rule.acf.length +
      rule.custom.length >
      0);

/** `{include: {<slug>: rule}, exclude: {<slug>: rule}}`, as `cwicly_conditions` and fragments store it. */
function readRuleSets(
  r: Reader,
  option: string,
  value: unknown,
): {
  include: Record<string, CwiclyConditionRule>;
  exclude: Record<string, CwiclyConditionRule>;
} {
  const sets = recordOf(value) ?? {};
  const read = (key: "include" | "exclude", combineKey: string) => {
    const out: [string, CwiclyConditionRule][] = [];
    const rules = member(r, option, sets, key, recordOf, "an object") ?? {};
    for (const [slug, rule] of Object.entries(rules)) {
      const parsed = readRule(rule, combineKey);
      if (parsed) out.push([slug, parsed]);
      else
        r.malformed(
          option,
          `has a ${key} rule for ${JSON.stringify(slug)} that is not an object; skipped`,
          { slug },
        );
    }
    // `fromEntries`, so a template called `__proto__` is a key.
    return Object.fromEntries(out);
  };
  return {
    include: read("include", "includeCondition"),
    exclude: read("exclude", "excludeCondition"),
  };
}

/** The editor's per-template model: `<slug>` is a list of conditions, `<slug>-conditionTypeInclude` etc. its settings. */
function readPreConditions(pre: Record<string, unknown>): Map<string, CwiclyPreCondition> {
  const out = new Map<string, CwiclyPreCondition>();
  for (const [slug, value] of Object.entries(pre)) {
    if (!Array.isArray(value)) continue;
    const overridePage = pre[`${slug}-conditionOverridePage`];
    const priority = numberOf(pre[`${slug}-conditionPriority`]);
    out.set(slug, {
      conditions: value,
      includeCombine: combineOf(pre[`${slug}-conditionTypeInclude`]),
      excludeCombine: combineOf(pre[`${slug}-conditionTypeExclude`]),
      ...(overridePage !== undefined ? { overridePage: isOn(overridePage) } : {}),
      ...(priority !== undefined ? { priority } : {}),
    });
  }
  return out;
}

function readConditions(r: Reader): {
  conditions: Record<string, unknown>;
  preConditions: Record<string, unknown>;
  templateRules: CwiclyTemplateRule[];
} {
  const conditions = structuredRecord(r, "cwicly_conditions") ?? {};
  const preConditions = structuredRecord(r, "cwicly_pre_conditions") ?? {};
  const sets = readRuleSets(r, "cwicly_conditions", conditions);
  const pre = readPreConditions(preConditions);
  const slugs = unique([...Object.keys(sets.include), ...Object.keys(sets.exclude), ...pre.keys()]);
  // A slug is a name a site chose: `constructor` is a template here, not `Object.prototype`'s.
  const ruleOf = (rules: Record<string, CwiclyConditionRule>, slug: string) =>
    Object.hasOwn(rules, slug) ? rules[slug] : undefined;
  const templateRules = slugs.map((slug) => {
    const include = ruleOf(sets.include, slug);
    return {
      slug,
      include,
      exclude: ruleOf(sets.exclude, slug),
      pre: pre.get(slug),
      assigned: isAssigned(include),
    };
  });
  return { conditions, preConditions, templateRules };
}

function readParts(r: Reader): {
  globalParts: Record<string, unknown>;
  fragments: CwiclyFragment[];
} {
  const OPTION = "cwicly_global_parts";
  const globalParts = structuredRecord(r, OPTION) ?? {};
  const fragments: CwiclyFragment[] = [];
  for (const [id, value] of Object.entries(
    member(r, OPTION, globalParts, "fragments", recordOf, "an object") ?? {},
  )) {
    const e = recordOf(value);
    if (!e) {
      r.malformed(OPTION, `has a fragment (${id}) that is not an object; skipped`, { id });
      continue;
    }
    const templates = (member(r, OPTION, e, "templates", listOf, "a list") ?? []).flatMap((t) => {
      const template = recordOf(t);
      const slug = template ? textOf(template.template) : undefined;
      // A fragment whose template is the empty string has none chosen yet.
      return template && slug
        ? [{ template: slug, preConditions: listOf(template.preConditions) ?? [] }]
        : [];
    });
    fragments.push({
      id,
      name: textOf(e.name) ?? "",
      templates,
      conditions: readRuleSets(r, OPTION, e.conditions),
    });
  }
  return { globalParts, fragments };
}

// ── Small settings ───────────────────────────────────────────────────────────────────────────────

const classNamesOf = (selectors: string): string[] =>
  [...selectors.matchAll(/\.[\w-]+/g)].map((m) => m[0].slice(1));

function darkModeOf(darkSelectors: string, lightSelectors: string): CwiclyDarkMode {
  return {
    darkSelectors,
    lightSelectors,
    darkClasses: classNamesOf(darkSelectors),
    lightClasses: classNamesOf(lightSelectors),
  };
}

/** What the front end and the `darkmode_force` token use when the selectors are unset. */
const DEFAULT_DARK_MODE = darkModeOf(".dark", ".light");

function readDarkMode(r: Reader): CwiclyDarkMode {
  const selectors = (name: string, fallback: string) => textOption(r, name).trim() || fallback;
  return darkModeOf(
    selectors("cwicly_darkmode_selectors", DEFAULT_DARK_MODE.darkSelectors),
    selectors("cwicly_lightmode_selectors", DEFAULT_DARK_MODE.lightSelectors),
  );
}

function readPseudos(r: Reader): string[] {
  // The editor stores a bare list, or `{pseudoClasses: [...]}` once a list exists.
  const value = structured(r, "cwicly_pseudos");
  const list = listOf(isRecord(value) && "pseudoClasses" in value ? value.pseudoClasses : value);
  if (value !== undefined && list === undefined)
    r.malformed("cwicly_pseudos", "is not a list of pseudo-classes; ignored");
  return unique((list ?? []).flatMap((p) => textOf(p)?.trim() || []));
}

function readSectionDefaults(r: Reader): Record<string, Record<string, string>> {
  const out: [string, Record<string, string>][] = [];
  for (const [property, byBreakpoint] of Object.entries(
    structuredRecord(r, "cwicly_section_defaults") ?? {},
  )) {
    const kept: [string, string][] = [];
    for (const [bp, value] of Object.entries(recordOf(byBreakpoint) ?? {})) {
      const text = textOf(value);
      if (text !== undefined && text.trim() !== "") kept.push([bp, text]);
    }
    // `fromEntries`, so a property or breakpoint named `__proto__` is a key.
    if (kept.length > 0) out.push([property, Object.fromEntries(kept)]);
  }
  return Object.fromEntries(out);
}

// ── Entry point ──────────────────────────────────────────────────────────────────────────────────

/**
 * Read Cwicly's options out of the raw option rows. `report`, when given, collects everything that
 * was missing, malformed or stale, each entry located at `option:<name>`. Never throws.
 */
export function readCwiclyOptions(
  options: ReadonlyMap<string, string>,
  report?: Report,
): CwiclyOptionsFull {
  const r = makeReader(options ?? new Map<string, string>(), report);

  const { breakpoints, media } = guard(r, "cwicly_breakpoints_list", defaultBreakpoints, () =>
    readBreakpoints(r),
  );
  const uploadsUrl = uploadsUrlOf(r);
  const globalFontsHtml = guard(
    r,
    "cwicly_global_fonts",
    () => "",
    () => textOption(r, "cwicly_global_fonts"),
  );
  const globalStyles = guard(
    r,
    STYLES,
    (): CwiclyGlobalStyles => ({
      colors: [],
      colorsById: new Map(),
      colorsBySlug: new Map(),
      colorsByLegacySlug: new Map(),
      colorRefs: new Map(),
      fonts: [],
      activeStyle: "style1",
      activeStyleName: "",
      backgroundColor: undefined,
      themeFonts: {},
      typography: [],
      themeElements: {},
      globalElements: [],
      gradients: [],
    }),
    () => readGlobalStyles(r, uploadsUrl, globalFontsHtml),
  );
  const classes = guard(
    r,
    "cwicly_global_classes",
    () => ({ names: new Map(), attrs: new Map(), styled: new Set() }) as GlobalClasses,
    () => readGlobalClasses(r, globalStyles.colorRefs),
  );
  const { compiledCss, rendered } = guard(
    r,
    "cwicly_global_classes_rendered",
    () => ({
      compiledCss: { global: "", classes: "", stylesheets: "" },
      rendered: new Map<string, CwiclyRenderedClass>(),
    }),
    () => readCompiledCss(r, breakpoints, classes),
  );
  const code = guard(
    r,
    "cwicly_custom_code",
    () => ({ customCode: { head: "", bodyOpen: "", footer: "" }, snippets: [] }),
    () => readCustomCode(r),
  );
  const conds = guard(
    r,
    "cwicly_conditions",
    () => ({ conditions: {}, preConditions: {}, templateRules: [] }),
    () => readConditions(r),
  );
  const parts = guard(
    r,
    "cwicly_global_parts",
    () => ({ globalParts: {}, fragments: [] }),
    () => readParts(r),
  );
  const optimise = structuredRecord(r, "cwicly_optimise") ?? {};
  const deprecated = structuredRecord(r, "cwicly_deprecated") ?? {};
  const interactions = guard(
    r,
    "cwicly_global_interactions",
    () => undefined,
    () => structured(r, "cwicly_global_interactions"),
  );
  const interactionCount = listOf(interactions)?.length ?? (interactions === undefined ? 0 : 1);
  if (interactionCount > 0) {
    r.report(
      "warn",
      "interaction.dropped",
      "cwicly_global_interactions defines global interactions, which have no Jx equivalent and are not carried over",
      "cwicly_global_interactions",
      { count: interactionCount },
    );
  }

  for (const [name, severity] of EXPECTED) {
    if (r.decode(name).kind === "absent") {
      r.report(
        severity,
        "option.missing",
        `${name} is not set; its part of the site is empty`,
        name,
      );
    }
  }

  return {
    version: textOption(r, "cwicly_db_version").trim() || undefined,
    breakpoints,
    media,
    globalStyles,
    compiledCss,
    globalClassNames: classes.names,
    globalClassAttrs: classes.attrs,
    globalClassesRendered: rendered,
    globalStylesheets: guard(
      r,
      "cwicly_global_stylesheets",
      () => [],
      () => readStylesheets(r),
    ),
    globalFontsHtml,
    customCode: code.customCode,
    customCodeSnippets: code.snippets,
    conditions: conds.conditions,
    preConditions: conds.preConditions,
    templateRules: conds.templateRules,
    globalParts: parts.globalParts,
    fragments: parts.fragments,
    customPseudos: guard(
      r,
      "cwicly_pseudos",
      () => [],
      () => readPseudos(r),
    ),
    sectionDefaults: guard(
      r,
      "cwicly_section_defaults",
      () => ({}),
      () => readSectionDefaults(r),
    ),
    darkMode: guard(
      r,
      "cwicly_darkmode_selectors",
      () => DEFAULT_DARK_MODE,
      () => readDarkMode(r),
    ),
    tailwind: r.raw("cwicly_tailwind")?.trim() === "true",
    optimise: {
      cwiclyDefaults: isTrue(optimise.cwiclyDefaults),
      removeIDsClasses: isTrue(optimise.removeIDsClasses),
      svgFilter: isTrue(optimise.svgFilter),
      wordPressGlobalStyles: isTrue(optimise.wordPressGlobalStyles),
      wordPressEmojis: isTrue(optimise.wordPressEmojis),
      templatePartWrapper: isTrue(optimise.templatePartWrapper),
      removeContainerDisplay: isTrue(optimise.removeContainerDisplay),
      flexOptimisation: isTrue(optimise.flexOptimisation),
    },
    deprecated: {
      oldSectionLayout: isTrue(deprecated.oldSectionLayout),
      oldButton: isTrue(deprecated.oldButton),
    },
    globalInteractions: interactions ?? [],
    uploadsUrl,
  };
}
