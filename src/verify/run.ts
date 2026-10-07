/**
 * `wp2jx verify`: build (when asked), serve the project's `dist/`, drive one browser over the live
 * site and the local one, URL by URL and viewport by viewport, and write the report.
 *
 * It fails only on tool errors (no `dist/`, no Chrome, nothing to compare, the live site
 * unreachable for every page, a build that did not build). A page that scores 40% is a finding, not
 * a failure: the caller decides what to do with the numbers.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import {
  launchBrowser,
  withMasks,
  DEFAULT_NOISE,
  type Capture,
  type NoiseConfig,
  type VerifyBrowser,
} from "./browser.ts";
import {
  comparePixels,
  compareDocuments,
  domFindings,
  pageFindings,
  visualFindings,
} from "./compare.ts";
import { parseRedirects, rulesFromProject, type RedirectRule } from "./redirects.ts";
import {
  buildReport,
  keepWorstImages,
  shotsDir,
  ShotKeeper,
  writeReport,
  type SkippedUrl,
  type VerifyReport,
} from "./report.ts";
import { resolveRequest, startStaticServer, type StaticServer } from "./serve.ts";
import type { Finding, PageSnapshot, UrlResult, ViewportResult } from "./types.ts";
import {
  createResolver,
  pathOf,
  readLiveSitemaps,
  readUrlFile,
  sample,
  slugOf,
  type Fetcher,
  type Resolver,
} from "./urls.ts";

export interface VerifyOptions {
  /** The migrated project's directory. */
  out: string;
  /** The live site's address. Defaults to the project's `url`. */
  live?: string;
  /** `sitemap` (default: the live site's sitemaps, restricted to what the migrated site serves), `all` (the same, unrestricted), or a file. */
  urls?: string;
  max?: number;
  /** Default 1366 and 390. */
  viewports?: number[];
  /** Only URLs whose path contains this. */
  only?: string;
  /** Run `jx build` in the project first. */
  build?: boolean;
  /** Extra CSS selectors to blank (`visibility:hidden`) on both sides. */
  masks?: string[];
  /** Selectors taken out of the layout on both sides (`display: none`). */
  removes?: string[];
  /** Where the reports go. Default `<out>/.wp2jx-verify`. */
  reportDir?: string;
  /** URLs in flight. Default 1. */
  concurrency?: number;
  /** The jx binary for `--build`. */
  jx?: string;
  chrome?: string;
  /** Pixelmatch colour tolerance. Default 0.1. */
  tolerance?: number;
  /** Pages that keep their images. Default 20. */
  images?: number;
  /** Replaces the default noise masks and blocked hosts entirely. */
  noise?: NoiseConfig;
  /**
   * Keep the live captures here (a JSON snapshot and a PNG per page, viewport and noise setting) and
   * reuse them on the next run, so a fix loop pays for the live site once and re-captures only the
   * migrated pages. Delete the folder to see the live site again.
   */
  liveCache?: string;
  /** Progress lines, one per page. */
  progress?: (message: string) => void;
  fetcher?: Fetcher;
  /** A started browser to use (and not close); for tests. */
  browser?: VerifyBrowser;
}

export interface VerifyOutcome {
  report: VerifyReport;
  files: { json: string; md: string };
  /** What the command prints. */
  summary: string;
}

export const DEFAULT_VIEWPORTS = [1366, 390];

const JX_BIN = join(import.meta.dir, "../../node_modules/.bin/jx");

export class VerifyError extends Error {}

