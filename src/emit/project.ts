/**
 * Project assembly: the whole pipeline, from a WordPress database to a Jx project on disk.
 *
 * {@link migrateSite} loads the site (`site.ts`), converts it in dependency order and writes the
 * project through a {@link Sink}:
 *
 * 1. **Components** (`emit/components.ts`), then **templates** (layouts, template parts, reusable blocks,
 *    the pages of the routes that are not pages), **pages** and **collections**. Each is built one
 *    after another (a conversion shares process-wide state), in a fixed order, so two runs write the
 *    same bytes. The menus are the placeholders the templates and pages replace (`menuResolvers`).
 * 2. **The design system** (`emit/design-system.ts`) over the site's global CSS, **the compatibility
 *    stylesheet** (the plugin's own CSS and the theme's `style.css`, linked first in `$head`), and the
 *    **core block CSS** of exactly the WordPress classes the converted markup carries.
 * 3. **`project.json`**: `name`, `url`, `defaults {layout, lang}`, `$media`, `style`, `$head`, `content`,
 *    `redirects`, `extensions`, `images` (only for a site with more than {@link HEAVY_IMAGE_COUNT}
 *    images, or when the caller gives one) and `build`.
 * 4. **Media** (`media.ts`): the files the converted content actually asked for, and the local fonts.
 * 5. **The report**: every module's findings merged in a stable order, with the migration's own, as
 *    `migration-report.md` (a section of decisions for the site owner on top) and `migration-report.json`.
 *
 * ## The order of `project.json`'s `style`
 *
 * Jx writes the project `style` as one `<style>` AFTER the `$head` links and BEFORE every element's own
 * rules, so the order a page ends up with is: the compatibility sheet, the global rules (`ds.style`),
 * the core block rules, the hoisted rules (the ones no element's own `style` could hold). Where a later
 * source has a selector an earlier one already has, its declarations are merged into that entry (later
 * values win, in place), because a second entry under the same key does not exist in an object; the
 * merge is said (`project.style-merged`). The WordPress block library's own sheet comes AFTER the
 * post's CSS on the live site and BEFORE it here (project style precedes element style): a class of a
 * core block and a class of a Cwicly block disagree about one property of one element only where an
 * author styled a core block by hand, and the block's own class wins that tie here as it should.
 * Presets (`--wp--preset--*`, `.has-<slug>-color`) are NOT shipped unless asked for (`presets`): the
 * live sites do not serve them, so a faithful copy does not invent them.
 *
 * ## Writing
 *
 * Files are written through the sink in path order and only when their bytes differ from what the sink
 * already holds, so a second run over the same site touches nothing. `.wp2jx-manifest.json` lists every
 * file this tool wrote with its hash, and the public address of the site they were made from. A file
 * the manifest names that a later run no longer produces is removed, unless it was edited since (its
 * hash moved): then it stays and is said (`project.stale-kept`). A file the manifest does not name is
 * never removed, and that includes a media file that was already there when the run met it. A file the
 * run produces again that was edited since is overwritten and said (`project.edited-overwritten`).
 * Removal happens before `jx` is run, so verification judges the files the run leaves behind. A
 * manifest of another site refuses the run before it writes anything (`force` replaces it,
 * `project.site-changed`). If a write fails, what was written so far is recorded in the manifest
 * before the error is thrown, naming the file. The disk sink is atomic per file (a temporary file in
 * the same directory, then a rename) and refuses any path that would leave the output directory,
 * lexically or through a symlink.
 *
 * ## What is not generated from the site
 *
 * - **`package.json`** (the starters' shape: the `jx` scripts, the compiler and runtime, `@jxsuite/parser`
 *   when there are collections) is written once and never again, and is not in the manifest: it is where
 *   a person adds what the site needs next. A project outside this repository needs it, and a
 *   `bun install` (`verify.install`), before `jx build` can resolve `@jxsuite/parser`; without that the
 *   build warns `prototype-resolver: failed to resolve …` and ships every content page empty. One that
 *   was already there is read, and what it lacks is said (`project.package-missing-parser`,
 *   `project.package-missing-jx`, `project.package-unreadable`).
 * - **`.gitignore`** (`dist/`, `node_modules/` and the image cache `.cache/`) is a seed too: nothing in
 *   it comes from the site, and what a person adds to it (`.env`) must outlive a re-run.
 * - **The public address** is `siteUrl` (the live address), else the `home` option: the `url` of
 *   `project.json` and the base of every canonical. The `siteurl` option, where WordPress itself lives,
 *   only says where to fetch files from.
 * - **The site icon** (`site_icon`, an attachment) is `icon` and `apple-touch-icon` links in `$head`.
 * - **Sources nobody named are the live site's.** `cssFrom`, `pluginFrom` and (through it) `wpFrom`
 *   default to `siteUrl`, else the `siteurl` option, because that is where Cwicly's stylesheets, the
 *   plugin's files, the theme's `style.css` and `wp-includes` are served; `false` for `pluginFrom` and
 *   `wpFrom` leaves them out and says so.
 *
 * ## Dry run
 *
 * `dryRun` converts and writes everything except media: nothing is fetched, and the files that would
 * have been are counted in the report (`media.not-downloaded`). A run with no sink and `dryRun` writes
 * nothing at all. `media: false` leaves the media out entirely (`media.skipped`).
 *
 * ## Verifying a build of a media-heavy site
 *
 * `verify.build` runs `jx build`, which encodes every image the pages use with Sharp. The limit it is
 * given is `verify.jx.timeoutMs`, else half an hour or {@link buildTimeoutFor} of the media the pages
 * use, whichever is more, and the build's own lines are progress events of the `verify` phase
 * (`jx build: optimising images: 250 so far (now photo.jpg)`).
 *
 * Report codes of this module: `project.stage-failed`, `project.css-missing`, `project.compat-missing`,
 * `project.core-css-skipped`, `project.core-css-failed`, `project.style-merged`,
 * `project.redirect-shadowed`, `project.ref-missing`, `project.json-invalid`, `project.file-collision`,
 * `project.file-invalid`, `project.site-icon-missing`, `project.manifest-unreadable`,
 * `project.stale-kept`, `project.edited-overwritten`, `project.site-changed`,
 * `project.media-not-adopted`, `project.package-missing-parser`, `project.package-missing-jx`,
 * `project.images-formats`, `project.package-unreadable`, `url.redirected` (an unresolved address that a carried redirect
 * answers; one the migrated site serves is no finding), `media.not-downloaded`, `media.skipped`, `media.local-missing`,
 * `media.font-unresolved`, plus everything every module reports.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import {
  coreBlockStyle,
  wpCoreCssSources,
  wpPresetCss,
  wpThemeJsonLayers,
} from "../core/block-css.ts";
import type { CssSourceText } from "../core/block-css.ts";
import { parseCwiclyCss } from "../cwicly/css.ts";
import { ensureConverters } from "../convert.ts";
import { downloadMedia, type DownloadResult, type FetchLike, type MediaFile } from "../media.ts";
import { createReport, renderReportJson, renderReportMarkdown, summarise } from "../report.ts";
import type { ReportSummary } from "../report.ts";
import { pathKey } from "../routes.ts";
import {
  allSubjects,
  importedStyleRules,
  loadSiteContext,
  subjectBlocks,
  type HoistedRule,
  type LoadSiteOptions,
  type SiteContext,
  type Subject,
} from "../site.ts";
import type { JxHeadEntry } from "@jxsuite/schema/types";
import type { JxStyle, Report, ReportEntry, Severity, Sink, WpBlock } from "../types.ts";
import { walkBlocks } from "../wp/blocks.ts";
import { openDb } from "../wp/db.ts";
import { decodeEntities } from "../wp/model.ts";
import {
  additionalCssFor,
  buildDesignSystem,
  collectFontImports,
  type DesignSystem,
} from "./design-system.ts";
import { imageCompareStylesheet } from "../core/image-compare.ts";
import { fluentFormStylesheet, TURNSTILE_SCRIPT, usedForms } from "./fluentform.ts";
import { geoMapStylesheet, usedGeoMaps } from "./geomap.ts";
import { buildCompatCss, compatFeaturesForBlocks, type CompatCss } from "./compat-css.ts";
import { buildComponents, type ComponentsOutput } from "./components.ts";
import { collectClassStyles } from "./class-styles.ts";
import { buildCollections, type CollectionsOutput } from "./collections.ts";
import { CURRENT_PAGE_SCRIPT, menuResolvers, newUsed as newMenusUsed } from "./menus.ts";
import { buildPages, type PagesOutput } from "./pages.ts";
import { markNoOptimize, undecodableImage } from "./no-optimize.ts";
import { buildRedirects, type RedirectBuild, type RedirectTarget } from "./redirects.ts";
import { buildTemplates, layoutFor, type TemplatesOutput } from "./templates.ts";
import {
  addIssues,
  buildProgress,
  buildProject,
  buildTimeoutFor,
  installDependencies,
  validateProject,
  type JxOptions,
} from "../jx.ts";

// ── Contract ─────────────────────────────────────────────────────────────────────────────────────

/**
 * How many raster images a site's content may use before its `project.json` asks Jx for WebP alone.
 *
 * Jx encodes every image it ships in WebP and in AVIF, at up to five widths, one image after the
 * other. Measured on the pilot (finelinepainting: 749 raster images, 421 MB, 3,427 variants of each
 * format, 48 cores, load 9): `jx build` takes 2 min with `images.formats: ["webp"]` and 44 min with
 * Jx's default, and a sample of the same images encodes in 65 ms a variant as WebP and 1.5 s as AVIF,
 * about 25 times as long. Up to this many images the default build stays in single-digit minutes, so
 * the migration leaves Jx's own settings alone; above it, it writes the lighter formats and says so
 * (`project.images-formats`). {@link MigrateOptions.images} overrides either way.
 */
export const HEAVY_IMAGE_COUNT = 100;

/**
 * The `images` of `project.json` for a site whose content uses `rasterImages` images: what the caller
 * gave (`{}` meaning none), else WebP alone above {@link HEAVY_IMAGE_COUNT}, else nothing (Jx's own).
 */
export function imageSettings(
  rasterImages: number,
  given?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (given !== undefined) return Object.keys(given).length > 0 ? given : undefined;
  return rasterImages > HEAVY_IMAGE_COUNT ? { formats: ["webp"] } : undefined;
}

/** The `.gitignore` a project starts with: the build, the packages, and the image cache a Bun-only machine keeps in the project. */
export const GITIGNORE = "dist/\nnode_modules/\n.cache/\n";

/** Where the manifest of what this tool wrote lives, relative to the project. */
export const MANIFEST_PATH = ".wp2jx-manifest.json";
export const REPORT_MD_PATH = "migration-report.md";
export const REPORT_JSON_PATH = "migration-report.json";
/** The script that marks the link of the current page in a `cc-menu` list (`menus.ts`). */
export const CURRENT_PAGE_JS_PATH = "public/js/wp2jx-current-page.js";
/** The core block rules a style object cannot carry, as CSS text. */
export const CORE_CSS_PATH = "public/css/wp-core-blocks.css";
/** Files every run writes after the stale ones are judged: never stale. */
const OWN_FILES: ReadonlySet<string> = new Set([MANIFEST_PATH, REPORT_MD_PATH, REPORT_JSON_PATH]);

/**
 * Where a project is written. `write` is all a conversion needs; the optional members let a run be
 * incremental (compare with what is there, remove what a previous run wrote and this one no longer
 * does).
 */
export interface ProjectSink extends Sink {
  /** The bytes of a file, or undefined when there is none. */
  read?(path: string): Promise<Uint8Array | undefined>;
  exists?(path: string): Promise<boolean>;
  remove?(path: string): Promise<void>;
}

export interface MemoryProjectSink extends ProjectSink {
  files: Map<string, string | Uint8Array>;
}

export interface MigrateProgress {
  phase:
    | "load"
    | "components"
    | "templates"
    | "pages"
    | "collections"
    | "design"
    | "core-css"
    | "redirects"
    | "media"
    | "write"
    | "verify"
    | "report";
  message: string;
  done?: number;
  total?: number;
}

export interface MigrateOptions {
  /** `mysql://user:pass@host:port/db` or `sqlite:<file>`. Not needed when `site` is given. */
  db?: string;
  prefix?: string;
  /** The live address when it differs from the `siteurl` option (a staging copy): uploads are resolved against it as well. */
  siteUrl?: string;
  /** Cwicly's generated stylesheets: an uploads folder, the live site, or both. Default: the live site (`siteUrl`, else the `siteurl` option). */
  cssFrom?: LoadSiteOptions["cssFrom"];
  /**
   * The plugin's files and the theme's `style.css`: a site checkout, the Cwicly repository, or a live
   * site's address. Default: the live site. `false`: none (the structural classes then have no styles,
   * which the report says).
   */
  pluginFrom?: string | false;
  /**
   * A WordPress root (a directory with `wp-includes`, or a live site's address) for the core block
   * library's stylesheets. Default: `pluginFrom` when it has a `wp-includes` or is an address.
   * `false`: none.
   */
  wpFrom?: string | false;
  componentPrefix?: string;
  /** Post types to convert besides pages, templates and the other structural ones. Default: every published type. */
  postTypes?: string[];
  routeTypes?: LoadSiteOptions["routeTypes"];
  /** An already loaded site (a test's, or a caller that loaded it once). */
  site?: SiteContext;

