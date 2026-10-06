/**
 * The plugin's own CSS, as a stylesheet of the Jx project.
 *
 * A Cwicly page links more than the site's generated files. `assets/css/base.css` (a reset: border
 * boxes, margin-less headings, links that inherit their colour) and `build/style-index.css` (35 KB:
 * `.cc-cntr,.cc-sct{width:100%}`, the container's `max-width`, every rule of `.cc-nav`,
 * `.cc-hamburger` and `.cc-menu`, the media and icon wrappers) belong to the plugin, and the
 * structural classes the converted markup keeps (`cc-sct`, `cc-cntr`, `cc-nav…`) are styled by them
 * and by nothing else. They load first on the live site (`CCnorm`, then `CC`), ahead of
 * `cc-global-inline-css`, so the project links this file first in `$head` and every global rule
 * overrides it, as it does there.
 *
 * What was checked, against `tests/fixtures/<site>/html` (the live pages) and the plugin source:
 *
 * - Every one of the 12 live pages loads `base.css` and `style-index.css`, and only those two
 *   always: the others are enqueued by the block that needs them, under an attribute test the PHP
 *   makes (`imageAnimation`, `hoverAnimation`, `imageLightbox`, a gallery block, a modal block,
 *   `infiniteLoad`, `repeaterSlider`, a slider block, `animateOnScrollType`). `compatFeaturesForBlocks`
 *   repeats those tests; the file list a page needs is therefore known from its blocks.
 * - The plugin copy in a site checkout and the one in the Cwicly repository (1.6.0) are byte-for-byte
 *   the same for every file below, so a repository checkout is a good source for a 1.4.x site. The
 *   version is read anyway and a mismatch with the site's own (`cwicly_db_version`) is reported.
 * - Nothing here has a relative `url()`, `@import` or `@charset` (the one `url()` is a `data:` font in
 *   `swiper.css`), so concatenating the files into one is safe wherever the result is served from.
 *
 * The theme's own `style.css` (`body{position:relative}` and the comment form's rules; every page of a
 * site on the Cwicly theme links it last) is not a plugin file, so the caller reads it (`dirThemeCss`,
 * `fetchThemeCss`) and passes it as `theme`; it ends this file and is pruned like the rest.
 *
 * What is not shipped, and why:
 *
 * - `aos.css` is never shipped. `[data-aos|=fade]{opacity:0!important}` hides an element until
 *   Cwicly's script reveals it, and that script is not ported, so the stylesheet would hide content
 *   permanently. Asking for it is reported.
 * - The tooltip and popover themes (`assets/css/tooltip`, `assets/css/popover`) are Tippy.js themes
 *   for a script that is not ported. `assets/js/fr/dist/main-*.css` styles the frontend-rendered
 *   query (a JavaScript application); the converted queries are static.
 * - Stripping is opt-in and by evidence: with `usedClasses` (every class the project's markup
 *   carries) a rule whose selectors all require a class outside that set is dropped, because no
 *   element can match it. Without it nothing is dropped: whether a rule is dead depends on markup
 *   this module does not see.
 *
 * `PluginAssetSource.get` is synchronous so that `buildCompatCss` is: a source that has to fetch
 * (`fetchPluginSource`) does so once, up front, and answers from memory.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import type { AtRule, Container } from "postcss";
import selectorParser from "postcss-selector-parser";
import type { FetchLike } from "../media.ts";
import type { Report, WpBlock } from "../types.ts";
import { walkBlocks } from "../wp/blocks.ts";

/** Where the file goes in the project, and how the page links it. */
export const COMPAT_CSS_PATH = "public/css/cwicly-base.css";
export const COMPAT_CSS_HREF = "/css/cwicly-base.css";

/** The files every Cwicly page loads, in the order it loads them (`CCnorm`, `CC`). */
export const COMPAT_BASE_FILES = ["assets/css/base.css", "build/style-index.css"] as const;

