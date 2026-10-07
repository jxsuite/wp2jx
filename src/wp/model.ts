/**
 * WordPress database → {@link WpModel}: one pass over the tables, then plain in-memory maps.
 *
 * Everything downstream reads this model and never SQL, so this is where the differences between
 * engines end: MySQL answers a DATETIME with a `Date` (an Invalid Date for the zero date) and SQLite
 * with a string, and a BIGINT past 2^31 or a DECIMAL arrives as a string (a bigint if the driver is told
 * so). Everything leaves here as an ISO 8601 UTC string, a `number` or a `string`.
 *
 * A DATETIME in a GMT column is UTC; one in a local column (`post_date`, `post_modified`) is the site's
 * wall clock, and is turned into UTC with the site's timezone only where its GMT twin is the zero date
 * (a draft never published), exactly as WordPress's `get_gmt_from_date` does.
 *
 * Text is returned as stored, and WordPress does not store it uniformly: term names, user display
 * names, `blogname` and `blogdescription` hold HTML entities (`Missions &amp; Evangelism`, `Jesus&#039;
 * kingdom`) while a post title written by an administrator holds the characters. Whatever shows such a
 * string as text decodes it exactly once with {@link decodeEntities}, which leaves a string that was
 * never encoded alone.
 *
 * Nothing is silently dropped: when a `report` is passed, a value this module cannot represent is
 * recorded there (codes `wp.*`), each with the row it came from and, for a post that has one, the
 * address it has on the source site.
 */
import { fromHtml } from "hast-util-from-html";
import type {
  Report,
  WpAttachment,
  WpDb,
  WpMenuItem,
  WpModel,
  WpPost,
  WpRedirect,
  WpSite,
  WpTerm,
  WpUser,
} from "../types.ts";
import { tableExists } from "./db.ts";
import { isSerialized, maybeUnserialize } from "./phpser.ts";
import { loadUserProfiles, setUserProfiles } from "./profiles.ts";

export interface LoadOptions {
  /**
   * Post types to load into `model.posts`. Default: every type present except
   * {@link DEFAULT_EXCLUDED_POST_TYPES}. Attachments, menu items, terms, users and redirects are
   * loaded whatever this says, because content refers to them.
   */
  postTypes?: string[] | undefined;
  /** Post statuses to load. Default: every status except `trash` and `auto-draft`. */
  statuses?: string[] | undefined;
  /** Which post meta rows to keep in `model.postMeta`; absent keeps all. Attachment facts are read regardless. */
  metaKeys?: ((key: string, postType: string) => boolean) | undefined;
  /** Where to record what could not be represented. */
  report?: Report | undefined;
}

/** Bookkeeping post types nobody migrates. (`auto-draft` is a status; it is excluded below as well.) */
export const DEFAULT_EXCLUDED_POST_TYPES: readonly string[] = [
  "revision",
  "auto-draft",
  "customize_changeset",
  "oembed_cache",
  "scheduled-action",
  "user_request",
];

/** Statuses that mean "gone": WordPress's trash, and the empty drafts it creates on its own. */
const DEFAULT_EXCLUDED_STATUSES: readonly string[] = ["trash", "auto-draft"];

/** A `where x in (…)` never carries more ids than this. */
const CHUNK = 500;

const REDIRECT_COMPARISONS = new Set(["exact", "contains", "start", "end", "regex"]);
const ATTACHMENT_META = new Set([
  "_wp_attached_file",
  "_wp_attachment_metadata",
  "_wp_attachment_image_alt",
]);

/** What a visitor reads as comments. Plugins keep their own notes in the same table under other types. */
const COMMENT_TYPES = ["", "comment", "pingback", "trackback", "review"] as const;

/**
 * Post types that exist for WordPress, ACF, Cwicly or a plugin and have no page of their own: no
 * address on the site, whatever their status. (A type this list does not know is taken to be public.)
 */
const INTERNAL_POST_TYPES = new Set([
  "attachment",
  "cc_block",
  "customize_changeset",
  "custom_css",
  "nav_menu_item",
  "oembed_cache",
  "revision",
  "scheduled-action",
  "user_request",
  "wp_block",
  "wp_font_face",
  "wp_font_family",
  "wp_global_styles",
  "wp_navigation",
  "wp_template",
  "wp_template_part",
]);

// ── Value normalisation ──────────────────────────────────────────────────────────────────────────

/** A text column as a string: null is "", and a driver that returns bytes for a text column is decoded. */
function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}

