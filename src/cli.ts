#!/usr/bin/env bun
/**
 * `wp2jx`: migrate a Cwicly WordPress site to a Jx project.
 *
 *   wp2jx convert   --db <url> --out <dir> [options]   convert a site (see `wp2jx --help`)
 *   wp2jx inventory --db <url> [--json]                census of a site: what it holds, to scope a migration
 *   wp2jx verify    --out <dir> --live <url> [...]     compare the built project with the live site (see `wp2jx verify --help`)
 *
 * Exit codes: 0 done; 1 done, but the report has errors (or `jx validate` / `jx build` failed), unless
 * `--allow-errors`; 2 usage (a flag or a value the tool cannot use); 3 the run could not finish (the
 * database would not open, a source could not be read). Progress goes to stderr, the summary to
 * stdout. The database URL may carry a password: it is taken from `WP2JX_DB` when `--db` is not given
 * (so it stays out of the process list), and it is masked in everything the tool prints or writes.
 *
 * The census (`inventory`) reads the same database the conversion does and prints what a person needs
 * to size a migration: post types by status and whether a conversion would take them, block names, the
 * Cwicly tokens in use, shortcodes and form plugins, ACF groups, active plugins.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { findTokens, isKnownToken } from "./cwicly/tokens.ts";
import { readCwiclyOptions } from "./cwicly/options.ts";
import {
  dbSecrets,
  MANIFEST_PATH,
  migrateSite,
  redactDbUrl,
  redactText,
  STRUCTURAL_POST_TYPES,
  type MigrateOptions,
  type MigrationResult,
} from "./emit/project.ts";
import { createReport } from "./report.ts";
import { verifyCommand } from "./verify/command.ts";
import { buildRoutes } from "./routes.ts";
import { componentInfos, publishedPostTypes, reportExcludedTypes } from "./site.ts";
import { loadAcf } from "./wp/acf.ts";
import { countBlocks, parseBlocks } from "./wp/blocks.ts";
import { openDb } from "./wp/db.ts";
import { decodeEntities, DEFAULT_EXCLUDED_POST_TYPES, loadModel } from "./wp/model.ts";

// ── Usage ────────────────────────────────────────────────────────────────────────────────────────

export const HELP = `wp2jx: migrate a Cwicly WordPress site to a Jx project

Usage
  wp2jx convert   --db <url> --out <dir> [options]
  wp2jx inventory --db <url> [--prefix <p>] [--post-types a,b] [--route-type t[=opts]] [--json]
  wp2jx verify    --out <dir> [--live <url>] [--urls sitemap|all|<file>] [--max n] [--viewports 1366,390] [options]
                  (compares the built project with the live site; wp2jx verify --help)
  wp2jx --help | --version

The database is mysql://user:pass@host:port/name or sqlite:<file>. Put the password in the WP2JX_DB
environment variable instead of --db to keep it out of the process list.

convert options
  --db <url>                 the WordPress database (or WP2JX_DB)
  --out <dir>                where the Jx project goes (required unless --dry-run)
  --prefix <p>               table prefix, trailing underscore included (detected when absent)
  --site-url <url>           the live address, when it differs from the siteurl option (a staging copy)
  --css-from <dir|url>       Cwicly's generated stylesheets: wp-content/uploads/cwicly, or the live site
                             (default: the live site). Repeat it to try a folder first and the site for
                             what it lacks
  --plugin-from <dir|url>    the plugin's own CSS and the theme's style.css: a site checkout, the Cwicly
                             repository, or the live site (default: the live site)
  --wp-from <dir|url>        a WordPress root for the core blocks' stylesheets (default: --plugin-from
                             when it has wp-includes or is a live site)
  --no-plugin-css            ship no plugin or theme CSS (offline; the report says what is missing)
  --no-core-css              ship no core block CSS
  --uploads <dir|url>        take the media from a local uploads folder or another address
  --component-prefix <p>     prefix of the Jx components' tags (default: the site name's initials)
  --post-types a,b           convert only these content types (pages, posts, templates and components
                             always)
  --route-type <t>[=opts]    give a plugin's post type its rewrite rule, so it is migrated: opts are
                             comma separated, from hierarchical, archive, archive:<slug>, slug:<base>,
                             no-front, private (--route-type grw_feed=slug:reviews,archive). Repeat it
                             per type; naming a type here also adds it to --post-types
  --dry-run                  fetch no media; with no --out, write nothing at all
  --no-media                 leave the media out entirely
  --install                  run bun install in the output first (the project's package.json names the
                             packages its build needs)
  --validate                 run jx schema + jx validate in the output
  --build                    run jx build in the output
  --strict                   with --validate: a lint error fails it
  --allow-errors             exit 0 even when the report has errors
  --force                    write into a directory that holds files this tool did not write, or the
                             project of another site (the files this run no longer produces are removed)
  --presets                  also ship the WordPress preset styles the live site does not serve
  --prune-css                drop the plugin CSS rules for classes no page carries
  --inline-gaps <mode>       report (default) or innerHTML: how to write paragraphs whose inline siblings
                             the build would separate by a space
  --css-cache <dir>          keep fetched stylesheets here
  --css-cache-absent-ttl <h> hours a remembered 404 for a stylesheet is believed (default 24; 0 asks
                             the site every time). Needs --css-cache. A stylesheet the site lacked
                             during an outage or a Cwicly regeneration stays missing until it expires
  --image-formats <list|jx>  the image formats Jx encodes (images.formats of project.json), comma
                             separated: webp,avif. By default a site of more than 100 images asks for
                             webp alone (avif takes most of an hour); jx leaves Jx's own settings.
                             Give it on every run: project.json is regenerated
  --concurrency <n>          media downloads in flight (default 6)
  --jx <path>                the jx binary (default: this repository's)
  --quiet                    no progress

Output: the project, migration-report.md (a punch list, decisions for the site owner first),
migration-report.json, and .wp2jx-manifest.json (what this tool wrote, so a re-run can remove what it
no longer produces and leave alone what it did not write).
`;

class UsageError extends Error {}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
}

const defaultIo = (): CliIo => ({
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
});

const isUrl = (text: string): boolean => /^https?:\/\//i.test(text);

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────────

const CONVERT_FLAGS = {
  db: { type: "string" },
  out: { type: "string" },
  prefix: { type: "string" },
  "site-url": { type: "string" },
  "css-from": { type: "string", multiple: true },
  "plugin-from": { type: "string" },
  "wp-from": { type: "string" },
  "no-plugin-css": { type: "boolean" },
  "no-core-css": { type: "boolean" },
  uploads: { type: "string" },
  "component-prefix": { type: "string" },
  "post-types": { type: "string" },
  "route-type": { type: "string", multiple: true },
  "dry-run": { type: "boolean" },
  "no-media": { type: "boolean" },
  install: { type: "boolean" },
  validate: { type: "boolean" },
  build: { type: "boolean" },
  strict: { type: "boolean" },
  "allow-errors": { type: "boolean" },
  force: { type: "boolean" },
  presets: { type: "boolean" },
  "prune-css": { type: "boolean" },
  "inline-gaps": { type: "string" },
  "css-cache": { type: "string" },
  "css-cache-absent-ttl": { type: "string" },
  "image-formats": { type: "string" },
  concurrency: { type: "string" },
  jx: { type: "string" },
  quiet: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const INVENTORY_FLAGS = {
  db: { type: "string" },
  prefix: { type: "string" },
  "post-types": { type: "string" },
  "route-type": { type: "string", multiple: true },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

function parse<
  T extends Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }>,
>(
  args: string[],
  options: T,
): ReturnType<typeof parseArgs<{ options: T; allowPositionals: true; args: string[] }>> {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

const list = (text: string | undefined): string[] | undefined =>
  text === undefined
    ? undefined
    : [
        ...new Set(
          text
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ];

/** The rewrite rule of a post type registered in code: what `--route-type` spells. */
type RouteTypes = NonNullable<MigrateOptions["routeTypes"]>;

