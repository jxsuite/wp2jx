import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadCssIndex, mergeCssIndexes, parseCwiclyCss } from "../../src/cwicly/css.ts";
import { dirCssSource, urlCssCacheDir, urlCssSource } from "../../src/cwicly/css-source.ts";
import type { CssSource } from "../../src/types.ts";
import {
  FIXTURE_BREAKPOINTS,
  fixtureCssDir,
  fixtureCssNames,
  fixtureCssSource,
  readFixtureCss,
} from "../helpers/fixture-css.ts";
import { readFixtureText } from "../helpers/fixture-db.ts";

const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wp2jx-css-source-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const CSS = { "content-type": "text/css" };

describe("dirCssSource", () => {
  test("reads a file that sits directly in the root", async () => {
    const source = dirCssSource(fixtureCssDir("fineline"));
    expect(await source.get("cc-global-classes.css")).toBe(
      readFixtureCss("fineline", "cc-global-classes.css"),
    );
    expect(await source.get("cc-post-5246.css")).toBe(
      readFixtureCss("fineline", "cc-post-5246.css"),
    );
  });

  test("falls back to <root>/css/<name>, the layout Cwicly writes", async () => {
    const root = tempDir();
    mkdirSync(join(root, "css"));
    writeFileSync(join(root, "cc-global-classes.css"), ".g{color:red}");
    writeFileSync(join(root, "css", "cc-post-1.css"), ".p{color:blue}");
    const source = dirCssSource(root);
    expect(await source.get("cc-global-classes.css")).toBe(".g{color:red}");
    expect(await source.get("cc-post-1.css")).toBe(".p{color:blue}");
  });

  test("the root wins when a name is in both", async () => {
    const root = tempDir();
    mkdirSync(join(root, "css"));
    writeFileSync(join(root, "x.css"), "root");
    writeFileSync(join(root, "css", "x.css"), "css");
    expect(await dirCssSource(root).get("x.css")).toBe("root");
  });

  test("an absent file is null: absent from both places, absent root, `css` being a file", async () => {
    const root = tempDir();
    expect(await dirCssSource(root).get("nope.css")).toBeNull();
    expect(await dirCssSource(join(root, "does-not-exist")).get("nope.css")).toBeNull();
    writeFileSync(join(root, "css"), "i am a file, not a directory");
    expect(await dirCssSource(root).get("nope.css")).toBeNull();
    expect(await fixtureCssSource("ap").get("cc-post-0.css")).toBeNull();
  });

  test("an empty stylesheet is the empty string, not null", async () => {
    // fineline's cc-global-stylesheets.css is empty on the live site.
    expect(await fixtureCssSource("fineline").get("cc-global-stylesheets.css")).toBe("");
  });

  test("a failure that is not 'no such file' throws: a directory where a stylesheet should be", async () => {
    const root = tempDir();
    mkdirSync(join(root, "cc-post-1.css"));
    await expect(dirCssSource(root).get("cc-post-1.css")).rejects.toThrow();
  });

  test("a name that could leave the root is refused, not looked up", async () => {
    const outer = tempDir();
    const inner = join(outer, "inner");
    mkdirSync(inner);
    writeFileSync(join(outer, "secret.css"), "secret");
    const source = dirCssSource(inner);
    for (const name of ["", ".", "..", "../secret.css", "a/b.css", "a\\b.css", "x\0y.css"]) {
      await expect(source.get(name)).rejects.toThrow("invalid stylesheet name");
    }
  });

  test("every stylesheet of both fixture sites can be read back", async () => {
    for (const site of ["fineline", "ap"]) {
      const source = fixtureCssSource(site);
      for (const name of fixtureCssNames(site))
        expect(await source.get(name)).toBe(readFixtureCss(site, name));
    }
  });
});

// ── urlCssSource ─────────────────────────────────────────────────────────────────────────────────

interface Served {
  base: string;
  requests: string[];
  stop(): void;
}

const servers: Served[] = [];
afterEach(() => {
  for (const served of servers.splice(0)) served.stop();
});

