/**
 * Addresses, for the oracle: which URLs to compare, and when two addresses are the same place.
 *
 * The URL list comes from the live site's sitemaps (Rank Math's `sitemap_index.xml`, WordPress's
 * `wp-sitemap.xml`, a plain `sitemap.xml`, or whatever `robots.txt` names), from a file, or from the
 * migrated site itself. Equivalence is the resolver's job: a link is reduced to a path (or an
 * absolute address when it leaves the site), followed through the redirect table, given the
 * directory form (`/about` and `/about/` are one page) and, for uploaded media, reduced to the
 * file's family name, so `/wp-content/uploads/2024/03/barn-300x200.jpg` on the live site and
 * `/media/barn.jpg` on the migrated one are the same picture.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRedirects, type RedirectRule } from "./redirects.ts";

// ── Equivalence ──────────────────────────────────────────────────────────────────────────────────

export interface Resolver {
  liveOrigin: string;
  localOrigin: string;
  /**
   * A comparable key for an address found on a page, or undefined when it names nothing to compare
   * (`#top`, `javascript:`, an empty href). Same-site addresses become paths (redirects followed,
   * trailing slash added), media become `media:<family>`, mail and phone links their scheme and
   * target, and every other address its origin and path without a trailing slash.
   */
  normalize(href: string, base?: string, followRedirects?: boolean): string | undefined;
  /** A key for an image address: its file's family name, which survives a move to `/media/` and a size suffix. */
  imageKey(src: string): string;
  /** Whether an address is on the site (the live origin, its `www` twin, or the local server). */
  isInternal(href: string, base?: string): boolean;
}

const SIZE_SUFFIX = /-\d+x\d+(?=\.|$)/;
const SCALED_SUFFIX = /-scaled(?=\.|$)/;
// A file name ends in one image extension, or two when a converter appended its own (`logo.png.webp`).
const IMAGE_EXTENSIONS = /(?:\.(?:jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico))+$/i;
// What the Jx image pipeline appends to a derivative: `<name>-<width>-<hash>`, under `/images/_optimized/`.
const PIPELINE_SUFFIX = /-\d{2,5}-[0-9a-f]{8}$/;

/**
 * A file name reduced to its family: no extension (or extensions), no `-WxH`, no `-scaled`, no Jx
 * pipeline suffix when `optimized`, lower case. A WordPress size copy, a converter's `.png.webp`
 * and a pipeline derivative of one upload all come out as the same name.
 */
export function familyName(fileName: string, optimized = false): string {
  let name = fileName;
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep as is
  }
  name = name.toLowerCase().replace(IMAGE_EXTENSIONS, "");
  if (optimized) name = name.replace(PIPELINE_SUFFIX, "");
  return name.replace(SIZE_SUFFIX, "").replace(SCALED_SUFFIX, "").replace(SIZE_SUFFIX, "");
}

const MEDIA_PATH = /^\/(?:wp-content\/uploads|media)\//i;