const ROUTE_TYPE_OPTIONS = "hierarchical, archive, archive:<slug>, slug:<base>, no-front, private";

/**
 * `--route-type <type>[=opt,opt]` values: the rewrite rule of each plugin post type (`RouteOptions.postTypes`).
 * Without options the type is routed flat at its own name, which is WordPress's default for a type
 * registered with no `rewrite` argument.
 */
function routeTypesOf(values: string[] | undefined): RouteTypes | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const out: Record<string, RouteTypes[string]> = {};
  for (const value of values) {
    const eq = value.indexOf("=");
    const type = (eq === -1 ? value : value.slice(0, eq)).trim();
    if (!/^[\w-]+$/.test(type)) {
      throw new UsageError(
        `--route-type ${JSON.stringify(value)}: a post type name is letters, digits, - and _ (--route-type <type>[=opts])`,
      );
    }
    if (type in out) throw new UsageError(`--route-type names ${type} twice`);
    const rule: RouteTypes[string] = {};
    const given = eq === -1 ? "" : value.slice(eq + 1);
    for (const raw of given.split(",")) {
      const opt = raw.trim();
      if (opt === "") continue;
      const colon = opt.indexOf(":");
      const key = colon === -1 ? opt : opt.slice(0, colon);
      const arg = colon === -1 ? undefined : opt.slice(colon + 1).trim();
      switch (key) {
        case "hierarchical":
          rule.hierarchical = true;
          break;
        case "no-front":
          rule.rewriteWithFront = false;
          break;
        case "private":
          rule.public = false;
          break;
        case "archive":
          rule.hasArchive = arg === undefined || arg === "" ? true : arg;
          break;
        case "slug":
          if (arg === undefined || arg === "") {
            throw new UsageError(
              `--route-type ${type}: slug: needs the rewrite base (slug:reviews)`,
            );
          }
          rule.rewriteSlug = arg.replace(/^\/+|\/+$/g, "");
          break;
        default:
          throw new UsageError(
            `--route-type ${type}: unknown option ${JSON.stringify(opt)} (${ROUTE_TYPE_OPTIONS})`,
          );
      }
    }
    out[type] = rule;
  }
  return out;
}