/** Optional stylesheets, in the order they are written into the file. */
export const COMPAT_FEATURE_FILES = {
  gallery: "assets/css/gallery.css",
  lightbox: "assets/css/lightbox.css",
  hoverAnimation: "assets/css/hover-animation.css",
  modal: "assets/css/modal.min.css",
  loaders: "assets/css/loaders.min.css",
  swiper: "assets/css/swiper.css",
  splide: "assets/css/splide.css",
  aos: "assets/css/aos.css",
} as const;

export type CompatFeature = keyof typeof COMPAT_FEATURE_FILES;

/** Where the theme stylesheet is named in `CompatCss.files`, relative to the site root. */
export const COMPAT_THEME_PATH = "wp-content/themes/cwicly/style.css";

/** Everything `fetchPluginSource` asks a live site for. */
export const COMPAT_FETCH_FILES: readonly string[] = [
  ...COMPAT_BASE_FILES,
  ...Object.values(COMPAT_FEATURE_FILES),
  "readme.txt",
];

// ── Sources ──────────────────────────────────────────────────────────────────────────────────────

export interface PluginAssetSource {
  /** The text of a plugin file, by path relative to the plugin's root (`build/style-index.css`); null when the source does not have it. */
  get(relPath: string): string | null;
  /** Where the files come from, for the report: a directory, a URL. */
  readonly origin: string;
}

/**
 * A directory: the plugin itself (`.../wp-content/plugins/cwicly`), a site checkout or the WordPress
 * root above it (`<root>/wp-content/plugins/cwicly`), or the Cwicly repository, whose root IS the
 * plugin.
 */