export function createResolver(opts: {
  liveUrl: string;
  localOrigin: string;
  rules?: readonly RedirectRule[];
}): Resolver {
  const live = new URL(opts.liveUrl);
  const local = new URL(opts.localOrigin);
  const rules = opts.rules ?? [];
  const bare = (host: string): string => host.replace(/^www\./, "");
  const internalHosts = new Set([bare(live.host), bare(local.host)]);

  const liveBare = bare(live.hostname);
  const isSiblingHost = (url: URL): boolean =>
    (url.protocol === "http:" || url.protocol === "https:") &&
    bare(url.hostname).endsWith(`.${liveBare}`);

  const parse = (href: string, base?: string): URL | undefined => {
    try {
      return new URL(href, base ?? `${live.origin}/`);
    } catch {
      return undefined;
    }
  };
  const isInternalUrl = (url: URL): boolean =>
    (url.protocol === "http:" || url.protocol === "https:") && internalHosts.has(bare(url.host));

  const withSlash = (path: string): string => {
    if (path.endsWith("/")) return path;
    const last = path.slice(path.lastIndexOf("/") + 1);
    return last.includes(".") ? path : `${path}/`;
  };

  const external = (url: URL): string =>
    `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;

  return {
    liveOrigin: live.origin,
    localOrigin: local.origin,
    normalize(href, base, followRedirects = true) {
      const raw = href.trim();
      if (raw === "" || raw.startsWith("#") || /^javascript:/i.test(raw)) return undefined;
      const url = parse(raw, base);
      if (url === undefined) return undefined;
      if (url.protocol === "mailto:" || url.protocol === "tel:") {
        // A malformed escape in somebody's contact link is theirs to fix, not a reason to lose the page.
        let target = url.pathname;
        try {
          target = decodeURIComponent(target);
        } catch {
          // keep the encoded form
        }
        return `${url.protocol}${target.toLowerCase().replace(/\s+/g, "")}`;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
      if (!isInternalUrl(url)) {
        // A file on another host of the same site (a media subdomain) is an upload like any other:
        // the migration moves it to /media/ whatever folder it sat in over there.
        if (
          isSiblingHost(url) &&
          url.pathname.slice(url.pathname.lastIndexOf("/") + 1).includes(".")
        ) {
          return `media:${familyName(url.pathname.slice(url.pathname.lastIndexOf("/") + 1))}`;
        }
        return external(url);
      }
      if (MEDIA_PATH.test(url.pathname)) {
        return `media:${familyName(url.pathname.slice(url.pathname.lastIndexOf("/") + 1))}`;
      }
      // Where a page ENDED is not redirected again: only a link, which has yet to be followed, is.
      const chain = resolveRedirects(followRedirects ? rules : [], withSlash(url.pathname));
      const target = chain.path;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        const dest = parse(target);
        if (dest === undefined) return target;
        if (isInternalUrl(dest)) return `${withSlash(dest.pathname)}${dest.search}`;
        return external(dest);
      }
      return `${withSlash(target)}${url.search}`;
    },
    imageKey(src) {
      if (src.startsWith("data:")) return `data:${src.slice(0, 40)}`;
      const url = parse(src);
      if (url === undefined) return src;
      return familyName(
        url.pathname.slice(url.pathname.lastIndexOf("/") + 1),
        url.pathname.includes("/_optimized/"),
      );
    },
    isInternal(href, base) {
      const url = parse(href, base);
      return url !== undefined && isInternalUrl(url);
    },
  };
}

// ── The URL list ─────────────────────────────────────────────────────────────────────────────────

const NOT_A_PAGE =
  /\.(?:jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|mp4|mp3|webm|css|js|json|xml|txt)(?:$|\?)/i;

const LOC = /<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*?))\s*<\/loc>/i;

/**
 * The `<loc>` entries of a sitemap, and whether the document is an index of further sitemaps.
 * `empty` counts the entries that had no readable `<loc>`, so a short list is never a silent one.
 */
export function parseSitemap(xml: string): { index: boolean; locs: string[]; empty?: number } {
  const index = /<sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  let empty = 0;
  const entries = index
    ? /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi
    : /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  for (let match = entries.exec(xml); match !== null; match = entries.exec(xml)) {
    const found = LOC.exec(match[1] ?? "");
    const cdata = found?.[1];
    const plain = found?.[2];
    if (cdata !== undefined && cdata.trim() !== "") locs.push(cdata.trim());
    else if (plain !== undefined && plain !== "") {
      // `&amp;` last: `&amp;lt;` is the text `&lt;`, not `<`.
      locs.push(
        plain
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#0?39;/g, "'")
          .replace(/&amp;/g, "&"),
      );
    } else empty += 1;
  }
  return empty === 0 ? { index, locs } : { index, locs, empty };
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

const defaultFetch: Fetcher = (url) =>
  fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/154 wp2jx-verify" },
  });

export interface SitemapResult {
  urls: string[];
  /** The sitemap documents read, in order. */
  sources: string[];
  /** Addresses that failed to read, with why. */
  problems: string[];
}

/**
 * Every page URL the live site lists: `sitemap_index.xml`, `wp-sitemap.xml`, `sitemap.xml` and the
 * `Sitemap:` lines of `robots.txt`, indexes followed to their sitemaps. Only addresses on the live
 * origin that are not files (images, PDFs, feeds) are returned, in sitemap order, without repeats.
 */
export async function readLiveSitemaps(
  liveUrl: string,
  fetcher: Fetcher = defaultFetch,
  limit = 400,
): Promise<SitemapResult> {
  const origin = new URL(liveUrl).origin;
  const named: string[] = [];
  const problems: string[] = [];
  try {
    const robots = await fetcher(`${origin}/robots.txt`);
    if (robots.ok) {
      for (const line of (await robots.text()).split(/\r?\n/)) {
        const match = /^\s*sitemap:\s*(\S+)/i.exec(line);
        if (match?.[1] !== undefined) named.push(match[1]);
      }
    }
  } catch {
    // robots.txt is a hint, not a requirement
  }
  const conventional = ["sitemap_index.xml", "wp-sitemap.xml", "sitemap.xml"].map(
    (name) => `${origin}/${name}`,
  );

  const urls: string[] = [];
  const sources: string[] = [];
  const seenUrls = new Set<string>();
  const seenDocs = new Set<string>();
  let read = 0;

  const walk = async (address: string, entry: boolean): Promise<void> => {
    if (seenDocs.has(address) || read >= limit) return;
    seenDocs.add(address);
    let text: string;
    try {
      const response = await fetcher(address);
      if (!response.ok) {
        if (!entry) problems.push(`${address}: not readable`);
        return;
      }
      text = await response.text();
    } catch (error) {
      problems.push(`${address}: ${(error as Error).message}`);
      return;
    }
    if (!/<(?:urlset|sitemapindex)[\s>]/i.test(text)) return;
    read += 1;
    sources.push(address);
    const parsed = parseSitemap(text);
    if (parsed.empty !== undefined) {
      problems.push(`${address}: ${parsed.empty} entries without a <loc>`);
    }
    if (parsed.index) {
      for (const child of parsed.locs) await walk(child, false);
      return;
    }
    for (const loc of parsed.locs) {
      let url: URL;
      try {
        url = new URL(loc);
      } catch {
        continue;
      }
      if (url.origin !== origin || NOT_A_PAGE.test(url.pathname)) continue;
      const key = `${url.pathname}${url.search}`;
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      urls.push(`${origin}${key}`);
    }
  };

  // Every sitemap robots.txt names is part of the list (a site may split posts and pages across
  // several); the conventional names are the same pages under another name, so they only stand in
  // when robots.txt gave nothing.
  for (const entry of named) await walk(entry, true);
  for (const entry of conventional) {
    if (urls.length > 0) break;
    await walk(entry, true);
  }
  return { urls, sources, problems };
}

/** A URL file: a JSON array, or one address (absolute or a path) per line; `#` starts a comment. */
export function readUrlFile(file: string, liveUrl: string): string[] {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`--urls ${file}: no such file`);
  const text = readFileSync(path, "utf8");
  const origin = new URL(liveUrl).origin;
  let items: string[];
  if (text.trimStart().startsWith("[")) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error(`--urls ${file}: a JSON file must be an array of strings`);
    }
    items = parsed as string[];
  } else {
    items = text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+#.*$/, "").trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = new URL(item, `${origin}/`);
    const key = `${url.pathname}${url.search}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${origin}${key}`);
  }
  return out;
}

