/**
 * The static server over a Jx `dist/`: the build's directory layout, trailing-slash routes, the
 * redirects the build writes, the 404 page, traversal, and that closing it frees the port. The
 * folder is laid out the way `jx build` lays it out (verified against the pilot's `dist/`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRedirects } from "../../src/verify/redirects.ts";
import {
  openServers,
  resolveRequest,
  safeJoin,
  startStaticServer,
} from "../../src/verify/serve.ts";
import { TMP_ROOT } from "../helpers/jx-build.ts";

let root: string;
const put = (path: string, content: string): void => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
};

const REDIRECTS = parseRedirects(`/old /about-us/ 301
/gone /about-us/ 302
/docs/* /about-us/:splat 301
/search-results /search/ 200
/flat /other/ 301
/team/:name /about-us/ 308
`);

beforeAll(() => {
  mkdirSync(TMP_ROOT, { recursive: true });
  root = mkdtempSync(join(TMP_ROOT, "verify-serve-"));
  put("index.html", "<h1>home</h1>");
  put("about-us/index.html", "<h1>about</h1>");
  put("about-us/index.md", "# about");
  put("search/index.html", "<h1>search</h1>");
  put("flat.html", "<h1>flat</h1>");
  put("404/index.html", "<h1>not found page</h1>");
  put("app.js", "console.log(1)");
  put("css/site.css", "body{}");
  put("space name/index.html", "<h1>space</h1>");
  put("mixed/inner/index.html", "<h1>inner</h1>");
  put("mixed.html", "<h1>mixed</h1>");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  expect(openServers()).toBe(0);
});

describe("resolveRequest", () => {
  test("a directory answers with its index, a file with itself", () => {
    expect(resolveRequest(root, "/", [])).toEqual({
      kind: "file",
      file: join(root, "index.html"),
      status: 200,
    });
    expect(resolveRequest(root, "/about-us/", [])).toMatchObject({
      kind: "file",
      file: join(root, "about-us/index.html"),
    });
    expect(resolveRequest(root, "/css/site.css", [])).toMatchObject({
      kind: "file",
      file: join(root, "css/site.css"),
    });
    expect(resolveRequest(root, "/space%20name/", [])).toMatchObject({
      kind: "file",
      file: join(root, "space name/index.html"),
    });
  });

  test("a directory without the trailing slash is sent to the slash", () => {
    expect(resolveRequest(root, "/search", [])).toEqual({
      kind: "redirect",
      location: "/search/",
      status: 301,
      rule: undefined,
    });
  });

  test("<path>.html answers <path>", () => {
    expect(resolveRequest(root, "/flat", [])).toMatchObject({
      kind: "file",
      file: join(root, "flat.html"),
      status: 200,
    });
  });

  test("<path>.html answers even when a folder of that name holds no index", () => {
    expect(resolveRequest(root, "/mixed", [])).toMatchObject({
      kind: "file",
      file: join(root, "mixed.html"),
      status: 200,
    });
    expect(resolveRequest(root, "/mixed/inner/", [])).toMatchObject({
      file: join(root, "mixed/inner/index.html"),
    });
  });

  test("an unknown path gets the 404 page with status 404", () => {
    expect(resolveRequest(root, "/nope/", [])).toEqual({
      kind: "file",
      file: join(root, "404/index.html"),
      status: 404,
    });
  });

  test("redirect rules answer before files, with their own status", () => {
    expect(resolveRequest(root, "/old", REDIRECTS)).toMatchObject({
      kind: "redirect",
      location: "/about-us/",
      status: 301,
    });
    expect(resolveRequest(root, "/gone/", REDIRECTS)).toMatchObject({
      kind: "redirect",
      status: 302,
    });
    expect(resolveRequest(root, "/team/ada", REDIRECTS)).toMatchObject({
      kind: "redirect",
      status: 308,
    });
    // `/flat` has a page, and a rule sending it away outranks the page, as it does on the live sites.
    expect(resolveRequest(root, "/flat", REDIRECTS)).toMatchObject({
      kind: "redirect",
      location: "/other/",
    });
  });

  test("a splat rule substitutes the rest of the path", () => {
    expect(resolveRequest(root, "/docs/a/b", REDIRECTS)).toMatchObject({
      kind: "redirect",
      location: "/about-us/a/b",
    });
  });

  test("a rewrite serves the destination in place when no file answers the path", () => {
    expect(resolveRequest(root, "/search-results", REDIRECTS)).toMatchObject({
      kind: "file",
      file: join(root, "search/index.html"),
      status: 200,
    });
  });

  test("a rewrite does not shadow a file that exists, unless forced", () => {
    const rules = parseRedirects("/flat /search/ 200");
    expect(resolveRequest(root, "/flat", rules)).toMatchObject({ file: join(root, "flat.html") });
    const forced = parseRedirects("/flat /search/ 200!");
    expect(resolveRequest(root, "/flat", forced)).toMatchObject({
      file: join(root, "search/index.html"),
    });
  });

  test("a site with no 404 page answers missing", () => {
    const bare = mkdtempSync(join(TMP_ROOT, "verify-serve-bare-"));
    try {
      expect(resolveRequest(bare, "/x/", [])).toEqual({ kind: "missing" });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("a sibling folder that shares the root's name as a prefix is outside it", () => {
    const sibling = `${root}-secret`;
    mkdirSync(sibling, { recursive: true });
    try {
      writeFileSync(join(sibling, "key.txt"), "secret");
      const name = `${root.slice(root.lastIndexOf("/") + 1)}-secret`;
      expect(safeJoin(root, `/../${name}/key.txt`)).toBeUndefined();
      expect(resolveRequest(root, `/../${name}/key.txt`, [])).toEqual({ kind: "missing" });
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test("rewrites chase each other five hops and no further, so a cycle ends in the 404 page", () => {
    const cycle = parseRedirects("/ping /pong 200\n/pong /ping 200\n");
    expect(resolveRequest(root, "/ping", cycle)).toMatchObject({ kind: "file", status: 404 });
    // Six rewrites to a page that exists: the chain is cut at five, as documented.
    const hops = (n: number) =>
      parseRedirects(
        [
          ...Array.from({ length: n }, (_, i) => `/h${i} /h${i + 1} 200`),
          `/h${n} /about-us/ 200`,
        ].join("\n"),
      );
    expect(resolveRequest(root, "/h0", hops(3))).toMatchObject({ kind: "file", status: 200 });
    expect(resolveRequest(root, "/h0", hops(8))).toMatchObject({ kind: "file", status: 404 });
  });

  test("a path that escapes the root, or is not valid, is missing", () => {
    expect(safeJoin(root, "/../etc/passwd")).toBeUndefined();
    expect(safeJoin(root, "/%2e%2e/%2e%2e/etc/passwd")).toBeUndefined();
    expect(safeJoin(root, "/a/../../x")).toBeUndefined();
    expect(safeJoin(root, "/%E0%A4%A")).toBeUndefined();
    expect(safeJoin(root, "/a%00b")).toBeUndefined();
    expect(resolveRequest(root, "/%2e%2e/x", [])).toEqual({ kind: "missing" });
    expect(safeJoin(root, "/about-us/")).toBe(join(root, "about-us") + "/");
  });
});

describe("startStaticServer", () => {
  test("serves over HTTP: bodies, types, statuses, redirects and the 404 page", async () => {
    const server = await startStaticServer({ root, redirects: REDIRECTS });
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const home = await fetch(`${server.origin}/`);
      expect(home.status).toBe(200);
      expect(home.headers.get("content-type")).toContain("text/html");
      expect(await home.text()).toBe("<h1>home</h1>");
      expect((await fetch(`${server.origin}/app.js`)).headers.get("content-type")).toContain(
        "javascript",
      );
      expect(await (await fetch(`${server.origin}/about-us/index.md`)).text()).toBe("# about");

      const missing = await fetch(`${server.origin}/nope`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("<h1>not found page</h1>");

      const moved = await fetch(`${server.origin}/old?x=1`, { redirect: "manual" });
      expect(moved.status).toBe(301);
      expect(moved.headers.get("location")).toBe("/about-us/?x=1");
      const slash = await fetch(`${server.origin}/search`, { redirect: "manual" });
      expect(slash.status).toBe(301);
      expect(slash.headers.get("location")).toBe("/search/");
      const followed = await fetch(`${server.origin}/old`);
      expect(followed.url).toBe(`${server.origin}/about-us/`);
      expect(await followed.text()).toBe("<h1>about</h1>");
      expect((await fetch(`${server.origin}/search-results`)).status).toBe(200);

      const head = await fetch(`${server.origin}/`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect((await fetch(`${server.origin}/`, { method: "POST" })).status).toBe(405);
      expect(server.requests).toBeGreaterThan(8);
    } finally {
      await server.close();
    }
  });

  test("an absolute destination keeps its own query", async () => {
    const server = await startStaticServer({
      root,
      redirects: parseRedirects("/away https://example.com/x 301"),
    });
    try {
      const response = await fetch(`${server.origin}/away?y=2`, { redirect: "manual" });
      expect(response.headers.get("location")).toBe("https://example.com/x");
    } finally {
      await server.close();
    }
  });

  test("close frees the port and is safe twice; the count of open servers returns to zero", async () => {
    const before = openServers();
    const server = await startStaticServer({ root });
    expect(openServers()).toBe(before + 1);
    const { port } = server;
    await server.close();
    await server.close();
    expect(openServers()).toBe(before);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    // The same port can be taken again.
    const again = await startStaticServer({ root, port });
    expect(again.port).toBe(port);
    await again.close();
  });

  test("close drops a connection that is still open", async () => {
    const server = await startStaticServer({ root });
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: { data() {}, close() {}, error() {} },
    });
    await Promise.race([
      server.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close hung")), 3000)),
    ]);
    socket.end();
  });

  test("close ends a keep-alive connection: the next request on it is not answered", async () => {
    const server = await startStaticServer({ root });
    const received: string[] = [];
    let closed = false;
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        data(_s, data) {
          received.push(Buffer.from(data).toString());
        },
        close() {
          closed = true;
        },
        error() {},
      },
    });
    const ask = "GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n";
    socket.write(ask);
    for (let i = 0; i < 50 && received.length === 0; i++) await Bun.sleep(20);
    expect(received.join("")).toContain("200");
    received.length = 0;
    await server.close();
    for (let i = 0; i < 25 && !closed; i++) await Bun.sleep(20);
    if (!closed) socket.write(ask);
    await Bun.sleep(200);
    expect(received.join("")).not.toContain("200 OK");
    socket.end();
  });

  test("asyncDispose closes it", async () => {
    let port = 0;
    {
      await using server = await startStaticServer({ root });
      port = server.port;
    }
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(openServers()).toBe(0);
  });

  test("refuses a folder that is not there", async () => {
    await expect(startStaticServer({ root: join(root, "missing") })).rejects.toThrow(
      "not a directory",
    );
  });
});