function dbOf(value: string | undefined, io: CliIo): string {
  const url = value ?? io.env.WP2JX_DB;
  if (url === undefined || url.trim() === "") {
    throw new UsageError("--db <url> is required (or set WP2JX_DB)");
  }
  return url.trim();
}

/** `--css-from` values: a folder and/or an address, each used once. */
function cssFromOf(
  values: string[] | undefined,
  cache: string | undefined,
  absentTtl: string | undefined,
  io: CliIo,
) {
  const from: { dir?: string; url?: string; cacheDir?: string; absentTtlMs?: number } = {};
  for (const value of values ?? []) {
    if (isUrl(value)) {
      if (from.url !== undefined) throw new UsageError("--css-from names two addresses; use one");
      from.url = value;
    } else {
      if (from.dir !== undefined) throw new UsageError("--css-from names two folders; use one");
      const dir = resolve(io.cwd, value);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new UsageError(`--css-from ${value}: no such directory`);
      }
      from.dir = dir;
    }
  }
  if (cache !== undefined) from.cacheDir = resolve(io.cwd, cache);
  if (absentTtl !== undefined) {
    const hours = absentTtl.trim() === "" ? Number.NaN : Number(absentTtl);
    if (!Number.isFinite(hours) || hours < 0) {
      throw new UsageError(
        `--css-cache-absent-ttl ${JSON.stringify(absentTtl)}: hours, zero or more (0 asks the site every time)`,
      );
    }
    if (cache === undefined) {
      throw new UsageError("--css-cache-absent-ttl needs --css-cache: the markers live in it");
    }
    from.absentTtlMs = hours * 3_600_000;
  }
  return from;
}

const localOrUrl = (value: string | undefined, flag: string, io: CliIo): string | undefined => {
  if (value === undefined) return undefined;
  if (isUrl(value)) return value;
  const dir = resolve(io.cwd, value);
  if (!existsSync(dir)) throw new UsageError(`${flag} ${value}: no such directory`);
  return dir;
};

/**
 * `--image-formats` value as the `images` of `project.json`: the formats in order, once each, or
 * `jx` (`{}`) for none, which leaves Jx's own settings in force.
 */
function imagesOf(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "jx") return {};
  const formats = list(value);
  if (
    formats === undefined ||
    formats.length === 0 ||
    formats.some((f) => f === "jx" || !/^[a-z0-9]+$/.test(f))
  ) {
    throw new UsageError(
      `--image-formats ${JSON.stringify(value)}: a comma separated list of formats (webp,avif), or jx for Jx's own settings`,
    );
  }
  return { formats };
}

/** What `convert` was asked, validated. */
export interface ConvertArgs {
  options: MigrateOptions;
  allowErrors: boolean;
  quiet: boolean;
  force: boolean;
  secrets: string[];
  db: string;
}

