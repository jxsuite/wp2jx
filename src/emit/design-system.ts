/**
 * A Cwicly site's global look, as the pieces of a Jx project: `project.json`'s `$media`, `style` and
 * `$head`, plus the files that go under `public/`.
 *
 * What the live page loads, in the order it loads it (`tests/fixtures/<site>/html`):
 *
 *   base.css, style-index.css            the plugin's own (compat-css.ts)
 *   <style id="cc-global-inline-css">    `cwicly_global_css`: tag rules, palette, `.cc-cntr`…
 *   cc-global-stylesheets.css            the site owner's hand-written CSS
 *   cc-global-classes.css                every global class
 *   …template, part, component and post files…
 *   the `cwicly_global_fonts` links, the custom-code snippets
 *
 * What a built Jx page loads: the project's `$head` entries (links, scripts) in order, and then ONE
 * `<style>` holding `project.json`'s `style` and, after it, the page's own. So the order survives
 * except in one place, which this module therefore handles deliberately: the site owner's
 * stylesheet is a `<link>` in `$head`, and the global rules are in the `<style>` after it, where
 * the live site has them the other way round for the tag rules (global CSS, then the owner's CSS,
 * then the classes). A declaration that the owner's sheet overrides on the live site and the project
 * style would now win is taken out of the project style (`design.cascade-order`), so the owner's
 * value still wins: the same selector and importance, and an owner declaration that sets the property
 * (itself, or the shorthand that includes it: `margin` over `margin-bottom`) wherever the global one
 * applies, which an owner rule outside any at-rule does for a global rule inside one. What taking
 * the global declaration out cannot fix (a global shorthand the owner overrides by one longhand, an
 * owner rule inside a media query over a global base rule) stays and is reported
 * (`design.cascade-unresolved`). Rules of `cc-global-classes.css` came after the owner's sheet there
 * and still do. WordPress's Additional CSS is a sheet of its own on the live site, printed after
 * everything else, and is a file of its own here, linked after the owner's.
 *
 * Decisions that are not obvious from the code (each verified by a real `jx build`, see the tests):
 *
 * - **Layout.** The rules go into `style` the way `projectStyles` (cwicly/css.ts) lays them out, not as
 *   one tree per class: every base rule of a stylesheet, then one top-level `"@--md"` block per
 *   breakpoint holding the selectors that have rules in it. A tree per class would write class A's
 *   responsive rules before class B's base rules, which reverses the file's order for an element
 *   that carries both. `projectStyles` starts a new object where even its layout would invert two
 *   rules, and `style` is one object, so the objects are merged in order (later declarations replace
 *   earlier ones in place) and `design.cascade-merged` says it happened. Merging in place puts a
 *   later object's rule at an earlier object's place, ahead of rules it must beat, so the result is
 *   then put back in the files' order wherever one object can say it (`repairOrder`): every pair of
 *   declarations that could decide one box's value (same property or a shorthand and its longhand,
 *   same importance and specificity, selectors that can end in one element) is compared with the
 *   source, and the later one is moved behind the other into a block of its own spelled with an
 *   equal-specificity alias (`.a` becomes `:is(.a)`, which matches the same elements at the same
 *   specificity; `design.cascade-reordered` lists them). At-rules other than the breakpoints go
 *   before or after a breakpoint as the pairs say. What one object cannot say (a base rule that the
 *   files wrote after an at-rule's, since the base is always written first) is left and reported
 *   with both sides (`design.cascade-inverted`). Two selectors are only paired when every class they
 *   name is a global class: a component's own classes (`.cc-nav-wrapper`) are not combined by an
 *   author, and a pair of them would be noise. The tests hold the result to the cascade of the
 *   original files for every pair of global classes of both sites.
 * - **Tokens and the body at the top, as Jx reads them.** `:root`'s custom properties become
 *   `style["--cc-color-2"]`, and `body`'s declarations become top-level properties (Jx writes the
 *   first onto `:root` and the second onto `body`), which is where Studio's Project Styles looks for
 *   design tokens and element defaults. Whatever else a `:root` or `body` rule holds stays under its
 *   own key.
 * - **`:root, .light`.** The compiled palette is declared on both, and the nested `.has-<slug>-color`
 *   utility classes under both. Without a dark palette the `.light` half cannot differ from `:root`
 *   (it exists to restore the light palette inside a subtree of a dark page), so it is folded into
 *   `:root`; and a copy would be a second place to edit a colour. With rules on the dark selector
 *   anywhere, it is kept, and `design.dark-mode` says that Cwicly's `darkmode.min.js` (which puts
 *   the class on `<html>` from `localStorage` or the OS setting) is not ported, so nothing applies it.
 * - **`@font-face` goes to a stylesheet.** The array form the spec shows for several faces is
 *   rejected by `jx validate` at project level and dropped, silently, by the project style builder
 *   (`buildSiteStyleCSS` skips an array value under an at-rule key); a single face would work, and
 *   a family has several. `public/css/cwicly-global.css` holds every `@font-face`, linked before the
 *   project style (nothing in it depends on the order). `@keyframes`, `@property` and the other
 *   declaration at-rules are single objects and stay in `style`.
 * - **`${` cannot be written in a Jx string.** `$head` text and attribute values and every style value
 *   are template-evaluated whenever they contain it (`isTemplateString`), and there is no escape.
 *   A head script or style that holds one is written to `public/js/` or `public/css/` and linked
 *   (the same bytes, in the same place in the head, a script without the `async` and `defer` an
 *   inline script ignored); a style value has the dollar written as the CSS escape `\24 `. A data
 *   block (`application/ld+json`, `importmap`) is never fetched through a `src`, so it stays inline,
 *   a JSON one with the dollar written as `\u0024`. All are reported (`design.head-externalised`,
 *   `design.template-literal`).
 * - **A custom property of the body stays on the body.** Jx writes every top-level custom property
 *   onto `:root`, so `body { --c: blue }` lifted would replace `:root`'s own `--c`.
 */
import type { JxHeadEntry } from "@jxsuite/schema/types";
import { cssPropertyName, isDeclarationAtRule, isKeyframesAtRule } from "@jxsuite/runtime/css";
import { parseFragment, serialize } from "parse5";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import type { DefaultTreeAdapterMap } from "parse5";
import type { CwiclyOptionsFull } from "../cwicly/options.ts";
import { resolvePaletteRefs } from "../cwicly/options.ts";
import {
  CSS_ARTIFACT,
  cssRules,
  mergeCssIndexes,
  parseCwiclyCss,
  projectStyles,
  type CssRulePart,
} from "../cwicly/css.ts";
import type { CssIndex, JxStyle, Report, WpModel } from "../types.ts";

// ── Public surface ───────────────────────────────────────────────────────────────────────────────

/** Where the project's own stylesheets go, and how a page links them. */
export const GLOBAL_CSS_PATH = "public/css/cwicly-global.css";
export const GLOBAL_CSS_HREF = "/css/cwicly-global.css";
export const CUSTOM_CSS_PATH = "public/css/cwicly-custom.css";
export const CUSTOM_CSS_HREF = "/css/cwicly-custom.css";
/** WordPress's Additional CSS: its own file, as it is its own sheet on the live site. */
export const ADDITIONAL_CSS_PATH = "public/css/cwicly-additional.css";
export const ADDITIONAL_CSS_HREF = "/css/cwicly-additional.css";
/** Local fonts are copied here, and `@font-face` urls point at the same place without `public`. */
export const FONTS_DIR = "public/fonts";
export const FONTS_HREF = "/fonts";

export interface DesignSystemInput {
  options: CwiclyOptionsFull;
  /** `cwicly_global_css` (`options.compiledCss.global`), parsed. */
  globalCss: CssIndex;
  /** `cc-global-classes.css`, parsed. */
  classesCss: CssIndex;
  /**
   * `cc-global-classes.css` as read, when the caller has it. Only used to say how many `!var=<id>!`
   * references the reader repaired against the palette (`design.palette-repaired`); the indexes do
   * not remember which declarations were repaired.
   */
  classesText?: string | undefined;
  /** `cc-global-stylesheets.css`: the site owner's CSS, as served. */
  stylesheetsCss: string;
  report: Report;
  /**
   * WordPress's "Additional CSS" (the `custom_css` post of the active theme), when the caller has it.
   * It is its own file, linked after the owner's stylesheet: on the live site it is a separate
   * `<style>` printed last of all, after the page's own CSS, which a stylesheet in `$head` cannot be
   * (`design.cascade-order` says so). Apart from the owner's text, an unterminated block or comment
   * in one cannot swallow the other, and an `@import` that opens it stays valid.
   */
  additionalCss?: string | undefined;
}

export interface DesignSystemOptions {
  /** `buildCompatCss`' result: written to `files` and linked first in `head`, ahead of every global rule. */
  compat?: { path: string; content: string | Uint8Array; href?: string | undefined } | undefined;
  /**
   * Rewrites every `url(…)` of the CSS the project carries (uploads to `/media/…`). `ConvertCtx.rewriteUrl`
   * is one, and reports what it cannot place. Without it urls are left as the site wrote them.
   */
  rewriteUrl?: ((url: string) => string) | undefined;
  /** Put the CSS artifacts of the two indexes (`css.invalid-value`…) in the report. Default true; turn it off when the caller reports them. */
  reportArtifacts?: boolean | undefined;
}

export interface DesignSystem {
  /** `project.json` `$media`. */
  media: Record<string, string>;
  /** `project.json` `style`. */
  style: JxStyle;
  /** `project.json` `$head`, in the order a page should carry it. */
  head: JxHeadEntry[];
  /** Files to write, project-relative (`public/css/cwicly-global.css`…). */
  files: { path: string; content: string | Uint8Array }[];
  /** Local font files to download: `url` is where to get it, `dest` the project-relative path. */
  fontDownloads: { url: string; dest: string }[];
  /**
   * `cwicly_custom_code`, as stored. `head` is already in `head` (as entries); `bodyOpen` belongs right
   * after `<body>` (the Google Tag Manager `<noscript><iframe>`), `footer` at the end of it, both as
   * HTML for the layout emitter to convert.
   */
  customCode: { head: string; bodyOpen: string; footer: string };
  /** The stylesheets linked from `head`, in order. */
  stylesheets: {
    role: "compat" | "global" | "custom" | "additional";
    path: string;
    href: string;
  }[];
  /** What went to the verbatim sheet, one entry per rule, for the assembler and the tests. */
  verbatim: { rule: string; reason: string }[];
  /** The families the site declares and where each comes from. */
  fonts: { family: string; source: "google" | "local" | "system" }[];
  /** How many objects `projectStyles` produced and were merged into `style` (1: the file's order is exact). */
  layoutObjects: number;
  /** Whether any rule of the CSS the project carries is on a dark-mode selector. */
  darkRules: boolean;
}

