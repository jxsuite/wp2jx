/**
 * The browser half of the oracle: Chrome through `puppeteer-core`, driven one page at a time under
 * settings that make two captures of the same page comparable.
 *
 * Determinism is the point. A capture uses a fresh browser context (no cache, no cookies), a fixed
 * viewport, reduced motion, animations and transitions switched off by an injected style, a
 * browser-like user agent, and a wait that ends when fonts and images are in and the network has
 * been quiet for a moment (capped, because a live site with a polling script is never idle). Lazy
 * images are scrolled into view. What is not content is masked on both sides alike: the injected
 * spam block and script some compromised sites serve, chat widgets, cookie banners, embedded maps and
 * video, carousels, review widgets. A mask is CSS (`display:none` or `visibility:hidden`) injected
 * before the page's own scripts run, so an element a script adds later is hidden too, and the
 * extractor, which skips hidden things, never sees it.
 */
import { existsSync } from "node:fs";
import { launch, type Browser, type Page } from "puppeteer-core";
import { comparePixels } from "./compare.ts";
import { extractDocument } from "./extract.ts";
import type { ConsoleError, ImageInfo, NetworkFailure, PageSnapshot } from "./types.ts";

// ── Chrome discovery ─────────────────────────────────────────────────────────────────────────────

const PATH_NAMES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "chrome",
];

/** The Chrome this machine's NixOS profile carries; the last resort after the environment and PATH. */
const NIXOS_CHROME =
  "/nix/store/vyghq5mvyvkmz0g51g1sgv7g9zi8raym-google-chrome-154.0.8037.57/share/google/chrome/chrome";

/**
 * Find a Chrome: an explicit path, `CHROME_PATH`, a name on `PATH` (as `@jxsuite/import`'s
 * browser-local does), then the NixOS fallback. Undefined when none exists.
 */