/** A numeric column as a number, whether it arrived as one, as a bigint, or as a string. */
function num(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;

/**
 * A site's own wall-clock time as the UTC instant it was. Both sides are milliseconds, and the wall
 * time is read as if it were UTC (`Date.UTC(2025, 1, 27, 20, 9, 28)` for 20:09:28 on the 27th).
 */
type Clock = (wallMs: number) => number;

const UTC: Clock = (wallMs) => wallMs;

const DAY = 86_400_000;

/** A named zone, with its daylight saving. Throws when the runtime does not know the name. */
function zoneClock(zone: string): Clock {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  /** How far the zone's wall clock is ahead of UTC at the instant `utcMs`. */
  const offsetAt = (utcMs: number): number => {
    const part: Record<string, number> = {};
    for (const { type, value } of format.formatToParts(utcMs)) part[type] = Number(value);
    const wall = Date.UTC(
      part.year!,
      part.month! - 1,
      part.day!,
      part.hour!,
      part.minute!,
      part.second!,
    );
    return wall - Math.floor(utcMs / 1000) * 1000;
  };
  return (wallMs) => {
    // The offset a day either side brackets any daylight-saving change that could touch this wall time.
    const before = offsetAt(wallMs - DAY);
    const after = offsetAt(wallMs + DAY);
    const fits = (offset: number): boolean => offsetAt(wallMs - offset) === offset;
    const valid = [...new Set([before, after])].filter(fits);
    // An hour that never happened (clocks went forward) is read with the offset before the change, as PHP
    // reads it. An hour that happens twice (clocks went back) is read as its first time, the larger
    // offset: PHP does the same west of UTC and takes the second time east of it, and no wall time
    // there has a better answer, so the one rule is kept. Either way it moves a date by an hour.
    return wallMs - (valid.length === 0 ? before : Math.max(...valid));
  };
}

/**
 * The site's clock: WordPress's own rule (`wp_timezone()`) is the `timezone_string` option when it
 * names a zone, else the `gmt_offset` option as a fixed number of hours, else UTC. A value that does not
 * work is reported and the next one stands in.
 */
function siteClock(options: ReadonlyMap<string, string>, report: Report | undefined): Clock {
  const zone = (options.get("timezone_string") ?? "").trim();
  if (zone !== "") {
    try {
      return zoneClock(zone);
    } catch {
      report?.add({
        severity: "warn",
        code: "wp.timezone-invalid",
        message: `The timezone_string option names a zone this runtime does not know (${JSON.stringify(zone)}); gmt_offset, or UTC, stands in when local dates are converted.`,
        where: "option:timezone_string",
        data: { timezone: zone },
      });
    }
  }
  const offset = (options.get("gmt_offset") ?? "").trim();
  if (offset !== "") {
    const hours = Number(offset);
    if (Number.isFinite(hours)) return (wallMs) => wallMs - hours * 3_600_000;
    report?.add({
      severity: "warn",
      code: "wp.timezone-invalid",
      message: `The gmt_offset option is not a number (${JSON.stringify(offset)}); UTC stands in when local dates are converted.`,
      where: "option:gmt_offset",
      data: { offset },
    });
  }
  return UTC;
}

/**
 * A DATETIME as ISO 8601 UTC, or null when it is not a real date. MySQL's driver reads a DATETIME
 * as UTC, so a `Date` already holds the stored digits; SQLite hands the digits over as text, which
 * is read the same way. The zero date (`0000-00-00 00:00:00`) is an Invalid Date from MySQL and a
 * string of zeros from SQLite; both are null.
 *
 * Digits with no zone are a wall-clock time. In a GMT column that is UTC already; in a local column
 * (`post_date`) pass the site's `local` clock, which turns them into the instant they were. A string
 * that states its own zone is an instant either way.
 */
function isoUtc(value: unknown, local: Clock = UTC): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(local(value.getTime())).toISOString();
  }
  if (typeof value !== "string") return null;
  const m = NAIVE_DATETIME.exec(value.trim());
  if (!m) {
    const instant = new Date(value);
    return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
  }
  const wall = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
  // A stored digit string that does not survive the round trip is not a date: `2020-02-31` rolls over
  // to March, and the zero date `0000-00-00 00:00:00` lands in 1899 (Date.UTC reads year 0 as 1900).
  if (wall.toISOString().slice(0, 19) !== `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`)
    return null;
  return new Date(local(wall.getTime())).toISOString();
}

const EPOCH = "1970-01-01T00:00:00.000Z";

const trimTrailingSlashes = (url: string): string => url.replace(/\/+$/, "");

function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/** A PHP array of strings, however PHP numbered it: a list, or an object whose keys have gaps. */
function stringList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object"
      ? Object.values(value)
      : [];
  return items.filter((v): v is string => typeof v === "string");
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// ── Loading ──────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * The columns each table is read through. A table is only read when it has them: a missing table
 * (no Rank Math, a multisite sub-site's users) and a table that is a column-less stub (what the
 * fixture helper makes of an empty JSON file) both mean "no rows".
 */