/** A loopback HTTP server standing in for a WordPress site; `handler` answers by request path (and sees the headers). */
function serve(handler: (path: string, headers: Headers) => Response | Promise<Response>): Served {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      return handler(path, request.headers);
    },
  });
  const served: Served = {
    base: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => void server.stop(true),
  };
  servers.push(served);
  return served;
}

const UPLOADS = "/wp-content/uploads/cwicly/";
const notFound = (): Response =>
  new Response("<html>Not found</html>", { status: 404, headers: { "content-type": "text/html" } });

describe("urlCssSource", () => {
  test("a per-post file is asked for under css/ first, a global one at the root first", async () => {
    const site = serve((path) => {
      if (path === `${UPLOADS}css/cc-post-1.css`) return new Response(".p{}", { headers: CSS });
      if (path === `${UPLOADS}cc-global-classes.css`) return new Response(".g{}", { headers: CSS });
      return notFound();
    });
    const source = urlCssSource(site.base);
    expect(await source.get("cc-post-1.css")).toBe(".p{}");
    expect(await source.get("cc-global-classes.css")).toBe(".g{}");
    expect(site.requests).toEqual([
      `${UPLOADS}css/cc-post-1.css`,
      `${UPLOADS}cc-global-classes.css`,
    ]);
  });

  test("every Cwicly kind in css/ is found there on the first request", async () => {
    const site = serve((path) =>
      path.startsWith(`${UPLOADS}css/cc-`) ? new Response("a{}", { headers: CSS }) : notFound(),
    );
    const source = urlCssSource(site.base);
    for (const name of [
      "cc-post-5246.css",
      "cc-tp-cwicly_header.css",
      "cc-cm-0a275b695a.css",
      "cc-rb-11.css",
    ]) {
      expect(await source.get(name)).toBe("a{}");
    }
    expect(site.requests).toHaveLength(4);
  });

  test("a name of no known kind tries the root, then css/", async () => {
    const site = serve((path) =>
      path === `${UPLOADS}css/extra.css` ? new Response("x{}", { headers: CSS }) : notFound(),
    );
    expect(await urlCssSource(site.base).get("extra.css")).toBe("x{}");
    expect(site.requests).toEqual([`${UPLOADS}extra.css`, `${UPLOADS}css/extra.css`]);
  });

  test("404 in both places is null (and 410 is the same)", async () => {
    const gone = serve((path) =>
      path.includes("/css/") ? new Response("gone", { status: 410 }) : notFound(),
    );
    expect(await urlCssSource(gone.base).get("cc-post-9.css")).toBeNull();
    expect(gone.requests).toEqual([`${UPLOADS}css/cc-post-9.css`, `${UPLOADS}cc-post-9.css`]);
  });

  test("a 200 HTML page standing in for a missing stylesheet is null, not CSS", async () => {
    const soft = serve(
      () =>
        new Response("<html><body>Page not found</body></html>", {
          headers: { "content-type": "text/html; charset=UTF-8" },
        }),
    );
    expect(await urlCssSource(soft.base).get("cc-post-9.css")).toBeNull();
  });

  test("any other failure throws and names the URL and status: 500, 403, a refused connection", async () => {
    const broken = serve(
      () => new Response("oops", { status: 500, statusText: "Internal Server Error" }),
    );
    await expect(urlCssSource(broken.base).get("cc-post-1.css")).rejects.toThrow(
      `${UPLOADS}css/cc-post-1.css failed: 500`,
    );
    const forbidden = serve(() => new Response("no", { status: 403 }));
    await expect(urlCssSource(forbidden.base).get("cc-global-classes.css")).rejects.toThrow("403");
    const dead = serve(() => notFound());
    const base = dead.base;
    dead.stop();
    await expect(urlCssSource(base).get("cc-post-1.css")).rejects.toThrow(
      `${base}${UPLOADS}css/cc-post-1.css failed:`,
    );
  });

  test("a failure is not remembered: asking again after the site recovers succeeds", async () => {
    let healthy = false;
    const site = serve(() =>
      healthy ? new Response("a{}", { headers: CSS }) : new Response("down", { status: 503 }),
    );
    const source = urlCssSource(site.base);
    await expect(source.get("cc-post-1.css")).rejects.toThrow("503");
    healthy = true;
    expect(await source.get("cc-post-1.css")).toBe("a{}");
  });

  test("a name asked for twice at once is fetched once, and a settled answer (even null) is reused", async () => {
    const site = serve(async (path) => {
      await Bun.sleep(10);
      return path.endsWith("cc-post-1.css") ? new Response("a{}", { headers: CSS }) : notFound();
    });
    const source = urlCssSource(site.base);
    const [first, second] = await Promise.all([
      source.get("cc-post-1.css"),
      source.get("cc-post-1.css"),
    ]);
    expect(first).toBe("a{}");
    expect(second).toBe("a{}");
    expect(site.requests).toHaveLength(1);
    expect(await source.get("cc-post-1.css")).toBe("a{}");
    expect(await source.get("cc-post-2.css")).toBeNull();
    const asked = site.requests.length;
    expect(await source.get("cc-post-2.css")).toBeNull();
    expect(site.requests).toHaveLength(asked);
  });

  test("at most `concurrency` requests are in flight at once, and all of them complete", async () => {
    let inFlight = 0;
    let peak = 0;
    const site = serve(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(25);
      inFlight -= 1;
      return new Response("a{}", { headers: CSS });
    });
    const names = Array.from({ length: 9 }, (_, i) => `cc-post-${i}.css`);
    const source = urlCssSource(site.base, { concurrency: 2 });
    const results = await Promise.all(names.map((name) => source.get(name)));
    expect(results).toEqual(names.map(() => "a{}"));
    expect(peak).toBe(2);
    expect(site.requests).toHaveLength(9);
  });

  test("the default limit is finite but allows overlap", async () => {
    let inFlight = 0;
    let peak = 0;
    const site = serve(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(20);
      inFlight -= 1;
      return new Response("a{}", { headers: CSS });
    });
    const source = urlCssSource(site.base);
    await Promise.all(Array.from({ length: 20 }, (_, i) => source.get(`cc-post-${i}.css`)));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  test("the limit is shared by a name's fallback request too (a miss then a hit stays within it)", async () => {
    let inFlight = 0;
    let peak = 0;
    const site = serve(async (path) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(15);
      inFlight -= 1;
      return path.includes("/css/") ? new Response("a{}", { headers: CSS }) : notFound();
    });
    const source = urlCssSource(site.base, { concurrency: 1 });
    // `extra-N.css` has no known kind: root (404) first, then css/.
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => source.get(`extra-${i}.css`)),
    );
    expect(results).toEqual(["a{}", "a{}", "a{}", "a{}"]);
    expect(peak).toBe(1);
    expect(site.requests).toHaveLength(8);
  });

  test("a concurrency that is not a positive integer is refused", () => {
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      expect(() => urlCssSource("http://127.0.0.1:1", { concurrency })).toThrow(RangeError);
    }
  });

  test("the base URL may end in slashes or carry a path (WordPress in a subdirectory)", async () => {
    const site = serve((path) =>
      path === `/blog${UPLOADS}css/cc-post-1.css`
        ? new Response("a{}", { headers: CSS })
        : notFound(),
    );
    expect(await urlCssSource(`${site.base}/blog//`).get("cc-post-1.css")).toBe("a{}");
    expect(site.requests).toEqual([`/blog${UPLOADS}css/cc-post-1.css`]);
  });

  test("a name is percent-encoded in the request (`#` and `?` are not URL syntax), and the body is decoded as text", async () => {
    const site = serve((path) =>
      path === `${UPLOADS}css/cc-tp-a%23b%3Fc%20d.css`
        ? new Response('.a::before{content:"é—✓"}', { headers: CSS })
        : notFound(),
    );
    expect(await urlCssSource(site.base).get("cc-tp-a#b?c d.css")).toBe(
      '.a::before{content:"é—✓"}',
    );
  });

  test("a name that could leave the uploads directory is refused before any request", async () => {
    const site = serve(() => notFound());
    const source = urlCssSource(site.base);
    for (const name of ["", "..", "../x.css", "a/b.css", "a\\b.css"]) {
      await expect(source.get(name)).rejects.toThrow("invalid stylesheet name");
    }
    expect(site.requests).toEqual([]);
  });
});