function readProject(out: string): {
  url?: string;
  redirects?: Parameters<typeof rulesFromProject>[0];
} {
  const file = join(out, "project.json");
  if (!existsSync(file)) throw new VerifyError(`${out} is not a Jx project: no project.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { url?: string };
  } catch (error) {
    throw new VerifyError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

async function build(dir: string, jx: string, log: (m: string) => void): Promise<void> {
  log(`building ${dir} with ${jx}`);
  const proc = Bun.spawn([jx, "build"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const timer = setTimeout(() => proc.kill(), 30 * 60_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) {
    const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-12).join("\n");
    throw new VerifyError(`jx build failed (exit ${code}):\n${tail}`);
  }
}

function localRedirects(dist: string, project: ReturnType<typeof readProject>): RedirectRule[] {
  const file = join(dist, "_redirects");
  if (existsSync(file)) return parseRedirects(readFileSync(file, "utf8"));
  return rulesFromProject(project.redirects);
}

/** Whether the migrated site answers an address with a page or a redirect, the way the host would. */
export function isServed(dist: string, path: string, rules: readonly RedirectRule[]): boolean {
  const resolved = resolveRequest(dist, path.split("?")[0] ?? path, rules);
  return resolved.kind === "redirect" || (resolved.kind === "file" && resolved.status === 200);
}

export async function runVerify(options: VerifyOptions): Promise<VerifyOutcome> {
  const log = options.progress ?? (() => {});
  const out = resolve(options.out);
  const project = readProject(out);
  const live = options.live ?? project.url;
  if (live === undefined || live === "") {
    throw new VerifyError(
      "no live address: pass --live <site url> (the project has no `url` either)",
    );
  }
  try {
    new URL(live);
  } catch {
    throw new VerifyError(`--live ${JSON.stringify(live)} is not a URL`);
  }
  const viewports = options.viewports ?? DEFAULT_VIEWPORTS;
  if (
    viewports.length === 0 ||
    viewports.some((w) => !Number.isInteger(w) || w < 200 || w > 5000)
  ) {
    throw new VerifyError(
      `--viewports takes widths between 200 and 5000, comma separated (got ${viewports.join(",")})`,
    );
  }
  const reportDir = resolve(options.reportDir ?? join(out, ".wp2jx-verify"));
  const tolerance = options.tolerance ?? 0.1;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const imageCount = options.images ?? 20;

  if (options.build === true) await build(out, options.jx ?? JX_BIN, log);
  const dist = join(out, "dist");
  if (!existsSync(dist)) {
    throw new VerifyError(
      `${dist} does not exist: run \`jx build\` in the project, or pass --build`,
    );
  }
  const rules = localRedirects(dist, project);

  // The list.
  const mode = options.urls ?? "sitemap";
  let listed: string[];
  let restrict = true;
  const skipped: SkippedUrl[] = [];
  if (mode === "sitemap" || mode === "all") {
    restrict = mode === "sitemap";
    log(`reading the sitemaps of ${live}`);
    const sitemap = await readLiveSitemaps(live, options.fetcher);
    if (sitemap.urls.length === 0) {
      throw new VerifyError(
        `${live} lists no pages in sitemap_index.xml, wp-sitemap.xml or sitemap.xml${sitemap.problems.length > 0 ? ` (${sitemap.problems.join("; ")})` : ""}; pass --urls <file>`,
      );
    }
    listed = sitemap.urls;
  } else {
    restrict = false;
    try {
      listed = readUrlFile(mode, live);
    } catch (error) {
      throw new VerifyError((error as Error).message);
    }
  }
  const total = listed.length;
  let urls = listed;
  if (options.only !== undefined && options.only !== "") {
    const needle = options.only;
    urls = urls.filter((url) => pathOf(url).includes(needle));
  }
  if (restrict) {
    urls = urls.filter((url) => {
      if (isServed(dist, pathOf(url), rules)) return true;
      skipped.push({
        url,
        reason: "not served by the migrated site (use --urls all to compare it anyway)",
      });
      return false;
    });
  }
  const chosen = sample(urls, options.max);
  if (chosen.length === 0) {
    throw new VerifyError(
      `no URL to compare: ${total} listed, ${skipped.length} not served by the migrated site, the rest filtered out`,
    );
  }
  log(`${chosen.length} URLs to compare (${total} listed, ${skipped.length} not served locally)`);

  // Serve and drive.
  // A report folder this run makes ignores itself: 300 MB of PNGs in a project is one `git add -A` from a commit.
  const fresh = !existsSync(reportDir);
  mkdirSync(reportDir, { recursive: true });
  if (fresh) writeFileSync(join(reportDir, ".gitignore"), "*\n");
  rmSync(join(reportDir, ".shots"), { recursive: true, force: true });
  let server: StaticServer | undefined;
  let browser: VerifyBrowser | undefined = options.browser;
  const ownBrowser = options.browser === undefined;
  const results: UrlResult[] = [];
  try {
    server = await startStaticServer({ root: dist, redirects: rules });
    browser ??= await launchBrowser(
      options.chrome === undefined ? {} : { executablePath: options.chrome },
    );
    const resolver = createResolver({ liveUrl: live, localOrigin: server.origin, rules });
    const noise =
      options.noise ?? withMasks(DEFAULT_NOISE, options.masks ?? [], options.removes ?? []);
    const keeper = new ShotKeeper(reportDir, imageCount);
    const slugs = new Set<string>();
    const named = chosen.map((url) => ({ url, slug: slugOf(url, slugs) }));
    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const item = named[index];
        if (item === undefined) return;
        const result = await verifyUrl({
          browser: browser as VerifyBrowser,
          server: server as StaticServer,
          resolver,
          noise,
          item,
          viewports,
          tolerance,
          reportDir,
          keeper,
          liveCache: options.liveCache === undefined ? undefined : resolve(options.liveCache),
        });
        results[index] = result;
        done += 1;
        log(
          `[${done}/${named.length}] ${result.path} ${result.fidelity === null ? "not compared" : `${(result.fidelity * 100).toFixed(1)}%`}`,
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, named.length) }, worker));

    const kept = keepWorstImages(reportDir, results, imageCount);
    const report = buildReport({
      live,
      project: out,
      viewports,
      tolerance,
      results,
      skipped,
      listed: total,
      imageCount,
    });
    const files = writeReport(reportDir, report, kept);
    const outcome: VerifyOutcome = { report, files, summary: renderSummary(report, files) };
    if (report.summary.compared === 0) {
      throw new VerifyError(
        `no page could be compared (${report.summary.failed} failed to capture); the report is in ${files.md}\n${firstErrors(results)}`,
      );
    }
    return outcome;
  } finally {
    if (ownBrowser) await browser?.close();
    await server?.close();
    rmSync(join(reportDir, ".shots"), { recursive: true, force: true });
  }
}