export function parseConvertArgs(args: string[], io: CliIo): ConvertArgs | "help" {
  const { values, positionals } = parse(args, CONVERT_FLAGS);
  if (values.help === true) return "help";
  if (positionals.length > 0) {
    throw new UsageError(`unexpected argument ${JSON.stringify(positionals[0])}`);
  }
  const db = dbOf(values.db, io);
  const dryRun = values["dry-run"] === true;
  if (values.out === undefined && !dryRun) {
    throw new UsageError("--out <dir> is required (a dry run may leave it out and writes nothing)");
  }
  if (
    values.out === undefined &&
    (values.install === true || values.validate === true || values.build === true)
  ) {
    throw new UsageError("--install, --validate and --build run on the output, so they need --out");
  }
  if (values.strict === true && values.validate !== true) {
    throw new UsageError("--strict is a way of running --validate");
  }
  const gaps = values["inline-gaps"];
  if (gaps !== undefined && gaps !== "report" && gaps !== "innerHTML") {
    throw new UsageError(`--inline-gaps is report or innerHTML, not ${JSON.stringify(gaps)}`);
  }
  let concurrency: number | undefined;
  if (values.concurrency !== undefined) {
    concurrency = Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
      throw new UsageError("--concurrency is a whole number from 1 to 64");
    }
  }
  const cssFrom = cssFromOf(
    values["css-from"],
    values["css-cache"],
    values["css-cache-absent-ttl"],
    io,
  );
  if (values["no-plugin-css"] === true && values["plugin-from"] !== undefined) {
    throw new UsageError("--no-plugin-css and --plugin-from say opposite things");
  }
  if (values["no-core-css"] === true && values["wp-from"] !== undefined) {
    throw new UsageError("--no-core-css and --wp-from say opposite things");
  }
  const routeTypes = routeTypesOf(values["route-type"]);
  const images = imagesOf(values["image-formats"]);
  const listed = list(values["post-types"]);
  // A type that was given its rewrite rule is one the person wants migrated.
  const postTypes =
    listed === undefined || routeTypes === undefined
      ? listed
      : [...new Set([...listed, ...Object.keys(routeTypes)])];
  const pluginFrom =
    values["no-plugin-css"] === true
      ? (false as const)
      : localOrUrl(values["plugin-from"], "--plugin-from", io);
  const wpFrom =
    values["no-core-css"] === true
      ? (false as const)
      : localOrUrl(values["wp-from"], "--wp-from", io);
  const uploads = localOrUrl(values.uploads, "--uploads", io);
  const verify =
    values.install === true || values.validate === true || values.build === true
      ? {
          ...(values.install === true ? { install: true } : {}),
          ...(values.validate === true ? { validate: true } : {}),
          ...(values.build === true ? { build: true } : {}),
          ...(values.strict === true ? { strict: true } : {}),
          ...(values.jx === undefined ? {} : { jx: { bin: resolve(io.cwd, values.jx) } }),
        }
      : undefined;
  const options: MigrateOptions = {
    db,
    ...(cssFrom.dir === undefined && cssFrom.url === undefined && cssFrom.cacheDir === undefined
      ? {}
      : { cssFrom }),
    ...(values.out === undefined ? {} : { out: resolve(io.cwd, values.out) }),
    ...(values.prefix === undefined ? {} : { prefix: values.prefix }),
    ...(values["site-url"] === undefined ? {} : { siteUrl: values["site-url"] }),
    ...(pluginFrom === undefined ? {} : { pluginFrom }),
    ...(wpFrom === undefined ? {} : { wpFrom }),
    ...(uploads === undefined ? {} : { uploads }),
    ...(values["component-prefix"] === undefined
      ? {}
      : { componentPrefix: values["component-prefix"] }),
    ...(postTypes === undefined ? {} : { postTypes }),
    ...(routeTypes === undefined ? {} : { routeTypes }),
    ...(dryRun ? { dryRun: true } : {}),
    ...(values["no-media"] === true ? { media: false } : {}),
    ...(values.presets === true ? { presets: true } : {}),
    ...(values["prune-css"] === true ? { pruneCompat: true } : {}),
    ...(gaps === undefined ? {} : { inlineGaps: gaps }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(images === undefined ? {} : { images }),
    ...(verify === undefined ? {} : { verify }),
  };
  return {
    options,
    allowErrors: values["allow-errors"] === true,
    quiet: values.quiet === true,
    force: values.force === true,
    secrets: dbSecrets(db),
    db,
  };
}

/**
 * A directory this tool may write into: missing, empty, or holding its own manifest. Anything else is
 * somebody's files, which `--force` accepts.
 */
function checkOutDir(out: string): string | undefined {
  if (!existsSync(out)) return undefined;
  if (!statSync(out).isDirectory()) return `${out} exists and is not a directory`;
  if (existsSync(join(out, MANIFEST_PATH))) return undefined;
  const entries = readdirSync(out).filter((name) => name !== ".git");
  return entries.length === 0
    ? undefined
    : `${out} is not empty and has no ${MANIFEST_PATH} (this tool did not write it); pass --force to write into it anyway`;
}