describe("urlCssSource: requests that go wrong half way", () => {
  /** A raw TCP server that promises 1000 bytes, sends the start of a stylesheet and drops the connection. */
  function dropsMidBody(): Served {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write(
            "HTTP/1.1 200 OK\r\ncontent-type: text/css\r\ncontent-length: 1000\r\n\r\n.a{color:red}",
          );
          setTimeout(() => socket.terminate(), 20);
        },
        open() {},
        close() {},
        error() {},
      },
    });
    const served: Served = {
      base: `http://127.0.0.1:${server.port}`,
      requests: [],
      stop: () => void server.stop(true),
    };
    servers.push(served);
    return served;
  }

  test("a connection dropped while the body is being read throws with the URL, like one refused before it", async () => {
    const site = dropsMidBody();
    await expect(urlCssSource(site.base).get("cc-post-1.css")).rejects.toThrow(
      `GET ${site.base}${UPLOADS}css/cc-post-1.css failed:`,
    );
  });

  test("a body cut off is not cached, and not remembered: asking again asks the site again", async () => {
    const cacheDir = tempDir();
    const site = dropsMidBody();
    const source = urlCssSource(site.base, { cacheDir });
    await expect(source.get("cc-post-1.css")).rejects.toThrow("cc-post-1.css failed");
    expect(readdirSync(cacheDir)).toEqual([]);
    await expect(source.get("cc-post-1.css")).rejects.toThrow("cc-post-1.css failed");
  });

  test("a site that never answers is cut off at the timeout, naming the URL", async () => {
    const silent = serve(() => new Promise<Response>(() => {}));
    const started = Date.now();
    await expect(urlCssSource(silent.base, { timeoutMs: 80 }).get("cc-post-1.css")).rejects.toThrow(
      `GET ${silent.base}${UPLOADS}css/cc-post-1.css failed:`,
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a body that stalls after the headers is cut off at the same timeout, naming the URL", async () => {
    const stalled = serve(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(".a{color:red}"));
              // Never closed.
            },
          }),
          { headers: CSS },
        ),
    );
    const started = Date.now();
    await expect(
      urlCssSource(stalled.base, { timeoutMs: 80 }).get("cc-post-1.css"),
    ).rejects.toThrow(`GET ${stalled.base}${UPLOADS}css/cc-post-1.css failed:`);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a response inside the timeout is not affected by it", async () => {
    const slow = serve(async () => {
      await Bun.sleep(30);
      return new Response("a{}", { headers: CSS });
    });
    expect(await urlCssSource(slow.base, { timeoutMs: 2000 }).get("cc-post-1.css")).toBe("a{}");
  });

  test("a timeout that is not a positive number is refused", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => urlCssSource("http://127.0.0.1:1", { timeoutMs })).toThrow(RangeError);
    }
  });

  test("the request asks for CSS, accepting anything else only as a last resort", async () => {
    const seen: (string | null)[] = [];
    const site = serve((_path, headers) => {
      seen.push(headers.get("accept"));
      return new Response("a{}", { headers: CSS });
    });
    await urlCssSource(site.base).get("cc-post-1.css");
    expect(seen).toEqual(["text/css,*/*;q=0.1"]);
  });
});