function firstErrors(results: UrlResult[]): string {
  const lines = results.flatMap((r) =>
    r.findings.filter((f) => f.code === "page.load-failed").map((f) => `  ${r.path}: ${f.message}`),
  );
  return lines.slice(0, 5).join("\n");
}

interface UrlJob {
  browser: VerifyBrowser;
  server: StaticServer;
  resolver: Resolver;
  noise: NoiseConfig;
  item: { url: string; slug: string };
  viewports: number[];
  tolerance: number;
  reportDir: string;
  keeper: ShotKeeper;
  liveCache?: string | undefined;
}

/** Capture and compare one URL at every viewport. Never throws: a failure becomes a finding. */
export async function verifyUrl(job: UrlJob): Promise<UrlResult> {
  const { item, resolver } = job;
  const path = pathOf(item.url);
  const localUrl = `${job.server.origin}${path}`;
  const viewports: ViewportResult[] = [];
  let pageLevel: Finding[] | undefined;
  const loadFailures: Finding[] = [];
  const dir = shotsDir(job.reportDir, item.slug);

  for (const width of job.viewports) {
    const liveCapture = await liveCaptureOf(job, item.url, width);
    const localCapture = await job.browser.capture(localUrl, { width, noise: job.noise });
    const found = pageFindings(liveCapture.snapshot, localCapture.snapshot, resolver);
    if (pageLevel === undefined) pageLevel = found;
    else loadFailures.push(...found.filter((f) => f.code === "page.load-failed"));

    const view: ViewportResult = {
      width,
      findings: [],
      liveStatus: liveCapture.snapshot.status,
      localStatus: localCapture.snapshot.status,
      liveFinalUrl: liveCapture.snapshot.finalUrl,
      localFinalUrl: localCapture.snapshot.finalUrl,
    };
    if (liveCapture.png !== undefined && localCapture.png !== undefined) {
      try {
        const { visual, diffPng } = comparePixels(liveCapture.png, localCapture.png, {
          tolerance: job.tolerance,
          viewportHeight: liveCapture.snapshot.viewport.height,
        });
        const { dom, work } = compareDocuments(
          liveCapture.snapshot,
          localCapture.snapshot,
          resolver,
        );
        view.visual = visual;
        view.dom = dom;
        view.findings.push(
          ...visualFindings(visual, liveCapture.snapshot, localCapture.snapshot, width),
          ...domFindings(dom, work, liveCapture.snapshot, localCapture.snapshot, resolver, width),
        );
        mkdirSync(dir, { recursive: true });
        await Promise.all([
          Bun.write(join(dir, `${width}-live.png`), liveCapture.png),
          Bun.write(join(dir, `${width}-local.png`), localCapture.png),
          Bun.write(join(dir, `${width}-diff.png`), diffPng),
        ]);
        view.images = {
          live: `${width}-live.png`,
          local: `${width}-local.png`,
          diff: `${width}-diff.png`,
        };
      } catch (error) {
        view.findings.push({
          code: "page.load-failed",
          severity: "error",
          viewport: width,
          message: `the comparison failed: ${(error as Error).message}`,
        });
      }
    }
    viewports.push(view);
  }

  const scored = viewports.flatMap((v) => (v.visual === undefined ? [] : [v.visual.fidelity]));
  const fidelity =
    scored.length === 0
      ? null
      : Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10_000) / 10_000;
  job.keeper.offer(item.slug, fidelity);
  return {
    url: item.url,
    path,
    slug: item.slug,
    viewports,
    fidelity,
    findings: [...(pageLevel ?? []), ...loadFailures],
  };
}