const COLUMNS = {
  postmeta: ["meta_id", "post_id", "meta_key", "meta_value"],
  term_taxonomy: ["term_taxonomy_id", "term_id", "taxonomy", "description", "parent", "count"],
  terms: ["term_id", "name", "slug"],
  termmeta: ["meta_id", "term_id", "meta_key", "meta_value"],
  term_relationships: ["object_id", "term_taxonomy_id", "term_order"],
  users: ["ID", "user_nicename", "display_name"],
  rank_math_redirections: ["id", "sources", "url_to", "header_code", "status"],
} as const;

const readable = (db: WpDb, table: keyof typeof COLUMNS): Promise<boolean> =>
  tableExists(db, table, COLUMNS[table]);

/**
 * Loads the model. Reads only; the handle is not closed. Queries run one after another, in
 * `order by` order, so two loads of the same database give the same maps in the same order.
 */
export async function loadModel(db: WpDb, opts: LoadOptions = {}): Promise<WpModel> {
  const { report } = opts;
  const t = (name: string): string => db.table(name);

  // ── options ──
  const options = new Map<string, string>();
  for (const row of await db.query<Row>(
    `select option_name, option_value from ${t("options")} order by option_id`,
  )) {
    options.set(str(row.option_name), str(row.option_value));
  }
  const site = buildSite(options, report);
  const clock = siteClock(options, report);

  // ── posts (and the attachments every post may refer to) ──
  const explicitTypes = opts.postTypes ? new Set(opts.postTypes) : undefined;
  const explicitStatuses = opts.statuses ? new Set(opts.statuses) : undefined;
  const wantType = (type: string): boolean =>
    explicitTypes ? explicitTypes.has(type) : !DEFAULT_EXCLUDED_POST_TYPES.includes(type);
  const wantStatus = (status: string): boolean =>
    explicitStatuses ? explicitStatuses.has(status) : !DEFAULT_EXCLUDED_STATUSES.includes(status);

  const typeSql = explicitTypes
    ? explicitTypes.size > 0
      ? { sql: `post_type in (${marks(explicitTypes.size)})`, params: [...explicitTypes] }
      : { sql: "1 = 0", params: [] }
    : {
        sql: `post_type not in (${marks(DEFAULT_EXCLUDED_POST_TYPES.length)})`,
        params: [...DEFAULT_EXCLUDED_POST_TYPES],
      };
  const statusSql = explicitStatuses
    ? explicitStatuses.size > 0
      ? { sql: `post_status in (${marks(explicitStatuses.size)})`, params: [...explicitStatuses] }
      : { sql: "1 = 0", params: [] }
    : {
        sql: `post_status not in (${marks(DEFAULT_EXCLUDED_STATUSES.length)})`,
        params: [...DEFAULT_EXCLUDED_STATUSES],
      };
  const postRows = await db.query<Row>(
    `select ID as id, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status,
            post_password, post_name, post_modified, post_modified_gmt, post_parent, guid, menu_order, post_type,
            post_mime_type
       from ${t("posts")}
      where (${typeSql.sql} and ${statusSql.sql})
         or (post_type = 'attachment' and post_status not in (${marks(DEFAULT_EXCLUDED_STATUSES.length)}))
      order by ID`,
    [...typeSql.params, ...statusSql.params, ...DEFAULT_EXCLUDED_STATUSES],
  );

  const posts = new Map<number, WpPost>();
  const kindById = new Map<number, { type: string; status: string }>();
  const attachmentRows: Row[] = [];
  for (const row of postRows) {
    const id = num(row.id);
    const type = str(row.post_type);
    const status = str(row.post_status);
    kindById.set(id, { type, status });
    if (type === "attachment") attachmentRows.push(row);
    if (wantType(type) && wantStatus(status)) posts.set(id, toPost(row, report, clock, site));
  }
  const allIds = [...kindById.keys()];

  // ── post meta (and the three facts an attachment needs) ──
  const postMeta = new Map<number, Record<string, unknown[]>>();
  const attachmentFacts = new Map<number, { file?: unknown; metadata?: unknown; alt?: unknown }>();
  for (const part of (await readable(db, "postmeta")) ? chunked(allIds) : []) {
    const rows = await db.query<Row>(
      `select post_id, meta_key, meta_value from ${t("postmeta")} where post_id in (${marks(part.length)}) order by meta_id`,
      part,
    );
    for (const row of rows) {
      if (row.meta_key === null || row.meta_key === undefined) continue;
      const id = num(row.post_id);
      const key = str(row.meta_key);
      const kind = kindById.get(id) ?? { type: "", status: "" };
      const type = kind.type;
      const keep = posts.has(id) && (opts.metaKeys ? opts.metaKeys(key, type) : true);
      const attachmentFact = type === "attachment" && ATTACHMENT_META.has(key);
      if (!keep && !attachmentFact) continue;
      const value = unserialise(rawText(row.meta_value), report, {
        where: `post:${id}`,
        url: publicUrl(site, { id, ...kind }),
        data: { key },
      });
      if (keep) {
        let record = postMeta.get(id);
        if (!record) postMeta.set(id, (record = {}));
        append(record, key, value);
      }
      if (attachmentFact) {
        const facts = attachmentFacts.get(id) ?? {};
        attachmentFacts.set(id, facts);
        // WordPress's `get_post_meta( $id, $key, true )` answers with the first row.
        if (key === "_wp_attached_file" && !("file" in facts)) facts.file = value;
        else if (key === "_wp_attachment_metadata" && !("metadata" in facts))
          facts.metadata = value;
        else if (key === "_wp_attachment_image_alt" && !("alt" in facts)) facts.alt = value;
      }
    }
  }

  // ── attachments ──
  const attachments = new Map<number, WpAttachment>();
  for (const row of attachmentRows) {
    const id = num(row.id);
    const attachment = toAttachment(row, attachmentFacts.get(id) ?? {});
    attachments.set(id, attachment);
    if (ABSOLUTE_ADDRESS.test(attachment.file)) {
      report?.add({
        severity: "info",
        code: "wp.attachment-file-absolute",
        message:
          "The attachment's file is an address, not a path under the uploads folder (a media plugin keeps it elsewhere); it is kept as stored.",
        where: `post:${id}`,
        url: attachment.file,
        data: { file: attachment.file },
      });
    }
  }

  // ── terms ──
  const terms = new Map<number, WpTerm>();
  const taxonomyRows =
    (await readable(db, "term_taxonomy")) && (await readable(db, "terms"))
      ? await db.query<Row>(
          `select tt.term_taxonomy_id, tt.term_id, tt.taxonomy, tt.description, tt.parent, tt.count as term_count,
                  t.name, t.slug
             from ${t("term_taxonomy")} tt
            inner join ${t("terms")} t on t.term_id = tt.term_id
            order by tt.term_taxonomy_id`,
        )
      : [];
  const termOfTaxonomyRow = new Map<number, { termId: number; taxonomy: string }>();
  for (const row of taxonomyRows) {
    const termId = num(row.term_id);
    const taxonomy = str(row.taxonomy);
    termOfTaxonomyRow.set(num(row.term_taxonomy_id), { termId, taxonomy });
    const existing = terms.get(termId);
    if (existing) {
      report?.add({
        severity: "warn",
        code: "wp.term-shared",
        message: `Term ${termId} is used by two taxonomies (${existing.taxonomy}, ${taxonomy}); only the first is kept.`,
        where: `term:${termId}`,
        data: { kept: existing.taxonomy, dropped: taxonomy },
      });
      continue;
    }
    terms.set(termId, {
      termId,
      taxonomyId: num(row.term_taxonomy_id),
      taxonomy,
      slug: str(row.slug),
      name: str(row.name),
      description: str(row.description),
      parent: num(row.parent),
      count: num(row.term_count),
      meta: {},
    });
  }
  if (await readable(db, "termmeta")) {
    for (const row of await db.query<Row>(
      `select term_id, meta_key, meta_value from ${t("termmeta")} order by meta_id`,
    )) {
      const term = terms.get(num(row.term_id));
      if (!term || row.meta_key === null || row.meta_key === undefined) continue;
      // Last value wins (rows arrive in meta_id order).
      const key = str(row.meta_key);
      setOwn(
        term.meta,
        key,
        unserialise(rawText(row.meta_value), report, {
          where: `term:${term.termId}`,
          data: { key },
        }),
      );
    }
  }

  // ── which terms each post has (term ids, not term_taxonomy ids) ──
  const termsByPost = new Map<number, number[]>();
  for (const part of (await readable(db, "term_relationships")) ? chunked(allIds) : []) {
    for (const row of await db.query<Row>(
      `select object_id, term_taxonomy_id from ${t("term_relationships")}
        where object_id in (${marks(part.length)}) order by object_id, term_order, term_taxonomy_id`,
      part,
    )) {
      const hit = termOfTaxonomyRow.get(num(row.term_taxonomy_id));
      if (!hit) continue;
      const id = num(row.object_id);
      const list = termsByPost.get(id);
      if (!list) termsByPost.set(id, [hit.termId]);
      else if (!list.includes(hit.termId)) list.push(hit.termId);
    }
  }

  // ── users: the authors of what was loaded, and nobody else ──
  const authorIds = new Set<number>();
  for (const row of postRows) {
    const author = num(row.post_author);
    if (author > 0) authorIds.add(author);
  }
  const users = new Map<number, WpUser>();
  if (authorIds.size > 0) {
    // A multisite sub-site (`wp_2_`) has no users table of its own: the network shares `wp_users`.
    if (await readable(db, "users")) {
      for (const part of chunked([...authorIds].sort((a, b) => a - b))) {
        for (const row of await db.query<Row>(
          `select ID as id, user_nicename, display_name from ${t("users")} where ID in (${marks(part.length)}) order by ID`,
          part,
        )) {
          const id = num(row.id);
          users.set(id, { id, slug: str(row.user_nicename), displayName: str(row.display_name) });
        }
      }
    } else {
      report?.add({
        severity: "info",
        code: "wp.users-missing",
        message: `There is no ${t("users")} table (a multisite sub-site shares its network's), so post authors have no names.`,
        where: `table:${t("users")}`,
      });
    }
  }

  // ── the people the site shows: their profile fields, read beside the model (`wp/profiles.ts`) ──
  const profiles = await loadUserProfiles(db, users, report);

  // ── menus ──
  const menuItems = await loadMenuItems(db, termOfTaxonomyRow, report);

  // ── Rank Math redirects ──
  const redirects = await loadRedirects(db, report);

  // ── comments: the model has no place for them, so they are reported ──
  if (report) await reportComments(db, posts, site, report);

  const model: WpModel = {
    site,
    options,
    posts,
    postMeta,
    attachments,
    terms,
    termsByPost,
    users,
    menuItems,
    redirects,
  };
  setUserProfiles(model, profiles);
  return model;
}