// ── convert ──────────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** The summary the run prints to stdout. */
export function renderSummary(result: MigrationResult, args: ConvertArgs): string {
  const o = args.options;
  const c = result.counts;
  // The summary is made of counts and the report's own titles. What came from outside it (the site's
  // address, the output path) is masked where it is used, so a password that is a common word cannot
  // rewrite the words around it.
  const safe = (text: string): string => redactText(text, args.secrets);
  const lines = [
    `Migrated ${safe(result.project.url as string)}${o.dryRun === true ? " (dry run)" : ""}`,
    `  ${plural(c.pages, "page")}, ${plural(c.entries, "entry", "entries")} in ${plural(c.collections, "collection")}, ${plural(c.components, "component")}, ${plural(c.layouts, "layout")}, ${plural(c.redirects, "redirect")}`,
    `  files: ${result.files.written.length} written, ${result.files.unchanged.length} unchanged, ${result.files.removed.length} removed${result.files.kept.length > 0 ? `, ${result.files.kept.length} stale kept (edited)` : ""}`,
  ];
  const m = result.media;
  lines.push(
    o.media === false
      ? `  media: left out (${m.planned} files referenced)`
      : o.dryRun === true
        ? `  media: ${m.planned} files referenced, none fetched (dry run)`
        : `  media: ${m.downloaded} fetched (${(m.bytes / 1e6).toFixed(1)} MB), ${m.skipped} already there, ${m.failed} failed`,
  );
  const s = result.summary.bySeverity;
  const where = o.out === undefined ? "" : ` (${safe(join(o.out, "migration-report.md"))})`;
  lines.push(
    `  report: ${plural(s.error, "error")}, ${plural(s.warn, "warning")}, ${s.info} info${where}`,
  );
  if (result.verify?.install !== undefined) {
    const i = result.verify.install;
    lines.push(`  bun install: ${i.ok ? "ok" : "FAILED"} (${seconds(i.ms)})`);
  }
  if (result.verify?.validate !== undefined) {
    const v = result.verify.validate;
    lines.push(`  jx validate: ${v.ok ? "ok" : "FAILED"} (${seconds(v.ms)})`);
  }
  if (result.verify?.build !== undefined) {
    const b = result.verify.build;
    lines.push(
      `  jx build: ${b.ok ? "ok" : "FAILED"} (${seconds(b.ms)}${b.routes === undefined ? "" : `, ${b.routes} routes, ${b.files ?? "?"} files`})`,
    );
  }
  if (result.decisions.length > 0) {
    lines.push("  decisions for the site owner:");
    for (const d of result.decisions) lines.push(`    - ${d.title} (${d.count})`);
  }
  lines.push(`  time: ${seconds(result.timings.total ?? 0)}`);
  return `${lines.join("\n")}\n`;
}

async function convert(args: string[], io: CliIo): Promise<number> {
  const parsed = parseConvertArgs(args, io);
  if (parsed === "help") {
    io.stdout(HELP);
    return 0;
  }
  const { options, secrets } = parsed;
  const safe = (text: string): string => redactText(text, secrets);
  if (options.out !== undefined && !parsed.force) {
    const problem = checkOutDir(options.out);
    if (problem !== undefined) throw new UsageError(problem);
  }
  const started = performance.now();
  if (!parsed.quiet) io.stderr(`wp2jx: reading ${redactDbUrl(parsed.db)}\n`);
  const result = await migrateSite({
    ...options,
    // `--force` also accepts another site's project in the directory: the run says so and replaces it.
    ...(parsed.force ? { force: true } : {}),
    progress: parsed.quiet
      ? () => {}
      : (event) => {
          // A counted phase (the media) reports often: one line in ten, and the last.
          if (event.total !== undefined && event.done !== undefined) {
            const step = Math.max(1, Math.floor(event.total / 10));
            if (event.done !== event.total && event.done % step !== 0) return;
          }
          io.stderr(
            `[${seconds(performance.now() - started).padStart(7)}] ${event.phase}: ${safe(event.message)}\n`,
          );
        },
  });
  io.stdout(renderSummary(result, parsed));
  const failed =
    result.verify?.install?.ok === false ||
    result.verify?.validate?.ok === false ||
    result.verify?.build?.ok === false;
  if (!parsed.allowErrors && (result.summary.bySeverity.error > 0 || failed)) {
    io.stderr(
      `wp2jx: the report has ${plural(result.summary.bySeverity.error, "error")}${failed ? " and jx did not pass" : ""}; exiting 1 (--allow-errors to accept)\n`,
    );
    return 1;
  }
  return 0;
}

// ── inventory ────────────────────────────────────────────────────────────────────────────────────

export interface Inventory {
  site: {
    url: string;
    name: string;
    description: string;
    theme: string;
    language: string;
    permalinkStructure: string;
    showOnFront: string;
    prefix: string;
  };
  /** Every post type in the database by status, and whether a conversion takes it. */
  postTypes: {
    type: string;
    total: number;
    statuses: Record<string, number>;
    converted: boolean;
    why?: string;
  }[];
  taxonomies: { taxonomy: string; terms: number }[];
  /** Block names over the content a conversion would read (published and private posts). */
  blocks: { name: string; count: number; posts: number }[];
  freeformPosts: number;
  /** Cwicly tokens (`{name=args}`, `<ccd>…</ccd>`) by name; `known` says the plugin's own table has the name. */
  tokens: { name: string; count: number; known: boolean }[];
  shortcodes: { name: string; count: number }[];
  forms: { kind: string; count: number }[];
  acf: {
    postTypes: string[];
    taxonomies: string[];
    optionsPages: string[];
    groups: { title: string; fields: number; active: boolean }[];
  };
  plugins: string[];
  cwicly: {
    version: string | undefined;
    components: number;
    templates: number;
    templateParts: number;
    reusableBlocks: number;
    globalClasses: number;
    breakpoints: string;
    colours: number;
  };
  media: { attachments: number };
  menus: number;
  redirects: number;
}

