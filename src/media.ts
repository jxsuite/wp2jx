/**
 * The media planner: which files of a WordPress uploads folder a migrated site ships, under what
 * names, and where every URL a block can hold for one of them leads.
 *
 * WordPress keeps one picture as a family of files: the upload, a `-scaled` copy when the upload was
 * past 2,560 pixels, an `-e<timestamp>` file for each edit in the media editor, and a `-WxH` file for
 * every registered size. Content refers to any of them, from any host the files were ever served
 * from. Jx regenerates the sizes from one source, so the family collapses to the single file worth
 * shipping, and every name of the family answers with that file.
 *
 * Jx's own importer has the same collapse (`packages/import/src/image-family.ts`, specs/desktop.md
 * 4.5a), but it only has URLs to go on, so it keys families on file-name patterns. Here the database
 * says what the family is (`file`, `original_image`, `sizes`, the guid), and the table built from it
 * is exact; the name patterns only turn a URL the table does not list (a size the metadata forgot,
 * an old edit) into the names it may be a derivative of. A URL no attachment accounts for is a
 * family of its own, ranked as the importer ranks it, and only when the caller lists it in
 * `extraUrls`.
 *
 * ## Which file of a family is shipped
 *
 * The attachment's own `file`: what WordPress itself serves as the full-size image. That is the
 * `-scaled` copy when WordPress made one, and the latest edit when the image was edited. Not the
 * unscaled upload (`original_image`), and never a `sizes` entry:
 *
 * - Pixels. The unscaled upload has more of them by construction, and nothing here can use them. The
 *   Jx image pipeline caps its ladder at the project's widest configured rung (1,920 by default),
 *   and a `-scaled` copy is 2,560 pixels on its long side. Eight unscaled uploads of each fixture
 *   site were measured with HEAD requests against the live site (fineline: 8 of 114, anabaptist
 *   perspectives: 8 of 105): 26.0 and 24.3 MB, against 3.0 and 3.1 MB for their scaled copies.
 *   That is eight times the bytes in a git repository, for pixels no derivative ever contains.
 * - What it is. `original_image` names the file from before WordPress's processing. When `file` is
 *   an edit of the scaled copy (`foo-scaled-e1722463968758.jpg`, three of these in the fixtures),
 *   the original is the picture before the edit, and shipping it would undo the author's crop.
 *   Dimensions are not recorded for it either, and `file` is the one whose dimensions are.
 * - Retrievability. The unscaled upload is not linked from any page, only from the attachment
 *   screen, so a media-offload plugin or a cleanup may have removed it. All sixteen that were
 *   probed were still served, but `file` is the one every page references.
 * - A `sizes` entry is never the answer. After an edit that shrinks the image WordPress keeps the
 *   entries it could not regenerate, so a size can be BIGGER than the edited `file` (16 fineline
 *   attachments, 2 on anabaptistperspectives). Picking the largest member by area, as the importer
 *   does for bare URLs, would resurrect the pre-edit picture.
 *
 * `preferUnscaled` ships the unscaled upload anyway, for a site whose photographs are the product,
 * and only where `original_image` really is the `-scaled` copy's source. The scaled copy then
 * becomes the first fallback of the download, so an upload that is gone costs a smaller image, not
 * a missing one.
 *
 * ## Where a file is fetched from
 *
 * Not necessarily the site. 1,793 of anabaptistperspectives' 1,794 guids name `media.…`, which serves
 * the uploads folder from its root, and one fineline guid names a staging host that no longer
 * resolves. An attachment's address is built from its guid when the guid is a file address whose
 * folder ends with the folder of `file` (an image-renaming plugin changes `file` and leaves the
 * guid, so the guid's name is not trusted, only its host and folder). Then the same file is tried on
 * the host most of the library lives on, and on the site's own uploads folder, because a guid can be
 * stale too: anabaptistperspectives' attachment 16206 names the site, which answers 404, and its file
 * is on the media host. The first address that answers with the file wins.
 *
 * ## Which attachments are planned at all
 *
 * A library is not a site's media. WordPress keeps in it whatever a plugin uploads: anabaptist
 * perspectives' library holds 670 Nextend Social Login avatars (`nsl_avatars/…`, `private`, parent 0,
 * a 404 on every host) and CSV exports of donors and subscriptions, next to the 1,124 files a
 * visitor can see. So:
 *
 * - An attachment whose `post_status` is anything but `inherit` or `publish` is not planned: it is
 *   not public on the site, and copying it into a repository would publish it. Its status is the
 *   attachment's own `status` (an extra field `loadModel` sets, as it does `originalFile`), else the
 *   status of the same id in `model.posts`; a model that states neither is read as published.
 *   `include` can only narrow the rest, never admit one of these.
 * - `plan.files` is every file the library holds that is public; `plan.used()` is the ones content
 *   actually asked for through `mediaFor` / `mediaForUrl` (or listed in `extraUrls`), which is what a
 *   migration should download.
 * - A dimension WordPress states for an SVG is not a size in pixels: it is whatever the file's root
 *   says, in inches (`3.2679in`, 9 of anabaptist perspectives' icons), or `100` for `width="100%"`
 *   (the site logo, whose viewBox is 2322 by 600). Nothing in the numbers tells them apart, so an SVG
 *   is planned with none.
 *
 * ## Names on disk
 *
 * A planned file lands at `<outDir>/<file>` and is referenced as `<urlBase>/<file>`. Where `file`
 * holds characters that mean something in a URL or a file system (a space, `#`, `%`, `?`, Windows'
 * `<>:"|*`, a trailing dot, a device name), the name is rewritten to letters, digits and `._~-`,
 * because Jx's image pipeline finds `src="/media/a%20b.png"` by joining the string onto `public/`
 * WITHOUT decoding it (`resolveImagePath` in the compiler's image-transform.ts): a percent-encoded
 * reference silently skips optimisation, and a literal space does not survive a `url(...)`
 * unquoted. Letters of any script and emoji are kept as they are (they are valid in an HTML
 * attribute and resolve in Jx as written), so `Дизайн-10.png` stays readable. Two files never share
 * a path, compared case-insensitively and by Unicode normal form, so a checkout onto macOS or
 * Windows cannot lose one to another; the later one gets `-2`, `-3`.
 */
import { createHash } from "node:crypto";
import type { Report, WpAttachment, WpModel } from "./types.ts";

// ── Contract ─────────────────────────────────────────────────────────────────────────────────────