/**
 * WordPress's "Additional CSS" for the active theme: the `custom_css` post whose slug is the theme's
 * (a site keeps one per theme it ever ran, and only the active theme's is printed: fineline's is
 * `blocksy`'s and the live pages do not carry it). Empty text is no CSS.
 */
export function additionalCssFor(model: Pick<WpModel, "posts" | "site">): string | undefined {
  let found: { id: number; css: string } | undefined;
  for (const post of model.posts.values()) {
    if (post.type !== "custom_css" || post.status !== "publish" || post.slug !== model.site.theme)
      continue;
    if (found === undefined || post.id > found.id) found = { id: post.id, css: post.content };
  }
  return found === undefined || found.css.trim() === "" ? undefined : found.css;
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────

const isBlock = (value: unknown): value is JxStyle =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const isScalar = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Structural equality of JSON values, whatever order an object's keys are in. */
function deepEqual(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : isBlock(value)
        ? Object.fromEntries(
            Object.entries(value)
              .toSorted(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const link = (href: string, attributes: Record<string, string> = {}): JxHeadEntry => ({
  tagName: "link",
  attributes: { rel: "stylesheet", href, ...attributes },
});

/** A site's `url(…)` values, with the url and how it was quoted. */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi;

/**
 * Rewrite every `url(…)` in CSS text, keeping its quoting. `data:` urls, fragments and `var()` are not
 * addresses and are left alone.
 */
export function rewriteCssUrls(css: string, rewrite: (url: string) => string): string {
  return css.replace(CSS_URL, (whole, double?: string, single?: string, bare?: string) => {
    const url = (double ?? single ?? bare ?? "").trim();
    if (url === "" || url.startsWith("data:") || url.startsWith("#") || url.startsWith("var(")) {
      return whole;
    }
    const next = rewrite(url);
    if (next === url) return whole;
    if (double !== undefined) return `url("${next.replaceAll('"', "%22")}")`;
    if (single !== undefined) return `url('${next.replaceAll("'", "%27")}')`;
    return /[\s()'"]/.test(next) ? `url("${next.replaceAll('"', "%22")}")` : `url(${next})`;
  });
}

/** Apply `rewrite` to every string value of a style tree that holds a `url(…)`. */
function rewriteStyleUrls(style: JxStyle, rewrite: (url: string) => string): void {
  for (const [key, value] of Object.entries(style)) {
    if (typeof value === "string") {
      if (value.includes("url(")) style[key] = rewriteCssUrls(value, rewrite);
    } else if (isBlock(value)) {
      rewriteStyleUrls(value, rewrite);
    } else if (Array.isArray(value)) {
      for (const item of value) rewriteStyleUrls(item, rewrite);
    }
  }
}

/**
 * A Jx string that holds `${` is a template, and a CSS value never means one. The dollar as a CSS
 * escape is the same character to a browser (inside a string, where it can occur at all) and no
 * longer a template to Jx. Returns how many values it changed.
 */
function escapeStyleTemplates(style: JxStyle): number {
  let changed = 0;
  for (const [key, value] of Object.entries(style)) {
    if (typeof value === "string") {
      if (value.includes("${")) {
        style[key] = value.replaceAll("${", "\\24 {");
        changed += 1;
      }
    } else if (isBlock(value)) {
      changed += escapeStyleTemplates(value);
    } else if (Array.isArray(value)) {
      for (const item of value) changed += escapeStyleTemplates(item);
    }
  }
  return changed;
}

// ── Head markup ──────────────────────────────────────────────────────────────────────────────────

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];

const VOID_HEAD = new Set([
  "base",
  "link",
  "meta",
  "basefont",
  "bgsound",
  "frame",
  "keygen",
  "param",
]);

function isElement(node: P5Node): node is P5Element {
  return "tagName" in node;
}

/**
 * Whether a `<script>`'s `type` makes it a program a `src` can stand in for: none, a JavaScript MIME
 * type, or `module`. Any other type is a data block (`application/ld+json`, `importmap`,
 * `text/template`) that the browser never fetches, so a file linked in its place is no data at all.
 */
function isExecutableScript(type: string | undefined): boolean {
  const kind = (type ?? "").trim().toLowerCase();
  return (
    kind === "" ||
    kind === "module" ||
    /^(text|application)\/(x-)?(java|ecma|j|live)script$/.test(kind)
  );
}

/** A data block whose text is JSON, in which `\u0024` is the same character as `$` inside a string. */
const isJsonScript = (type: string | undefined): boolean =>
  /(^|[/+])json$|^(importmap|speculationrules)$/.test((type ?? "").trim().toLowerCase());

/** The text of a node's children as written: raw text for `script` and `style`, markup for the rest. */
function innerContent(element: P5Element): string {
  const only = element.childNodes;
  if (only.length > 0 && only.every((child) => child.nodeName === "#text")) {
    return only.map((child) => (child as DefaultTreeAdapterMap["textNode"]).value).join("");
  }
  return serialize(element);
}

interface HeadContext {
  report: Report;
  where: string;
  /** Files written for content Jx cannot carry inline. */
  files: { path: string; content: string }[];
  /** Used paths, so two externalised scripts never share one. */
  taken: Set<string>;
}

/**
 * HTML that a page would put in its `<head>` (a custom-code snippet, the font links) as `$head`
 * entries. Every element becomes `{tagName, attributes, textContent}` with its content as written:
 * the build writes `textContent` of a head entry without escaping it, so a script, a style and a
 * `<noscript>` hold their text exactly. A boolean attribute is the empty string (the schema wants
 * strings). Comments carry no behaviour and are not kept; text outside any element is reported.
 * A script or style whose text holds `${` goes to a file (`design.head-externalised`) because the
 * build would evaluate it, except a data block (`application/ld+json`, `importmap`), which a browser
 * only reads inline: JSON keeps its text with the dollar written as `\u0024`, and any other data
 * block is kept as written with a `design.template-literal` warning.
 */
export function parseHeadHtml(
  html: string,
  ctx: Pick<HeadContext, "report" | "where"> & Partial<Pick<HeadContext, "files" | "taken">>,
): JxHeadEntry[] {
  const files = ctx.files ?? [];
  const taken = ctx.taken ?? new Set<string>();
  const entries: JxHeadEntry[] = [];
  const fragment = parseFragment(html);
  const take = (dir: string, ext: string): string => {
    for (let n = 1; ; n += 1) {
      const path = `${dir}/cwicly-head-${n}.${ext}`;
      if (!taken.has(path)) {
        taken.add(path);
        return path;
      }
    }
  };
  for (const node of fragment.childNodes) {
    if (node.nodeName === "#comment") continue;
    if (node.nodeName === "#text") {
      const text = (node as DefaultTreeAdapterMap["textNode"]).value.trim();
      if (text !== "") {
        ctx.report.add({
          severity: "warn",
          code: "design.head-markup",
          message: `text outside any element in head markup was not carried over: ${JSON.stringify(text.slice(0, 80))}`,
          where: ctx.where,
        });
      }
      continue;
    }
    if (!isElement(node)) continue;
    const tag = node.tagName;
    const entry: JxHeadEntry = { tagName: tag };
    if (node.attrs.length > 0) {
      entry.attributes = Object.fromEntries(node.attrs.map((a) => [a.name, a.value]));
    }
    if (node.attrs.some((attr) => attr.value.includes("${"))) {
      ctx.report.add({
        severity: "warn",
        code: "design.template-literal",
        message: `an attribute of a <${tag}> in head markup holds a Jx template marker, which the build evaluates: its value may not survive`,
        where: ctx.where,
      });
    }
    if (!VOID_HEAD.has(tag)) {
      const content = innerContent(node);
      if (content.includes("${")) {
        const hasSrc = entry.attributes?.src !== undefined;
        const rawType = entry.attributes?.type;
        const type = typeof rawType === "string" ? rawType : undefined;
        if (tag === "script" && !hasSrc && isExecutableScript(type)) {
          const path = take("public/js", "js");
          files.push({ path, content });
          // An inline classic script ignores `async` and `defer`; the same script behind a `src` would
          // not, and would run later than the page expects. A module keeps both, which mean the same.
          const { async: _async, defer: _defer, ...kept } = entry.attributes ?? {};
          const attributes = type?.trim().toLowerCase() === "module" ? entry.attributes : kept;
          entry.attributes = { ...attributes, src: `/${path.slice("public/".length)}` };
          ctx.report.add({
            severity: "info",
            code: "design.head-externalised",
            message: `an inline <script> in head markup holds a Jx template marker, which the build would evaluate; it is written to ${path} and linked from the same place`,
            where: ctx.where,
            data: { path },
          });
          entries.push(entry);
          continue;
        }
        if (tag === "script" && !hasSrc && isJsonScript(type)) {
          // Structured data must stay inline (the browser never fetches a data block's `src`), and a
          // `$` inside a JSON string can be written as `\u0024`, which a JSON parser reads back as `$`.
          entry.textContent = content.replaceAll("${", "\\u0024{");
          entries.push(entry);
          ctx.report.add({
            severity: "info",
            code: "design.template-literal",
            message: `a <script type="${type}"> in head markup holds a Jx template marker, which the build would evaluate; the dollar sign was written as the JSON escape \\u0024`,
            where: ctx.where,
          });
          continue;
        }
        if (tag === "style") {
          const path = take("public/css", "css");
          files.push({ path, content });
          const media = entry.attributes?.media;
          entries.push(
            link(`/${path.slice("public/".length)}`, typeof media === "string" ? { media } : {}),
          );
          ctx.report.add({
            severity: "info",
            code: "design.head-externalised",
            message: `an inline <style> in head markup holds a Jx template marker, which the build would evaluate; it is written to ${path} and linked from the same place`,
            where: ctx.where,
            data: { path },
          });
          continue;
        }
        ctx.report.add({
          severity: "warn",
          code: "design.template-literal",
          message: `a <${tag}> in head markup holds a Jx template marker, which the build evaluates: its text may not survive`,
          where: ctx.where,
        });
      }
      if (content !== "") entry.textContent = content;
    }
    entries.push(entry);
  }
  return entries;
}

/** Entries with the same content, once, in the order they first appear. */
function dedupe(entries: JxHeadEntry[]): { entries: JxHeadEntry[]; removed: number } {
  const seen = new Set<string>();
  const out: JxHeadEntry[] = [];
  for (const entry of entries) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return { entries: out, removed: entries.length - out.length };
}

/**
 * `cwicly_global_fonts`: the `<link>` tags Cwicly prints in every page's head, as `$head` entries.
 * The site repeats one link seven times and each stylesheet link may be followed by preconnect
 * hints, so identical entries are kept once. Cwicly runs the markup through `wp_kses` with `link`
 * (href, rel) and `style` (type) allowed, so only those two tags are real on the live site; others
 * are reported and not carried. The attributes the author stored are kept (`crossorigin` on a
 * preconnect is what makes it useful, and the filter is a PHP safety net, not part of the design).
 */
function fontHeadEntries(options: CwiclyOptionsFull, ctx: HeadContext): JxHeadEntry[] {
  const html = options.globalFontsHtml.trim();
  if (html === "") return [];
  const parsed = parseHeadHtml(html, ctx);
  const kept = parsed.filter((entry) => {
    if (entry.tagName === "link" || entry.tagName === "style") return true;
    ctx.report.add({
      severity: "info",
      code: "design.font-markup",
      message: `a <${entry.tagName}> in cwicly_global_fonts is stripped by the plugin's own filter on the live site, so it was not carried over`,
      where: "option:cwicly_global_fonts",
    });
    return false;
  });
  const { entries, removed } = dedupe(kept);
  if (removed > 0) {
    ctx.report.add({
      severity: "info",
      code: "design.head-deduped",
      message: `cwicly_global_fonts repeats ${removed} identical tag${removed === 1 ? "" : "s"}; each is kept once`,
      where: "option:cwicly_global_fonts",
      data: { removed },
    });
  }
  return entries;
}

// ── @import statements ───────────────────────────────────────────────────────────────────────────

const FONT_HOSTS = new Set([
  "fonts.googleapis.com",
  "fonts.bunny.net",
  "use.typekit.net",
  "fonts.adobe.com",
  "fast.fonts.net",
]);

/** `@import url("https://…") screen` → the address and what follows it. */
function parseImport(key: string): { url: string; rest: string } | undefined {
  const match =
    /^@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)|"([^"]*)"|'([^']*)')\s*(.*)$/i.exec(
      key.trim(),
    );
  if (match === null) return undefined;
  const url = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "").trim();
  return url === "" ? undefined : { url, rest: (match[6] ?? "").trim() };
}