const TOKEN_NAME = /^[A-Za-z][\w-]*$/;

const FORM_BLOCK = /fluent|wpforms|gravity|ninja|contact-form-7|cf7|formidable|forminator/i;
const FORM_SHORTCODE =
  /fluent|wpforms|gravity|ninja|contact-form|cf7|formidable|forminator|mailchimp|mc4wp/i;

/** `[name attr="x"]` and `[/name]` in markup, comments (block delimiters) left out. */
function shortcodesIn(content: string): string[] {
  const text = content.replace(/<!--[\s\S]*?-->/g, " ");
  const found: string[] = [];
  for (const m of text.matchAll(/\[\/?([A-Za-z][\w-]{1,40})(?=[\s\]/])/g)) {
    const name = m[1]!.toLowerCase();
    if (name === "object" || name === "email") continue;
    found.push(name);
  }
  return found;
}

const bump = (map: Map<string, number>, key: string, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

const ranked = (map: Map<string, number>): [string, number][] =>
  [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/** The census of a site's database. */
export async function buildInventory(opts: {
  db: string;
  prefix?: string | undefined;
  postTypes?: string[] | undefined;
  /** The rewrite rules of plugin post types (`--route-type`): a type with one has an address, so a conversion takes it. */
  routeTypes?: MigrateOptions["routeTypes"] | undefined;
}): Promise<Inventory> {
  const db = await openDb(opts.db, opts.prefix === undefined ? {} : { prefix: opts.prefix });
  try {
    const report = createReport();
    const counted = await db.query<{ post_type: string; post_status: string; n: number | string }>(
      `select post_type, post_status, count(*) as n from ${db.table("posts")} where post_status not in ('trash', 'auto-draft') group by post_type, post_status order by post_type, post_status`,
    );
    const postTypes = opts.postTypes ?? (await publishedPostTypes(db));
    const model = await loadModel(db, { postTypes, report });
    const acf = loadAcf(model, report);
    const options = readCwiclyOptions(model.options, report);

    const byType = new Map<string, { total: number; statuses: Record<string, number> }>();
    for (const row of counted) {
      const entry = byType.get(row.post_type) ?? { total: 0, statuses: {} };
      const n = Number(row.n);
      entry.total += n;
      entry.statuses[row.post_status] = n;
      byType.set(row.post_type, entry);
    }
    // Why a type is left out: the same census a conversion makes.
    const excluded = createReport();
    await reportExcludedTypes(db, postTypes, excluded);
    const why = new Map<string, string>();
    for (const entry of excluded.entries()) {
      const type = entry.data?.type;
      if (typeof type === "string") why.set(type, String(entry.data?.reason ?? "left out"));
    }
    // Attachments and menu items are loaded whatever the list says: content refers to them.
    const wanted = new Set([...postTypes, "attachment", "nav_menu_item"]);
    // A content type is converted when it has an address on the migrated site (a plugin's has none).
    const routes = buildRoutes(model, acf, {
      report: createReport(),
      ...(opts.routeTypes === undefined ? {} : { postTypes: opts.routeTypes }),
    });
    const routed = new Set<string>();
    for (const route of routes.all())
      if (route.kind === "entry" && route.type !== undefined) routed.add(route.type);
    const structural = new Set([...STRUCTURAL_POST_TYPES, "attachment", "nav_menu_item"]);
    const noAddress = (type: string): boolean =>
      wanted.has(type) && !structural.has(type) && !type.startsWith("acf-") && !routed.has(type);

    const blocks = new Map<string, number>();
    const blockPosts = new Map<string, number>();
    const tokens = new Map<string, number>();
    const shortcodes = new Map<string, number>();
    let freeform = 0;
    const taxonomies = new Map<string, number>();
    for (const term of model.terms.values()) {
      bump(taxonomies, term.taxonomy);
    }
    for (const post of model.posts.values()) {
      if (post.status !== "publish" && post.status !== "private") continue;
      if (post.type === "attachment" || post.type.startsWith("acf-") || post.content === "")
        continue;
      const tree = parseBlocks(post.content);
      const counts = countBlocks(tree);
      if (tree.some((b) => b.name === null)) freeform++;
      for (const [name, n] of counts) {
        bump(blocks, name, n);
        bump(blockPosts, name);
      }
      // A CSS or JSON brace is no token: a name is an identifier, as the plugin's own table has them.
      for (const t of findTokens(post.content)) if (TOKEN_NAME.test(t.name)) bump(tokens, t.name);
      for (const name of shortcodesIn(post.content)) bump(shortcodes, name);
    }

    const forms = new Map<string, number>();
    for (const [name, n] of blocks) if (FORM_BLOCK.test(name)) bump(forms, `block:${name}`, n);
    for (const [name, n] of shortcodes)
      if (FORM_SHORTCODE.test(name)) bump(forms, `shortcode:${name}`, n);

    const ofType = (type: string): number =>
      [...model.posts.values()].filter((p) => p.type === type && p.status === "publish").length;
    const components = componentInfos(model);
    return {
      site: {
        url: model.site.url,
        name: decodeEntities(model.site.name),
        description: decodeEntities(model.site.description),
        theme: model.site.theme,
        language: model.site.language,
        permalinkStructure: model.site.permalinkStructure,
        showOnFront: model.site.showOnFront,
        prefix: db.prefix,
      },
      postTypes: [...byType]
        .sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1))
        .map(([type, v]) => ({
          type,
          total: v.total,
          statuses: v.statuses,
          converted: wanted.has(type) && !noAddress(type),
          ...(noAddress(type)
            ? {
                why: "no address on the migrated site: a plugin's or code's post type, give it a rewrite rule (--route-type)",
              }
            : wanted.has(type)
              ? {}
              : {
                  why:
                    why.get(type) ??
                    (DEFAULT_EXCLUDED_POST_TYPES.includes(type) ? "bookkeeping" : "left out"),
                }),
        })),
      taxonomies: ranked(taxonomies).map(([taxonomy, n]) => ({ taxonomy, terms: n })),
      blocks: ranked(blocks).map(([name, count]) => ({
        name,
        count,
        posts: blockPosts.get(name) ?? 0,
      })),
      freeformPosts: freeform,
      tokens: ranked(tokens).map(([name, count]) => ({ name, count, known: isKnownToken(name) })),
      shortcodes: ranked(shortcodes).map(([name, count]) => ({ name, count })),
      forms: ranked(forms).map(([kind, count]) => ({ kind, count })),
      acf: {
        postTypes: [...acf.postTypes.keys()].sort(),
        taxonomies: [...acf.taxonomies.keys()].sort(),
        optionsPages: acf.optionsPages.map((page) => page.slug).sort(),
        groups: acf.groups.map((g) => ({
          title: decodeEntities(g.title),
          fields: g.fields.length,
          active: g.active,
        })),
      },
      plugins: [...model.site.activePlugins].sort(),
      cwicly: {
        version: options.version,
        components: components.size,
        templates: ofType("wp_template"),
        templateParts: ofType("wp_template_part"),
        reusableBlocks: ofType("wp_block"),
        globalClasses: options.globalClassNames.size,
        breakpoints: options.breakpoints
          .map((b) => `${b.key} ${b.width}${b.isMain ? " (main)" : ""}`)
          .join(", "),
        colours: options.globalStyles.colors.length,
      },
      media: { attachments: model.attachments.size },
      menus: [...model.terms.values()].filter((t) => t.taxonomy === "nav_menu").length,
      redirects: model.redirects.length,
    };
  } finally {
    await db.close();
  }
}

