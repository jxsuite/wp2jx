/**
 * `runVerify` without a browser: a fake browser hands back canned captures, so the URL selection,
 * the local server, the retries, the images, the report files, the build step and every tool error
 * are exercised on real folders. (The same path against real Chrome is in browser.test.ts.)
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Capture, CaptureOptions, VerifyBrowser } from "../../src/verify/browser.ts";
import {
  isServed,
  renderSummary,
  runVerify,
  VerifyError,
  type VerifyOptions,
} from "../../src/verify/run.ts";
import { parseRedirects } from "../../src/verify/redirects.ts";
import { openServers } from "../../src/verify/serve.ts";
import type { Fetcher } from "../../src/verify/urls.ts";
import type { PageSnapshot } from "../../src/verify/types.ts";
import { TMP_ROOT } from "../helpers/jx-build.ts";

const LIVE = "https://site.test";
const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  expect(openServers()).toBe(0);
});

function tmp(name: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, `verify-run-${name}-`));
  roots.push(dir);
  return dir;
}

function png(width: number, height: number, black = 0): Buffer {
  const out = new PNG({ width, height });
  out.data.fill(255);
  for (let y = 0; y < black; y++)
    for (let x = 0; x < width; x++) out.data.set([0, 0, 0, 255], (y * width + x) * 4);
  return PNG.sync.write(out);
}

function snapshot(url: string, width: number, over: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    viewport: { width, height: 900 },
    title: "T",
    description: "",
    canonical: "",
    robots: "",
    lang: "en",
    docWidth: width,
    docHeight: 1000,
    textBlocks: [{ path: "body > p", text: "Hello there" }],
    headings: [],
    links: [],
    images: [],
    elements: [],
    overflow: { scrollWidth: width, clientWidth: width, overflow: false, offenders: [] },
    truncated: 0,
    consoleErrors: [],
    failedRequests: [],
    ...over,
  };
}

interface Fake extends VerifyBrowser {
  calls: { url: string; width: number }[];
  closed: boolean;
}

/** A browser that answers from a function: no Chrome. The default makes every local page 10% black. */
function fakeBrowser(answer?: (url: string, width: number, call: number) => Capture): Fake {
  const calls: { url: string; width: number }[] = [];
  const browser: Fake = {
    chromePath: "fake",
    calls,
    closed: false,
    async capture(url: string, options: CaptureOptions) {
      calls.push({ url, width: options.width });
      const call = calls.filter((c) => c.url === url && c.width === options.width).length;
      if (answer !== undefined) return answer(url, options.width, call);
      const local = url.startsWith("http://127.0.0.1");
      return {
        snapshot: snapshot(url, options.width),
        png: png(options.width, 100, local ? 10 : 0),
      };
    },
    async close() {
      browser.closed = true;
    },
  };
  return browser;
}

function sitemap(paths: string[]): Fetcher {
  const body = `<urlset>${paths.map((p) => `<url><loc>${LIVE}${p}</loc></url>`).join("")}</urlset>`;
  return async (url) => ({ ok: url.endsWith("/sitemap_index.xml"), text: async () => body });
}

function project(pages: string[], extra: { redirects?: string; url?: string | null } = {}): string {
  const dir = tmp("p");
  const url = extra.url === undefined ? LIVE : extra.url;
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({ name: "t", ...(url === null ? {} : { url }) }),
  );
  for (const page of pages) {
    const file =
      page === "/"
        ? join(dir, "dist/index.html")
        : join(dir, "dist", page.replace(/^\/|\/$/g, ""), "index.html");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `<h1>${page}</h1>`);
  }
  mkdirSync(join(dir, "dist"), { recursive: true });
  if (extra.redirects !== undefined) writeFileSync(join(dir, "dist/_redirects"), extra.redirects);
  return dir;
}

const run = (dir: string, over: Partial<VerifyOptions> & { paths?: string[] } = {}) => {
  const { paths, ...rest } = over;
  return runVerify({
    out: dir,
    reportDir: join(tmp("r"), "report"),
    viewports: [1366],
    images: 0,
    fetcher: sitemap(paths ?? ["/", "/about/", "/services/", "/lost/"]),
    browser: fakeBrowser(),
    ...rest,
  });
};