  /** The output directory (an on-disk sink). */
  out?: string;
  /** Any other sink. With neither, nothing is written (a dry run with a report). */
  sink?: ProjectSink;

  /**
   * Write into an output directory that holds the project of another site (its manifest names a
   * different address), removing what this run no longer produces. Without it the run refuses, before
   * it writes anything.
   */
  force?: boolean;
  /** Convert and write everything except media: nothing is fetched. */
  dryRun?: boolean;
  /** `false` leaves media out entirely. Default true. */
  media?: boolean;
  /**
   * The `images` of `project.json` (Jx's `ImageConfig`: `formats`, `widths`, `quality`, `optimize`…),
   * written as given; `{}` writes none, so Jx's own settings apply. Default: Jx's own settings for a
   * site whose content uses up to {@link HEAVY_IMAGE_COUNT} raster images, and WebP only above that
   * (`{"formats": ["webp"]}`, reported as `project.images-formats`), because AVIF is what makes a
   * build of hundreds of images take most of an hour.
   */
  images?: Record<string, unknown>;
  /** Where the media comes from instead of the site: a local uploads folder or an address. */
  uploads?: string;
  fetch?: FetchLike;
  concurrency?: number;
  /** Ship the WordPress preset styles (`--wp--preset--*`, `.has-<slug>-color`), which the live sites do not serve. Default false. */
  presets?: boolean;
  /** Drop the compatibility stylesheet's rules for classes no converted markup carries. Default false. */
  pruneCompat?: boolean;
  inlineGaps?: "report" | "innerHTML";
  /** The clock Rank Math's `%currentyear%` and kin read; one for the whole run. Default: now. */
  now?: Date;
  /** Run `jx validate` / `jx build` in the output directory and put what they say in the report. Needs `out`. */
  verify?: {
    /** `bun install` in the output first, so the packages its `package.json` names can be resolved. */
    install?: boolean;
    /** The install command, when it is not Bun's own (`bun install`). */
    installCmd?: readonly string[];
    validate?: boolean;
    build?: boolean;
    strict?: boolean;
    jx?: JxOptions;
  };
  progress?: (event: MigrateProgress) => void;
  /** Findings of the load (a caller that made the site itself passes its report). */
  report?: Report;
}

/** One thing the site owner has to decide, derived from the report. */
export interface Decision {
  id: string;
  title: string;
  /** What the owner is asked. */
  question: string;
  /** How many report entries it covers. */
  count: number;
  /** Up to ten examples, as `where` or `address` texts. */
  examples: string[];
  /** Which codes it was drawn from. */
  codes: string[];
}

export interface MigrationResult {
  /** The `project.json` object. */
  project: Record<string, unknown>;
  /** Project-relative paths, by what happened to them in this run. */
  files: {
    /** New or changed. */
    written: string[];
    unchanged: string[];
    /** Stale files a previous run wrote, removed. */
    removed: string[];
    /** Stale files that were edited since and so kept. */
    kept: string[];
  };
  /** Every module's findings, deduplicated, in a stable order. */
  report: ReportEntry[];
  summary: ReportSummary;
  decisions: Decision[];
  media: {
    /** Files the converted content asked for (and fonts). */
    planned: number;
    downloaded: number;
    skipped: number;
    failed: number;
    bytes: number;
  };
  counts: {
    pages: number;
    entries: number;
    collections: number;
    components: number;
    layouts: number;
    redirects: number;
    files: number;
  };
  /** Milliseconds per phase (not part of any written file). */
  timings: Record<string, number>;
  /** `jx validate` / `jx build`, when asked for. */
  verify?: {
    install?: { ok: boolean; ms: number };
    validate?: { ok: boolean; issues: number; ms: number };
    build?: {
      ok: boolean;
      issues: number;
      ms: number;
      /** The limit the build ran under. */
      timeoutMs: number;
      routes?: number;
      files?: number;
    };
  };
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const bytesOf = (data: string | Uint8Array): Uint8Array =>
  typeof data === "string" ? new TextEncoder().encode(data) : data;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && Buffer.compare(a, b) === 0;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Text order that reads `post:9` before `post:10`, with no locale in it (the same on every machine). */
export function naturalCompare(a: string, b: string): number {
  const x = a.match(/\d+|\D+/g) ?? [];
  const y = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!;
    const q = y[i]!;
    if (p === q) continue;
    const numeric = /^\d/.test(p) && /^\d/.test(q);
    if (numeric) {
      const d = Number(p) - Number(q);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    return cmp(p, q);
  }
  return x.length - y.length;
}

const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** `JSON.stringify` that survives what a report's free-form `data` may hold. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return String(value);
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ── Paths and sinks ──────────────────────────────────────────────────────────────────────────────

/**
 * A project-relative path as the sinks accept it: forward slashes, no `.` or `..` segment, no empty
 * one, not absolute, no NUL or backslash. Throws otherwise: such a path is a bug in the emitter, and
 * writing it would leave the project.
 */
export function checkProjectPath(path: string): string {
  const bad = (why: string): never => {
    throw new Error(`refusing to write ${JSON.stringify(path)}: ${why}`);
  };
  if (path === "") return bad("the path is empty");
  if (path.includes("\0")) return bad("the path holds a NUL");
  if (path.includes("\\")) return bad("the path holds a backslash");
  if (path.startsWith("/") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    return bad("the path is absolute");
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return bad("the path leaves the project or is not normalised");
    }
  }
  return path;
}

let tempCounter = 0;

/**
 * A sink over a directory. Every write goes to a temporary file in the same directory and is renamed
 * into place, so a reader (or a crash) sees the old file or the new one, never half of one. The path
 * must stay inside the directory both as written and after symlinks are resolved. The directory is
 * created on the first write.
 */
