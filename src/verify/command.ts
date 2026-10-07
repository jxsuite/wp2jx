/**
 * The `wp2jx verify` subcommand: flags in, `runVerify` out, the summary on stdout and progress on
 * stderr. Exit codes follow the rest of the tool: 0 done (whatever the fidelity), 2 a flag the tool
 * cannot use, 3 the run could not finish.
 */
import { parseArgs } from "node:util";
import type { CliIo } from "../cli.ts";
import { DEFAULT_VIEWPORTS, runVerify, type VerifyOptions } from "./run.ts";

export const VERIFY_HELP = `wp2jx verify: compare a migrated project's built site with the live site

Usage
  wp2jx verify --out <project dir> [--live <site url>] [options]

Serves <project>/dist, drives one headless Chrome over the live URL and the local one, URL by URL and
viewport by viewport, and writes verify-report.json, verify-report.md and side-by-side images of the
worst pages. It never fails on fidelity: exit 0 with the summary; 3 only when the run could not finish.

Options
  --out <dir>              the migrated Jx project (required)
  --live <url>             the live site (default: the project's own url)
  --urls <sitemap|all|file>  sitemap (default): the live sitemaps, restricted to URLs the migrated site
                           serves (the rest are listed as not compared); all: every sitemap URL, so a
                           page the migration lost shows as an error; or a file of URLs or paths (one
                           per line, or a JSON array)
  --max <n>                at most n URLs: the home page, then an even spread over the list
  --only <substring>       only URLs whose path contains this
  --viewports <w,w>        widths to capture (default ${DEFAULT_VIEWPORTS.join(",")})
  --build                  run jx build in the project first
  --remove <selector>      take this CSS selector out of the layout on both sides (repeatable): for what
                           one side has only because the database is older than the live site
  --mask <selector>        blank this CSS selector on both sides (repeatable); the built-in masks hide
                           chat widgets, cookie banners, maps and video embeds, carousels, review
                           widgets, and fineline's injected spam block and script
  --report-dir <dir>       where the reports and images go (default <project>/.wp2jx-verify)
  --live-cache <dir>       keep the live captures here and reuse them on the next run, so a fix loop
                           re-captures only the migrated pages (delete the folder to see live again)
  --concurrency <n>        pages in flight (default 1)
  --images <n>             worst pages that keep their images (default 20)
  --tolerance <0..1>       pixelmatch colour tolerance (default 0.1)
  --jx <path>              the jx binary for --build
  --chrome <path>          the Chrome binary (default: CHROME_PATH, PATH, then the NixOS profile's)
  --quiet                  no progress
`;

const FLAGS = {
  out: { type: "string" },
  live: { type: "string" },
  urls: { type: "string" },
  max: { type: "string" },
  only: { type: "string" },
  viewports: { type: "string" },
  build: { type: "boolean" },
  mask: { type: "string", multiple: true },
  remove: { type: "string", multiple: true },
  "report-dir": { type: "string" },
  "live-cache": { type: "string" },
  concurrency: { type: "string" },
  images: { type: "string" },
  tolerance: { type: "string" },
  jx: { type: "string" },
  chrome: { type: "string" },
  quiet: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

class UsageError extends Error {}

const int = (flag: string, text: string, min: number, max: number): number => {
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(
      `--${flag} takes a whole number from ${min} to ${max} (got ${JSON.stringify(text)})`,
    );
  }
  return n;
};

/** Parse `verify`'s flags into options. Throws `UsageError` for what cannot be used. */
export function parseVerifyArgs(args: string[]): VerifyOptions | "help" {
  let parsed: ReturnType<
    typeof parseArgs<{ options: typeof FLAGS; allowPositionals: true; args: string[] }>
  >;
  try {
    parsed = parseArgs({ args, options: FLAGS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) return "help";
  if (positionals.length > 0)
    throw new UsageError(`unexpected argument ${JSON.stringify(positionals[0])}`);
  if (values.out === undefined || values.out.trim() === "")
    throw new UsageError("--out <project dir> is required");

  const options: VerifyOptions = { out: values.out };
  if (values.live !== undefined) {
    if (!/^https?:\/\//i.test(values.live))
      throw new UsageError(
        `--live takes an address starting with http:// or https:// (got ${JSON.stringify(values.live)})`,
      );
    options.live = values.live;
  }
  if (values.urls !== undefined) options.urls = values.urls;
  if (values.max !== undefined) options.max = int("max", values.max, 1, 100_000);
  if (values.only !== undefined) options.only = values.only;
  if (values.viewports !== undefined) {
    const widths = values.viewports
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    if (widths.length === 0) throw new UsageError("--viewports needs at least one width");
    options.viewports = [...new Set(widths.map((w) => int("viewports", w, 200, 5000)))];
  }
  if (values.build === true) options.build = true;
  if (values.mask !== undefined) options.masks = values.mask;
  if (values.remove !== undefined) options.removes = values.remove;
  if (values["report-dir"] !== undefined) options.reportDir = values["report-dir"];
  if (values["live-cache"] !== undefined) options.liveCache = values["live-cache"];
  if (values.concurrency !== undefined)
    options.concurrency = int("concurrency", values.concurrency, 1, 8);
  if (values.images !== undefined) options.images = int("images", values.images, 0, 1000);
  if (values.tolerance !== undefined) {
    const n = Number(values.tolerance);
    if (!Number.isFinite(n) || n < 0 || n > 1)
      throw new UsageError(
        `--tolerance takes a number from 0 to 1 (got ${JSON.stringify(values.tolerance)})`,
      );
    options.tolerance = n;
  }
  if (values.jx !== undefined) options.jx = values.jx;
  if (values.chrome !== undefined) options.chrome = values.chrome;
  return options;
}

/** Run `wp2jx verify`; returns the exit code. */
export async function verifyCommand(args: string[], io: CliIo): Promise<number> {
  try {
    const options = parseVerifyArgs(args);
    if (options === "help") {
      io.stdout(VERIFY_HELP);
      return 0;
    }
    const quiet = args.includes("--quiet");
    if (!quiet) options.progress = (message) => io.stderr(`${message}\n`);
    const outcome = await runVerify(options);
    io.stdout(outcome.summary);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`wp2jx: ${message}\n`);
    return error instanceof UsageError ? 2 : 3;
  }
}
