/**
 * WordPress core-block CSS as Jx-native project style.
 *
 * Converted core blocks keep their `wp-block-*`, `has-*` and `align*` classes, and the live sites
 * style them with WordPress's own stylesheets. This module turns those stylesheets into
 * `project.json` `style` entries for exactly the classes a converted site uses, so the migrated pages
 * look the way the live ones do without shipping the whole block library.
 *
 * What the live sites actually serve (read from the saved pages under `tests/fixtures/<site>/html`,
 * not assumed from the WordPress docs). Both fixture sites run Cwicly's "WordPress global styles"
 * optimisation, which removes `wp_enqueue_global_styles`, so a rendered page carries:
 *
 * - `wp-block-library-inline-css`: `wp-includes/css/dist/block-library/common.min.css` (the
 *   `screen-reader-text`, `has-text-align-*`, `has-regular-font-size`… rules every page loads);
 * - one `wp-block-<name>-inline-css` per block the page renders, which is that block's
 *   `wp-includes/blocks/<name>/style.min.css` (WordPress loads core block styles separately);
 * - NO `global-styles-inline-css`, no `classic-theme-styles-inline-css` and no
 *   `core-block-supports-inline-css`. So `--wp--preset--*`, the `.has-<slug>-color` classes of the
 *   theme.json palette and the `is-layout-*` rules do not exist on those sites, and a converted site
 *   that kept their classes must not invent styles for them (`has-large-font-size` renders at the
 *   body size on the live site). Cwicly's own `.has-cc-<id>-color` rules come from its compiled
 *   global CSS (`cc-global-inline-css`), not from WordPress.
 *
 * So the sources are the files WordPress itself prints, in the order it prints them (the per-block
 * sheets, then `common.min.css`). The decision about the presets: a faithful migration serves what the
 * live site serves, so the default is NO preset styles, and the `has-*` classes that WordPress would
 * have styled from theme.json are reported (`corecss.preset-unstyled`) rather than invented. A project
 * that wants the author's intent instead (what the Site Editor showed) adds {@link wpPresetCss}, which
 * derives the preset custom properties and `.has-<slug>-*` classes from the layers
 * {@link wpThemeJsonLayers} reads off a WordPress checkout and the `wp_global_styles` post, with
 * WordPress's own algorithm (see that section's comment, and the test that compares it with
 * `WP_Theme_JSON` itself), as one more source for {@link coreBlockStyle}.
 *
 * How a class set becomes style:
 *
 * - A rule is kept when its selector can match given the classes in use: every class it requires is
 *   used (a class inside `:not()` is not required, a `:where()`/`:is()` is satisfied by one member,
 *   a `[class*=wp-image-]` test is judged against the used names). An attribute test on anything but
 *   `class` (`[style*=border-color]`) cannot be judged from class names and is assumed to hold.
 *   A rule that names no class at all (`ol,ul{box-sizing:border-box}`, `:where(figure){margin:0 0 1em}`)
 *   is ambient: kept when its source is the common sheet or a sheet we cannot attribute to a block,
 *   and, for a block's own sheet, only when the block is in use: named in `options.blocks` (what the
 *   live page does: it loads the sheet whenever the block renders) or, failing that, one of its
 *   classes is in use (a list renders without `wp-block-list` unless it has a background, so the
 *   class is a weak proxy, and the rules dropped on it are reported as `corecss.ambient-dropped`). Id selectors never match
 *   unless the caller lists the ids (`#end-resizable-editor-section` is an editor-only rule).
 * - Rules are read with `parseCwiclyCss` (it reads any stylesheet; what its Cwicly-specific checks
 *   find in WordPress's is reported as `corecss.unreadable`, apart from two things that are expected
 *   here and not forwarded: every media query names no Cwicly breakpoint, and a base rule that follows
 *   a responsive one, which only concerns the class trees the reader builds). It hands back one rule
 *   per selector-list member, in file order, with the declarations cleaned and camelCased, and a media
 *   query as `@(min-width: 782px)` (a literal query) or `@--md` when it equals a declared breakpoint.
 * - Order is the cascade, and a Jx project `style` object is one ordered map, so it is laid out the
 *   way `buildSiteStyleCSS` emits it: each rule is an entry keyed by its selector, its media queries
 *   nested inside it (a top-level `@` key would be emitted after every selector entry and so after
 *   rules that follow it in the file), entries in first-appearance order. A later rule for a key that
 *   already exists is merged into that entry only when that cannot reorder it against a rule of equal
 *   specificity that it overlaps; otherwise it becomes an entry of its own under a key that selects
 *   the same elements (`a, a`), which is where it belongs in the file.
 * - Custom properties declared on `:root` are not emitted as rules: `custom` carries the ones the
 *   kept rules reference (transitively), ready for `project.json` `style`. They are one cascade in
 *   source order: a later declaration replaces an earlier one, an unconditional one ends every
 *   conditional one before it, and a conditional one that cannot be emitted after what it must follow
 *   goes to `verbatim`.
 * - Anything Jx cannot carry goes to `verbatim` (CSS text) and is reported as `corecss.verbatim`:
 *   a rule with a literal `${` in a value (Jx reads it as a template and the project style drops it),
 *   statement at-rules (`@import`), a custom property under a nested condition, and the second and later
 *   `@font-face` of a project (Jx's project-level builder drops the list form). Every selector WordPress's block library uses was
 *   built through Jx (`:where()`, attribute tests with quotes, `:has()`, `:not()` chains), so no
 *   selector needs the escape hatch.
 *
 * Report codes (all `corecss.*`): `verbatim` (warn: kept as CSS text), `fallback` (info: a rule declares
 * one property twice, a fallback, and a style object holds one value), `rekeyed` (info: a rule got an
 * entry of its own to stay after a rule of equal specificity), `var-unresolved` (warn: a kept rule reads
 * a custom property no source declares; info for WordPress's own `--wp--*`), `unreadable` (warn: a source
 * the reader could not fully read), `sources-missing` (warn when no stylesheet was found or a block name
 * is not one; info for a block that has none of its own or is a plugin's), `sources-unscoped` (info: the
 * whole block library was read, not the blocks the pages render), `ambient-dropped` (info: classless rules
 * of a block's sheet dropped because none of its classes is in use and the blocks were not named),
 * `preset-unstyled` (info: a `has-*` class
 * whose rule would come from global styles the site does not serve) and, from {@link wpPresetCss} and
 * {@link wpThemeJsonLayers}, `preset-block-scoped`, `preset-custom`, `preset-fluid`, `preset-duotone`,
 * `preset-styles` (info: a theme.json feature that is not reproduced), `preset-layer-missing` (info) and
 * `preset-layer-malformed` (warn).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cssPropertyName } from "@jxsuite/runtime/css";
import { parse, parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import selectorParser from "postcss-selector-parser";
import { CSS_ARTIFACT, parseCwiclyCss } from "../cwicly/css.ts";
import type { CssRulePart } from "../cwicly/css.ts";
import type { Breakpoint, JxElement, JxNode, JxStyle, Report } from "../types.ts";

/** One stylesheet and where it came from (a path under the WordPress root, a URL, or `inline:<id>`). */
export interface CssSourceText {
  css: string;
  origin: string;
}

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];

// ── Which classes a converted site uses ──────────────────────────────────────────────────────────

/** HTML class-token separators: ASCII whitespace only, so a no-break space stays inside a name. */
const CLASS_SPLIT = /[ \t\n\f\r]+/;

/** A `${…}` expression inside a class string is not a class name; what is left around it is. */
const TEMPLATE = /\$\{[^}]*\}/g;

function addTokens(into: Set<string>, text: string): void {
  for (const token of text.replace(TEMPLATE, " ").split(CLASS_SPLIT)) {
    if (token !== "") into.add(token);
  }
}

const isP5Element = (node: P5Node): node is P5Element => "tagName" in node;

/** Children of a parse5 node, `<template>` contents included. */
function childrenOf(node: P5Node): P5Node[] {
  if ("content" in node && node.content) return node.content.childNodes;
  return "childNodes" in node ? node.childNodes : [];
}

/**
 * A document is parsed as one and a snippet as a fragment: a fragment parse drops the `<html>` and
 * `<body>` tags with their attributes, and WordPress puts `wp-embed-responsive` and friends on `<body>`.
 */
const DOCUMENT_TAG = /<(?:!doctype|html|head|body)[\s>]/i;

function parseMarkup(html: string): P5Node[] {
  return DOCUMENT_TAG.test(html)
    ? [...parse(html).childNodes]
    : [...parseFragment(html).childNodes];
}

/**
 * Every class name in a piece of HTML. The text is parsed, so a `class="…"` that sits inside a
 * script, a comment or an attribute value is not a class.
 */
export function collectWpClassesFromHtml(html: string): Set<string> {
  const found = new Set<string>();
  if (!html.includes("class")) return found;
  const pending: P5Node[] = parseMarkup(html);
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (isP5Element(node)) {
      for (const attribute of node.attrs) {
        if (attribute.name === "class") addTokens(found, attribute.value);
      }
    }
    pending.push(...childrenOf(node));
  }
  return found;
}

/**
 * Every class name in emitted Jx trees: `className`, `attributes.class`, and the markup an element
 * holds as `innerHTML` (an embed's wrapper, an inline svg). Repeaters and `$switch` cases are walked
 * too, since the elements they stamp carry classes. A `${…}` expression in a class string is dropped
 * and the static names around it kept.
 */
export function collectWpClasses(nodes: Iterable<JxNode>): Set<string> {
  const found = new Set<string>();
  const pending: JxNode[] = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (typeof node === "string") continue;
    walkElement(node, found, pending);
  }
  return found;
}

function walkElement(element: JxElement, found: Set<string>, pending: JxNode[]): void {
  if (typeof element.className === "string") addTokens(found, element.className);
  const attributeClass = element.attributes?.class;
  if (typeof attributeClass === "string") addTokens(found, attributeClass);
  if (typeof element.innerHTML === "string") {
    for (const name of collectWpClassesFromHtml(element.innerHTML)) found.add(name);
  }
  const { children } = element;
  if (Array.isArray(children)) pending.push(...children);
  else if (children && typeof children === "object" && children.map) pending.push(children.map);
  // The element a repeater stamps out (`$prototype: "Array"` with `map`), on the element itself.
  const mapped = (element as { map?: unknown }).map;
  if (mapped && typeof mapped === "object") pending.push(mapped as JxElement);
  if (element.cases && typeof element.cases === "object") {
    for (const branch of Object.values(element.cases)) pending.push(branch);
  }
}

