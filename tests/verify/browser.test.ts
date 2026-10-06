/**
 * Real Chrome, on a synthetic live site served from loopback: what a capture sees, that the noise
 * masks hold, and that two captures of one page are the same. Needs Chrome, so it runs only with
 * WP2JX_TEST_LIVE=1; nothing here touches the internet.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  DEFAULT_NOISE,
  findChrome,
  globToRegExp,
  launchBrowser,
  markBlocked,
  maskCss,
  withMasks,
  type VerifyBrowser,
} from "../../src/verify/browser.ts";
import { comparePixels } from "../../src/verify/compare.ts";
import { openServers, startStaticServer, type StaticServer } from "../../src/verify/serve.ts";
import { TMP_ROOT } from "../helpers/jx-build.ts";

setDefaultTimeout(120_000);

const chrome = findChrome();
const enabled = process.env.WP2JX_TEST_LIVE === "1" && chrome !== undefined;
const suite = enabled ? describe : describe.skip;

function solid(w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set([180, 40, 40, 255], i * 4);
  return PNG.sync.write(png);
}

const HOME = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme Painting</title>
<meta name="description" content="We paint"><link rel="canonical" href="/">
<style>
body{margin:0;font:16px/1.5 Georgia,serif;color:#222}
nav{background:#073b4c;padding:10px}
nav a{color:#fff;font-family:Arial,sans-serif;margin-right:16px}
h1{font-size:40px;margin:24px 16px}
p{margin:0 16px 16px}
img{display:block;margin:16px}
footer{background:#eee;padding:16px}
@keyframes slide{from{margin-left:300px}to{margin-left:0}}
.moving{animation:slide 5s infinite}
[data-aos]{opacity:0;transform:translateY(50px)}
</style></head><body>
<div class="so-widget-content" style="font-size:0;position:absolute;left:-9999px"><a href="https://spam.example/casino">casino</a></div>
<nav><a href="/">Home</a> <a href="/about/">About</a></nav>
<h1 class="heading-abc1234">Painting you can trust</h1>
<p class="moving">Interior and exterior &ldquo;painting&rdquo;.</p>
<p data-aos="fade-up">Revealed on scroll.</p>
<img src="/media/barn.png" width="200" height="100" alt="Barn">
<img src="/media/lazy.png" loading="lazy" width="200" height="100" alt="Lazy" style="margin-top:2000px">
<iframe src="https://www.google.com/maps/embed?pb=x" width="300" height="150"></iframe>
<div class="splide">Slide one</div>
<p class="rm" style="display:none">Reduced motion on</p><p class="lt" style="display:none">Light scheme</p><p id="ua"></p>
<style>@media (prefers-reduced-motion: reduce){.rm{display:block !important}}@media (prefers-color-scheme: light){.lt{display:block !important}}</style>
<script>document.getElementById('ua').textContent=/HeadlessChrome/.test(navigator.userAgent)?'ua headless':'ua normal'</script>
<script>setTimeout(function(){var w=document.createElement('chat-widget');w.textContent='Chat with us';w.style.cssText='position:fixed;bottom:0;right:0;background:#0a0;padding:30px';document.body.appendChild(w)},300)</script>
<p id="io" style="margin-top:3000px">Not seen yet</p>
<script>new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)e.target.textContent='Seen by observer'})}).observe(document.getElementById('io'))</script>
<footer><p>Call us today</p></footer></body></html>`;

/** Every way a page hides text from a reader, none of them in the mask list, and one visible control. */
const HIDDEN = `<!doctype html><html><head><meta charset="utf-8"><title>Hidden</title><style>body{margin:0;font:16px Arial}</style></head><body>
<p>Visible words</p><a href="/shown/">Shown link</a>
<fp-header style="display:contents"><nav><a href="/in-contents/">In contents link</a> <fp-inner style="display:contents"><p>Words inside a component host</p></fp-inner></nav><p style="display:none">hidden inside a component host</p></fp-header>
<div style="display:none"><fp-header style="display:contents"><a href="/hidden-parent/">Under a hidden parent</a></fp-header></div>
<p style="display:none">display none words</p><a href="/none/" style="display:none">None link</a>
<p style="visibility:hidden">visibility hidden words</p>
<p style="opacity:0">opacity zero words</p>
<p style="font-size:0">font size zero words</p>
<div style="position:absolute;left:-9999px"><a href="/off/">Offscreen link</a> offscreen words</div>
<div style="height:0;overflow:hidden"><p>clipped words</p><a href="/clip/">Clipped link</a></div>
<div hidden><p>hidden attribute words</p></div>
<details><summary>Summary words</summary><p>closed details words</p></details>
<div style="display:none"><p style="display:block">child of display none</p></div>
<svg width="10" height="10"><text>svg words</text></svg><script>var scriptWords = 1</script><noscript>noscript words</noscript>
<p>Line one<br>line two</p>
<p>Un<b>bro</b>ken <em>word</em></p>
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="5" height="5" alt="dot" style="display:none">
<div style="position:relative;overflow:hidden;height:30px"><a href="/farright/" style="position:absolute;left:5000px">Far right link</a> far right words</div>
<script src="http://blocked.test/x.js"></script>
</body></html>`;

