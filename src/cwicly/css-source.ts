/**
 * Where Cwicly's generated stylesheets are read from: an uploads directory on disk, or the live
 * site.
 *
 * Cwicly writes them under `wp-content/uploads/cwicly/`: the per-post, per-template, per-component
 * and per-reusable-block files (`cc-post-*`, `cc-tp-*`, `cc-cm-*`, `cc-rb-*`) in a `css/`
 * subdirectory, and the site-wide ones (`cc-global-*`, `cc-main`) beside it. A source answers by
 * file name and hides which of the two it was found in.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CssSource } from "../types.ts";

/** A stylesheet name is a file name. Anything that could walk out of the root is a caller's bug. */
function checkName(name: string): void {
  if (name === "" || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`invalid stylesheet name: ${JSON.stringify(name)}`);
  }
}

/** The text of a file, or null when there is no such file; every other failure throws. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * A source over a local uploads directory (`wp-content/uploads/cwicly`, or a copy of it).
 * `get(name)` tries `<dir>/<name>`, then `<dir>/css/<name>`, and answers null when neither exists.
 */
export function dirCssSource(dir: string): CssSource {
  return {
    async get(name) {
      checkName(name);
      for (const candidate of [join(dir, name), join(dir, "css", name)]) {
        const text = await readIfPresent(candidate);
        if (text !== null) return text;
      }
      return null;
    },
  };
}

export interface UrlCssSourceOptions {
  /**
   * Keep every fetched stylesheet here. Cwicly's file names repeat from site to site
   * (`cc-global-classes.css`, `cc-tp-cwicly_header.css`), so each site gets a directory of its own
   * inside it, named for the site's host and a hash of its uploads URL (`urlCssCacheDir` gives the
   * path), and one directory can serve any number of sites without one answering for another. A
   * cached file is trusted as it stands (no revalidation), so delete the site's directory to
   * refresh it.
   *
   * A stylesheet the site answered 404 for is remembered too, for `absentTtlMs`: a post that has no
   * Cwicly stylesheet is most of a site's posts (1,244 of them on one pilot), and without that
   * every re-run would ask the live site for each again. The marker is a file under the site's
   * directory (`.absent/<name>`) that holds the time it expires; an expired or unreadable one
   * counts for nothing. Only a clean "not there" (a 404 or 410, or an HTML page standing in for
   * one, at every place the name is looked for) is remembered: a failed request never is.
   */
  cacheDir?: string | undefined;
  /**
   * How long "this stylesheet does not exist" is believed, in milliseconds, when there is a
   * `cacheDir`. Default 24 hours; 0 asks the site every time, as before.
   */
  absentTtlMs?: number | undefined;
  /** The clock, in milliseconds since the epoch. Default `Date.now`. */
  now?: (() => number) | undefined;
  /** Most requests in flight at once. Default 6. */
  concurrency?: number | undefined;
  /** Longest one request may take, from sending it to the last byte of the body. Default 30 000. */
  timeoutMs?: number | undefined;
}

/** A "this stylesheet does not exist" a source believed instead of asking the site: where it is kept and when it stops being believed. */
export interface RememberedAbsence {
  /** The marker file; deleting it makes the next run ask the site. */
  file: string;
  /** Milliseconds since the epoch. */
  expires: number;
}

/**
 * A live site's source, which can also say which names it answered from a marker. A remembered 404
 * and a fresh one read the same to the converter (`null`), and only the source knows which it was.
 */
export interface UrlCssSource extends CssSource {
  /** The marker that answered `name` in this process, or undefined when the site was asked (or the name was found). */
  remembered(name: string): RememberedAbsence | undefined;
}

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ABSENT_TTL_MS = 24 * 60 * 60_000;

/** The directory inside a site's cache directory that holds the markers of the stylesheets it does not have. */
const ABSENT_DIR = ".absent";