export interface MediaOptions {
  /** The site's own address. Default: `model.site.url`. */
  siteUrl?: string | undefined;
  /**
   * Where the uploads folder is served. Default: what WordPress computes (`wp_upload_dir()`): the
   * `upload_url_path` option, else `<siteUrl>/<upload_path>` for a relative `upload_path`, else
   * `<siteUrl>/wp-content/uploads`.
   */
  uploadsBase?: string | undefined;
  /** Project-relative directory the files are written to. Default: `public/media`. */
  outDir?: string | undefined;
  /** URL prefix the written files are served under. Default: `/media`. */
  urlBase?: string | undefined;
  /**
   * Uploads URLs found in content that no attachment accounts for. Each family of them becomes one
   * more file, downloaded from the URL that was seen. A URL the attachment table does resolve is
   * not planned twice.
   */
  extraUrls?: Iterable<string> | undefined;
  /** Ship the unscaled upload instead of the `-scaled` copy where WordPress made one. Default: false. */
  preferUnscaled?: boolean | undefined;
  /**
   * Other hosts that serve a copy of this site's uploads folder: a staging site, a CDN pull zone.
   * Content and stylesheets generated there name them (anabaptistperspectives' compiled CSS points at
   * `sandbox.anabaptistperspectives.org`), and an address on one resolves like the site's own. A
   * bare host (or one with a scheme) is read as WordPress lays uploads out, under `/wp-content/uploads/`;
   * an address with a path (`https://cdn.example.com/media/`) names the folder itself. An attachment's
   * file is never fetched from one; an address on one that no attachment accounts for (an extra) is
   * fetched where it was written. Without this a host nothing names is a stranger's: a path on
   * another site's uploads folder can look just like this one's.
   */
  aliasHosts?: Iterable<string> | undefined;
  /**
   * Which attachments to plan, beyond the published ones. Return false to leave one out (a CSV
   * export, a plugin's avatars); it is reported in `unplanned` with that reason. A private or draft
   * attachment is left out whatever this says. Default: every published attachment.
   */
  include?: ((attachment: WpAttachment) => boolean) | undefined;
}

export interface MediaFile {
  /** The attachments that resolve to this file, ascending. Empty for a file found only through `extraUrls`. */
  attachmentIds: number[];
  /** Where to fetch it first: the host the attachment's guid names, which need not be the site's. */
  sourceUrl: string;
  /**
   * Where else to look when `sourceUrl` fails, in order: the same file on the host most of the library
   * is served from and on the site's own uploads folder, the scaled copy when the unscaled upload was
   * asked for, the other members of a family of addresses. Always present on a planned file.
   */
  fallbackUrls?: string[];
  /** Relative to the uploads folder, as WordPress names it: `2023/03/foo.jpg`. */
  file: string;
  /** Project-relative, forward slashes: `public/media/2023/03/foo.jpg`. */
  destPath: string;
  /** What markup says: `/media/2023/03/foo.jpg`. */
  publicPath: string;
  width?: number;
  height?: number;
  mime: string;
}

export interface MediaRef {
  src: string;
  width?: number;
  height?: number;
  alt?: string;
}

export interface MediaStats {
  /** Attachments in the model. */
  attachments: number;
  /** Attachments left out: no usable `file` and no file address in their guid, not published, or refused by `include`. */
  unplanned: number;
  /** Files to download. */
  files: number;
  /** Of those, the ones found only through `extraUrls`. */
  extraFiles: number;
  /** Names (sizes, edits, the unscaled upload, the guid's name) that resolve to a file shipped under another name. */
  aliases: number;
}

export interface MediaPlan {
  files: MediaFile[];
  /** The file an attachment id resolves to; `alt` is the attachment's alt text, `""` when it has none. */
  mediaFor(attachmentId: number): (MediaRef & { alt: string }) | undefined;
  /**
   * The file any uploads URL resolves to: a size (`foo-300x200.jpg`), the `-scaled` or unscaled
   * name, the guid's host or the site's, `http`, `https` or protocol-relative, percent-encoded or
   * not. Attachments first, `extraUrls` second. A URL that resolves to nothing is recorded in
   * `unresolved` (the host is one of the site's) or `external` (it is not) and answers undefined.
   */
  mediaForUrl(url: string): MediaRef | undefined;
  /**
   * Media addresses asked about (or listed in `extraUrls`) on hosts the site does not own, in
   * first-seen order. They are left alone: an image on a CDN, a YouTube thumbnail, another site's
   * uploads folder. A page link, a stylesheet or a script is no media address and is not listed.
   */
  readonly external: string[];
  /**
   * Media addresses on the site's own hosts that no attachment or extra URL accounts for, in
   * first-seen order: an upload with no attachment, a file in a folder that is not uploads, a name
   * nobody recognises. The caller reports them, or lists them in `extraUrls` and plans again.
   */
  readonly unresolved: string[];
  /** Attachments that could not be planned. */
  readonly unplanned: { attachmentId: number; reason: string }[];
  /**
   * The files content asked for so far, in plan order: every one an `mediaFor` or `mediaForUrl`
   * answered with, and every one listed in `extraUrls`. `files` is the whole public library; this is
   * what a migration needs to download.
   */
  used(): MediaFile[];
  /** The uploads base the plan derived or was given, no trailing slash. */
  readonly uploadsBase: string;
  readonly stats: MediaStats;
}

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/** `foo-300x200`: a registered size. */
const SIZE_MARKER = /-(\d{1,5})x(\d{1,5})$/;
/** `foo-scaled`: WordPress's working copy of an upload past the big-image threshold. */
const SCALED_MARKER = /-scaled$/;
/** `foo-e1722463968758`: a media-editor save; the digits are a millisecond timestamp. */
const EDIT_MARKER = /-e\d{10,}$/;
/** `foo-rotated`: the copy WordPress makes of an upload whose EXIF orientation it applied. */
const ROTATED_MARKER = /-rotated$/;
const MARKERS = [SIZE_MARKER, SCALED_MARKER, EDIT_MARKER, ROTATED_MARKER] as const;

/** A lone surrogate cannot be percent-encoded, and cannot be a name on any file system. */
const wellFormed = (s: string): string => s.toWellFormed();

/**
 * What a case-insensitive, normalisation-insensitive file system (macOS, Windows) would call the
 * same name. Upper then lower so `ß`/`ss` and `ſ`/`s` meet; being too eager only costs a suffix.
 */
const fold = (s: string): string => s.normalize("NFD").toUpperCase().toLowerCase();

const encodePath = (rel: string): string => rel.split("/").map(encodeURIComponent).join("/");

interface Parts {
  /** `""` or `2023/03/`. */
  dir: string;
  stem: string;
  /** With the dot, or `""`. */
  ext: string;
}

function parts(rel: string): Parts {
  const slash = rel.lastIndexOf("/");
  const name = rel.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return {
    dir: rel.slice(0, slash + 1),
    stem: dot > 0 ? name.slice(0, dot) : name,
    ext: dot > 0 ? name.slice(dot) : "",
  };
}

/** `stem` with one trailing marker removed, or undefined when it has none (or would be left empty). */
function stripMarker(stem: string): string | undefined {
  for (const marker of MARKERS) {
    const m = marker.exec(stem);
    if (m && m.index > 0) return stem.slice(0, m.index);
  }
  return undefined;
}

/**
 * The names a file may be a derivative of, nearest first, the name itself first. Each marker comes
 * off the end in whatever order they were stacked (`foo-scaled-e1722463968758-300x300`), and at every
 * level the `-scaled` twin is tried too, because a table that lists only the scaled copy still
 * answers for the upload's own name. These are lookups, never names to ship: they only ever hit
 * a name the database listed.
 */
function candidates(rel: string): string[] {
  const { dir, stem, ext } = parts(rel);
  const names = [stem];
  for (let s = stripMarker(stem); s !== undefined; s = stripMarker(s)) names.push(s);
  const out: string[] = [];
  for (const name of names) {
    out.push(`${dir}${name}${ext}`);
    if (!SCALED_MARKER.test(name)) out.push(`${dir}${name}-scaled${ext}`);
  }
  return out;
}