describe("two sites sharing one cache directory", () => {
  // Cwicly's file names repeat from site to site: both fixture sites have a cc-global-classes.css.
  test("each site is served its own stylesheet, and each is cached apart", async () => {
    const cacheDir = tempDir();
    const siteA = serve(() => new Response(".site-a{color:red}", { headers: CSS }));
    const siteB = serve(() => new Response(".site-b{color:blue}", { headers: CSS }));
    const a = urlCssSource(siteA.base, { cacheDir });
    const b = urlCssSource(siteB.base, { cacheDir });
    expect(await a.get("cc-global-classes.css")).toBe(".site-a{color:red}");
    expect(await b.get("cc-global-classes.css")).toBe(".site-b{color:blue}");
    expect(readdirSync(cacheDir)).toHaveLength(2);

    // From the cache alone, with both sites gone, each still answers for itself.
    siteA.stop();
    siteB.stop();
    expect(await urlCssSource(siteA.base, { cacheDir }).get("cc-global-classes.css")).toBe(
      ".site-a{color:red}",
    );
    expect(await urlCssSource(siteB.base, { cacheDir }).get("cc-global-classes.css")).toBe(
      ".site-b{color:blue}",
    );
    expect(siteA.requests).toHaveLength(1);
    expect(siteB.requests).toHaveLength(1);
  });

  test("the directory is named for the site: its host, however the base URL is written", () => {
    const root = "/cache";
    const plain = urlCssCacheDir(root, "https://finelinepainting.pro");
    expect(basename(plain)).toStartWith("finelinepainting.pro-");
    expect(urlCssCacheDir(root, "https://finelinepainting.pro/")).toBe(plain);
    expect(urlCssCacheDir(root, "https://finelinepainting.pro///")).toBe(plain);
    expect(urlCssCacheDir(root, "https://FinelinePainting.PRO")).toBe(plain);
    expect(plain.startsWith(`${root}/`)).toBe(true);
    expect(dirname(plain)).toBe(root);
  });

  test("sites that differ in more than the host are different sites: another host, a port, a subdirectory, a scheme", () => {
    const base = urlCssCacheDir("/cache", "https://example.com");
    const others = [
      "https://example.org",
      "https://example.com:8443",
      "https://example.com/blog",
      "http://example.com",
    ].map((url) => urlCssCacheDir("/cache", url));
    expect(new Set([base, ...others]).size).toBe(5);
    // And a port or a path cannot reach out of the directory through the host part of its name.
    for (const dir of others) expect(dirname(dir)).toBe("/cache");
  });

  test("a base URL that is not a URL still gets a directory of its own", () => {
    const one = urlCssCacheDir("/cache", "not a url");
    const two = urlCssCacheDir("/cache", "not another url");
    expect(dirname(one)).toBe("/cache");
    expect(one).not.toBe(two);
  });
});

