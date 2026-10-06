/**
 * A static server over a Jx `dist/`, laid out the way the build lays files out and the way a static
 * host serves them: a directory answers with its `index.html`, a directory asked for without the
 * trailing slash is sent to the slash, `<path>.html` answers `<path>`, an unknown path gets the
 * site's `404` page with status 404, and the redirects the build wrote to `_redirects` are honoured
 * (so the URLs a live site redirects can be compared at their destination).
 *
 * `resolveRequest` is the whole routing decision as a pure function of the folder; the server only
 * turns it into a response. The caller owns the port: `port: 0` (the default) asks the system for a
 * free one, and `close()` ends every open connection, so nothing outlives the run.
 */
import { statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { matchRedirect, type RedirectRule } from "./redirects.ts";

export type Resolution =
  | { kind: "file"; file: string; status: 200 | 404 }
  | { kind: "redirect"; location: string; status: number; rule: RedirectRule | undefined }
  | { kind: "missing" };

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The file under `root` a URL path names, or undefined when it escapes `root` or is not valid. */
export function safeJoin(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const base = resolve(root);
  const target = normalize(join(base, decoded));
  return target === base || target.startsWith(base + sep) ? target : undefined;
}

/** The page the site shows for an unknown path, when it has one. */
export function notFoundPage(root: string): string | undefined {
  for (const name of ["404.html", join("404", "index.html")]) {
    const file = join(root, name);
    if (isFile(file)) return file;
  }
  return undefined;
}

/**
 * Decide what a request for `pathname` gets. Precedence follows a static host:
 *   1. a redirect rule (a rewrite, status 200, only when no file answers the path itself, unless forced);
 *   2. the file at the path;
 *   3. a directory: its `index.html`, or a redirect to the trailing slash;
 *   4. `<path>.html`;
 *   5. the 404 page.
 * A rewrite's destination is served in place of the path, with the destination's own routing.
 */
export function resolveRequest(
  root: string,
  pathname: string,
  redirects: readonly RedirectRule[] = [],
  depth = 0,
): Resolution {
  const target = safeJoin(root, pathname);
  if (target === undefined) return { kind: "missing" };

  const rule = matchRedirect(redirects, pathname);
  if (rule !== undefined) {
    const answers = fileAnswering(root, pathname) !== undefined;
    if (rule.rule.status !== 200) {
      return { kind: "redirect", location: rule.to, status: rule.rule.status, rule: rule.rule };
    }
    if ((!answers || rule.rule.force) && depth < 5 && !/^[a-z][a-z0-9+.-]*:/i.test(rule.to)) {
      return resolveRequest(root, rule.to, redirects, depth + 1);
    }
  }

  const answer = fileAnswering(root, pathname);
  if (answer !== undefined) {
    if (answer === "slash") {
      return { kind: "redirect", location: `${pathname}/`, status: 301, rule: undefined };
    }
    return { kind: "file", file: answer, status: 200 };
  }

  const missing = notFoundPage(root);
  return missing === undefined ? { kind: "missing" } : { kind: "file", file: missing, status: 404 };
}

/** The file a path is answered by on its own, `"slash"` when it needs the trailing slash, else nothing. */
function fileAnswering(root: string, pathname: string): string | "slash" | undefined {
  const target = safeJoin(root, pathname);
  if (target === undefined) return undefined;
  if (isFile(target)) return target;
  if (isDir(target)) {
    const index = join(target, "index.html");
    if (isFile(index)) return pathname.endsWith("/") ? index : "slash";
  }
  const html = `${pathname.endsWith("/") ? target.slice(0, -1) : target}.html`;
  if (isFile(html)) return html;
  return undefined;
}

export interface StaticServerOptions {
  /** The folder to serve (a project's `dist/`). */
  root: string;
  redirects?: readonly RedirectRule[];
  /** Default 0: a free port. */
  port?: number;
  /** Default `127.0.0.1`. */
  hostname?: string;
}

export interface StaticServer {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  origin: string;
  port: number;
  /** Requests answered so far. */
  readonly requests: number;
  /** Stop listening and drop every open connection. Safe to call twice. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

const open = new Set<StaticServer>();

/** Servers started here that nobody has closed yet; a test asserts this is empty. */
export function openServers(): number {
  return open.size;
}

export async function startStaticServer(opts: StaticServerOptions): Promise<StaticServer> {
  const root = resolve(opts.root);
  if (!isDir(root)) throw new Error(`cannot serve ${root}: it is not a directory`);
  const redirects = opts.redirects ?? [];
  let requests = 0;

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch(request) {
      requests += 1;
      const url = new URL(request.url);
      const headers = { "cache-control": "no-store" };
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405, headers });
      }
      const resolved = resolveRequest(root, url.pathname, redirects);
      if (resolved.kind === "redirect") {
        // The query string rides along: a redirect that dropped it would change the page.
        const location =
          /^[a-z][a-z0-9+.-]*:/i.test(resolved.location) || url.search === ""
            ? resolved.location
            : `${resolved.location}${resolved.location.includes("?") ? "&" : "?"}${url.search.slice(1)}`;
        return new Response(null, { status: resolved.status, headers: { ...headers, location } });
      }
      if (resolved.kind === "missing") {
        return new Response("not found", {
          status: 404,
          headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
        });
      }
      const file = Bun.file(resolved.file);
      return new Response(request.method === "HEAD" ? null : file, {
        status: resolved.status,
        headers: { ...headers, "content-type": file.type },
      });
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("the static server did not report a port");
  let closed = false;
  const handle: StaticServer = {
    origin: `http://${opts.hostname ?? "127.0.0.1"}:${port}`,
    port,
    get requests() {
      return requests;
    },
    async close() {
      if (closed) return;
      closed = true;
      open.delete(handle);
      await server.stop(true);
    },
    [Symbol.asyncDispose]() {
      return handle.close();
    },
  };
  open.add(handle);
  return handle;
}