/** A page that aborts one of its own requests and asks for an icon that is not there. */
const NOISY = `<!doctype html><title>noisy</title><link rel="icon" href="/favicon.ico"><p>Noisy words</p>
<script>var c=new AbortController();fetch('/media/barn.png',{signal:c.signal}).catch(function(){});c.abort()</script>`;

/** A page that repaints itself on every frame for ever: no two screenshots of it are the same. */
const RESTLESS = `<!doctype html><title>restless</title><body style="margin:0"><div id="d" style="height:200px"></div><p>Restless words</p>
<script>(function tick(){document.getElementById('d').style.background='hsl('+(performance.now()%360)+',80%,50%)';requestAnimationFrame(tick)})()</script>`;

let tmp: string;
let tracker: StaticServer;
let live: StaticServer;
let browser: VerifyBrowser;

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(TMP_ROOT, { recursive: true });
  tmp = mkdtempSync(join(TMP_ROOT, "verify-browser-"));
  mkdirSync(join(tmp, "media"));
  writeFileSync(join(tmp, "media/barn.png"), solid(200, 100));
  writeFileSync(join(tmp, "media/lazy.png"), solid(200, 100));
  writeFileSync(join(tmp, "index.html"), HOME);
  mkdirSync(join(tmp, "tracker"));
  writeFileSync(join(tmp, "tracker/tracker.js"), "window.tracked = true");
  tracker = await startStaticServer({ root: join(tmp, "tracker") });
  mkdirSync(join(tmp, "tracked"));
  writeFileSync(
    join(tmp, "tracked/index.html"),
    `<!doctype html><title>t</title><p>tracked page</p><script src="${tracker.origin}/tracker.js"></script>`,
  );
  mkdirSync(join(tmp, "hidden"));
  writeFileSync(join(tmp, "hidden/index.html"), HIDDEN);
  mkdirSync(join(tmp, "noisy"));
  writeFileSync(join(tmp, "noisy/index.html"), NOISY);
  mkdirSync(join(tmp, "fineline"));
  writeFileSync(
    join(tmp, "fineline/index.html"),
    readFileSync(join(import.meta.dir, "../fixtures/fineline/html/home.html"), "utf8"),
  );
  mkdirSync(join(tmp, "big"));
  writeFileSync(
    join(tmp, "big/index.html"),
    `<!doctype html><title>big</title>${Array.from({ length: 3200 }, (_, i) => `<p>row ${i} text</p>`).join("")}`,
  );
  mkdirSync(join(tmp, "poster"));
  writeFileSync(
    join(tmp, "poster/index.html"),
    `<!doctype html><title>poster</title><img src="https://i.ytimg.com/vi/abc123/hqdefault.jpg" width="100" height="60" alt="poster"><img src="${"/media/barn.png"}" alt="Barn">`,
  );
  mkdirSync(join(tmp, "restless"));
  writeFileSync(join(tmp, "restless/index.html"), RESTLESS);
  live = await startStaticServer({ root: tmp });
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await tracker?.close();
  await live?.close();
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
  if (enabled) expect(openServers()).toBe(0);
});