describe("urlCssSource with a cache directory", () => {
  test("every fetched stylesheet is written under its name, and a second source needs no network", async () => {
    const cacheDir = join(tempDir(), "nested", "cache");
    const site = serve((path) => {
      if (path.endsWith("/css/cc-post-1.css")) return new Response("p{}", { headers: CSS });
      if (path.endsWith("/cc-global-classes.css"))
        return new Response('g{content:"é"}', { headers: CSS });
      return notFound();
    });
    const first = urlCssSource(site.base, { cacheDir });
    expect(await first.get("cc-post-1.css")).toBe("p{}");
    expect(await first.get("cc-global-classes.css")).toBe('g{content:"é"}');
    // One directory per site inside the cache directory (see "two sites" below).
    const siteDir = urlCssCacheDir(cacheDir, site.base);
    expect(readdirSync(cacheDir)).toEqual([basename(siteDir)]);
    expect(readdirSync(siteDir).sort()).toEqual(["cc-global-classes.css", "cc-post-1.css"]);
    expect(readFileSync(join(siteDir, "cc-global-classes.css"), "utf8")).toBe('g{content:"é"}');

    const asked = site.requests.length;
    site.stop();
    const second = urlCssSource(site.base, { cacheDir });
    expect(await second.get("cc-post-1.css")).toBe("p{}");
    expect(await second.get("cc-global-classes.css")).toBe('g{content:"é"}');
    expect(site.requests).toHaveLength(asked);
  });

  test("an absent stylesheet leaves a marker and no file, and a failure leaves nothing behind", async () => {
    const cacheDir = tempDir();
    const missing = serve(() => notFound());
    expect(await urlCssSource(missing.base, { cacheDir }).get("cc-post-1.css")).toBeNull();
    const siteDir = urlCssCacheDir(cacheDir, missing.base);
    expect(readdirSync(siteDir)).toEqual([".absent"]);
    expect(readdirSync(join(siteDir, ".absent"))).toEqual(["cc-post-1.css"]);
    const broken = serve(() => new Response("x", { status: 500 }));
    await expect(urlCssSource(broken.base, { cacheDir }).get("cc-post-2.css")).rejects.toThrow();
    expect(existsSync(urlCssCacheDir(cacheDir, broken.base))).toBe(false);
  });

  test("no temporary files are left behind, even under concurrent writes", async () => {
    const cacheDir = tempDir();
    const site = serve(() => new Response("a{}", { headers: CSS }));
    const source = urlCssSource(site.base, { cacheDir, concurrency: 4 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => source.get(`cc-post-${i}.css`)));
    const files = readdirSync(urlCssCacheDir(cacheDir, site.base));
    expect(files).toHaveLength(12);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  test("a cached stylesheet is trusted as it stands: no request is made for it", async () => {
    const cacheDir = tempDir();
    const site = serve(() => new Response("fresh{}", { headers: CSS }));
    const siteDir = urlCssCacheDir(cacheDir, site.base);
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(siteDir, "cc-post-1.css"), "cached{}");
    expect(await urlCssSource(site.base, { cacheDir }).get("cc-post-1.css")).toBe("cached{}");
    expect(site.requests).toEqual([]);
    expect(existsSync(join(siteDir, "cc-post-1.css"))).toBe(true);
  });
});

describe("urlCssSource remembers the stylesheets a site does not have", () => {
  const HOUR = 60 * 60_000;
  const markerOf = (cacheDir: string, base: string, name: string): string =>
    join(urlCssCacheDir(cacheDir, base), ".absent", name);

  test("a 404 is asked once for good: a later source over the same cache makes no request", async () => {
    const cacheDir = tempDir();
    const site = serve(() => notFound());
    expect(await urlCssSource(site.base, { cacheDir }).get("cc-post-7.css")).toBeNull();
    // The css/ place and the root: two requests, the whole price of finding out.
    expect(site.requests).toHaveLength(2);
    expect(await urlCssSource(site.base, { cacheDir }).get("cc-post-7.css")).toBeNull();
    expect(site.requests).toHaveLength(2);
  });

  test("the marker holds the time it expires, a day on by default", async () => {
    const cacheDir = tempDir();
    const site = serve(() => notFound());
    await urlCssSource(site.base, { cacheDir, now: () => 1_000_000 }).get("cc-post-7.css");
    expect(
      JSON.parse(readFileSync(markerOf(cacheDir, site.base, "cc-post-7.css"), "utf8")),
    ).toEqual({
      expires: 1_000_000 + 24 * HOUR,
    });
  });

  test("an expired marker is not believed: the site is asked again, and a stylesheet that has appeared is used", async () => {
    const cacheDir = tempDir();
    let exists = false;
    const site = serve((path) =>
      exists && path.includes("/css/") ? new Response("late{}", { headers: CSS }) : notFound(),
    );
    let clock = 0;
    const opts = { cacheDir, absentTtlMs: 2 * HOUR, now: () => clock };
    expect(await urlCssSource(site.base, opts).get("cc-post-7.css")).toBeNull();
    exists = true;
    clock = 2 * HOUR - 1;
    expect(await urlCssSource(site.base, opts).get("cc-post-7.css")).toBeNull();
    expect(site.requests).toHaveLength(2);
    clock = 2 * HOUR;
    expect(await urlCssSource(site.base, opts).get("cc-post-7.css")).toBe("late{}");
    // It is a stylesheet now, and no longer marked absent.
    expect(existsSync(markerOf(cacheDir, site.base, "cc-post-7.css"))).toBe(false);
    expect(readFileSync(join(urlCssCacheDir(cacheDir, site.base), "cc-post-7.css"), "utf8")).toBe(
      "late{}",
    );
  });

  test("a stylesheet that is cached wins over a marker for the same name", async () => {
    const cacheDir = tempDir();
    const site = serve(() => notFound());
    const siteDir = urlCssCacheDir(cacheDir, site.base);
    mkdirSync(join(siteDir, ".absent"), { recursive: true });
    writeFileSync(join(siteDir, ".absent", "cc-post-7.css"), JSON.stringify({ expires: 1e18 }));
    writeFileSync(join(siteDir, "cc-post-7.css"), "kept{}");
    expect(await urlCssSource(site.base, { cacheDir }).get("cc-post-7.css")).toBe("kept{}");
    expect(site.requests).toEqual([]);
  });

  test("a source says which names it answered from a marker, and where the marker is, so a report can tell a remembered 404 from a new one", async () => {
    const cacheDir = tempDir();
    const site = serve(() => notFound());
    const first = urlCssSource(site.base, { cacheDir, now: () => 5 });
    expect(await first.get("cc-post-7.css")).toBeNull();
    // This run asked the site: nothing was remembered into it.
    expect(first.remembered("cc-post-7.css")).toBeUndefined();
    const second = urlCssSource(site.base, { cacheDir, now: () => 6 });
    expect(await second.get("cc-post-7.css")).toBeNull();
    expect(second.remembered("cc-post-7.css")).toEqual({
      file: markerOf(cacheDir, site.base, "cc-post-7.css"),
      expires: 5 + 24 * HOUR,
    });
    expect(second.remembered("cc-post-8.css")).toBeUndefined();
  });

  test("absentTtlMs: 0 remembers nothing, and no cacheDir means no markers at all", async () => {
    const cacheDir = tempDir();
    const site = serve(() => notFound());
    await urlCssSource(site.base, { cacheDir, absentTtlMs: 0 }).get("cc-post-7.css");
    await urlCssSource(site.base, { cacheDir, absentTtlMs: 0 }).get("cc-post-7.css");
    expect(site.requests).toHaveLength(4);
    expect(readdirSync(cacheDir)).toEqual([]);
    await urlCssSource(site.base).get("cc-post-7.css");
    await urlCssSource(site.base).get("cc-post-7.css");
    expect(site.requests).toHaveLength(8);
  });

  test("an HTML page standing in for a missing stylesheet is remembered as absent too", async () => {
    const cacheDir = tempDir();
    const site = serve(
      () => new Response("<html>nope</html>", { headers: { "content-type": "text/html" } }),
    );
    expect(await urlCssSource(site.base, { cacheDir }).get("cc-global-x.css")).toBeNull();
    expect(existsSync(markerOf(cacheDir, site.base, "cc-global-x.css"))).toBe(true);
  });

  test("a name that failed anywhere on the way is not remembered: a 404 in one place and a 500 in the other is no answer", async () => {
    const cacheDir = tempDir();
    let healthy = false;
    const site = serve((path) => {
      if (path.includes("/css/")) return notFound();
      return healthy ? new Response("g{}", { headers: CSS }) : new Response("x", { status: 503 });
    });
    const source = (): CssSource => urlCssSource(site.base, { cacheDir });
    await expect(source().get("cc-post-7.css")).rejects.toThrow("503");
    expect(existsSync(markerOf(cacheDir, site.base, "cc-post-7.css"))).toBe(false);
    healthy = true;
    expect(await source().get("cc-post-7.css")).toBe("g{}");
  });

  test("a marker nobody can read is ignored, and the answer replaces it", async () => {
    const cacheDir = tempDir();
    const site = serve(() => notFound());
    const siteDir = urlCssCacheDir(cacheDir, site.base);
    mkdirSync(join(siteDir, ".absent"), { recursive: true });
    for (const [name, text] of [
      ["cc-post-1.css", "{not json"],
      ["cc-post-2.css", JSON.stringify({ expires: "99999999999999" })],
      ["cc-post-3.css", JSON.stringify({})],
      ["cc-post-4.css", ""],
    ] as const) {
      writeFileSync(join(siteDir, ".absent", name), text);
      expect(await urlCssSource(site.base, { cacheDir }).get(name)).toBeNull();
      expect(
        JSON.parse(readFileSync(markerOf(cacheDir, site.base, name), "utf8")).expires,
      ).toBeGreaterThan(Date.now());
    }
    expect(site.requests).toHaveLength(8);
  });

  test("the marker directory's own name is a name like any other: it is asked for, never read as a cache entry", async () => {
    const cacheDir = tempDir();
    const site = serve(() => notFound());
    const source = urlCssSource(site.base, { cacheDir });
    await source.get("cc-post-1.css");
    expect(await source.get(".absent")).toBeNull();
    expect(await urlCssSource(site.base, { cacheDir }).get(".absent")).toBeNull();
    expect(site.requests.filter((path) => path.endsWith("/.absent"))).toHaveLength(4);
  });

  test("a site with a thousand posts and no stylesheets for them costs one pass of bounded requests, then none", async () => {
    const cacheDir = tempDir();
    let inFlight = 0;
    let peak = 0;
    const site = serve(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(1);
      inFlight -= 1;
      return notFound();
    });
    const names = Array.from({ length: 300 }, (_, i) => `cc-post-${i}.css`);
    const first = urlCssSource(site.base, { cacheDir, concurrency: 4 });
    expect((await Promise.all(names.map((name) => first.get(name)))).every((r) => r === null)).toBe(
      true,
    );
    expect(peak).toBe(4);
    expect(site.requests).toHaveLength(600);
    const second = urlCssSource(site.base, { cacheDir, concurrency: 4 });
    await Promise.all(names.map((name) => second.get(name)));
    expect(site.requests).toHaveLength(600);
    expect(readdirSync(join(urlCssCacheDir(cacheDir, site.base), ".absent"))).toHaveLength(300);
  });

  test("absentTtlMs that is not zero or a positive number is refused", () => {
    for (const absentTtlMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => urlCssSource("http://127.0.0.1:1", { absentTtlMs })).toThrow(RangeError);
    }
  });
});