// ── Pieces ───────────────────────────────────────────────────────────────────────────────────────

/** A meta or option value as text, keeping NULL as null (`meta_value` is nullable). */
function rawText(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

/** Adds `value` to the list kept under `key`, whatever the key is called. */
function append(record: Record<string, unknown[]>, key: string, value: unknown): void {
  if (Object.hasOwn(record, key)) record[key]!.push(value);
  else setOwn(record, key, [value]);
}

/** Assigns an own property, including the names (`__proto__`) plain assignment would swallow. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

/** `maybe_unserialize`, plus a report entry when a value that is serialized does not parse. */
function unserialise(
  raw: unknown,
  report: Report | undefined,
  context: { where: string; url?: string | undefined; data: Record<string, unknown> },
): unknown {
  const value = maybeUnserialize(raw);
  if (report && value === raw && isSerialized(raw)) {
    report.add({
      severity: "info",
      code: "wp.serialized-malformed",
      message:
        "A value that looks PHP-serialized does not parse (usually string lengths broken by a search and replace); it is kept as text.",
      where: context.where,
      ...(context.url === undefined ? {} : { url: context.url }),
      data: { ...context.data, sample: String(raw).slice(0, 80) },
    });
  }
  return value;
}

function buildSite(options: ReadonlyMap<string, string>, report: Report | undefined): WpSite {
  const opt = (name: string): string => options.get(name) ?? "";
  if (opt("siteurl") === "" && opt("home") === "") {
    report?.add({
      severity: "warn",
      code: "wp.option-missing",
      message:
        "The options table has neither a siteurl nor a home row; public URLs cannot be built.",
      where: "option:siteurl",
    });
  }
  const url = trimTrailingSlashes(opt("siteurl") || opt("home"));
  const plugins = maybeUnserialize(opt("active_plugins"));
  if (opt("active_plugins") !== "" && typeof plugins === "string") {
    report?.add({
      severity: "info",
      code: "wp.serialized-malformed",
      message: "The active_plugins option does not parse; no plugins are listed.",
      where: "option:active_plugins",
    });
  }
  return {
    url,
    home: trimTrailingSlashes(opt("home") || opt("siteurl")),
    name: opt("blogname"),
    description: opt("blogdescription"),
    permalinkStructure: opt("permalink_structure"),
    showOnFront: opt("show_on_front") === "page" ? "page" : "posts",
    pageOnFront: num(opt("page_on_front")),
    pageForPosts: num(opt("page_for_posts")),
    activePlugins: stringList(plugins),
    // The child theme's directory when there is one, else the theme itself.
    theme: opt("stylesheet") || opt("template"),
    // WPLANG is a locale (`de_DE`), empty for the default; `get_bloginfo('language')` is the same text with `-`.
    language: opt("WPLANG") ? opt("WPLANG").replace(/_/g, "-") : "en-US",
  };
}

function toPost(row: Row, report: Report | undefined, clock: Clock, site: WpSite): WpPost {
  const id = num(row.id);
  // post_date_gmt is the zero date on drafts that were never published. Their local date is the time
  // they were made, in the site's timezone, and it is turned into the instant it was exactly as
  // WordPress does it for a draft (`get_gmt_from_date`), so a draft's date agrees with its modified date.
  const date = isoUtc(row.post_date_gmt) ?? isoUtc(row.post_date, clock);
  const type = str(row.post_type);
  const status = str(row.post_status);
  if (date === null) {
    const url = publicUrl(site, { id, type, status });
    report?.add({
      severity: "warn",
      code: "wp.date-invalid",
      message: "The post has no valid date; 1970-01-01 stands in for it.",
      where: `post:${id}`,
      ...(url === undefined ? {} : { url }),
    });
  }
  const created = date ?? EPOCH;
  return {
    id,
    type,
    status,
    slug: str(row.post_name),
    title: str(row.post_title),
    content: str(row.post_content),
    excerpt: str(row.post_excerpt),
    date: created,
    modified: isoUtc(row.post_modified_gmt) ?? isoUtc(row.post_modified, clock) ?? created,
    parent: num(row.post_parent),
    menuOrder: num(row.menu_order),
    authorId: num(row.post_author),
    guid: str(row.guid),
    passwordProtected: str(row.post_password) !== "",
  };
}

/** A stated image dimension: a number, or the numeric string some plugins write; anything else is "not stated". */
function dimension(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * An attachment as {@link toAttachment} builds it: the contract's {@link WpAttachment}, plus the one
 * field WordPress's big-image handling needs. The contract has no place for it, so it travels as an
 * extra field; read it with {@link originalFileOf}. (A redirect's `ignoreCase` is carried the same way.)
 */
type AttachmentWithOriginal = WpAttachment & { originalFile?: string };

/**
 * The unscaled upload of an attachment, relative to uploads like `file`, or undefined. WordPress shrinks
 * an upload past 2,560 pixels to a `-scaled` copy and keeps the upload itself beside it, named only by
 * `original_image` in `_wp_attachment_metadata`; `file` and the sizes describe the scaled copy. It is
 * read here, from the attachment's own meta, so that it survives `postTypes` leaving attachments out of
 * `model.posts` and `metaKeys` leaving their meta out of `model.postMeta`. The name is joined to the
 * directory of `file` as `wp_get_original_image_path()` does, and so is a path under uploads or, where
 * `file` is an address (a media plugin), an address.
 */
export function originalFileOf(attachment: WpAttachment): string | undefined {
  return (attachment as AttachmentWithOriginal).originalFile;
}

/** `https://…`, `http://…` or `//host/…`: where a value that should be a path is an address. */
const ABSOLUTE_ADDRESS = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

function toAttachment(
  row: Row,
  facts: { file?: unknown; metadata?: unknown; alt?: unknown },
): AttachmentWithOriginal {
  const metadata = isRecord(facts.metadata) ? facts.metadata : {};
  const sizes: WpAttachment["sizes"] = [];
  if (metadata.sizes !== null && typeof metadata.sizes === "object") {
    for (const [name, size] of Object.entries(metadata.sizes)) {
      if (!isRecord(size)) continue;
      sizes.push({ name, file: str(size.file), width: num(size.width), height: num(size.height) });
    }
  }
  const attachment: AttachmentWithOriginal = {
    id: num(row.id),
    // As stored: the guid of an attachment is not always a file (50 of fineline's are `?attachment_id=N`
    // and 33 are page slugs) and not always on the site's host. It names the attachment; `file` is what
    // to download.
    url: str(row.guid),
    mime: str(row.post_mime_type),
    title: str(row.post_title),
    alt: str(facts.alt),
    caption: str(row.post_excerpt),
    file: str(facts.file) || str(metadata.file),
    sizes,
    parent: num(row.post_parent),
  };
  const width = dimension(metadata.width);
  const height = dimension(metadata.height);
  if (width !== undefined) attachment.width = width;
  if (height !== undefined) attachment.height = height;
  if (typeof metadata.original_image === "string" && metadata.original_image !== "") {
    const slash = attachment.file.lastIndexOf("/");
    attachment.originalFile = `${attachment.file.slice(0, slash + 1)}${metadata.original_image}`;
  }
  return attachment;
}

async function loadMenuItems(
  db: WpDb,
  termOfTaxonomyRow: ReadonlyMap<number, { termId: number; taxonomy: string }>,
  report: Report | undefined,
): Promise<WpMenuItem[]> {
  const t = (name: string): string => db.table(name);
  const itemRows = await db.query<Row>(
    `select ID as id, post_title, menu_order from ${t("posts")}
      where post_type = 'nav_menu_item' and post_status = 'publish' order by ID`,
  );
  const ids = itemRows.map((r) => num(r.id));
  const meta = new Map<number, Record<string, unknown>>();
  const menus = new Map<number, number[]>();
  const hasMeta = await readable(db, "postmeta");
  const hasRelationships = await readable(db, "term_relationships");
  for (const part of chunked(ids)) {
    for (const row of hasMeta
      ? await db.query<Row>(
          `select post_id, meta_key, meta_value from ${t("postmeta")} where post_id in (${marks(part.length)}) order by meta_id`,
          part,
        )
      : []) {
      const key = str(row.meta_key);
      if (!key.startsWith("_menu_item_")) continue;
      const id = num(row.post_id);
      const record = meta.get(id) ?? {};
      meta.set(id, record);
      if (!Object.hasOwn(record, key)) {
        setOwn(
          record,
          key,
          unserialise(rawText(row.meta_value), report, { where: `post:${id}`, data: { key } }),
        );
      }
    }
    for (const row of hasRelationships
      ? await db.query<Row>(
          `select object_id, term_taxonomy_id from ${t("term_relationships")}
            where object_id in (${marks(part.length)}) order by object_id, term_order, term_taxonomy_id`,
          part,
        )
      : []) {
      const hit = termOfTaxonomyRow.get(num(row.term_taxonomy_id));
      if (!hit || hit.taxonomy !== "nav_menu") continue;
      const id = num(row.object_id);
      const list = menus.get(id) ?? [];
      menus.set(id, list);
      if (!list.includes(hit.termId)) list.push(hit.termId);
    }
  }

  const items: WpMenuItem[] = [];
  for (const row of itemRows) {
    const id = num(row.id);
    const m = meta.get(id) ?? {};
    const classes = m._menu_item_classes;
    const classList = typeof classes === "string" ? [classes] : stringList(classes);
    const owners = menus.get(id) ?? [];
    if (owners.length === 0) {
      report?.add({
        severity: "info",
        code: "wp.menu-item-orphan",
        message: "A published menu item belongs to no menu and is not part of any navigation.",
        where: `post:${id}`,
        data: { title: str(row.post_title) },
      });
      continue;
    }
    for (const menuTermId of owners) {
      items.push({
        id,
        menuTermId,
        parent: num(m._menu_item_menu_item_parent),
        order: num(row.menu_order),
        title: str(row.post_title),
        kind: str(m._menu_item_type),
        objectId: num(m._menu_item_object_id),
        object: str(m._menu_item_object),
        url: str(m._menu_item_url),
        classes: classList.flatMap((c) => c.split(/\s+/)).filter((c) => c !== ""),
        target: str(m._menu_item_target),
      });
    }
  }
  return items.sort((a, b) => a.menuTermId - b.menuTermId || a.order - b.order || a.id - b.id);
}

async function loadRedirects(db: WpDb, report: Report | undefined): Promise<WpRedirect[]> {
  if (!(await readable(db, "rank_math_redirections"))) return [];
  const redirects: WpRedirect[] = [];
  for (const row of await db.query<Row>(
    `select id, sources, url_to, header_code, status from ${db.table("rank_math_redirections")} order by id`,
  )) {
    const id = num(row.id);
    const parsed = maybeUnserialize(rawText(row.sources));
    const sources = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed)
        ? Object.values(parsed)
        : undefined;
    if (!sources) {
      report?.add({
        severity: "warn",
        code: "wp.redirect-malformed",
        message: "A Rank Math redirect's sources do not parse; the redirect was not carried over.",
        where: `redirect:${id}`,
        data: { destination: str(row.url_to) },
      });
      continue;
    }
    for (const source of sources) {
      if (!isRecord(source) || typeof source.pattern !== "string") {
        report?.add({
          severity: "warn",
          code: "wp.redirect-malformed",
          message: "A source of a Rank Math redirect has no pattern; it was not carried over.",
          where: `redirect:${id}`,
          data: { destination: str(row.url_to) },
        });
        continue;
      }
      // No comparison stated means Rank Math's default, an exact match; only a stated mode we do not know is news.
      const stated = str(source.comparison) || "exact";
      const comparison = REDIRECT_COMPARISONS.has(stated)
        ? (stated as WpRedirect["comparison"])
        : "exact";
      if (!REDIRECT_COMPARISONS.has(stated)) {
        report?.add({
          severity: "warn",
          code: "wp.redirect-comparison-unknown",
          message: `A Rank Math redirect compares with ${JSON.stringify(stated)}, which is not a known mode; it is treated as an exact match.`,
          where: `redirect:${id}`,
          data: { pattern: source.pattern },
        });
      }
      const redirect: WpRedirect & { ignoreCase?: true } = {
        source: source.pattern,
        comparison,
        destination: str(row.url_to),
        status: num(row.header_code, 301),
        active: str(row.status) === "active",
      };
      // Rank Math's "ignore case" has no home in the contract; it is carried when set, as a bonus field.
      if (source.ignore === "case") redirect.ignoreCase = true;
      redirects.push(redirect);
    }
  }
  return redirects;
}

/**
 * The approved comments a visitor can read on the posts that were loaded, one report entry per post.
 * The model has no place for comments, and they are on the live pages (one of the two pilot sites has
 * 113 on 55 posts), so a migration that drops them says so. Only what a visitor sees counts: approved
 * comments, pingbacks, trackbacks and reviews; spam, trash and unmoderated ones, and the notes plugins
 * keep in this table under their own types (a donation plugin's `give_sub_note`), do not.
 */
async function reportComments(
  db: WpDb,
  posts: ReadonlyMap<number, WpPost>,
  site: WpSite,
  report: Report,
): Promise<void> {
  const columns = ["comment_post_ID", "comment_approved", "comment_type"];
  if (!(await tableExists(db, "comments", columns))) return;
  const rows = await db.query<Row>(
    `select comment_post_ID, count(*) as n from ${db.table("comments")}
      where comment_approved = '1' and comment_type in (${marks(COMMENT_TYPES.length)})
      group by comment_post_ID order by comment_post_ID`,
    [...COMMENT_TYPES],
  );
  for (const row of rows) {
    const id = num(row.comment_post_ID);
    const post = posts.get(id);
    const approved = num(row.n);
    if (!post || approved === 0) continue;
    const url = publicUrl(site, post);
    report.add({
      severity: "warn",
      code: "wp.comments-not-migrated",
      // The same words for every post: the report shows a group's first message above all its entries, so
      // a number in it would read as the group's. The count is in `data`.
      message: "The post has approved comments, and comments are not migrated.",
      where: `post:${id}`,
      ...(url === undefined ? {} : { url }),
      data: { approved },
    });
  }
}

// ── Lookups ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The address a post has on the source site, or undefined when a visitor cannot reach one: it is not
 * published, or its type is one WordPress, ACF or a plugin keeps for itself. It is WordPress's short
 * form, `<home>/?p=<id>`, which the site redirects (301) to the post's permalink, for a page, a post and
 * a custom post type alike. It is not built from the guid, which keeps the host a site had when the post
 * was made and writes its `&` as `&#038;`. It is an address to give a person for the report; the
 * permalink itself (and so the redirects a changed route needs) is not computed here.
 */
export function publicUrl(
  site: Pick<WpSite, "home">,
  post: Pick<WpPost, "id" | "type" | "status">,
): string | undefined {
  if (site.home === "" || post.status !== "publish") return undefined;
  if (INTERNAL_POST_TYPES.has(post.type) || post.type.startsWith("acf-")) return undefined;
  return `${site.home}/?p=${post.id}`;
}

/**
 * A stored string as text: its character references (`&amp;`, `&#039;`, `&hellip;`) become the
 * characters, and nothing else is touched (markup, whitespace, an `&` that starts no reference). The
 * references are read as the HTML a browser would show them as, so any named one resolves. Decode a
 * value once, where it is shown as text: decoding `&amp;amp;` twice shows `&`. See the header for which
 * of the model's strings WordPress stores encoded.
 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARACTER_REFERENCE, (reference) => {
    let decoded = decodedReferences.get(reference);
    if (decoded === undefined) {
      const [node] = fromHtml(reference, { fragment: true }).children;
      decoded = node?.type === "text" ? node.value : reference;
      decodedReferences.set(reference, decoded);
    }
    return decoded;
  });
}

/** `&name;`, `&#123;` and `&#x1F3A8;`: the semicolon is required, as it is of PHP's `html_entity_decode`. */
const CHARACTER_REFERENCE = /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g;
const decodedReferences = new Map<string, string>();

/** The loaded posts of one type, by id; `statuses` narrows them (absent: every loaded status). */
export function postsOfType(model: WpModel, type: string, statuses?: readonly string[]): WpPost[] {
  const out: WpPost[] = [];
  for (const post of model.posts.values()) {
    if (post.type === type && (statuses === undefined || statuses.includes(post.status)))
      out.push(post);
  }
  return out;
}

/** The terms a post is filed under, in WordPress's stored order; `taxonomy` narrows them. */
export function termsOf(model: WpModel, postId: number, taxonomy?: string): WpTerm[] {
  const out: WpTerm[] = [];
  for (const termId of model.termsByPost.get(postId) ?? []) {
    const term = model.terms.get(termId);
    if (term && (taxonomy === undefined || term.taxonomy === taxonomy)) out.push(term);
  }
  return out;
}

export function attachmentOf(model: WpModel, id: number): WpAttachment | undefined {
  return model.attachments.get(id);
}

/**
 * What a menu shows for an item, as stored. A WordPress menu item with an empty title displays its
 * target's: the page's title for a `post_type` item, the term's name for a `taxonomy` one. (`WpMenuItem.title`
 * stays the stored value, so the two can be told apart.) It is not decoded: a term's name is stored with
 * its entities (`Missions &amp; Evangelism`, as on three of anabaptistperspectives' menu items), so pass
 * what is shown as text through {@link decodeEntities}.
 */
export function menuItemTitle(model: WpModel, item: WpMenuItem): string {
  if (item.title !== "") return item.title;
  if (item.kind === "post_type") return model.posts.get(item.objectId)?.title ?? "";
  if (item.kind === "taxonomy") return model.terms.get(item.objectId)?.name ?? "";
  return "";
}