// ── MIME types ───────────────────────────────────────────────────────────────────────────────────

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  svg: "image/svg+xml",
  svgz: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  avi: "video/x-msvideo",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  zip: "application/zip",
  csv: "text/csv",
  txt: "text/plain",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

/** The extensions that can name an upload; anything else in a guid is a page address, not a file. */
const MEDIA_NAME = new RegExp(`\\.(?:${Object.keys(MIME_BY_EXT).join("|")})$`, "i");

function mimeOfName(rel: string): string {
  return MIME_BY_EXT[parts(rel).ext.slice(1).toLowerCase()] ?? "application/octet-stream";
}

/** An SVG by type or by name: a plugin may label one `application/octet-stream`. */
const isSvg = (att: WpAttachment): boolean =>
  att.mime.toLowerCase() === "image/svg+xml" || /\.svgz?$/i.test(att.file);

/**
 * Dimensions WordPress states: both positive. A `0` is what plugins write for an image they could not
 * measure. An SVG never states pixels: its metadata holds the root's `width`/`height` as written,
 * inches (`3.2679in`) or `100` for `100%`, so they are not used however plausible they look.
 */
function hasDimensions(att: WpAttachment): att is WpAttachment & { width: number; height: number } {
  return (
    att.width !== undefined &&
    att.height !== undefined &&
    att.width > 0 &&
    att.height > 0 &&
    !isSvg(att)
  );
}

/** Statuses of an attachment that a visitor can see (`inherit` follows a published parent or none). */
const PUBLIC_STATUS = new Set(["", "inherit", "publish"]);

/** `status` is the extra field `loadModel` carries beside `originalFile`; the contract has no place for it. */
function statusOf(model: WpModel, att: WpAttachment): string {
  const own = (att as WpAttachment & { status?: unknown }).status;
  if (typeof own === "string") return own;
  return model.posts.get(att.id)?.status ?? "";
}

const isImage = (att: WpAttachment): boolean =>
  att.mime === "" ? mimeOfName(att.file).startsWith("image/") : att.mime.startsWith("image/");

// ── Addresses ────────────────────────────────────────────────────────────────────────────────────

