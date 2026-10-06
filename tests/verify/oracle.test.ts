/**
 * The oracle end to end in real Chrome: a synthetic live site and a migrated twin on loopback, with
 * seeded defects (a missing image, another font on the nav, changed text, sideways overflow at 390,
 * a broken image, another title) that the report must see, then the whole `runVerify` path and the
 * command line. Needs Chrome, so it runs only with WP2JX_TEST_LIVE=1; nothing here uses the internet.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { main, type CliIo } from "../../src/cli.ts";
import { findChrome, launchBrowser, type VerifyBrowser } from "../../src/verify/browser.ts";
import {
  compareDocuments,
  comparePixels,
  domFindings,
  pageFindings,
  visualFindings,
} from "../../src/verify/compare.ts";
import { runVerify } from "../../src/verify/run.ts";
import { openServers, startStaticServer, type StaticServer } from "../../src/verify/serve.ts";
import { createResolver } from "../../src/verify/urls.ts";
import { TMP_ROOT } from "../helpers/jx-build.ts";

setDefaultTimeout(180_000);

const enabled = process.env.WP2JX_TEST_LIVE === "1" && findChrome() !== undefined;
const suite = enabled ? describe : describe.skip;

interface PageOptions {
  navFont?: string;
  heading?: string;
  image?: string | null;
  paragraph?: string | null;
  wide?: boolean;
  title?: string;
}

/** One page of the synthetic site, with seeded differences. */
function page(name: string, o: PageOptions = {}): string {
  const nav =
    o.navFont === undefined ? "" : `<style>nav a{font-family:${o.navFont} !important}</style>`;
  const image =
    o.image === null
      ? ""
      : `<img src="${o.image ?? "/media/barn.png"}" width="200" height="100" alt="Barn">`;
  const paragraph = o.paragraph === null ? "" : "<p>We serve Lebanon and Lancaster counties.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${o.title ?? "Acme Painting"}</title><style>
body{margin:0;font:16px/1.5 Georgia,serif;color:#222}nav{background:#073b4c;padding:10px}
nav a{color:#fff;font-family:Arial,sans-serif;margin-right:16px}h1{font-size:40px;margin:24px 16px}
p{margin:0 16px 16px}img{display:block;margin:16px}footer{background:#eee;padding:16px}
@media (max-width:600px){h1{font-size:28px}}</style>${nav}</head><body>
<div class="so-widget-content" style="font-size:0;position:absolute;left:-9999px"><a href="https://spam.example/casino">casino</a></div>
<nav><a href="/">Home</a> <a href="/about/">About</a> <a href="/services/">Services</a> <a href="/contact/">Contact</a></nav>
<h1 class="heading-abc1234">${o.heading ?? `Painting you can trust ${name}`}</h1>
<p>Interior and exterior painting for homes and barns.</p>${paragraph}${image}
${o.wide === true ? '<div style="width:700px;height:20px;background:#c00"></div>' : ""}<div style="height:900px"></div>
<script>setTimeout(function(){var w=document.createElement('chat-widget');w.textContent='Chat';w.style.cssText='position:fixed;bottom:0;right:0;padding:30px;background:#0a0';document.body.appendChild(w)},300)</script>
<footer><p>Call us today</p><a href="/contact/">Contact</a></footer></body></html>`;
}

function solid(): Buffer {
  const png = new PNG({ width: 200, height: 100 });
  for (let i = 0; i < 200 * 100; i++) png.data.set([180, 40, 40, 255], i * 4);
  return PNG.sync.write(png);
}

function site(dir: string, pages: Record<string, string>): void {
  mkdirSync(join(dir, "media"), { recursive: true });
  writeFileSync(join(dir, "media/barn.png"), solid());
  for (const [path, html] of Object.entries(pages)) {
    const file =
      path === "/"
        ? join(dir, "index.html")
        : join(dir, path.replace(/^\/|\/$/g, ""), "index.html");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, html);
  }
}

let tmp: string;
let live: StaticServer;
let browser: VerifyBrowser;
const PAGES = ["/", "/about/", "/services/", "/broken/", "/lost/"];

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(TMP_ROOT, { recursive: true });
  tmp = mkdtempSync(join(TMP_ROOT, "verify-oracle-"));
  const liveDir = join(tmp, "live");
  site(liveDir, Object.fromEntries(PAGES.map((p) => [p, page(p)])));
  live = await startStaticServer({ root: liveDir });
  const locs = [...PAGES, "/media/barn.png"]
    .map((p) => `<url><loc>${live.origin}${p}</loc></url>`)
    .join("");
  writeFileSync(
    join(liveDir, "sitemap.xml"),
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`,
  );
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await live?.close();
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
  if (enabled) expect(openServers()).toBe(0);
});

suite("seeded defects are seen", () => {
  async function pair(local: string, width = 1366) {
    const dir = join(tmp, `local-${Math.random().toString(36).slice(2)}`);
    site(dir, { "/about/": local });
    const server = await startStaticServer({ root: dir });
    try {
      const a = await browser.capture(`${live.origin}/about/`, { width });
      const b = await browser.capture(`${server.origin}/about/`, { width });
      const r = createResolver({ liveUrl: live.origin, localOrigin: server.origin });
      const { visual } = comparePixels(a.png as Buffer, b.png as Buffer);
      const { dom, work } = compareDocuments(a.snapshot, b.snapshot, r);
      const findings = [
        ...pageFindings(a.snapshot, b.snapshot, r),
        ...visualFindings(visual, a.snapshot, b.snapshot, width),
        ...domFindings(dom, work, a.snapshot, b.snapshot, r, width),
      ];
      return { visual, dom, findings };
    } finally {
      await server.close();
    }
  }
  const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

  test("an identical twin scores 1 and has nothing worth reporting", async () => {
    const { visual, findings } = await pair(page("/about/"));
    expect(visual.fidelity).toBe(1);
    expect(findings.filter((f) => f.severity !== "info")).toEqual([]);
  });

  test("a removed image is a missing image and a shorter page", async () => {
    const { findings, visual } = await pair(page("/about/", { image: null }));
    expect(codes(findings)).toEqual(
      expect.arrayContaining(["image.missing", "layout.height-delta"]),
    );
    expect(visual.fidelity).toBeLessThan(1);
  });

  test("an image that does not load is broken, with its address, and its request failed", async () => {
    const { findings } = await pair(page("/about/", { image: "/media/gone.png" }));
    const broken = findings.find((f) => f.code === "image.broken");
    expect(broken?.severity).toBe("error");
    expect(JSON.stringify(broken?.data)).toContain("/media/gone.png");
    expect(codes(findings)).toContain("request.failed");
  });

  test("another font on every nav link is one systematic finding with both values", async () => {
    const { findings } = await pair(page("/about/", { navFont: "Courier New, monospace" }));
    const f = findings.find((x) => x.code === "style.systematic" && x.property === "fontFamily");
    expect(f).toMatchObject({ count: 4, data: expect.objectContaining({ group: "nav > a" }) });
    expect(String(f?.live).toLowerCase()).toContain("arial");
    expect(String(f?.local).toLowerCase()).toContain("courier");
    expect(f?.selector).toMatch(/^body > nav:nth-child\(2\) > a:nth-child\(\d\)$/);
  });

  test("changed and missing text are told apart and located", async () => {
    const { findings, dom } = await pair(
      page("/about/", { heading: "Painting you can really trust /about/", paragraph: null }),
    );
    expect(
      dom.text.changed.some((c) => c.live.includes("trust /about/") && c.local.includes("really")),
    ).toBe(true);
    expect(dom.text.missing.map((m) => m.text)).toContain(
      "We serve Lebanon and Lancaster counties.",
    );
    expect(codes(findings)).toEqual(expect.arrayContaining(["text.missing", "text.changed"]));
  });

  test("a page that scrolls sideways at 390 is an error when live does not", async () => {
    const { findings } = await pair(page("/about/", { wide: true }), 390);
    const f = findings.find((x) => x.code === "layout.overflow-x");
    expect(f?.severity).toBe("error");
    expect(f?.local).toBeGreaterThanOrEqual(700);
  });

  test("another title is a finding with both values", async () => {
    const { findings } = await pair(page("/about/", { title: "Another title" }));
    expect(findings.find((f) => f.code === "meta.title")).toMatchObject({
      live: "Acme Painting",
      local: "Another title",
    });
  });
});

/** Chrome processes this tool started (its profile folders and its flags name them), by pid. */
function oracleChromes(): Set<number> {
  const out = Bun.spawnSync(["ps", "-eo", "pid,args"]).stdout.toString();
  const pids = new Set<number>();
  for (const line of out.split("\n")) {
    if (
      line.includes("--font-render-hinting=none") &&
      line.includes("puppeteer_dev_chrome_profile")
    )
      pids.add(Number(line.trim().split(/\s+/)[0]));
  }
  return pids;
}

suite("runVerify in real Chrome", () => {
  const projectDir = () => join(tmp, "project");
  function project(pages: Record<string, string>, redirects = ""): void {
    rmSync(projectDir(), { recursive: true, force: true });
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(
      join(projectDir(), "project.json"),
      JSON.stringify({ name: "t", url: live.origin }),
    );
    site(join(projectDir(), "dist"), pages);
    if (redirects !== "") writeFileSync(join(projectDir(), "dist", "_redirects"), redirects);
  }

  test("the sitemap, the skipped page, the worst pages, the files", async () => {
    project({
      "/": page("/"),
      "/about/": page("/about/", { navFont: "Courier New, monospace" }),
      "/services/": page("/services/"),
      "/broken/": page("/broken/", { image: null }),
    });
    const lines: string[] = [];
    const reportDir = join(tmp, "report");
    const { report, files } = await runVerify({
      out: projectDir(),
      reportDir,
      viewports: [1366, 390],
      images: 2,
      progress: (m) => lines.push(m),
    });
    expect(report.summary).toMatchObject({ compared: 4, listed: 5, skipped: 1 });
    expect(report.skipped.map((s) => new URL(s.url).pathname)).toEqual(["/lost/"]);
    const by = Object.fromEntries(report.urls.map((u) => [u.path, u]));
    expect(by["/"]?.fidelity).toBe(1);
    expect(by["/services/"]?.fidelity).toBe(1);
    expect(by["/broken/"]?.fidelity as number).toBeLessThan(1);
    // Removing an image displaces everything below it: worse than a font on four links.
    expect(report.summary.worst.map((w) => w.path).slice(0, 2)).toEqual(["/broken/", "/about/"]);
    expect(report.summary.systematic[0]).toMatchObject({
      property: "fontFamily",
      group: "nav > a",
    });
    expect(report.summary.byCode.map((c) => c.code)).toContain("image.missing");
    expect(readFileSync(files.md, "utf8")).toContain("Systematic differences");
    const kept = report.urls.filter((u) => u.viewports.some((v) => v.images !== undefined));
    expect(kept).toHaveLength(2);
    for (const u of kept)
      for (const f of ["1366-live.png", "1366-local.png", "1366-diff.png", "390-diff.png"])
        expect(existsSync(join(reportDir, "verify", u.slug, f))).toBe(true);
    expect(existsSync(join(reportDir, ".shots"))).toBe(false);
    expect(lines.some((l) => l.includes("[4/4]"))).toBe(true);
  });

  test("the Chrome a run starts is gone when it returns, whether it finished or failed, and so is its server", async () => {
    project({
      "/": page("/"),
      "/about/": page("/about/"),
      "/services/": page("/services/"),
      "/broken/": page("/broken/"),
    });
    const before = oracleChromes();
    await runVerify({
      out: projectDir(),
      reportDir: join(tmp, "rc1"),
      viewports: [1366],
      max: 1,
      images: 0,
    });
    expect([...oracleChromes()].filter((pid) => !before.has(pid))).toEqual([]);
    // A run that fails after the browser is up (the live site answers nothing) closes it too.
    const failing = runVerify({
      out: projectDir(),
      reportDir: join(tmp, "rc2"),
      viewports: [1366],
      urls: "all",
      only: "/about/",
      images: 0,
      fetcher: async () => ({
        ok: true,
        text: async () => `<urlset><url><loc>http://127.0.0.1:1/about/</loc></url></urlset>`,
      }),
      live: "http://127.0.0.1:1",
    });
    await expect(failing).rejects.toThrow("no page could be compared");
    expect([...oracleChromes()].filter((pid) => !before.has(pid))).toEqual([]);
    expect(openServers()).toBe(1);
  });

  test("two runs agree on fidelity to within half a point", async () => {
    project({
      "/": page("/"),
      "/about/": page("/about/", { image: null }),
      "/services/": page("/services/"),
      "/broken/": page("/broken/", { navFont: "Courier New" }),
    });
    const options = { out: projectDir(), viewports: [1366, 390], max: 3, images: 0 };
    const a = await runVerify({ ...options, reportDir: join(tmp, "r1") });
    const b = await runVerify({ ...options, reportDir: join(tmp, "r2") });
    expect(a.report.urls.map((u) => u.path)).toEqual(b.report.urls.map((u) => u.path));
    for (const [i, u] of a.report.urls.entries())
      expect(
        Math.abs((u.fidelity as number) - (b.report.urls[i]?.fidelity as number)),
      ).toBeLessThan(0.005);
  });

  test("_redirects are followed locally: a page the live site serves but the migration moved is a redirect finding", async () => {
    project(
      {
        "/": page("/"),
        "/about/": page("/about/"),
        "/services/": page("/services/"),
        "/broken/": page("/broken/"),
      },
      "/lost /about/ 301\n",
    );
    const { report } = await runVerify({
      out: projectDir(),
      reportDir: join(tmp, "r3"),
      viewports: [1366],
      only: "lost",
      images: 0,
    });
    expect(report.urls[0]?.findings.map((f) => f.code)).toContain("page.redirect");
  });

  test("--urls all compares a page the migration lost, and it is an error", async () => {
    project({
      "/": page("/"),
      "/about/": page("/about/"),
      "/services/": page("/services/"),
      "/broken/": page("/broken/"),
    });
    const { report } = await runVerify({
      out: projectDir(),
      reportDir: join(tmp, "r4"),
      viewports: [1366],
      urls: "all",
      only: "lost",
      images: 0,
    });
    expect(report.urls[0]?.findings.find((f) => f.code === "page.status")).toMatchObject({
      severity: "error",
      local: 404,
    });
  });

  test("the command line returns 0 with the summary whatever the fidelity", async () => {
    project({
      "/": page("/", { image: null }),
      "/about/": page("/about/"),
      "/services/": page("/services/"),
      "/broken/": page("/broken/"),
    });
    let out = "";
    let err = "";
    const io: CliIo = {
      stdout: (t) => void (out += t),
      stderr: (t) => void (err += t),
      env: {},
      cwd: tmp,
    };
    const code = await main(
      [
        "verify",
        "--out",
        projectDir(),
        "--max",
        "2",
        "--viewports",
        "1366",
        "--report-dir",
        join(tmp, "r5"),
        "--images",
        "1",
      ],
      io,
    );
    expect(code).toBe(0);
    expect(out).toContain("verified 2 pages");
    expect(out).toContain("fidelity: mean");
    expect(err).toContain("[2/2]");
  });
});