export function findChrome(explicit?: string): string | undefined {
  // A path the caller named is the only one that counts: falling back would run a different Chrome than asked for.
  if (explicit !== undefined && explicit !== "") return existsSync(explicit) ? explicit : undefined;
  const candidates: (string | undefined)[] = [process.env.CHROME_PATH];
  for (const name of PATH_NAMES) candidates.push(Bun.which(name) ?? undefined);
  candidates.push(NIXOS_CHROME);
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== "" && existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ── Noise ────────────────────────────────────────────────────────────────────────────────────────

export interface NoiseConfig {
  /** Elements that are not content and take no space: removed from layout (`display:none`). */
  remove: string[];
  /** Elements whose content cannot be compared but whose box must stay: `visibility:hidden`. */
  blank: string[];
  /** Request patterns Chrome refuses (`*example.com*`), for what only adds noise or malware. */
  blockUrls: string[];
}

/**
 * What is not content, on any site: chat widgets, cookie banners, embedded maps and video,
 * carousels (their auto-advance gives two captures two different slides), review widgets, and
 * injected spam links and scripts (a hidden `<div class="so-widget-content">` right after
 * `<body>`, and `cdn.nodedelivr.com`, a lookalike of the jsDelivr CDN). The analytics and tag
 * managers are blocked on both sides: a tag manager injects popups and pixels no migration carries.
 */
export const DEFAULT_NOISE: NoiseConfig = {
  remove: [
    "body > div.so-widget-content",
    "chat-widget",
    "#lc_text-widget",
    ".lc_text-widget",
    "iframe[src*='leadconnectorhq']",
    "iframe[src*='msgsndr']",
    "#cookie-law-info-bar",
    "#cookie-notice",
    ".cookie-notice-container",
    "#CybotCookiebotDialog",
    "#onetrust-banner-sdk",
    ".cmplz-cookiebanner",
    "[id*='cookie-banner']",
    "[class*='cookie-banner']",
    "#wpadminbar",
  ],
  blank: [
    "iframe[src*='google.com/maps']",
    "iframe[src*='maps.google']",
    "iframe[src*='openstreetmap']",
    "iframe[src*='youtube']",
    "iframe[src*='youtu.be']",
    "iframe[src*='vimeo']",
    "iframe[src*='facebook.com/plugins']",
    "video",
    ".splide",
    ".swiper",
    ".swiper-container",
    ".slick-slider",
    ".owl-carousel",
    ".flickity-enabled",
    ".ti-widget",
    "[class*='trustindex']",
    ".wp-gr",
  ],
  blockUrls: [
    "*nodedelivr.com*",
    "*leadconnectorhq.com*",
    "*msgsndr.com*",
    "*googletagmanager.com*",
    "*google-analytics.com*",
    "*doubleclick.net*",
    "*connect.facebook.net*",
    "*hotjar.com*",
    "*clarity.ms*",
    "*google.com/maps*",
    "*youtube.com*",
    "*youtube-nocookie.com*",
    "*ytimg.com*",
    "*vimeo.com*",
  ],
};

/** The mask lists with extra selectors added (`--mask`). The extra ones blank: the box stays. */
export function withMasks(base: NoiseConfig, extraBlank: readonly string[]): NoiseConfig {
  return {
    remove: [...base.remove],
    blank: [...base.blank, ...extraBlank],
    blockUrls: [...base.blockUrls],
  };
}

/** What every capture injects: no motion, no scroll animation, scroll-triggered fades already done. */
export const BASE_CSS = `
*, *::before, *::after {
  animation: none !important;
  animation-delay: 0s !important;
  transition: none !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
html { scroll-behavior: auto !important; }
[data-aos] { opacity: 1 !important; transform: none !important; }
`;

/** The stylesheet that masks: one rule per selector, so one bad selector cannot take the others down. */
export function maskCss(noise: NoiseConfig): string {
  const rules: string[] = [BASE_CSS.trim()];
  for (const selector of noise.remove) rules.push(`${selector} { display: none !important; }`);
  for (const selector of noise.blank) rules.push(`${selector} { visibility: hidden !important; }`);
  return rules.join("\n");
}

// ── Capture ──────────────────────────────────────────────────────────────────────────────────────

export interface CaptureOptions {
  width: number;
  /** Viewport height; the page is captured whole regardless. Default 900 (844 under 500 px wide). */
  height?: number;
  noise?: NoiseConfig;
  /** Navigation timeout. Default 45 s. */
  navTimeoutMs?: number;
  /** The longest the network-idle wait may take. Default 6 s. */
  idleCapMs?: number;
  /** The longest the wait for images to load and decode may take (a slow host serves big images slowly). Default 30 s. */
  imageCapMs?: number;
  /** The tallest screenshot taken, in pixels (Chrome refuses much past 16,384). Default 16,000. */
  maxHeight?: number;
  /** Take the screenshot (default true). */
  screenshot?: boolean;
}

export interface Capture {
  snapshot: PageSnapshot;
  /** The full-page PNG, absent when the page could not be captured or `screenshot` was false. */
  png?: Buffer;
}

export interface VerifyBrowser {
  capture(url: string, options: CaptureOptions): Promise<Capture>;
  /** Close Chrome. Safe to call twice. */
  close(): Promise<void>;
  readonly chromePath: string;
}

const ENGINE_ARGS = [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  "--mute-audio",
  "--font-render-hinting=none",
  "--force-color-profile=srgb",
  "--disable-lcd-text",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--no-first-run",
  "--no-default-browser-check",
];

const live = new Set<Browser>();
let hooked = false;

/** Kill every Chrome this process started, whatever state the run is in. */
function killAll(): void {
  for (const browser of live) {
    try {
      browser.process()?.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

function hook(): void {
  if (hooked) return;
  hooked = true;
  process.once("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      killAll();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

export interface LaunchOptions {
  executablePath?: string;
}

/** Start Chrome headless. Throws when no Chrome can be found. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<VerifyBrowser> {
  const chromePath = findChrome(options.executablePath);
  if (chromePath === undefined) {
    throw new Error(
      "could not find Chrome: set CHROME_PATH, install google-chrome-stable, or pass --chrome <path>",
    );
  }
  hook();
  const browser = await launch({
    executablePath: chromePath,
    headless: true,
    args: ENGINE_ARGS,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  live.add(browser);
  let userAgent: string | undefined;
  let closed = false;

  return {
    chromePath,
    async capture(url, captureOptions) {
      userAgent ??= (await browser.userAgent()).replace("HeadlessChrome", "Chrome");
      return capturePage(browser, url, captureOptions, userAgent);
    },
    async close() {
      if (closed) return;
      closed = true;
      live.delete(browser);
      try {
        await browser.close();
      } catch {
        browser.process()?.kill("SIGKILL");
      }
    },
  };
}

/** A `*`-wildcard pattern (what `Network.setBlockedURLs` takes) as a regular expression. */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
}

/** The images whose address the noise config refuses, marked: they never load, and that is the capture's doing. */
export function markBlocked(images: readonly ImageInfo[], noise: NoiseConfig): ImageInfo[] {
  const refusals = noise.blockUrls.map((pattern) => globToRegExp(pattern));
  const refused = (url: string): boolean => url !== "" && refusals.some((re) => re.test(url));
  return images.map((image) =>
    refused(image.currentSrc) || refused(image.src) ? { ...image, blocked: true } : image,
  );
}

/** The most request addresses a snapshot keeps. */
const MAX_REQUESTS = 3000;

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function emptySnapshot(
  url: string,
  width: number,
  height: number,
  error: string,
  extra: Partial<PageSnapshot> = {},
): PageSnapshot {
  return {
    requestedUrl: url,
    finalUrl: url,
    status: null,
    viewport: { width, height },
    title: "",
    description: "",
    canonical: "",
    robots: "",
    lang: "",
    docWidth: 0,
    docHeight: 0,
    textBlocks: [],
    headings: [],
    links: [],
    images: [],
    elements: [],
    overflow: { scrollWidth: 0, clientWidth: width, overflow: false, offenders: [] },
    truncated: 0,
    consoleErrors: [],
    failedRequests: [],
    error,
    ...extra,
  };
}

/** The ways a request can end that are the oracle's own doing, not the page's. */
const NOT_THE_PAGES_FAULT = /ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/;

async function capturePage(
  browser: Browser,
  url: string,
  options: CaptureOptions,
  userAgent: string,
): Promise<Capture> {
  const width = options.width;
  const height = options.height ?? (width < 500 ? 844 : 900);
  const noise = options.noise ?? DEFAULT_NOISE;
  const navTimeout = options.navTimeoutMs ?? 45_000;
  const idleCap = options.idleCapMs ?? 6_000;
  const imageCap = options.imageCapMs ?? 30_000;
  const maxHeight = options.maxHeight ?? 16_000;
  const css = maskCss(noise);

  let context: Awaited<ReturnType<Browser["createBrowserContext"]>>;
  try {
    context = await browser.createBrowserContext();
  } catch (error) {
    // Chrome is gone (crashed, killed): every page from here on is a failed capture, not a failed run.
    return {
      snapshot: emptySnapshot(
        url,
        width,
        options.height ?? height,
        `capture failed: ${(error as Error).message}`,
      ),
    };
  }
  try {
    const page = await context.newPage();
    // What we told Chrome to refuse fails by our doing; Chrome does not always say so in the error text.
    const refusals = noise.blockUrls.map((pattern) => globToRegExp(pattern));
    const refused = (url: string): boolean => refusals.some((re) => re.test(url));
    const consoleErrors: ConsoleError[] = [];
    const failedRequests: NetworkFailure[] = [];
    const requests = new Set<string>();
    page.on("request", (request) => {
      const address = request.url();
      if (requests.size < MAX_REQUESTS && /^https?:/i.test(address)) requests.add(address);
    });

    // Chrome probes /favicon.ico by itself, and not every time: a probe that 404s says nothing about the page.
    const isFaviconProbe = (url: string | undefined): boolean =>
      url !== undefined && /\/favicon\.ico(?:$|\?)/.test(url);
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const location = message.location();
      if (isFaviconProbe(location.url)) return;
      consoleErrors.push({
        message: message.text(),
        ...(location.url === undefined || location.url === "" ? {} : { url: location.url }),
      });
    });
    page.on("pageerror", (error) => {
      consoleErrors.push({ message: error instanceof Error ? error.message : String(error) });
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "failed";
      if (
        NOT_THE_PAGES_FAULT.test(failure) ||
        isFaviconProbe(request.url()) ||
        refused(request.url())
      )
        return;
      failedRequests.push({ url: request.url(), failure });
    });
    page.on("response", (response) => {
      if (response.status() >= 400 && !isFaviconProbe(response.url())) {
        failedRequests.push({ url: response.url(), status: response.status() });
      }
    });

    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setUserAgent({ userAgent });
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-color-scheme", value: "light" },
    ]);
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: noise.blockUrls });
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await page.evaluateOnNewDocument((sheet: string) => {
      const inject = (): void => {
        if (document.getElementById("__wp2jx_verify") !== null) return;
        const target = document.head ?? document.documentElement;
        if (target === null) return;
        const style = document.createElement("style");
        style.id = "__wp2jx_verify";
        style.textContent = sheet;
        target.appendChild(style);
      };
      inject();
      document.addEventListener("DOMContentLoaded", inject);
    }, css);

    let status: number | null = null;
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });
      status = response?.status() ?? null;
    } catch (error) {
      return {
        snapshot: emptySnapshot(
          url,
          width,
          height,
          `navigation failed: ${(error as Error).message}`,
          {
            consoleErrors,
            failedRequests,
          },
        ),
      };
    }
    await page
      .waitForFunction(() => document.readyState === "complete", { timeout: idleCap })
      .catch(() => {});
    await settle(page, idleCap, imageCap, maxHeight);

    const extracted = await page.evaluate(extractDocument, { maxElements: 1500, maxBlocks: 3000 });
    const snapshot: PageSnapshot = {
      ...extracted,
      images: markBlocked(extracted.images, noise),
      requests: [...requests],
      requestedUrl: url,
      finalUrl: page.url(),
      status,
      viewport: { width, height },
      consoleErrors,
      failedRequests,
    };

    if (options.screenshot === false) return { snapshot };
    const shotHeight = Math.max(1, Math.min(snapshot.docHeight, maxHeight));
    if (snapshot.docHeight > maxHeight) snapshot.clippedAt = maxHeight;
    const shoot = async (): Promise<Buffer> =>
      Buffer.from(
        await page.screenshot({
          type: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height: shotHeight },
        }),
      );
    // A shot is taken until two in a row are the same pixels: a late decode, a font swap or a lazy
    // paint changes the second, and then the third settles it. A page that never settles (a script
    // animating without end) keeps its last shot and is marked, so its score is read with care.
    let png = await shoot();
    let settled = false;
    for (let attempt = 0; attempt < 3 && !settled; attempt++) {
      await delay(150);
      const next = await shoot();
      settled = next.equals(png) || comparePixels(png, next).visual.fidelity >= 0.9999;
      png = next;
    }
    if (!settled) snapshot.unstable = true;
    return { snapshot, png };
  } catch (error) {
    return {
      snapshot: emptySnapshot(
        url,
        width,
        options.height ?? 900,
        `capture failed: ${(error as Error).message}`,
      ),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Bring the page to rest: fonts in, lazy images loaded (made eager and scrolled into view), the
 * network quiet, the height steady, scrolled back to the top.
 */
async function settle(
  page: Page,
  idleCap: number,
  imageCap: number,
  maxHeight: number,
): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 600, timeout: idleCap }).catch(() => {});
  await page.evaluate(async () => {
    await document.fonts?.ready;
    // Eager, and decoded when painted: an `async` decode of a big image can still be pending when a
    // tall screenshot is rasterised, which leaves an empty box where the picture is.
    for (const img of Array.from(document.images)) {
      img.loading = "eager";
      img.decoding = "sync";
    }
  });
  // Scroll through the page so scroll-triggered loading and reveal scripts run.
  await page.evaluate(async (cap: number) => {
    const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    let y = 0;
    for (let i = 0; i < 80; i++) {
      const total = Math.min(document.documentElement.scrollHeight, cap);
      if (y >= total) break;
      window.scrollTo(0, y);
      await wait(110);
      y += step;
    }
    window.scrollTo(0, 0);
  }, maxHeight);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: idleCap }).catch(() => {});
  // Every image loaded AND decoded: `complete` is true while a `decoding="async"` image is still
  // being decoded, and a screenshot taken then shows an empty box. Wait for them, but not forever.
  await page
    .evaluate(async (cap: number) => {
      const ready = (img: HTMLImageElement): Promise<void> =>
        new Promise<void>((done) => {
          const decode = (): void => {
            img.decode().then(
              () => done(),
              () => done(),
            );
          };
          if (img.complete) decode();
          else {
            img.addEventListener("load", decode, { once: true });
            img.addEventListener("error", () => done(), { once: true });
          }
        });
      await Promise.race([
        Promise.all(Array.from(document.images).map(ready)),
        new Promise<void>((done) => setTimeout(done, cap)),
      ]);
      await document.fonts?.ready;
      // Two frames: what was decoded is painted before the shot.
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
    }, imageCap)
    .catch(() => {});
  // The height settles once late scripts (sliders, embeds) have done their layout.
  let last = -1;
  for (let i = 0; i < 6; i++) {
    const now = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    );
    if (now === last) break;
    last = now;
    await delay(200);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}