/** A URL, taken apart the way matching needs it. */
interface Located {
  /** Lower case, `www.` dropped, a non-default port kept: the identity of a host. */
  host: string;
  /** `https://media.example.org`, as written (lower-cased host). */
  origin: string;
  /** Percent-decoded, always with a leading slash, dot segments resolved, no query or fragment. */
  path: string;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * `input` as an address, or undefined when it is not one a browser would fetch over http(s) (`data:`,
 * `mailto:`, `#top`, an empty string). A relative address is read against `root`, the way a page
 * on the site would read it.
 */
function locate(input: string, root: string): Located | undefined {
  let text = input.trim();
  if (text === "") return undefined;
  if (text.startsWith("//")) text = `https:${text}`;
  let url: URL;
  try {
    url = new URL(text, root === "" ? undefined : `${root.replace(/\/+$/, "")}/`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return {
    host:
      url.hostname.toLowerCase().replace(/^www\./, "") + (url.port === "" ? "" : `:${url.port}`),
    origin: url.origin.toLowerCase(),
    path: wellFormed(url.pathname.split("/").map(decodeSegment).join("/")),
  };
}

/** A place uploads are served from: every URL on `host` whose path starts with `prefix` names a file relative to it. */
interface Base {
  host: string;
  /** Leading and trailing slash: `/wp-content/uploads/`, or `/` when the whole host is the uploads folder. */
  prefix: string;
  /** What to join an encoded relative path onto: `https://media.example.org/`. */
  url: string;
}

/**
 * WordPress's own answer to "where are uploads served" (`wp_upload_dir()`): the `upload_url_path`
 * option when set, else the site's address plus a relative `upload_path`, else
 * `<siteUrl>/wp-content/uploads`. An absolute `upload_path` is a file system path and says nothing
 * about the URL.
 */
function derivedUploadsBase(options: ReadonlyMap<string, string>, siteUrl: string): string {
  const urlPath = (options.get("upload_url_path") ?? "").trim();
  if (urlPath !== "") return urlPath.replace(/\/+$/, "");
  const uploadPath = (options.get("upload_path") ?? "").trim().replace(/^\/+|\/+$/g, "");
  const relative =
    uploadPath !== "" && !/^(?:[a-z]:|\/)/i.test((options.get("upload_path") ?? "").trim());
  return relative ? `${siteUrl}/${uploadPath}` : `${siteUrl}/wp-content/uploads`;
}

// ── Safe names ───────────────────────────────────────────────────────────────────────────────────

/** Everything that is not a letter or digit of any script, a mark, an emoji, or one of `._~-`. */
const UNSAFE = /[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}._~-]+/gu;
/** Names Windows reserves, with or without an extension. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?=\.|$)/i;
/** Longest path segment kept, in UTF-8 bytes: file systems stop at 255, and a suffix still has to fit. */
const MAX_SEGMENT_BYTES = 200;

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

function safeSegment(segment: string): string {
  let s = segment.normalize("NFC").replace(UNSAFE, "-");
  // `.` and `..` would walk the tree, and a leading or trailing dot hides the file or is dropped by Windows.
  s = s.replace(/^\.+/, "-").replace(/\.+$/, "-");
  if (s === "") s = "-";
  if (DEVICE_NAME.test(s)) s = `_${s}`;
  if (utf8Length(s) > MAX_SEGMENT_BYTES) {
    const { stem, ext } = parts(s);
    const keep = ext.length <= 16 ? ext : "";
    const room = MAX_SEGMENT_BYTES - utf8Length(keep) - 9;
    let cut = "";
    for (const ch of keep === "" ? s : stem) {
      if (utf8Length(cut + ch) > room) break;
      cut += ch;
    }
    const hash = createHash("sha256").update(segment).digest("hex").slice(0, 8);
    s = `${cut}-${hash}${keep}`;
  }
  return s;
}

function safePath(rel: string): string {
  return rel
    .split("/")
    .filter((segment) => segment !== "")
    .map(safeSegment)
    .join("/");
}

function withSuffix(path: string, segmentIndex: number, n: number): string {
  const segments = path.split("/");
  const last = segmentIndex === segments.length - 1;
  const segment = segments[segmentIndex]!;
  if (last) {
    const { stem, ext } = parts(segment);
    segments[segmentIndex] = `${stem}-${n}${ext}`;
  } else {
    segments[segmentIndex] = `${segment}-${n}`;
  }
  return segments.join("/");
}

/**
 * Hands out project paths, none of which can be mistaken for another on a case-insensitive file
 * system, and none of which is a directory another one needs (`a/b` and `a/b/c.jpg` cannot both exist).
 * A clash is settled by numbering the segment that clashes, so the loop ends: each number is a new name.
 */
class NameAllocator {
  private readonly files = new Set<string>();
  private readonly dirs = new Set<string>();

  /** The segment of `path` that is already taken, or -1. */
  private clash(path: string): number {
    const segments = fold(path).split("/");
    let prefix = "";
    for (let i = 0; i < segments.length; i++) {
      prefix = i === 0 ? segments[0]! : `${prefix}/${segments[i]!}`;
      if (i < segments.length - 1) {
        if (this.files.has(prefix)) return i;
      } else if (this.files.has(prefix) || this.dirs.has(prefix)) {
        return i;
      }
    }
    return -1;
  }

  fits(path: string): boolean {
    return this.clash(path) === -1;
  }

  place(wanted: string): string {
    let path = wanted;
    for (let n = 2; ; n++) {
      const at = this.clash(path);
      if (at === -1) break;
      path = withSuffix(wanted, at, n);
    }
    const segments = fold(path).split("/");
    this.files.add(segments.join("/"));
    for (let i = 1; i < segments.length; i++) this.dirs.add(segments.slice(0, i).join("/"));
    return path;
  }
}

// ── Planning ─────────────────────────────────────────────────────────────────────────────────────

/** A file to ship, before its project path is settled. */
interface Draft {
  /** What is shipped, relative to uploads. */
  rel: string;
  attachments: WpAttachment[];
  mime: string;
  width?: number;
  height?: number;
  sourceUrl: string;
  fallbackUrls: string[];
  file?: MediaFile;
}

/** What a name resolves to. */
interface Hit {
  draft: Draft;
  attachment?: WpAttachment;
}

/** How an attachment sits in the uploads folder: its names, and the base they are served from. */
interface Placement {
  att: WpAttachment;
  rel: string;
  orig?: string;
  sizes: string[];
  /** The guid's file name, joined to the directory of `rel`, when the guid is a file address under `base`. */
  guidName?: string;
  base: Base;
}

const cleanDir = (dir: string): string => {
  const slashed = dir.trim().replaceAll("\\", "/");
  const segments = slashed.split("/");
  if (/^(?:[a-z]:)?\//i.test(slashed) || /^[a-z]:/i.test(slashed) || segments.includes("..")) {
    throw new Error(
      `planMedia: outDir ${JSON.stringify(dir)} must be a path inside the project, not an absolute one or one that leaves it`,
    );
  }
  return segments.filter((s) => s !== "" && s !== ".").join("/");
};

/** `/media`, `https://cdn.example.com/media`, or `""` for the site root; never a trailing slash. */
const cleanUrlBase = (base: string): string => {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (trimmed === "" || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(trimmed)) return trimmed;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

/** An edit stamp, wherever the markers WordPress stacks after it (`-scaled`, `-rotated`, a size) leave it. */
const EDIT_STAMP = /-e\d{10,}(?=(?:-scaled|-rotated|-\d{1,5}x\d{1,5})*$)/;

/** `rel` as it was named before its last media-editor save, or undefined when it carries no stamp. */
function withoutEditStamp(rel: string): string | undefined {
  const { dir, stem, ext } = parts(rel);
  const plain = stem.replace(EDIT_STAMP, "");
  return plain === stem || plain === "" ? undefined : `${dir}${plain}${ext}`;
}

/** Whether `scaled` is `original`'s `-scaled` copy: same directory, same name plus the marker, same extension. */
function isScaledTwin(scaled: string, original: string): boolean {
  const a = parts(scaled);
  const b = parts(original);
  return a.dir === b.dir && a.stem === `${b.stem}-scaled` && a.ext === b.ext;
}

/**
 * The family an address no attachment stands behind belongs to, grouped as the importer groups them:
 * the directory, the name without a `-WxH` and then a `-scaled` marker, and the extension in lower case.
 */
function extraFamily(rel: string): {
  key: string;
  area: number | null;
  scaled: boolean;
  size?: [number, number];
} {
  const { dir, stem, ext } = parts(rel);
  let name = stem;
  let area: number | null = null;
  let size: [number, number] | undefined;
  const dimensions = SIZE_MARKER.exec(name);
  if (dimensions && dimensions.index > 0) {
    size = [Number(dimensions[1]), Number(dimensions[2])];
    area = size[0] * size[1];
    name = name.slice(0, dimensions.index);
  }
  const scaled = SCALED_MARKER.test(name) && name.length > "-scaled".length;
  if (scaled) name = name.replace(SCALED_MARKER, "");
  return { key: `${dir}${name}${ext.toLowerCase()}`, area, scaled, ...(size ? { size } : {}) };
}

export function planMedia(model: WpModel, opts: MediaOptions = {}): MediaPlan {
  const siteUrl = (opts.siteUrl ?? model.site.url).trim().replace(/\/+$/, "");
  const outDir = cleanDir(opts.outDir ?? "public/media");
  const urlBase = cleanUrlBase(opts.urlBase ?? "/media");
  const preferUnscaled = opts.preferUnscaled === true;

  const siteLocation = siteUrl === "" ? undefined : locate(siteUrl, "");
  const primaryBaseUrl =
    opts.uploadsBase !== undefined && opts.uploadsBase.trim() !== ""
      ? opts.uploadsBase.trim().replace(/\/+$/, "")
      : siteUrl === ""
        ? ""
        : derivedUploadsBase(model.options, siteUrl);
  if (primaryBaseUrl === "") {
    throw new Error("planMedia: the model has no site URL and no uploadsBase was given");
  }

  // ── bases: every place a URL for an upload can lead ──
  const bases = new Map<string, Base>();
  /** The same bases by host, longest prefix first: a lookup reads only the host's own. */
  const basesByHost = new Map<string, Base[]>();
  const makeBase = (location: Located, prefix: string): Base => {
    // The site's own host is served over the scheme the site is configured with, whatever an old guid says.
    const origin =
      siteLocation !== undefined && location.host === siteLocation.host
        ? siteLocation.origin
        : location.origin;
    return { host: location.host, prefix, url: `${origin}${encodePath(prefix)}` };
  };
  const addBase = (base: Base): Base => {
    const key = `${base.host}${base.prefix}`;
    const known = bases.get(key);
    if (known) return known;
    bases.set(key, base);
    const onHost = basesByHost.get(base.host) ?? [];
    basesByHost.set(base.host, onHost);
    onHost.push(base);
    onHost.sort((a, b) => b.prefix.length - a.prefix.length);
    return base;
  };
  const baseOfUrl = (url: string): Base | undefined => {
    const location = locate(url, siteUrl);
    if (!location) return undefined;
    const prefix = `${location.path.replace(/\/+$/, "")}/`;
    return makeBase(location, prefix);
  };

  // The bases the site itself serves uploads from: the one asked for or derived, then where WordPress
  // puts them unless told otherwise (old content keeps pointing there after an offload). A file is
  // fetched from these when its own host fails.
  const primaryBase = baseOfUrl(primaryBaseUrl);
  if (!primaryBase)
    throw new Error(`planMedia: ${JSON.stringify(primaryBaseUrl)} is not an address`);
  const siteBases: Base[] = [];
  for (const base of [primaryBase, baseOfUrl(`${siteUrl}/wp-content/uploads`)]) {
    if (!base) continue;
    const added = addBase(base);
    if (!siteBases.includes(added)) siteBases.push(added);
  }
  const primary = siteBases[0]!;
  // Content is also written against the address the database itself names (`siteurl`, `home`) when
  // `siteUrl` was overridden to where the site lives now, so those are recognised, never fetched from.
  for (const root of [model.site.url, model.site.home]) {
    const base =
      root === "" ? undefined : baseOfUrl(`${root.replace(/\/+$/, "")}/wp-content/uploads`);
    if (base) addBase(base);
  }
  for (const alias of opts.aliasHosts ?? []) {
    const text = alias.trim();
    const location = locate(
      /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(text) ? text : `https://${text}`,
      "",
    );
    if (!location) continue;
    const named = location.path.replace(/\/+$/, "");
    for (const prefix of named === ""
      ? new Set(["/wp-content/uploads/", primaryBase.prefix])
      : [`${named}/`]) {
      addBase(makeBase(location, prefix));
    }
  }

  /** `rel` under `base`, as an address. */
  const urlOf = (base: Base, rel: string): string => `${base.url}${encodePath(rel)}`;

  /** The relative path an address names under one of the bases (the longest prefix wins), or undefined. */
  const relUnder = (location: Located): { rel: string; base: Base }[] => {
    const out: { rel: string; base: Base }[] = [];
    for (const base of basesByHost.get(location.host) ?? []) {
      if (!location.path.startsWith(base.prefix)) continue;
      const rel = location.path
        .slice(base.prefix.length)
        .split("/")
        .filter((s) => s !== "")
        .join("/");
      if (rel !== "") out.push({ rel, base });
    }
    return out;
  };

  // ── where each attachment sits ──
  const attachments = [...model.attachments.values()].sort((a, b) => a.id - b.id);
  const unplanned: { attachmentId: number; reason: string }[] = [];
  const placements = new Map<number, Placement>();

  /**
   * The base an attachment's files are served from, read off its guid. The guid is the address the
   * upload had when it was made, so its host is where the file lives (media.example.org, a CDN, an
   * old staging host). Its directory must END WITH the directory of `file`, which strips the base
   * off it without trusting the file name: an image-renaming plugin changes `file` and leaves the
   * guid, and a guid that is a page address (`?attachment_id=7`, `/photo-by-someone/`) is not a file
   * address at all and says nothing.
   */
  const guidBaseOf = (att: WpAttachment, dir: string): { base: Base; name: string } | undefined => {
    const location = locate(att.url, siteUrl);
    if (!location) return undefined;
    const slash = location.path.lastIndexOf("/");
    const name = location.path.slice(slash + 1);
    if (!MEDIA_NAME.test(name)) return undefined;
    const guidDir = location.path.slice(0, slash + 1);
    const tail = `/${dir}`;
    if (!guidDir.endsWith(tail)) return undefined;
    const prefix = guidDir.slice(0, guidDir.length - dir.length);
    return { base: addBase(makeBase(location, prefix)), name };
  };

  /** An attachment's `file` as a path under uploads: `file` is an address when a media plugin kept it elsewhere. */
  const relativise = (file: string): { rel: string; base?: Base } | undefined => {
    const text = wellFormed(file.trim());
    if (text === "") return undefined;
    if (!/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(text)) {
      // WordPress on Windows has been seen to store `2023\03\a.jpg`; a browser reads the same address with slashes.
      return {
        rel: text
          .split(/[/\\]/)
          .filter((s) => s !== "")
          .join("/"),
      };
    }
    const location = locate(text, siteUrl);
    if (!location) return undefined;
    const under = relUnder(location)[0];
    if (under) return under;
    const rel = location.path
      .split("/")
      .filter((s) => s !== "")
      .join("/");
    return rel === "" ? undefined : { rel, base: addBase(makeBase(location, "/")) };
  };

  /**
   * An attachment with no `file` (an offloaded or externally hosted one) may still name its file in
   * its guid, when that is an absolute file address: under a known uploads folder, else the root of
   * its own host, as an absolute `file` is read. A page address or a bare directory is no file.
   */
  const relativiseGuid = (att: WpAttachment): { rel: string; base?: Base } | undefined => {
    const text = wellFormed(att.url.trim());
    if (!/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(text)) return undefined;
    const location = locate(text, siteUrl);
    if (!location || !MEDIA_NAME.test(location.path.slice(location.path.lastIndexOf("/") + 1))) {
      return undefined;
    }
    return relativise(text);
  };

  for (const att of attachments) {
    const status = statusOf(model, att);
    if (!PUBLIC_STATUS.has(status)) {
      unplanned.push({
        attachmentId: att.id,
        reason: `the attachment is ${status}, not published, so it is not shipped`,
      });
      continue;
    }
    if (opts.include && !opts.include(att)) {
      unplanned.push({ attachmentId: att.id, reason: "the attachment is excluded by `include`" });
      continue;
    }
    const file = relativise(att.file) ?? relativiseGuid(att);
    if (!file) {
      unplanned.push({ attachmentId: att.id, reason: "the attachment names no file" });
      continue;
    }
    const { dir } = parts(file.rel);
    const fromGuid = file.base ? undefined : guidBaseOf(att, dir);
    const base = file.base ?? fromGuid?.base ?? primary;
    const orig = att.originalFile === undefined ? undefined : relativise(att.originalFile)?.rel;
    const sizes = isImage(att)
      ? att.sizes
          .map((s) => (s.file === "" ? "" : `${dir}${wellFormed(s.file)}`))
          .filter((s) => s !== "")
      : [];
    placements.set(att.id, {
      att,
      rel: file.rel,
      sizes,
      base,
      ...(orig === undefined ? {} : { orig }),
      ...(fromGuid ? { guidName: `${dir}${fromGuid.name}` } : {}),
    });
  }

  // Where most of the library is served from. Every file is tried there after its own address.
  const uses = new Map<Base, number>();
  for (const { base } of placements.values()) uses.set(base, (uses.get(base) ?? 0) + 1);
  const libraryBase =
    [...uses].sort((a, b) => b[1] - a[1] || (a[0].url < b[0].url ? -1 : 1))[0]?.[0] ?? primary;

  // ── drafts: one file per distinct shipped name ──
  const drafts: Draft[] = [];
  const draftByRel = new Map<string, Draft>();
  const hits = new Map<number, Hit>();
  const exact = new Map<string, { hit: Hit; tier: number }>();
  const folded = new Map<string, { hit: Hit; tier: number }>();
  let aliasCount = 0;

  /**
   * Files a name under a table, unless a name of a better tier is there: the attachment's own file
   * (0), its unscaled upload (1), the name its guid gives (2), a size (3), and last, any of those
   * without its edit stamp (4), because the picture as it was before an edit stays on disk beside
   * the edit and old content points at it.
   */
  const register = (rel: string, hit: Hit, tier: number): void => {
    for (const [table, key] of [
      [exact, rel],
      [folded, fold(rel)],
    ] as const) {
      const known = table.get(key);
      if (!known || known.tier > tier) table.set(key, { hit, tier });
    }
    const plain = tier < 4 ? withoutEditStamp(rel) : undefined;
    if (plain !== undefined) register(plain, hit, 4);
  };

  for (const att of attachments) {
    const placement = placements.get(att.id);
    if (!placement) continue;
    const useOriginal =
      preferUnscaled &&
      placement.orig !== undefined &&
      isImage(att) &&
      isScaledTwin(placement.rel, placement.orig);
    const shipped = useOriginal ? placement.orig! : placement.rel;

    let draft = draftByRel.get(shipped);
    if (!draft) {
      draft = {
        rel: shipped,
        attachments: [],
        mime: att.mime !== "" ? att.mime : mimeOfName(shipped),
        sourceUrl: urlOf(placement.base, shipped),
        fallbackUrls: [],
      };
      drafts.push(draft);
      draftByRel.set(shipped, draft);
    }
    draft.attachments.push(att);
    // The unscaled upload's dimensions are recorded nowhere; the file's own are.
    if (draft.width === undefined && !useOriginal && hasDimensions(att)) {
      draft.width = att.width;
      draft.height = att.height;
    }

    // Other places this file may be, base by base: the one its guid names, the one most of the library
    // lives on (a guid left behind by an offload plugin names the old host; 1 of anabaptistperspectives'
    // 1,794 does), then the site's own. At each, the file, and the scaled copy it replaces.
    for (const base of new Set([placement.base, libraryBase, ...siteBases])) {
      for (const rel of useOriginal ? [shipped, placement.rel] : [shipped]) {
        const url = urlOf(base, rel);
        if (url !== draft.sourceUrl && !draft.fallbackUrls.includes(url))
          draft.fallbackUrls.push(url);
      }
    }

    const hit: Hit = { draft, attachment: att };
    hits.set(att.id, hit);
    register(placement.rel, hit, 0);
    if (placement.orig !== undefined) register(placement.orig, hit, 1);
    if (placement.guidName !== undefined) register(placement.guidName, hit, 2);
    for (const size of placement.sizes) register(size, hit, 3);
  }
  for (const [key, { hit }] of exact) if (key !== hit.draft.rel) aliasCount++;

  // ── lookups ──
  const owned = new Set<string>();
  for (const base of bases.values()) owned.add(base.host);
  if (siteLocation) owned.add(siteLocation.host);
  const homeLocation = locate(model.site.home, "");
  if (homeLocation) owned.add(homeLocation.host);

  const lookupAttachment = (rel: string): Hit | undefined => {
    const names = candidates(rel);
    for (const name of names) {
      const found = exact.get(name);
      if (found) return found.hit;
    }
    for (const name of names) {
      const found = folded.get(fold(name));
      if (found) return found.hit;
    }
    return undefined;
  };

  // ── extras: URLs no attachment accounts for ──
  const externalUrls: string[] = [];
  const externalSeen = new Set<string>();
  const unresolvedUrls: string[] = [];
  const unresolvedSeen = new Set<string>();
  /**
   * Records an address that led nowhere, when it is one a person would call a media file: a name
   * with a media extension, or an extensionless one under an uploads base. A page link, a stylesheet
   * or a script is not the planner's to account for and is recorded nowhere.
   */
  const note = (location: Located, url: string): void => {
    const name = location.path.slice(location.path.lastIndexOf("/") + 1);
    const mediaLike =
      MEDIA_NAME.test(name) || (!name.includes(".") && relUnder(location).length > 0);
    if (!mediaLike) return;
    const text = url.trim();
    if (owned.has(location.host)) {
      if (!unresolvedSeen.has(text)) {
        unresolvedSeen.add(text);
        unresolvedUrls.push(text);
      }
    } else if (!externalSeen.has(text)) {
      externalSeen.add(text);
      externalUrls.push(text);
    }
  };

  interface Member {
    rel: string;
    url: string;
    area: number | null;
    scaled: boolean;
    size?: [number, number];
  }
  const families = new Map<string, Member[]>();
  const extraByRel = new Map<string, Draft>();
  const extraByKey = new Map<string, Draft>();
  for (const url of opts.extraUrls ?? []) {
    const location = locate(url, siteUrl);
    if (!location) continue;
    const under = relUnder(location);
    if (under.length === 0) {
      note(location, url);
      continue;
    }
    if (under.some((u) => lookupAttachment(u.rel))) continue;
    const { rel, base } = under[0]!;
    const family = extraFamily(rel);
    const members = families.get(family.key) ?? [];
    families.set(family.key, members);
    if (!members.some((m) => m.rel === rel)) {
      members.push({
        rel,
        url: urlOf(base, rel),
        area: family.area,
        scaled: family.scaled,
        ...(family.size ? { size: family.size } : {}),
      });
    }
  }
  // The importer's ranking: the upload itself, else the scaled copy, else the largest explicit crop.
  // The winner is always a name that was seen, because a synthesised one may not exist.
  const ranked = (m: Member): number => (m.area === null ? (m.scaled ? 1 : 0) : 2);
  const extraDrafts: Draft[] = [];
  for (const [key, members] of families) {
    members.sort(
      (a, b) =>
        ranked(a) - ranked(b) ||
        (b.area ?? 0) - (a.area ?? 0) ||
        (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
    );
    const winner = members[0]!;
    const draft: Draft = {
      rel: winner.rel,
      attachments: [],
      mime: mimeOfName(winner.rel),
      sourceUrl: winner.url,
      fallbackUrls: [],
      ...(winner.size ? { width: winner.size[0], height: winner.size[1] } : {}),
    };
    const others = [
      ...members.slice(1).map((m) => m.url),
      ...[...new Set([libraryBase, ...siteBases])].map((b) => urlOf(b, winner.rel)),
    ];
    for (const url of others) {
      if (url !== draft.sourceUrl && !draft.fallbackUrls.includes(url))
        draft.fallbackUrls.push(url);
    }
    extraDrafts.push(draft);
    extraByKey.set(key, draft);
    for (const m of members) extraByRel.set(m.rel, draft);
  }
  extraDrafts.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  drafts.push(...extraDrafts);

  // ── project paths ──
  const allocator = new NameAllocator();
  const wanted = drafts.map((d) => ({ draft: d, safe: safePath(d.rel) }));
  const settled = new Map<Draft, string>();
  // A name that needed no rewriting keeps it before any rewritten name can take it.
  for (const { draft, safe } of wanted) {
    if (safe === draft.rel && allocator.fits(safe)) settled.set(draft, allocator.place(safe));
  }
  for (const { draft, safe } of wanted) {
    if (!settled.has(draft)) settled.set(draft, allocator.place(safe));
  }
  for (const draft of drafts) {
    const rel = settled.get(draft)!;
    draft.file = {
      attachmentIds: draft.attachments.map((a) => a.id),
      sourceUrl: draft.sourceUrl,
      fallbackUrls: draft.fallbackUrls,
      file: draft.rel,
      destPath: outDir === "" ? rel : `${outDir}/${rel}`,
      publicPath: `${urlBase}/${rel}`,
      mime: draft.mime,
      ...(draft.width === undefined ? {} : { width: draft.width }),
      ...(draft.height === undefined ? {} : { height: draft.height }),
    };
  }

  const usedDrafts = new Set<Draft>(extraDrafts);
  const refOf = (draft: Draft, attachment: WpAttachment | undefined): MediaRef => {
    usedDrafts.add(draft);
    const file = draft.file!;
    return {
      src: file.publicPath,
      ...(file.width === undefined ? {} : { width: file.width }),
      ...(file.height === undefined ? {} : { height: file.height }),
      ...(attachment === undefined ? {} : { alt: attachment.alt }),
    };
  };

  const resolve = (location: Located): MediaRef | undefined => {
    const under = relUnder(location);
    for (const { rel } of under) {
      const hit = lookupAttachment(rel);
      if (hit) return refOf(hit.draft, hit.attachment);
    }
    for (const { rel } of under) {
      const draft = extraByRel.get(rel) ?? extraByKey.get(extraFamily(rel).key);
      if (draft) return refOf(draft, undefined);
    }
    return undefined;
  };

  return {
    files: drafts.map((d) => d.file!),
    mediaFor(attachmentId) {
      const hit = hits.get(attachmentId);
      if (!hit) return undefined;
      const ref = refOf(hit.draft, hit.attachment);
      return { ...ref, alt: hit.attachment?.alt ?? "" };
    },
    mediaForUrl(url) {
      const location = locate(url, siteUrl);
      if (!location) return undefined;
      const found = resolve(location);
      if (!found) note(location, url);
      return found;
    },
    get external() {
      return [...externalUrls];
    },
    get unresolved() {
      return [...unresolvedUrls];
    },
    unplanned,
    used: () => drafts.filter((d) => usedDrafts.has(d)).map((d) => d.file!),
    uploadsBase: primaryBaseUrl,
    stats: {
      attachments: attachments.length,
      unplanned: unplanned.length,
      files: drafts.length,
      extraFiles: extraDrafts.length,
      aliases: aliasCount,
    },
  };
}

// ── Sniffing ─────────────────────────────────────────────────────────────────────────────────────

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  signature.every((b, i) => bytes[at + i] === b);

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)));

/** The start of a text file as text, no further than `limit` bytes. (The decoder drops a byte order mark itself.) */
function textHead(bytes: Uint8Array, limit: number): string {
  return new TextDecoder().decode(bytes.subarray(0, limit));
}

/**
 * Past the XML declaration, comments and doctype that may precede the root of an SVG: true when the
 * root is `<svg`. Editors write all three, so an SVG that starts `<?xml` or `<!--` is the ordinary case.
 */
function looksLikeSvg(head: string): boolean {
  let i = 0;
  for (;;) {
    while (i < head.length && /\s/.test(head[i]!)) i++;
    if (head.startsWith("<?", i)) {
      const end = head.indexOf("?>", i);
      if (end === -1) return false;
      i = end + 2;
    } else if (head.startsWith("<!--", i)) {
      const end = head.indexOf("-->", i);
      if (end === -1) return false;
      i = end + 3;
    } else if (/^<!doctype/i.test(head.slice(i, i + 9))) {
      // A doctype may carry an internal subset: `<!DOCTYPE svg [ ... ]>`.
      const subset = head.indexOf("[", i);
      const close = head.indexOf(">", i);
      if (close === -1) return false;
      if (subset !== -1 && subset < close) {
        const end = head.indexOf("]>", subset);
        if (end === -1) return false;
        i = end + 2;
      } else {
        i = close + 1;
      }
    } else {
      return /^<svg[\s>/]/i.test(head.slice(i, i + 5));
    }
  }
}

/** What a browser would take for markup: a document, or the tags error pages and login walls start with. */
const HTML_START =
  /^(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<title[\s>]|<meta[\s>]|<script[\s>]|<style[\s>]|<iframe[\s>]|<h1[\s>]|<div[\s>]|<p[\s>]|<br[\s>/]|<table[\s>]|<a\s|<\?php)/i;

function looksLikeHtml(head: string): boolean {
  const text = head.trimStart();
  // Only markup that starts as markup: a CSV whose cells hold `<html>` is still a CSV.
  if (!text.startsWith("<")) return false;
  return HTML_START.test(text) || /<(?:html|head|body)[\s>]/i.test(text.slice(0, 1024));
}

/**
 * The media type the first bytes of a body show, or undefined when they show none that is known: the
 * common image formats, SVG, PDF, ZIP, the usual audio and video containers, and `text/html` (an error
 * page, a login wall). Names and headers lie, bytes do not, which is why a download is judged on this.
 */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (ascii(bytes, 0, 4) === "RIFF") {
    const kind = ascii(bytes, 8, 12);
    if (kind === "WEBP") return "image/webp";
    if (kind === "WAVE") return "audio/wav";
  }
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (/^(?:heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return "image/heic";
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "image/tiff";
  }
  if (startsWith(bytes, [0x42, 0x4d]) && startsWith(bytes, [0, 0, 0, 0], 6)) return "image/bmp";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) || startsWith(bytes, [0x00, 0x00, 0x02, 0x00])) {
    return "image/x-icon";
  }
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
    return "audio/mpeg";
  }
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  const head = textHead(bytes, 2048);
  if (looksLikeSvg(head)) return "image/svg+xml";
  if (looksLikeHtml(head)) return "text/html";
  return undefined;
}

