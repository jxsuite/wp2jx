/**
 * A page built in pages of one of its lists (site-architecture.md §4.3, "Paging a list").
 *
 * WordPress shows a listing a page at a time (`/essays/page/2/`, or a "Load more" button that fetches
 * the next page), and a static page that held every entry would hold hundreds of cards. A query whose
 * live page is paged and whose list is a collection claims its page's paging when it is converted
 * (`cwicly/blocks/data.ts`, `Converted.paging`), and leaves a pager bound to `$page.pagination` where
 * the device was. This module makes the page what the claim says, on the document the page or
 * templates emitter wrote:
 *
 * - **The file** is a catch-all page next to where it was, so the first page keeps the page's address
 *   and the next ones are numbered after it: `pages/essays.json` → `pages/essays/[...page].json`
 *   (`/essays/`, `/essays/2/`), `pages/index.json` → `pages/[...page].json` (`/`, `/2/`), and a page of
 *   a term → `pages/category/[slug]/[...page].json` (`/category/bible/`, `/category/bible/2/`).
 * - **`$paths`** is `{ "paginate": { "$ref": "#/state/<list>" }, "pageSize": n }`, and a page that
 *   had `$paths` of its own (one per term) keeps them as `each`: the list is paged once per term.
 * - **The title** says which page it is past the first (` - Page 2`), and **the canonical address and
 *   `og:url`** are the page's own (`…/essays/2/`), as Rank Math writes them on a paged archive.
 * - **A redirect** sends WordPress's own page addresses there (`/essays/page/:n` → `/essays/:n/`).
 *
 * Report code: `paging.paged` (info), located at the page.
 */
import { posix } from "node:path";
import type { PagingClaim } from "../cwicly/blocks/data.ts";
import type { Report } from "../types.ts";

/** A path relative to a file's directory, as `$elements` names a component (`emit/pages.ts`, `relativeRef`). */
function relativeRef(fromFile: string, toFile: string): string {
  const ref = posix.relative(posix.dirname(fromFile), toFile);
  return ref.startsWith(".") ? ref : `./${ref}`;
}

/** The page number of `$page.pagination`, as an expression. */
const NUMBER = "state.$page.pagination.number";

/**
 * Where the paged page lives: a catch-all `[...page].json` in the directory the page stood for.
 * `pages/index.json` and `pages/about/index.json` are their directory's own page; any other file is
 * the directory of its name.
 */
export function pagedFile(file: string): string {
  const dir = file.replace(/\.json$/, "").replace(/(^|\/)index$/, "");
  return `${dir}/[...page].json`.replace(/\/\//g, "/");
}

/** `$paths` that page the claimed list, once per value of the page's own `$paths` where it had some. */
export function pagedPaths(paths: unknown, claim: PagingClaim): Record<string, unknown> {
  return {
    ...(paths === undefined ? {} : { each: paths }),
    paginate: { $ref: `#/state/${claim.key}` },
    pageSize: claim.pageSize,
  };
}

/** A canonical address with the page's number after the first page: `…/essays/` → `…/essays/2/`. */
function pagedAddress(value: string): string {
  // A bound address (a term's `seo.canonical`) ends with a slash, as every address of the site does.
  const slash = value.endsWith("/") || value.endsWith("}");
  return `${value}\${${NUMBER} > 1 ? ${slash ? "" : "'/' + "}${NUMBER} + '/' : ''}`;
}

/** The title of a page past the first says which it is, after what the page's title says. */
export const pagedTitle = (title: string): string =>
  `${title}\${${NUMBER} > 1 ? ' - Page ' + ${NUMBER} : ''}`;

type HeadEntry = { tagName?: unknown; attributes?: Record<string, unknown> };

/** The head with the page's own canonical address and `og:url`. */
export function pagedHead(head: readonly unknown[]): unknown[] {
  return head.map((entry) => {
    const e = entry as HeadEntry;
    const attrs = e.attributes;
    if (attrs === undefined) return entry;
    const key =
      attrs.rel === "canonical" ? "href" : attrs.property === "og:url" ? "content" : undefined;
    const value = key === undefined ? undefined : attrs[key];
    if (key === undefined || typeof value !== "string" || value === "") return entry;
    return { ...e, attributes: { ...attrs, [key]: pagedAddress(value) } };
  });
}

/**
 * WordPress's own addresses of the pages after the first, from the page's route (`/essays/`, or a
 * pattern such as `/category/:slug/`): `/essays/page/:n` → `/essays/:n/`.
 */
export function pagedRedirect(route: string): { from: string; to: string } {
  const base = route.endsWith("/") ? route : `${route}/`;
  return { from: `${base}page/:n`, to: `${base}:n/` };
}

/**
 * The page as a paged route: its file, and its document with `$paths`, title and head made for it.
 * The document is copied, not changed.
 */
export function pagedPage(
  file: string,
  doc: Readonly<Record<string, unknown>>,
  claim: PagingClaim,
  report?: Report,
): { file: string; doc: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  const paged = pagedFile(file);
  // A component is named relative to the page's file, which is now a directory deeper (`$layout` is
  // the project's own path, and stays).
  const rebase = (ref: unknown): unknown =>
    typeof ref === "string" && /^\.\.?\//.test(ref)
      ? relativeRef(paged, posix.join(posix.dirname(file), ref))
      : ref;
  // `$paths` first, as a dynamic page writes it.
  out.$paths = pagedPaths(doc.$paths, claim);
  for (const [key, value] of Object.entries(doc)) {
    if (key === "$paths") continue;
    out[key] =
      key === "title" && typeof value === "string"
        ? pagedTitle(value)
        : key === "$head" && Array.isArray(value)
          ? pagedHead(value)
          : key === "$elements" && Array.isArray(value)
            ? value.map((e: unknown) =>
                typeof e === "object" && e !== null && "$ref" in e
                  ? { ...e, $ref: rebase((e as { $ref: unknown }).$ref) }
                  : rebase(e),
              )
            : value;
  }
  report?.add({
    severity: "info",
    code: "paging.paged",
    message: `The page is built in pages of ${claim.pageSize} entries of its list ${claim.key}, the first at its own address and the next ones numbered after it (${paged}); WordPress's /page/N/ addresses are redirected there.`,
    where: `file:${file}`,
    data: { file: paged, key: claim.key, pageSize: claim.pageSize },
  });
  return { file: paged, doc: out };
}
