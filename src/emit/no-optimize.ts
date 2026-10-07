/**
 * Images Jx's optimiser cannot read.
 *
 * `jx build` hands every local raster image a page uses to Sharp and stops the WHOLE build when one
 * fails to decode: one file (a phone's HEIC saved under a `.jpg` name and served as `image/jpeg`, which
 * is what a WordPress library lets happen) takes every page of the site with it. Jx's own switch for an
 * image it must leave alone is the `data-no-optimize` attribute (compiler spec §7.4), so the converter
 * puts it on the references to those files, once it has the bytes and knows which they are
 * ({@link undecodableImage}). The page then carries the file as the live site does.
 */
import { sniffMediaType } from "../media.ts";

/** What Sharp (libvips as Jx ships it) reads: JPEG, PNG, WebP, GIF, AVIF, TIFF and SVG. */
const READABLE = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/tiff",
  "image/svg+xml",
]);

/**
 * Why Jx's optimiser cannot decode these bytes, or undefined when it can (or when the bytes are not an
 * image at all, which the download already judged). The HEIC family has no decoder in the prebuilt
 * libvips (HEVC is patent-encumbered), and BMP and ICO have no loader.
 */
export function undecodableImage(bytes: Uint8Array): string | undefined {
  const type = sniffMediaType(bytes);
  if (type === undefined || !type.startsWith("image/") || READABLE.has(type)) return undefined;
  if (type === "image/heic") {
    return "it is a HEIC/HEIF picture (a phone's own format; no HEVC decoder ships with the image optimiser and most browsers cannot show it either)";
  }
  return `it is ${type}, which the image optimiser has no loader for`;
}

/** An address as a set holds it: no query or fragment, percent escapes decoded. */
function normal(src: string): string {
  const bare = src.split(/[?#]/, 1)[0] ?? src;
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

const IMG_TAG = /<img\b[^>]*>/gi;

/** `<img … src="/media/x.jpg" …>` text with the attribute added to the tags whose `src` is in `srcs`. */
function markTags(html: string, srcs: ReadonlySet<string>): { html: string; count: number } {
  let count = 0;
  const out = html.replace(IMG_TAG, (tag) => {
    if (/\bdata-no-optimize\b/i.test(tag)) return tag;
    const src = /\bsrc=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const value = src?.[1] ?? src?.[2];
    if (value === undefined || !srcs.has(normal(value.replaceAll("&amp;", "&")))) return tag;
    count++;
    return tag.replace(/\s*\/?>$/, (end) => ` data-no-optimize${end.trimStart()}`);
  });
  return { html: out, count };
}

/** A line of Markdown that is an image directive (`::img{…}` leaf or `:img[…]{…}` inline) with its `src`. */
const IMG_DIRECTIVE = /:{1,2}img\b(?:\[[^\]\n]*\])?\{[^\n]*\}/g;

function markDirectives(text: string, srcs: ReadonlySet<string>): { text: string; count: number } {
  let count = 0;
  const out = text.replace(IMG_DIRECTIVE, (directive) => {
    if (/\bdata-no-optimize\b/.test(directive)) return directive;
    const src = /\bsrc="([^"]*)"/.exec(directive);
    if (src === null || !srcs.has(normal(src[1]!))) return directive;
    count++;
    return directive.replace(/\}$/, " data-no-optimize}");
  });
  const tags = markTags(out, srcs);
  return { text: tags.html, count: count + tags.count };
}

type Json = unknown;

function markNode(node: Json, srcs: ReadonlySet<string>): number {
  let count = 0;
  if (Array.isArray(node)) {
    for (const item of node) count += markNode(item, srcs);
    return count;
  }
  if (node === null || typeof node !== "object") return 0;
  const rec = node as Record<string, Json>;
  if (typeof rec.tagName === "string" && rec.tagName.toLowerCase() === "img") {
    const attrs = rec.attributes;
    const holder =
      attrs !== null && typeof attrs === "object" && !Array.isArray(attrs)
        ? (attrs as Record<string, Json>)
        : undefined;
    const src = holder?.src ?? rec.src;
    if (
      typeof src === "string" &&
      srcs.has(normal(src)) &&
      holder?.["data-no-optimize"] === undefined
    ) {
      const target = holder ?? {};
      target["data-no-optimize"] = "";
      if (holder === undefined) rec.attributes = target;
      count++;
    }
  }
  for (const [key, value] of Object.entries(rec)) {
    if (typeof value === "string") {
      if (value.includes("<img")) {
        const marked = markTags(value, srcs);
        if (marked.count > 0) {
          rec[key] = marked.html;
          count += marked.count;
        }
      }
    } else count += markNode(value, srcs);
  }
  return count;
}

export interface NoOptimizeResult {
  /** Project-relative path of each file that was changed, with the number of references marked. */
  changed: { path: string; count: number }[];
}

/**
 * Add `data-no-optimize` to every reference, in the project's JSON documents and Markdown entries, to
 * an image whose address is in `srcs` (public addresses, `/media/2021/04/x.jpg`). Mutates `files`.
 */
export function markNoOptimize(
  files: Map<string, string | Uint8Array>,
  srcs: ReadonlySet<string>,
): NoOptimizeResult {
  const changed: { path: string; count: number }[] = [];
  if (srcs.size === 0) return { changed };
  const wanted = new Set([...srcs].map(normal));
  for (const [path, data] of files) {
    if (typeof data !== "string") continue;
    if (path.endsWith(".json")) {
      let doc: Json;
      try {
        doc = JSON.parse(data);
      } catch {
        continue;
      }
      const count = markNode(doc, wanted);
      if (count > 0) {
        files.set(path, `${JSON.stringify(doc, null, 2)}\n`);
        changed.push({ path, count });
      }
    } else if (path.endsWith(".md")) {
      const { text, count } = markDirectives(data, wanted);
      if (count > 0) {
        files.set(path, text);
        changed.push({ path, count });
      }
    }
  }
  return { changed };
}