/**
 * The census with the secrets masked out of the text the database supplies (the site's own words and
 * the plugins' and groups' names). Post types, blocks, tokens and shortcodes are identifiers: a
 * password that is a common word must not turn `post` into `***` in the very table that counts them.
 */
export function redactInventory(inv: Inventory, secrets: readonly string[]): Inventory {
  if (secrets.length === 0) return inv;
  const mask = (text: string): string => redactText(text, secrets);
  return {
    ...inv,
    site: {
      ...inv.site,
      url: mask(inv.site.url),
      name: mask(inv.site.name),
      description: mask(inv.site.description),
    },
    acf: { ...inv.acf, groups: inv.acf.groups.map((g) => ({ ...g, title: mask(g.title) })) },
    plugins: inv.plugins.map(mask),
  };
}

const pad = (text: string, width: number): string => text.padEnd(width);

/** The census as text. */
export function renderInventory(inv: Inventory): string {
  const out: string[] = [];
  const section = (title: string, rows: string[]): void => {
    out.push("", title, ...(rows.length === 0 ? ["  (none)"] : rows.map((r) => `  ${r}`)));
  };
  out.push(`${inv.site.name} (${inv.site.url})`);
  out.push(
    `theme ${inv.site.theme}, language ${inv.site.language}, permalinks ${inv.site.permalinkStructure || "plain"}, front: ${inv.site.showOnFront}, table prefix ${inv.site.prefix}`,
  );
  const w = Math.max(4, ...inv.postTypes.map((p) => p.type.length));
  section(
    "Post types",
    inv.postTypes.map(
      (p) =>
        `${pad(p.type, w)} ${String(p.total).padStart(6)}  ${Object.entries(p.statuses)
          .map(([s, n]) => `${s} ${n}`)
          .join(", ")}${p.converted ? "" : `  [left out: ${p.why ?? "?"}]`}`,
    ),
  );
  section(
    "Taxonomies",
    inv.taxonomies.map((t) => `${t.taxonomy}: ${t.terms} terms`),
  );
  section(
    `Blocks (${inv.freeformPosts} posts hold classic HTML)`,
    inv.blocks
      .slice(0, 40)
      .map((b) => `${pad(b.name, 36)} ${String(b.count).padStart(6)} in ${b.posts} posts`),
  );
  if (inv.blocks.length > 40) out.push(`  ... and ${inv.blocks.length - 40} more`);
  section(
    "Cwicly tokens",
    inv.tokens
      .slice(0, 40)
      .map((t) => `${pad(t.name, 28)} ${t.count}${t.known ? "" : "  (not in the plugin's table)"}`),
  );
  section(
    "Shortcodes",
    inv.shortcodes.slice(0, 30).map((s) => `${pad(s.name, 28)} ${s.count}`),
  );
  section(
    "Forms",
    inv.forms.map((f) => `${pad(f.kind, 40)} ${f.count}`),
  );
  section("ACF", [
    `post types: ${inv.acf.postTypes.join(", ") || "none"}`,
    `taxonomies: ${inv.acf.taxonomies.join(", ") || "none"}`,
    `options pages: ${inv.acf.optionsPages.join(", ") || "none"}`,
    ...inv.acf.groups.map(
      (g) => `group ${g.title}: ${g.fields} fields${g.active ? "" : " (inactive)"}`,
    ),
  ]);
  section("Cwicly", [
    `version ${inv.cwicly.version ?? "unknown"}`,
    `${inv.cwicly.components} components, ${inv.cwicly.templates} templates, ${inv.cwicly.templateParts} template parts, ${inv.cwicly.reusableBlocks} reusable blocks`,
    `${inv.cwicly.globalClasses} global classes, ${inv.cwicly.colours} palette colours`,
    `breakpoints ${inv.cwicly.breakpoints}`,
  ]);
  section(
    "Active plugins",
    inv.plugins.map((p) => p),
  );
  out.push(
    "",
    `${inv.media.attachments} attachments, ${inv.menus} menus, ${inv.redirects} Rank Math redirect sources`,
  );
  return `${out.join("\n")}\n`;
}