describe("isServed", () => {
  const dir = project(["/", "/about/"]);
  const rules = parseRedirects("/old /about/ 301\n/proxy /about/ 200\n");
  test("a page, a redirect and a rewrite are served; an unknown path is not, and the query is ignored", () => {
    expect(isServed(join(dir, "dist"), "/", rules)).toBe(true);
    expect(isServed(join(dir, "dist"), "/about/?x=1", rules)).toBe(true);
    expect(isServed(join(dir, "dist"), "/old/", rules)).toBe(true);
    expect(isServed(join(dir, "dist"), "/proxy", rules)).toBe(true);
    expect(isServed(join(dir, "dist"), "/nowhere/", rules)).toBe(false);
  });
});

describe("isServed: the 404 page does not serve", () => {
  test("a site with a 404 page still does not serve what it has no page for", () => {
    const dir = project(["/", "/about/", "/404/"]);
    expect(isServed(join(dir, "dist"), "/nowhere/", [])).toBe(false);
    expect(isServed(join(dir, "dist"), "/about/", [])).toBe(true);
  });
});

describe("runVerify: choosing the URLs", () => {
  test("by default the sitemap, restricted to what the migrated site serves; the rest are listed, not compared", async () => {
    const browser = fakeBrowser();
    const { report } = await run(project(["/", "/about/", "/services/"]), { browser });
    expect(report.urls.map((u) => u.path)).toEqual(["/", "/about/", "/services/"]);
    expect(report.summary).toMatchObject({ listed: 4, compared: 3, skipped: 1, failed: 0 });
    expect(report.skipped).toEqual([
      { url: `${LIVE}/lost/`, reason: expect.stringContaining("not served") },
    ]);
    expect(browser.closed).toBe(false);
    // Live first, then local, per page and viewport.
    expect(browser.calls[0]).toEqual({ url: `${LIVE}/`, width: 1366 });
    expect(browser.calls[1]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(browser.calls).toHaveLength(6);
  });

  test("a redirect rule makes a URL expected: it is compared at its destination", async () => {
    const { report } = await run(
      project(["/", "/about/", "/services/"], { redirects: "/lost /about/ 301\n" }),
    );
    expect(report.urls.map((u) => u.path)).toEqual(["/", "/about/", "/services/", "/lost/"]);
    expect(report.skipped).toEqual([]);
  });

  test("project.json redirects are used when the build wrote no _redirects", async () => {
    const dir = project(["/", "/about/", "/services/"]);
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({ name: "t", url: LIVE, redirects: { "/lost": "/about/" } }),
    );
    const { report } = await run(dir);
    expect(report.urls.map((u) => u.path)).toContain("/lost/");
  });

  test("--urls all compares every listed URL, so a page the migration lost shows up as an error", async () => {
    const browser = fakeBrowser((url, width) => {
      const local = url.startsWith("http://127.0.0.1");
      const lost = url.endsWith("/lost/");
      return {
        snapshot: snapshot(url, width, local && lost ? { status: 404 } : {}),
        png: png(width, 100),
      };
    });
    const { report } = await run(project(["/", "/about/", "/services/"]), { urls: "all", browser });
    expect(report.summary).toMatchObject({ compared: 4, skipped: 0 });
    const lost = report.urls.find((u) => u.path === "/lost/");
    expect(lost?.findings).toEqual([
      expect.objectContaining({ code: "page.status", severity: "error", live: 200, local: 404 }),
    ]);
  });

  test("--urls <file> takes the file as is, restricted to nothing", async () => {
    const dir = project(["/", "/about/"]);
    const file = join(tmp("f"), "urls.txt");
    writeFileSync(file, "/about/\n/missing/\n");
    const { report } = await run(dir, { urls: file });
    expect(report.urls.map((u) => u.path)).toEqual(["/about/", "/missing/"]);
  });

  test("--only keeps the URLs whose path contains the text; --max samples with the home page first", async () => {
    const dir = project(["/", "/about/", "/about/team/", "/services/", "/blog/"]);
    const paths = ["/", "/about/", "/about/team/", "/services/", "/blog/"];
    expect((await run(dir, { paths, only: "about" })).report.urls.map((u) => u.path)).toEqual([
      "/about/",
      "/about/team/",
    ]);
    const sampled = (await run(dir, { paths, max: 3 })).report.urls.map((u) => u.path);
    expect(sampled).toHaveLength(3);
    expect(sampled[0]).toBe("/");
  });

  test("--only is matched against the path, never the address: the host is not a page", async () => {
    const dir = project(["/", "/about/"]);
    await expect(run(dir, { only: "site.test", paths: ["/", "/about/"] })).rejects.toBeInstanceOf(
      VerifyError,
    );
    await expect(run(dir, { only: "https", paths: ["/", "/about/"] })).rejects.toBeInstanceOf(
      VerifyError,
    );
    const ok = await run(dir, { only: "about", paths: ["/", "/about/"] });
    expect(ok.report.urls.map((u) => u.path)).toEqual(["/about/"]);
  });

  test("the project's own url is the live site when --live is not given; --live wins when it is", async () => {
    const browser = fakeBrowser();
    await run(project(["/"], { url: LIVE }), { browser, paths: ["/"] });
    expect(browser.calls[0]?.url).toBe(`${LIVE}/`);
    const other = fakeBrowser();
    await run(project(["/"], { url: "https://elsewhere.test" }), {
      browser: other,
      live: LIVE,
      paths: ["/"],
    });
    expect(other.calls[0]?.url).toBe(`${LIVE}/`);
  });
});