// ── Where the stylesheets come from ──────────────────────────────────────────────────────────────

/** The `<style>` blocks WordPress itself prints for blocks and global styles. */
const WP_STYLE_ID =
  /^(?:wp-block-[a-z0-9-]+|global-styles|classic-theme-styles|core-block-supports)-inline-css$/;

const SOURCE_URL = /\/\*#\s*sourceURL=([^*]*?)\s*\*\//g;

/** The text of a `<style>` element, which parse5 keeps as one raw-text child. */
function textOf(element: P5Element): string {
  return element.childNodes
    .map((child) => ("value" in child && typeof child.value === "string" ? child.value : ""))
    .join("");
}

/**
 * The stylesheets WordPress printed inline into a rendered page, in document order: one per block
 * the page renders (`wp-block-image-inline-css`), the block library's common sheet
 * (`wp-block-library-inline-css`), and the global-styles, classic-theme-styles and
 * core-block-supports sheets on a site that prints them. The origin is the `sourceURL` WordPress
 * stamps at the end of each (`…/wp-includes/blocks/image/style.min.css`), else `inline:<id>`, and the
 * comment is removed from the text. Other inline styles (Cwicly's own, plugins', the Customizer's
 * Additional CSS, `wp-img-auto-sizes-contain`) are not WordPress block CSS and are left alone.
 */
export function inlineWpCss(html: string): CssSourceText[] {
  const out: CssSourceText[] = [];
  if (!html.includes("<style")) return out;
  const pending: P5Node[] = parseMarkup(html).toReversed();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (isP5Element(node)) {
      if (node.tagName === "style") {
        const id = node.attrs.find((attribute) => attribute.name === "id")?.value ?? "";
        if (WP_STYLE_ID.test(id)) {
          let css = textOf(node);
          let origin = `inline:${id.replace(/-inline-css$/, "")}`;
          for (const match of css.matchAll(SOURCE_URL)) origin = match[1] ?? origin;
          css = css.replaceAll(SOURCE_URL, "").trim();
          if (css !== "") out.push({ css, origin });
        }
        continue;
      }
    }
    pending.push(...childrenOf(node).toReversed());
  }
  return out;
}

export interface WpCoreCssOptions {
  /**
   * Block names whose own stylesheets to read: the directory names (`image`, `post-terms`) or the
   * registered names the converter counts (`core/image`; the `core/` is dropped). Pass the blocks the
   * pages render, including the ones their template parts and reusable blocks hold: that is what
   * WordPress prints a sheet for, so it is the only way a class borrowed by another block (a
   * `wp-block-button__link` on a login button) is styled the way the live page styles it. A name that
   * is not a block name, belongs to a plugin or has no core stylesheet is reported, not dropped
   * silently (`corecss.sources-missing`).
   *
   * A directory root is listed instead when this is absent; a URL root, which cannot be listed,
   * falls back to the combined `block-library/style.min.css` (every block's rules and the common ones
   * in one file). Both read the whole library, which is reported as `corecss.sources-unscoped`.
   */
  blocks?: Iterable<string>;
  /**
   * Also read the `theme.min.css` sheets, which WordPress loads only for a theme that declares
   * `wp-block-styles` support. Neither fixture site's theme does.
   */
  theme?: boolean;
  /** Replaces `fetch`, for a root that is a URL. */
  fetch?: typeof fetch;
  report?: Report;
}

const BLOCK_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** `namespace/name`: a plugin's or a theme's block, which core prints no stylesheet for. */
const NAMESPACED_BLOCK = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

const isUrl = (root: string): boolean => /^https?:\/\//i.test(root);

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

async function fetchIfPresent(url: string, fetcher: typeof fetch): Promise<string | null> {
  let response: Response;
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "text/css,*/*;q=0.1" },
    });
  } catch (error) {
    throw new Error(`GET ${url} failed: ${(error as Error).message}`, { cause: error });
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  // A host that answers a missing file with its 200 "not found" page has sent no stylesheet.
  if (/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel();
    return null;
  }
  return response.text();
}

/**
 * The stylesheets WordPress loads for core blocks, from a site checkout (`root` is the WordPress
 * directory, the one that holds `wp-includes`) or a live site (`root` is its base URL).
 *
 * With `blocks` (the blocks the pages render) a checkout is read the way a page that loads core block
 * styles separately prints them: each block's `wp-includes/blocks/<name>/style.min.css`
 * (alphabetical; the order WordPress enqueues them in is the order the page renders blocks, which a
 * checkout cannot know, and two block sheets only ever disagree about a class one of them owns), then
 * the common sheet (`css/dist/block-library/common.min.css`) last, as the live pages print it. WITHOUT
 * `blocks` it reads every block's sheet, which is more than any page loads: a class one block borrows
 * from another (the login button's `wp-block-button__link`) is then styled although the live page
 * never loads that sheet, and the result says so (`corecss.sources-unscoped`). A tree without per-block
 * sheets, and any URL root without `blocks`, gets the combined `style.min.css` instead. The
 * unminified `.css` stands in for a missing `.min.css`.
 *
 * Origins are paths under `root` (or URLs), so the block a sheet belongs to can be read off them.
 * A file that does not exist is skipped and noted as `corecss.sources-missing` when nothing at all
 * was found; any other failure to read one (a 5xx, a refused connection) throws.
 */