// ── Download ─────────────────────────────────────────────────────────────────────────────────────

/** Where bytes go. A `Sink` from types.ts is one. */
export interface MediaIo {
  write(destPath: string, bytes: Uint8Array): Promise<void>;
}

/** What `fetch` is to `downloadMedia`: the global one is, and so is a test double. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DownloadStatus = "ok" | "skipped" | "failed";

export interface DownloadOutcome {
  file: MediaFile;
  status: DownloadStatus;
  /** Bytes written, for `ok`. */
  bytes?: number;
  /** The address that served it (a fallback when `sourceUrl` failed), for `ok`. */
  url?: string;
  /** Requests made. */
  attempts: number;
  /** Why it failed: every address tried and what it said. */
  error?: string;
}

export interface DownloadProgress {
  done: number;
  total: number;
  outcome: DownloadOutcome;
}

export interface DownloadOptions {
  fetch?: FetchLike | undefined;
  /** Files in flight at once. Default 6. */
  concurrency?: number | undefined;
  /** Whether a file is already in place and need not be fetched. */
  skipExisting?: ((destPath: string) => Promise<boolean>) | undefined;
  onProgress?: ((progress: DownloadProgress) => void) | undefined;
  /** Further attempts per address after a failure that can pass (network, timeout, 408/425/429/5xx). Default 2. */
  retries?: number | undefined;
  /** Wait before the first retry; doubles each time. Default 300. */
  retryDelayMs?: number | undefined;
  /** Per request. Default 60,000. */
  timeoutMs?: number | undefined;
  userAgent?: string | undefined;
  /** Failed files are added here as `media.download-failed`. */
  report?: Report | undefined;
}