/** The path (and query) of an address, for the local server and for naming. */
export function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Pick at most `max` addresses: the home page first, then an even spread over the rest, so a
 * small run still samples every kind of page the sitemap lists rather than its first dozen.
 */
export function sample(urls: readonly string[], max: number | undefined): string[] {
  if (max === undefined || urls.length <= max) return [...urls];
  if (max <= 0) return [];
  const home = urls.filter((url) => new URL(url).pathname === "/");
  const rest = urls.filter((url) => new URL(url).pathname !== "/");
  const room = max - home.length;
  const picked: string[] = [...home];
  if (room > 0 && rest.length > 0) {
    const step = rest.length / room;
    const seen = new Set<number>();
    for (let i = 0; i < room; i++) {
      let index = Math.min(rest.length - 1, Math.floor(i * step));
      while (seen.has(index) && index < rest.length - 1) index += 1;
      seen.add(index);
      picked.push(rest[index] as string);
    }
  }
  return picked.slice(0, max);
}

/** A short, unique, file-system-safe name for a page. */
export function slugOf(url: string, taken: Set<string>): string {
  const parsed = new URL(url);
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the encoded form
  }
  // No leading dot: `..` and `.` are folders, not names, and a decoded `%2e%2e%2f` is one.
  let base =
    path
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^[._]*(?=[A-Za-z0-9-])|^[._]+$/, "")
      .slice(0, 80) || "index";
  if (parsed.search !== "") base += `_q${Bun.hash(parsed.search).toString(36).slice(0, 6)}`;
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  taken.add(slug);
  return slug;
}