/** Where a site keeps its stylesheets: `<baseUrl>/wp-content/uploads/cwicly/`, one slash after the base however it was written. */
const uploadsRoot = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/wp-content/uploads/cwicly/`;

/**
 * The directory inside `cacheDir` that holds one site's stylesheets: the host (readable) and a hash
 * of the uploads URL (so that two WordPress installs on one host, `example.com` and
 * `example.com/blog`, are two sites).
 */
export function urlCssCacheDir(cacheDir: string, baseUrl: string): string {
  let root = uploadsRoot(baseUrl);
  let host = "site";
  try {
    // The parsed form lower-cases the host and drops a default port, so the same site is one site.
    const url = new URL(root);
    root = url.href;
    host = url.host;
  } catch {
    // Not a URL: the text as written tells sites apart.
  }
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 8);
  return join(cacheDir, `${host.replace(/[^A-Za-z0-9.-]+/g, "_")}-${hash}`);
}

/** The files Cwicly keeps in `css/`; everything else it names (`cc-global-*`, `cc-main`) is beside it. */
const NESTED_NAME = /^cc-(?:post|tp|cm|rb)-/;

/** Locations to try for a name, in order. A name of a known kind goes straight to where it lives. */
function locations(name: string): string[] {
  return NESTED_NAME.test(name) ? ["css/", ""] : ["", "css/"];
}

/** A counting semaphore: at most `max` of the wrapped calls run at once, the rest wait in order. */
function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < max) {
      active += 1;
    } else {
      // Whichever call finishes next hands its slot over, so `active` is not touched here.
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

/** What a failed request says: a refused connection, a reset or a timeout does not name the URL, and the person reading the report needs it. */
const failure = (url: string, error: unknown): Error =>
  new Error(`GET ${url} failed: ${(error as Error).message}`, { cause: error });

/** The body of a stylesheet response, or null for a 404/410 or an HTML page standing in for one. */
async function fetchStylesheet(url: string, timeoutMs: number): Promise<string | null> {
  // One signal for the whole request: it is also what ends a body that stalls after the headers.
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { accept: "text/css,*/*;q=0.1" } });
  } catch (error) {
    throw failure(url, error);
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  // Some hosts answer a missing upload with their 200 "not found" page; that is not a stylesheet.
  if (/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel();
    return null;
  }
  try {
    return await response.text();
  } catch (error) {
    // The connection can drop, or the timeout fire, after the headers have arrived.
    throw failure(url, error);
  }
}

/**
 * A source over a live site: `<baseUrl>/wp-content/uploads/cwicly/<name>` or `…/css/<name>`.
 *
 * A 404 (or 410) is "no such stylesheet" and answers null; any other failure (5xx, 403, a network
 * error, a body cut off half way, a timeout) throws with the URL in the message, because a transient
 * error must not pass for an absent file. Requests are limited to `concurrency` at a time across
 * all callers, and a name asked for twice is fetched once.
 */
export function urlCssSource(baseUrl: string, opts: UrlCssSourceOptions = {}): UrlCssSource {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive number, got ${timeoutMs}`);
  }
  const absentTtlMs = opts.absentTtlMs ?? DEFAULT_ABSENT_TTL_MS;
  if (!Number.isFinite(absentTtlMs) || absentTtlMs < 0) {
    throw new RangeError(`absentTtlMs must be zero or a positive number, got ${absentTtlMs}`);
  }
  const now = opts.now ?? Date.now;
  const root = uploadsRoot(baseUrl);
  const cacheDir = opts.cacheDir === undefined ? undefined : urlCssCacheDir(opts.cacheDir, baseUrl);
  const limit = limiter(concurrency);
  const pending = new Map<string, Promise<string | null>>();
  const believed = new Map<string, RememberedAbsence>();

  async function load(name: string): Promise<string | null> {
    // The marker directory is the one name of the cache that a stylesheet could also be called.
    const cache = name === ABSENT_DIR ? undefined : cacheDir;
    if (cache !== undefined) {
      const cached = await readIfPresent(join(cache, name));
      if (cached !== null) return cached;
      if (absentTtlMs > 0) {
        const expires = await markedAbsent(cache, name, now());
        if (expires !== undefined) {
          believed.set(name, { file: join(cache, ABSENT_DIR, name), expires });
          return null;
        }
      }
    }
    for (const location of locations(name)) {
      const text = await limit(() =>
        fetchStylesheet(`${root}${location}${encodeURIComponent(name)}`, timeoutMs),
      );
      if (text === null) continue;
      if (cache !== undefined) {
        await store(cache, name, text);
        await rm(join(cache, ABSENT_DIR, name), { force: true });
      }
      return text;
    }
    if (cache !== undefined && absentTtlMs > 0) await markAbsent(cache, name, now() + absentTtlMs);
    return null;
  }

  return {
    async get(name) {
      checkName(name);
      let result = pending.get(name);
      if (result === undefined) {
        result = load(name);
        pending.set(name, result);
        // A failure is not remembered: the next ask tries again.
        result.catch(() => pending.delete(name));
      }
      return result;
    },
    remembered: (name) => believed.get(name),
  };
}

/** Write beside the target and rename into place, so a reader never sees a half-written file. */
async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

const store = (cacheDir: string, name: string, text: string): Promise<void> =>
  writeAtomically(join(cacheDir, name), text);

/** When the unexpired marker for a stylesheet the site does not have stops being believed, or undefined when there is none. */
async function markedAbsent(
  cacheDir: string,
  name: string,
  at: number,
): Promise<number | undefined> {
  const text = await readIfPresent(join(cacheDir, ABSENT_DIR, name));
  if (text === null) return undefined;
  try {
    const marker = JSON.parse(text) as { expires?: unknown };
    return typeof marker.expires === "number" && marker.expires > at ? marker.expires : undefined;
  } catch {
    // Half a marker is no marker: ask the site, and the answer replaces it.
    return undefined;
  }
}

/** Remember that the site does not have a stylesheet, until `expires`. */
const markAbsent = (cacheDir: string, name: string, expires: number): Promise<void> =>
  writeAtomically(join(cacheDir, ABSENT_DIR, name), JSON.stringify({ expires }));