/** One retry for a live page that did not load: a flaky network is not a finding about the migration. */
async function captureWithRetry(
  browser: VerifyBrowser,
  url: string,
  width: number,
  noise: NoiseConfig,
): Promise<Capture> {
  const first = await browser.capture(url, { width, noise });
  if (first.snapshot.error === undefined) return first;
  return browser.capture(url, { width, noise });
}

/** Bumped when a snapshot gains a field the comparison reads, so an older cache is taken again. */
const CACHE_VERSION = 2;

/** A cached capture, or undefined when either file is missing, cut short or not what it should be. */
function readCached(json: string, png: string): Capture | undefined {
  if (!existsSync(json) || !existsSync(png)) return undefined;
  try {
    const bytes = Buffer.from(readFileSync(png));
    PNG.sync.read(bytes);
    return { snapshot: JSON.parse(readFileSync(json, "utf8")) as PageSnapshot, png: bytes };
  } catch {
    // A half-written entry (a killed run): take it again.
    return undefined;
  }
}

/** Write a file whole or not at all: a killed run leaves the old file or none, never a prefix. */
function writeWhole(file: string, data: string | Uint8Array): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, file);
}

/** The live capture of a page: from the cache when there is one, else taken (and kept, unless it failed). */
async function liveCaptureOf(job: UrlJob, url: string, width: number): Promise<Capture> {
  const cache = job.liveCache;
  if (cache === undefined) return captureWithRetry(job.browser, url, width, job.noise);
  const key = Bun.hash(JSON.stringify([url, width, job.noise, CACHE_VERSION])).toString(36);
  const json = join(cache, `${key}.json`);
  const png = join(cache, `${key}.png`);
  const cached = readCached(json, png);
  if (cached !== undefined) return cached;
  const capture = await captureWithRetry(job.browser, url, width, job.noise);
  if (capture.snapshot.error === undefined && capture.png !== undefined) {
    mkdirSync(cache, { recursive: true });
    // The snapshot goes last: an entry without it is not an entry.
    writeWhole(png, capture.png);
    writeWhole(json, JSON.stringify(capture.snapshot));
  }
  return capture;
}

/** What the command prints: the numbers, the worst pages, the biggest systematic differences, where the files are. */
export function renderSummary(report: VerifyReport, files: { json: string; md: string }): string {
  const s = report.summary;
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(
    `verified ${s.compared} page${s.compared === 1 ? "" : "s"} of ${s.listed} listed against ${report.live} (${s.skipped} not served locally, ${s.failed} not captured)`,
  );
  if (s.fidelity !== null) {
    lines.push(
      `fidelity: mean ${pct(s.fidelity.mean)}, median ${pct(s.fidelity.median)}, min ${pct(s.fidelity.min)}`,
    );
  }
  for (const [width, v] of Object.entries(s.byViewport))
    lines.push(`  at ${width} px: mean ${pct(v.mean)}, min ${pct(v.min)}`);
  lines.push(
    `findings: ${s.severities.error} errors, ${s.severities.warning} warnings, ${s.severities.info} notes`,
  );
  if (s.worst.length > 0) {
    lines.push("worst pages:");
    for (const w of s.worst.slice(0, 5))
      lines.push(`  ${w.fidelity === null ? "n/a" : pct(w.fidelity)}  ${w.path}`);
  }
  if (s.systematic.length > 0) {
    lines.push("biggest systematic differences:");
    for (const d of s.systematic.slice(0, 5)) {
      lines.push(
        `  ${d.elements} elements on ${d.urls} pages: ${d.group} ${d.property} ${d.live} -> ${d.local}`,
      );
    }
  }
  lines.push(`report: ${files.md}`, `        ${files.json}`);
  return `${lines.join("\n")}\n`;
}