describe("noise configuration", () => {
  test("the masks are CSS: removed things take no space, blanked things keep their box", () => {
    const css = maskCss(withMasks(DEFAULT_NOISE, [".mine"]));
    expect(css).toContain("body > div.so-widget-content { display: none !important; }");
    expect(css).toContain("chat-widget { display: none !important; }");
    expect(css).toContain(".splide { visibility: hidden !important; }");
    expect(css).toContain(".mine { visibility: hidden !important; }");
    expect(css).toContain("animation: none !important");
  });

  test("withMasks adds to the defaults without changing them", () => {
    const before = DEFAULT_NOISE.blank.length;
    withMasks(DEFAULT_NOISE, ["x"]);
    expect(DEFAULT_NOISE.blank.length).toBe(before);
    expect(DEFAULT_NOISE.blockUrls).toContain("*nodedelivr.com*");
  });

  test("a blocked-address pattern is a wildcard match with every other character literal", () => {
    const re = globToRegExp("*nodedelivr.com*");
    expect(re.test("https://cdn.nodedelivr.com/mpackage.js")).toBe(true);
    expect(re.test("https://cdn.nodedelivrXcom/mpackage.js")).toBe(false);
    expect(globToRegExp("*google.com/maps*").test("https://www.google.com/maps/embed?pb=1")).toBe(
      true,
    );
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("x(1)+[y]").test("x(1)+[y]")).toBe(true);
    expect(globToRegExp("exact").test("an exact match")).toBe(false);
  });

  test("images whose address the config refuses are marked blocked, the others are left alone", () => {
    const img = (src: string, currentSrc = src) =>
      ({ kind: "img", src, currentSrc, loaded: false }) as Parameters<
        typeof markBlocked
      >[0][number];
    const out = markBlocked(
      [
        img("https://i.ytimg.com/vi/abc/hqdefault.jpg"),
        img("https://cdn.example/poster.jpg", "https://vimeo.com/p.jpg"),
        img("https://img.youtube.com/vi/abc/0.jpg"),
        img("http://127.0.0.1:1/media/gone.jpg"),
        img(""),
      ],
      DEFAULT_NOISE,
    );
    expect(out.map((i) => i.blocked)).toEqual([true, true, true, undefined, undefined]);
  });

  test("findChrome honours an explicit path and refuses one that does not exist", () => {
    expect(findChrome("/definitely/not/here")).toBeUndefined();
    if (chrome !== undefined) expect(findChrome(chrome)).toBe(chrome);
  });

  test("launching with a path that is not there fails with a message that names the way out", async () => {
    await expect(launchBrowser({ executablePath: "/definitely/not/here" })).rejects.toThrow(
      "could not find Chrome",
    );
    await expect(launchBrowser({ executablePath: "/definitely/not/here" })).rejects.toThrow(
      "--chrome",
    );
  });
});