export function dirPluginSource(root: string): PluginAssetSource {
  const nested = join(root, "wp-content", "plugins", "cwicly");
  const base = existsSync(nested) ? nested : root;
  return {
    origin: base,
    get(relPath) {
      try {
        return readFileSync(join(base, relPath), "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** Files already in hand, keyed by plugin-relative path. */
export function memoryPluginSource(
  files: Readonly<Record<string, string>>,
  origin = "memory",
): PluginAssetSource {
  const own = new Map(Object.entries(files));
  return { origin, get: (relPath) => own.get(relPath) ?? null };
}

/**
 * The live site's copy (`<site>/wp-content/plugins/cwicly/...`), fetched once for every file
 * `buildCompatCss` can use. A file the site does not serve is absent from the result, so the
 * caller learns of it from `buildCompatCss`, which reports what it needed and did not get.
 */
export async function fetchPluginSource(
  siteUrl: string,
  opts: { fetch?: FetchLike | undefined } = {},
): Promise<PluginAssetSource> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = `${siteUrl.replace(/\/+$/, "")}/wp-content/plugins/cwicly/`;
  const files: Record<string, string> = {};
  await Promise.all(
    COMPAT_FETCH_FILES.map(async (path) => {
      const text = await fetchText(doFetch, new URL(path, base).href);
      if (text !== null) files[path] = text;
    }),
  );
  return memoryPluginSource(files, base);
}

/**
 * One file of a live site as text, or null when the site does not have it. A 2xx is not enough: a
 * WordPress site with a catch-all route answers a missing file with its 404 PAGE and a 200, and that
 * HTML would be shipped as a stylesheet. A response that says it is HTML, or whose text opens with
 * markup (no CSS and no readme opens with `<`), is absent. Unreachable is absent too.
 */
async function fetchText(doFetch: FetchLike, url: string): Promise<string | null> {
  try {
    const response = await doFetch(url);
    if (!response.ok) return null;
    const type = response.headers?.get("content-type") ?? "";
    const text = await response.text();
    if (/\bhtml\b/i.test(type) || text.trimStart().startsWith("<")) return null;
    return text;
  } catch {
    return null;
  }
}

/** The theme's stylesheet, relative to a site root: the one a Cwicly site's pages link last (`cwicly-css`). */
const THEME_CSS = COMPAT_THEME_PATH;

/**
 * The active Cwicly theme's `style.css` from a site checkout (`<root>/wp-content/themes/cwicly`), or
 * null. Give its text to `buildCompatCss` as `theme`: it is not a plugin file, so the plugin source
 * cannot answer for it.
 */
export function dirThemeCss(root: string): string | null {
  try {
    return readFileSync(join(root, THEME_CSS), "utf8");
  } catch {
    return null;
  }
}

/** The theme's `style.css` from the live site, with the same soft-404 guard as the plugin files. */
export async function fetchThemeCss(
  siteUrl: string,
  opts: { fetch?: FetchLike | undefined } = {},
): Promise<string | null> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  return fetchText(doFetch, new URL(THEME_CSS, `${siteUrl.replace(/\/+$/, "")}/`).href);
}

/**
 * The plugin's version: the `Version:` header of `cwicly.php` (a checkout, the repository), else the
 * `Stable tag:` of `readme.txt` (the only one a live site serves, because it executes the PHP).
 */
export function pluginVersion(source: PluginAssetSource): string | undefined {
  const main = source.get("cwicly.php");
  const header = main === null ? undefined : /^[ \t*]*Version:[ \t]*(\S+)/im.exec(main)?.[1];
  if (header !== undefined) return header;
  const readme = source.get("readme.txt");
  return readme === null ? undefined : /^Stable tag:[ \t]*(\S+)/im.exec(readme)?.[1];
}

// ── Which optional files a set of blocks needs ───────────────────────────────────────────────────

/**
 * The optional stylesheets the plugin itself would enqueue for these blocks, by the attribute tests
 * its render callbacks make (`image.php`, `icon.php`, `nav-link.php`, `gallery.php`, `modal.php`,
 * `button.php`, `query.php`, `query-template.php`, `repeater.php`, `taxonomyterms.php`,
 * `slider.php`, `dynamic/render.php`). That is what the live page loaded, not what the converted
 * page needs: a feature whose script is not ported (a lightbox, a slider) may leave its stylesheet
 * with nothing to style, and the caller decides. `aos` is reported here and refused by
 * `buildCompatCss`.
 */
export function compatFeaturesForBlocks(blocks: readonly WpBlock[]): Set<CompatFeature> {
  const features = new Set<CompatFeature>();
  walkBlocks(blocks, (block) => {
    const attrs = block.attrs;
    const on = (key: string): boolean => Boolean(attrs[key]);
    switch (block.name) {
      case "cwicly/image":
        if (on("imageAnimation")) features.add("hoverAnimation");
        if (on("imageLightbox")) features.add("lightbox");
        break;
      case "cwicly/button":
      case "cwicly/icon":
      case "cwicly/navlink":
        if (on("hoverAnimation")) features.add("hoverAnimation");
        break;
      case "cwicly/gallery":
        features.add("gallery");
        if (attrs.linkWrapperType === "lightbox") features.add("lightbox");
        break;
      case "cwicly/modal":
        features.add("modal");
        break;
      case "cwicly/query":
        if (on("infiniteLoad")) features.add("loaders");
        break;
      case "cwicly/slider":
        features.add("swiper");
        break;
      case "cwicly/repeater":
      case "cwicly/taxonomyterms":
      case "cwicly/query-template":
        if (on("repeaterSlider")) features.add("splide");
        break;
      default:
        break;
    }
    if (on("animateOnScrollType")) features.add("aos");
  });
  return features;
}

// ── Pruning, by evidence ─────────────────────────────────────────────────────────────────────────

/**
 * The classes every element matching the selector must carry: those of its compound selectors at the
 * top level. A class inside `:not()`, `:is()`, `:where()` or `:has()` is not required (an element
 * can match without it), so it does not count.
 */
function requiredClasses(selector: selectorParser.Selector): string[] {
  const required: string[] = [];
  for (const node of selector.nodes) {
    if (node.type === "class") required.push(node.value);
  }
  return required;
}

/** Whether some element carrying only `used` classes could match one member of the selector list. */
function couldMatch(member: string, used: ReadonlySet<string>): boolean {
  let parsed: selectorParser.Root;
  try {
    parsed = selectorParser().astSync(member);
  } catch {
    // Not a selector this module can read: keep it, since "cannot match" has no evidence.
    return true;
  }
  return parsed.nodes.every((selector) =>
    requiredClasses(selector).every((name) => used.has(name)),
  );
}

function selectorMembers(selector: string): string[] {
  return postcss.list.comma(selector).filter((member) => member.trim() !== "");
}

export interface PruneStats {
  rules: number;
  bytes: number;
}

export interface PruneResult {
  css: string;
  stats: PruneStats;
  /** Set when the text is not CSS postcss reads: it comes back untouched, because nothing in it is evidence. */
  error?: string;
}

/**
 * Remove the rules no element carrying only `used` classes can match: every member of the rule's
 * selector list requires a class outside the set. A list keeps the members that can match. A
 * `@keyframes` stays when a kept declaration names it. Everything that does not name a class
 * (`html`, `video`, `[cc-hidden]`, `[data-aos]`) stays: attributes are not evidence here.
 */
export function pruneUnusedClasses(css: string, used: ReadonlySet<string>): PruneResult {
  const stats: PruneStats = { rules: 0, bytes: 0 };
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch (error) {
    return { css, stats, error: (error as Error).message };
  }

  const sweep = (container: Container): void => {
    // A copy: a removed node must not shorten the list being walked.
    for (const node of Array.from(container.nodes ?? [])) {
      if (node.type === "rule") {
        const members = selectorMembers(node.selector);
        const kept = members.filter((member) => couldMatch(member, used));
        if (kept.length === 0) {
          stats.rules += 1;
          stats.bytes += node.toString().length;
          node.remove();
        } else if (kept.length < members.length) {
          node.selector = kept.map((member) => member.trim()).join(",");
        }
      } else if (node.type === "atrule" && node.nodes !== undefined) {
        if (!/^(-\w+-)?keyframes$/i.test(node.name)) {
          sweep(node);
          if (node.nodes.length === 0) node.remove();
        }
      }
    }
  };
  sweep(root);

  // Animations are kept by name, after the rules that use them are settled.
  const named = new Set<string>();
  root.walkDecls(/^(-\w+-)?animation(-name)?$/i, (declaration) => {
    for (const token of declaration.value.split(/[\s,]+/)) named.add(token);
  });
  root.walkAtRules(/^(-\w+-)?keyframes$/i, (keyframes: AtRule) => {
    if (!named.has(keyframes.params.trim())) {
      stats.rules += 1;
      stats.bytes += keyframes.toString().length;
      keyframes.remove();
    }
  });
  return { css: root.toString(), stats };
}

// ── buildCompatCss ───────────────────────────────────────────────────────────────────────────────

export type CompatFeatures = {
  [feature in CompatFeature]?: boolean | undefined;
} & {
  /** The site's own Cwicly version (`options.version`): a plugin copy of another version is reported. */
  version?: string | undefined;
  /**
   * The text of the Cwicly theme's `style.css` (`dirThemeCss`, `fetchThemeCss`): `body{position:relative}`
   * and the comment form's rules, which every page of a site on that theme links. Shipped last, with
   * its header comment dropped. Absent or empty: nothing.
   */
  theme?: string | null | undefined;
  /** Every class the project's markup carries. When given, rules no element of that markup can match are dropped. */
  usedClasses?: ReadonlySet<string> | undefined;
  report?: Report | undefined;
  /** Report location; default `plugin:cwicly`. */
  where?: string | undefined;
};

export interface CompatCss {
  path: typeof COMPAT_CSS_PATH;
  /** How the page links it: `/css/cwicly-base.css`. */
  href: typeof COMPAT_CSS_HREF;
  content: string;
  /** The plugin files written into it, in order. */
  files: { path: string; bytes: number }[];
  /** What was asked for or always needed and is not in the file, with the reason. */
  skipped: { path: string; reason: string }[];
  /** The plugin copy's version, when the source says. */
  pluginVersion: string | undefined;
  /** What `usedClasses` removed. */
  pruned: PruneStats;
}

const AOS_REASON =
  "assets/css/aos.css hides every [data-aos] element (opacity:0!important) until Cwicly's script reveals it, and that script is not ported: shipping it would hide content for good";

/**
 * The compatibility stylesheet: `base.css` and `style-index.css`, then the optional files the
 * caller asks for, each under a one-line comment naming its origin. See the module comment for what
 * each is and why `aos.css` is never in it. A required file the source lacks is an `error` in the
 * report (without one it throws): a project without `style-index.css` has no container widths.
 */
export function buildCompatCss(
  source: PluginAssetSource,
  features: CompatFeatures = {},
): CompatCss {
  const where = features.where ?? "plugin:cwicly";
  const version = pluginVersion(source);
  const files: CompatCss["files"] = [];
  const skipped: CompatCss["skipped"] = [];
  const parts: string[] = [];
  const pruned: PruneStats = { rules: 0, bytes: 0 };

  if (features.version !== undefined && version !== undefined && version !== features.version) {
    features.report?.add({
      severity: "warn",
      code: "design.plugin-version",
      message: `the Cwicly files come from ${source.origin} at version ${version}, but the site runs ${features.version}: the compatibility stylesheet may differ from what its pages loaded`,
      where,
      data: { pluginVersion: version, siteVersion: features.version, origin: source.origin },
    });
  }

  /** One file's text into the output, pruned when asked, under a comment naming it. */
  const ship = (path: string, text: string): void => {
    let body = text;
    if (features.usedClasses !== undefined) {
      const result = pruneUnusedClasses(text, features.usedClasses);
      body = result.css;
      pruned.rules += result.stats.rules;
      pruned.bytes += result.stats.bytes;
      if (result.error !== undefined) {
        features.report?.add({
          severity: "warn",
          code: "design.compat-prune-failed",
          message: `${path} is not CSS the pruner can read (${result.error}), so it is shipped whole`,
          where,
          data: { path },
        });
      }
    }
    const label = version === undefined ? path : `${path} (Cwicly ${version})`;
    parts.push(`/* ${label} */\n${body.trim()}\n`);
    files.push({ path, bytes: body.length });
  };

  const include = (path: string, required: boolean): void => {
    const text = source.get(path);
    if (text === null) {
      const reason = `${path} is not available from ${source.origin}`;
      skipped.push({ path, reason });
      if (required && features.report === undefined)
        throw new Error(`Cwicly compat CSS: ${reason}`);
      features.report?.add({
        severity: required ? "error" : "warn",
        code: "design.compat-missing",
        message: required
          ? `${reason}; without it structural classes such as cc-cntr and cc-nav have no styles`
          : `${reason}; the stylesheet for a feature the site uses is missing`,
        where,
        data: { path, origin: source.origin },
      });
      return;
    }
    ship(path, text);
  };

  for (const path of COMPAT_BASE_FILES) include(path, true);
  for (const feature of Object.keys(COMPAT_FEATURE_FILES) as CompatFeature[]) {
    if (features[feature] !== true) continue;
    const path = COMPAT_FEATURE_FILES[feature];
    if (feature === "aos") {
      skipped.push({ path, reason: AOS_REASON });
      features.report?.add({
        severity: "warn",
        code: "design.compat-skipped",
        message: AOS_REASON,
        where,
        data: { path },
      });
      continue;
    }
    include(path, false);
  }

  // The theme's own stylesheet loads last on the live site; here it is the last file of this one.
  // Every global rule of the project is linked after this file, so a rule of both that the live
  // site resolves for the theme (`body{position:relative}` against a global `body{position}`) is
  // resolved for the project instead; the theme sets only that one declaration and comment-form rules.
  if (features.theme !== undefined && features.theme !== null && features.theme.trim() !== "") {
    ship(COMPAT_THEME_PATH, features.theme.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ""));
  }

  if (pruned.rules > 0) {
    features.report?.add({
      severity: "info",
      code: "design.compat-pruned",
      message: `${pruned.rules} rule${pruned.rules === 1 ? "" : "s"} (${pruned.bytes} bytes) of the plugin CSS name a class no markup of the project carries and were left out`,
      where,
      data: { rules: pruned.rules, bytes: pruned.bytes },
    });
  }

  return {
    path: COMPAT_CSS_PATH,
    href: COMPAT_CSS_HREF,
    content: parts.join("\n"),
    files,
    skipped,
    pluginVersion: version,
    pruned,
  };
}