/**
 * The `@import` statements of stylesheets (per-post CSS has them, one per block that picks a Google
 * font: `@import url("https://fonts.googleapis.com/css?family=Inter:…&display=swap")`) as `$head`
 * stylesheet links, each address once, in the order they appear. A Jx style object cannot hold a
 * statement at-rule and a `<link>` is what an `@import` of a stylesheet means. A trailing media
 * query becomes the link's `media`; `layer()` and `supports()` conditions have no link spelling and
 * are reported. An import of anything but a font host is carried the same way and reported
 * (`design.import-hoisted`), since a site-wide link is wider than a per-page rule was.
 */
export function collectFontImports(
  indexes: readonly Pick<CssIndex, "atRules">[],
  opts: { report?: Report | undefined; where?: string | undefined } = {},
): JxHeadEntry[] {
  const entries: JxHeadEntry[] = [];
  const seen = new Set<string>();
  for (const index of indexes) {
    for (const { key, style } of index.atRules) {
      if (!/^@import\b/i.test(key) || Object.keys(style).length > 0) continue;
      const parsed = parseImport(key);
      if (parsed === undefined) {
        opts.report?.add({
          severity: "warn",
          code: "design.import-hoisted",
          message: `${key} is not an @import this module can turn into a link`,
          ...(opts.where === undefined ? {} : { where: opts.where }),
        });
        continue;
      }
      const conditional = /^(layer|supports)\b/i.test(parsed.rest);
      const media = conditional || parsed.rest === "" ? undefined : parsed.rest;
      const id = `${parsed.url}\n${media ?? ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push(link(parsed.url, media === undefined ? {} : { media }));
      let host = "";
      try {
        host = new URL(parsed.url).hostname;
      } catch {
        // A relative address: it is not a font host.
      }
      if (conditional || !FONT_HOSTS.has(host)) {
        opts.report?.add({
          severity: conditional ? "warn" : "info",
          code: "design.import-hoisted",
          message: conditional
            ? `${key}: a layer() or supports() condition on an @import has no link equivalent and was dropped; the stylesheet is linked unconditionally`
            : `${key} is not a font host: it is linked from every page's head instead of being imported by one stylesheet`,
          ...(opts.where === undefined ? {} : { where: opts.where }),
          data: { url: parsed.url },
        });
      }
    }
  }
  return entries;
}

// ── Local fonts ──────────────────────────────────────────────────────────────────────────────────

/** A path segment safe on every file system and in an unquoted `url()`. */
const safeSegment = (segment: string): string => {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Not percent-encoded after all.
  }
  const cleaned = decoded.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "");
  return cleaned === "" ? "font" : cleaned;
};

interface LocalFonts {
  css: string;
  downloads: { url: string; dest: string }[];
  families: string[];
}

/**
 * The fonts Cwicly serves from the site's own uploads (`cwicly_local_active_fonts`): their `@font-face`
 * CSS with every font file's address changed from `<uploads>/cwicly/local-fonts/google/<family>/latin/…`
 * to `/fonts/google/<family>/latin/…`, and the list of files to fetch for `public/fonts`. A file
 * outside `local-fonts` keeps only its name, and two addresses that would land on one path get a
 * counter. Every active font is carried, not only the ones loaded on every page: a face nothing
 * uses costs the browser nothing.
 */