suite("a capture", () => {
  test("sees what a reader sees: not the spam, the late chat widget, the map or the carousel", async () => {
    const { snapshot, png } = await browser.capture(`${live.origin}/`, { width: 1366 });
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.status).toBe(200);
    const text = snapshot.textBlocks.map((b) => b.text).join("\n");
    expect(text).toContain("Painting you can trust");
    expect(text).toContain("Interior and exterior “painting”.");
    expect(text).not.toContain("casino");
    expect(text).not.toContain("Chat with us");
    expect(text).not.toContain("Slide one");
    expect(snapshot.links.map((l) => l.raw)).toEqual(["/", "/about/"]);
    expect(snapshot.headings).toEqual([
      expect.objectContaining({ level: 1, text: "Painting you can trust" }),
    ]);
    expect(snapshot.title).toBe("Acme Painting");
    expect(snapshot.description).toBe("We paint");
    expect(snapshot.canonical).toBe(`${live.origin}/`);
    expect(snapshot.lang).toBe("en");
    expect(snapshot.overflow.overflow).toBe(false);
    expect(png?.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(snapshot.docHeight).toBeGreaterThan(2000);
  });

  test("the page is asked for reduced motion and the light scheme, and does not announce a headless browser", async () => {
    const { snapshot } = await browser.capture(`${live.origin}/`, {
      width: 1366,
      screenshot: false,
    });
    const text = snapshot.textBlocks.map((b) => b.text);
    expect(text).toContain("Reduced motion on");
    expect(text).toContain("Light scheme");
    expect(text).toContain("ua normal");
  });

  test("scroll-triggered scripts run: the page is scrolled through before it is read", async () => {
    const { snapshot } = await browser.capture(`${live.origin}/`, {
      width: 1366,
      screenshot: false,
    });
    expect(snapshot.textBlocks.map((b) => b.text)).toContain("Seen by observer");
  });

  test("a blocked address is never requested at all; unblocked, it is", async () => {
    const before = tracker.requests;
    await browser.capture(`${live.origin}/tracked/`, {
      width: 1366,
      screenshot: false,
      noise: { remove: [], blank: [], blockUrls: ["*tracker.js*"] },
    });
    expect(tracker.requests).toBe(before);
    await browser.capture(`${live.origin}/tracked/`, {
      width: 1366,
      screenshot: false,
      noise: { remove: [], blank: [], blockUrls: [] },
    });
    expect(tracker.requests).toBeGreaterThan(before);
  });

  test("lazy images are scrolled into view and loaded; both are measured", async () => {
    const { snapshot } = await browser.capture(`${live.origin}/`, { width: 1366 });
    expect(snapshot.images).toEqual([
      expect.objectContaining({
        kind: "img",
        alt: "Barn",
        loaded: true,
        naturalWidth: 200,
        width: 200,
        height: 100,
      }),
      expect.objectContaining({ kind: "img", alt: "Lazy", loaded: true, naturalWidth: 200 }),
    ]);
  });

  test("animations are off and scroll reveals are done, so what moves is at rest", async () => {
    const { snapshot } = await browser.capture(`${live.origin}/`, { width: 1366 });
    const moving = snapshot.elements.find((e) => e.classes.includes("moving"));
    expect(moving?.rect.x).toBe(16);
    expect(snapshot.textBlocks.map((b) => b.text)).toContain("Revealed on scroll.");
  });

  test("probes elements with their path, classes, rect and computed style", async () => {
    const { snapshot } = await browser.capture(`${live.origin}/`, { width: 1366 });
    const h1 = snapshot.elements.find((e) => e.tag === "h1");
    expect(h1).toMatchObject({
      path: "body > h1.heading-abc1234:nth-child(3)",
      classes: ["heading-abc1234"],
      text: "Painting you can trust",
      landmark: "body",
    });
    expect(h1?.style).toMatchObject({ fontSize: "40px", fontWeight: "700", display: "block" });
    expect(h1?.rect).toMatchObject({ x: 16, width: 1334 });
    const link = snapshot.elements.find((e) => e.tag === "a");
    expect(link).toMatchObject({ landmark: "nav", text: "Home" });
    expect(link?.style.fontFamily.toLowerCase()).toContain("arial");
    expect(link?.style.color).toBe("rgb(255, 255, 255)");
  });

  test("the same page captured twice is pixel-identical, at both widths", async () => {
    for (const width of [1366, 390]) {
      const a = await browser.capture(`${live.origin}/`, { width });
      const b = await browser.capture(`${live.origin}/`, { width });
      expect(comparePixels(a.png as Buffer, b.png as Buffer).visual.fidelity).toBe(1);
      expect(a.snapshot.docHeight).toBe(b.snapshot.docHeight);
      expect(a.snapshot.viewport.width).toBe(width);
    }
  });

  test("a narrow viewport lays the page out at that width", async () => {
    const { snapshot, png } = await browser.capture(`${live.origin}/`, { width: 390 });
    expect(snapshot.overflow.clientWidth).toBe(390);
    expect(snapshot.viewport).toEqual({ width: 390, height: 844 });
    expect(
      (await browser.capture(`${live.origin}/`, { width: 1366, screenshot: false })).snapshot
        .viewport,
    ).toEqual({ width: 1366, height: 900 });
    expect(PNG.sync.read(png as Buffer).width).toBe(390);
  });

  test("a mask given by the caller blanks its content and keeps its box", async () => {
    const plain = await browser.capture(`${live.origin}/`, { width: 1366 });
    const masked = await browser.capture(`${live.origin}/`, {
      width: 1366,
      noise: withMasks(DEFAULT_NOISE, ["h1"]),
    });
    expect(masked.snapshot.headings).toEqual([]);
    const y = (s: typeof plain.snapshot) =>
      s.elements.find((e) => e.text === "Revealed on scroll.")?.rect.y;
    expect(y(masked.snapshot)).toBe(y(plain.snapshot));
  });

  test("the screenshot is cut at the height cap and the snapshot says so", async () => {
    const { snapshot, png } = await browser.capture(`${live.origin}/`, {
      width: 1366,
      maxHeight: 1200,
    });
    expect(snapshot.clippedAt).toBe(1200);
    expect(PNG.sync.read(png as Buffer).height).toBe(1200);
  });

  test("a settled page is not marked; a page that repaints for ever is, and still gets a screenshot", async () => {
    const calm = await browser.capture(`${live.origin}/hidden/`, { width: 1366 });
    expect(calm.snapshot.unstable).toBeUndefined();
    const restless = await browser.capture(`${live.origin}/restless/`, { width: 1366 });
    expect(restless.snapshot.unstable).toBe(true);
    expect(restless.png).toBeDefined();
  });

  test("a snapshot without a screenshot when none is asked for", async () => {
    const { snapshot, png } = await browser.capture(`${live.origin}/`, {
      width: 1366,
      screenshot: false,
    });
    expect(png).toBeUndefined();
    expect(snapshot.textBlocks.length).toBeGreaterThan(0);
  });

  test("an unreachable page is a snapshot with an error, not an exception", async () => {
    const { snapshot, png } = await browser.capture("http://127.0.0.1:1/", {
      width: 1366,
      navTimeoutMs: 5000,
    });
    expect(snapshot.error).toContain("navigation failed");
    expect(png).toBeUndefined();
  });

  test("a browser that has gone away yields failed captures, not a thrown error, and closing twice is safe", async () => {
    const own = await launchBrowser();
    await own.capture(`${live.origin}/hidden/`, { width: 1366, screenshot: false });
    await own.close();
    await own.close();
    const { snapshot, png } = await own.capture(`${live.origin}/`, { width: 1366 });
    expect(snapshot.error).toContain("capture failed");
    expect(png).toBeUndefined();
  });

  test("a 404 carries its status and the failed request", async () => {
    const { snapshot } = await browser.capture(`${live.origin}/nope/`, { width: 1366 });
    expect(snapshot.status).toBe(404);
    expect(snapshot.failedRequests).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 404 })]),
    );
  });
});