export async function wpCoreCssSources(
  root: string,
  opts: WpCoreCssOptions = {},
): Promise<CssSourceText[]> {
  const url = isUrl(root);
  const base = url ? root.replace(/\/+$/, "") : root;
  const fetcher = opts.fetch ?? fetch;
  const read = (relative: string): Promise<string | null> =>
    url ? fetchIfPresent(`${base}/${relative}`, fetcher) : readIfPresent(join(base, relative));
  const originOf = (relative: string): string => (url ? `${base}/${relative}` : relative);
  /** `.min.css` first, then the plain file. */
  const readSheet = async (dir: string, name: string): Promise<CssSourceText | null> => {
    for (const file of [`${name}.min.css`, `${name}.css`]) {
      const relative = `${dir}/${file}`;
      const css = await read(relative);
      if (css !== null) return { css, origin: originOf(relative) };
    }
    return null;
  };

  let blocks: string[] | undefined;
  /** Names the caller listed that cannot have a core sheet, by why. */
  const invalid: string[] = [];
  const foreign: string[] = [];
  if (opts.blocks !== undefined) {
    const wanted = new Set<string>();
    for (const given of opts.blocks) {
      const name = given.replace(/^core\//, "");
      if (BLOCK_NAME.test(name)) wanted.add(name);
      else if (NAMESPACED_BLOCK.test(name)) foreign.push(given);
      else invalid.push(given);
    }
    blocks = [...wanted].toSorted();
  } else if (!url) {
    try {
      const entries = await readdir(join(base, "wp-includes/blocks"), { withFileTypes: true });
      blocks = entries
        .filter((entry) => entry.isDirectory() && BLOCK_NAME.test(entry.name))
        .map((entry) => entry.name)
        .toSorted();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }

  const out: CssSourceText[] = [];
  const LIBRARY = "wp-includes/css/dist/block-library";
  /** Listed blocks that turned out to have a sheet of any kind. */
  const sheeted = new Set<string>();
  if (blocks !== undefined) {
    for (const name of blocks) {
      const sheet = await readSheet(`wp-includes/blocks/${name}`, "style");
      if (sheet === null) continue;
      sheeted.add(name);
      if (sheet.css.trim() !== "") out.push(sheet);
    }
    const common = await readSheet(LIBRARY, "common");
    if (common !== null) out.push(common);
  }
  if (out.length === 0) {
    const combined = await readSheet(LIBRARY, "style");
    if (combined !== null) out.push(combined);
  }
  if (opts.theme === true) {
    for (const name of blocks ?? []) {
      const sheet = await readSheet(`wp-includes/blocks/${name}`, "theme");
      if (sheet === null) continue;
      sheeted.add(name);
      if (sheet.css.trim() !== "") out.push(sheet);
    }
    const theme = await readSheet(LIBRARY, "theme");
    if (theme !== null) out.push(theme);
  }
  const report = opts.report;
  if (report !== undefined) {
    if (invalid.length > 0) {
      report.add({
        severity: "warn",
        code: "corecss.sources-missing",
        message: `${invalid.join(", ")}: not a WordPress block name (a directory name such as image, or core/image), so no stylesheet was read for it.`,
        data: { root, blocks: invalid, reason: "invalid-name" },
      });
    }
    if (foreign.length > 0) {
      report.add({
        severity: "info",
        code: "corecss.sources-missing",
        message: `${foreign.join(", ")}: not core blocks, so WordPress core has no stylesheet for them (a plugin or theme prints its own).`,
        data: { root, blocks: foreign, reason: "not-core" },
      });
    }
    const bare = (blocks ?? []).filter((name) => !sheeted.has(name));
    if (bare.length > 0 && out.length > 0) {
      report.add({
        severity: "info",
        code: "corecss.sources-missing",
        message: `${bare.map((name) => `core/${name}`).join(", ")}: no stylesheet of their own under ${root} (many core blocks have none).`,
        data: { root, blocks: bare, reason: "no-sheet" },
      });
    }
    if (opts.blocks === undefined && out.length > 0) {
      report.add({
        severity: "info",
        code: "corecss.sources-unscoped",
        message: `Every block's stylesheet under ${root} was read, not only the blocks the pages render: a class a rendered block borrows from another block is styled although the live page does not load that sheet. Pass \`blocks\` to read what the pages load.`,
        data: { root },
      });
    }
    if (out.length === 0) {
      report.add({
        severity: "warn",
        code: "corecss.sources-missing",
        message: `No WordPress block-library stylesheet was found under ${root}: core blocks will be unstyled.`,
        data: { root },
      });
    }
  }
  return out;
}

// ── theme.json presets ───────────────────────────────────────────────────────────────────────────

/*
 * What WordPress does, and what is ported (read from `wp-includes/class-wp-theme-json.php` of 7.1 and
 * checked against it: see `tests/core/block-css.test.ts`, which runs WordPress's own `WP_Theme_JSON`
 * over the same layers wherever PHP and a WordPress tree exist).
 *
 * `wp_get_global_stylesheet()` builds three layers into one `WP_Theme_JSON`: the core file
 * `wp-includes/theme.json` (origin `default`), the active theme's `theme.json` (`theme`; a child theme
 * merges over its parent) and the user's Site Editor choices, the `wp_global_styles` post of the active
 * theme (`custom`). From the merged `settings` it prints, in this order:
 *
 *   :root{--wp--preset--<kind>--<slug>: <value>; …}                      one block, for every preset
 *   .has-<slug>-color{color: var(--wp--preset--color--<slug>) !important;} …   one rule per class
 *
 * Presets are lists of `{slug, <value>}` and the algorithm is small: a list from layer L is filed under
 * L's origin (a list that is already keyed by origin, which is what the Site Editor saves for a
 * theme's own palette, keeps its keys); a later layer REPLACES the list of the same origin; a `theme`
 * list loses every slug the `default` list has when the defaults are on (`defaultPalette`,
 * `defaultGradients`, `defaultFontSizes`, `defaultSpacingSizes`, `defaultAspectRatios`, `defaultPresets`,
 * which is what "the theme cannot override a default" means); and the printed value of a slug is the
 * one of the LAST origin that has it, at the position of the FIRST (a PHP array assigned twice). A
 * slug is kebab-cased by `_wp_to_kebab_case`, which splits at digits (`cc-xew3h` is `cc-xew-3-h`).
 * Spacing sizes can also come from a `spacingScale`, which WordPress expands into the `20`…`80` steps.
 *
 * The subset implemented is what both fixture sites' data reaches: the root-level presets (aspect
 * ratios, colours, gradients, font sizes, font families, spacing sizes with their scale, shadows,
 * border radii, dimensions). NOT implemented, each reported when a layer needs it: block-scoped
 * presets (`settings.blocks[...]`, which WordPress prints under the block's own selector; the only
 * ones in core are button widths), fluid font sizes (`clamp()` values: the plain `size` is used),
 * `settings.custom` (`--wp--custom--*`) and duotone. `styles` (the body colours, a block's
 * typography, `blockGap`: most of what a Site Editor user changes) is not reproduced either: a theme's
 * or the Site Editor's non-empty `styles` is reported once per layer as `corecss.preset-styles`.
 */

export type ThemeJsonOrigin = "default" | "theme" | "custom";

/** One layer of the merge, in merge order. `json` is the parsed file or post content. */
export interface ThemeJsonLayer {
  origin: ThemeJsonOrigin;
  json: unknown;
  /** Where it was read from, for report entries. */
  label?: string;
}

interface PresetKind {
  /** Path under `settings`. */
  path: readonly string[];
  /** The `settings` flag that, when on, stops a theme preset from taking a default's slug. */
  preventOverride?: readonly string[];
  /** The key that holds the value, or a function of the preset (font sizes). */
  valueKey?: string;
  valueOf?: (preset: Record<string, unknown>) => unknown;
  cssVar: string;
  /** Class template → property. */
  classes: readonly (readonly [string, string])[];
}

/** WordPress's `PRESETS_METADATA` without duotone, in its order (variables and classes are printed in this order). */
const PRESET_KINDS: readonly PresetKind[] = [
  {
    path: ["dimensions", "aspectRatios"],
    preventOverride: ["dimensions", "defaultAspectRatios"],
    valueKey: "ratio",
    cssVar: "--wp--preset--aspect-ratio--",
    classes: [],
  },
  {
    path: ["color", "palette"],
    preventOverride: ["color", "defaultPalette"],
    valueKey: "color",
    cssVar: "--wp--preset--color--",
    classes: [
      [".has-$slug-color", "color"],
      [".has-$slug-background-color", "background-color"],
      [".has-$slug-border-color", "border-color"],
    ],
  },
  {
    path: ["color", "gradients"],
    preventOverride: ["color", "defaultGradients"],
    valueKey: "gradient",
    cssVar: "--wp--preset--gradient--",
    classes: [[".has-$slug-gradient-background", "background"]],
  },
  {
    path: ["typography", "fontSizes"],
    preventOverride: ["typography", "defaultFontSizes"],
    valueOf: (preset) => preset.size,
    cssVar: "--wp--preset--font-size--",
    classes: [[".has-$slug-font-size", "font-size"]],
  },
  {
    path: ["typography", "fontFamilies"],
    valueKey: "fontFamily",
    cssVar: "--wp--preset--font-family--",
    classes: [[".has-$slug-font-family", "font-family"]],
  },
  {
    path: ["spacing", "spacingSizes"],
    preventOverride: ["spacing", "defaultSpacingSizes"],
    valueKey: "size",
    cssVar: "--wp--preset--spacing--",
    classes: [],
  },
  {
    path: ["shadow", "presets"],
    preventOverride: ["shadow", "defaultPresets"],
    valueKey: "shadow",
    cssVar: "--wp--preset--shadow--",
    classes: [],
  },
  {
    path: ["border", "radiusSizes"],
    valueKey: "size",
    cssVar: "--wp--preset--border-radius--",
    classes: [],
  },
  {
    path: ["dimensions", "dimensionSizes"],
    valueKey: "size",
    cssVar: "--wp--preset--dimension--",
    classes: [],
  },
];

const ORIGIN_ORDER = ["default", "theme", "custom"] as const;

type Json = Record<string, unknown>;
type Preset = Record<string, unknown>;

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function jsonAt(root: unknown, path: readonly string[]): unknown {
  let at = root;
  for (const key of path) {
    if (!isJson(at)) return undefined;
    at = at[key];
  }
  return at;
}

/**
 * PCRE with `/u` (PHP) reads `\b` and `\d` as Unicode (UCP); a JavaScript `u` regexp reads them as
 * ASCII, so the port spells them out.
 */
const WORD = "[\\p{L}\\p{N}_]";
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const DIGIT = "\\p{Nd}";

const KEBAB = (() => {
  const lower = "a-z\\xdf-\\xf6\\xf8-\\xff";
  const nonChar = "\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf";
  const punctuation = "\\u{2000}-\\u{206f}";
  const space =
    " \\t\\x0b\\f\\xa0\\u{feff}\\n\\r\\u{2028}\\u{2029}\\u{1680}\\u{180e}\\u{2000}-\\u{200a}\\u{202f}\\u{205f}\\u{3000}";
  const upper = "A-Z\\xc0-\\xd6\\xd8-\\xde";
  const breakRange = nonChar + punctuation + space;
  const rsBreak = `[${breakRange}]`;
  const rsDigits = `${DIGIT}+`;
  const rsLower = `[${lower}]`;
  const rsMisc = `[^${breakRange}${rsDigits}${lower}${upper}]`;
  const rsUpper = `[${upper}]`;
  const rsMiscLower = `(?:${rsLower}|${rsMisc})`;
  const rsMiscUpper = `(?:${rsUpper}|${rsMisc})`;
  const rsOrdLower = `${DIGIT}*(?:1st|2nd|3rd|(?![123])${DIGIT}th)(?=${BOUNDARY}|[A-Z_])`;
  const rsOrdUpper = `${DIGIT}*(?:1ST|2ND|3RD|(?![123])${DIGIT}TH)(?=${BOUNDARY}|[a-z_])`;
  return new RegExp(
    [
      `${rsUpper}?${rsLower}+(?=${rsBreak}|${rsUpper}|$)`,
      `${rsMiscUpper}+(?=${rsBreak}|${rsUpper}${rsMiscLower}|$)`,
      `${rsUpper}?${rsMiscLower}+`,
      `${rsUpper}+`,
      rsOrdUpper,
      rsOrdLower,
      rsDigits,
    ].join("|"),
    "gu",
  );
})();

/** WordPress's `_wp_to_kebab_case` (a port of lodash's `kebabCase`): how a preset slug becomes part of a class or property name. */
export function wpKebabCase(input: string): string {
  // PHP's strtolower is ASCII-only: `É` stays `É`.
  return (input.replaceAll("'", "").match(KEBAB) ?? [])
    .join("-")
    .replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** PHP's `round($n, 2)` followed by string conversion, which is how WordPress writes a generated spacing size. */
function phpRound2(value: number): string {
  const rounded = Number(`${Math.round(Number(`${value}e2`))}e-2`);
  return String(rounded);
}

/** WordPress's `compute_spacing_sizes`: the `20`…`80` steps a `spacingScale` stands for. */
function spacingSizesOf(scale: Json): Preset[] {
  const steps = Number(scale.steps);
  const medium = Number(scale.mediumStep);
  const increment = Number(scale.increment);
  const operator = scale.operator;
  if (
    !Number.isFinite(steps) ||
    steps === 0 ||
    !Number.isFinite(medium) ||
    typeof scale.unit !== "string" ||
    (operator !== "+" && operator !== "*") ||
    !Number.isFinite(increment)
  ) {
    return [];
  }
  const unit = scale.unit === "%" ? "%" : scale.unit.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  // PHP's `round(x, 0)` rounds half away from zero; the step counts here are positive.
  const midPoint = Math.round(steps / 2);
  const below: Preset[] = [];
  let current = medium;
  let slug = 40;
  let remainder = 0;
  for (let count = midPoint - 1; steps > 1 && slug > 0 && count > 0; count -= 1) {
    if (operator === "+") current -= increment;
    else if (increment > 1) current /= increment;
    else current *= increment;
    if (current <= 0) {
      remainder = count;
      break;
    }
    below.push({ slug: String(slug), size: phpRound2(current) + unit });
    slug -= 10;
  }
  below.reverse();
  below.push({ slug: "50", size: `${medium}${unit}` });
  current = medium;
  slug = 60;
  const above = steps - midPoint + remainder;
  for (let count = 0; count < above; count += 1) {
    current =
      operator === "+"
        ? current + increment
        : increment >= 1
          ? current * increment
          : current / increment;
    below.push({ slug: String(slug), size: phpRound2(current) + unit });
    slug += 10;
  }
  return below;
}

/** WordPress's `merge_spacing_sizes`: generated sizes first, then the explicit ones over them, ordered by slug. */
function mergeSpacingSizes(base: readonly Preset[], incoming: readonly Preset[]): Preset[] {
  if (base.length === 0) return [...incoming];
  const merged = new Map<string, Preset>();
  for (const item of [...base, ...incoming]) merged.set(String(item.slug), item);
  return [...merged.entries()]
    .toSorted(([a], [b]) => Number(a) - Number(b))
    .map(([, item]) => item);
}

/**
 * A layer's `settings` the way `WP_Theme_JSON`'s constructor leaves them. A document without a
 * `version` is replaced by an empty one (so a Site Editor post that lacks it contributes nothing), and
 * a version 1 or 2 file is migrated to 3: a theme that lists font sizes or spacing sizes turns the
 * defaults of those off (`defaultFontSizes`, `defaultSpacingSizes`), and one that lists spacing sizes
 * drops its `spacingScale`. The `custom` origin skips that step ("it takes on the value of the theme").
 */
function layerSettings(layer: ThemeJsonLayer): Json | undefined {
  if (!isJson(layer.json) || layer.json.version === undefined || layer.json.version === null) {
    return undefined;
  }
  const settings = layer.json.settings;
  if (!isJson(settings)) return undefined;
  const version = Number(layer.json.version);
  if ((version !== 1 && version !== 2) || layer.origin === "custom") return settings;
  const migrated = structuredClone(settings);
  const typography = isJson(migrated.typography) ? migrated.typography : undefined;
  const spacing = isJson(migrated.spacing) ? migrated.spacing : undefined;
  if (typography?.fontSizes !== undefined && typography.fontSizes !== null) {
    typography.defaultFontSizes = false;
  }
  if (spacing !== undefined) {
    const sizes = spacing.spacingSizes !== undefined && spacing.spacingSizes !== null;
    if (sizes || (spacing.spacingScale !== undefined && spacing.spacingScale !== null)) {
      spacing.defaultSpacingSizes = false;
    }
    if (sizes) delete spacing.spacingScale;
  }
  return migrated;
}

/** A layer's non-empty `styles`, when WordPress would read the document at all (it needs a `version`). */
function layerStyles(layer: ThemeJsonLayer): Json | undefined {
  if (!isJson(layer.json) || layer.json.version === undefined || layer.json.version === null) {
    return undefined;
  }
  const { styles } = layer.json;
  return isJson(styles) && Object.keys(styles).length > 0 ? styles : undefined;
}

/** The merged `settings` presets: per preset kind, a list per origin. */
type Merged = Map<PresetKind, Partial<Record<ThemeJsonOrigin, Preset[]>>>;

function presetList(value: unknown): Preset[] | null {
  return Array.isArray(value) ? value.filter(isJson) : null;
}

/** Merge theme.json layers the way `WP_Theme_JSON::merge` does for the presets and the flags that guard them. */
function mergePresets(
  layers: readonly ThemeJsonLayer[],
  note: (code: string, message: string, data?: Record<string, unknown>) => void,
): Merged {
  const merged: Merged = new Map(PRESET_KINDS.map((kind) => [kind, {}]));
  /** `settings` flags, later layers replacing earlier ones leaf by leaf (`array_replace_recursive`). */
  const flags = new Map<string, unknown>();
  /** `spacingScale` per origin, as WordPress flattens it. */
  let flattenedScale: Json = {};
  const scales: Partial<Record<ThemeJsonOrigin, Json>> = {};
  const reported = new Set<string>();
  const once = (
    code: string,
    message: string,
    data?: Record<string, unknown>,
    identity: string = code,
  ): void => {
    if (reported.has(identity)) return;
    reported.add(identity);
    note(code, message, data);
  };

  for (const layer of layers) {
    const label = layer.label ?? layer.origin;
    // `styles` (body colours, a block's typography, `blockGap`) print as rules of their own, which this
    // port does not produce. Core's own are what an unthemed site gets and are not named.
    const styles = layer.origin === "default" ? undefined : layerStyles(layer);
    if (styles !== undefined) {
      once(
        "corecss.preset-styles",
        `${label}: its styles (${Object.keys(styles).join(", ")}) are not reproduced; only its presets are.`,
        {
          layer: label,
          keys: Object.keys(styles),
          blocks: isJson(styles.blocks) ? Object.keys(styles.blocks) : [],
        },
        `corecss.preset-styles:${label}`,
      );
    }
    const settings = layerSettings(layer);
    if (settings === undefined) continue;
    for (const kind of PRESET_KINDS) {
      const flag = kind.preventOverride;
      if (flag !== undefined) {
        const value = jsonAt(settings, flag);
        if (value !== undefined) flags.set(flag.join("."), value);
      }
    }
    // WordPress's own file declares button widths for `core/button`; nothing in the block library reads them.
    if (layer.origin !== "default" && isJson(settings.blocks)) {
      for (const [name, block] of Object.entries(settings.blocks)) {
        if (PRESET_KINDS.some((kind) => jsonAt(block, kind.path) !== undefined)) {
          once(
            "corecss.preset-block-scoped",
            `${label}: ${name} declares presets of its own; WordPress prints those under the block's selector, which is not reproduced.`,
            { layer: label, block: name },
          );
        }
      }
    }
    if (settings.custom !== undefined) {
      once(
        "corecss.preset-custom",
        `${label}: settings.custom (--wp--custom--*) is not reproduced.`,
        { layer: label },
      );
    }
    if (jsonAt(settings, ["typography", "fluid"])) {
      once(
        "corecss.preset-fluid",
        `${label}: fluid typography is on; font sizes keep their plain size instead of WordPress's clamp() value.`,
        { layer: label },
      );
    }
    // Duotone has no custom property or class of its own (block supports print it), so core's list is not a loss.
    if (layer.origin !== "default" && jsonAt(settings, ["color", "duotone"]) !== undefined) {
      once("corecss.preset-duotone", `${label}: duotone presets are not reproduced.`, {
        layer: label,
      });
    }

    // spacingScale is keyed by origin like a preset; a layer's own scale generates its sizes.
    const rawScale = jsonAt(settings, ["spacing", "spacingScale"]);
    let layerScales: Partial<Record<ThemeJsonOrigin, Json>> | undefined;
    if (isJson(rawScale)) {
      const keyed = ORIGIN_ORDER.some((origin) => origin in rawScale) || "blocks" in rawScale;
      layerScales = keyed
        ? (Object.fromEntries(
            ORIGIN_ORDER.filter((origin) => isJson(rawScale[origin])).map((origin) => [
              origin,
              rawScale[origin],
            ]),
          ) as Partial<Record<ThemeJsonOrigin, Json>>)
        : { [layer.origin]: rawScale };
    }

    const spacingKind = PRESET_KINDS.find((kind) => kind.path[1] === "spacingSizes")!;
    for (const kind of PRESET_KINDS) {
      const raw = jsonAt(settings, kind.path);
      let incoming: Partial<Record<ThemeJsonOrigin, Preset[]>> = {};
      const list = presetList(raw);
      if (list !== null) {
        incoming = { [layer.origin]: list };
      } else if (isJson(raw)) {
        // `{}` is an empty PHP array, which WordPress files as an empty list under the layer's origin.
        if (Object.keys(raw).length === 0) incoming[layer.origin] = [];
        for (const origin of ORIGIN_ORDER) {
          const sub = presetList(raw[origin]);
          if (sub !== null) incoming[origin] = sub;
        }
      }
      if (kind === spacingKind && layerScales !== undefined) {
        // `compute_spacing_sizes` per origin, with partial scales inheriting from lower layers.
        for (const origin of ORIGIN_ORDER) {
          flattenedScale = { ...flattenedScale, ...scales[origin] };
          const own = layerScales[origin];
          if (own === undefined) continue;
          scales[origin] = { ...scales[origin], ...own };
          flattenedScale = { ...flattenedScale, ...own };
          incoming[origin] = mergeSpacingSizes(
            spacingSizesOf(flattenedScale),
            incoming[origin] ?? [],
          );
        }
      }
      if (
        kind.path[1] === "fontSizes" &&
        Object.values(incoming).some((sizes) => sizes.some((size) => size.fluid))
      ) {
        once(
          "corecss.preset-fluid",
          `${label}: a font size is fluid; it keeps its plain size instead of WordPress's clamp() value.`,
          { layer: label },
        );
      }
      const target = merged.get(kind)!;
      const defaultSlugs = new Set(
        (target.default ?? []).flatMap((preset) =>
          typeof preset.slug === "string" ? [preset.slug] : [],
        ),
      );
      const prevent =
        kind.preventOverride === undefined
          ? false
          : Boolean(flags.get(kind.preventOverride.join(".")));
      for (const origin of ORIGIN_ORDER) {
        let content = incoming[origin];
        if (content === undefined) continue;
        if (origin === "theme" && prevent && defaultSlugs.size > 0) {
          content = content.filter(
            (preset) => typeof preset.slug === "string" && !defaultSlugs.has(preset.slug),
          );
        }
        target[origin] = content;
      }
    }
  }
  return merged;
}

export interface WpPresetOptions {
  report?: Report;
  /** Locates report entries. */
  where?: string;
  url?: string;
}

/**
 * The stylesheet WordPress's global styles print for presets: `:root` custom properties and the
 * `.has-<slug>-color` / `-background-color` / `-border-color` / `-gradient-background` / `-font-size` /
 * `-font-family` classes, from theme.json layers in merge order (see the section comment above). Hand
 * the result to {@link coreBlockStyle} as one more source, last: it keeps the classes in use and the
 * properties they read.
 *
 * It covers a layer's `settings` only: its `styles` produce no CSS here and are reported
 * (`corecss.preset-styles`), so "what the Site Editor showed" is only the presets part of it.
 *
 * It is NOT what the fixture sites serve. Both run Cwicly's "WordPress global styles" optimisation,
 * which removes `wp_enqueue_global_styles`, so on the live pages `has-large-font-size` and
 * `has-cc-color-1-background-color` are unstyled and `--wp--preset--*` is undefined. Adding this
 * source makes the migrated site look the way the editor showed it instead of the way the live site
 * does, which is the converter's choice to make; leaving it out reproduces the live site, and the
 * classes it would have styled are reported as `corecss.preset-unstyled`.
 */
export function wpPresetCss(
  layers: readonly ThemeJsonLayer[],
  options: WpPresetOptions = {},
): CssSourceText {
  const note = (code: string, message: string, data?: Record<string, unknown>): void => {
    options.report?.add({
      severity: "info",
      code,
      message,
      ...(options.where === undefined ? {} : { where: options.where }),
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(data === undefined ? {} : { data }),
    });
  };
  const merged = mergePresets(layers, note);
  const values = (kind: PresetKind): Map<string, string> => {
    const out = new Map<string, string>();
    for (const origin of ORIGIN_ORDER) {
      for (const preset of merged.get(kind)?.[origin] ?? []) {
        if (preset.slug === undefined || preset.slug === null) continue;
        const slug = wpKebabCase(String(preset.slug));
        const raw = kind.valueKey === undefined ? kind.valueOf?.(preset) : preset[kind.valueKey];
        if (typeof raw === "string" || typeof raw === "number") out.set(slug, String(raw));
      }
    }
    return out;
  };
  const slugs = (kind: PresetKind): string[] => {
    const out = new Set<string>();
    for (const origin of ORIGIN_ORDER) {
      for (const preset of merged.get(kind)?.[origin] ?? []) {
        if (preset.slug !== undefined && preset.slug !== null)
          out.add(wpKebabCase(String(preset.slug)));
      }
    }
    return [...out];
  };

  let variables = "";
  for (const kind of PRESET_KINDS) {
    for (const [slug, value] of values(kind)) variables += `${kind.cssVar}${slug}: ${value};`;
  }
  let css = variables === "" ? "" : `:root{${variables}}`;
  for (const kind of PRESET_KINDS) {
    const names = slugs(kind);
    for (const [template, property] of kind.classes) {
      for (const slug of names) {
        css += `${template.replace("$slug", slug)}{${property}: var(${kind.cssVar}${slug}) !important;}`;
      }
    }
  }
  return { css, origin: "theme.json:presets" };
}

export interface WpThemeJsonOptions {
  report?: Report;
  where?: string;
  /**
   * Where to read core's `wp-includes/theme.json` when `root` is only the site's `wp-content` (a
   * site repository usually is). Core's file belongs to the WordPress version, not to the site, so any
   * checkout of that version serves.
   */
  coreRoot?: string;
}

async function readJson(path: string): Promise<unknown | undefined> {
  const text = await readIfPresent(path);
  if (text === null) return undefined;
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * The theme.json layers of a site, from what a migration has: a WordPress checkout (`root`, the
 * directory that holds `wp-includes` and `wp-content`) and the database (`model.options`,
 * `model.posts`). In merge order: core `wp-includes/theme.json` (origin `default`); the parent theme's
 * and then the active theme's `theme.json` (`theme`); and the Site Editor's saved choices, the
 * `wp_global_styles` post named `wp-global-styles-<stylesheet>` (`custom`).
 *
 * A layer that is absent is skipped and reported (`corecss.preset-layer-missing`, info): without core
 * there are no default palette or font sizes, without a theme.json the theme is a classic one whose
 * presets come from PHP (`add_theme_support`) that no data here describes. A file that is not valid
 * JSON is reported as `corecss.preset-layer-malformed` (warn) and skipped.
 */
export async function wpThemeJsonLayers(
  root: string,
  model: {
    options: ReadonlyMap<string, string>;
    posts: ReadonlyMap<number, { type: string; status: string; slug: string; content: string }>;
  },
  options: WpThemeJsonOptions = {},
): Promise<ThemeJsonLayer[]> {
  const layers: ThemeJsonLayer[] = [];
  const add = async (
    origin: ThemeJsonOrigin,
    relative: string,
    from: string = root,
  ): Promise<boolean> => {
    let json: unknown;
    try {
      json = await readJson(join(from, relative));
    } catch (error) {
      options.report?.add({
        severity: "warn",
        code: "corecss.preset-layer-malformed",
        message: `${relative} is not valid JSON (${(error as Error).message}); its presets are skipped.`,
        ...(options.where === undefined ? {} : { where: options.where }),
        data: { file: relative },
      });
      return false;
    }
    if (json === undefined) {
      options.report?.add({
        severity: "info",
        code: "corecss.preset-layer-missing",
        message: `${relative} was not found under ${from}; its presets are skipped.`,
        ...(options.where === undefined ? {} : { where: options.where }),
        data: { file: relative },
      });
      return false;
    }
    layers.push({ origin, json, label: relative });
    return true;
  };

  await add("default", "wp-includes/theme.json", options.coreRoot ?? root);
  const stylesheet = model.options.get("stylesheet") ?? model.options.get("template") ?? "";
  const template = model.options.get("template") ?? stylesheet;
  if (stylesheet !== "") {
    const themes = template === stylesheet ? [stylesheet] : [template, stylesheet];
    for (const theme of themes) await add("theme", `wp-content/themes/${theme}/theme.json`);
    const slug = `wp-global-styles-${encodeURIComponent(stylesheet)}`.toLowerCase();
    const post = [...model.posts.values()].find(
      (candidate) =>
        candidate.type === "wp_global_styles" &&
        candidate.slug === slug &&
        candidate.status === "publish",
    );
    if (post !== undefined) {
      try {
        layers.push({ origin: "custom", json: JSON.parse(post.content), label: `post:${slug}` });
      } catch (error) {
        options.report?.add({
          severity: "warn",
          code: "corecss.preset-layer-malformed",
          message: `The ${slug} global styles post is not valid JSON (${(error as Error).message}); the Site Editor's presets are skipped.`,
          ...(options.where === undefined ? {} : { where: options.where }),
          data: { post: slug },
        });
      }
    }
  }
  return layers;
}

// ── Reading a selector ───────────────────────────────────────────────────────────────────────────

type Specificity = readonly [number, number, number];
type Sel = selectorParser.Selector;

/** What the classes and ids a converted site uses say about whether a selector can match. */
interface Use {
  classes: ReadonlySet<string>;
  ids: ReadonlySet<string>;
}

const LEGACY_PSEUDO_ELEMENTS = new Set([":before", ":after", ":first-line", ":first-letter"]);
/** Pseudo-classes whose arguments are selectors, any of which may match. */
const ANY_OF = new Set([":is", ":where", ":matches", ":-webkit-any", ":-moz-any"]);

function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function specificityOf(selector: Sel): Specificity {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const node of selector.nodes) {
    if (node.type === "id") a += 1;
    else if (node.type === "class" || node.type === "attribute") b += 1;
    else if (node.type === "tag") c += 1;
    else if (node.type === "pseudo") {
      const name = node.value.toLowerCase();
      if (name.startsWith("::") || LEGACY_PSEUDO_ELEMENTS.has(name)) {
        c += 1;
      } else if (name === ":where") {
        // Specificity zero, whatever it holds.
      } else if (ANY_OF.has(name) || name === ":not" || name === ":has") {
        let best: Specificity = [0, 0, 0];
        for (const argument of node.nodes) {
          const inner = specificityOf(argument);
          if (compareSpecificity(inner, best) > 0) best = inner;
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

/** The class-attribute tests (`[class*=wp-image-]`) judged against the class names in use. */
function classAttributeHolds(node: selectorParser.Attribute, used: ReadonlySet<string>): boolean {
  const operator = node.operator;
  if (operator === undefined) return used.size > 0;
  const fold = (text: string): string => (node.insensitive ? text.toLowerCase() : text);
  const value = fold(node.value ?? "");
  const names = [...used].map(fold);
  switch (operator) {
    case "=":
      return value.split(CLASS_SPLIT).every((part) => part === "" || names.includes(part));
    case "~=":
      return names.includes(value);
    case "|=":
      return names.some((name) => name === value || name.startsWith(`${value}-`));
    case "^=":
      return names.some((name) => name.startsWith(value));
    case "$=":
      return names.some((name) => name.endsWith(value));
    case "*=":
      return names.some((name) => name.includes(value));
    default:
      return true;
  }
}

/** Whether every part of the selector can be satisfied by the elements a converted site has. */
function holds(selector: Sel, use: Use): boolean {
  return selector.nodes.every((node) => {
    switch (node.type) {
      case "class":
        return use.classes.has(node.value);
      case "id":
        return use.ids.has(node.value);
      case "attribute":
        return node.attribute === "class" ? classAttributeHolds(node, use.classes) : true;
      case "pseudo": {
        const name = node.value.toLowerCase();
        if (ANY_OF.has(name) || name === ":has") {
          return node.nodes.length === 0 || node.nodes.some((argument) => holds(argument, use));
        }
        // `:not(.x)`, `:hover`, `::before`: nothing in a class list rules them out.
        return true;
      }
      default:
        return true;
    }
  });
}

/** Whether the selector requires a class (or tests the class attribute) however it is matched. */
function namesClass(selector: Sel): boolean {
  return selector.nodes.some((node) => {
    if (node.type === "class") return true;
    if (node.type === "attribute") return node.attribute === "class";
    if (node.type === "pseudo") {
      const name = node.value.toLowerCase();
      if (ANY_OF.has(name) || name === ":has") {
        return node.nodes.length > 0 && node.nodes.every(namesClass);
      }
    }
    return false;
  });
}

interface SelectorFacts {
  parsed: Sel | null;
  specificity: Specificity;
  /** The element type the selector ends in, lower case; empty when it names none. */
  tag: string;
  /** `::before`…: only a rule for the same pseudo-element can override this one. */
  pseudoElement: string;
  /** The ids of the last compound. */
  ids: readonly string[];
  /** Classless rules are ambient: nothing in a class list says whether they apply. */
  classless: boolean;
}

const factsCache = new Map<string, SelectorFacts>();

/**
 * The element type a compound selector ends in. The reader writes `p.a` as `.a:is(p)` (same
 * specificity), so a lone type inside `:is()` is the type too.
 */
function tagOfCompound(compound: readonly selectorParser.Node[]): string {
  for (const node of compound) {
    if (node.type === "tag") return node.value.toLowerCase();
    if (node.type === "pseudo" && node.value.toLowerCase() === ":is" && node.nodes.length === 1) {
      const inner = node.nodes[0]!.nodes;
      if (inner.length === 1 && inner[0]!.type === "tag") return inner[0]!.value.toLowerCase();
    }
  }
  return "";
}

function selectorFacts(selector: string): SelectorFacts {
  let facts = factsCache.get(selector);
  if (facts === undefined) {
    if (factsCache.size > 20_000) factsCache.clear();
    facts = {
      parsed: null,
      specificity: [0, 0, 0],
      tag: "",
      pseudoElement: "",
      ids: [],
      classless: false,
    };
    try {
      const parsed = selectorParser().astSync(selector).nodes[0];
      if (parsed !== undefined) {
        let last: selectorParser.Node[] = [];
        for (const node of parsed.nodes) {
          if (node.type === "combinator") last = [];
          else last.push(node);
        }
        const pseudoElements = last.flatMap((node) => {
          if (node.type !== "pseudo") return [];
          const name = node.value.toLowerCase();
          if (LEGACY_PSEUDO_ELEMENTS.has(name)) return [`:${name}`];
          return name.startsWith("::") ? [name] : [];
        });
        facts = {
          parsed,
          specificity: specificityOf(parsed),
          tag: tagOfCompound(last),
          pseudoElement: pseudoElements.join(""),
          ids: last.filter((node) => node.type === "id").map((node) => node.value),
          classless: !parsed.nodes.some(
            (node) =>
              node.type === "class" ||
              (node.type === "attribute" && node.attribute === "class") ||
              (node.type === "pseudo" && namesClass({ nodes: [node] } as unknown as Sel)),
          ),
        };
      }
    } catch {
      // The reader placed it, so a browser reads it; what it means is beyond this analysis.
    }
    factsCache.set(selector, facts);
  }
  return facts;
}

/** Whether two selectors could style one element: a type, an id or a pseudo-element that differs says no. */
function mayShareAnElement(a: SelectorFacts, b: SelectorFacts): boolean {
  if (a.tag !== "" && b.tag !== "" && a.tag !== b.tag) return false;
  if (a.pseudoElement !== b.pseudoElement) return false;
  if (a.ids.length > 0 && b.ids.length > 0 && a.ids.some((id) => !b.ids.includes(id))) return false;
  return true;
}

// ── Declarations that can override one another ───────────────────────────────────────────────────

/** Properties that set each other without sharing a first word (`gap` sets `row-gap`, `inset` sets `top`), and aliases. */
const FAMILY: Readonly<Record<string, string>> = {
  "row-gap": "gap",
  "column-gap": "gap",
  "grid-gap": "gap",
  "grid-row-gap": "gap",
  "grid-column-gap": "gap",
  top: "inset",
  right: "inset",
  bottom: "inset",
  left: "inset",
  // A shorthand is in its own family too: its first word is not its longhands' (`place-content` sets
  // `align-content`, which does not start with `place`).
  "flex-flow": "flex-flow",
  "flex-direction": "flex-flow",
  "flex-wrap": "flex-flow",
  "place-content": "place-content",
  "align-content": "place-content",
  "justify-content": "place-content",
  "place-items": "place-items",
  "align-items": "place-items",
  "justify-items": "place-items",
  "place-self": "place-self",
  "align-self": "place-self",
  "justify-self": "place-self",
  "line-height": "font",
  "column-width": "columns",
  "column-count": "columns",
  // One property under two names: the logical and legacy spellings are aliases, not relatives.
  "inline-size": "width",
  "block-size": "height",
  "word-wrap": "overflow",
  "page-break-before": "break",
  "page-break-after": "break",
  "page-break-inside": "break",
};

/**
 * The group of properties one declaration can override or be overridden by: the first word of the
 * property (`margin`, `border`, `font`), with the exceptions above. Deliberately coarse: two
 * properties of one family that never interact (`margin-top` and `margin-bottom`) are treated as if
 * they might, which can only cost a rule its place in an existing entry, never its position in the
 * cascade.
 */
function propertyFamily(key: string): string {
  if (key.startsWith("--")) return key;
  const name = cssPropertyName(key).replace(/^-(?:webkit|moz|ms|o)-/, "");
  return FAMILY[name] ?? name.split("-")[0]!;
}

const isImportant = (value: string): boolean => /!\s*important\s*$/i.test(value);

/** What a rule contributes to the cascade, kept per entry so a later rule can be checked against it. */
interface Fact {
  /** One per member of the rule's selector list. */
  selectors: readonly SelectorFacts[];
  context: readonly string[];
  props: readonly { family: string; important: boolean }[];
}

/** The widths a chain of at-rule keys can hold at: `[min, max]` in px, or null when it is not a plain width query. */
function widthRange(
  context: readonly string[],
  widths: ReadonlyMap<string, readonly [number, number]>,
): readonly [number, number] {
  let min = 0;
  let max = Number.POSITIVE_INFINITY;
  for (const key of context) {
    const named = widths.get(key);
    if (named !== undefined) {
      min = Math.max(min, named[0]);
      max = Math.min(max, named[1]);
      continue;
    }
    if (!key.startsWith("@(") || /[,]|\bor\b|\bnot\b/i.test(key)) continue;
    for (const match of key.matchAll(/\(\s*(min|max)-width\s*:\s*([\d.]+)(px|em|rem)?\s*\)/gi)) {
      const pixels = Number(match[2]) * (match[3] === undefined || match[3] === "px" ? 1 : 16);
      if (match[1]!.toLowerCase() === "min") min = Math.max(min, pixels);
      else max = Math.min(max, pixels);
    }
  }
  return [min, max];
}

/**
 * The layout of a project `style` object, entry by entry, with the cascade kept: it knows where each
 * rule's declarations will be emitted and whether putting one more rule into an earlier entry would
 * change which of two rules wins.
 *
 * Emission order is the order `buildSiteStyleCSS` writes: entries in key order; inside an entry its
 * own declarations first, then its nested blocks in key order, each of those the same way. `slots`
 * lists every block that way, so "emitted after" is "later in the list".
 */
class Layout {
  readonly style: Record<string, JxStyle> = {};
  private readonly slots: { entry: Entry; path: readonly string[]; facts: Fact[] }[] = [];
  private readonly byKey = new Map<string, Entry[]>();
  private readonly widths = new Map<string, readonly [number, number]>();

  constructor(breakpoints: readonly Breakpoint[]) {
    for (const bp of breakpoints) {
      if (bp.isMain || bp.direction === "none") continue;
      this.widths.set(
        `@--${bp.key}`,
        bp.direction === "max" ? [0, bp.width] : [bp.width, Infinity],
      );
    }
  }

  /** Whether `a` and `b` could both apply to one element and set related properties at one specificity and importance. */
  private ties(a: Fact, b: Fact): boolean {
    const meet = a.selectors.some((x) =>
      b.selectors.some(
        (y) => compareSpecificity(x.specificity, y.specificity) === 0 && mayShareAnElement(x, y),
      ),
    );
    if (!meet) return false;
    const [aMin, aMax] = widthRange(a.context, this.widths);
    const [bMin, bMax] = widthRange(b.context, this.widths);
    if (Math.max(aMin, bMin) > Math.min(aMax, bMax)) return false;
    return a.props.some((x) =>
      b.props.some(
        (y) =>
          x.important === y.important &&
          (x.family === y.family || x.family === "all" || y.family === "all"),
      ),
    );
  }

  /** The index of the slot for `path` in `entry`, or where it would be inserted. */
  private locate(entry: Entry, path: readonly string[]): { index: number; exists: boolean } {
    const own = (index: number): boolean => this.slots[index]!.entry === entry;
    for (let depth = 0; depth <= path.length; depth += 1) {
      const wanted = path.slice(0, depth);
      const found = this.slots.findIndex(
        (slot) =>
          slot.entry === entry &&
          slot.path.length === depth &&
          slot.path.every((key, i) => key === wanted[i]),
      );
      if (found !== -1) continue;
      // The first missing block goes after everything already inside its parent.
      const parent = path.slice(0, depth - 1);
      let at = -1;
      for (let index = 0; index < this.slots.length; index += 1) {
        if (own(index) && parent.every((key, i) => this.slots[index]!.path[i] === key)) at = index;
      }
      return { index: at + 1, exists: false };
    }
    return {
      index: this.slots.findIndex(
        (slot) =>
          slot.entry === entry &&
          slot.path.length === path.length &&
          slot.path.every((key, i) => key === path[i]),
      ),
      exists: true,
    };
  }

  /** Create the blocks for `path` (and the ones above it that are missing), starting at slot index `at`. */
  private open(entry: Entry, path: readonly string[], at: number): number {
    let cursor = at;
    let block: JxStyle = entry.block;
    let target = -1;
    for (let depth = 1; depth <= path.length; depth += 1) {
      const key = path[depth - 1]!;
      const existing = block[key];
      const wanted = path.slice(0, depth);
      const slot = this.slots.findIndex(
        (s) =>
          s.entry === entry && s.path.length === depth && s.path.every((k, i) => k === wanted[i]),
      );
      if (
        typeof existing === "object" &&
        existing !== null &&
        !Array.isArray(existing) &&
        slot !== -1
      ) {
        block = existing as JxStyle;
        target = slot;
        continue;
      }
      const created: JxStyle = {};
      block[key] = created;
      block = created;
      this.slots.splice(cursor, 0, { entry, path: wanted, facts: [] });
      target = cursor;
      cursor += 1;
    }
    return target;
  }

  private blockOf(slot: { entry: Entry; path: readonly string[] }): JxStyle {
    let block = slot.entry.block;
    for (const key of slot.path) block = block[key] as JxStyle;
    return block;
  }

  /**
   * Add one rule. Returns `merged` when it joined an existing entry, `added` when it opened one, and
   * `rekeyed` when the entry for its selector exists but joining it would have reordered the rule
   * against one of equal specificity, so it was given an entry of its own at the end.
   */
  place(
    selectors: readonly string[],
    context: readonly string[],
    declarations: readonly (readonly [string, string])[],
  ): { how: "merged" | "added" | "rekeyed"; key: string } {
    const selector = selectors.join(", ");
    const fact: Fact = {
      selectors: selectors.map(selectorFacts),
      context,
      props: declarations.map(([key, value]) => ({
        family: propertyFamily(key),
        important: isImportant(value),
      })),
    };
    const entries = this.byKey.get(selector);
    const last = entries?.at(-1);
    if (last !== undefined) {
      const at = this.locate(last, context);
      const after = this.slots.slice(at.exists ? at.index + 1 : at.index);
      if (!after.some((slot) => slot.facts.some((other) => this.ties(fact, other)))) {
        const index = at.exists ? at.index : this.open(last, context, at.index);
        this.write(this.slots[index]!, fact, declarations);
        return { how: "merged", key: last.key };
      }
    }
    // A key that is taken (by an earlier rule of this selector, or by a rekeyed entry that happens to be
    // spelled like a selector list of this rule's own) gets the same selector once more: it selects the
    // same elements, and a duplicate key would silently replace the entry that holds it.
    let key = selector;
    if (key in this.style) {
      const first = selectors[0] ?? selector;
      key = `${selector}, ${first}`;
      while (key in this.style) key += `, ${first}`;
    }
    const entry: Entry = { key, block: {} };
    this.style[key] = entry.block;
    this.byKey.set(selector, [...(entries ?? []), entry]);
    this.slots.push({ entry, path: [], facts: [] });
    const index =
      context.length === 0 ? this.slots.length - 1 : this.open(entry, context, this.slots.length);
    this.write(this.slots[index]!, fact, declarations);
    return { how: entries === undefined ? "added" : "rekeyed", key };
  }

  /** Later declarations win, as in a stylesheet, and move to the end so a shorthand after its longhand still overrides it. */
  private write(
    slot: { entry: Entry; path: readonly string[]; facts: Fact[] },
    fact: Fact,
    declarations: readonly (readonly [string, string])[],
  ): void {
    const block = this.blockOf(slot);
    for (const [key, value] of declarations) {
      const before = block[key];
      if (typeof before === "string" && isImportant(before) && !isImportant(value)) continue;
      delete block[key];
      block[key] = value;
    }
    slot.facts.push(fact);
  }
}

interface Entry {
  key: string;
  block: JxStyle;
}

// ── Which block a sheet belongs to ───────────────────────────────────────────────────────────────

/** `wp-includes/blocks/<name>/style.min.css` (or the URL of one): the name is the block's. */
const BLOCK_SHEET = /\/blocks\/([a-z0-9][a-z0-9-]*)\/(?:style|theme)(?:-rtl)?(?:\.min)?\.css/;

function blockOfOrigin(origin: string): string | null {
  return BLOCK_SHEET.exec(origin.replaceAll("\\", "/"))?.[1] ?? null;
}

// ── The result ───────────────────────────────────────────────────────────────────────────────────

export interface CoreBlockStyle {
  /**
   * Project style entries, in cascade order: selector keys with their declarations and nested media
   * queries (`".wp-block-columns": { display: "flex", "@(min-width: 782px)": { … } }`), then the
   * `@keyframes` and `@font-face` the entries use, then conditional custom properties. Merge it into
   * `project.json` `style` after any entry that must come first, in this order.
   */
  style: JxStyle;
  /** The custom properties (`--wp--preset--font-size--normal`) the kept rules read, with their values. For `project.json` `style`. */
  custom: Record<string, string>;
  /** CSS text for what a style object cannot carry (reported as `corecss.verbatim`); empty when nothing needed it. */
  verbatim: string;
}

export interface CoreBlockStyleOptions {
  /** Ids the converted markup carries: an id selector matches only these. */
  ids?: Iterable<string>;
  /** Keep rules that name no class (`ol,ul{box-sizing:border-box}`) from sources that cannot say which block they belong to. Default true. */
  ambient?: boolean;
  /**
   * The blocks the pages render (`core/list` or `list`; the keys of `countBlocks`). A block's sheet is
   * loaded whenever the block is on the page, so its classless rules (`ol,ul{box-sizing:border-box}`)
   * apply even when the converted markup carries no `wp-block-<name>` class (a list gets one only when
   * it has a background). Without this the module can only look for the class, and it reports the
   * ambient rules it dropped on that basis (`corecss.ambient-dropped`).
   */
  blocks?: Iterable<string>;
  /** Custom properties another stylesheet declares (Cwicly's global CSS), so a rule reading one is not reported as unresolved. */
  knownVars?: Iterable<string>;
  /**
   * Class names another stylesheet styles (the `.has-cc-<id>-color` rules of Cwicly's compiled global
   * CSS), so they are not reported as `corecss.preset-unstyled`.
   */
  styledElsewhere?: Iterable<string>;
  /** Locates report entries (`post:5246`, `site`). */
  where?: string;
  url?: string;
}

/** The at-rule a context key stands for, as CSS (`@--md` through the breakpoints, `@(print)` as `@media print`). */
function atRuleHead(key: string, breakpoints: readonly Breakpoint[]): string {
  if (key.startsWith("@--")) {
    const bp = breakpoints.find((candidate) => `@--${candidate.key}` === key);
    if (bp !== undefined && bp.direction !== "none") {
      return `@media (${bp.direction}-width: ${bp.width}px)`;
    }
    return key;
  }
  if (key.startsWith("@(")) {
    const inner = key.slice(2, -1).trim();
    return /^(?:all|print|screen|speech)$/i.test(inner)
      ? `@media ${inner}`
      : `@media ${key.slice(1)}`;
  }
  return key;
}

function ruleText(
  selector: string,
  context: readonly string[],
  declarations: readonly (readonly [string, string])[],
  breakpoints: readonly Breakpoint[],
): string {
  const body = declarations.map(([key, value]) => `${cssPropertyName(key)}: ${value}`).join("; ");
  let text = `${selector} { ${body} }`;
  for (const key of context.toReversed()) text = `${atRuleHead(key, breakpoints)} { ${text} }`;
  return text;
}

const VAR_REFERENCE = /var\(\s*(--[^\s,)]+)\s*(,)?/g;

/** Custom properties a value reads: `[name, hasFallback]`. */
function varsIn(value: string): [string, boolean][] {
  return [...value.matchAll(VAR_REFERENCE)].map((match) => [match[1]!, match[2] !== undefined]);
}

const isRootSelector = (selector: string): boolean => selector === ":root" || selector === "html";

/**
 * `has-<slug>-color`, `has-<slug>-font-size`…: the classes WordPress styles from theme.json presets.
 * `has-text-color`, `has-link-color`, `has-border-color`, `has-inline-color` and `has-background-color`
 * name no preset: they only say that the block has a colour of that kind (set inline or by block
 * supports), so a stylesheet that does not style them is not missing anything.
 */
const PRESET_CLASS =
  /^has-(?!(?:text|link|border|background|inline)-color$).+-(?:color|background-color|border-color|font-size|font-family|gradient-background)$/;

/**
 * Tree-shaken Jx project style for the WordPress stylesheets `sources`, covering exactly the classes
 * in `usedClasses`. See the module comment for what is kept, how it is ordered, and what goes to
 * `verbatim`. `sources` are read in the order given, which is their cascade order.
 *
 * `breakpoints` are the site's (`CwiclyOptions.breakpoints`): a WordPress media query that equals
 * one of them becomes its `@--<key>` name, every other becomes a literal `@(…)` key. Nothing here
 * throws on bad CSS; what the reader could not read is reported as `corecss.unreadable`.
 */
export function coreBlockStyle(
  usedClasses: Iterable<string>,
  sources: readonly CssSourceText[],
  breakpoints: readonly Breakpoint[],
  report?: Report,
  options: CoreBlockStyleOptions = {},
): CoreBlockStyle {
  const classes = new Set<string>();
  for (const name of usedClasses) {
    const trimmed = name.trim();
    if (trimmed !== "") classes.add(trimmed);
  }
  const use: Use = { classes, ids: new Set(options.ids ?? []) };
  const where = options.where;
  const note = (
    severity: "info" | "warn",
    code: string,
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    report?.add({
      severity,
      code,
      message,
      ...(where === undefined ? {} : { where }),
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(data === undefined ? {} : { data }),
    });
  };

  const rendered = new Set<string>();
  for (const name of options.blocks ?? []) rendered.add(name.replace(/^core\//, ""));
  const blockUse = new Map<string, boolean>();
  const blockUsed = (block: string): boolean => {
    let used = blockUse.get(block);
    if (used === undefined) {
      const root = `wp-block-${block}`;
      used =
        rendered.has(block) ||
        [...classes].some(
          (name) => name === root || name.startsWith(`${root}-`) || name.startsWith(`${root}__`),
        );
      blockUse.set(block, used);
    }
    return used;
  };

  const layout = new Layout(breakpoints);
  const verbatim: string[] = [];
  /** Every `:root` custom property declaration, in source order, with the conditions it sits under. */
  const customDecls: { name: string; value: string; context: readonly string[] }[] = [];
  const keyframes = new Map<string, { key: string; style: JxStyle }>();
  const fontFaces: { family: string; style: JxStyle }[] = [];
  /** Every value a kept declaration holds, for the custom-property closure and for what `@keyframes` are used. */
  const values: string[] = [];
  const animations = new Set<string>();
  const families: string[] = [];
  /** Classes some kept rule requires (the ones `has-*` reporting counts as styled). */
  const styled = new Set<string>();

  type Declarations = readonly (readonly [string, string])[];
  /** A run of consecutive kept rules that say the same thing, which a stylesheet would write as one selector list. */
  const keep = (group: readonly CssRulePart[], declarations: Declarations): void => {
    const selectors = group.map((rule) => rule.selector);
    const context = group[0]!.context;
    const label = selectors.join(", ");
    if (declarations.some(([, value]) => value.includes("${"))) {
      verbatim.push(ruleText(label, context, declarations, breakpoints));
      note(
        "warn",
        "corecss.verbatim",
        `${label}: a declaration holds a literal "\${", which Jx would read as a template; the rule is kept as CSS text.`,
        { selector: label, reason: "template" },
      );
      return;
    }
    const seen = new Map<string, string>();
    for (const [key, value] of declarations) {
      const earlier = seen.get(key);
      if (earlier !== undefined && earlier !== value) {
        note(
          "info",
          "corecss.fallback",
          `${label}: ${cssPropertyName(key)} is declared twice (${earlier}, then ${value}); a style object holds one value, so the later one is kept.`,
          { selector: label, property: cssPropertyName(key), dropped: earlier, kept: value },
        );
      }
      seen.set(key, value);
      values.push(value);
      if (/^(?:-?webkit)?animation(?:Name)?$/i.test(key)) {
        for (const word of value.split(/[\s,]+/)) animations.add(word);
      }
      if (/^fontFamily$|^font$/.test(key)) families.push(value.toLowerCase());
    }
    const placed = layout.place(selectors, context, declarations);
    if (placed.how === "rekeyed") {
      note(
        "info",
        "corecss.rekeyed",
        `${label}: kept as ${placed.key} so it stays after a rule of equal specificity that it overrides in the stylesheet.`,
        { selector: label, key: placed.key },
      );
    }
    for (const selector of selectors) {
      const parsed = selectorFacts(selector).parsed;
      if (parsed === null) continue;
      const collect = (inner: Sel): void => {
        for (const node of inner.nodes) {
          if (node.type === "class") styled.add(node.value);
          else if (node.type === "pseudo" && node.value.toLowerCase() !== ":not")
            node.nodes.forEach(collect);
        }
      };
      collect(parsed);
    }
  };
  /** Classless rules of a block's sheet that were dropped for want of a class of the block: per block, their selectors. */
  const ambientDropped = new Map<string, Set<string>>();
  /** Rules that passed the tree-shake, in cascade order across every source. */
  const pending: { rule: CssRulePart; declarations: Declarations }[] = [];

  for (const source of sources) {
    const index = parseCwiclyCss(source.css, breakpoints, { file: source.origin });
    for (const artifact of index.artifacts) {
      // Every WordPress media query is a literal query, which is what the reader says it kept; and its
      // warning about a base rule after a responsive one is about the class trees it builds, not about
      // the cascade-ordered entries laid out here (a rule that must stay after another is `rekeyed`).
      if (
        artifact.code === CSS_ARTIFACT.mediaUnmapped ||
        artifact.code === CSS_ARTIFACT.cascadeOrder
      ) {
        continue;
      }
      const facts = artifact.selector === undefined ? undefined : selectorFacts(artifact.selector);
      if (facts?.parsed && !holds(facts.parsed, use)) continue;
      note("warn", "corecss.unreadable", `${source.origin}: ${artifact.detail}`, {
        origin: source.origin,
        reader: artifact.code,
        ...(artifact.selector === undefined ? {} : { selector: artifact.selector }),
      });
    }
    const block = blockOfOrigin(source.origin);
    const blockless = block !== null && !blockUsed(block);
    const ambient = options.ambient !== false && !blockless;

    for (const rule of index.rules) {
      let declarations = rule.declarations;
      if (isRootSelector(rule.selector)) {
        const custom = declarations.filter(([key]) => key.startsWith("--"));
        for (const [name, value] of custom)
          customDecls.push({ name, value, context: rule.context });
        declarations = declarations.filter(([key]) => !key.startsWith("--"));
        if (declarations.length === 0) continue;
      }
      const facts = selectorFacts(rule.selector);
      if (facts.parsed !== null && !holds(facts.parsed, use)) continue;
      if (facts.classless && !ambient) {
        if (blockless && options.ambient !== false && block !== null) {
          const selectors = ambientDropped.get(block) ?? new Set<string>();
          selectors.add(rule.selector);
          ambientDropped.set(block, selectors);
        }
        continue;
      }
      pending.push({ rule, declarations });
    }

    for (const at of index.atRules) {
      if (Object.keys(at.style).length === 0) {
        // `@import url(…);` has no style-object spelling, and no place but the top of a sheet.
        if (ambient) {
          verbatim.push(`${at.key};`);
          note(
            "warn",
            "corecss.verbatim",
            `${at.key}: a statement at-rule has no Jx spelling; it is kept as CSS text.`,
            {
              at: at.key,
              reason: "statement",
            },
          );
        }
      } else if (at.key.startsWith("@keyframes")) {
        const name = at.key.slice("@keyframes".length).trim();
        keyframes.delete(name);
        keyframes.set(name, { key: at.key, style: at.style });
      } else if (at.key === "@font-face") {
        const family = String(at.style.fontFamily ?? "").replace(/^["']|["']$/g, "");
        fontFaces.push({ family: family.toLowerCase(), style: at.style });
      } else if (ambient) {
        // `@property` and `@counter-style`: declaration at-rules, kept as they are.
        keyframes.set(at.key, { key: at.key, style: at.style });
        animations.add(at.key);
      }
    }
  }

  for (let at = 0; at < pending.length;) {
    const first = pending[at]!;
    const sameContext = first.rule.context.join("\0");
    const sameDeclarations = JSON.stringify(first.declarations);
    let end = at + 1;
    while (
      end < pending.length &&
      pending[end]!.rule.context.join("\0") === sameContext &&
      JSON.stringify(pending[end]!.declarations) === sameDeclarations
    ) {
      end += 1;
    }
    keep(
      pending.slice(at, end).map((entry) => entry.rule),
      first.declarations,
    );
    at = end;
  }

  if (options.blocks === undefined && ambientDropped.size > 0) {
    note(
      "info",
      "corecss.ambient-dropped",
      `Classless rules of ${[...ambientDropped.keys()].map((name) => `core/${name}`).join(", ")} were dropped because no class of the block is in use. A block that renders without its wp-block class (a list without a background) still gets them on the live page: pass \`blocks\` to keep them.`,
      {
        blocks: [...ambientDropped.keys()],
        selectors: [...ambientDropped.values()].flatMap((selectors) => [...selectors]),
      },
    );
  }

  // `:root` custom properties are one cascade in source order (every rule is `:root`, one
  // specificity): a later declaration beats an earlier one wherever it applies, so an unconditional one
  // ends everything before it, and a second one under the very same condition replaces the first. What
  // is left of the conditional ones is emitted after the unconditional values, in source order.
  /** The value that applies everywhere, per name; the ones that apply under a condition. */
  const declared = new Map<string, string>();
  const conditional: { name: string; value: string; context: readonly string[] }[] = [];
  {
    const everywhere = new Map<string, string>();
    const settled = new Set<string>();
    const seen = new Set<string>();
    for (const decl of customDecls.toReversed()) {
      if (settled.has(decl.name)) continue;
      if (decl.context.length === 0) {
        everywhere.set(decl.name, decl.value);
        settled.add(decl.name);
        continue;
      }
      const identity = `${decl.name}\0${decl.context.join("\0")}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      conditional.unshift(decl);
    }
    for (const { name } of customDecls) {
      const value = everywhere.get(name);
      if (value !== undefined && !declared.has(name)) declared.set(name, value);
    }
  }

  // Which custom properties the kept rules read, and what those read in turn.
  const keptKeyframes = [...keyframes].filter(([name]) => animations.has(name));
  const read = new Map<string, boolean>();
  const scan = (value: string): void => {
    for (const [name, fallback] of varsIn(value)) {
      read.set(name, (read.get(name) ?? true) && fallback);
    }
  };
  for (const value of values) scan(value);
  for (const [, { style }] of keptKeyframes) {
    for (const stop of Object.values(style)) {
      if (typeof stop === "object" && stop !== null && !Array.isArray(stop)) {
        for (const value of Object.values(stop)) if (typeof value === "string") scan(value);
      }
    }
  }
  const needed = new Set<string>();
  const queue = [...read.keys()];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (needed.has(name)) continue;
    needed.add(name);
    for (const value of [
      declared.get(name),
      ...conditional.filter((c) => c.name === name).map((c) => c.value),
    ]) {
      if (value === undefined) continue;
      for (const [inner, fallback] of varsIn(value)) {
        if (!read.has(inner)) read.set(inner, fallback);
        queue.push(inner);
      }
    }
  }
  const known = new Set(options.knownVars ?? []);
  const custom: Record<string, string> = {};
  for (const [name, value] of declared) if (needed.has(name)) custom[name] = value;
  for (const [name, withFallback] of read) {
    if (
      declared.has(name) ||
      conditional.some((c) => c.name === name) ||
      known.has(name) ||
      withFallback
    )
      continue;
    // WordPress's own `--wp--*` properties are set per element (a block's inline style, block supports)
    // or by a script, so a stylesheet that reads one is not wrong; any other name is.
    note(
      name.startsWith("--wp--") ? "info" : "warn",
      "corecss.var-unresolved",
      `${name} is read by a kept rule and no stylesheet declares it.`,
      {
        property: name,
      },
    );
  }

  // The style object: entries, then what they use.
  const style: JxStyle = { ...layout.style };
  for (const [, { key, style: stops }] of keptKeyframes) style[key] = stops;
  const faces = fontFaces.filter(
    (face) => face.family !== "" && families.some((value) => value.includes(face.family)),
  );
  if (faces.length === 1) {
    style["@font-face"] = faces[0]!.style;
  } else {
    // A project `style` object holds one block per key, and Jx's project-level builder drops the list
    // form that an element's own `style` accepts (`"@font-face": [{…}, {…}]`), so several faces cannot
    // be entries.
    for (const face of faces) {
      verbatim.push(
        `@font-face { ${Object.entries(face.style)
          .map(([key, value]) => `${cssPropertyName(key)}: ${String(value)}`)
          .join("; ")} }`,
      );
      note(
        "warn",
        "corecss.verbatim",
        `@font-face ${face.family}: a project style holds one @font-face block, and this site needs ${faces.length}; the face is kept as CSS text.`,
        { at: "@font-face", family: face.family, reason: "font-face-list" },
      );
    }
  }
  /** The entries each conditional property sits in, in emission order: a later declaration must be emitted after an earlier one. */
  const placed = new Map<string, string[]>();
  for (const { name, value, context } of conditional) {
    if (!needed.has(name)) continue;
    if (context.length !== 1) {
      verbatim.push(ruleText(":root", context, [[name, value]], breakpoints));
      note(
        "warn",
        "corecss.verbatim",
        `${name}: a custom property under ${context.join(" ")} cannot be a project style entry; it is kept as CSS text.`,
        {
          property: name,
          reason: "nested-condition",
        },
      );
      continue;
    }
    const key = context[0]!;
    const order = Object.keys(style);
    const home = order.indexOf(key);
    // An entry that already exists sits where it was first made: a declaration that has to come after
    // another of this property which is emitted later than that entry cannot join it.
    if (home !== -1 && (placed.get(name) ?? []).some((other) => order.indexOf(other) > home)) {
      verbatim.push(ruleText(":root", context, [[name, value]], breakpoints));
      note(
        "warn",
        "corecss.verbatim",
        `${name}: under ${key} it must follow a declaration under another condition that a project style entry would emit after it; it is kept as CSS text.`,
        { property: name, reason: "conditional-order" },
      );
      continue;
    }
    placed.set(name, [...(placed.get(name) ?? []), key]);
    const existing = style[key];
    const target: JxStyle =
      typeof existing === "object" && existing !== null && !Array.isArray(existing)
        ? (existing as JxStyle)
        : {};
    target[name] = value;
    style[key] = target;
  }

  const elsewhere = new Set(options.styledElsewhere ?? []);
  for (const name of classes) {
    if (PRESET_CLASS.test(name) && !styled.has(name) && !elsewhere.has(name)) {
      note(
        "info",
        "corecss.preset-unstyled",
        `.${name} has no rule in the stylesheets given: WordPress styles it from theme.json global styles, which this site does not print.`,
        { class: name },
      );
    }
  }

  return { style, custom, verbatim: verbatim.join("\n") };
}