export function diskSink(dir: string): ProjectSink & { readonly root: string } {
  const root = resolve(dir);
  const target = (path: string): string => {
    checkProjectPath(path);
    const full = resolve(root, ...path.split("/"));
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`refusing to write ${JSON.stringify(path)}: it is outside ${root}`);
    }
    return full;
  };
  /** The directory exists and really is inside the root (a symlink inside the project cannot lead out). */
  const safeParent = async (full: string): Promise<void> => {
    await mkdir(dirname(full), { recursive: true });
    const rootReal = await realpath(root);
    const parentReal = await realpath(dirname(full));
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
      throw new Error(`refusing to write ${full}: its directory leads outside ${rootReal}`);
    }
  };
  return {
    root,
    async write(path, data) {
      const full = target(path);
      await safeParent(full);
      const temp = `${full}.${process.pid}.${tempCounter++}.wp2jx-tmp`;
      try {
        await writeFile(temp, data);
        await rename(temp, full);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    async read(path) {
      try {
        return new Uint8Array(await readFile(target(path)));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
        throw error;
      }
    },
    async exists(path) {
      try {
        return (await stat(target(path))).isFile();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return false;
        throw error;
      }
    },
    async remove(path) {
      const full = target(path);
      await rm(full, { force: true });
      // The directories it leaves empty go too, up to (never including) the root.
      for (let dirPath = dirname(full); dirPath !== root && dirPath.startsWith(root + sep);) {
        try {
          await rmdir(dirPath);
        } catch {
          break;
        }
        dirPath = dirname(dirPath);
      }
    },
  };
}

/** A sink in memory, for tests and for a run that writes nothing. */
export function memorySink(): MemoryProjectSink {
  const files = new Map<string, string | Uint8Array>();
  return {
    files,
    async write(path, data) {
      files.set(checkProjectPath(path), data);
    },
    async read(path) {
      const found = files.get(path);
      return found === undefined ? undefined : bytesOf(found);
    },
    async exists(path) {
      return files.has(path);
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

// ── Secrets ──────────────────────────────────────────────────────────────────────────────────────

/** The password inside a database URL (`mysql://user:PASSWORD@host/db`), and the `?password=` forms. */
export function dbSecrets(url: string): string[] {
  const secrets: string[] = [];
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^?#]*)@/i.exec(url)?.[1];
  if (authority !== undefined) {
    const colon = authority.indexOf(":");
    if (colon !== -1) {
      const password = authority.slice(colon + 1);
      if (password !== "") secrets.push(password, safeDecode(password));
    }
  }
  for (const m of url.matchAll(/[?&;](?:password|passwd|pwd|pass)=([^&#;]*)/gi)) {
    if (m[1]) secrets.push(m[1], safeDecode(m[1]));
  }
  return [...new Set(secrets.filter((s) => s !== ""))];
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A database URL with its password masked, for anything a person reads. */
export function redactDbUrl(url: string): string {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url)?.[0] ?? "";
  const rest = url.slice(scheme.length).replace(/^([^:/?#@]*):[\s\S]*@/, "$1:***@");
  return `${scheme}${rest}`.replace(/([?&;](?:password|passwd|pwd|pass)=)[^&#;]*/gi, "$1***");
}

const WORD = /[A-Za-z0-9]/;

/**
 * `text` with every secret replaced. A secret is matched as a whole token where its ends are letters
 * or digits: a password that is an ordinary word (`page`, `post`) must mask the password, not the
 * `pages` or `posts` around it. (A secret that ends in a symbol has no such ambiguity and is matched
 * anywhere.) One shorter than three characters would mask ordinary text and is left alone.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 3) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = WORD.test(secret[0]!) ? "(?<![A-Za-z0-9])" : "";
    const after = WORD.test(secret[secret.length - 1]!) ? "(?![A-Za-z0-9])" : "";
    out = out.replace(new RegExp(`${before}${escaped}${after}`, "g"), "***");
  }
  return out;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (isRec(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, secrets)]));
  }
  return value;
}

/** A location with its kind (`post:`, `template:`, `file:`) left alone: the kind is structure, what follows may be anything. */
function redactWhere(where: string, secrets: readonly string[]): string {
  const kind = /^[A-Za-z][\w-]*:/.exec(where)?.[0] ?? "";
  return `${kind}${redactText(where.slice(kind.length), secrets)}`;
}

/**
 * An entry with the secrets masked out of what a person reads: the message, the address, the data and
 * the location's subject. The code and the severity are the report's own vocabulary, which the
 * decisions and every consumer match on, and a database password that is a common word must not
 * rewrite them (`page.password-protected` became `page.***-protected`).
 */
export function redactEntry(entry: ReportEntry, secrets: readonly string[]): ReportEntry {
  if (secrets.length === 0) return entry;
  return {
    ...entry,
    message: redactText(entry.message, secrets),
    ...(entry.where === undefined ? {} : { where: redactWhere(entry.where, secrets) }),
    ...(entry.url === undefined ? {} : { url: redactText(entry.url, secrets) }),
    ...(entry.data === undefined
      ? {}
      : { data: redactValue(entry.data, secrets) as Record<string, unknown> }),
  };
}

// ── The merged report ────────────────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/**
 * Every module's entries as one list: exact duplicates (the same finding reached through two
 * emitters) once, in an order that does not depend on which module ran first: severity, code,
 * location (numbers in natural order), address, message, data. Secrets are masked last (`redactEntry`),
 * so they cannot change what is an exact duplicate or where an entry sorts; a caller that derives
 * anything from the entries (the owner's decisions) merges with none and masks after.
 */
export function mergeReports(
  parts: readonly (Report | readonly ReportEntry[])[],
  secrets: readonly string[] = [],
): ReportEntry[] {
  const seen = new Set<string>();
  const out: ReportEntry[] = [];
  for (const part of parts) {
    const entries = Array.isArray(part) ? part : (part as Report).entries();
    for (const entry of entries as readonly ReportEntry[]) {
      const key = safeStringify([
        entry.severity,
        entry.code,
        entry.message,
        entry.where,
        entry.url,
        entry.data,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  const keyed = out.map((entry) => ({ entry, data: safeStringify(entry.data ?? null) }));
  keyed.sort(
    (a, b) =>
      SEVERITY_RANK[a.entry.severity] - SEVERITY_RANK[b.entry.severity] ||
      cmp(a.entry.code, b.entry.code) ||
      naturalCompare(a.entry.where ?? "", b.entry.where ?? "") ||
      naturalCompare(a.entry.url ?? "", b.entry.url ?? "") ||
      cmp(a.entry.message, b.entry.message) ||
      cmp(a.data, b.data),
  );
  const merged = keyed.map((k) => k.entry);
  return secrets.length === 0 ? merged : merged.map((entry) => redactEntry(entry, secrets));
}

// ── What the site owner has to decide ────────────────────────────────────────────────────────────

interface DecisionSpec {
  id: string;
  title: string;
  question: string;
  codes: readonly string[];
  /** What one entry is an example of; default its location. Several keys when one entry names several things. */
  keys?: (entry: ReportEntry) => string[] | string | undefined;
  /** How many things the entry stands for (a count it carries); default one. */
  weight?: (entry: ReportEntry) => number | undefined;
  /** Two entries that report one thing (one per code) keep the larger count (`max`) instead of adding up (`sum`, the default). */
  combine?: "sum" | "max";
  /** The example's text from its key and what was found. */
  label?: (key: string, found: { places: number; weight: number; codes: string[] }) => string;
}

const dataText = (entry: ReportEntry, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = entry.data?.[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
};

const dataNumber = (entry: ReportEntry, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = entry.data?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
};

/** What a placeholder or an unsupported block stands for: `shortcode [fluentform]`, `block icb/image-compare`. */
function placeholderKeys(entry: ReportEntry): string[] {
  const kind = dataText(entry, "kind");
  const shortcode = dataText(entry, "shortcode");
  const block = dataText(entry, "block");
  const blocks = entry.data?.blocks;
  if (Array.isArray(blocks) && blocks.length > 0) return blocks.map((b) => `block ${String(b)}`);
  if (kind === "search") return ["search form"];
  const form = entry.data?.form;
  if (typeof form === "number") {
    const name = dataText(entry, "title") ?? form;
    return [
      entry.code === "form.missing"
        ? `Fluent Forms form ${name} (not in the database)`
        : `Fluent Forms form ${name} (drawn, not submittable)`,
    ];
  }
  const map = entry.data?.map;
  if (typeof map === "number") {
    const name = dataText(entry, "title") ?? map;
    return [
      entry.code === "map.missing"
        ? `Interactive Geo Maps map ${name} (not in the database)`
        : `Interactive Geo Maps map ${name} (an empty stage, no map)`,
    ];
  }
  if (shortcode !== undefined) return [`shortcode [${shortcode}]`];
  if (kind === "shortcode") return [`shortcode ${dataText(entry, "name") ?? "(unnamed)"}`];
  if (block !== undefined) return [`block ${block}`];
  return [dataText(entry, "tag", "name") ?? entry.where ?? entry.code];
}

const plainLabel = (key: string, found: { places: number }): string =>
  found.places > 1 ? `${key} (${found.places})` : key;

const DECISIONS: readonly DecisionSpec[] = [
  {
    id: "post-types",
    title: "Post types that were not migrated",
    question:
      "Does the new site need them? A plugin's post type has no address the tool can know: describe its rewrite rule (the routeTypes option) to migrate it, or confirm it stays behind.",
    codes: ["collection.unrouted", "route.unregistered", "site.post-type-excluded"],
    keys: (e) => dataText(e, "type"),
    weight: (e) => dataNumber(e, "count", "rows"),
    combine: "max",
    label: (key, f) => `${key}: ${f.weight} post${f.weight === 1 ? "" : "s"}`,
  },
  {
    id: "not-public",
    title: "Content left out because it is not public",
    question:
      "Only published, unprotected content is carried over. Publish what belongs on the new site and run the migration again, or confirm the rest stays behind.",
    codes: [
      "collection.excluded",
      "collection.protected",
      "page.unpublished",
      "page.password-protected",
      "template.skipped",
    ],
    keys: (e) => {
      const type =
        dataText(e, "type") ?? (e.code.startsWith("page.") ? "page" : "template or part");
      const status =
        e.code.endsWith("protected") || e.code.endsWith("password-protected")
          ? "password protected"
          : (dataText(e, "status", "why") ?? "unpublished");
      return `${type}, ${status}`;
    },
    weight: (e) => dataNumber(e, "count", "ids") ?? 1,
    label: (key, f) => `${f.weight} × ${key}`,
  },
  {
    id: "conditions",
    title: "Display conditions a static site cannot decide",
    question:
      "These blocks are shown to every visitor (or hidden for one, as the entry says). Decide whether each should go, or be replaced by something the visitor's browser can decide.",
    codes: [
      "condition.dropped",
      "condition.approximated",
      "template.condition-unsupported",
      "template.condition-approximated",
    ],
    keys: (e) => `${e.where ?? "site"}: ${dataText(e, "token", "condition") ?? e.code}`,
  },
  {
    id: "placeholders",
    title: "Forms, shortcodes and blocks with no static form",
    question:
      "Each stands where it was as a visible neutral element, or was left out (a block of a plugin the site no longer has prints nothing on the live site, and nothing here). Choose a replacement per type (a form service, an embed, a script).",
    codes: [
      "page.placeholder-neutral",
      "template.placeholder-neutral",
      "component.placeholder-neutral",
      "placeholder.unresolved",
      "entry.placeholder-dropped",
      "block.unsupported",
      "block.unregistered",
      "block.shortcode",
      "form.not-submittable",
      "form.element-unsupported",
      "form.missing",
      "form.css-missing",
      "form.load-failed",
      "map.not-interactive",
      "map.missing",
      "map.css-missing",
    ],
    keys: placeholderKeys,
    label: (key, f) => `${key}: ${f.places} place${f.places === 1 ? "" : "s"}`,
  },
  {
    id: "behaviours",
    title: "Behaviour that is not ported",
    question:
      "Animations, tabs, sliders, lightboxes and similar scripts are not carried over; the markup falls back to something plain. Decide which ones the new site still needs.",
    codes: [
      "interaction.dropped",
      "interaction.approximated",
      "link.unsupported",
      "template.shortcode-dropped",
      "page.shortcode-dropped",
    ],
    keys: (e) =>
      dataText(e, "feature", "interaction", "action", "block", "kind", "shortcode") ?? e.where,
    label: (key, f) => `${key}: ${f.places} place${f.places === 1 ? "" : "s"}`,
  },
  {
    id: "urls",
    title: "Addresses the new site has no page for",
    question:
      "A link or reference points at a page that does not exist on the migrated site. Point it at an existing page, add the page, or remove the link.",
    codes: ["url.unresolved", "link.unresolved"],
    keys: (e) => dataText(e, "url", "token") ?? e.url ?? e.where,
    label: (key, f) => `${key}: ${f.places} place${f.places === 1 ? "" : "s"}`,
  },
  {
    id: "markdown",
    title: "Entries the Markdown could not carry faithfully",
    question:
      "Each entry reads back differently from what was written. Open them and fix the text by hand, or accept the difference.",
    codes: ["md.lossy", "md.frontmatter-mismatch", "entry.failed", "entry.schema-invalid"],
  },
  {
    id: "redirects",
    title: "Redirects that were dropped or need a look",
    question:
      "A redirect that leads nowhere, loops, or hides a live page was not carried over unchanged, and a page that a redirect hides (as it did on the source site) was not written. Point each at an existing page, or delete the rule, to bring it back.",
    codes: [
      "redirect.dangling",
      "redirect.unsupported",
      "redirect.shadowed",
      "redirect.supersedes-page",
      "redirect.loop",
      "redirect.wildcard-overlap",
      "project.redirect-shadowed",
    ],
    keys: (e) => dataText(e, "source") ?? e.where,
    label: (key, f) =>
      `${key} (${f.codes.map((c) => c.replace(/^(?:project\.)?redirect[.-]/, "")).join(", ")})`,
  },
  {
    id: "images",
    title: "Image formats of the build",
    question:
      "The project asks Jx for WebP only, because AVIF takes most of an hour to encode for this many images. Convert again with --image-formats webp,avif for the smaller files, if that wait is acceptable (project.json is regenerated by every run, so an edit to it does not last).",
    codes: ["project.images-formats"],
    keys: () => "project.json",
    weight: (e) => dataNumber(e, "images"),
    combine: "max",
    label: (key, f) => `${key}: ${f.weight} images, WebP only`,
  },
  {
    id: "undecodable",
    title: "Pictures the image optimiser cannot read",
    question:
      "The build cannot resize these (a phone's HEIC saved under a .jpg name, for one): they are served as they are, and most browsers cannot show a HEIC at all. Replace each with a JPEG or PNG in the media library and convert again.",
    codes: ["media.undecodable"],
    keys: (e) => dataText(e, "file") ?? e.where,
    label: (key, f) => `${key}: ${f.places} place${f.places === 1 ? "" : "s"}`,
  },
  {
    id: "media",
    title: "Files that could not be fetched",
    question:
      "These files are referenced by the migrated pages and are missing from the project. Provide them (the uploads option), or remove the references.",
    codes: [
      "media.download-failed",
      "media.local-missing",
      "dynamic.missing-image",
      "media.font-unresolved",
    ],
    keys: (e) =>
      e.data?.id === undefined
        ? (dataText(e, "file") ?? e.where)
        : `attachment ${String(e.data.id)}`,
    label: (key, f) => `${key}: ${f.places} place${f.places === 1 ? "" : "s"}`,
  },
];

/** The report's entries drawn into the questions only a person can answer. A question nothing raised is left out. */
export function ownerDecisions(entries: readonly ReportEntry[]): Decision[] {
  const out: Decision[] = [];
  for (const spec of DECISIONS) {
    const mine = entries.filter((e) => spec.codes.includes(e.code));
    if (mine.length === 0) continue;
    const found = new Map<string, { places: Set<string>; weight: number; codes: Set<string> }>();
    for (const e of mine) {
      const raw = spec.keys?.(e) ?? e.where ?? e.code;
      const keys = Array.isArray(raw) ? raw : [raw];
      const w = spec.weight?.(e);
      for (const key of keys) {
        const f = found.get(key) ?? {
          places: new Set<string>(),
          weight: 0,
          codes: new Set<string>(),
        };
        f.places.add(e.where ?? `${e.code}:${f.places.size}`);
        f.weight = spec.combine === "max" ? Math.max(f.weight, w ?? 1) : f.weight + (w ?? 1);
        f.codes.add(e.code);
        found.set(key, f);
      }
    }
    const rows = [...found].map(([key, f]) => ({
      key,
      places: f.places.size,
      weight: f.weight,
      codes: [...f.codes].sort(cmp),
    }));
    rows.sort((a, b) => b.weight - a.weight || b.places - a.places || naturalCompare(a.key, b.key));
    out.push({
      id: spec.id,
      title: spec.title,
      question: spec.question,
      count: mine.length,
      examples: rows
        .slice(0, 10)
        .map((r) =>
          (spec.label ?? plainLabel)(r.key, { places: r.places, weight: r.weight, codes: r.codes }),
        ),
      codes: [...new Set(mine.map((e) => e.code))].sort(cmp),
    });
  }
  return out;
}

/** A Markdown code span that survives backticks in the text. */
function span(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  const longest = Math.max(0, ...[...one.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = one.startsWith("`") || one.endsWith("`") ? " " : "";
  return `${fence}${pad}${one}${pad}${fence}`;
}

/** The decisions as a Markdown section. */
export function renderDecisions(decisions: readonly Decision[]): string {
  if (decisions.length === 0) return "";
  const lines = [
    "## Decisions for the site owner",
    "",
    "These are the migration facts that need a person. Each is drawn from the entries below, which have the locations.",
    "",
  ];
  for (const d of decisions) {
    lines.push(`### ${d.title} (${d.count})`, "", d.question, "");
    for (const example of d.examples) lines.push(`- ${span(example)}`);
    if (d.count > d.examples.length && d.examples.length > 0) {
      lines.push(`- Codes: ${d.codes.map(span).join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** The report's Markdown with the decisions placed before the first group of entries. */
export function renderProjectReport(
  entries: readonly ReportEntry[],
  decisions: readonly Decision[],
  site: string,
): string {
  const base = renderReportMarkdown(entries, { site });
  const section = renderDecisions(decisions);
  if (section === "") return base;
  const at = base.search(/^## (?:error|warn|info) \(/m);
  return at === -1 ? `${base}\n${section}` : `${base.slice(0, at)}${section}\n${base.slice(at)}`;
}

// ── The project's style ──────────────────────────────────────────────────────────────────────────

/**
 * At-rules whose key names ONE definition: a second `@keyframes spin` replaces the first in CSS, and a
 * style object has one slot per key.
 */
const REPLACING_AT_RULE =
  /^@(?:-\w+-)?(?:keyframes|property|counter-style|font-palette-values|font-feature-values|position-try|font-face)(?![\w-])/i;

/** `source` over `target` as the cascade reads two rules of one selector: a later property wins and moves to the end, nested blocks merge. */
function mergeDeclarations(target: Rec, source: Rec): void {
  for (const [key, value] of Object.entries(source)) {
    const known = target[key];
    if (isRec(known) && isRec(value)) {
      mergeDeclarations(known, value);
      continue;
    }
    delete target[key];
    target[key] = clone(value);
  }
}

export interface StyleLayer {
  /** Entries keyed by selector, at-rule or custom property. */
  style?: JxStyle | undefined;
  /** Custom properties: set only where the project does not have them already. */
  custom?: Record<string, string> | undefined;
  /** Rules (a selector and its declarations), in order. */
  rules?: readonly { selector: string; style: JxStyle }[] | undefined;
}

/**
 * The project `style`: `base`, then each layer on top, in order. A key a later layer shares with an
 * earlier entry is merged into that entry (later declarations win, in place), identical content is
 * left alone, and the keys that were merged are returned, so the caller can say it.
 */
export function composeStyle(
  base: JxStyle,
  layers: readonly StyleLayer[],
): { style: JxStyle; merged: string[] } {
  const style: Rec = clone(base) as Rec;
  const merged = new Set<string>();
  const put = (key: string, value: unknown): void => {
    const known = style[key];
    if (known === undefined) {
      style[key] = clone(value);
      return;
    }
    if (JSON.stringify(known) === JSON.stringify(value)) return;
    if (isRec(known) && isRec(value) && !REPLACING_AT_RULE.test(key)) {
      mergeDeclarations(known, value);
      merged.add(key);
      return;
    }
    // A scalar (a body declaration) or a replacing at-rule: the later one wins.
    merged.add(key);
    delete style[key];
    style[key] = clone(value);
  };
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.custom ?? {})) {
      if (style[key] === undefined) style[key] = value;
    }
    for (const [key, value] of Object.entries(layer.style ?? {})) put(key, value);
    for (const rule of layer.rules ?? []) put(rule.selector.trim(), rule.style);
  }
  return { style: style as JxStyle, merged: [...merged] };
}

/**
 * The media blocks of the selector entries moved to the project's own conditional blocks, which come in
 * the order of `$media`. Jx writes every selector entry of the project style and only then the top-level
 * `@--md`, `@--sm` blocks, so `.card { @--sm { … } }` of a hoisted rule came BEFORE the design system's
 * and the core rules' `@--md` block: below 576px the rule for 992px (the later one) won every property
 * the two share, where on the live page the narrower query is written after the wider (`.gallery-c1bef94
 * .cc-gallery { repeat(3) }` at 576px lost to `.gallery-default .cc-gallery { repeat(2) }` at 992px, and
 * a gallery of three columns showed two). Written the way Jx reads them, `@--sm: { ".card": { … } }`,
 * the narrow blocks follow the wide ones whoever wrote them.
 */
export function liftMediaBlocks(style: JxStyle, media: readonly string[]): JxStyle {
  const aliases = media.map((name) => `@${name}`);
  const known = new Set(aliases);
  const blocks = new Map<string, Rec>();
  const block = (alias: string): Rec => {
    let found = blocks.get(alias);
    if (found === undefined) blocks.set(alias, (found = {}));
    return found;
  };
  const out: Rec = {};
  for (const [key, value] of Object.entries(style as Rec)) {
    if (known.has(key) && isRec(value)) {
      const into = block(key);
      for (const [name, inner] of Object.entries(value)) {
        const have = into[name];
        if (isRec(have) && isRec(inner)) mergeDeclarations(have, clone(inner) as Rec);
        else {
          delete into[name];
          into[name] = clone(inner);
        }
      }
      continue;
    }
    if (!isRec(value) || key.startsWith("@")) {
      out[key] = value;
      continue;
    }
    const rest: Rec = {};
    for (const [name, inner] of Object.entries(value)) {
      if (known.has(name) && isRec(inner)) {
        const into = block(name);
        const have = into[key];
        if (isRec(have)) mergeDeclarations(have, clone(inner) as Rec);
        else into[key] = clone(inner);
      } else rest[name] = inner;
    }
    // A selector with nothing but media blocks has no rule of its own left.
    if (Object.keys(rest).length > 0 || Object.keys(value).length === 0) out[key] = rest;
  }
  for (const alias of aliases) {
    const found = blocks.get(alias);
    if (found !== undefined && Object.keys(found).length > 0) out[alias] = found;
  }
  return out as JxStyle;
}

/**
 * The files of the pages and entries whose address a Rank Math redirect answers (`redirect.supersedes-page`):
 * those are not written, the redirect is. `supersedes` are the addresses; a page or entry is named by its route.
 */
export function supersededFiles(
  supersedes: readonly string[],
  pages: readonly { route: string; file: string }[],
  entries: readonly { route: string; file: string }[],
): Set<string> {
  const hidden = new Set(supersedes.map(pathKey));
  return new Set(
    [...pages, ...entries].filter((p) => hidden.has(pathKey(p.route))).map((p) => p.file),
  );
}

/** A heading an entry writes with a background: `:::h2{className="wp-block-heading ... has-background"}` (or the `###`-less directive form). */
const ENTRY_BACKGROUND_HEADING = /^:{2,}h[1-6]\{[^}\n]*(?<![\w-])has-background(?![\w-])/m;

/**
 * The block library's padding for a heading with a background (`.has-background:is(h2):where(.wp-block-heading)`,
 * 1.25em 2.375em, one class and one element), written once more with `:root` in front for the entries
 * that hold such a heading. The live page prints the library's stylesheet last, so against a template rule of the
 * same specificity (`.content-post h2 { padding: 2rem }`) the library wins; Jx writes the project's style before the
 * page's, so the page's rule won and nine headings of a post kept 32px where the live page has 55px 104px (the text
 * wrapped differently and the post came out 1,800px short at 1366px). One more class puts the library's rule
 * above the page's without reaching for `!important`.
 */
export function entryHeadingRules(
  coreStyle: Readonly<Record<string, unknown>> | undefined,
  entries: readonly { content: string }[],
): HoistedRule[] {
  if (coreStyle === undefined || !entries.some((e) => ENTRY_BACKGROUND_HEADING.test(e.content))) {
    return [];
  }
  const rules: HoistedRule[] = [];
  for (const [selector, value] of Object.entries(coreStyle)) {
    if (!/^\.has-background:is\(h[1-6]\)/.test(selector) || !isRec(value)) continue;
    // Only the declarations: a media block of the rule keeps its place in the library's own entry.
    const declarations = Object.fromEntries(Object.entries(value).filter(([, v]) => !isRec(v)));
    if (Object.keys(declarations).length === 0) continue;
    rules.push({
      selector: selector
        .split(",")
        .map((part) => `:root ${part.trim()}`)
        .join(", "),
      style: declarations as JxStyle,
    });
  }
  return rules;
}

/** `pages` without the pages whose address a Rank Math redirect answers (the redirect is written there instead); `pages` is edited in place. */
export function withoutSupersededPages(
  supersedes: readonly string[],
  pages: { files: { path: string }[]; pages: { route: string; file: string }[] },
): void {
  const hidden = supersededFiles(supersedes, pages.pages, []);
  if (hidden.size === 0) return;
  pages.files = pages.files.filter((f) => !hidden.has(f.path));
  pages.pages = pages.pages.filter((p) => !hidden.has(p.file));
}

/** The block that holds every rule of a post at once: a query every width meets, so that it is a conditional block and follows the others. */
export const EVERY_WIDTH = "@(min-width: 0px)";

/**
 * `rules` (the rules the posts, templates and documents moved to the project) written after every block
 * of `style`, the design system's conditional blocks included. The live page prints the global classes'
 * stylesheet first, the template's and the post's after it, so a post's `.gallery-c1 .cc-gallery`
 * (three columns) beats the global `.gallery-default .cc-gallery` inside its `@media (max-width: 992px)`
 * at the same specificity. Jx writes every selector entry of the project style and only then the
 * conditional blocks in the order they were written, so a rule in a selector entry came before the
 * design system's `@--md` block and lost to it below 992px (every project gallery showed two columns
 * at 390px where the live page shows three). The rules go in a block of their own, `@(min-width: 0px)`,
 * and their own media blocks in literal blocks of the same queries (`@(max-width: 992px)`), written
 * after it, so each rule still follows its own base. A `$media` name whose query is no parenthesised
 * feature (the `--` base width) has no literal form and is left inside its rule.
 */
export function layerAfterMedia(
  style: JxStyle,
  rules: JxStyle,
  media: Readonly<Record<string, string>>,
): JxStyle {
  const literal = new Map<string, string>();
  for (const [name, query] of Object.entries(media)) {
    if (/^\(.*\)$/.test(query.trim())) literal.set(`@${name}`, `@${query.trim()}`);
  }
  const base: Rec = {};
  const blocks = new Map<string, Rec>();
  const out: Rec = clone(style as Rec);
  for (const [selector, value] of Object.entries(rules as Rec)) {
    if (!isRec(value) || selector.startsWith("@")) {
      // Not a rule that has a place in a block of its own (a custom property, an at-rule): where it was.
      delete out[selector];
      out[selector] = clone(value);
      continue;
    }
    const rest: Rec = {};
    for (const [name, inner] of Object.entries(value)) {
      const key = literal.get(name);
      if (key !== undefined && isRec(inner)) {
        let block = blocks.get(key);
        if (block === undefined) blocks.set(key, (block = {}));
        block[selector] = clone(inner);
      } else rest[name] = clone(inner);
    }
    if (Object.keys(rest).length > 0 || Object.keys(value).length === 0) base[selector] = rest;
  }
  if (Object.keys(base).length > 0) out[EVERY_WIDTH] = base;
  for (const key of literal.values()) {
    const block = blocks.get(key);
    if (block !== undefined) out[key] = block;
  }
  return out as JxStyle;
}

/** Class names a style object's selector keys name (`.has-cc-1-color`), nested keys too, for rules another sheet already styles. */
function classesOfKeys(style: JxStyle): Set<string> {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (!isRec(value)) return;
    for (const [key, inner] of Object.entries(value)) {
      for (const m of key.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) found.add(m[1]!);
      visit(inner);
    }
  };
  visit(style);
  return found;
}

// ── Stages that may fail on their own ────────────────────────────────────────────────────────────

const emptyUsed = () => ({
  components: new Set<string>(),
  wpClasses: new Set<string>(),
  hoisted: [] as { selector: string; style: JxStyle }[],
  documentRules: [] as { selector: string; style: JxStyle }[],
  states: new Set<string>(),
});

const failedComponents = (report: Report): ComponentsOutput => ({
  files: [],
  components: [],
  skipped: [],
  used: emptyUsed(),
  report,
});

const failedTemplates = (report: Report): TemplatesOutput => ({
  files: [],
  layouts: {},
  frames: {},
  base: null,
  pages: [],
  parts: [],
  reusables: [],
  collections: {},
  notFound: null,
  used: { ...emptyUsed(), templates: new Set(), menus: newMenusUsed() },
  report,
});

const failedPages = (report: Report): PagesOutput => ({
  files: [],
  pages: [],
  skipped: [],
  used: emptyUsed(),
  report,
});

const failedCollections = (report: Report): CollectionsOutput => ({
  collections: {},
  files: [],
  entries: [],
  used: { components: new Set(), wpClasses: new Set(), hoisted: [] },
  report,
});

/**
 * Types a model always needs, whatever the caller asks to convert: pages and posts, the block
 * templates, parts and reusable blocks, Cwicly's components, and the ACF definitions that say what the
 * rest are. Everything else is a content type, which `postTypes` chooses.
 */
export const STRUCTURAL_POST_TYPES = [
  "page",
  "post",
  "wp_template",
  "wp_template_part",
  "wp_block",
  "wp_navigation",
  "wp_global_styles",
  "custom_css",
  "cc_block",
  "acf-post-type",
  "acf-taxonomy",
  "acf-field-group",
  "acf-field",
];

const isUrl = (text: string): boolean => /^https?:\/\//i.test(text);

/** `wpFrom`, or the plugin source when it is a WordPress root or a live site. */
function coreCssRoot(
  wpFrom: string | false | undefined,
  pluginFrom: string | undefined,
): string | undefined {
  if (wpFrom === false) return undefined;
  if (wpFrom !== undefined) return wpFrom;
  if (pluginFrom === undefined) return undefined;
  if (isUrl(pluginFrom)) return pluginFrom;
  return existsSync(join(pluginFrom, "wp-includes", "blocks")) ? pluginFrom : undefined;
}

/**
 * Whether the active theme asks for `wp-embed-responsive` on the body: its `functions.php` calls
 * `add_theme_support('responsive-embeds')`. Read from the WordPress root the core CSS is read from (a live
 * site has no source to read, and then an embed keeps the size its markup names).
 */
export function themeSupportsResponsiveEmbeds(
  root: string | undefined,
  theme: string | undefined,
): boolean {
  if (root === undefined || isUrl(root) || theme === undefined || theme === "") return false;
  try {
    const code = readFileSync(join(root, "wp-content", "themes", theme, "functions.php"), "utf8");
    return /\badd_theme_support\(\s*['"]responsive-embeds['"]/.test(code);
  } catch {
    return false;
  }
}

/** The `siteurl` option of a database: where the live site is, when nothing else says. */
export async function readSiteUrl(dbUrl: string, prefix?: string): Promise<string> {
  const db = await openDb(dbUrl, prefix === undefined ? {} : { prefix });
  try {
    const rows = await db.query<{ option_value: unknown }>(
      `select option_value from ${db.table("options")} where option_name = 'siteurl'`,
    );
    const url = String(rows[0]?.option_value ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (url === "") {
      throw new Error(
        "the database has no siteurl option, so the live site's address is unknown: pass siteUrl (--site-url)",
      );
    }
    return url;
  } finally {
    await db.close();
  }
}

const MIME_OF_FONT: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  svg: "image/svg+xml",
};

/** A local font as a file to fetch: the address resolved against the site, the destination the CSS already names. */
export function fontFile(
  font: { url: string; dest: string },
  siteUrl: string,
  uploadsBase: string,
): MediaFile | undefined {
  let source: string;
  try {
    source = isUrl(font.url)
      ? font.url
      : font.url.startsWith("//")
        ? `https:${font.url}`
        : font.url.startsWith("/")
          ? new URL(font.url, `${siteUrl}/`).href
          : new URL(font.url, `${uploadsBase.replace(/\/+$/, "")}/cwicly/local-fonts/`).href;
  } catch {
    return undefined;
  }
  const ext = font.dest.split(".").pop()?.toLowerCase() ?? "";
  return {
    attachmentIds: [],
    sourceUrl: source,
    file: font.dest.replace(/^public\//, ""),
    destPath: font.dest,
    publicPath: `/${font.dest.replace(/^public\//, "")}`,
    mime: MIME_OF_FONT[ext] ?? "",
  };
}

// ── package.json ─────────────────────────────────────────────────────────────────────────────────

/** The version of a package installed beside this tool (a project is built with what it was tested with), as a caret range. */
function installedRange(pkg: string, fallback: string): string {
  for (let dir = import.meta.dir, last = ""; dir !== last; last = dir, dir = dirname(dir)) {
    const file = join(dir, "node_modules", pkg, "package.json");
    if (!existsSync(file)) continue;
    try {
      const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
      if (typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) return `^${version}`;
    } catch {
      // A package.json that does not read is no version: the fallback stands.
    }
  }
  return fallback;
}

/** An npm package name for a site: lower case letters, digits and hyphens. */
const packageName = (siteName: string): string =>
  siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "jx-site";

/**
 * The project's `package.json`, as the starters' are: the `jx` scripts, the compiler and the runtime to
 * build with, and `@jxsuite/parser` when the project has Markdown collections (its `extensions` name
 * it). The versions are the ones this tool was run with. It is written once and never again: a
 * `package.json` is where a person adds what the site needs next.
 */
export function projectPackageJson(siteName: string, hasCollections: boolean): string {
  const dependencies = hasCollections
    ? { "@jxsuite/parser": installedRange("@jxsuite/parser", "^1.8.2") }
    : undefined;
  return jsonText({
    name: packageName(siteName),
    private: true,
    description: `${siteName}, migrated from WordPress by wp2jx`,
    type: "module",
    scripts: { build: "jx build", dev: "jx dev", validate: "jx validate" },
    ...(dependencies === undefined ? {} : { dependencies }),
    devDependencies: {
      "@jxsuite/compiler": installedRange("@jxsuite/compiler", "^4.0.2"),
      "@jxsuite/runtime": installedRange("@jxsuite/runtime", "^4.0.2"),
    },
  });
}

// ── The manifest ─────────────────────────────────────────────────────────────────────────────────

interface Manifest {
  generator: "wp2jx";
  manifest: 1;
  /** The public address of the site the files were made from: a run for another site must not remove them. Absent in manifests older than this field. */
  site?: string;
  /** path → sha256 of what this tool wrote. */
  files: Record<string, string>;
}

function parseManifest(bytes: Uint8Array | undefined): Manifest | "unreadable" | undefined {
  if (bytes === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRec(parsed) || parsed.generator !== "wp2jx" || !isRec(parsed.files)) return "unreadable";
    const files: Record<string, string> = {};
    for (const [path, hash] of Object.entries(parsed.files)) {
      if (typeof hash === "string") files[path] = hash;
    }
    return {
      generator: "wp2jx",
      manifest: 1,
      ...(typeof parsed.site === "string" && parsed.site !== "" ? { site: parsed.site } : {}),
      files,
    };
  } catch {
    return "unreadable";
  }
}

const sortedRecord = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort((a, b) => cmp(a[0], b[0])));

// ── Addresses the migrated site serves ───────────────────────────────────────────────────────────

/**
 * Where a carried redirect sends `address`, when one of the project's redirect sources is it (an
 * exact address, or a `*` / `:param` pattern): the old address still works on the migrated site, by
 * way of the redirect. An address with a query string is never matched: a redirect source is a path.
 */
export function redirectDestination(
  redirects: Readonly<Record<string, RedirectTarget>>,
  address: string,
): string | undefined {
  if (/\?/.test(address.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, ""))) return undefined;
  const segments = pathKey(address).split("/").filter(Boolean);
  const text = segments.join("/");
  for (const [source, target] of Object.entries(redirects)) {
    if (source.includes("?")) continue;
    const wanted = pathKey(source).split("/").filter(Boolean);
    const wild = source.includes("*") || /(?:^|\/):[A-Za-z_]/.test(source);
    let hit = false;
    if (!wild) hit = wanted.join("/") === text;
    else {
      const pattern = source
        .toLowerCase()
        .split("/")
        .filter(Boolean)
        .map((segment) =>
          segment.startsWith(":")
            ? "[^/]+"
            : segment
                .split("*")
                .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                .join(".*"),
        )
        .join("/");
      hit = new RegExp(`^${pattern}$`).test(text);
    }
    if (hit) return typeof target === "string" ? target : target.destination;
  }
  return undefined;
}

/**
 * The report's `url.unresolved` entries for an address the migrated site does serve: one that is the
 * route of a page this run wrote (the search page the templates stage adds is not in the route table
 * the URL tools read) is no finding and goes; one that is a carried redirect's source works through
 * the redirect, and is information, not a page the owner has to make.
 */
export function settleUnresolved(
  entries: readonly ReportEntry[],
  served: ReadonlySet<string>,
  redirects: Readonly<Record<string, RedirectTarget>>,
): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const entry of entries) {
    const address =
      entry.code === "url.unresolved" ? (dataText(entry, "url") ?? entry.url) : undefined;
    if (address === undefined) {
      out.push(entry);
      continue;
    }
    if (!address.includes("?") && served.has(pathKey(address))) continue;
    const destination = redirectDestination(redirects, address);
    if (destination === undefined) {
      out.push(entry);
      continue;
    }
    out.push({
      severity: "info",
      code: "url.redirected",
      message: `This address has no page on the migrated site, but a carried redirect sends it to ${destination}: the link works, by way of the redirect (point the link at ${destination} to save the hop).`,
      ...(entry.where === undefined ? {} : { where: entry.where }),
      ...(entry.url === undefined ? {} : { url: entry.url }),
      data: { ...entry.data, destination },
    });
  }
  return out;
}

// ── References between the files ─────────────────────────────────────────────────────────────────

/**
 * Every `$ref` to a project file and every `$layout` the JSON files hold, checked against the files
 * that exist. A page that asks for a component or a layout nobody wrote builds into an empty element
 * or fails the build, so it is an error here, where the cause is named.
 */
export function checkReferences(
  files: ReadonlyMap<string, string | Uint8Array>,
  report: Report,
): void {
  const exists = (path: string): boolean => files.has(path);
  for (const [path, content] of [...files].sort((a, b) => cmp(a[0], b[0]))) {
    if (!path.endsWith(".json") || typeof content !== "string") continue;
    let doc: unknown;
    try {
      doc = JSON.parse(content);
    } catch (error) {
      report.add({
        severity: "error",
        code: "project.json-invalid",
        message: `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); jx cannot read it.`,
        where: path,
      });
      continue;
    }
    const missing = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!isRec(value)) return;
      for (const [key, inner] of Object.entries(value)) {
        if (typeof inner === "string" && (key === "$ref" || key === "$layout")) {
          if (/^(?:#|@|https?:|data:)/.test(inner) || !inner.endsWith(".json")) continue;
          const target =
            key === "$layout" || path === "project.json"
              ? posix.normalize(inner.replace(/^\.\//, ""))
              : posix.normalize(posix.join(posix.dirname(path), inner));
          if (!exists(target)) missing.add(`${key} ${inner}`);
        } else visit(inner);
      }
    };
    visit(doc);
    for (const what of [...missing].sort(cmp)) {
      report.add({
        severity: "error",
        code: "project.ref-missing",
        message: `${path} has ${what}, and the project has no such file; the build leaves the element empty or fails.`,
        where: path,
        data: { reference: what },
      });
    }
  }
}

/** The site root above a plugin directory (`<root>/wp-content/plugins/cwicly`), when it is one. */
function pluginRootOf(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  const match = /^(.*)\/wp-content\/plugins\/cwicly\/?$/.exec(origin);
  return match?.[1];
}

// ── The pipeline ─────────────────────────────────────────────────────────────────────────────────

/**
 * Migrate a site: load it, convert it, write the project (see the module comment for the order and
 * what is written). A stage that throws costs its own output only (`project.stage-failed`); the files
 * of the others are still written.
 */
export async function migrateSite(opts: MigrateOptions): Promise<MigrationResult> {
  const started = performance.now();
  const secrets = opts.db === undefined ? [] : dbSecrets(opts.db);
  const own = createReport();
  const timings: Record<string, number> = {};
  const say = (
    phase: MigrateProgress["phase"],
    message: string,
    extra: { done?: number; total?: number } = {},
  ): void => {
    try {
      opts.progress?.({ phase, message, ...extra });
    } catch {
      // An observer that throws must not take the migration with it.
    }
  };
  const phase = async <T>(
    name: MigrateProgress["phase"],
    message: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const t = performance.now();
    say(name, message);
    try {
      return await run();
    } finally {
      timings[name] = Math.round((timings[name] ?? 0) + performance.now() - t);
    }
  };
  /** One stage; a throw is an error entry and the stage's empty output. */
  const progressOfBuild = buildProgress((message) => say("verify", `jx build: ${message}`));
  const stage = async <T>(
    name: MigrateProgress["phase"],
    message: string,
    run: () => Promise<T>,
    fallback: () => T,
  ): Promise<T> => {
    try {
      return await phase(name, message, run);
    } catch (error) {
      own.add({
        severity: "error",
        code: "project.stage-failed",
        message: `The ${name} stage failed (${error instanceof Error ? error.message : String(error)}); its files are not in the output.`,
        where: "site",
        data: { stage: name },
      });
      return fallback();
    }
  };

  if (opts.verify !== undefined && opts.out === undefined) {
    throw new Error("verify needs an output directory (`out`): jx runs on the files on disk");
  }
  if (opts.out === undefined && opts.sink === undefined && opts.dryRun !== true) {
    throw new Error("migrateSite needs `out` or `sink` to write to (or `dryRun` to write nothing)");
  }
  const sink: ProjectSink =
    opts.sink ?? (opts.out === undefined ? memorySink() : diskSink(opts.out));
  const writesNothing = opts.sink === undefined && opts.out === undefined;

  // ── Load ───────────────────────────────────────────────────────────────────────────────────────
  let site: SiteContext;
  /** Where the plugin's files come from, for the core block CSS to follow. */
  let pluginFrom = opts.pluginFrom === false ? undefined : opts.pluginFrom;
  if (opts.site !== undefined) {
    site = opts.site;
  } else {
    const dbUrl = opts.db;
    if (dbUrl === undefined) {
      throw new Error("migrateSite needs `db` (or an already loaded `site`)");
    }
    site = await phase("load", "reading the database and the site's options", async () => {
      await ensureConverters();
      // What nobody named is the live site's: its stylesheets and the plugin's files are served there.
      let live: string | undefined;
      const liveUrl = async (): Promise<string> =>
        (live ??= (opts.siteUrl ?? (await readSiteUrl(dbUrl, opts.prefix))).replace(/\/+$/, ""));
      const given = opts.cssFrom;
      const cssFrom =
        given !== undefined && (given.dir !== undefined || given.url !== undefined)
          ? given
          : { ...given, url: await liveUrl() };
      if (opts.pluginFrom === undefined) pluginFrom = await liveUrl();
      return loadSiteContext({
        db: dbUrl,
        cssFrom,
        ...(opts.prefix === undefined ? {} : { prefix: opts.prefix }),
        ...(opts.siteUrl === undefined ? {} : { siteUrl: opts.siteUrl }),
        ...(pluginFrom === undefined ? {} : { pluginFrom }),
        ...(opts.componentPrefix === undefined ? {} : { componentPrefix: opts.componentPrefix }),
        ...(opts.routeTypes === undefined ? {} : { routeTypes: opts.routeTypes }),
        ...(opts.report === undefined ? {} : { report: opts.report }),
        ...(opts.postTypes === undefined
          ? {}
          : { postTypes: [...new Set([...STRUCTURAL_POST_TYPES, ...opts.postTypes])].sort(cmp) }),
      });
    });
  }
  const { model } = site;
  const now = opts.now ?? new Date();
  // The address the migrated site is served at: what the caller says, else where WordPress puts its
  // pages (`home`). The `siteurl` option is where WordPress itself lives (`/wp` for one installed in a
  // subdirectory, the staging host of a copy), which is no page's canonical and no sitemap entry; it
  // is used only to fetch files.
  const siteUrl = (opts.siteUrl ?? model.site.home).trim().replace(/\/+$/, "");
  const fetchBase = (opts.siteUrl ?? model.site.url).trim().replace(/\/+$/, "");
  const siteName = decodeEntities(model.site.name).trim() || "Jx Site";

  // What an earlier run left in the output, read before anything is converted: a manifest of another
  // site is a reason to stop now, not after the pages are written over its files.
  const previous = parseManifest(await sink.read?.(MANIFEST_PATH));
  if (previous === "unreadable") {
    own.add({
      severity: "warn",
      code: "project.manifest-unreadable",
      message: `${MANIFEST_PATH} could not be read, so nothing an earlier run wrote is removed and every file is rewritten where it differs.`,
      where: MANIFEST_PATH,
    });
  }
  const old: Manifest | undefined = previous === "unreadable" ? undefined : previous;
  if (old?.site !== undefined && old.site !== siteUrl) {
    if (opts.force !== true) {
      throw new Error(
        `the output directory holds the project of ${old.site} (its ${MANIFEST_PATH} says so), and this run migrates ${siteUrl}: its files that this run no longer produces would be removed. Use another directory, or pass force (--force) to replace it`,
      );
    }
    own.add({
      severity: "warn",
      code: "project.site-changed",
      message: `The output directory held the project of ${old.site}; this run migrates ${siteUrl}, so what it no longer produces of the earlier project was removed.`,
      where: MANIFEST_PATH,
      data: { before: old.site, after: siteUrl },
    });
  }

  // ── Convert, in dependency order ───────────────────────────────────────────────────────────────
  const menusUsed = newMenusUsed();
  const menuReport = createReport();
  const components = await stage(
    "components",
    "converting the components",
    () =>
      buildComponents(site, {
        resolvers: menuResolvers(site, { report: menuReport, used: menusUsed }),
      }),
    () => failedComponents(createReport()),
  );
  const templates = await stage(
    "templates",
    "converting the templates, parts and the pages of the routes that are not pages",
    () =>
      buildTemplates(site, {
        now,
        siteUrl,
        responsiveEmbeds: themeSupportsResponsiveEmbeds(
          coreCssRoot(opts.wpFrom, pluginFrom),
          site.model.site.theme,
        ),
      }),
    () => failedTemplates(createReport()),
  );
  const pages = await stage(
    "pages",
    "converting the pages",
    () =>
      buildPages(site, {
        now,
        siteUrl,
        layoutFor,
        resolvers: menuResolvers(site, { report: menuReport, used: menusUsed }),
      }),
    () => failedPages(createReport()),
  );
  const collections = await stage(
    "collections",
    "converting the posts into Markdown collections",
    () =>
      buildCollections(site, {
        classStyles: collectClassStyles([...components.files, ...templates.files, ...pages.files]),
        now,
        ...(opts.inlineGaps === undefined ? {} : { inlineGaps: opts.inlineGaps }),
      }),
    () => failedCollections(createReport()),
  );

  // What was written, as blocks and classes: the compatibility sheet and the core CSS follow it.
  const emittedPosts = new Set<number>([
    ...pages.pages.map((p) => p.id),
    ...collections.entries.map((e) => e.postId),
  ]);
  const blocks: WpBlock[] = [];
  for (const subject of allSubjects(site) as Subject[]) {
    if (subject.kind === "post" && !emittedPosts.has(subject.id)) continue;
    blocks.push(...subjectBlocks(site, subject));
  }
  const usedClasses = new Set<string>([
    ...pages.used.wpClasses,
    ...templates.used.wpClasses,
    ...components.used.wpClasses,
    ...collections.used.wpClasses,
    ...menusUsed.classes,
    ...templates.used.menus.classes,
  ]);

  // ── Design system, compatibility stylesheet ────────────────────────────────────────────────────
  const designReport = createReport();
  const compatReport = createReport();
  const design: DesignSystem | undefined = await stage(
    "design",
    "building the design system and the compatibility stylesheet",
    async () => {
      const palette = [...site.options.globalStyles.colorRefs.values()];
      const read = async (name: string): Promise<string | null> => {
        try {
          return await site.cssSource.get(name);
        } catch (error) {
          designReport.add({
            severity: "error",
            code: "project.css-missing",
            message: `${name} could not be read (${error instanceof Error ? error.message : String(error)}); the rules it holds are not in the project.`,
            where: `file:${name}`,
          });
          return null;
        }
      };
      const classesText = (await read("cc-global-classes.css")) ?? "";
      if (classesText === "" && site.options.globalClassNames.size > 0) {
        designReport.add({
          severity: "warn",
          code: "project.css-missing",
          message:
            "cc-global-classes.css was not found, so the site's global classes have no rules in the project (the options name them, the stylesheet that holds their CSS is generated by the editor).",
          where: "file:cc-global-classes.css",
        });
      }
      const stylesheetsText =
        (await read("cc-global-stylesheets.css")) ?? site.options.compiledCss.stylesheets;
      let compat: CompatCss | undefined;
      if (site.pluginSource === undefined) {
        designReport.add({
          severity: "warn",
          code: "project.compat-missing",
          message:
            "No plugin source was given (pluginFrom), so the plugin's own stylesheets (base.css, style-index.css) and the theme's style.css are not in the project: the structural classes (cc-cntr, cc-sct, cc-nav…) have no styles.",
          where: "plugin:cwicly",
        });
      } else {
        const wanted = compatFeaturesForBlocks(blocks);
        compat = buildCompatCss(site.pluginSource, {
          ...Object.fromEntries([...wanted].map((feature) => [feature, true])),
          ...(site.options.version === undefined ? {} : { version: site.options.version }),
          theme: site.theme,
          ...(opts.pruneCompat === true ? { usedClasses } : {}),
          report: compatReport,
        });
      }
      const tools = site.urls.bind(designReport, "design:global-css");
      const additionalCss = additionalCssFor(model);
      return buildDesignSystem(
        {
          options: site.options,
          globalCss: parseCwiclyCss(site.options.compiledCss.global, site.options.breakpoints, {
            file: "cwicly_global_css",
            palette,
          }),
          classesCss: parseCwiclyCss(classesText, site.options.breakpoints, {
            file: "cc-global-classes.css",
            palette,
          }),
          classesText,
          stylesheetsCss: stylesheetsText,
          report: designReport,
          additionalCss,
        },
        {
          ...(compat === undefined ? {} : { compat }),
          rewriteUrl: (url) => tools.rewriteUrl(url),
        },
      );
    },
    () => undefined,
  );

  // ── Core block CSS ─────────────────────────────────────────────────────────────────────────────
  const coreReport = createReport();
  let core: ReturnType<typeof coreBlockStyle> | undefined;
  await stage(
    "core-css",
    "tree-shaking the WordPress block library's stylesheets",
    async () => {
      const root = coreCssRoot(opts.wpFrom, pluginFrom);
      if (root === undefined) {
        coreReport.add({
          severity: "warn",
          code: "project.core-css-skipped",
          message:
            "No WordPress root was given (wpFrom, or a pluginFrom that holds wp-includes or is the live site), so the core blocks' own stylesheets (columns, buttons, galleries, quotes…) are not in the project.",
          where: "site",
        });
        return;
      }
      const names = new Set<string>();
      walkBlocks(blocks, (block) => {
        if (block.name?.startsWith("core/") === true) names.add(block.name);
      });
      let sources: CssSourceText[];
      try {
        sources = await wpCoreCssSources(root, { blocks: names, report: coreReport });
        if (opts.presets === true) {
          const layers = await wpThemeJsonLayers(root, model, {
            report: coreReport,
            where: "site",
          });
          sources.push(wpPresetCss(layers, { report: coreReport, where: "site" }));
        }
      } catch (error) {
        coreReport.add({
          severity: "warn",
          code: "project.core-css-failed",
          message: `The WordPress block library's stylesheets could not be read from ${root} (${error instanceof Error ? error.message : String(error)}); the core blocks keep their classes and have no styles.`,
          where: "site",
        });
        return;
      }
      const known =
        design === undefined ? [] : Object.keys(design.style).filter((k) => k.startsWith("--"));
      core = coreBlockStyle(usedClasses, sources, site.options.breakpoints, coreReport, {
        blocks: names,
        knownVars: known,
        styledElsewhere: design === undefined ? [] : classesOfKeys(design.style),
        where: "site",
      });
    },
    () => undefined,
  );

  // ── Redirects ──────────────────────────────────────────────────────────────────────────────────
  const redirectReport = createReport();
  const redirects: RedirectBuild = await stage(
    "redirects",
    "building the redirects",
    async () =>
      buildRedirects(model, site.routes, {
        report: redirectReport,
        tools: site.urls.bind(redirectReport, "redirects"),
        media: site.media,
      }),
    () => ({
      redirects: {},
      summary: { rankMath: 0, routes: 0, dropped: {}, literal: 0, wildcard: 0 },
      supersedes: [],
    }),
  );

  // A page behind a Rank Math redirect was unreachable on the source site (the rule answers first), and
  // the redirect is written at its address: the page is not written, as Jx would write two things there.
  // An entry is different: the lists of its collection still show it on the source site (the blog index
  // prints the card of a post whose address Rank Math sends elsewhere), so the entry stays in the
  // collection and only its own page gives way, the redirect's file being written over it by the build.
  withoutSupersededPages(redirects.supersedes, pages);
  const superseded = new Set(redirects.supersedes.map(pathKey));

  // A redirect from the address of a page this run wrote would make the build write two things at one
  // address. The route table already vets the pages it knows (`redirect.shadowed`); the pages the
  // templates emitter adds (the search page, the 404, the posts index) are not in it.
  const live = new Set<string>([
    ...pages.pages.map((p) => pathKey(p.route)),
    ...templates.pages.filter((p) => !/[:*]/.test(p.route)).map((p) => pathKey(p.route)),
    ...collections.entries.map((e) => pathKey(e.route)).filter((k) => !superseded.has(k)),
  ]);
  {
    for (const source of Object.keys(redirects.redirects)) {
      if (/[:*]/.test(source) || !live.has(pathKey(source))) continue;
      delete redirects.redirects[source];
      own.add({
        severity: "warn",
        code: "project.redirect-shadowed",
        message: `The redirect from ${source} was dropped: the migrated site has a page at that address (the redirect and the page would both be written there).`,
        where: `redirect:${source}`,
        data: { source },
      });
    }
  }

  // ── The files ──────────────────────────────────────────────────────────────────────────────────
  const files = new Map<string, string | Uint8Array>();
  const add = (path: string, content: string | Uint8Array, origin: string): void => {
    try {
      checkProjectPath(path);
    } catch (error) {
      own.add({
        severity: "error",
        code: "project.file-invalid",
        message: `${origin} produced a file the project cannot hold (${error instanceof Error ? error.message : String(error)}); it was not written.`,
        where: origin,
        data: { path },
      });
      return;
    }
    const known = files.get(path);
    if (known !== undefined) {
      const same =
        typeof known === "string" && typeof content === "string"
          ? known === content
          : sha256(known) === sha256(content);
      if (!same) {
        own.add({
          severity: "error",
          code: "project.file-collision",
          message: `${path} was produced twice with different content; the first is kept.`,
          where: path,
          data: { origin },
        });
      }
      return;
    }
    files.set(path, content);
  };
  for (const f of components.files) add(f.path, f.content, "components");
  for (const f of templates.files) add(f.path, f.content, "templates");
  for (const f of pages.files) add(f.path, f.content, "pages");
  for (const f of collections.files) add(f.path, f.content, "collections");
  if (design !== undefined) for (const f of design.files) add(f.path, f.content, "design system");

  // ── project.json ───────────────────────────────────────────────────────────────────────────────
  const head: JxHeadEntry[] = design === undefined ? [] : clone(design.head);
  // The `@import`s of the pages', templates' and components' own stylesheets (a block that picks a
  // Google font): a style object cannot hold one, so each is a link here, once.
  for (const entry of collectFontImports([{ atRules: importedStyleRules(site) }], {
    report: own,
    where: "site",
  })) {
    const href = entry.attributes?.href;
    if (!head.some((known) => known.tagName === "link" && known.attributes?.href === href)) {
      head.push(entry);
    }
  }
  if (core !== undefined && core.verbatim.trim() !== "") {
    add(
      CORE_CSS_PATH,
      `/* WordPress block library rules project.json's style cannot carry */\n${core.verbatim.trim()}\n`,
      "core css",
    );
    const at = head.findLastIndex(
      (entry) =>
        entry.tagName === "link" &&
        design?.stylesheets.some(
          (sheet) =>
            (sheet.role === "compat" || sheet.role === "global") &&
            sheet.href === entry.attributes?.href,
        ) === true,
    );
    head.splice(at + 1, 0, {
      tagName: "link",
      attributes: { rel: "stylesheet", href: CORE_CSS_PATH.replace(/^public/, "") },
    });
  }
  // The forms the pages draw: the plugin's stylesheets and each form's styler rules, linked after the
  // compatibility sheet so the page's own rules (Cwicly classes) keep winning where they overlap.
  const formSheet = await fluentFormStylesheet(
    usedForms(site),
    pluginFrom ?? pluginRootOf(site.pluginSource?.origin),
    own,
  );
  if (usedForms(site).some((form) => form.turnstile)) {
    head.push({
      tagName: "script",
      attributes: { src: TURNSTILE_SCRIPT, async: "", defer: "" },
    });
  }
  if (formSheet !== undefined) {
    add(formSheet.path, formSheet.content, "forms");
    const at = head.findIndex(
      (entry) => entry.tagName === "link" && entry.attributes?.rel === "stylesheet",
    );
    head.splice(at + 1, 0, {
      tagName: "link",
      attributes: { rel: "stylesheet", href: formSheet.path.replace(/^public/, "") },
    });
  }
  // The before and after sliders' stylesheet, beside the forms'.
  const compareSheet = await imageCompareStylesheet(
    site.model,
    pluginFrom ?? pluginRootOf(site.pluginSource?.origin),
    own,
  );
  if (compareSheet !== undefined) {
    add(compareSheet.path, compareSheet.content, "image compare");
    const at = head.findIndex(
      (entry) => entry.tagName === "link" && entry.attributes?.rel === "stylesheet",
    );
    head.splice(at + 1, 0, {
      tagName: "link",
      attributes: { rel: "stylesheet", href: compareSheet.path.replace(/^public/, "") },
    });
  }
  // The maps' stage: the plugin's stylesheet gives the empty container the size the live page's map has.
  const mapSheet = await geoMapStylesheet(
    usedGeoMaps(site),
    pluginFrom ?? pluginRootOf(site.pluginSource?.origin),
    own,
  );
  if (mapSheet !== undefined) {
    add(mapSheet.path, mapSheet.content, "geo map");
    const at = head.findIndex(
      (entry) => entry.tagName === "link" && entry.attributes?.rel === "stylesheet",
    );
    head.splice(at + 1, 0, {
      tagName: "link",
      attributes: { rel: "stylesheet", href: mapSheet.path.replace(/^public/, "") },
    });
  }
  // The site icon: WordPress prints it as icon links of several sizes cut from one attachment; the
  // browser scales the one file here (and takes it, an SVG included, as the touch icon too).
  const iconId = Number(model.options.get("site_icon") ?? "");
  if (Number.isInteger(iconId) && iconId > 0) {
    const icon = site.media.mediaFor(iconId);
    if (icon === undefined) {
      own.add({
        severity: "warn",
        code: "project.site-icon-missing",
        message: `The site icon is the attachment ${iconId}, which has no file in the media plan, so the pages have no icon links.`,
        where: "option:site_icon",
        data: { id: iconId },
      });
    } else {
      const type = icon.src.toLowerCase().endsWith(".svg") ? { type: "image/svg+xml" } : {};
      head.push(
        { tagName: "link", attributes: { rel: "icon", href: icon.src, ...type } },
        { tagName: "link", attributes: { rel: "apple-touch-icon", href: icon.src } },
      );
    }
  }
  if (menusUsed.currentPage || templates.used.menus.currentPage) {
    add(CURRENT_PAGE_JS_PATH, `${CURRENT_PAGE_SCRIPT}\n`, "menus");
    head.push({
      tagName: "script",
      attributes: { src: CURRENT_PAGE_JS_PATH.replace(/^public/, ""), defer: "" },
    });
  }

  const mediaOf = (design?.media ?? site.options.media) as Record<string, string>;
  const composed = composeStyle((design?.style ?? {}) as JxStyle, [
    { custom: core?.custom, style: core?.style },
  ]);
  composed.style = liftMediaBlocks(composed.style, Object.keys(mediaOf));
  // What the posts, templates and documents moved here follows the design system's conditional blocks.
  const posts = composeStyle({} as JxStyle, [
    {
      rules: [
        ...templates.used.hoisted,
        ...collections.used.hoisted,
        ...entryHeadingRules(core?.style, collections.files),
        ...pages.used.documentRules,
        ...templates.used.documentRules,
        ...components.used.documentRules,
      ],
    },
  ]);
  composed.style = layerAfterMedia(composed.style, posts.style, mediaOf);
  composed.merged.push(...posts.merged);
  if (composed.merged.length > 0) {
    own.add({
      severity: "info",
      code: "project.style-merged",
      message: `${composed.merged.length} rule${composed.merged.length === 1 ? "" : "s"} of the core block CSS or the hoisted rules share a selector with an earlier entry of the project style and were merged into it (the later declarations win).`,
      where: "project.json",
      data: { selectors: composed.merged.slice(0, 20) },
    });
  }

  const content: Rec = { ...collections.collections, ...templates.collections };
  const language = model.site.language.trim();
  const defaults: Rec = {
    ...(templates.base === null ? {} : { layout: templates.base }),
    ...(/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/.test(language)
      ? { lang: language.replace("_", "-") }
      : {}),
  };
  // Raster images the content uses: what Jx's image build has to encode.
  const rasterImages = site.media
    .used()
    .filter((file) => /^image\/(?:jpeg|png|webp|gif|avif|tiff)$/i.test(file.mime)).length;
  const images = imageSettings(rasterImages, opts.images);
  if (images !== undefined && opts.images === undefined) {
    own.add({
      severity: "info",
      code: "project.images-formats",
      message: `The pages use ${rasterImages} images. Jx encodes every image in WebP and in AVIF unless told otherwise, and AVIF takes about 25 times as long to encode as WebP: the first \`jx build\` of this many images takes most of an hour (the same images take about 2 minutes as WebP alone), so project.json asks for WebP only (\`images.formats\`). AVIF files are smaller: convert again with \`--image-formats webp,avif\` when the longer first build is worth it (the encoded images are kept for the builds after it). Do not edit \`images.formats\` in project.json: every run rewrites that file from the options.`,
      where: "project.json",
      data: { images: rasterImages, threshold: HEAVY_IMAGE_COUNT, formats: images.formats },
    });
  }
  const project: Rec = {
    name: siteName,
    url: siteUrl,
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    $media: design?.media ?? site.options.media,
    ...(Object.keys(content).length > 0 ? { extensions: ["@jxsuite/parser"], content } : {}),
    style: composed.style,
    ...(head.length > 0 ? { $head: head } : {}),
    ...(Object.keys(redirects.redirects).length > 0 ? { redirects: redirects.redirects } : {}),
    ...(images === undefined ? {} : { images }),
    build: { adapter: "static" },
  };
  add("project.json", jsonText(project), "project");
  /**
   * Files written when they are not there and never again (not in the manifest): a person's to edit.
   * The `.gitignore` is not made from the site, so there is nothing a re-run could refresh in it, and
   * what a person adds (`.env`, `.wrangler`) must not be lost to it.
   */
  const seeds = new Map<string, string>([
    [".gitignore", GITIGNORE],
    ["package.json", projectPackageJson(siteName, Object.keys(content).length > 0)],
  ]);

  checkReferences(files, own);

  // ── Media ──────────────────────────────────────────────────────────────────────────────────────
  const mediaTotals = { planned: 0, downloaded: 0, skipped: 0, failed: 0, bytes: 0 };
  const mediaReport = createReport();
  const written: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];

  /** What the manifest will hold for media: written by this run, or carried from the last one. */
  const mediaHashes: Record<string, string> = {};
  const RASTER_NAME = /\.(?:jpe?g|png|webp|avif|tiff?|heic|heif|bmp|ico)$/i;
  const isMediaPath = (path: string): boolean =>
    path.startsWith("public/media/") || path.startsWith("public/fonts/");

  const mediaOn = opts.media !== false;
  /** The library's files the converted content asked for, and the theme's fonts (which have no attachment). */
  const library = site.media.used();
  const fontFiles = (design?.fontDownloads ?? []).flatMap((font) => {
    const file = fontFile(font, fetchBase, site.media.uploadsBase);
    if (file === undefined) {
      mediaReport.add({
        severity: "warn",
        code: "media.font-unresolved",
        message: `The font file ${font.url} has no address the tool can fetch it from; ${font.dest} is not in the project.`,
        where: "option:cwicly_local_fonts",
        data: { file: font.dest, url: font.url },
      });
    }
    return file === undefined ? [] : [file];
  });
  const planned: MediaFile[] = [...library, ...fontFiles];
  mediaTotals.planned = planned.length;
  const fetchPlan = async (): Promise<void> => {
    const uploads = opts.uploads;
    const localDir = uploads !== undefined && !isUrl(uploads) ? resolve(uploads) : undefined;
    let plan = library;
    if (uploads !== undefined && localDir === undefined) {
      // Another address for the library: asked first, the site's own the fallback.
      const base = uploads.replace(/\/+$/, "");
      plan = library.map((file) => ({
        ...file,
        sourceUrl: `${base}/${file.file.split("/").map(encodeURIComponent).join("/")}`,
        fallbackUrls: [file.sourceUrl, ...(file.fallbackUrls ?? [])].filter((u) => u !== ""),
      }));
    }
    const skipExisting = async (dest: string): Promise<boolean> =>
      sink.exists !== undefined && (await sink.exists(dest));
    const io = {
      async write(dest: string, bytes: Uint8Array): Promise<void> {
        await sink.write(dest, bytes);
        mediaHashes[dest] = sha256(bytes);
      },
    };
    const download = async (files: MediaFile[]): Promise<void> => {
      if (files.length === 0) return;
      const result: DownloadResult = await downloadMedia({ files }, io, {
        ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
        ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
        skipExisting,
        report: mediaReport,
        onProgress: (p) =>
          say("media", `${p.done} of ${p.total} files (${p.outcome.file.file})`, {
            done: p.done,
            total: p.total,
          }),
      });
      mediaTotals.downloaded += result.ok;
      mediaTotals.skipped += result.skipped;
      mediaTotals.failed += result.failed;
      mediaTotals.bytes += result.bytes;
    };
    if (localDir !== undefined) {
      // The library is on disk: copy it, never touch the network for it. (The fonts are the theme's,
      // not the library's: they come from the site.)
      let done = 0;
      for (const file of plan) {
        done++;
        if (await skipExisting(file.destPath)) {
          mediaTotals.skipped++;
          continue;
        }
        const from = resolve(localDir, ...file.file.split("/"));
        try {
          if (from !== localDir && !from.startsWith(localDir + sep)) throw new Error("outside");
          await io.write(file.destPath, new Uint8Array(await readFile(from)));
          mediaTotals.downloaded++;
          mediaTotals.bytes += statSync(from).size;
        } catch {
          mediaTotals.failed++;
          mediaReport.add({
            severity: "error",
            code: "media.local-missing",
            message: `${file.file} is not in ${localDir}, so ${file.publicPath} does not exist in the project.`,
            where:
              file.attachmentIds.length > 0
                ? `post:${file.attachmentIds[0]}`
                : `media:${file.file}`,
            data: { file: file.file, destPath: file.destPath },
          });
        }
        if (done % 50 === 0)
          say("media", `copied ${done} of ${plan.length} files`, { done, total: plan.length });
      }
      await download(fontFiles);
      return;
    }
    await download([...plan, ...fontFiles]);
  };
  if (!mediaOn) {
    own.add({
      severity: "info",
      code: "media.skipped",
      message: `Media was left out: ${planned.length} file${planned.length === 1 ? "" : "s"} the converted content refers to (and the fonts) are not in the project, so their addresses (/media/…) do not resolve until they are fetched.`,
      where: "site",
      data: { files: planned.length },
    });
  } else if (opts.dryRun === true) {
    own.add({
      severity: "info",
      code: "media.not-downloaded",
      message: `Dry run: ${planned.length} file${planned.length === 1 ? "" : "s"} would be fetched (${site.media.stats.attachments} attachments in the library, ${site.media.stats.files} planned in all). Run again without the dry-run flag to fetch them.`,
      where: "site",
      data: { files: planned.length, attachments: site.media.stats.attachments },
    });
  } else if (!writesNothing) {
    await stage("media", `fetching ${planned.length} media files`, fetchPlan, () => undefined);
    // The manifest vouches for what this tool wrote: a file this run wrote has its hash, and one it
    // skipped as already there keeps the hash the last run gave it. A file that was there with no
    // manifest entry is somebody's (an uploads folder copied in before the run): it is left out, so
    // no later run can take it for stale and delete it.
    const foreign: string[] = [];
    for (const file of planned) {
      if (mediaHashes[file.destPath] !== undefined) continue;
      const existing = old?.files[file.destPath];
      if (existing !== undefined && (await sink.exists?.(file.destPath)) !== false) {
        mediaHashes[file.destPath] = existing;
      } else if ((await sink.exists?.(file.destPath)) === true) {
        foreign.push(file.destPath);
      }
    }
    if (foreign.length > 0) {
      own.add({
        severity: "info",
        code: "project.media-not-adopted",
        message: `${foreign.length} media file${foreign.length === 1 ? " was" : "s were"} already in the project and not written by this tool, so ${foreign.length === 1 ? "it was" : "they were"} used as found and ${foreign.length === 1 ? "is" : "are"} not in the manifest: no later run removes ${foreign.length === 1 ? "it" : "them"}.`,
        where: "site",
        data: { files: foreign.length, examples: foreign.slice(0, 10) },
      });
    }
  }
  if (!(mediaOn && opts.dryRun !== true && !writesNothing)) {
    // Media this run did not touch stays in the manifest, so a later run still knows it wrote them.
    for (const [path, hash] of Object.entries(old?.files ?? {})) {
      if (isMediaPath(path)) mediaHashes[path] = hash;
    }
  }

  // A picture the image optimiser cannot decode would stop the whole `jx build`: its references say so.
  if (mediaOn && opts.dryRun !== true && !writesNothing && sink.read !== undefined) {
    const unreadable = new Map<string, string>();
    for (const file of library) {
      if (!RASTER_NAME.test(file.file)) continue;
      const bytes = await sink.read(file.destPath);
      const why = bytes === undefined ? undefined : undecodableImage(bytes);
      if (why === undefined) continue;
      unreadable.set(file.publicPath, why);
      mediaReport.add({
        severity: "warn",
        code: "media.undecodable",
        message: `${file.file} cannot be decoded by Jx's image optimiser: ${why}. Its references carry data-no-optimize so the build goes on, and the picture is served as it is (replace it with a JPEG or PNG for a result in every browser).`,
        where:
          file.attachmentIds.length > 0 ? `post:${file.attachmentIds[0]}` : `media:${file.file}`,
        data: { file: file.file, publicPath: file.publicPath, attachmentIds: file.attachmentIds },
      });
    }
    markNoOptimize(files, new Set(unreadable.keys()));
  }

  // ── Write the files ────────────────────────────────────────────────────────────────────────────
  /** What the manifest will vouch for: a file counts once it is on disk, so the manifest is true at every step. */
  const manifestFiles: Record<string, string> = {};
  /** A write that fails is said with its file and its operation (the sink's own message may name neither). */
  const put = async (path: string, data: string | Uint8Array): Promise<void> => {
    try {
      await sink.write(path, data);
    } catch (error) {
      throw new Error(
        `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
  /**
   * Run a step of the writing. If it fails, what was written so far is recorded in a manifest before
   * the failure goes on: a project half written with no manifest is not the tool's as far as the next
   * run can tell, and that run would refuse the directory.
   */
  const writing = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      try {
        const partial: Manifest = {
          generator: "wp2jx",
          manifest: 1,
          site: siteUrl,
          files: sortedRecord({ ...old?.files, ...mediaHashes, ...manifestFiles }),
        };
        await sink.write(MANIFEST_PATH, jsonText(partial));
      } catch {
        // The sink is what is failing; the original error is the one to report.
      }
      throw error;
    }
  };
  await writing(() =>
    phase("write", `writing ${files.size} files`, async () => {
      let done = 0;
      for (const path of [...files.keys()].sort(cmp)) {
        const data = files.get(path)!;
        const before = await sink.read?.(path);
        if (before !== undefined && sameBytes(before, bytesOf(data))) unchanged.push(path);
        else {
          const known = old?.files[path];
          if (before !== undefined && known !== undefined && sha256(before) !== known) {
            own.add({
              severity: "warn",
              code: "project.edited-overwritten",
              message: `${path} was written by an earlier run and edited since, and this run produces it again, so the edit was overwritten. A file the tool does not produce is never touched: keep a hand edit in one.`,
              where: path,
            });
          }
          await put(path, data);
          written.push(path);
        }
        manifestFiles[path] = sha256(data);
        done++;
        if (done % 200 === 0)
          say("write", `wrote ${done} of ${files.size} files`, { done, total: files.size });
      }
    }),
  );

  await writing(async () => {
    for (const [path, text] of seeds) {
      if (path in manifestFiles) continue;
      if ((await sink.exists?.(path)) === true) {
        unchanged.push(path);
      } else {
        await put(path, text);
        written.push(path);
      }
    }
  });

  // A package.json that was already there is not rewritten, and if it lacks what the project needs,
  // the build fails far from here (a parser that cannot be resolved ships every content page empty).
  if (!written.includes("package.json") && sink.read !== undefined) {
    const bytes = await sink.read("package.json");
    if (bytes !== undefined) {
      let pkg: Rec | undefined;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        pkg = isRec(parsed) ? parsed : undefined;
      } catch {
        pkg = undefined;
      }
      if (pkg === undefined) {
        own.add({
          severity: "warn",
          code: "project.package-unreadable",
          message:
            "package.json is not valid JSON, so whether it names the packages the build needs could not be checked.",
          where: "package.json",
        });
      } else {
        const has = (name: string): boolean =>
          [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].some(
            (group) => isRec(group) && typeof group[name] === "string",
          );
        if (Object.keys(content).length > 0 && !has("@jxsuite/parser")) {
          own.add({
            severity: "warn",
            code: "project.package-missing-parser",
            message:
              "project.json names @jxsuite/parser (the site has Markdown collections) but package.json does not depend on it: the build warns `prototype-resolver: failed to resolve …` and ships every content page empty. Add it to the dependencies and install.",
            where: "package.json",
          });
        }
        const lacking = ["@jxsuite/compiler", "@jxsuite/runtime"].filter((name) => !has(name));
        if (lacking.length > 0) {
          own.add({
            severity: "warn",
            code: "project.package-missing-jx",
            message: `package.json does not depend on ${lacking.join(" or ")}, which \`jx build\` needs (it is not found in a project outside the wp2jx repository until it is added and installed).`,
            where: "package.json",
            data: { packages: lacking },
          });
        }
      }
    }
  }

  // ── What the manifest lets us remove ───────────────────────────────────────────────────────────
  // Before jx runs: `jx validate` and `jx build` judge the files the run leaves behind, not the ones
  // it is about to remove (a stale page would pass or fail the verification and stay in `dist/`).
  const next: Manifest = {
    generator: "wp2jx",
    manifest: 1,
    site: siteUrl,
    files: { ...manifestFiles, ...mediaHashes },
  };
  if (old !== undefined && sink.remove !== undefined) {
    await writing(async () => {
      for (const [path, hash] of Object.entries(old.files).sort((a, b) => cmp(a[0], b[0]))) {
        if (next.files[path] !== undefined || OWN_FILES.has(path) || seeds.has(path)) continue;
        try {
          checkProjectPath(path);
        } catch {
          continue;
        }
        const bytes = await sink.read?.(path);
        if (bytes === undefined) continue;
        if (sha256(bytes) !== hash) {
          kept.push(path);
          own.add({
            severity: "warn",
            code: "project.stale-kept",
            message: `${path} was written by an earlier run and is no longer produced, but it was edited since, so it was not removed.`,
            where: path,
          });
          next.files[path] = hash;
          continue;
        }
        await sink.remove!(path);
        removed.push(path);
      }
    });
  }

  // ── Verify ─────────────────────────────────────────────────────────────────────────────────────
  const verifyReport = createReport();
  const verify: NonNullable<MigrationResult["verify"]> = {};
  if (opts.verify !== undefined && opts.out !== undefined) {
    const dir = resolve(opts.out);
    if (opts.verify.install === true) {
      const result = await phase("verify", "bun install", () =>
        installDependencies(dir, opts.verify?.installCmd ? { cmd: opts.verify.installCmd } : {}),
      );
      addIssues(verifyReport, result.issues);
      verify.install = { ok: result.ok, ms: result.run.ms };
    }
    if (opts.verify.validate === true) {
      const result = await phase("verify", "jx validate", () =>
        validateProject(dir, {
          ...opts.verify?.jx,
          ...(opts.verify?.strict === true ? { strict: true } : {}),
        }),
      );
      addIssues(verifyReport, result.issues);
      verify.validate = { ok: result.ok, issues: result.issues.length, ms: result.run.ms };
    }
    if (opts.verify.build === true) {
      // A build encodes every image the pages use, which takes minutes for a media-heavy site: the
      // limit scales with the media unless the caller set one, and the build's lines are progress.
      const jx = opts.verify?.jx ?? {};
      const result = await phase("verify", "jx build", () =>
        buildProject(dir, {
          ...jx,
          timeoutMs: jx.timeoutMs ?? buildTimeoutFor({ files: mediaTotals.planned }),
          onLine: (line, stream) => {
            jx.onLine?.(line, stream);
            progressOfBuild(line, stream);
          },
        }),
      );
      addIssues(verifyReport, result.issues);
      verify.build = {
        ok: result.ok,
        issues: result.issues.length,
        ms: result.run.ms,
        timeoutMs: result.run.timeoutMs,
        ...(result.summary.routes === undefined ? {} : { routes: result.summary.routes }),
        ...(result.summary.files === undefined ? {} : { files: result.summary.files }),
      };
    }
  }

  // ── The report ─────────────────────────────────────────────────────────────────────────────────
  // The entries are merged with nothing masked, and the decisions are drawn from them as they are:
  // they match on codes, types and kinds, which a database password that is a common word (`page`,
  // `post`) would otherwise rewrite. What a person reads is masked after.
  const unmasked = mergeReports([
    settleUnresolved(
      mergeReports([
        site.report,
        designReport,
        compatReport,
        coreReport,
        components.report,
        templates.report,
        pages.report,
        menuReport,
        collections.report,
        redirectReport,
        mediaReport,
        own,
        verifyReport,
      ]),
      live,
      redirects.redirects,
    ),
  ]);
  const decisions = ownerDecisions(unmasked).map((d) => ({
    ...d,
    examples: d.examples.map((example) => redactText(example, secrets)),
  }));
  const report = secrets.length === 0 ? unmasked : unmasked.map((e) => redactEntry(e, secrets));
  const reportFiles: [string, string][] = [
    [REPORT_MD_PATH, renderProjectReport(report, decisions, siteUrl)],
    [REPORT_JSON_PATH, renderReportJson(report)],
  ];
  await writing(async () => {
    for (const [path, text] of reportFiles) {
      next.files[path] = sha256(text);
      const before = await sink.read?.(path);
      if (before !== undefined && sameBytes(before, bytesOf(text))) unchanged.push(path);
      else {
        await put(path, text);
        written.push(path);
      }
    }
  });

  // ── The manifest, last ─────────────────────────────────────────────────────────────────────────
  next.files = sortedRecord(next.files);
  const manifestText = jsonText(next);
  const manifestBefore = await sink.read?.(MANIFEST_PATH);
  if (manifestBefore !== undefined && sameBytes(manifestBefore, bytesOf(manifestText))) {
    unchanged.push(MANIFEST_PATH);
  } else {
    await sink.write(MANIFEST_PATH, manifestText);
    written.push(MANIFEST_PATH);
  }

  timings.total = Math.round(performance.now() - started);
  return {
    project,
    files: {
      written: written.sort(cmp),
      unchanged: unchanged.sort(cmp),
      removed: removed.sort(cmp),
      kept: kept.sort(cmp),
    },
    report,
    summary: summarise(report),
    decisions,
    media: mediaTotals,
    counts: {
      pages: pages.pages.length + templates.pages.length,
      entries: collections.entries.length,
      collections: Object.keys(content).length,
      components: components.files.length + templates.parts.length + templates.reusables.length,
      layouts: Object.keys(templates.layouts).length + Object.keys(templates.frames).length,
      redirects: Object.keys(redirects.redirects).length,
      files: Object.keys(next.files).length,
    },
    timings,
    ...(Object.keys(verify).length > 0 ? { verify } : {}),
  };
}