suite("what a reader cannot see is not extracted", () => {
  test("hidden text, links and images never reach the snapshot; visible ones do", async () => {
    const { snapshot } = await browser.capture(`${live.origin}/hidden/`, {
      width: 1366,
      screenshot: false,
    });
    const text = snapshot.textBlocks.map((b) => b.text).join("\n");
    for (const word of [
      "display none",
      "visibility hidden",
      "opacity zero",
      "font size zero",
      "offscreen",
      "clipped",
      "hidden attribute",
      "closed details",
      "child of display none",
      "svg words",
      "noscript",
      "scriptWords",
    ]) {
      expect(text).not.toContain(word);
    }
    expect(text).toContain("Visible words");
    expect(text).toContain("Summary words");
    // A component host is a `display: contents` wrapper (no box of its own): what it holds is seen, unless its parent hides it.
    expect(text).toContain("Words inside a component host");
    expect(snapshot.links.map((l) => l.raw)).toEqual(["/shown/", "/in-contents/"]);
    expect(snapshot.images).toEqual([]);
  });

  test("a line break is a space and inline markup does not split a word", async () => {
    const { snapshot } = await browser.capture(`${live.origin}/hidden/`, {
      width: 1366,
      screenshot: false,
    });
    const text = snapshot.textBlocks.map((b) => b.text);
    expect(text).toContain("Line one line two");
    expect(text).toContain("Unbroken word");
  });

  test("a blocked address is refused before it is requested; unblocked, the failure is the page's", async () => {
    const blocked = await browser.capture(`${live.origin}/hidden/`, {
      width: 1366,
      screenshot: false,
      noise: { remove: [], blank: [], blockUrls: ["*blocked.test*"] },
    });
    expect(blocked.snapshot.failedRequests).toEqual([]);
    const open = await browser.capture(`${live.origin}/hidden/`, {
      width: 1366,
      screenshot: false,
      noise: { remove: [], blank: [], blockUrls: [] },
    });
    expect(open.snapshot.failedRequests.map((r) => r.url)).toContain("http://blocked.test/x.js");
  });

  test("a page past the caps reports what was cut instead of silently comparing half", async () => {
    const { snapshot } = await browser.capture(`${live.origin}/big/`, {
      width: 1366,
      screenshot: false,
    });
    expect(snapshot.textBlocks).toHaveLength(3000);
    expect(snapshot.truncatedBlocks).toBe(200);
  });

  test("an image the oracle blocks is marked, and every address the page asked for is listed", async () => {
    const { snapshot } = await browser.capture(`${live.origin}/poster/`, {
      width: 1366,
      screenshot: false,
    });
    const poster = snapshot.images.find((i) => i.src.includes("ytimg"));
    expect(poster).toMatchObject({ loaded: false, blocked: true });
    expect(snapshot.images.find((i) => i.src.endsWith("barn.png"))?.blocked).toBeUndefined();
    expect(snapshot.requests).toContain(`${live.origin}/poster/`);
    expect(snapshot.requests).toContain(`${live.origin}/media/barn.png`);
  });

  test("a request the page aborts itself and a missing favicon are not the page's errors", async () => {
    const { snapshot } = await browser.capture(`${live.origin}/noisy/`, {
      width: 1366,
      screenshot: false,
    });
    expect(snapshot.failedRequests).toEqual([]);
    expect(snapshot.consoleErrors).toEqual([]);
  });
});