describe("a page's stylesheets over HTTP", () => {
  /** A site that serves a fixture's stylesheets exactly where Cwicly keeps them. */
  function fixtureSite(site: string): Served {
    const names = new Set(fixtureCssNames(site));
    return serve((path) => {
      const match = /^\/wp-content\/uploads\/cwicly\/(css\/)?([^/]+)$/.exec(path);
      if (!match || !names.has(match[2]!)) return notFound();
      const nested = /^cc-(post|tp|cm|rb)-/.test(match[2]!);
      if (Boolean(match[1]) !== nested) return notFound();
      return new Response(readFixtureCss(site, match[2]!), { headers: CSS });
    });
  }

  test("the index built from a rendered page's stylesheets is the same over HTTP as from disk", async () => {
    const html = readFixtureText("fineline", "html/home.html");
    const names = [
      ...html.matchAll(/<link[^>]+href=['"][^'"]*\/uploads\/cwicly\/(?:css\/)?(cc-[^?'"]+)[?'"]/g),
    ].map((match) => match[1]!);
    expect(names).toHaveLength(6);

    const site = fixtureSite("fineline");
    const cacheDir = tempDir();
    const overHttp = await loadCssIndex(
      urlCssSource(site.base, { cacheDir, concurrency: 3 }),
      names,
      FIXTURE_BREAKPOINTS,
    );
    const fromDisk = await loadCssIndex(fixtureCssSource("fineline"), names, FIXTURE_BREAKPOINTS);
    const reference = mergeCssIndexes(
      ...names.map((name) =>
        parseCwiclyCss(readFixtureCss("fineline", name), FIXTURE_BREAKPOINTS, { file: name }),
      ),
    );

    expect(Object.fromEntries(overHttp.classes)).toEqual(Object.fromEntries(fromDisk.classes));
    expect(Object.fromEntries(overHttp.other)).toEqual(Object.fromEntries(fromDisk.other));
    expect(overHttp.artifacts).toEqual(fromDisk.artifacts);
    expect(Object.fromEntries(overHttp.classes)).toEqual(Object.fromEntries(reference.classes));
    expect(overHttp.classes.size).toBeGreaterThan(100);
    // Each name cost one request: nothing was asked for in the wrong directory first.
    expect(site.requests).toHaveLength(names.length);
    expect(readdirSync(urlCssCacheDir(cacheDir, site.base)).sort()).toEqual([...names].sort());
  });

  test("a stylesheet the site does not have is reported by the loader, not thrown", async () => {
    const site = fixtureSite("ap");
    const index = await loadCssIndex(
      urlCssSource(site.base),
      ["cc-global-classes.css", "cc-post-1.css"],
      FIXTURE_BREAKPOINTS,
    );
    expect(index.artifacts.filter((a) => a.code === "css.missing-file")).toEqual([
      {
        code: "css.missing-file",
        detail: "stylesheet cc-post-1.css was not found",
        file: "cc-post-1.css",
      },
    ]);
    expect(index.classes.has("searchform")).toBe(true);
  });
});