function localFonts(options: CwiclyOptionsFull, report: Report): LocalFonts {
  const out: LocalFonts = { css: "", downloads: [], families: [] };
  const destFor = new Map<string, string>();
  const used = new Set<string>();
  const parts: string[] = [];
  for (const font of options.globalStyles.fonts) {
    if (font.source !== "local" || font.css === undefined) continue;
    out.families.push(font.family);
    const css = font.css.replace(
      CSS_URL,
      (whole, double?: string, single?: string, bare?: string) => {
        const url = (double ?? single ?? bare ?? "").trim();
        if (url === "" || url.startsWith("data:")) return whole;
        if (url.includes("{{CC_UPLOAD_URL}}")) {
          report.add({
            severity: "warn",
            code: "design.font-unresolved",
            message: `the font file ${url} of "${font.family}" names {{CC_UPLOAD_URL}}, and the site's uploads address could not be derived: it was left as written`,
            where: "option:cwicly_local_fonts",
            data: { family: font.family, url },
          });
          return whole;
        }
        let dest = destFor.get(url);
        if (dest === undefined) {
          const bare = url.split(/[?#]/)[0]!;
          const marker = bare.indexOf("/local-fonts/");
          const rel =
            marker === -1
              ? [bare.slice(bare.lastIndexOf("/") + 1)]
              : bare.slice(marker + "/local-fonts/".length).split("/");
          const base = rel.map(safeSegment).join("/");
          let candidate = base;
          for (let n = 2; used.has(candidate); n += 1) {
            candidate = base.replace(/(\.[A-Za-z0-9]+)?$/, `-${n}$1`);
          }
          used.add(candidate);
          dest = candidate;
          destFor.set(url, dest);
          out.downloads.push({ url, dest: `${FONTS_DIR}/${dest}` });
        }
        return `url(${FONTS_HREF}/${dest})`;
      },
    );
    parts.push(
      `/* ${font.family}${font.key === undefined ? "" : ` (${font.key})`} */\n${css.trim()}`,
    );
  }
  out.css = parts.join("\n\n");
  return out;
}

// ── Rendering an at-rule ─────────────────────────────────────────────────────────────────────────

/** `@font-face`, `@keyframes`…: the at-rule's name, lower case, without the `@`. */
const atRuleName = (key: string): string => /^@([\w-]+)/.exec(key)?.[1]?.toLowerCase() ?? "";

/** At-rules that are statements (`@layer a, b;`), not blocks: with nothing to put in one they end in `;`. */
const STATEMENT_AT_RULES = new Set(["layer", "namespace", "charset", "import"]);

/** `@font-face { … }` from the reader's `{key, style}` form, one declaration per line. */
function renderAtRule(key: string, style: JxStyle): string {
  const lines: string[] = [];
  for (const [property, value] of Object.entries(style)) {
    if (isScalar(value)) lines.push(`  ${cssPropertyName(property)}: ${value};`);
  }
  // A block would swallow the next rule of the file: `@layer a, b {}` is not `@layer a, b;`.
  if (lines.length === 0 && STATEMENT_AT_RULES.has(atRuleName(key))) return `${key};`;
  return `${key} {\n${lines.join("\n")}\n}`;
}

// ── Colours ──────────────────────────────────────────────────────────────────────────────────────

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` as `[r, g, b]` in 0..255, or undefined for any other spelling. */
function hexRgb(value: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (match === null) return undefined;
  let hex = match[1]!;
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * The `--<name>-hsl` value Cwicly declares beside a palette colour: `1deg 67% 51%` for `#d5312d`
 * (alpha is not part of it). Whole degrees and percents; undefined for a colour that is not a hex
 * literal. The plugin gets there through colord (RGB to HSV unrounded, HSV to HSL, then one rounding
 * of each part), and the same path is walked here: converting RGB to HSL directly differs in the
 * last digit for about one colour in 250 (`#0b2445` is 73% saturated by one path and 72% by the other).
 */
export function hexToHsl(value: string): string | undefined {
  const rgb = hexRgb(value);
  if (rgb === undefined) return undefined;
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  const sector =
    delta === 0
      ? 0
      : max === r
        ? (g - b) / delta
        : max === g
          ? 2 + (b - r) / delta
          : 4 + (r - g) / delta;
  const hue = 60 * (sector < 0 ? sector + 6 : sector);
  const saturationV = max === 0 ? 0 : (delta / max) * 100;
  const brightness = (max / 255) * 100;
  const span = ((200 - saturationV) * brightness) / 100;
  const saturation =
    span > 0 && span < 200
      ? ((saturationV * brightness) / 100 / (span <= 100 ? span : 200 - span)) * 100
      : 0;
  const whole = (n: number): number => Math.round(n) + 0;
  return `${whole(hue)}deg ${whole(saturation)}% ${whole(span / 2)}%`;
}

/** `#rrggbbaa`, lower case, for any hex literal; undefined for every other spelling of a colour. */
function normalHex(value: string): string | undefined {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (match === null) return undefined;
  let hex = match[1]!.toLowerCase();
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  return `#${hex.padEnd(8, "f")}`;
}

/** Whether two spellings are one colour: hex literals compare by value, anything else as written. */
function sameColour(a: string, b: string): boolean {
  const x = normalHex(a);
  const y = normalHex(b);
  return x !== undefined && y !== undefined
    ? x === y
    : a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ── The project style ────────────────────────────────────────────────────────────────────────────

type Layout = Record<string, JxStyle>;

/**
 * Lay the objects `projectStyles` returned over one another in order, later declarations replacing
 * earlier ones in place. `mergeCssIndexes` already is that merge (it is the one the reader itself
 * uses for a stylesheet's repeated rules), so the objects are handed to it as indexes of `other`.
 */
function mergeLayouts(layouts: readonly Layout[]): Layout {
  const asIndex = (layout: Layout): CssIndex => ({
    classes: new Map(),
    other: new Map(Object.entries(layout)),
    atRules: [],
    artifacts: [],
  });
  return Object.fromEntries(mergeCssIndexes(...layouts.map(asIndex)).other);
}

/** The rank of a top-level at-rule key: the breakpoints in cascade order, then everything else as it came. */
function conditionRanker(
  breakpoints: readonly { key: string; direction: string }[],
): (key: string) => number {
  const known = breakpoints.filter((bp) => bp.direction !== "none").map((bp) => `@--${bp.key}`);
  return (key) => {
    const at = known.indexOf(key);
    return at === -1 ? known.length : at;
  };
}

/** Whether `selector` names `needle` as a whole token (`.dark` in `.dark .x`, not in `.darkroom`). */
function mentions(selector: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?![\\w-])`).test(selector);
}

/** The dark selectors of the site, one per list member. */
function darkSelectors(options: CwiclyOptionsFull): string[] {
  return options.darkMode.darkSelectors
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);
}

// ── Shorthands ───────────────────────────────────────────────────────────────────────────────────

const SIDES = ["top", "right", "bottom", "left"] as const;
const sides = (pattern: string): string[] => SIDES.map((side) => pattern.replace("*", side));
const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;

/** Every shorthand the cascade has to see through, with the longhands it sets (CSS property names). */
const SHORTHANDS: Record<string, readonly string[]> = (() => {
  const borderParts = (side: string): string[] => [
    `border-${side}-width`,
    `border-${side}-style`,
    `border-${side}-color`,
  ];
  const table: Record<string, string[]> = {
    margin: sides("margin-*"),
    padding: sides("padding-*"),
    inset: [...SIDES],
    "scroll-margin": sides("scroll-margin-*"),
    "scroll-padding": sides("scroll-padding-*"),
    "border-width": sides("border-*-width"),
    "border-style": sides("border-*-style"),
    "border-color": sides("border-*-color"),
    "border-radius": CORNERS.map((corner) => `border-${corner}-radius`),
    overflow: ["overflow-x", "overflow-y"],
    gap: ["row-gap", "column-gap"],
    flex: ["flex-grow", "flex-shrink", "flex-basis"],
    "flex-flow": ["flex-direction", "flex-wrap"],
    font: [
      "font-style",
      "font-variant",
      "font-weight",
      "font-stretch",
      "font-size",
      "line-height",
      "font-family",
    ],
    background: [
      "background-color",
      "background-image",
      "background-position",
      "background-size",
      "background-repeat",
      "background-origin",
      "background-clip",
      "background-attachment",
    ],
    "list-style": ["list-style-type", "list-style-position", "list-style-image"],
    outline: ["outline-color", "outline-style", "outline-width"],
    "text-decoration": [
      "text-decoration-line",
      "text-decoration-style",
      "text-decoration-color",
      "text-decoration-thickness",
    ],
    transition: [
      "transition-property",
      "transition-duration",
      "transition-timing-function",
      "transition-delay",
    ],
    animation: [
      "animation-name",
      "animation-duration",
      "animation-timing-function",
      "animation-delay",
      "animation-iteration-count",
      "animation-direction",
      "animation-fill-mode",
      "animation-play-state",
    ],
    columns: ["column-width", "column-count"],
    "column-rule": ["column-rule-width", "column-rule-style", "column-rule-color"],
    "grid-template": ["grid-template-rows", "grid-template-columns", "grid-template-areas"],
    "grid-row": ["grid-row-start", "grid-row-end"],
    "grid-column": ["grid-column-start", "grid-column-end"],
    "place-content": ["align-content", "justify-content"],
    "place-items": ["align-items", "justify-items"],
    "place-self": ["align-self", "justify-self"],
  };
  for (const side of SIDES) table[`border-${side}`] = borderParts(side);
  table.border = [
    ...SIDES.flatMap(borderParts),
    "border-image-source",
    "border-image-slice",
    "border-image-width",
    "border-image-outset",
    "border-image-repeat",
  ];
  table["grid-area"] = [...table["grid-row"]!, ...table["grid-column"]!];
  table.grid = [
    ...table["grid-template"]!,
    "grid-auto-rows",
    "grid-auto-columns",
    "grid-auto-flow",
  ];
  return table;
})();

/** `margin-top` as the Jx style key `marginTop`; a custom property is its own key. */
const jxKey = (property: string): string =>
  property.startsWith("--")
    ? property
    : property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const SHORTHAND_SETS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(SHORTHANDS).map(([name, longhands]) => [
    jxKey(name),
    new Set(longhands.map(jxKey)),
  ]),
);

/** The longhands a Jx property key sets: itself, or what the shorthand stands for. `all` is everything. */
const longhandsOf = (key: string): ReadonlySet<string> | "all" =>
  key === "all" ? "all" : (SHORTHAND_SETS.get(key) ?? new Set([key]));

/** Whether setting `a` sets everything `b` sets, so a later `a` leaves `b` nothing to say. */
function covers(a: string, b: string): boolean {
  const x = longhandsOf(a);
  const y = longhandsOf(b);
  if (x === "all") return !b.startsWith("--");
  if (y === "all") return false;
  return [...y].every((longhand) => x.has(longhand));
}

/** Whether `a` and `b` set any property in common. */
function overlaps(a: string, b: string): boolean {
  const x = longhandsOf(a);
  const y = longhandsOf(b);
  if (x === "all") return !b.startsWith("--");
  if (y === "all") return !a.startsWith("--");
  return [...x].some((longhand) => y.has(longhand));
}

// ── The owner's stylesheet against the global CSS ────────────────────────────────────────────────

const IMPORTANT = /!\s*important\s*$/i;

interface Declared {
  selector: string;
  /** The at-rules around it, outermost first. */
  context: readonly string[];
  property: string;
  important: boolean;
}

const declaredOf = (parts: readonly CssRulePart[]): Declared[] =>
  parts.flatMap((part) =>
    part.declarations.map(([property, value]) => ({
      selector: part.selector,
      context: part.context,
      property,
      important: IMPORTANT.test(value),
    })),
  );

const sameContext = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((key, at) => key === b[at]);

/** A declaration the project style cannot make win the way the live site did. */
interface Unresolved {
  selector: string;
  context: string;
  property: string;
  owner: { context: string; property: string };
}

/**
 * Take out of the layout every declaration of `cwicly_global_css` that the site owner's stylesheet
 * overrides on the live site and would no longer override here (the owner's sheet is a `<link>` and
 * the project style a `<style>` after it, so the global rule now comes last). The same selector at
 * the same importance, and the owner's declaration must cover the global one: the same property, or a
 * shorthand that sets it (`margin` over `margin-bottom`). Where the owner's declaration applies
 * wherever the global one does (no at-rule, or the same one) the global one is taken out; a global
 * declaration inside a media query is overridden by the owner's base rule on the live site at every
 * width. It stays when `cc-global-classes.css` sets it again (that file follows the owner's in both
 * places and is the one that wins). Returns what was taken, and what could not be fixed by taking
 * anything out, because dropping it would also drop the part the owner never touched: a global
 * shorthand the owner overrides by one longhand, an owner rule inside a media query over a global
 * base rule, or two different media queries.
 */
function dropOverriddenByCustom(
  layout: Layout,
  globalParts: readonly CssRulePart[],
  classesParts: readonly CssRulePart[],
  customParts: readonly CssRulePart[],
): {
  dropped: { selector: string; context: string; property: string }[];
  unresolved: Unresolved[];
} {
  const dropped: { selector: string; context: string; property: string }[] = [];
  const unresolved: Unresolved[] = [];
  const custom = Map.groupBy(declaredOf(customParts), (declared) => declared.selector);
  if (custom.size === 0) return { dropped, unresolved };
  const later = Map.groupBy(declaredOf(classesParts), (declared) => declared.selector);
  for (const part of globalParts) {
    const theirs = custom.get(part.selector);
    if (theirs === undefined) continue;
    for (const [property, value] of part.declarations) {
      const important = IMPORTANT.test(value);
      // What the classes file says wins in both orders when it covers the declaration wherever it applies.
      const shadowed = (later.get(part.selector) ?? []).some(
        (c) =>
          covers(c.property, property) &&
          (c.important || !important) &&
          (c.context.length === 0 || sameContext(c.context, part.context)),
      );
      if (shadowed) continue;
      let take = false;
      for (const owner of theirs) {
        if (owner.important !== important || !overlaps(owner.property, property)) continue;
        const wherever = owner.context.length === 0 || sameContext(owner.context, part.context);
        if (wherever && covers(owner.property, property)) {
          take = true;
        } else {
          unresolved.push({
            selector: part.selector,
            context: part.context.join(" "),
            property,
            owner: { context: owner.context.join(" "), property: owner.property },
          });
        }
      }
      if (!take) continue;
      // The first at-rule of the context is a top-level key of the layout; deeper ones nest inside the selector's block.
      const outer = part.context.length === 0 ? layout : layout[part.context[0]!];
      let block: unknown = isBlock(outer) ? outer[part.selector] : undefined;
      for (const key of part.context.slice(1)) block = isBlock(block) ? block[key] : undefined;
      if (!isBlock(block) || !hasOwn(block, property)) continue;
      delete block[property];
      dropped.push({ selector: part.selector, context: part.context.join(" "), property });
    }
  }
  // An emptied block, and an emptied at-rule, say nothing.
  for (const [key, value] of Object.entries(layout)) {
    if (!isBlock(value)) continue;
    if (key.startsWith("@")) {
      for (const [selector, block] of Object.entries(value)) {
        if (isBlock(block) && Object.keys(block).length === 0) delete value[selector];
      }
      if (Object.keys(value).length === 0) delete layout[key];
    } else if (Object.keys(value).length === 0) {
      delete layout[key];
    }
  }
  return { dropped, unresolved };
}

/**
 * Fold the light selector into `:root`: delete `.light` and every `.light <rest>` whose `:root <rest>`
 * twin holds the same block, in the layout and in each of its at-rule blocks, and only when every
 * such key has a twin. Returns how many keys went.
 */
function foldLightSelector(layout: Layout, lightClass: string): number {
  const head = `.${lightClass}`;
  const containers: Layout[] = [layout];
  for (const [key, value] of Object.entries(layout))
    if (key.startsWith("@") && isBlock(value)) containers.push(value as Layout);
  const doomed: [Layout, string][] = [];
  for (const container of containers) {
    for (const [key, block] of Object.entries(container)) {
      const rest =
        key === head ? "" : key.startsWith(`${head} `) ? key.slice(head.length) : undefined;
      if (rest === undefined) {
        // `.light:hover`, `.light.x`, `.x .light`…: not a twin of anything on `:root`.
        if (key.startsWith(head) && !/[\w-]/.test(key.charAt(head.length))) return 0;
        continue;
      }
      const twin = container[`:root${rest}`];
      if (!isBlock(twin) || !deepEqual(twin, block)) return 0;
      doomed.push([container, key]);
    }
  }
  for (const [container, key] of doomed) delete container[key];
  return doomed.length;
}

// ── The order of the cascade ─────────────────────────────────────────────────────────────────────

type Specificity = readonly [number, number, number];

const LEGACY_ELEMENTS = new Set([":before", ":after", ":first-line", ":first-letter"]);

const higher = (a: Specificity, b: Specificity): Specificity => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! > b[i]! ? a : b;
  }
  return a;
};

/** The specificity of one complex selector: ids, classes (attributes, pseudo-classes), types (pseudo-elements). */
function specificityOfSelector(selector: selectorParser.Selector): Specificity {
  let ids = 0;
  let classes = 0;
  let types = 0;
  for (const node of selector.nodes) {
    if (node.type === "id") ids += 1;
    else if (node.type === "class" || node.type === "attribute") classes += 1;
    else if (node.type === "tag") types += 1;
    else if (node.type === "pseudo") {
      const name = node.value.toLowerCase();
      if (name.startsWith("::") || LEGACY_ELEMENTS.has(name)) {
        types += 1;
      } else if (name === ":where") {
        // zero by definition
      } else if (name === ":is" || name === ":not" || name === ":has" || name === ":matches") {
        const inner = node.nodes.map(specificityOfSelector).reduce(higher, [0, 0, 0]);
        ids += inner[0];
        classes += inner[1];
        types += inner[2];
      } else {
        classes += 1;
      }
    }
  }
  return [ids, classes, types];
}

/** What of a selector decides whether two rules can style the same box, and how strongly. */
interface SelectorFacts {
  specificity: Specificity;
  /** The type, ids, classes and pseudo-element of the compound the selector ends in. */
  tag: string | undefined;
  ids: string;
  classes: readonly string[];
  pseudoElement: string;
}

const factsCache = new Map<string, SelectorFacts | undefined>();

function selectorFacts(selector: string): SelectorFacts | undefined {
  if (factsCache.has(selector)) return factsCache.get(selector);
  let facts: SelectorFacts | undefined;
  try {
    const first = selectorParser().astSync(selector).nodes[0];
    if (first !== undefined) {
      let tag: string | undefined;
      const ids: string[] = [];
      const classes: string[] = [];
      let pseudoElement = "";
      for (const node of first.nodes) {
        // The subject is the last compound: what a combinator closes is not the styled box.
        if (node.type === "combinator") {
          tag = undefined;
          ids.length = 0;
          classes.length = 0;
          pseudoElement = "";
        } else if (node.type === "tag") tag = node.value.toLowerCase();
        else if (node.type === "id") ids.push(node.value);
        else if (node.type === "class") classes.push(node.value);
        else if (node.type === "pseudo") {
          const name = node.value.toLowerCase();
          if (name.startsWith("::") || LEGACY_ELEMENTS.has(name))
            pseudoElement = name.replace(/^:{1,2}/, "");
        }
      }
      facts = {
        specificity: specificityOfSelector(first),
        tag,
        ids: ids.toSorted().join(" "),
        classes,
        pseudoElement,
      };
    }
  } catch {
    // A selector this module cannot read has no specificity to compare.
  }
  factsCache.set(selector, facts);
  return facts;
}

/** One declaration of the project style, where it is written. */
interface Unit {
  selector: string;
  /** The at-rules around it, outermost first; the first is the top-level key it sits under. */
  context: readonly string[];
  property: string;
  value: string | number;
  key: string;
  important: boolean;
  facts: SelectorFacts | undefined;
  /** The key of the block it is written under in its container. */
  block: string;
}

const unitKey = (selector: string, context: readonly string[], property: string): string =>
  `${selector}\0${context.join("\0")}\0${property}`;

/** Selectors Jx lifts out of the layout: their declarations are written first, wherever they were. */
const LIFTED = new Set([":root", "body"]);

/**
 * Every declaration of the layout in the order the page's `<style>` will carry it: the base blocks in
 * the order of the object, then each top-level at-rule in `conditions`; inside a block its own
 * declarations, then the at-rules nested in it.
 */
function unitsOf(layout: Layout, conditions: readonly string[]): Unit[] {
  const out: Unit[] = [];
  const block = (
    selector: string,
    body: JxStyle,
    context: readonly string[],
    home: string,
  ): void => {
    for (const [property, value] of Object.entries(body)) {
      if (!isScalar(value)) continue;
      out.push({
        selector,
        context,
        property,
        value,
        key: unitKey(selector, context, property),
        important: IMPORTANT.test(String(value)),
        facts: selectorFacts(selector),
        block: home,
      });
    }
    for (const [key, nested] of Object.entries(body)) {
      if (isBlock(nested) && key.startsWith("@")) block(selector, nested, [...context, key], home);
    }
  };
  for (const [key, value] of Object.entries(layout)) {
    if (!key.startsWith("@") && isBlock(value) && !LIFTED.has(key)) block(key, value, [], key);
  }
  for (const condition of conditions) {
    const container = layout[condition];
    if (!isBlock(container)) continue;
    for (const [selector, body] of Object.entries(container)) {
      if (isBlock(body) && !LIFTED.has(selector)) block(selector, body, [condition], selector);
    }
  }
  return out;
}

/**
 * Where each declaration that survives the merge was written in the source, counted over every
 * declaration of every rule. The merge keeps the last write of a property in a rule except an
 * `!important` one a later plain write does not replace: the position is that of the write kept.
 */
function sourcePositions(parts: readonly CssRulePart[]): Map<string, number> {
  const kept = new Map<string, { at: number; important: boolean }>();
  let position = 0;
  for (const part of parts) {
    for (const [property, value] of part.declarations) {
      const key = unitKey(part.selector, part.context, property);
      const important = IMPORTANT.test(value);
      const earlier = kept.get(key);
      if (earlier === undefined || important || !earlier.important) {
        kept.set(key, { at: position, important });
      }
      position += 1;
    }
  }
  return new Map([...kept].map(([key, { at }]) => [key, at] as const));
}

/**
 * The pairs of declarations that could decide one box's value (same property, same importance, same
 * specificity, selectors that can end in one element, different values), each as `{first, second}`:
 * in the source `second` comes later and so wins. Two different selectors can end in one element when
 * neither names a class outside `authored` (the site's global classes, which an author puts on the
 * same element at will); a class that belongs to a component (the plugin's navigation, a WordPress
 * block) is not combined with another, and a pair of those would only be noise.
 */
function conflictsOf(
  units: readonly Unit[],
  source: ReadonlyMap<string, number>,
  authored: ReadonlySet<string>,
): { first: Unit; second: Unit }[] {
  const out: { first: Unit; second: Unit }[] = [];
  // A shorthand and the longhand it sets decide the same value, so a unit is filed under every longhand it sets.
  const buckets = new Map<string, number[]>();
  units.forEach((unit, at) => {
    const set = longhandsOf(unit.property);
    if (set === "all") return;
    for (const name of set) {
      const bucket = buckets.get(name);
      if (bucket === undefined) buckets.set(name, [at]);
      else bucket.push(at);
    }
  });
  const seen = new Set<number>();
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      const u = units[bucket[i]!]!;
      const fu = u.facts;
      const su = source.get(u.key);
      if (fu === undefined || su === undefined) continue;
      for (let j = i + 1; j < bucket.length; j += 1) {
        const v = units[bucket[j]!]!;
        const fv = v.facts;
        const sv = source.get(v.key);
        if (fv === undefined || sv === undefined || u.important !== v.important) continue;
        if (fu.specificity.some((n, at) => n !== fv.specificity[at])) continue;
        if (u.property === v.property && String(u.value).trim() === String(v.value).trim())
          continue;
        if (u.selector !== v.selector) {
          if (fu.classes.some((name) => !authored.has(name))) continue;
          if (fv.classes.some((name) => !authored.has(name))) continue;
        }
        if (fu.tag !== undefined && fv.tag !== undefined && fu.tag !== fv.tag) continue;
        if (fu.ids !== "" && fv.ids !== "" && fu.ids !== fv.ids) continue;
        if (fu.pseudoElement !== fv.pseudoElement) continue;
        // Two shorthands that share several longhands meet in several buckets: once is enough.
        const id = bucket[i]! * units.length + bucket[j]!;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(su < sv ? { first: u, second: v } : { first: v, second: u });
      }
    }
  }
  return out;
}

/** An at-rule container as the first key of a context: `""` is the base. */
const containerOf = (unit: Unit): string => unit.context[0] ?? "";

/**
 * `selector` as an equal-specificity spelling that is a different key: the first simple selector
 * wrapped in `:is()` (`.a:hover` is `:is(.a):hover`, and `:is()` takes the specificity of its
 * argument). Wrapping again gives another. Undefined where the selector cannot be spelled so (it
 * starts with a pseudo-element or a nesting selector).
 */
function aliasOf(selector: string): string | undefined {
  try {
    const first = selectorParser().astSync(selector).nodes[0]?.nodes[0];
    if (first === undefined || first.type === "nesting" || first.type === "combinator")
      return undefined;
    if (first.type === "pseudo" && first.value.startsWith("::")) return undefined;
    const written = first.toString();
    if (!selector.startsWith(written)) return undefined;
    return `:is(${written})${selector.slice(written.length)}`;
  } catch {
    return undefined;
  }
}

/**
 * A top-level order for the at-rule keys of the layout that keeps the breakpoints where the
 * cascade needs them (`known`, in the order given) and puts any other at-rule before or after a
 * breakpoint when a pair of conflicting declarations says the source had it so. A constraint that
 * would contradict an earlier one or the breakpoints is left out.
 */
function orderConditions(
  initial: readonly string[],
  known: ReadonlySet<string>,
  wanted: readonly [before: string, after: string][],
): string[] {
  const after = new Map<string, Set<string>>(initial.map((key) => [key, new Set<string>()]));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const next of after.get(at) ?? []) stack.push(next);
    }
    return false;
  };
  const add = (before: string, later: string): void => {
    if (before === later || !after.has(before) || !after.has(later)) return;
    if (reaches(later, before)) return;
    after.get(before)!.add(later);
  };
  const breakpoints = initial.filter((key) => known.has(key));
  for (let i = 1; i < breakpoints.length; i += 1) add(breakpoints[i - 1]!, breakpoints[i]!);
  for (const [before, later] of wanted) add(before, later);
  const indegree = new Map<string, number>(initial.map((key) => [key, 0]));
  for (const targets of after.values())
    for (const target of targets) indegree.set(target, indegree.get(target)! + 1);
  const out: string[] = [];
  const left = new Set(initial);
  while (left.size > 0) {
    const next = initial.find((key) => left.has(key) && indegree.get(key) === 0)!;
    left.delete(next);
    out.push(next);
    for (const target of after.get(next)!) indegree.set(target, indegree.get(target)! - 1);
  }
  return out;
}

interface Repair {
  /** The at-rule keys in the order they are written. */
  conditions: string[];
  /** Blocks written under an `:is()` alias to keep the file's order. */
  aliases: { selector: string; alias: string; context: string }[];
}

/**
 * Put the layout's rules in an order where, for every pair of declarations that could decide one
 * box's value, the one the source had last is the one written last, as far as one object can say so:
 *
 * - Top-level at-rules are ordered by the pairs found (an `@supports` rule that preceded a
 *   breakpoint's in the file keeps preceding it).
 * - Inside one container (the base, one at-rule), a declaration that would be written before one it
 *   must beat is moved to a block of its own, spelled with an equal-specificity alias (`:is(.a)`) and
 *   put after the last declaration it must follow. A block cannot be split any other way, and a later
 *   object's rules cannot be merged into an earlier object's blocks without this.
 *
 * What it cannot do (a base rule that must follow an at-rule's, since the base comes first) it leaves
 * for `invertedPairs` to report. Mutates `layout`.
 */
function repairOrder(
  layout: Layout,
  source: ReadonlyMap<string, number>,
  authored: ReadonlySet<string>,
  initial: readonly string[],
  known: ReadonlySet<string>,
): Repair {
  const present = initial.filter((key) => isBlock(layout[key]));
  let conditions = [...present];
  const lay = (): Unit[] => unitsOf(layout, conditions);

  // Top-level at-rules.
  const wanted: [string, string][] = [];
  for (const pair of conflictsOf(lay(), source, authored)) {
    const a = containerOf(pair.first);
    const b = containerOf(pair.second);
    if (a !== b && a !== "" && b !== "") wanted.push([a, b]);
  }
  conditions = orderConditions(present, known, wanted);

  // Inside each container.
  const aliases: Repair["aliases"] = [];
  const units = lay();
  const preds = new Map<Unit, Unit[]>();
  for (const { first: a, second: b } of conflictsOf(units, source, authored)) {
    if (containerOf(a) !== containerOf(b)) continue;
    preds.set(b, [...(preds.get(b) ?? []), a]);
  }
  const touched = new Set([...preds.keys()].map(containerOf));
  for (const container of touched) {
    const body = container === "" ? undefined : layout[container];
    if (container !== "" && !isBlock(body)) continue;
    const mine = units.filter((unit) => containerOf(unit) === container);
    // A block this does not understand (a nested selector) is left as it is.
    const blocks =
      container === ""
        ? Object.entries(layout).filter(([k]) => !k.startsWith("@"))
        : Object.entries(body!);
    if (
      blocks.some(
        ([, value]) =>
          !isBlock(value) ||
          Object.entries(value).some(([k, v]) => isBlock(v) && !k.startsWith("@")),
      )
    )
      continue;
    const order = [...mine];
    const taken = new Set(blocks.map(([key]) => key));
    const aliasBlocks = new Map<string, string>();
    let moved = false;
    for (const unit of mine.toSorted((x, y) => source.get(x.key)! - source.get(y.key)!)) {
      const before = preds.get(unit);
      if (before === undefined) continue;
      const here = order.indexOf(unit);
      const last = Math.max(...before.map((p) => order.indexOf(p)));
      if (here > last) continue;
      const anchor = order[last]!;
      // Right after the end of the anchor's block: blocks stay in one piece.
      let end = last;
      for (let i = last + 1; i < order.length; i += 1)
        if (order[i]!.block === anchor.block) end = i;
      let home = anchor.block;
      const homeSelector = aliasBlocks.get(home) ?? home;
      if (homeSelector !== unit.selector) {
        let alias = unit.selector;
        for (;;) {
          const next = aliasOf(alias);
          if (next === undefined) {
            alias = "";
            break;
          }
          alias = next;
          if (!taken.has(alias)) break;
        }
        if (alias === "") continue;
        taken.add(alias);
        aliasBlocks.set(alias, unit.selector);
        aliases.push({ selector: unit.selector, alias, context: container });
        home = alias;
      }
      order.splice(here, 1);
      if (here < end) end -= 1;
      order.splice(end + 1, 0, unit);
      unit.block = home;
      moved = true;
    }
    if (!moved) continue;
    // Write the container again, block by block, in the new order.
    const rebuilt: Layout = {};
    for (const unit of order) {
      let cursor: JxStyle = (rebuilt[unit.block] ??= {});
      for (const key of unit.context.slice(1)) {
        const nested = cursor[key];
        if (isBlock(nested)) {
          cursor = nested;
        } else {
          const fresh: JxStyle = {};
          cursor[key] = fresh;
          cursor = fresh;
        }
      }
      cursor[unit.property] = unit.value;
    }
    // The lifted blocks stay where they are; everything else is written again after them.
    const target = container === "" ? layout : (body as Layout);
    for (const key of Object.keys(target)) {
      if (!LIFTED.has(key) && (container !== "" || !key.startsWith("@"))) delete target[key];
    }
    Object.assign(target, rebuilt);
  }
  return { conditions, aliases };
}

/** The pairs `repairOrder` could not put right: `selector` wins here and loses in the source. */
function invertedPairs(
  layout: Layout,
  conditions: readonly string[],
  source: ReadonlyMap<string, number>,
  authored: ReadonlySet<string>,
): {
  property: string;
  here: { selector: string; context: string };
  inSource: { selector: string; context: string };
}[] {
  const units = unitsOf(layout, conditions);
  const index = new Map(units.map((unit, at) => [unit, at] as const));
  return conflictsOf(units, source, authored)
    .filter(({ first, second }) => index.get(first)! > index.get(second)!)
    .map(({ first, second }) => ({
      property: first.property,
      here: { selector: first.selector, context: first.context.join(" ") },
      inSource: { selector: second.selector, context: second.context.join(" ") },
    }));
}

interface StyleBuild {
  style: JxStyle;
  layoutObjects: number;
  droppedByCustom: { selector: string; context: string; property: string }[];
  unresolved: Unresolved[];
  aliases: Repair["aliases"];
  inverted: ReturnType<typeof invertedPairs>;
  lightFolded: number;
  tokensAdded: string[];
  tokenMismatches: { variable: string; compiled: string; palette: string }[];
}

/**
 * The project style from the two indexes. See the module comment for the layout. Steps, in order:
 * lay the rules out; merge the layout objects; take out what the owner's stylesheet overrides;
 * fold the light selector; lift `:root`'s custom properties and `body`'s declarations to the top
 * level; check the palette against the tokens; order the keys; add the declaration at-rules.
 */
function buildStyle(
  input: DesignSystemInput,
  customParts: readonly CssRulePart[],
  darkRules: boolean,
): StyleBuild {
  const { options, globalCss, classesCss } = input;
  const merged = mergeCssIndexes(globalCss, classesCss);
  const layouts = projectStyles(merged, options.breakpoints);
  const layout = mergeLayouts(layouts);

  const { dropped: droppedByCustom, unresolved } = dropOverriddenByCustom(
    layout,
    cssRules(globalCss),
    cssRules(classesCss),
    customParts,
  );

  let lightFolded = 0;
  if (!darkRules) {
    for (const name of options.darkMode.lightClasses)
      lightFolded += foldLightSelector(layout, name);
  }

  // The merge above puts a later object's rules at an earlier object's place; write them where the
  // file had them where one object can say so, and name what it cannot.
  const rank = conditionRanker(options.breakpoints);
  const atRuleKeys = Object.keys(layout).filter(
    (key) =>
      key.startsWith("@") &&
      isBlock(layout[key]) &&
      !isDeclarationAtRule(key) &&
      !isKeyframesAtRule(key),
  );
  const known = new Set(
    options.breakpoints.filter((bp) => bp.direction !== "none").map((bp) => `@--${bp.key}`),
  );
  const source = sourcePositions(cssRules(merged));
  const authored = new Set([...classesCss.classes.keys(), ...options.globalClassNames.values()]);
  const repair = repairOrder(
    layout,
    source,
    authored,
    atRuleKeys.toSorted((a, b) => rank(a) - rank(b)),
    known,
  );
  const inverted = invertedPairs(layout, repair.conditions, source, authored);

  // Lift `:root`'s custom properties and `body`'s declarations, at the top level and in each at-rule block.
  const tokens: JxStyle = {};
  const lift = (container: Layout, into: JxStyle, rootInto: JxStyle): void => {
    const root = container[":root"];
    if (isBlock(root)) {
      for (const [key, value] of Object.entries(root)) {
        if (key.startsWith("--") && isScalar(value)) {
          rootInto[key] = value;
          delete root[key];
        }
      }
      if (Object.keys(root).length === 0) delete container[":root"];
    }
    const body = container["body"];
    if (isBlock(body)) {
      for (const [key, value] of Object.entries(body)) {
        // Jx writes a top-level `colorScheme` onto `:root`, which is not what `body { color-scheme }` said,
        // and every top-level custom property onto `:root` too: `body { --c: blue }` lifted would
        // replace `:root`'s own `--c` for every element that reads it above the body.
        if (isScalar(value) && key !== "colorScheme" && !key.startsWith("--")) {
          into[key] = value;
          delete body[key];
        }
      }
      if (Object.keys(body).length === 0) delete container["body"];
    }
  };
  const bodyProps: JxStyle = {};
  lift(layout, bodyProps, tokens);
  for (const [key, value] of Object.entries(layout)) {
    if (!key.startsWith("@") || !isBlock(value)) continue;
    if (isDeclarationAtRule(key) || isKeyframesAtRule(key)) continue;
    // In an at-rule block, direct custom properties go to `:root` and the rest to `body`.
    const direct: JxStyle = {};
    lift(value as Layout, direct, direct);
    layout[key] = { ...direct, ...value };
  }

  // The palette against the tokens: what the compiled CSS lacks is added, what it disagrees on is reported.
  const tokensAdded: string[] = [];
  const tokenMismatches: StyleBuild["tokenMismatches"] = [];
  // A token the owner's stylesheet sets on `:root` was taken out above so that value still wins; the
  // compiled CSS did declare it, so the palette has nothing to add.
  const overridden = new Set(
    droppedByCustom
      .filter((entry) => entry.selector === ":root" && entry.context === "")
      .map((entry) => entry.property),
  );
  for (const color of options.globalStyles.colors) {
    const compiled = tokens[color.variable];
    if (compiled === undefined) {
      if (overridden.has(color.variable)) continue;
      tokens[color.variable] = color.value;
      tokensAdded.push(color.variable);
      const hsl = hexToHsl(color.value);
      if (hsl !== undefined && tokens[`${color.variable}-hsl`] === undefined) {
        tokens[`${color.variable}-hsl`] = hsl;
      }
    } else if (typeof compiled === "string" && !sameColour(compiled, color.value)) {
      tokenMismatches.push({ variable: color.variable, compiled, palette: color.value });
    }
  }
  for (const gradient of options.globalStyles.gradients) {
    if (tokens[gradient.variable] !== undefined || overridden.has(gradient.variable)) continue;
    tokens[gradient.variable] = resolvePaletteRefs(
      gradient.value,
      options.globalStyles.colorRefs,
    ).text;
    tokensAdded.push(gradient.variable);
  }

  // Order: tokens, body, selector blocks as laid out, at-rule blocks by breakpoint.
  const style: JxStyle = { ...tokens, ...bodyProps };
  const selectors = Object.keys(layout).filter((key) => !key.startsWith("@"));
  const conditions = [
    ...repair.conditions,
    ...Object.keys(layout)
      .filter((key) => key.startsWith("@") && !repair.conditions.includes(key))
      .sort((a, b) => rank(a) - rank(b)),
  ];
  for (const key of selectors) style[key] = layout[key]!;
  for (const key of conditions) style[key] = layout[key]!;
  return {
    style,
    layoutObjects: layouts.length,
    droppedByCustom,
    unresolved,
    aliases: repair.aliases,
    inverted,
    lightFolded,
    tokensAdded,
    tokenMismatches,
  };
}

// ── The design system ────────────────────────────────────────────────────────────────────────────

/**
 * The top-level at-rules of a stylesheet's text that the reader could not classify (`@page`,
 * `@font-feature-values`, `@layer a, b;`: no Jx style key spells them), as written, keyed by the head
 * the reader reported them under, every occurrence in order (a file may hold several `@page` rules,
 * and the reader reports each). They are carried verbatim instead of lost. A statement keeps its
 * `;`: postcss leaves it on the parent, so without it the next rule would become the statement's body.
 */
function unclassifiedAtRules(text: string, index: CssIndex): Map<string, string[]> {
  const heads = new Set(
    index.artifacts
      .filter((a) => a.code === CSS_ARTIFACT.unclassified && a.selector?.startsWith("@"))
      .map((a) => a.selector!),
  );
  const found = new Map<string, string[]>();
  if (heads.size === 0 || text.trim() === "") return found;
  let root: postcss.Root;
  try {
    root = postcss.parse(text);
  } catch {
    return found;
  }
  root.each((node) => {
    if (node.type !== "atrule") return;
    const params = node.params.trim().replace(/\s+/g, " ");
    const head = params === "" ? `@${node.name}` : `@${node.name} ${params}`;
    if (!heads.has(head)) return;
    const written = `${node.toString().trim()}${node.nodes === undefined ? ";" : ""}`;
    found.set(head, [...(found.get(head) ?? []), written]);
  });
  return found;
}

/** `Family 400 italic`: which face an `@font-face` entry is, for a report line. */
function faceLabel(style: JxStyle): string {
  const part = (value: unknown): string =>
    isScalar(value) ? String(value).replace(/^["']|["']$/g, "") : "";
  const family = part(style.fontFamily) || "?";
  const variant = [part(style.fontWeight), part(style.fontStyle)].filter((text) => text !== "");
  return variant.length === 0 ? family : `${family} ${variant.join(" ")}`;
}

/**
 * The comment that opens a stylesheet the project owns, naming where its text came from so the
 * file explains itself to whoever opens it.
 */
const banner = (text: string): string => `/* ${text} */\n`;

/**
 * Turn a Cwicly site's global look into the pieces of a Jx project. Pure: it reads the options and
 * the two parsed indexes and returns data; nothing is written anywhere. See the module comment for
 * the decisions and `DesignSystem` for the result.
 *
 * Report codes (all under `design.`): `cascade-merged`, `cascade-reordered`, `cascade-inverted`,
 * `cascade-order`, `cascade-unresolved`, `dark-mode`,
 * `light-folded`, `palette-added`, `palette-mismatch`, `verbatim`, `custom-css`, `head-deduped`,
 * `head-externalised`, `head-markup`, `font-markup`, `font-unresolved`, `font-unlinked`,
 * `import-hoisted`, `template-literal`; the compiled CSS's own artifacts keep the reader's `css.*`
 * code.
 */
export function buildDesignSystem(
  input: DesignSystemInput,
  opts: DesignSystemOptions = {},
): DesignSystem {
  const { options, report } = input;
  const rewrite = opts.rewriteUrl;
  const files: DesignSystem["files"] = [];
  const stylesheets: DesignSystem["stylesheets"] = [];
  const verbatim: DesignSystem["verbatim"] = [];
  const palette = [...options.globalStyles.colorRefs.values()];

  // At-rules the reader had no key for are recovered from the text, so they are not lost.
  const recovered = new Map<string, Map<string, string[]>>();
  for (const [where, index, text] of [
    ["option:cwicly_global_css", input.globalCss, options.compiledCss.global],
    ["file:cc-global-classes.css", input.classesCss, input.classesText ?? ""],
  ] as const) {
    recovered.set(where, unclassifiedAtRules(text, index));
  }

  // The CSS's own artifacts first: they belong to the sources, whatever the output looks like. The
  // reader warns once per rule it could not place, and so does this: one warning is replaced by
  // each rule recovered under its head, and the rest (a head met more often than it was found) stay.
  if (opts.reportArtifacts !== false) {
    for (const [where, index] of [
      ["option:cwicly_global_css", input.globalCss],
      ["file:cc-global-classes.css", input.classesCss],
    ] as const) {
      const unreplaced = new Map(
        [...(recovered.get(where) ?? [])].map(([head, texts]) => [head, texts.length] as const),
      );
      for (const artifact of index.artifacts) {
        const left =
          artifact.code === CSS_ARTIFACT.unclassified && artifact.selector !== undefined
            ? (unreplaced.get(artifact.selector) ?? 0)
            : 0;
        if (left > 0) {
          unreplaced.set(artifact.selector!, left - 1);
          continue;
        }
        report.add({
          severity: "warn",
          code: artifact.code,
          message: artifact.detail,
          where,
          ...(artifact.selector === undefined ? {} : { data: { selector: artifact.selector } }),
        });
      }
    }
  }

  // `!var=<id>!` the generator never resolved and the reader repaired from the palette: the live
  // site drops those declarations, so a repaired one is a declaration the project has and the site
  // did not.
  const known = new Set(palette.map((color) => color.id));
  for (const [where, text] of [
    ["option:cwicly_global_css", options.compiledCss.global],
    ["file:cc-global-classes.css", input.classesText ?? ""],
  ] as const) {
    const ids = [...text.matchAll(/!var=([^!\s]+)!/g)]
      .map((m) => m[1]!)
      .filter((id) => known.has(id));
    if (ids.length === 0) continue;
    report.add({
      severity: "info",
      code: "design.palette-repaired",
      message: `${ids.length} declaration${ids.length === 1 ? "" : "s"} held a palette reference the generator never resolved (!var=<id>!); a browser drops such a declaration, so the live site does not apply it, and the palette's custom property was written in its place`,
      where,
      data: { ids: [...new Set(ids)] },
    });
  }

  // ── The owner's stylesheet and WordPress's Additional CSS, each as its own file and each read on
  // its own (the cascade needs both: the live site prints them as separate sheets).
  const ownerText = input.stylesheetsCss.trim();
  const additionalText = (input.additionalCss ?? "").trim();
  const readCustom = (text: string): readonly CssRulePart[] =>
    text === ""
      ? []
      : cssRules(
          parseCwiclyCss(text, options.breakpoints, { file: "cc-global-stylesheets.css", palette }),
        );
  const customParts: readonly CssRulePart[] = [
    ...readCustom(ownerText),
    ...readCustom(additionalText),
  ];

  // ── Dark mode: any rule of the global CSS on the dark selector.
  const dark = darkSelectors(options);
  const darkRules = [...cssRules(input.globalCss), ...cssRules(input.classesCss)].some((part) =>
    dark.some((selector) => mentions(part.selector, selector)),
  );
  if (darkRules) {
    report.add({
      severity: "warn",
      code: "design.dark-mode",
      message: `the site's CSS has rules on ${options.darkMode.darkSelectors}, the dark-mode class; they are kept, but Cwicly's darkmode script (which puts the class on <html> from localStorage or the OS setting) is not ported, so nothing applies them`,
      where: "option:cwicly_global_css",
    });
  }

  // ── The project style.
  const built = buildStyle(input, customParts, darkRules);
  const style = built.style;
  if (built.layoutObjects > 1) {
    report.add({
      severity: "info",
      code: "design.cascade-merged",
      message: `the global rules need ${built.layoutObjects} stylesheets to keep the order of the files, and project.json holds one style object: they were merged in order, and a rule the merge would have written before one it must beat was written after it instead (design.cascade-reordered)`,
      where: "option:cwicly_global_css",
      data: { objects: built.layoutObjects },
    });
  }
  if (built.aliases.length > 0) {
    report.add({
      severity: "info",
      code: "design.cascade-reordered",
      message: `${built.aliases.length} block${built.aliases.length === 1 ? "" : "s"} of the global rules had to move behind another to keep the cascade of the files (a later rule of ${built.aliases[0]!.selector} against a rule written after it by the merge), and are written under an equal-specificity alias such as ${built.aliases[0]!.alias}; the alias matches the same elements at the same specificity`,
      where: "option:cwicly_global_css",
      data: { aliases: built.aliases },
    });
  }
  if (built.inverted.length > 0) {
    const first = built.inverted[0]!;
    const named = (side: { selector: string; context: string }): string =>
      `${side.selector}${side.context === "" ? "" : ` in ${side.context}`}`;
    report.add({
      severity: "warn",
      code: "design.cascade-inverted",
      message: `${built.inverted.length} pair${built.inverted.length === 1 ? "" : "s"} of global declarations are written in the opposite order to the files, and one object cannot say it (a rule outside an at-rule is always written before one inside it): ${first.property} of ${named(first.here)} now beats ${named(first.inSource)}, which came later and won on the live site`,
      where: "option:cwicly_global_css",
      data: { pairs: built.inverted },
    });
  }
  if (built.droppedByCustom.length > 0) {
    report.add({
      severity: "info",
      code: "design.cascade-order",
      message: `${built.droppedByCustom.length} declaration${built.droppedByCustom.length === 1 ? "" : "s"} of the global CSS are overridden by the site owner's stylesheet on the live site and the project style would now win over it (the stylesheet is a <link>, the project style a <style> after it): they were taken out of the project style so the owner's value still wins`,
      where: "option:cwicly_global_css",
      data: { dropped: built.droppedByCustom },
    });
  }
  if (built.unresolved.length > 0) {
    const first = built.unresolved[0]!;
    report.add({
      severity: "warn",
      code: "design.cascade-unresolved",
      message: `${built.unresolved.length} declaration${built.unresolved.length === 1 ? "" : "s"} of the global CSS overlap one the site owner's stylesheet sets, and the owner's wins on the live site; here the project style comes after the owner's <link> and wins instead, and taking the global declaration out would lose the part the owner did not override (the first: ${first.selector} ${first.property} in ${first.context === "" ? "no at-rule" : first.context}, against the owner's ${first.owner.property} in ${first.owner.context === "" ? "no at-rule" : first.owner.context}), so it was kept`,
      where: "option:cwicly_global_css",
      data: { pairs: built.unresolved },
    });
  }
  if (built.lightFolded > 0) {
    report.add({
      severity: "info",
      code: "design.light-folded",
      message: `the compiled palette is declared on both :root and the light-mode class; with no dark palette they cannot differ, so the ${built.lightFolded} duplicate keys of the light class were folded into :root`,
      where: "option:cwicly_global_css",
      data: { keys: built.lightFolded },
    });
  }
  if (built.tokensAdded.length > 0) {
    report.add({
      severity: "info",
      code: "design.palette-added",
      message: `${built.tokensAdded.length} palette colours or gradients had no custom property in the compiled CSS and were added from the palette: ${built.tokensAdded.join(", ")}`,
      where: "option:cwicly_global_styles",
      data: { variables: built.tokensAdded },
    });
  }
  for (const mismatch of built.tokenMismatches) {
    report.add({
      severity: "warn",
      code: "design.palette-mismatch",
      message: `${mismatch.variable} is ${mismatch.compiled} in the compiled CSS and ${mismatch.palette} in the palette; the compiled value (what the live site shows) is kept`,
      where: "option:cwicly_global_styles",
      data: { ...mismatch },
    });
  }

  // ── At-rules: faces to the verbatim sheet, animations and the like stay in the style.
  const merged = mergeCssIndexes(input.globalCss, input.classesCss);
  const rules: string[] = [];
  const seenRules = new Set<string>();
  const addVerbatim = (text: string, rule: string, reason: string): void => {
    if (seenRules.has(text)) return;
    seenRules.add(text);
    rules.push(text);
    verbatim.push({ rule, reason });
  };
  const FACE_REASON =
    "project.json's style cannot hold several @font-face rules (the array form fails jx validate and the site style builder drops it), so every face is written to the verbatim stylesheet";
  for (const { key, style: body } of merged.atRules) {
    const name = atRuleName(key);
    if (name === "import" && Object.keys(body).length === 0) continue;
    if (name === "font-face") {
      addVerbatim(renderAtRule(key, body), `@font-face ${faceLabel(body)}`, FACE_REASON);
    } else if (isKeyframesAtRule(key) || isDeclarationAtRule(key)) {
      style[key] = cloneJson(body);
    } else {
      addVerbatim(
        renderAtRule(key, body),
        key,
        `${key} has no place in project.json's style, so it is written to the verbatim stylesheet`,
      );
    }
  }

  for (const found of recovered.values()) {
    for (const [head, texts] of found) {
      for (const text of texts) {
        addVerbatim(
          text,
          head,
          `${head} has no key in project.json's style, so it is written to the verbatim stylesheet as the site wrote it`,
        );
      }
    }
  }

  // ── Local fonts.
  const local = localFonts(options, report);
  const localText = local.css;

  if (rewrite !== undefined) rewriteStyleUrls(style, rewrite);
  const escaped = escapeStyleTemplates(style);
  if (escaped > 0) {
    report.add({
      severity: "info",
      code: "design.template-literal",
      message: `${escaped} style value${escaped === 1 ? "" : "s"} held a Jx template marker, which the build would evaluate; the dollar sign was written as the CSS escape \\24`,
      where: "option:cwicly_global_css",
    });
  }

  // ── The verbatim stylesheet.
  let globalCss = "";
  if (localText !== "" || rules.length > 0) {
    const sections: string[] = [];
    // The local fonts' addresses are final (`/fonts/…`); the other rules are the site's own text.
    if (localText !== "")
      sections.push(`${banner("Local fonts (Cwicly: cwicly_local_active_fonts)")}${localText}`);
    if (rules.length > 0) {
      const text = rules.join("\n\n");
      sections.push(
        `${banner("Rules project.json's style cannot carry")}${rewrite === undefined ? text : rewriteCssUrls(text, rewrite)}`,
      );
    }
    globalCss = `${sections.join("\n\n")}\n`;
  }
  for (const rule of verbatim) {
    report.add({
      severity: "info",
      code: "design.verbatim",
      message: `${rule.rule}: ${rule.reason}`,
      where: "option:cwicly_global_css",
      data: { rule: rule.rule },
    });
  }

  // ── The owner's stylesheet and the Additional CSS, verbatim.
  const customFile = (text: string, label: string, where: string, path: string): string => {
    if (text === "") return "";
    let css = `${banner(label)}${text}\n`;
    if (rewrite !== undefined) css = rewriteCssUrls(css, rewrite);
    report.add({
      severity: "info",
      code: "design.custom-css",
      message: `${label.replace(/ \(.*$/, "")} (${text.length} bytes) is shipped as written to ${path} and linked from the head; it loads before the project style, where the live site printed ${path === CUSTOM_CSS_PATH ? "it between the global rules and the global classes" : "it after everything else"}`,
      where,
      data: { bytes: text.length },
    });
    return css;
  };
  const customCss = customFile(
    ownerText,
    "The site owner's CSS (Cwicly: cc-global-stylesheets.css)",
    "file:cc-global-stylesheets.css",
    CUSTOM_CSS_PATH,
  );
  const additionalCss = customFile(
    additionalText,
    "WordPress Additional CSS (the active theme's custom_css post)",
    "post:custom_css",
    ADDITIONAL_CSS_PATH,
  );

  // ── The head.
  const extra: { path: string; content: string }[] = [];
  const taken = new Set<string>();
  const headCtx = { report, where: "option:cwicly_global_fonts", files: extra, taken };
  const fontEntries = dedupe([
    ...fontHeadEntries(options, headCtx),
    ...collectFontImports([merged], { report, where: "file:cc-global-classes.css" }),
  ]).entries;
  const linked = new Set(fontEntries.map((entry) => entry.attributes?.href));
  for (const font of options.globalStyles.fonts) {
    if (font.source === "google" && font.url !== undefined && !linked.has(font.url)) {
      report.add({
        severity: "info",
        code: "design.font-unlinked",
        message: `the Google font "${font.family}" is in the site's font list but cwicly_global_fonts does not link it, so the live site does not load it either: no link was added`,
        where: "option:cwicly_global_fonts",
        data: { family: font.family, url: font.url },
      });
    }
  }
  const codeHead = parseHeadHtml(options.customCode.head, {
    report,
    where: "option:cwicly_custom_code",
    files: extra,
    taken,
  });

  const head: JxHeadEntry[] = [];
  if (opts.compat !== undefined) {
    const href = opts.compat.href ?? `/${opts.compat.path.replace(/^public\//, "")}`;
    files.push({ path: opts.compat.path, content: opts.compat.content });
    stylesheets.push({ role: "compat", path: opts.compat.path, href });
    head.push(link(href));
  }
  if (globalCss !== "") {
    files.push({ path: GLOBAL_CSS_PATH, content: globalCss });
    stylesheets.push({ role: "global", path: GLOBAL_CSS_PATH, href: GLOBAL_CSS_HREF });
    head.push(link(GLOBAL_CSS_HREF));
  }
  if (customCss !== "") {
    files.push({ path: CUSTOM_CSS_PATH, content: customCss });
    stylesheets.push({ role: "custom", path: CUSTOM_CSS_PATH, href: CUSTOM_CSS_HREF });
    head.push(link(CUSTOM_CSS_HREF));
  }
  if (additionalCss !== "") {
    files.push({ path: ADDITIONAL_CSS_PATH, content: additionalCss });
    stylesheets.push({ role: "additional", path: ADDITIONAL_CSS_PATH, href: ADDITIONAL_CSS_HREF });
    head.push(link(ADDITIONAL_CSS_HREF));
  }
  head.push(...fontEntries, ...codeHead);
  for (const file of extra) files.push(file);

  return {
    media: { ...options.media },
    style,
    head,
    files,
    fontDownloads: local.downloads,
    customCode: { ...options.customCode },
    stylesheets,
    verbatim,
    fonts: options.globalStyles.fonts.map((font) => ({ family: font.family, source: font.source })),
    layoutObjects: built.layoutObjects,
    darkRules,
  };
}