export interface DownloadResult {
  /** In plan order. */
  outcomes: DownloadOutcome[];
  ok: number;
  skipped: number;
  failed: number;
  /** Bytes written. */
  bytes: number;
}

type Kind = "raster" | "svg" | "pdf" | "html" | "other";

function kindOf(file: MediaFile): Kind {
  const mime = (file.mime || mimeOfName(file.file)).toLowerCase();
  if (mime === "image/svg+xml") return "svg";
  if (mime.startsWith("image/")) return "raster";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  return "other";
}

/**
 * Why a response must not be written as `file`, or undefined when it may be. The bytes decide: an
 * HTML error page with a 200 status and `image/jpeg` on it is still an error page, and an image sent
 * as `application/octet-stream` (S3's default) is still an image. The content type only speaks for
 * what the bytes cannot, a file type with no signature (a CSV, an audio format this does not know)
 * that arrives labelled as a web page.
 */
function problemWith(
  file: MediaFile,
  bytes: Uint8Array,
  contentType: string | undefined,
): string | undefined {
  if (bytes.length === 0) return "the response body is empty";
  const kind = kindOf(file);
  if (kind === "html") return undefined;
  const sniffed = sniffMediaType(bytes);
  if (sniffed === "text/html") return "the response is an HTML page, not the file";
  const said = contentType === undefined ? "no content type" : contentType;
  switch (kind) {
    case "raster":
      return sniffed?.startsWith("image/") ? undefined : `the response is not an image (${said})`;
    case "svg":
      return sniffed?.startsWith("image/") ? undefined : `the response is not an SVG (${said})`;
    case "pdf":
      return sniffed === "application/pdf" ? undefined : `the response is not a PDF (${said})`;
    default:
      return sniffed === undefined &&
        contentType !== undefined &&
        /^(?:text\/html|application\/xhtml\+xml)\b/.test(contentType)
        ? `the response is labelled ${contentType}, not the file`
        : undefined;
  }
}