async function inventory(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, INVENTORY_FLAGS);
  if (values.help === true) {
    io.stdout(HELP);
    return 0;
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected argument ${JSON.stringify(positionals[0])}`);
  }
  const url = dbOf(values.db, io);
  const routeTypes = routeTypesOf(values["route-type"]);
  const listed = list(values["post-types"]);
  const postTypes =
    listed === undefined || routeTypes === undefined
      ? listed
      : [...new Set([...listed, ...Object.keys(routeTypes)])];
  const inv = redactInventory(
    await buildInventory({
      db: url,
      ...(values.prefix === undefined ? {} : { prefix: values.prefix }),
      ...(postTypes === undefined ? {} : { postTypes }),
      ...(routeTypes === undefined ? {} : { routeTypes }),
    }),
    dbSecrets(url),
  );
  io.stdout(values.json === true ? `${JSON.stringify(inv, null, 2)}\n` : renderInventory(inv));
  return 0;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

/** Run the command line; returns the exit code. */
export async function main(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const [command, ...rest] = argv;
  // A password may be in the environment or in any argument: `--db mysql://u:p@h/d`, `--db=mysql://…`.
  const secrets = [
    ...dbSecrets(io.env.WP2JX_DB ?? ""),
    ...argv.flatMap((arg) => dbSecrets(arg.replace(/^--db=/, ""))),
  ];
  try {
    switch (command) {
      case undefined:
      case "--help":
      case "-h":
      case "help":
        io.stdout(HELP);
        return command === undefined ? 2 : 0;
      case "--version":
      case "-v":
        io.stdout("wp2jx 0.0.0\n");
        return 0;
      case "convert":
        return await convert(rest, io);
      case "inventory":
        return await inventory(rest, io);
      case "verify":
        return await verifyCommand(rest, io);
      default:
        throw new UsageError(`unknown command ${JSON.stringify(command)}; try wp2jx --help`);
    }
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error), secrets);
    if (error instanceof UsageError) {
      io.stderr(`wp2jx: ${message}\n`);
      return 2;
    }
    io.stderr(`wp2jx: ${message}\n`);
    return 3;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