describe("runVerify: results and files", () => {
  test("fidelity, findings and the files of a run", async () => {
    const dir = project(["/", "/about/"]);
    const reportDir = join(tmp("rd"), "out");
    const lines: string[] = [];
    const outcome = await run(dir, {
      reportDir,
      paths: ["/", "/about/"],
      viewports: [1366, 390],
      images: 1,
      progress: (m) => lines.push(m),
    });
    const { report } = outcome;
    // Each local page is 10 rows black out of 100: 90% at both widths.
    expect(report.urls.map((u) => u.fidelity)).toEqual([0.9, 0.9]);
    expect(report.urls[0]?.viewports.map((v) => v.width)).toEqual([1366, 390]);
    expect(report.summary.fidelity).toMatchObject({ mean: 0.9, min: 0.9 });
    expect(report.urls[0]?.viewports[0]?.findings.map((f) => f.code)).toContain(
      "visual.low-fidelity",
    );
    expect(existsSync(join(reportDir, "verify-report.json"))).toBe(true);
    expect(readFileSync(join(reportDir, "verify-report.md"), "utf8")).toContain(
      "Pages compared: 2 of 2",
    );
    // One page kept its images, both widths, three files each; the scratch folder is gone.
    const kept = report.urls.filter((u) => u.viewports[0]?.images !== undefined);
    expect(kept).toHaveLength(1);
    for (const f of [
      "1366-live.png",
      "1366-local.png",
      "1366-diff.png",
      "390-live.png",
      "390-diff.png",
    ]) {
      expect(existsSync(join(reportDir, "verify", kept[0]?.slug as string, f))).toBe(true);
    }
    expect(existsSync(join(reportDir, "verify/index.html"))).toBe(true);
    expect(existsSync(join(reportDir, ".shots"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("[")).length).toBe(2);
    expect(outcome.summary).toContain("verified 2 pages of 2 listed");
    expect(outcome.summary).toContain("fidelity: mean 90.0%");
    expect(outcome.summary).toContain("verify-report.md");
  });

  test("a live cache pays for the live site once: the second run captures only the migrated pages", async () => {
    const pages = ["/", "/about/"];
    const dir = project(pages);
    const cache = join(tmp("cache"), "live");
    const first = fakeBrowser();
    const a = await run(dir, {
      paths: pages,
      liveCache: cache,
      browser: first,
      viewports: [1366, 390],
    });
    expect(first.calls.filter((c) => c.url.startsWith(LIVE))).toHaveLength(4);
    expect(readdirSync(cache)).toHaveLength(8);
    const second = fakeBrowser();
    const b = await run(dir, {
      paths: pages,
      liveCache: cache,
      browser: second,
      viewports: [1366, 390],
    });
    expect(second.calls.filter((c) => c.url.startsWith(LIVE))).toHaveLength(0);
    expect(second.calls.filter((c) => c.url.startsWith("http://127.0.0.1"))).toHaveLength(4);
    expect(b.report.urls.map((u) => u.fidelity)).toEqual(a.report.urls.map((u) => u.fidelity));
    // Another mask is another capture; a corrupt entry is taken again.
    const third = fakeBrowser();
    await run(dir, {
      paths: pages,
      liveCache: cache,
      browser: third,
      masks: [".x"],
      viewports: [1366, 390],
    });
    expect(third.calls.filter((c) => c.url.startsWith(LIVE))).toHaveLength(4);
    const [entry] = readdirSync(cache).filter((f) => f.endsWith(".json"));
    writeFileSync(join(cache, entry as string), "{broken");
    const fourth = fakeBrowser();
    await run(dir, { paths: pages, liveCache: cache, browser: fourth, viewports: [1366, 390] });
    expect(fourth.calls.filter((c) => c.url.startsWith(LIVE))).toHaveLength(1);
  });

  test("a cached live PNG that is cut short is captured again instead of failing the page for good", async () => {
    const pages = ["/about/"];
    const dir = project(pages);
    const cache = join(tmp("cache3"), "live");
    await run(dir, { paths: pages, liveCache: cache, browser: fakeBrowser() });
    const [shot] = readdirSync(cache).filter((f) => f.endsWith(".png"));
    const file = join(cache, shot as string);
    writeFileSync(file, readFileSync(file).subarray(0, 40));
    const again = fakeBrowser();
    const { report } = await run(dir, { paths: pages, liveCache: cache, browser: again });
    expect(again.calls.filter((c) => c.url.startsWith(LIVE))).toHaveLength(1);
    expect(report.urls[0]?.fidelity).toBe(0.9);
    // And the entry is whole again: a third run pays nothing.
    const third = fakeBrowser();
    await run(dir, { paths: pages, liveCache: cache, browser: third });
    expect(third.calls.filter((c) => c.url.startsWith(LIVE))).toHaveLength(0);
    expect(readdirSync(cache).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  test("a live page that failed to load is not cached", async () => {
    const cache = join(tmp("cache2"), "live");
    const bad = fakeBrowser((url, width) =>
      url.startsWith(LIVE)
        ? { snapshot: snapshot(url, width, { error: "navigation failed: x" }) }
        : { snapshot: snapshot(url, width), png: png(width, 100) },
    );
    await run(project(["/", "/about/"]), {
      paths: ["/", "/about/"],
      liveCache: cache,
      browser: bad,
    }).catch(() => undefined);
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
  });

  test("a long run never holds more than the kept pages' images on disk", async () => {
    const pages = ["/", "/a/", "/b/", "/c/", "/d/"];
    const reportDir = join(tmp("bound"), "out");
    const held: number[] = [];
    await run(project(pages), {
      reportDir,
      paths: pages,
      images: 2,
      progress: () =>
        held.push(
          existsSync(join(reportDir, ".shots")) ? readdirSync(join(reportDir, ".shots")).length : 0,
        ),
    });
    expect(Math.max(...held)).toBeLessThanOrEqual(2);
    expect(held.length).toBeGreaterThanOrEqual(5);
  });

  test("a report folder the run creates ignores itself, so a git add of the project never takes it", async () => {
    const dir = project(["/"]);
    await runVerify({
      out: dir,
      viewports: [1366],
      images: 0,
      fetcher: sitemap(["/"]),
      browser: fakeBrowser(),
    });
    expect(readFileSync(join(dir, ".wp2jx-verify/.gitignore"), "utf8")).toBe("*\n");
    // A folder that was already there is the caller's, and is left as it was.
    const own = tmp("own");
    await run(project(["/"]), { reportDir: own, paths: ["/"] });
    expect(existsSync(join(own, ".gitignore"))).toBe(false);
  });

  test("the mean over the viewports is the page's fidelity, not the best or the worst of them", async () => {
    const browser = fakeBrowser((url, width) => {
      const local = url.startsWith("http://127.0.0.1");
      return {
        snapshot: snapshot(url, width),
        png: png(width, 100, local ? (width === 1366 ? 10 : 30) : 0),
      };
    });
    const { report } = await run(project(["/"]), {
      paths: ["/"],
      browser,
      viewports: [1366, 390],
    });
    expect(report.urls[0]?.fidelity).toBe(0.8);
  });

  test("the report defaults to <project>/.wp2jx-verify", async () => {
    const dir = project(["/"]);
    await runVerify({
      out: dir,
      viewports: [1366],
      images: 0,
      fetcher: sitemap(["/"]),
      browser: fakeBrowser(),
    });
    expect(existsSync(join(dir, ".wp2jx-verify/verify-report.json"))).toBe(true);
  });

  test("a live page that fails to load once is retried; a page that fails twice is a finding, not a crash", async () => {
    const browser = fakeBrowser((url, width, call) => {
      const live = url.startsWith(LIVE);
      if (live && url.endsWith("/about/"))
        return { snapshot: snapshot(url, width, { error: "navigation failed: timeout" }) };
      if (live && url.endsWith("/services/") && call === 1)
        return { snapshot: snapshot(url, width, { error: "navigation failed: reset" }) };
      return { snapshot: snapshot(url, width), png: png(width, 100) };
    });
    const { report } = await run(project(["/", "/about/", "/services/"]), { browser });
    const byPath = Object.fromEntries(report.urls.map((u) => [u.path, u]));
    expect(byPath["/services/"]?.fidelity).toBe(1);
    expect(byPath["/about/"]?.fidelity).toBeNull();
    expect(byPath["/about/"]?.findings).toEqual([
      expect.objectContaining({ code: "page.load-failed", severity: "error" }),
    ]);
    expect(report.summary).toMatchObject({ compared: 2, failed: 1 });
    expect(browser.calls.filter((c) => c.url === `${LIVE}/about/`)).toHaveLength(2);
    expect(browser.calls.filter((c) => c.url === `${LIVE}/services/`)).toHaveLength(2);
  });

  test("several pages in flight give the same report as one at a time", async () => {
    const pages = ["/", "/a/", "/b/", "/c/", "/d/"];
    const dir = project(pages);
    const one = await run(dir, { paths: pages, concurrency: 1 });
    const many = await run(dir, { paths: pages, concurrency: 4 });
    expect(many.report.urls.map((u) => [u.path, u.fidelity])).toEqual(
      one.report.urls.map((u) => [u.path, u.fidelity]),
    );
  });

  test("a comparison that throws becomes a finding on that viewport and leaves the other pages alone", async () => {
    const browser = fakeBrowser((url, width) => ({
      snapshot: snapshot(url, width),
      png:
        url.endsWith("/about/") && url.startsWith("http://127")
          ? Buffer.from("not a png")
          : png(width, 100),
    }));
    const { report } = await run(project(["/", "/about/"]), { browser, paths: ["/", "/about/"] });
    const about = report.urls.find((u) => u.path === "/about/");
    expect(about?.fidelity).toBeNull();
    expect(about?.viewports[0]?.findings).toEqual([
      expect.objectContaining({
        code: "page.load-failed",
        message: expect.stringContaining("the comparison failed"),
      }),
    ]);
    expect(report.urls.find((u) => u.path === "/")?.fidelity).toBe(1);
  });
});

describe("runVerify: tool errors", () => {
  const fails = async (promise: Promise<unknown>, text: string) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(VerifyError);
    expect((error as Error).message).toContain(text);
  };

  test("a folder that is not a project", async () => {
    await fails(run(tmp("empty")), "no project.json");
  });

  test("a project.json that is not JSON", async () => {
    const dir = tmp("bad");
    writeFileSync(join(dir, "project.json"), "{nope");
    await fails(run(dir), "not valid JSON");
  });

  test("no live address anywhere, or one that is not a URL", async () => {
    await fails(run(project(["/"], { url: null })), "no live address");
    await fails(run(project(["/"]), { live: "not a url" }), "is not a URL");
  });

  test("no dist: build first", async () => {
    const dir = tmp("nodist");
    writeFileSync(join(dir, "project.json"), JSON.stringify({ url: LIVE }));
    await fails(run(dir), "jx build");
  });

  test("bad viewports", async () => {
    await fails(run(project(["/"]), { viewports: [] }), "--viewports");
    await fails(run(project(["/"]), { viewports: [100] }), "--viewports");
    await fails(run(project(["/"]), { viewports: [1.5] }), "--viewports");
  });

  test("a live site with no sitemap, naming what was tried", async () => {
    await fails(
      run(project(["/"]), { fetcher: async () => ({ ok: false, text: async () => "" }) }),
      "lists no pages",
    );
  });

  test("nothing left to compare after the filters", async () => {
    await fails(run(project(["/"]), { only: "zzz" }), "no URL to compare");
    await fails(run(project(["/"]), { paths: ["/only-live/"] }), "no URL to compare");
  });

  test("a missing URL file", async () => {
    await fails(run(project(["/"]), { urls: join(tmp("x"), "none.txt") }), "no such file");
  });

  test("when no page could be captured at all, the report is written and the run fails", async () => {
    const browser = fakeBrowser((url, width) => ({
      snapshot: snapshot(url, width, { error: "navigation failed: net::ERR_NAME_NOT_RESOLVED" }),
    }));
    const reportDir = join(tmp("rd2"), "r");
    await fails(
      run(project(["/", "/about/"]), { browser, reportDir }),
      "no page could be compared",
    );
    expect(existsSync(join(reportDir, "verify-report.json"))).toBe(true);
    expect(openServers()).toBe(0);
  });
});

describe("runVerify: --build", () => {
  const script = (dir: string, body: string): string => {
    const file = join(dir, "fake-jx");
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  test("runs the jx binary in the project, then verifies what it built", async () => {
    const dir = tmp("build");
    writeFileSync(join(dir, "project.json"), JSON.stringify({ url: LIVE }));
    const jx = script(
      dir,
      'test "$1" = build || exit 9\nmkdir -p dist && echo "<h1>home</h1>" > dist/index.html',
    );
    const { report } = await run(dir, { build: true, jx, paths: ["/"] });
    expect(report.urls.map((u) => u.path)).toEqual(["/"]);
  });

  test("a failing build is a tool error with the end of its output", async () => {
    const dir = tmp("buildfail");
    writeFileSync(join(dir, "project.json"), JSON.stringify({ url: LIVE }));
    const jx = script(dir, 'echo "compiling..."; echo "error: pages/x.json is broken" >&2; exit 3');
    const error = await run(dir, { build: true, jx }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(VerifyError);
    expect((error as Error).message).toContain("jx build failed (exit 3)");
    expect((error as Error).message).toContain("pages/x.json is broken");
  });
});

describe("renderSummary", () => {
  test("prints counts, fidelity per viewport, the worst pages and the biggest systematic differences", async () => {
    const { report, files } = await run(project(["/", "/about/"]), {
      viewports: [1366, 390],
      paths: ["/", "/about/"],
    });
    const text = renderSummary(report, files);
    expect(text).toContain("at 1366 px: mean 90.0%");
    expect(text).toContain("at 390 px: mean 90.0%");
    expect(text).toContain("worst pages:");
    expect(text).toMatch(/90\.0% {2}\/about\//);
    expect(text).not.toContain("systematic");
  });
});

// Keep the type import used.
export type _Unused = VerifyOptions;