interface Attempt {
  bytes?: Uint8Array;
  error?: string;
  retryable: boolean;
  /** What the server asked for in `Retry-After`, in milliseconds. */
  waitMs?: number;
}

function retryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A count option read off a command line (`Number("x")` is NaN) or written as Infinity: anything that
 * is not a finite number is the default, and the rest is a whole number inside `[min, max]`. Left raw,
 * NaN starts no worker or makes no request, and Infinity never ends against an address that keeps failing.
 */
function wholeNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Fetches every file of the plan to its `destPath` through `io`. A file is tried at its `sourceUrl`
 * and then at each fallback; at each address a failure that may pass (a dropped connection, a
 * timeout, 408, 425, 429, a 5xx, a body shorter than its Content-Length) is retried with a doubling
 * wait, and one that will not (404, 403, an HTML page served with 200) moves on at once. A file no
 * address could give is `failed`, and says why in the report as `media.download-failed`; the rest
 * are unaffected, so one dead image never stops a migration.
 */
export async function downloadMedia(
  plan: Pick<MediaPlan, "files">,
  io: MediaIo,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const concurrency = wholeNumber(opts.concurrency, 6, 1, 64);
  const retries = wholeNumber(opts.retries, 2, 0, 10);
  const retryDelayMs = Math.max(0, Number.isFinite(opts.retryDelayMs) ? opts.retryDelayMs! : 300);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const userAgent = opts.userAgent ?? "wp2jx";

  const attempt = async (url: string, file: MediaFile): Promise<Attempt> => {
    let response: Response;
    try {
      response = await doFetch(url, {
        redirect: "follow",
        headers: { accept: "*/*", "user-agent": userAgent },
        ...(Number.isFinite(timeoutMs) && timeoutMs > 0
          ? { signal: AbortSignal.timeout(timeoutMs) }
          : {}),
      });
    } catch (error) {
      return { error: describe(error), retryable: true };
    }
    if (!response.ok) {
      // An error page nobody reads must not hold its connection open.
      response.body?.cancel().catch(() => {});
      const waitMs = retryAfter(response.headers.get("retry-after"));
      return {
        error: `HTTP ${response.status}`,
        retryable:
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500,
        ...(waitMs === undefined ? {} : { waitMs }),
      };
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      return { error: `the body could not be read: ${describe(error)}`, retryable: true };
    }
    // A Content-Length is the size on the wire; only without a content encoding does it equal the body.
    const declared = Number(response.headers.get("content-length"));
    const encoded = (response.headers.get("content-encoding") ?? "identity") !== "identity";
    if (
      !encoded &&
      Number.isFinite(declared) &&
      response.headers.has("content-length") &&
      declared !== bytes.length
    ) {
      return {
        error: `the body is ${bytes.length} bytes, not the ${declared} announced`,
        retryable: true,
      };
    }
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const problem = problemWith(file, bytes, type);
    return problem === undefined
      ? { bytes, retryable: false }
      : { error: problem, retryable: false };
  };

  const fail = (
    file: MediaFile,
    attempts: number,
    tried: { url: string; error: string }[],
  ): DownloadOutcome => {
    const error = tried.map((t) => (t.url === "" ? t.error : `${t.url}: ${t.error}`)).join("; ");
    opts.report?.add({
      severity: "error",
      code: "media.download-failed",
      message: `${file.file} could not be downloaded, so ${file.publicPath} does not exist in the project.`,
      where: file.attachmentIds.length > 0 ? `post:${file.attachmentIds[0]}` : `media:${file.file}`,
      ...(file.sourceUrl === "" ? {} : { url: file.sourceUrl }),
      data: {
        file: file.file,
        destPath: file.destPath,
        attachmentIds: file.attachmentIds,
        attempts: tried,
      },
    });
    return { file, status: "failed", attempts, error };
  };

  const fetchFile = async (file: MediaFile): Promise<DownloadOutcome> => {
    if (opts.skipExisting) {
      try {
        if (await opts.skipExisting(file.destPath)) return { file, status: "skipped", attempts: 0 };
      } catch (error) {
        return fail(file, 0, [
          { url: file.destPath, error: `skipExisting threw: ${describe(error)}` },
        ]);
      }
    }
    const urls = [file.sourceUrl, ...(file.fallbackUrls ?? [])].filter((u) => u !== "");
    const tried: { url: string; error: string }[] = [];
    let attempts = 0;
    for (const url of urls) {
      for (let n = 0; n <= retries; n++) {
        attempts++;
        const result = await attempt(url, file);
        if (result.bytes) {
          try {
            await io.write(file.destPath, result.bytes);
          } catch (error) {
            return fail(file, attempts, [
              { url: file.destPath, error: `could not write: ${describe(error)}` },
            ]);
          }
          return { file, status: "ok", bytes: result.bytes.length, url, attempts };
        }
        tried.push({ url, error: result.error ?? "failed" });
        if (!result.retryable || n === retries) break;
        await sleep(Math.min(10_000, Math.max(result.waitMs ?? 0, retryDelayMs * 2 ** n)));
      }
    }
    if (urls.length === 0) tried.push({ url: "", error: "the file has no source address" });
    return fail(file, attempts, tried);
  };

  const files = plan.files;
  const outcomes = Array.from<DownloadOutcome>({ length: files.length });
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const outcome = await fetchFile(files[i]!);
      outcomes[i] = outcome;
      done++;
      try {
        opts.onProgress?.({ done, total: files.length, outcome });
      } catch {
        // An observer that throws must not take the other downloads with it.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));

  const result: DownloadResult = { outcomes, ok: 0, skipped: 0, failed: 0, bytes: 0 };
  for (const outcome of outcomes) {
    result[outcome.status]++;
    result.bytes += outcome.bytes ?? 0;
  }
  return result;
}
