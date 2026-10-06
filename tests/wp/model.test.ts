import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unserialize as psUnserialize } from "php-serialize";
import { createReport } from "../../src/report.ts";
import type { ReportEntry, WpDb, WpModel, WpPost, WpRedirect, WpSite } from "../../src/types.ts";
import { openDb } from "../../src/wp/db.ts";
import {
  attachmentOf,
  DEFAULT_EXCLUDED_POST_TYPES,
  decodeEntities,
  type LoadOptions,
  loadModel,
  menuItemTitle,
  originalFileOf,
  postsOfType,
  publicUrl,
  termsOf,
} from "../../src/wp/model.ts";
import { fixtureDb, readFixtureJson, readFixtureText } from "../helpers/fixture-db.ts";

// ── Independent expectations ─────────────────────────────────────────────────────────────────────
// What the model should say is worked out here from the committed JSON rows (which came out of the
// live MySQL databases, so their dates are already ISO strings and their zero dates already null)
// and, for PHP-serialised values, from the `php-serialize` package, never from the code under test.

interface PostJson {
  ID: number;
  post_author: number;
  post_date: string | null;
  post_date_gmt: string | null;
  post_content: string;
  post_title: string;
  post_excerpt: string;
  post_status: string;
  post_password: string;
  post_name: string;
  post_modified: string | null;
  post_modified_gmt: string | null;
  post_parent: number;
  guid: string;
  menu_order: number;
  post_type: string;
  post_mime_type: string;
}
interface MetaJson {
  meta_id: number;
  post_id: number;
  meta_key: string | null;
  meta_value: string | null;
}
interface TermMetaJson {
  meta_id: number;
  term_id: number;
  meta_key: string;
  meta_value: string | null;
}
interface TaxonomyJson {
  term_taxonomy_id: number;
  term_id: number;
  taxonomy: string;
  description: string;
  parent: number;
  count: number;
}
interface TermJson {
  term_id: number;
  name: string;
  slug: string;
}
interface RelationJson {
  object_id: number;
  term_taxonomy_id: number;
  term_order: number;
}
interface UserJson {
  ID: number;
  user_nicename: string;
  display_name: string;
}
interface OptionJson {
  option_id: number;
  option_name: string;
  option_value: string;
}
interface RedirectJson {
  id: number;
  sources: string;
  url_to: string;
  header_code: number;
  status: string;
}

const SERIALIZED_SHAPE = /^(?:N;|[bid]:[-+0-9.eE]+;|s:\d+:".*";|a:\d+:\{.*\}|O:\d+:".*\})$/s;

/** php-serialize hands objects back as incomplete-class instances; reshape them to wp2jx's convention. */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const name = rec.__PHP_Incomplete_Class_Name;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      if (key !== "__PHP_Incomplete_Class_Name") out[key] = plain(rec[key]);
    }
    if (typeof name === "string" && name !== "stdClass") out.__class = name;
    return out;
  }
  return v;
}

/** What WordPress would read from a stored meta/option value. */
function indep(value: string | null): unknown {
  if (value === null) return null;
  const trimmed = value.trim();
  return SERIALIZED_SHAPE.test(trimmed)
    ? plain(psUnserialize(trimmed, {}, { strict: false }))
    : value;
}

const dir = (site: string) => ({
  rows: <T>(table: string): T[] => readFixtureJson<T[]>(site, `rows/${table}.json`),
});

interface Expected {
  prefix: string;
  site: Record<string, unknown>;
  posts: PostJson[];
  meta: MetaJson[];
  options: OptionJson[];
}

function load(site: string, prefix: string, siteExpectations: Record<string, unknown>): Expected {
  const { rows } = dir(site);
  return {
    prefix,
    site: siteExpectations,
    posts: rows<PostJson>("posts"),
    meta: rows<MetaJson>("postmeta").sort((a, b) => a.meta_id - b.meta_id),
    options: rows<OptionJson>("options"),
  };
}

const FIXTURES = {
  fineline: load("fineline", "KjLnF_", {
    url: "https://finelinepainting.pro",
    home: "https://finelinepainting.pro",
    permalinkStructure: "/%postname%/",
    showOnFront: "page",
    pageOnFront: 5246,
    pageForPosts: 2588,
    theme: "cwicly",
    language: "en-US",
  }),
  ap: load("ap", "wp_", {
    url: "https://anabaptistperspectives.org",
    home: "https://anabaptistperspectives.org",
    permalinkStructure: "/essays/%postname%/",
    showOnFront: "page",
    pageOnFront: 819,
    pageForPosts: 830,
    theme: "cwicly",
    language: "en-US",
  }),
} as const;
type SiteKey = keyof typeof FIXTURES;

const models = {} as Record<SiteKey, WpModel>;
const databases = {} as Record<SiteKey, WpDb>;
const reports = {} as Record<SiteKey, readonly ReportEntry[]>;
for (const key of Object.keys(FIXTURES) as SiteKey[]) {
  const { url } = await fixtureDb(key);
  databases[key] = await openDb(url);
  const report = createReport();
  models[key] = await loadModel(databases[key], { report });
  reports[key] = report.entries();
}
afterAll(async () => {
  await Promise.all(Object.values(databases).map((db) => db.close()));
});

const first = <T>(list: T[]): T => {
  if (list[0] === undefined) throw new Error("empty list");
  return list[0];
};

/**
 * US Eastern wall-clock time (as ISO digits, the way the fixture rows hold a local date) as the UTC
 * instant it was, by the statutory rule: daylight time runs from the second Sunday of March at 02:00
 * to the first Sunday of November at 02:00. Both fixture sites are `America/New_York`, and every date
 * in them is after 2007, when that rule began. Worked out by hand, without Intl, so that it does not
 * share a bug with the code under test.
 */
function easternToUtc(wallIso: string): string {
  const wall = Date.parse(wallIso);
  const year = new Date(wall).getUTCFullYear();
  const sunday = (month: number, nth: number): number => {
    const first = new Date(Date.UTC(year, month, 1));
    const toSunday = (7 - first.getUTCDay()) % 7;
    return Date.UTC(year, month, 1 + toSunday + (nth - 1) * 7, 2);
  };
  const HOUR = 3_600_000;
  // The hour after 02:00 in March does not exist on the wall clock, so it is read with the offset before.
  const daylight = wall >= sunday(2, 2) + HOUR && wall < sunday(10, 1);
  return new Date(wall + (daylight ? 4 : 5) * HOUR).toISOString();
}

// ── The two fixture sites ────────────────────────────────────────────────────────────────────────

describe.each(Object.keys(FIXTURES) as SiteKey[])("%s", (key) => {
  const fx = FIXTURES[key];
  const model = models[key];
  const { rows } = dir(key);

  test("opens under the right prefix and loads with nothing reported but what the data really has", () => {
    expect(databases[key].prefix).toBe(fx.prefix);
    // fineline is clean. Two of ap's attachments are not in the uploads folder at all: a media plugin
    // stored the address of a copy on its own host where WordPress keeps a path relative to uploads.
    expect(reports[key].map((e) => [e.code, e.severity, e.where])).toEqual(
      key === "ap"
        ? [
            ["wp.attachment-file-absolute", "info", "post:8832"],
            ["wp.attachment-file-absolute", "info", "post:14607"],
          ]
        : [],
    );
  });

  describe("site", () => {
    test("the fields the options table states", () => {
      const opt = (name: string) => fx.options.find((o) => o.option_name === name)!.option_value;
      expect(model.site).toEqual({
        ...fx.site,
        name: opt("blogname"),
        description: opt("blogdescription"),
        activePlugins: expect.any(Array),
      } as unknown as WpSite);
      expect(model.site.url).toBe(opt("siteurl"));
      expect(model.site.name.length).toBeGreaterThan(0);
    });

    test("active plugins are the unserialised option", () => {
      const raw = fx.options.find((o) => o.option_name === "active_plugins")!.option_value;
      expect(model.site.activePlugins).toEqual(
        psUnserialize(raw, {}, { strict: false }) as string[],
      );
      expect(model.site.activePlugins).toContain("cwicly/cwicly.php");
      expect(model.site.activePlugins.every((p) => typeof p === "string")).toBe(true);
    });

    test("the urls have no trailing slash", () => {
      expect(model.site.url.endsWith("/")).toBe(false);
      expect(model.site.home.endsWith("/")).toBe(false);
    });
  });

  describe("options", () => {
    test("every row, as the raw string", () => {
      expect(model.options.size).toBe(fx.options.length);
      for (const row of fx.options)
        expect(model.options.get(row.option_name), row.option_name).toBe(row.option_value);
      // Cwicly's options stay JSON text; nothing is parsed.
      expect(typeof model.options.get("cwicly_global_classes")).toBe("string");
      expect(typeof model.options.get("active_plugins")).toBe("string");
    });

    test("in option_id order", () => {
      const ids = fx.options.sort((a, b) => a.option_id - b.option_id).map((o) => o.option_name);
      expect([...model.options.keys()]).toEqual(ids);
    });
  });

  describe("posts", () => {
    test("every post of every type, none of them excluded by default", () => {
      expect(DEFAULT_EXCLUDED_POST_TYPES).toEqual([
        "revision",
        "auto-draft",
        "customize_changeset",
        "oembed_cache",
        "scheduled-action",
        "user_request",
      ]);
      // The fixtures were cut without trash, auto-drafts or bookkeeping types, so all rows are loaded.
      expect(fx.posts.every((p) => !DEFAULT_EXCLUDED_POST_TYPES.includes(p.post_type))).toBe(true);
      expect(
        fx.posts.every((p) => p.post_status !== "trash" && p.post_status !== "auto-draft"),
      ).toBe(true);
      expect(model.posts.size).toBe(fx.posts.length);
      expect([...model.posts.keys()]).toEqual(fx.posts.map((p) => p.ID).sort((a, b) => a - b));
    });

    test("each field of each post", () => {
      for (const row of fx.posts) {
        const expected: WpPost = {
          id: row.ID,
          type: row.post_type,
          status: row.post_status,
          slug: row.post_name,
          title: row.post_title,
          content: row.post_content,
          excerpt: row.post_excerpt,
          // A draft that was never published has the zero GMT date: its local date is converted
          // with the site's timezone, which WordPress itself does (get_gmt_from_date).
          date: row.post_date_gmt ?? easternToUtc(row.post_date!),
          modified: row.post_modified_gmt ?? easternToUtc(row.post_modified!),
          parent: row.post_parent,
          menuOrder: row.menu_order,
          authorId: row.post_author,
          guid: row.guid,
          passwordProtected: row.post_password !== "",
        };
        expect(model.posts.get(row.ID), `post ${row.ID}`).toEqual(expected);
      }
    });

    test("dates are ISO 8601 UTC, and the zero GMT date of a draft is its local date in the site's timezone", () => {
      const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
      let zeroGmt = 0;
      for (const row of fx.posts) {
        const post = model.posts.get(row.ID)!;
        expect(post.date).toMatch(ISO);
        expect(post.modified).toMatch(ISO);
        if (row.post_date_gmt === null) {
          zeroGmt++;
          expect(post.date, `post ${row.ID}`).toBe(easternToUtc(row.post_date!));
          // New York is four or five hours behind UTC, so the instant is later than its digits say.
          expect(Date.parse(post.date) - Date.parse(row.post_date!)).toBeGreaterThanOrEqual(
            4 * 3_600_000,
          );
        }
      }
      // Both sites have drafts that were never published.
      expect(zeroGmt).toBeGreaterThan(5);
    });

    test("a draft created and last modified in the same instant has the same date for both, as the real GMT column says", () => {
      // Real rows: a draft's post_date and post_modified are both the local time it was created at, and
      // WordPress wrote the GMT of the modification (but left post_date_gmt at zero). So the date of
      // creation must come out equal to that GMT. (Digits read as UTC would put it four or five hours earlier.)
      const sameInstant = fx.posts.filter(
        (p) =>
          p.post_date_gmt === null &&
          p.post_modified_gmt !== null &&
          p.post_date === p.post_modified,
      );
      expect(sameInstant.length).toBeGreaterThanOrEqual(key === "fineline" ? 7 : 5);
      for (const row of sameInstant) {
        const post = model.posts.get(row.ID)!;
        expect(post.date, `post ${row.ID}`).toBe(row.post_modified_gmt!);
        expect(post.modified, `post ${row.ID}`).toBe(row.post_modified_gmt!);
      }
    });

    test("a post with no GMT date at all is converted on both columns", () => {
      // fineline 6541 and ap 15745 have both GMT columns at zero. Both dates are in daylight time.
      const row = fx.posts.find((p) => p.post_date_gmt === null && p.post_modified_gmt === null)!;
      expect(row.ID).toBe(key === "fineline" ? 6541 : 15745);
      const post = model.posts.get(row.ID)!;
      const expected = key === "fineline" ? "2026-07-21T13:47:22.000Z" : "2026-06-04T20:26:27.000Z";
      expect([post.date, post.modified]).toEqual([expected, expected]);
    });

    test("posts come back ordered by id", () => {
      const ids = [...model.posts.keys()];
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    });

    test("no password is ever exposed, only whether there is one", () => {
      for (const post of model.posts.values()) {
        expect(Object.keys(post).sort()).toEqual([
          "authorId",
          "content",
          "date",
          "excerpt",
          "guid",
          "id",
          "menuOrder",
          "modified",
          "parent",
          "passwordProtected",
          "slug",
          "status",
          "title",
          "type",
        ]);
      }
      const protectedIds = fx.posts
        .filter((p) => p.post_password !== "")
        .map((p) => p.ID)
        .sort((a, b) => a - b);
      expect([...model.posts.values()].filter((p) => p.passwordProtected).map((p) => p.id)).toEqual(
        protectedIds,
      );
    });
  });

  describe("postsOfType", () => {
    test("filters by type, and by status when asked", () => {
      for (const type of new Set(fx.posts.map((p) => p.post_type))) {
        const all = fx.posts.filter((p) => p.post_type === type);
        expect(postsOfType(model, type).map((p) => p.id)).toEqual(all.map((p) => p.ID));
        const published = all.filter((p) => p.post_status === "publish");
        expect(
          postsOfType(model, type, ["publish"]).map((p) => p.id),
          type,
        ).toEqual(published.map((p) => p.ID));
      }
      expect(postsOfType(model, "no-such-type")).toEqual([]);
      expect(postsOfType(model, "page", [])).toEqual([]);
    });

    test("several statuses at once", () => {
      const wanted = ["publish", "private"];
      const expected = fx.posts
        .filter((p) => p.post_type === "page" && wanted.includes(p.post_status))
        .map((p) => p.ID);
      expect(postsOfType(model, "page", wanted).map((p) => p.id)).toEqual(expected);
    });
  });

  describe("attachments", () => {
    const metaBy = new Map<string, string[]>();
    for (const m of fx.meta) {
      if (m.meta_key === null || m.meta_value === null) continue;
      const k = `${m.post_id}\0${m.meta_key}`;
      metaBy.set(k, [...(metaBy.get(k) ?? []), m.meta_value]);
    }
    const attachmentRows = fx.posts.filter((p) => p.post_type === "attachment");

    test("one per attachment row, in id order", () => {
      expect(model.attachments.size).toBe(attachmentRows.length);
      expect([...model.attachments.keys()]).toEqual(
        attachmentRows.map((p) => p.ID).sort((a, b) => a - b),
      );
    });

    test("url, mime, title, caption, file, alt, size list and dimensions", () => {
      let withSizes = 0;
      let withDimensions = 0;
      let withOriginal = 0;
      for (const row of attachmentRows) {
        const file = metaBy.get(`${row.ID}\0_wp_attached_file`)?.[0] ?? "";
        const alt = metaBy.get(`${row.ID}\0_wp_attachment_image_alt`)?.[0] ?? "";
        const rawMeta = metaBy.get(`${row.ID}\0_wp_attachment_metadata`)?.[0];
        const md = rawMeta
          ? (plain(psUnserialize(rawMeta, {}, { strict: false })) as Record<string, any>)
          : {};
        // A few plugins (SVG support) store a size's dimensions as "150" or as false; the contract wants numbers.
        const sizes = Object.entries((md.sizes ?? {}) as Record<string, any>).map(([name, s]) => ({
          name,
          file: s.file,
          width: Number(s.width) || 0,
          height: Number(s.height) || 0,
        }));
        // WordPress's wp_get_original_image_path(): `original_image` is a name beside the (scaled) file.
        const original =
          typeof md.original_image === "string" && md.original_image !== ""
            ? `${file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : ""}${md.original_image}`
            : undefined;
        if (original !== undefined) withOriginal++;
        const expected = {
          id: row.ID,
          url: row.guid,
          mime: row.post_mime_type,
          title: row.post_title,
          alt,
          caption: row.post_excerpt,
          file,
          ...(typeof md.width === "number" ? { width: md.width } : {}),
          ...(typeof md.height === "number" ? { height: md.height } : {}),
          sizes,
          parent: row.post_parent,
          ...(original === undefined ? {} : { originalFile: original }),
        };
        const got = model.attachments.get(row.ID)!;
        expect(got, `attachment ${row.ID}`).toEqual(expected);
        // Optional properties are absent, not undefined.
        expect("width" in got).toBe(typeof md.width === "number");
        expect("height" in got).toBe(typeof md.height === "number");
        if (sizes.length > 0) withSizes++;
        if (got.width !== undefined) withDimensions++;
      }
      expect(withSizes).toBeGreaterThan(100);
      expect(withDimensions).toBeGreaterThan(100);
      expect(withOriginal).toBe(key === "fineline" ? 114 : 105);
    });

    test("the unscaled upload WordPress keeps beside a -scaled copy is named, relative to uploads like file", () => {
      // Past 2,560 pixels WordPress keeps only a `-scaled` copy as `file`; the upload itself is named
      // by `original_image` in the metadata, and is what to download (the design: the largest original).
      const withOriginal = [...model.attachments.values()].filter(
        (a) => originalFileOf(a) !== undefined,
      );
      expect(withOriginal).toHaveLength(key === "fineline" ? 114 : 105);
      const scaled = withOriginal.filter((a) => /-scaled(?:-e\d+)?\.[^./]+$/.test(a.file));
      expect(scaled).toHaveLength(key === "fineline" ? 114 : 105);
      const strip = (file: string): string => file.replace(/-scaled(?:-e\d+)?(\.[^./]+)$/, "$1");
      for (const a of scaled) expect(a.width, `attachment ${a.id}`).toBeGreaterThan(1000);
      // Almost always the same name with the suffix WordPress added (and the editor's `-e<timestamp>`)
      // left off. Not always, which is why the name is read and not derived: on fineline 1871 the
      // `_wp_attached_file` is `…-pa-scaled.jpeg` while the metadata, its sizes and `original_image` all
      // say `…-pa-1…`, a number WordPress added to the upload's name that `file` never got.
      const apart = scaled.filter((a) => originalFileOf(a) !== strip(a.file));
      expect(apart.map((a) => a.id)).toEqual(key === "fineline" ? [1871] : []);
      if (key === "fineline") {
        expect(originalFileOf(model.attachments.get(1871)!)).toBe(
          "professional-shutter-painting-services-in-lancaster-pa-1.jpeg",
        );
      }
      // One that was never scaled has no such name.
      const plain = [...model.attachments.values()].find((a) => originalFileOf(a) === undefined)!;
      expect("originalFile" in plain).toBe(false);
    });

    test("it is still named when postTypes keeps attachments out of model.posts, and when metaKeys keeps their meta out", async () => {
      const all = [...model.attachments.values()].filter((a) => originalFileOf(a) !== undefined);
      expect(all.length).toBeGreaterThan(100);
      for (const opts of [
        { postTypes: ["page"] },
        { metaKeys: () => false },
      ] satisfies LoadOptions[]) {
        const narrowed = await loadModel(databases[key], opts);
        expect(
          [...narrowed.attachments.values()].filter((a) => originalFileOf(a) !== undefined),
        ).toEqual(all);
        // The attachment itself is untouched: file, sizes and all, in full.
        expect([...narrowed.attachments]).toEqual([...model.attachments]);
      }
    });

    test("attachmentOf looks one up, and answers undefined for a post that is not one", () => {
      const row = first(attachmentRows);
      expect(attachmentOf(model, row.ID)).toBe(model.attachments.get(row.ID));
      expect(attachmentOf(model, row.ID)?.url).toBe(row.guid);
      const page = first(fx.posts.filter((p) => p.post_type === "page"));
      expect(attachmentOf(model, page.ID)).toBeUndefined();
      expect(attachmentOf(model, -1)).toBeUndefined();
    });

    test("an attachment's files are as WordPress names them: the original, then -WxH derivatives", () => {
      const img = first(
        [...model.attachments.values()].filter((a) => a.sizes.length > 0 && a.file !== ""),
      );
      const dirOfFile = img.file.includes("/")
        ? img.file.slice(0, img.file.lastIndexOf("/") + 1)
        : "";
      expect(img.file.slice(dirOfFile.length)).not.toContain("/");
      for (const size of img.sizes) {
        expect(size.file).not.toContain("/");
        expect(size.width).toBeGreaterThan(0);
        expect(size.height).toBeGreaterThan(0);
        expect(size.name).not.toBe("");
      }
    });
  });

  describe("post meta", () => {
    test("every row of every loaded post, grouped by key, in meta_id order, unserialised", () => {
      const expected = new Map<number, Record<string, unknown[]>>();
      let rowsWithKey = 0;
      for (const m of fx.meta) {
        if (m.meta_key === null) continue;
        rowsWithKey++;
        const rec = expected.get(m.post_id) ?? {};
        expected.set(m.post_id, rec);
        (rec[m.meta_key] ??= []).push(indep(m.meta_value));
      }
      expect(model.postMeta.size).toBe(expected.size);
      let values = 0;
      for (const [id, rec] of expected) {
        const got = model.postMeta.get(id);
        expect(got, `post ${id}`).toEqual(rec);
        // Keys appear in the order they were first stored.
        expect(Object.keys(got!), `post ${id} key order`).toEqual(Object.keys(rec));
        values += Object.values(got!).reduce((n, list) => n + list.length, 0);
      }
      expect(values).toBe(rowsWithKey);
    });

    test("repeated keys keep every value, in order", () => {
      const counts = new Map<string, number>();
      for (const m of fx.meta)
        counts.set(
          `${m.post_id}\0${m.meta_key}`,
          (counts.get(`${m.post_id}\0${m.meta_key}`) ?? 0) + 1,
        );
      const repeated = [...counts].filter(([, n]) => n > 1);
      expect(repeated.length).toBeGreaterThan(0);
      for (const [composite, n] of repeated.slice(0, 50)) {
        const [id, k] = composite.split("\0");
        expect(model.postMeta.get(Number(id))?.[k!], composite).toHaveLength(n);
      }
    });

    test("PHP-serialised values arrive unserialised, plain ones as the stored text", () => {
      const menu = fx.meta.find((m) => m.meta_key === "_menu_item_classes")!;
      const classes = model.postMeta.get(menu.post_id)!._menu_item_classes![0];
      expect(Array.isArray(classes)).toBe(true);
      expect(classes).toContain("menu-item");
      const attachment = fx.meta.find((m) => m.meta_key === "_wp_attachment_metadata")!;
      const metadata = model.postMeta.get(attachment.post_id)!
        ._wp_attachment_metadata![0] as Record<string, unknown>;
      expect(typeof metadata.file).toBe("string");
      const plainRow = fx.meta.find((m) => m.meta_key === "_wp_attached_file")!;
      expect(model.postMeta.get(plainRow.post_id)!._wp_attached_file![0]).toBe(plainRow.meta_value);
    });

    test("meta keys that exist only on posts that were not loaded are not in the map", () => {
      const loaded = new Set(model.posts.keys());
      for (const id of model.postMeta.keys()) expect(loaded.has(id), `post ${id}`).toBe(true);
    });
  });

  describe("terms", () => {
    const taxonomies = rows<TaxonomyJson>("term_taxonomy");
    const termRows = new Map(rows<TermJson>("terms").map((t) => [t.term_id, t]));
    const termMeta = rows<TermMetaJson>("termmeta").sort((a, b) => a.meta_id - b.meta_id);

    test("one term per term_taxonomy row, joined to its name and slug", () => {
      expect(model.terms.size).toBe(taxonomies.length);
      for (const tt of taxonomies) {
        const term = model.terms.get(tt.term_id)!;
        const base = termRows.get(tt.term_id)!;
        expect(term, `term ${tt.term_id}`).toMatchObject({
          termId: tt.term_id,
          taxonomyId: tt.term_taxonomy_id,
          taxonomy: tt.taxonomy,
          slug: base.slug,
          name: base.name,
          description: tt.description,
          parent: tt.parent,
          count: tt.count,
        });
      }
    });

    test("term meta keeps the last value, unserialised", () => {
      const last = new Map<string, string | null>();
      for (const m of termMeta) last.set(`${m.term_id}\0${m.meta_key}`, m.meta_value);
      expect(last.size).toBeGreaterThan(0);
      const byTerm = new Map<number, Record<string, unknown>>();
      for (const [composite, value] of last) {
        const [id, k] = composite.split("\0");
        const rec = byTerm.get(Number(id)) ?? {};
        byTerm.set(Number(id), rec);
        rec[k!] = indep(value);
      }
      for (const [id, rec] of byTerm) expect(model.terms.get(id)!.meta, `term ${id}`).toEqual(rec);
      // Terms without any meta have an empty object.
      for (const term of model.terms.values())
        if (!byTerm.has(term.termId)) expect(term.meta).toEqual({});
    });

    test("termsByPost lists term ids, not term_taxonomy ids", () => {
      // In these two databases the two id spaces happen to coincide row for row, so this cannot tell
      // them apart; the synthetic "terms" tests below, whose ids differ, do.
      const ttToTerm = new Map(taxonomies.map((t) => [t.term_taxonomy_id, t.term_id]));
      const expected = new Map<number, number[]>();
      const relations = rows<RelationJson>("term_relationships").sort(
        (a, b) =>
          a.object_id - b.object_id ||
          a.term_order - b.term_order ||
          a.term_taxonomy_id - b.term_taxonomy_id,
      );
      for (const rel of relations) {
        const term = ttToTerm.get(rel.term_taxonomy_id);
        if (term === undefined) continue;
        expected.set(rel.object_id, [...(expected.get(rel.object_id) ?? []), term]);
      }
      expect(model.termsByPost.size).toBe(expected.size);
      for (const [post, terms] of expected)
        expect(model.termsByPost.get(post), `post ${post}`).toEqual(terms);
      for (const terms of model.termsByPost.values())
        for (const id of terms) expect(model.terms.has(id)).toBe(true);
    });

    test("termsOf returns the terms of a post, narrowed by taxonomy", () => {
      const [postId, termIds] = first([...model.termsByPost].filter(([, ids]) => ids.length >= 2));
      const all = termsOf(model, postId);
      expect(all.map((t) => t.termId)).toEqual([...termIds]);
      for (const taxonomy of new Set(all.map((t) => t.taxonomy))) {
        const subset = termsOf(model, postId, taxonomy);
        expect(subset.every((t) => t.taxonomy === taxonomy)).toBe(true);
        expect(subset.map((t) => t.termId)).toEqual(
          all.filter((t) => t.taxonomy === taxonomy).map((t) => t.termId),
        );
      }
      expect(termsOf(model, postId, "no-such-taxonomy")).toEqual([]);
      expect(termsOf(model, -1)).toEqual([]);
    });
  });

  describe("users", () => {
    test("the authors of the loaded posts, as slug and display name", () => {
      const authors = new Set(fx.posts.map((p) => p.post_author).filter((a) => a > 0));
      const userRows = rows<UserJson>("users").filter((u) => authors.has(u.ID));
      expect(model.users.size).toBe(userRows.length);
      expect(userRows.length).toBeGreaterThan(5);
      for (const u of userRows) {
        expect(model.users.get(u.ID), `user ${u.ID}`).toEqual({
          id: u.ID,
          slug: u.user_nicename,
          displayName: u.display_name,
        });
      }
    });

    test("nothing but id, slug and display name leaves the users table", () => {
      for (const user of model.users.values())
        expect(Object.keys(user).sort()).toEqual(["displayName", "id", "slug"]);
    });
  });

  describe("menu items", () => {
    const taxonomies = rows<TaxonomyJson>("term_taxonomy");
    const relations = rows<RelationJson>("term_relationships");
    const metaBy = new Map<number, Record<string, string[]>>();
    for (const m of fx.meta) {
      if (m.meta_key === null || m.meta_value === null) continue;
      const rec = metaBy.get(m.post_id) ?? {};
      metaBy.set(m.post_id, rec);
      (rec[m.meta_key] ??= []).push(m.meta_value);
    }
    const menuTerm = new Map(
      taxonomies
        .filter((t) => t.taxonomy === "nav_menu")
        .map((t) => [t.term_taxonomy_id, t.term_id]),
    );

    const expected = fx.posts
      .filter((p) => p.post_type === "nav_menu_item" && p.post_status === "publish")
      .flatMap((p) => {
        const m = metaBy.get(p.ID) ?? {};
        const classes = psUnserialize(
          m._menu_item_classes?.[0] ?? "a:0:{}",
          {},
          { strict: false },
        ) as string[];
        return relations
          .filter((r) => r.object_id === p.ID && menuTerm.has(r.term_taxonomy_id))
          .map((r) => ({
            id: p.ID,
            menuTermId: menuTerm.get(r.term_taxonomy_id)!,
            parent: Number(m._menu_item_menu_item_parent?.[0] ?? 0),
            order: p.menu_order,
            title: p.post_title,
            kind: m._menu_item_type?.[0] ?? "",
            objectId: Number(m._menu_item_object_id?.[0] ?? 0),
            object: m._menu_item_object?.[0] ?? "",
            url: m._menu_item_url?.[0] ?? "",
            classes: Object.values(classes).filter((c) => c !== ""),
            target: m._menu_item_target?.[0] ?? "",
          }));
      })
      .sort((a, b) => a.menuTermId - b.menuTermId || a.order - b.order || a.id - b.id);

    test("every published item, joined to its menu, in menu then order sequence", () => {
      expect(expected.length).toBeGreaterThan(20);
      expect(model.menuItems).toEqual(expected);
    });

    test("is ordered by menuTermId, then order", () => {
      for (let i = 1; i < model.menuItems.length; i++) {
        const a = model.menuItems[i - 1]!;
        const b = model.menuItems[i]!;
        expect(
          a.menuTermId < b.menuTermId || (a.menuTermId === b.menuTermId && a.order <= b.order),
        ).toBe(true);
      }
    });

    test("every parent is another item of the same menu, and every target is in the model", () => {
      const menuOf = new Map(model.menuItems.map((i) => [i.id, i.menuTermId]));
      for (const item of model.menuItems) {
        if (item.parent !== 0)
          expect(menuOf.get(item.parent), `item ${item.id}`).toBe(item.menuTermId);
        if (item.kind === "post_type")
          expect(model.posts.has(item.objectId), `item ${item.id}`).toBe(true);
        if (item.kind === "taxonomy")
          expect(model.terms.has(item.objectId), `item ${item.id}`).toBe(true);
      }
      expect(model.menuItems.some((i) => i.parent !== 0)).toBe(true);
    });

    test("menuTermId is a term id of a nav_menu term", () => {
      for (const item of model.menuItems)
        expect(model.terms.get(item.menuTermId)?.taxonomy).toBe("nav_menu");
    });

    test("the stored title is kept, and menuItemTitle fills an empty one from the target", () => {
      const empty = model.menuItems.filter((i) => i.title === "");
      expect(empty.length).toBeGreaterThan(0);
      for (const item of empty) {
        const shown = menuItemTitle(model, item);
        if (item.kind === "post_type")
          expect(shown).toBe(model.posts.get(item.objectId)?.title ?? "");
        if (item.kind === "taxonomy")
          expect(shown).toBe(model.terms.get(item.objectId)?.name ?? "");
      }
      const resolved = empty.filter((i) => menuItemTitle(model, i) !== "");
      expect(resolved.length).toBeGreaterThan(0);
      const titled = first(model.menuItems.filter((i) => i.title !== ""));
      expect(menuItemTitle(model, titled)).toBe(titled.title);
    });

    test("classes are the stored list without its empty strings", () => {
      for (const item of model.menuItems) expect(item.classes.every((c) => c !== "")).toBe(true);
      expect(model.menuItems.some((i) => i.classes.includes("menu-item"))).toBe(true);
    });
  });

  describe("redirects", () => {
    const rowsJson = rows<RedirectJson>("rank_math_redirections").sort((a, b) => a.id - b.id);
    const expected = rowsJson.flatMap((r) =>
      (
        psUnserialize(r.sources, {}, { strict: false }) as {
          pattern: string;
          comparison?: string;
          ignore?: string;
        }[]
      ).map((s) => ({
        source: s.pattern,
        comparison: (s.comparison ?? "exact") as WpRedirect["comparison"],
        destination: r.url_to,
        status: r.header_code,
        active: r.status === "active",
        ...(s.ignore === "case" ? { ignoreCase: true } : {}),
      })),
    );

    test("one per source of every Rank Math redirect (a row can carry several)", () => {
      expect(rowsJson.length).toBe(key === "fineline" ? 57 : 391);
      // The brief counts rows; the contract says one redirect per source, and some rows have two or three.
      expect(expected.length).toBe(key === "fineline" ? 67 : 400);
      expect(model.redirects).toHaveLength(expected.length);
      expect(model.redirects).toEqual(expected);
    });

    test("active means status 'active'; trashed ones are kept but inactive", () => {
      const trashed = rowsJson.filter((r) => r.status !== "active");
      expect(trashed.length).toBeGreaterThan(0);
      expect(model.redirects.filter((r) => !r.active).length).toBe(
        expected.filter((r) => !r.active).length,
      );
      expect(model.redirects.filter((r) => r.active).length).toBeLessThan(model.redirects.length);
    });

    test("comparison is one of the five Rank Math modes", () => {
      for (const r of model.redirects)
        expect(["exact", "contains", "start", "end", "regex"]).toContain(r.comparison);
    });
  });

  test("a second load gives an identical model", async () => {
    const again = await loadModel(databases[key]);
    expect([...again.posts]).toEqual([...model.posts]);
    expect(again.site).toEqual(model.site);
    expect(again.menuItems).toEqual(model.menuItems);
    expect([...again.termsByPost]).toEqual([...model.termsByPost]);
  });
});

// ── The numbers the brief states, derived again from the SQLite file itself ──────────────────────

describe("the brief's numbers, from independent SQL", () => {
  async function sqlite(site: SiteKey) {
    const { path, prefix } = await fixtureDb(site);
    const db = new Database(path, { readonly: true });
    const n = (sql: string, ...params: string[]) =>
      (db.query(sql).get(...params) as { n: number }).n;
    return { db, prefix, n };
  }

  test("finelinepainting", async () => {
    const { db, prefix, n } = await sqlite("fineline");
    const m = models.fineline;
    expect(m.site.url).toBe("https://finelinepainting.pro");
    expect(m.site.pageOnFront).toBe(5246);
    expect(m.site.pageForPosts).toBe(2588);
    expect(
      n(
        `select count(*) as n from ${prefix}posts where post_type = 'project' and post_status = 'publish'`,
      ),
    ).toBe(82);
    expect(postsOfType(m, "project", ["publish"])).toHaveLength(82);
    expect(
      n(
        `select count(*) as n from ${prefix}posts where post_type = 'service' and post_status = 'publish'`,
      ),
    ).toBe(19);
    expect(postsOfType(m, "service", ["publish"])).toHaveLength(19);
    expect(n(`select count(*) as n from ${prefix}posts where post_type = 'attachment'`)).toBe(1233);
    expect(m.attachments.size).toBe(1233);
    expect(n(`select count(*) as n from ${prefix}rank_math_redirections`)).toBe(57);
    expect(
      n(
        `select count(*) as n from ${prefix}posts where post_type = 'nav_menu_item' and post_status = 'publish'`,
      ),
    ).toBe(45);
    expect(m.menuItems).toHaveLength(45);
    db.close();
  });

  test("anabaptistperspectives", async () => {
    const { db, prefix, n } = await sqlite("ap");
    const m = models.ap;
    expect(prefix).toBe("wp_");
    expect(m.site.permalinkStructure).toBe("/essays/%postname%/");
    expect(m.site.pageOnFront).toBe(819);
    expect(m.site.pageForPosts).toBe(830);
    expect(n(`select count(*) as n from ${prefix}rank_math_redirections`)).toBe(391);
    // The fixture keeps at most 100 posts of each non-structural type.
    for (const type of ["post", "episode", "captivate_podcast", "supporters_update"]) {
      expect(postsOfType(m, type).length, type).toBeLessThanOrEqual(100);
    }
    expect(postsOfType(m, "page", ["publish"])).toHaveLength(30);
    db.close();
  });
});

// ── LoadOptions ──────────────────────────────────────────────────────────────────────────────────

describe("LoadOptions", () => {
  const key: SiteKey = "fineline";
  const fx = FIXTURES[key];
  const db = databases[key];

  test("postTypes narrows model.posts, and nothing else the content refers to", async () => {
    const m = await loadModel(db, { postTypes: ["project"] });
    const projects = fx.posts.filter((p) => p.post_type === "project");
    expect([...m.posts.values()].map((p) => p.type)).toEqual(projects.map(() => "project"));
    expect(m.posts.size).toBe(projects.length);
    // Still loaded, because pages and projects point at them.
    expect(m.attachments.size).toBe(1233);
    expect(m.menuItems).toHaveLength(45);
    expect(m.redirects).toHaveLength(67);
    expect(m.terms.size).toBe(249);
    expect(m.users.size).toBeGreaterThan(0);
    // Meta of the projects, and of nothing else.
    for (const id of m.postMeta.keys()) expect(m.posts.get(id)?.type).toBe("project");
  });

  test("postTypes can name a type the default would exclude, and can be empty", async () => {
    const none = await loadModel(db, { postTypes: [] });
    expect(none.posts.size).toBe(0);
    expect(none.postMeta.size).toBe(0);
    expect(none.attachments.size).toBe(1233);
    const att = await loadModel(db, { postTypes: ["attachment", "no-such-type"] });
    expect(att.posts.size).toBe(1233);
    expect([...att.posts.values()].every((p) => p.type === "attachment")).toBe(true);
  });

  test("statuses narrows model.posts; attachments are loaded regardless", async () => {
    const m = await loadModel(db, { statuses: ["publish"] });
    const published = fx.posts.filter((p) => p.post_status === "publish");
    expect([...m.posts.keys()]).toEqual(published.map((p) => p.ID).sort((a, b) => a - b));
    expect(m.attachments.size).toBe(1233); // status 'inherit', not in posts, still in attachments
    expect([...m.posts.values()].some((p) => p.type === "attachment")).toBe(false);

    const drafts = await loadModel(db, { statuses: ["draft", "private"], postTypes: ["page"] });
    const expected = fx.posts.filter(
      (p) => p.post_type === "page" && ["draft", "private"].includes(p.post_status),
    );
    expect(drafts.posts.size).toBe(expected.length);
    expect(drafts.posts.size).toBeGreaterThan(20);
  });

  test("metaKeys is asked about each key with the type of the post it belongs to", async () => {
    const asked = new Set<string>();
    const m = await loadModel(db, {
      metaKeys: (k, type) => {
        asked.add(`${type}\0${k}`);
        return k === "rank_math_title";
      },
    });
    expect(asked.has("page\0rank_math_title")).toBe(true);
    expect(asked.has("attachment\0_wp_attached_file")).toBe(true);
    expect(asked.has("nav_menu_item\0_menu_item_type")).toBe(true);
    expect(m.postMeta.size).toBeGreaterThan(0);
    for (const rec of m.postMeta.values()) expect(Object.keys(rec)).toEqual(["rank_math_title"]);
    const expectedPosts = new Set(
      fx.meta.filter((r) => r.meta_key === "rank_math_title").map((r) => r.post_id),
    );
    expect(new Set(m.postMeta.keys())).toEqual(expectedPosts);
  });

  test("metaKeys never starves the things built from meta", async () => {
    const m = await loadModel(db, { metaKeys: () => false });
    expect(m.postMeta.size).toBe(0);
    // Attachments and menu items read their own meta.
    const alt = fx.meta.find((r) => r.post_id === 29 && r.meta_key === "_wp_attachment_image_alt")!;
    expect(m.attachments.get(29)).toMatchObject({
      file: "Screen-Shot-2022-10-08-at-12.49.17-PM.png",
      alt: alt.meta_value,
      width: 527,
      height: 252,
    });
    expect(
      m.attachments
        .get(29)!
        .sizes.map((s) => s.name)
        .sort(),
    ).toEqual(["medium", "thumbnail"]);
    expect(m.menuItems).toEqual(models.fineline.menuItems);
  });

  test("meta is loaded in chunks of at most 500 ids, and every id-list query respects it", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const spy: WpDb = {
      prefix: db.prefix,
      table: (name) => db.table(name),
      close: () => db.close(),
      query: (sql, params) => {
        calls.push({ sql, params: params ?? [] });
        return db.query(sql, params);
      },
    };
    await loadModel(spy);
    const metaCalls = calls.filter((c) => /from KjLnF_postmeta where post_id in/.test(c.sql));
    // 1,549 loaded posts → four chunks for the posts, one more for the 45 menu items.
    expect(metaCalls.map((c) => c.params.length).sort((a, b) => a - b)).toEqual([
      45, 49, 500, 500, 500,
    ]);
    expect(metaCalls.every((c) => /order by meta_id/.test(c.sql))).toBe(true);
    for (const c of calls.filter(
      (c) => /\bin \(/.test(c.sql) && !/post_type in|post_type not in/.test(c.sql),
    )) {
      expect(c.params.length, c.sql.replace(/\s+/g, " ").slice(0, 80)).toBeLessThanOrEqual(500);
    }
    // And the model only ever asks to read.
    expect(calls.every((c) => /^\s*select\b/i.test(c.sql))).toBe(true);
  });

  test("the same load with a smaller default gives the same posts as with none", async () => {
    const a = await loadModel(db, { postTypes: [...new Set(fx.posts.map((p) => p.post_type))] });
    expect([...a.posts]).toEqual([...models.fineline.posts]);
  });
});

// ── Synthetic databases: the edge cases the fixtures do not have ─────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "wp2jx-model-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let dbCounter = 0;

interface FakePost {
  ID: number | string;
  post_author: number | string;
  post_date: string | null;
  post_date_gmt: string | null;
  post_content: string | Uint8Array;
  post_title: string | Uint8Array;
  post_excerpt: string;
  post_status: string;
  post_password: string;
  post_name: string | null;
  post_modified: string | null;
  post_modified_gmt: string | null;
  post_parent: number | string;
  guid: string | null;
  menu_order: number | string;
  post_type: string;
  post_mime_type: string;
}

interface Fake {
  options?: Record<string, string>;
  /** option name → option_id, where the order matters */
  optionIds?: Record<string, number>;
  posts?: Partial<FakePost>[];
  /** [post_id, meta_key, meta_value] in meta_id order */
  meta?: [postId: number, key: string | null, value: string | null, metaId?: number][];
  /** One taxonomy row each (the term shares its id). */
  taxonomies?: {
    ttId: number;
    termId: number;
    taxonomy: string;
    name?: string;
    slug?: string;
    parent?: number;
  }[];
  relationships?: [objectId: number, ttId: number, order?: number][];
  /** null: no termmeta table at all */
  termmeta?: [termId: number, key: string, value: string, metaId?: number][] | null;
  /** null: no users table at all (a multisite sub-site) */
  users?: { ID: number; user_nicename: string; display_name: string }[] | null;
  /** null: no Rank Math table at all */
  redirections?:
    | {
        id: number;
        sources: string | null;
        url_to: string;
        header_code: number | string;
        status: string;
      }[]
    | null;
  /** Tables made as a table of one `id` column, the fixture helper's stand-in for an empty JSON file. */
  stubs?: string[];
  /** Declare the numeric post columns as text, as a driver might hand them back. */
  textNumbers?: boolean;
  /** Rows of the comments table; absent: no such table. */
  comments?: FakeComment[];
}

interface FakeComment {
  id: number;
  post: number;
  approved: string;
  /** WordPress writes `comment`, older installs an empty string, plugins their own. */
  type?: string;
}

async function fakeSite(fake: Fake): Promise<{ db: WpDb; done: () => Promise<void> }> {
  const path = join(scratch, `wp-${dbCounter++}.sqlite`);
  const sqlite = new Database(path, { create: true });
  const n = fake.textNumbers ? "text" : "integer";
  const create = (name: string, columns: string): void => {
    sqlite.run(`create table wp_${name} ${fake.stubs?.includes(name) ? "(id integer)" : columns}`);
  };
  sqlite.run(`create table wp_options (option_id integer, option_name text, option_value text)`);
  sqlite.run(
    `create table wp_posts (ID ${n}, post_author ${n}, post_date text, post_date_gmt text, post_content, post_title, post_excerpt text,
       post_status text, post_password text, post_name text, post_modified text, post_modified_gmt text, post_parent ${n}, guid text,
       menu_order ${n}, post_type text, post_mime_type text)`,
  );
  create("postmeta", `(meta_id integer, post_id integer, meta_key text, meta_value text)`);
  create("terms", `(term_id integer, name text, slug text, term_group integer)`);
  create(
    "term_taxonomy",
    `(term_taxonomy_id integer, term_id integer, taxonomy text, description text, parent integer, count integer)`,
  );
  create("term_relationships", `(object_id integer, term_taxonomy_id integer, term_order integer)`);
  if (fake.users !== null) {
    create("users", `(ID integer, user_login text, user_nicename text, display_name text)`);
  }
  if (fake.termmeta !== null) {
    create("termmeta", `(meta_id integer, term_id integer, meta_key text, meta_value text)`);
  }
  if (fake.comments !== undefined || fake.stubs?.includes("comments")) {
    create(
      "comments",
      `(comment_ID integer, comment_post_ID integer, comment_author text, comment_content text, comment_approved text, comment_type text, comment_parent integer)`,
    );
  }
  if (fake.redirections !== null && fake.redirections !== undefined) {
    create(
      "rank_math_redirections",
      `(id integer, sources text, url_to text, header_code ${n}, hits integer, status text)`,
    );
  }

  const options = { siteurl: "https://x.test", home: "https://x.test", ...fake.options };
  let nextOptionId = 1;
  for (const [name, value] of Object.entries(options)) {
    sqlite.run(`insert into wp_options (option_id, option_name, option_value) values (?, ?, ?)`, [
      fake.optionIds?.[name] ?? nextOptionId++,
      name,
      value,
    ]);
  }
  for (const p of fake.posts ?? []) {
    const row: FakePost = {
      ID: 1,
      post_author: 0,
      post_date: "2024-01-02 03:04:05",
      post_date_gmt: "2024-01-02 08:04:05",
      post_content: "",
      post_title: "",
      post_excerpt: "",
      post_status: "publish",
      post_password: "",
      post_name: "",
      post_modified: "2024-01-03 03:04:05",
      post_modified_gmt: "2024-01-03 08:04:05",
      post_parent: 0,
      guid: "",
      menu_order: 0,
      post_type: "post",
      post_mime_type: "",
      ...p,
    };
    sqlite.run(
      `insert into wp_posts values (${Array(17).fill("?").join(",")})`,
      Object.values(row) as never[],
    );
  }
  let nextMetaId = 1;
  for (const [postId, key, value, metaId] of fake.meta ?? []) {
    sqlite.run(
      `insert into wp_postmeta (meta_id, post_id, meta_key, meta_value) values (?, ?, ?, ?)`,
      [metaId ?? nextMetaId++, postId, key, value],
    );
  }
  const termsDone = new Set<number>();
  for (const t of fake.taxonomies ?? []) {
    if (!termsDone.has(t.termId)) {
      termsDone.add(t.termId);
      sqlite.run(`insert into wp_terms values (?, ?, ?, 0)`, [
        t.termId,
        t.name ?? `term ${t.termId}`,
        t.slug ?? `term-${t.termId}`,
      ]);
    }
    sqlite.run(`insert into wp_term_taxonomy values (?, ?, ?, '', ?, 0)`, [
      t.ttId,
      t.termId,
      t.taxonomy,
      t.parent ?? 0,
    ]);
  }
  for (const [objectId, ttId, order] of fake.relationships ?? []) {
    sqlite.run(`insert into wp_term_relationships values (?, ?, ?)`, [objectId, ttId, order ?? 0]);
  }
  let nextTermMetaId = 1;
  for (const [termId, key, value, metaId] of fake.termmeta ?? []) {
    sqlite.run(
      `insert into wp_termmeta (meta_id, term_id, meta_key, meta_value) values (?, ?, ?, ?)`,
      [metaId ?? nextTermMetaId++, termId, key, value],
    );
  }
  if (!fake.stubs?.includes("comments")) {
    for (const c of fake.comments ?? []) {
      sqlite.run(`insert into wp_comments values (?, ?, 'Someone', 'Hello', ?, ?, 0)`, [
        c.id,
        c.post,
        c.approved,
        c.type ?? "comment",
      ]);
    }
  }
  for (const u of fake.users ?? [])
    sqlite.run(`insert into wp_users values (?, 'login', ?, ?)`, [
      u.ID,
      u.user_nicename,
      u.display_name,
    ]);
  for (const r of fake.redirections ?? []) {
    sqlite.run(`insert into wp_rank_math_redirections values (?, ?, ?, ?, 0, ?)`, [
      r.id,
      r.sources,
      r.url_to,
      r.header_code,
      r.status,
    ]);
  }
  sqlite.close();
  const db = await openDb(`sqlite:${path}`);
  return { db, done: () => db.close() };
}

async function loadFake(fake: Fake, opts: LoadOptions = {}) {
  const { db, done } = await fakeSite(fake);
  const report = createReport();
  const model = await loadModel(db, { report, ...opts });
  await done();
  return { model, report: report.entries() };
}

describe("dates", () => {
  test("GMT wins; the zero GMT date falls back to the local date, which is UTC on a site with no timezone", async () => {
    const { model, report } = await loadFake({
      posts: [
        { ID: 1 },
        {
          ID: 2,
          post_date_gmt: "0000-00-00 00:00:00",
          post_date: "2024-03-05 10:20:30",
          post_modified_gmt: "0000-00-00 00:00:00",
          post_modified: "2024-03-06 11:00:00",
        },
        {
          ID: 3,
          post_date_gmt: null,
          post_date: "2022-12-31 23:59:59",
          post_modified_gmt: null,
          post_modified: null,
        },
      ],
    });
    expect(model.posts.get(1)).toMatchObject({
      date: "2024-01-02T08:04:05.000Z",
      modified: "2024-01-03T08:04:05.000Z",
    });
    expect(model.posts.get(2)).toMatchObject({
      date: "2024-03-05T10:20:30.000Z",
      modified: "2024-03-06T11:00:00.000Z",
    });
    // No modified date at all: the post's own date stands in.
    expect(model.posts.get(3)).toMatchObject({
      date: "2022-12-31T23:59:59.000Z",
      modified: "2022-12-31T23:59:59.000Z",
    });
    expect(report).toEqual([]);
  });

  test("a post with no valid date at all gets the epoch, and says so", async () => {
    const { model, report } = await loadFake({
      posts: [
        { ID: 7, post_date_gmt: "0000-00-00 00:00:00", post_date: "0000-00-00 00:00:00" },
        { ID: 8, post_date_gmt: "2020-02-31 10:00:00", post_date: "2020-13-01 10:00:00" },
        { ID: 9, post_date_gmt: "garbage", post_date: null },
      ],
    });
    for (const id of [7, 8, 9])
      expect(model.posts.get(id)).toMatchObject({ date: "1970-01-01T00:00:00.000Z" });
    expect(report.map((e) => [e.code, e.where])).toEqual([
      ["wp.date-invalid", "post:7"],
      ["wp.date-invalid", "post:8"],
      ["wp.date-invalid", "post:9"],
    ]);
  });

  test("ISO strings, with or without a zone, and fractional seconds, are read as UTC", async () => {
    const { model } = await loadFake({
      posts: [
        { ID: 1, post_date_gmt: "2024-03-05T10:20:30Z" },
        { ID: 2, post_date_gmt: "2024-03-05T10:20:30.123Z" },
        { ID: 3, post_date_gmt: "2024-03-05 10:20:30.456" },
        { ID: 4, post_date_gmt: "2024-03-05T12:20:30+02:00" },
      ],
    });
    expect([1, 2, 3, 4].map((id) => model.posts.get(id)!.date)).toEqual([
      "2024-03-05T10:20:30.000Z",
      "2024-03-05T10:20:30.123Z",
      "2024-03-05T10:20:30.000Z",
      "2024-03-05T10:20:30.000Z",
    ]);
  });
});

/** A draft: no GMT date, so its local date is read in the site's timezone. */
const draft = (wall: string, over: Partial<FakePost> = {}): Partial<FakePost> => ({
  ID: 1,
  post_status: "draft",
  post_date: wall,
  post_date_gmt: "0000-00-00 00:00:00",
  post_modified: wall,
  post_modified_gmt: "0000-00-00 00:00:00",
  ...over,
});

describe("the site's clock", () => {
  const dateIn = async (options: Record<string, string>, wall: string) =>
    (await loadFake({ options, posts: [draft(wall)] })).model.posts.get(1)!.date;

  test("a draft's local date is turned into UTC with the site's timezone, daylight saving included", async () => {
    const tz = { timezone_string: "America/New_York" };
    expect(await dateIn(tz, "2024-01-15 12:00:00")).toBe("2024-01-15T17:00:00.000Z"); // EST, UTC-5
    expect(await dateIn(tz, "2024-07-15 12:00:00")).toBe("2024-07-15T16:00:00.000Z"); // EDT, UTC-4
    // The hour that does not exist (clocks went forward) is read with the offset before the change.
    expect(await dateIn(tz, "2024-03-10 02:30:00")).toBe("2024-03-10T07:30:00.000Z");
    // The hour that happens twice (clocks went back) is its first time.
    expect(await dateIn(tz, "2024-11-03 01:30:00")).toBe("2024-11-03T05:30:00.000Z");
    expect(await dateIn(tz, "2024-11-03 02:30:00")).toBe("2024-11-03T07:30:00.000Z");
    // A zone ahead of UTC, with a half hour, moves the other way.
    expect(await dateIn({ timezone_string: "Asia/Kolkata" }, "2024-07-15 12:00:00")).toBe(
      "2024-07-15T06:30:00.000Z",
    );
  });

  test("the modified date of a draft is converted the same way, and each column on its own", async () => {
    const tz = { timezone_string: "America/New_York" };
    const { model } = await loadFake({
      options: tz,
      posts: [
        draft("2024-07-15 12:00:00", { ID: 1, post_modified: "2024-07-16 09:30:00" }),
        // Only the modified GMT is there: it wins for modified; the date is still converted.
        draft("2024-07-15 12:00:00", { ID: 2, post_modified_gmt: "2024-07-15 20:00:00" }),
        // Only the date's GMT is there: it wins for the date; modified is converted.
        draft("2024-07-15 12:00:00", {
          ID: 3,
          post_date_gmt: "2024-07-15 15:00:00",
          post_modified: "2024-01-15 09:00:00",
        }),
        // No modified date at all: the date stands in.
        draft("2024-07-15 12:00:00", { ID: 4, post_modified: null, post_modified_gmt: null }),
      ],
    });
    const at = (id: number) => [model.posts.get(id)!.date, model.posts.get(id)!.modified];
    expect(at(1)).toEqual(["2024-07-15T16:00:00.000Z", "2024-07-16T13:30:00.000Z"]);
    expect(at(2)).toEqual(["2024-07-15T16:00:00.000Z", "2024-07-15T20:00:00.000Z"]);
    expect(at(3)).toEqual(["2024-07-15T15:00:00.000Z", "2024-01-15T14:00:00.000Z"]);
    expect(at(4)).toEqual(["2024-07-15T16:00:00.000Z", "2024-07-15T16:00:00.000Z"]);
  });

  test("a real GMT column is never second-guessed by the timezone", async () => {
    const { model } = await loadFake({
      options: { timezone_string: "Pacific/Auckland" },
      posts: [{ ID: 1, post_date: "2024-07-15 12:00:00", post_date_gmt: "2024-07-15 16:00:00" }],
    });
    expect(model.posts.get(1)!.date).toBe("2024-07-15T16:00:00.000Z");
  });

  test("with no timezone_string the gmt_offset is a fixed number of hours; with neither the site is on UTC", async () => {
    const wall = "2024-07-15 12:00:00";
    expect(await dateIn({ gmt_offset: "-5" }, wall)).toBe("2024-07-15T17:00:00.000Z");
    expect(await dateIn({ gmt_offset: "5.5" }, wall)).toBe("2024-07-15T06:30:00.000Z");
    expect(await dateIn({ gmt_offset: "-3.5" }, wall)).toBe("2024-07-15T15:30:00.000Z");
    expect(await dateIn({ gmt_offset: "5.75" }, wall)).toBe("2024-07-15T06:15:00.000Z");
    expect(await dateIn({ gmt_offset: "0" }, wall)).toBe("2024-07-15T12:00:00.000Z");
    expect(await dateIn({ gmt_offset: "" }, wall)).toBe("2024-07-15T12:00:00.000Z");
    expect(await dateIn({}, wall)).toBe("2024-07-15T12:00:00.000Z");
    expect(await dateIn({ timezone_string: "UTC" }, wall)).toBe("2024-07-15T12:00:00.000Z");
    // A named zone wins over an offset, as in WordPress, and blanks around either are ignored.
    expect(await dateIn({ timezone_string: " America/New_York ", gmt_offset: "9" }, wall)).toBe(
      "2024-07-15T16:00:00.000Z",
    );
    expect(await dateIn({ timezone_string: "  ", gmt_offset: " 2 " }, wall)).toBe(
      "2024-07-15T10:00:00.000Z",
    );
  });

  test("a timezone that cannot be used is reported once and the next rule stands in", async () => {
    const wall = "2024-07-15 12:00:00";
    const posts = [draft(wall, { ID: 1 }), draft(wall, { ID: 2 }), draft(wall, { ID: 3 })];
    const zone = await loadFake({
      options: { timezone_string: "Mars/Olympus_Mons", gmt_offset: "2" },
      posts,
    });
    expect(zone.model.posts.get(1)!.date).toBe("2024-07-15T10:00:00.000Z");
    expect(zone.report).toHaveLength(1);
    expect(zone.report[0]).toMatchObject({
      severity: "warn",
      code: "wp.timezone-invalid",
      where: "option:timezone_string",
      data: { timezone: "Mars/Olympus_Mons" },
    });
    const offset = await loadFake({ options: { gmt_offset: "five" }, posts });
    expect(offset.model.posts.get(1)!.date).toBe("2024-07-15T12:00:00.000Z");
    expect(offset.report.map((e) => [e.code, e.where])).toEqual([
      ["wp.timezone-invalid", "option:gmt_offset"],
    ]);
    // A site that is fine says nothing, however many drafts it has.
    const fine = await loadFake({ options: { timezone_string: "America/New_York" }, posts });
    expect(fine.report).toEqual([]);
  });

  test("a date that states its own zone is an instant, and the site's timezone does not move it", async () => {
    const { model } = await loadFake({
      options: { timezone_string: "America/New_York" },
      posts: [
        draft("2024-03-05T12:20:30+02:00", { ID: 1 }),
        draft("2024-03-05T10:20:30Z", { ID: 2 }),
        // Digits with no zone are wall-clock time, with a space or a T between date and time.
        draft("2024-03-05T10:20:30", { ID: 3 }),
        draft("2024-03-05 10:20:30.456", { ID: 4 }),
      ],
    });
    expect([1, 2, 3, 4].map((id) => model.posts.get(id)!.date)).toEqual([
      "2024-03-05T10:20:30.000Z",
      "2024-03-05T10:20:30.000Z",
      "2024-03-05T15:20:30.000Z",
      "2024-03-05T15:20:30.000Z",
    ]);
  });

  test("zone-less ISO digits with a T are wall-clock time, whatever zone the process itself is in", async () => {
    // `new Date("2024-03-05T10:20:30")` is local time to the engine running it: the same digits mean a
    // different instant on a machine in another zone. They must be read as the stated wall clock.
    const was = process.env.TZ;
    try {
      for (const zone of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = zone;
        expect(new Date("2024-03-05T10:20:30").getHours(), zone).toBe(10); // the process zone took effect
        const { model } = await loadFake({
          posts: [
            {
              ID: 1,
              post_date_gmt: "2024-03-05T10:20:30",
              post_modified_gmt: "2024-03-05 10:20:30",
            },
          ],
        });
        expect(model.posts.get(1), zone).toMatchObject({
          date: "2024-03-05T10:20:30.000Z",
          modified: "2024-03-05T10:20:30.000Z",
        });
      }
    } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  });

  test("the oracle used for the fixtures reproduces the real GMT column where WordPress wrote both", () => {
    // easternToUtc is worked out by hand; this is what makes it a witness. Where a site's imports wrote
    // the two columns independently (years apart) it cannot agree, and those are the few that remain.
    for (const key of Object.keys(FIXTURES) as SiteKey[]) {
      let pairs = 0;
      let agree = 0;
      for (const row of FIXTURES[key].posts) {
        for (const [local, gmt] of [
          [row.post_date, row.post_date_gmt],
          [row.post_modified, row.post_modified_gmt],
        ] as const) {
          if (!local || !gmt) continue;
          pairs++;
          if (easternToUtc(local) === gmt) agree++;
        }
      }
      expect(pairs, key).toBeGreaterThan(3000);
      expect(agree / pairs, key).toBeGreaterThan(0.98);
    }
  });
});

/** A `php` that has DateTime with transitions (any 8.x does). */
const phpForClock = Bun.which("php");

describe.skipIf(!phpForClock)("the site's clock, against PHP's own DateTime", () => {
  // WordPress converts a local date with `date_create($local, wp_timezone())`; PHP is the reference.
  const run = (script: string, stdin: string): string[] => {
    const proc = Bun.spawnSync([phpForClock!, "-r", script], {
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stderr.toString()).toBe("");
    return proc.stdout.toString().trimEnd().split("\n");
  };
  const ZONES = [
    "America/New_York",
    "America/Los_Angeles",
    "America/St_Johns", // UTC-3:30 and DST
    "America/Sao_Paulo", // DST abolished in 2019
    "Europe/London",
    "Europe/Berlin",
    "Europe/Moscow",
    "Africa/Casablanca", // DST inverted around Ramadan
    "Asia/Kolkata", // UTC+5:30, no DST
    "Asia/Kathmandu", // UTC+5:45
    "Asia/Tokyo",
    "Australia/Sydney", // southern hemisphere DST
    "Australia/Lord_Howe", // DST of 30 minutes
    "Pacific/Auckland",
    "Pacific/Apia", // skipped a whole day in 2011, DST abolished in 2021
    "UTC",
  ];

  test("every zone, on a grid of dates and an hour either side of every change since 2009", () => {
    const transitions = run(
      `foreach (explode(",", trim(fgets(STDIN))) as $z) {
         $t = (new DateTimeZone($z))->getTransitions(strtotime("2009-01-01"), strtotime("2026-12-31"));
         $o = []; $prev = null;
         foreach ($t as $x) { $o[] = [$x["ts"], $prev === null ? $x["offset"] : $prev, $x["offset"]]; $prev = $x["offset"]; }
         echo json_encode([$z, $o]), "\\n";
       }`,
      ZONES.join(","),
    ).map((line) => JSON.parse(line) as [string, [number, number, number][]]);

    const wallIso = (ms: number): string =>
      new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const cases: { zone: string; wall: string }[] = [];
    for (const [zone, changes] of transitions) {
      for (const [ts, before, after] of changes) {
        for (const offset of new Set([before, after])) {
          for (const minutes of [-150, -90, -61, -59, -31, -1, 0, 1, 29, 31, 59, 61, 90, 150]) {
            cases.push({ zone, wall: wallIso((ts + offset + minutes * 60) * 1000) });
          }
        }
      }
      // A plain grid too: a date every 23 days at an odd time of day, across the whole span.
      for (
        let ms = Date.UTC(2009, 0, 1, 13, 7, 9);
        ms < Date.UTC(2026, 11, 31);
        ms += 23 * 86_400_000 + 4_000_000
      ) {
        cases.push({ zone, wall: wallIso(ms) });
      }
    }
    expect(cases.length).toBeGreaterThan(8000);

    /**
     * The other instant a wall time can mean, when clocks went back and the hour happened twice. PHP
     * takes the first time west of UTC and the second east of it; either is right, so both are accepted
     * there, and only there.
     */
    const changesByZone = new Map(transitions);
    const otherReading = (zone: string, wall: string): string | undefined => {
      const wallSeconds = Date.parse(`${wall.replace(" ", "T")}Z`) / 1000;
      for (const [ts, before, after] of changesByZone.get(zone) ?? []) {
        if (after < before && wallSeconds >= ts + after && wallSeconds < ts + before) {
          return [wallSeconds - before, wallSeconds - after]
            .map((s) => new Date(s * 1000).toISOString())
            .join("|");
        }
      }
      return undefined;
    };

    const expected = run(
      `while (($line = fgets(STDIN)) !== false) {
         [$z, $w] = explode("|", trim($line));
         $d = new DateTime($w, new DateTimeZone($z));
         $d->setTimezone(new DateTimeZone("UTC"));
         echo $d->format("Y-m-d\\\\TH:i:s.000\\\\Z"), "\\n";
       }`,
      cases.map((c) => `${c.zone}|${c.wall}`).join("\n"),
    );
    expect(expected).toHaveLength(cases.length);

    // One database per zone, every case of that zone a draft in it.
    return Promise.all(
      ZONES.map(async (zone) => {
        const mine = cases.map((c, i) => ({ ...c, i })).filter((c) => c.zone === zone);
        const { model } = await loadFake({
          options: { timezone_string: zone },
          posts: mine.map((c) => draft(c.wall, { ID: c.i + 1 })),
        });
        const wrong = mine
          .filter((c) => {
            const got = model.posts.get(c.i + 1)!.date;
            if (got === expected[c.i]) return false;
            return !otherReading(zone, c.wall)?.split("|").includes(got);
          })
          .map((c) => `${zone} ${c.wall}: ${model.posts.get(c.i + 1)!.date}, PHP ${expected[c.i]}`);
        expect(wrong.slice(0, 5)).toEqual([]);
      }),
    ).then(() => undefined);
  }, 60_000);

  test("gmt_offset, spelled the way WordPress writes it", () => {
    const offsets = ["0", "-5", "5.5", "-3.5", "5.75", "-9.5", "12.75", "14", "-12", "1", "-0.5"];
    const walls = [
      "2024-01-15 12:00:00",
      "2024-07-15 12:00:00",
      "2023-12-31 23:59:59",
      "2024-03-10 02:30:00",
    ];
    const expected = run(
      `while (($line = fgets(STDIN)) !== false) {
         [$o, $w] = explode("|", trim($line));
         // wp_timezone_string(), for a site with no timezone_string.
         $offset = (float) $o; $hours = (int) $offset; $minutes = ($offset - $hours);
         $sign = ($offset < 0) ? "-" : "+";
         $tz = sprintf("%s%02d:%02d", $sign, abs($hours), abs($minutes * 60));
         $d = new DateTime($w, new DateTimeZone($tz));
         $d->setTimezone(new DateTimeZone("UTC"));
         echo $d->format("Y-m-d\\\\TH:i:s.000\\\\Z"), "\\n";
       }`,
      offsets.flatMap((o) => walls.map((w) => `${o}|${w}`)).join("\n"),
    );
    return Promise.all(
      offsets.map(async (offset, k) => {
        const { model } = await loadFake({
          options: { gmt_offset: offset },
          posts: walls.map((w, i) => draft(w, { ID: i + 1 })),
        });
        expect(
          walls.map((_, i) => model.posts.get(i + 1)!.date),
          offset,
        ).toEqual(expected.slice(k * walls.length, (k + 1) * walls.length));
      }),
    ).then(() => undefined);
  });
});

describe("numbers and text from a driver that is not careful", () => {
  test("numeric columns that arrive as strings become numbers", async () => {
    const { model } = await loadFake({
      textNumbers: true,
      posts: [{ ID: "12", post_author: "3", post_parent: "4294967296", menu_order: "-5" }],
      users: [{ ID: 3, user_nicename: "kev", display_name: "Kevin" }],
    });
    expect(model.posts.get(12)).toMatchObject({
      id: 12,
      authorId: 3,
      parent: 4294967296,
      menuOrder: -5,
    });
    expect(model.users.get(3)).toEqual({ id: 3, slug: "kev", displayName: "Kevin" });
  });

  test("a text column that comes back as bytes is decoded", async () => {
    const { model } = await loadFake({
      posts: [
        {
          ID: 1,
          post_title: new TextEncoder().encode("Café ← 🎨"),
          post_content: new TextEncoder().encode("<p>x</p>"),
        },
      ],
    });
    expect(model.posts.get(1)).toMatchObject({ title: "Café ← 🎨", content: "<p>x</p>" });
  });

  test("a text column SQLite stored as a number is its decimal text", async () => {
    const { model } = await loadFake({
      posts: [
        { ID: 1, post_title: 2024 as unknown as string, post_content: 3.5 as unknown as string },
      ],
    });
    expect(model.posts.get(1)).toMatchObject({ title: "2024", content: "3.5" });
  });

  test("NULL text is the empty string", async () => {
    const { model } = await loadFake({
      posts: [{ ID: 1, post_modified: null, post_name: null, guid: null }],
    });
    expect(model.posts.get(1)).toMatchObject({ slug: "", guid: "" });
  });
});

describe("site", () => {
  test("language from WPLANG, as the locale's BCP 47 spelling", async () => {
    expect((await loadFake({ options: { WPLANG: "de_DE" } })).model.site.language).toBe("de-DE");
    expect((await loadFake({ options: { WPLANG: "pt_BR" } })).model.site.language).toBe("pt-BR");
    expect((await loadFake({ options: { WPLANG: "" } })).model.site.language).toBe("en-US");
    expect((await loadFake({})).model.site.language).toBe("en-US");
  });

  test("trailing slashes are removed from both urls; home falls back to siteurl and back", async () => {
    const a = (
      await loadFake({ options: { siteurl: "https://x.test/wp/", home: "https://x.test//" } })
    ).model.site;
    expect([a.url, a.home]).toEqual(["https://x.test/wp", "https://x.test"]);
    const noHome = await loadFake({ options: { siteurl: "https://only.test/", home: "" } });
    expect([noHome.model.site.url, noHome.model.site.home]).toEqual([
      "https://only.test",
      "https://only.test",
    ]);
  });

  test("the child theme is the active one; the parent is the fallback", async () => {
    expect(
      (await loadFake({ options: { template: "parent", stylesheet: "child" } })).model.site.theme,
    ).toBe("child");
    expect((await loadFake({ options: { template: "parent" } })).model.site.theme).toBe("parent");
    expect((await loadFake({})).model.site.theme).toBe("");
  });

  test("show_on_front is page or posts; page ids default to zero", async () => {
    const posts = (await loadFake({})).model.site;
    expect([posts.showOnFront, posts.pageOnFront, posts.pageForPosts]).toEqual(["posts", 0, 0]);
    const page = (
      await loadFake({
        options: { show_on_front: "page", page_on_front: "12", page_for_posts: "13" },
      })
    ).model.site;
    expect([page.showOnFront, page.pageOnFront, page.pageForPosts]).toEqual(["page", 12, 13]);
    expect(
      (await loadFake({ options: { show_on_front: "nonsense" } })).model.site.showOnFront,
    ).toBe("posts");
  });

  test("active plugins whose PHP array has gaps are still a list; damage gives an empty list and a report entry", async () => {
    const gaps = await loadFake({
      options: { active_plugins: 'a:2:{i:0;s:5:"a/a.p";i:4;s:5:"b/b.p";}' },
    });
    expect(gaps.model.site.activePlugins).toEqual(["a/a.p", "b/b.p"]);
    const broken = await loadFake({ options: { active_plugins: 'a:1:{i:0;s:9:"a/a.php";}' } });
    expect(broken.model.site.activePlugins).toEqual([]);
    expect(broken.report.map((e) => e.where)).toEqual(["option:active_plugins"]);
    const none = await loadFake({ options: { active_plugins: "" } });
    expect(none.model.site.activePlugins).toEqual([]);
    expect(none.report).toEqual([]);
  });

  test("a database with neither siteurl nor home says so", async () => {
    const path = join(scratch, `wp-nosite-${dbCounter++}.sqlite`);
    const sqlite = new Database(path, { create: true });
    sqlite.run(`create table wp_options (option_id integer, option_name text, option_value text)`);
    sqlite.run(`create table wp_posts (ID integer)`);
    sqlite.run(`create table wp_postmeta (meta_id integer)`);
    sqlite.close();
    // Not a full WordPress schema, so only the site block is exercised: no posts query is attempted.
    const db = await openDb(`sqlite:${path}`);
    await expect(loadModel(db)).rejects.toThrow(); // posts columns are missing: fails loudly rather than guessing
    await db.close();
    const { model, report } = await loadFake({ options: { siteurl: "", home: "" } });
    expect(model.site.url).toBe("");
    expect(report.map((e) => e.code)).toEqual(["wp.option-missing"]);
  });

  test("blogname and description are kept as stored, entities and all", async () => {
    const { model } = await loadFake({
      options: { blogname: "Smith &amp; Sons", blogdescription: "It&#039;s fine" },
    });
    expect(model.site.name).toBe("Smith &amp; Sons");
    expect(model.site.description).toBe("It&#039;s fine");
  });
});

describe("posts", () => {
  test("bookkeeping types and trashed or auto-draft posts are excluded by default", async () => {
    const posts: Partial<FakePost>[] = [
      { ID: 1, post_type: "post" },
      { ID: 2, post_type: "revision", post_status: "inherit" },
      { ID: 3, post_type: "oembed_cache" },
      { ID: 4, post_type: "customize_changeset" },
      { ID: 5, post_type: "scheduled-action" },
      { ID: 6, post_type: "user_request" },
      { ID: 7, post_type: "post", post_status: "trash" },
      { ID: 8, post_type: "post", post_status: "auto-draft" },
      { ID: 9, post_type: "page", post_status: "draft" },
      { ID: 10, post_type: "custom_thing", post_status: "private" },
      { ID: 11, post_type: "auto-draft" },
    ];
    expect([...(await loadFake({ posts })).model.posts.keys()]).toEqual([1, 9, 10]);
    expect([
      ...(await loadFake({ posts }, { statuses: ["trash", "auto-draft"] })).model.posts.keys(),
    ]).toEqual([7, 8]);
    expect([
      ...(await loadFake({ posts }, { postTypes: ["revision"] })).model.posts.keys(),
    ]).toEqual([2]);
  });

  test("a password-protected post is flagged, and its password goes nowhere", async () => {
    const { model } = await loadFake({ posts: [{ ID: 1, post_password: "hunter2" }, { ID: 2 }] });
    expect(model.posts.get(1)?.passwordProtected).toBe(true);
    expect(model.posts.get(2)?.passwordProtected).toBe(false);
    expect(JSON.stringify([...model.posts.values()])).not.toContain("hunter2");
  });
});

describe("post meta", () => {
  test("repeated keys keep their order; NULL keys are skipped; NULL values stay null", async () => {
    const { model } = await loadFake({
      posts: [{ ID: 1 }],
      meta: [
        [1, "tag", "b"],
        [1, "other", "x"],
        [1, "tag", "a"],
        [1, null, "orphan"],
        [1, "empty", null],
        [1, "tag", "c"],
      ],
    });
    expect(model.postMeta.get(1)).toEqual({ tag: ["b", "a", "c"], other: ["x"], empty: [null] });
    expect(Object.keys(model.postMeta.get(1)!)).toEqual(["tag", "other", "empty"]);
  });

  test("a meta key named __proto__ is an ordinary key", async () => {
    const { model } = await loadFake({
      posts: [{ ID: 1 }],
      meta: [
        [1, "__proto__", "one"],
        [1, "__proto__", "two"],
        [1, "constructor", "c"],
      ],
    });
    const meta = model.postMeta.get(1)!;
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
    expect(Object.keys(meta)).toEqual(["__proto__", "constructor"]);
    expect(Object.getOwnPropertyDescriptor(meta, "__proto__")?.value).toEqual(["one", "two"]);
    expect((meta as Record<string, unknown[]>)["constructor"]).toEqual(["c"]);
  });

  test("a serialized value that does not parse stays text and is reported once", async () => {
    const broken = 'a:1:{i:0;s:9:"short";}';
    const { model, report } = await loadFake({
      posts: [{ ID: 4 }],
      meta: [
        [4, "damaged", broken],
        [4, "fine", 'a:1:{i:0;s:1:"x";}'],
      ],
    });
    expect(model.postMeta.get(4)).toEqual({ damaged: [broken], fine: [["x"]] });
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      severity: "info",
      code: "wp.serialized-malformed",
      where: "post:4",
      data: { key: "damaged" },
    });
  });

  test("a value keyed by a 64-bit id is read, not reported as damaged", async () => {
    // A numeric id of 17 digits used as a PHP array key serializes as `i:<digits>;`, past 2^53.
    const value = 'a:1:{i:17895695668004550;a:1:{s:2:"id";s:1:"x";}}';
    const { model, report } = await loadFake({ posts: [{ ID: 1 }], meta: [[1, "social", value]] });
    expect(model.postMeta.get(1)).toEqual({ social: [{ "17895695668004550": { id: "x" } }] });
    expect(report).toEqual([]);
  });

  test("a post with no kept meta has no entry at all", async () => {
    const { model } = await loadFake({ posts: [{ ID: 1 }, { ID: 2 }], meta: [[2, "k", "v"]] });
    expect(model.postMeta.has(1)).toBe(false);
    expect(model.postMeta.get(2)).toEqual({ k: ["v"] });
  });
});

describe("attachments", () => {
  const png =
    'a:5:{s:5:"width";i:800;s:6:"height";i:600;s:4:"file";s:14:"2023/03/a2.png";s:5:"sizes";a:1:{s:9:"thumbnail";a:4:{s:4:"file";s:14:"a2-150x150.png";s:5:"width";i:150;s:6:"height";i:150;s:9:"mime-type";s:9:"image/png";}}s:10:"image_meta";a:0:{}}';

  test("file, alt, dimensions and sizes come from three meta keys; the first row of each wins", async () => {
    const { model } = await loadFake({
      posts: [
        {
          ID: 10,
          post_type: "attachment",
          post_status: "inherit",
          post_mime_type: "image/png",
          guid: "https://x.test/wp-content/uploads/2023/03/a2.png",
          post_title: "A",
          post_excerpt: "cap",
          post_parent: 3,
        },
      ],
      meta: [
        [10, "_wp_attached_file", "2023/03/a2.png"],
        [10, "_wp_attached_file", "other.png"],
        [10, "_wp_attachment_image_alt", "first alt"],
        [10, "_wp_attachment_image_alt", "second alt"],
        [10, "_wp_attachment_metadata", png],
      ],
    });
    expect(model.attachments.get(10)).toEqual({
      id: 10,
      url: "https://x.test/wp-content/uploads/2023/03/a2.png",
      mime: "image/png",
      title: "A",
      alt: "first alt",
      caption: "cap",
      file: "2023/03/a2.png",
      width: 800,
      height: 600,
      sizes: [{ name: "thumbnail", file: "a2-150x150.png", width: 150, height: 150 }],
      parent: 3,
    });
  });

  test("no metadata: no dimensions, no sizes, and the file falls back to nothing", async () => {
    const { model } = await loadFake({
      posts: [{ ID: 10, post_type: "attachment", post_status: "inherit" }],
      meta: [[10, "_wp_attached_file", "2023/03/doc.pdf"]],
    });
    const att = model.attachments.get(10)!;
    expect(att).toMatchObject({ file: "2023/03/doc.pdf", alt: "", sizes: [] });
    expect("width" in att).toBe(false);
    expect("height" in att).toBe(false);
  });

  test("a missing _wp_attached_file falls back to the file in the metadata", async () => {
    const { model } = await loadFake({
      posts: [{ ID: 10, post_type: "attachment", post_status: "inherit" }],
      meta: [[10, "_wp_attachment_metadata", png]],
    });
    expect(model.attachments.get(10)?.file).toBe("2023/03/a2.png");
  });

  test("dimensions some plugins write as strings are numbers; anything not a number is 'not stated'", async () => {
    const { model } = await loadFake({
      posts: [
        { ID: 10, post_type: "attachment", post_status: "inherit" },
        { ID: 11, post_type: "attachment", post_status: "inherit" },
      ],
      meta: [
        [
          10,
          "_wp_attachment_metadata",
          'a:3:{s:5:"width";s:3:"640";s:6:"height";s:3:"480";s:5:"sizes";a:1:{s:1:"t";a:3:{s:4:"file";s:1:"f";s:5:"width";s:2:"64";s:6:"height";b:0;}}}',
        ],
        [11, "_wp_attachment_metadata", 'a:2:{s:5:"width";b:0;s:6:"height";s:0:"";}'],
      ],
    });
    expect(model.attachments.get(10)).toMatchObject({
      width: 640,
      height: 480,
      sizes: [{ name: "t", file: "f", width: 64, height: 0 }],
    });
    expect("width" in model.attachments.get(11)!).toBe(false);
    expect("height" in model.attachments.get(11)!).toBe(false);
  });

  test("damaged metadata, an empty size list and odd sizes do not break the attachment", async () => {
    const { model } = await loadFake({
      posts: [
        { ID: 10, post_type: "attachment", post_status: "inherit" },
        { ID: 11, post_type: "attachment", post_status: "inherit" },
        { ID: 12, post_type: "attachment", post_status: "inherit" },
      ],
      meta: [
        [10, "_wp_attachment_metadata", 'a:1:{s:5:"width";i:9;'],
        [11, "_wp_attachment_metadata", 'a:2:{s:5:"width";i:9;s:5:"sizes";a:0:{}}'],
        [
          12,
          "_wp_attachment_metadata",
          'a:1:{s:5:"sizes";a:2:{s:1:"a";s:1:"x";s:1:"b";a:1:{s:4:"file";s:1:"f";}}}',
        ],
      ],
    });
    expect(model.attachments.get(10)).toMatchObject({ sizes: [] });
    expect("width" in model.attachments.get(10)!).toBe(false);
    expect(model.attachments.get(11)).toMatchObject({ width: 9, sizes: [] });
    expect(model.attachments.get(12)?.sizes).toEqual([
      { name: "b", file: "f", width: 0, height: 0 },
    ]);
  });

  test("an attachment is loaded whatever postTypes and statuses say, and trashed ones are not", async () => {
    const posts: Partial<FakePost>[] = [
      { ID: 1, post_type: "page" },
      { ID: 2, post_type: "attachment", post_status: "private" },
      { ID: 3, post_type: "attachment", post_status: "trash" },
    ];
    const { model } = await loadFake({ posts }, { postTypes: ["page"], statuses: ["publish"] });
    expect([...model.posts.keys()]).toEqual([1]);
    expect([...model.attachments.keys()]).toEqual([2]);
  });
});

describe("terms", () => {
  test("a term id shared by two taxonomies is kept once, and said so", async () => {
    const { model, report } = await loadFake({
      posts: [{ ID: 1 }],
      taxonomies: [
        { ttId: 10, termId: 7, taxonomy: "category", name: "Shared" },
        { ttId: 11, termId: 7, taxonomy: "post_tag", name: "Shared" },
      ],
      relationships: [
        [1, 10],
        [1, 11],
      ],
    });
    expect(model.terms.size).toBe(1);
    expect(model.terms.get(7)?.taxonomy).toBe("category");
    expect(model.termsByPost.get(1)).toEqual([7]);
    expect(report.map((e) => [e.code, e.where])).toEqual([["wp.term-shared", "term:7"]]);
  });

  test("relationships to a taxonomy row that does not exist are ignored", async () => {
    const { model } = await loadFake({
      posts: [{ ID: 1 }],
      taxonomies: [{ ttId: 10, termId: 7, taxonomy: "category" }],
      relationships: [
        [1, 10],
        [1, 99],
      ],
    });
    expect(model.termsByPost.get(1)).toEqual([7]);
  });

  test("term order, then taxonomy id, decide the sequence", async () => {
    const { model } = await loadFake({
      posts: [{ ID: 1 }],
      taxonomies: [
        { ttId: 10, termId: 1, taxonomy: "category" },
        { ttId: 11, termId: 2, taxonomy: "category" },
        { ttId: 12, termId: 3, taxonomy: "category" },
      ],
      relationships: [
        [1, 12, 0],
        [1, 10, 2],
        [1, 11, 1],
      ],
    });
    expect(model.termsByPost.get(1)).toEqual([3, 2, 1]);
  });

  test("term meta: the last value wins, serialized values are unserialised, a missing table is fine", async () => {
    const withMeta = await loadFake({
      taxonomies: [{ ttId: 10, termId: 7, taxonomy: "category" }],
      termmeta: [
        [7, "color", "red"],
        [7, "color", "blue"],
        [7, "list", 'a:2:{i:0;s:1:"a";i:1;s:1:"b";}'],
        [99, "orphan", "x"],
      ],
    });
    expect(withMeta.model.terms.get(7)?.meta).toEqual({ color: "blue", list: ["a", "b"] });
    const without = await loadFake({
      taxonomies: [{ ttId: 10, termId: 7, taxonomy: "category" }],
      termmeta: null,
    });
    expect(without.model.terms.get(7)?.meta).toEqual({});
    expect(without.report).toEqual([]);
  });

  test("terms keep their name, slug, parent and taxonomy row id", async () => {
    const { model } = await loadFake({
      taxonomies: [
        { ttId: 20, termId: 5, taxonomy: "category", name: "Parent", slug: "parent" },
        { ttId: 21, termId: 6, taxonomy: "category", name: "Child", slug: "child", parent: 5 },
      ],
    });
    expect(model.terms.get(6)).toMatchObject({
      termId: 6,
      taxonomyId: 21,
      taxonomy: "category",
      name: "Child",
      slug: "child",
      parent: 5,
    });
  });
});

describe("users", () => {
  test("only the authors of loaded posts; author 0 and a missing row are skipped", async () => {
    const { model } = await loadFake({
      posts: [
        { ID: 1, post_author: 2 },
        { ID: 2, post_author: 0 },
        { ID: 3, post_author: 77 },
        { ID: 4, post_author: 5, post_type: "revision", post_status: "inherit" },
      ],
      users: [
        { ID: 1, user_nicename: "never-wrote-anything", display_name: "Nobody" },
        { ID: 2, user_nicename: "ann", display_name: "Ann" },
        { ID: 5, user_nicename: "only-a-revision", display_name: "Rev" },
      ],
    });
    expect([...model.users.keys()]).toEqual([2]);
  });
});

describe("users across more authors than one query holds", () => {
  test("come back in id order, however the authors were met and however many chunks it takes", async () => {
    // 520 authors, met in descending order: two chunks of an `in (…)` list, whose rows must still join
    // one map in id order.
    const ids = Array.from({ length: 520 }, (_, i) => 2000 - i);
    const { model } = await loadFake({
      posts: ids.map((author, i) => ({ ID: i + 1, post_author: author })),
      users: ids.map((id) => ({ ID: id, user_nicename: `u${id}`, display_name: `User ${id}` })),
    });
    expect([...model.users.keys()]).toEqual([...ids].sort((a, b) => a - b));
    expect(model.users.get(2000)).toEqual({ id: 2000, slug: "u2000", displayName: "User 2000" });
  });
});

describe("users, when the table is not there", () => {
  test("a multisite sub-site shares its network's users table: no names, and a note saying why", async () => {
    const { model, report } = await loadFake({ posts: [{ ID: 1, post_author: 2 }], users: null });
    expect(model.users.size).toBe(0);
    expect(model.posts.get(1)?.authorId).toBe(2);
    expect(report.map((e) => [e.code, e.where])).toEqual([["wp.users-missing", "table:wp_users"]]);
  });

  test("no authors, no users table needed, nothing to say", async () => {
    const { model, report } = await loadFake({ posts: [{ ID: 1, post_author: 0 }], users: null });
    expect(model.users.size).toBe(0);
    expect(report).toEqual([]);
  });
});

describe("menu items", () => {
  const item = (
    id: number,
    title: string,
    order: number,
    over: Partial<FakePost> = {},
  ): Partial<FakePost> => ({
    ID: id,
    post_type: "nav_menu_item",
    post_title: title,
    menu_order: order,
    ...over,
  });
  const itemMeta = (
    id: number,
    kind: string,
    objectId: number,
    extra: [string, string][] = [],
  ): [number, string, string][] => [
    [id, "_menu_item_type", kind],
    [id, "_menu_item_object_id", String(objectId)],
    [id, "_menu_item_object", kind === "taxonomy" ? "category" : "page"],
    [id, "_menu_item_menu_item_parent", "0"],
    [id, "_menu_item_url", ""],
    [id, "_menu_item_target", ""],
    [id, "_menu_item_classes", 'a:3:{i:0;s:0:"";i:1;s:4:"cta ";i:2;s:7:"two cls";}'],
    ...extra.map(([k, v]) => [id, k, v] as [number, string, string]),
  ];

  test("joined to their menu; draft items, orphans and other taxonomies do not appear", async () => {
    const { model, report } = await loadFake({
      posts: [
        item(1, "B", 2),
        item(2, "A", 1),
        item(3, "Draft", 3, { post_status: "draft" }),
        item(4, "Orphan", 4),
        item(5, "In two menus", 5),
        item(6, "Wrong taxonomy", 6),
      ],
      meta: [
        ...itemMeta(1, "post_type", 10),
        ...itemMeta(2, "custom", 2, [["_menu_item_url", "https://x.test/a"]]),
        ...itemMeta(5, "taxonomy", 9),
        ...itemMeta(6, "custom", 6),
      ],
      taxonomies: [
        { ttId: 20, termId: 200, taxonomy: "nav_menu" },
        { ttId: 21, termId: 100, taxonomy: "nav_menu" },
        { ttId: 22, termId: 300, taxonomy: "category" },
      ],
      relationships: [
        [1, 20],
        [2, 20],
        [3, 20],
        [5, 20],
        [5, 21],
        [6, 22],
      ],
    });
    expect(model.menuItems.map((i) => [i.menuTermId, i.order, i.id])).toEqual([
      [100, 5, 5],
      [200, 1, 2],
      [200, 2, 1],
      [200, 5, 5],
    ]);
    expect(report.map((e) => [e.code, e.where])).toEqual([
      ["wp.menu-item-orphan", "post:4"],
      ["wp.menu-item-orphan", "post:6"],
    ]);
  });

  test("fields come from the _menu_item_* meta; classes are split and cleaned", async () => {
    const { model } = await loadFake({
      posts: [item(1, "Home", 3)],
      meta: itemMeta(1, "post_type", 10, [
        ["_menu_item_target", "_blank"],
        ["_menu_item_menu_item_parent", "88"],
      ]).filter(([, k], i, all) => all.findLastIndex(([, kk]) => kk === k) === i),
      taxonomies: [{ ttId: 20, termId: 200, taxonomy: "nav_menu" }],
      relationships: [[1, 20]],
    });
    expect(model.menuItems).toEqual([
      {
        id: 1,
        menuTermId: 200,
        parent: 88,
        order: 3,
        title: "Home",
        kind: "post_type",
        objectId: 10,
        object: "page",
        url: "",
        classes: ["cta", "two", "cls"],
        target: "_blank",
      },
    ]);
  });

  test("a _menu_item_* key stored twice keeps its first row, as get_post_meta() answers", async () => {
    const { model } = await loadFake({
      posts: [item(1, "Home", 1)],
      meta: [
        [1, "_menu_item_type", "custom"],
        [1, "_menu_item_url", "https://x.test/first"],
        [1, "_menu_item_url", "https://x.test/second"],
        [1, "_menu_item_menu_item_parent", "5"],
        [1, "_menu_item_menu_item_parent", "6"],
        [1, "_menu_item_target", "_blank"],
        [1, "_menu_item_target", ""],
      ],
      taxonomies: [{ ttId: 20, termId: 200, taxonomy: "nav_menu" }],
      relationships: [[1, 20]],
    });
    expect(model.menuItems[0]).toMatchObject({
      url: "https://x.test/first",
      parent: 5,
      target: "_blank",
    });
  });

  test("items with the same menu_order keep the order of their ids, in every menu they are in", async () => {
    const { model } = await loadFake({
      posts: [item(9, "Nine", 1), item(3, "Three", 1), item(5, "Five", 1), item(7, "Seven", 0)],
      meta: [
        ...itemMeta(9, "custom", 1),
        ...itemMeta(3, "custom", 1),
        ...itemMeta(5, "custom", 1),
        ...itemMeta(7, "custom", 1),
      ],
      taxonomies: [
        { ttId: 20, termId: 200, taxonomy: "nav_menu" },
        { ttId: 21, termId: 100, taxonomy: "nav_menu" },
      ],
      relationships: [
        [9, 20],
        [3, 20],
        [5, 20],
        [7, 20],
        [5, 21],
        [3, 21],
      ],
    });
    expect(model.menuItems.map((i) => [i.menuTermId, i.order, i.id])).toEqual([
      [100, 1, 3],
      [100, 1, 5],
      [200, 0, 7],
      [200, 1, 3],
      [200, 1, 5],
      [200, 1, 9],
    ]);
  });

  test("a menu item with no meta at all still loads, with empty fields", async () => {
    const { model } = await loadFake({
      posts: [item(1, "Bare", 0)],
      taxonomies: [{ ttId: 20, termId: 200, taxonomy: "nav_menu" }],
      relationships: [[1, 20]],
    });
    expect(model.menuItems).toEqual([
      {
        id: 1,
        menuTermId: 200,
        parent: 0,
        order: 0,
        title: "Bare",
        kind: "",
        objectId: 0,
        object: "",
        url: "",
        classes: [],
        target: "",
      },
    ]);
  });

  test("menu items are loaded even when postTypes leaves them out of model.posts", async () => {
    const { model } = await loadFake(
      {
        posts: [item(1, "Home", 1), { ID: 2, post_type: "page" }],
        meta: itemMeta(1, "custom", 1),
        taxonomies: [{ ttId: 20, termId: 200, taxonomy: "nav_menu" }],
        relationships: [[1, 20]],
      },
      { postTypes: ["page"], metaKeys: () => false },
    );
    expect([...model.posts.keys()]).toEqual([2]);
    expect(model.menuItems.map((i) => i.id)).toEqual([1]);
  });

  test("menuItemTitle: the stored title, else the page's, else the term's, else nothing", async () => {
    const { model } = await loadFake({
      posts: [
        { ID: 10, post_type: "page", post_title: "About Us" },
        item(1, "", 1),
        item(2, "", 2),
        item(3, "", 3),
        item(4, "Custom label", 4),
        item(5, "", 5),
      ],
      meta: [
        ...itemMeta(1, "post_type", 10),
        ...itemMeta(2, "taxonomy", 20),
        ...itemMeta(3, "post_type", 999),
        ...itemMeta(4, "post_type", 10),
        ...itemMeta(5, "custom", 5),
      ],
      taxonomies: [
        { ttId: 30, termId: 200, taxonomy: "nav_menu" },
        { ttId: 31, termId: 20, taxonomy: "category", name: "News" },
      ],
      relationships: [
        [1, 30],
        [2, 30],
        [3, 30],
        [4, 30],
        [5, 30],
      ],
    });
    const titles = model.menuItems.map((i) => [i.id, menuItemTitle(model, i)]);
    expect(titles).toEqual([
      [1, "About Us"],
      [2, "News"],
      [3, ""],
      [4, "Custom label"],
      [5, ""],
    ]);
  });
});

describe("redirects", () => {
  const sources = (...s: [string, string, string?][]): string =>
    `a:${s.length}:{${s
      .map(([pattern, comparison, ignore], i) => {
        const fields: [string, string][] = [
          ["pattern", pattern],
          ["comparison", comparison],
          ...(ignore !== undefined ? ([["ignore", ignore]] as [string, string][]) : []),
        ];
        return `i:${i};a:${fields.length}:{${fields.map(([k, v]) => `s:${Buffer.byteLength(k)}:"${k}";s:${Buffer.byteLength(v)}:"${v}";`).join("")}}`;
      })
      .join("")}}`;

  test("no Rank Math table: no redirects, and that is not worth a report entry", async () => {
    const { model, report } = await loadFake({ redirections: null });
    expect(model.redirects).toEqual([]);
    expect(report).toEqual([]);
  });

  test("an empty table: no redirects", async () => {
    expect((await loadFake({ redirections: [] })).model.redirects).toEqual([]);
  });

  test("one redirect per source, with status, destination and the active flag", async () => {
    const { model, report } = await loadFake({
      redirections: [
        {
          id: 2,
          sources: sources(["old-a", "exact"], ["old-b/", "start"]),
          url_to: "https://x.test/new/",
          header_code: 301,
          status: "active",
        },
        {
          id: 1,
          sources: sources(["gone", "exact"]),
          url_to: "",
          header_code: 410,
          status: "active",
        },
        {
          id: 3,
          sources: sources(["trashed", "contains"]),
          url_to: "https://x.test/t/",
          header_code: 302,
          status: "trashed",
        },
        {
          id: 4,
          sources: sources(["off", "end"]),
          url_to: "https://x.test/o/",
          header_code: 307,
          status: "inactive",
        },
        {
          id: 5,
          sources: sources(["^p/(.*)$", "regex"]),
          url_to: "https://x.test/$1",
          header_code: "308",
          status: "active",
        },
      ],
    });
    expect(model.redirects).toEqual([
      { source: "gone", comparison: "exact", destination: "", status: 410, active: true },
      {
        source: "old-a",
        comparison: "exact",
        destination: "https://x.test/new/",
        status: 301,
        active: true,
      },
      {
        source: "old-b/",
        comparison: "start",
        destination: "https://x.test/new/",
        status: 301,
        active: true,
      },
      {
        source: "trashed",
        comparison: "contains",
        destination: "https://x.test/t/",
        status: 302,
        active: false,
      },
      {
        source: "off",
        comparison: "end",
        destination: "https://x.test/o/",
        status: 307,
        active: false,
      },
      {
        source: "^p/(.*)$",
        comparison: "regex",
        destination: "https://x.test/$1",
        status: 308,
        active: true,
      },
    ]);
    expect(report).toEqual([]);
  });

  test("'ignore case' is carried when set and absent otherwise", async () => {
    const { model } = await loadFake({
      redirections: [
        {
          id: 1,
          sources: sources(
            ["Case", "exact", "case"],
            ["plain", "exact", ""],
            ["other", "exact", "yes"],
          ),
          url_to: "https://x.test/",
          header_code: 301,
          status: "active",
        },
      ],
    });
    expect(model.redirects[0]).toEqual({
      source: "Case",
      comparison: "exact",
      destination: "https://x.test/",
      status: 301,
      active: true,
      ignoreCase: true,
    } as WpRedirect);
    expect("ignoreCase" in model.redirects[1]!).toBe(false);
    // Only Rank Math's own word for it counts.
    expect("ignoreCase" in model.redirects[2]!).toBe(false);
  });

  test("a source with no comparison at all is an exact match, and not worth a report entry", async () => {
    const { model, report } = await loadFake({
      redirections: [
        {
          id: 1,
          sources: 'a:1:{i:0;a:1:{s:7:"pattern";s:3:"old";}}',
          url_to: "https://x.test/",
          header_code: 301,
          status: "active",
        },
      ],
    });
    expect(model.redirects.map((r) => [r.source, r.comparison])).toEqual([["old", "exact"]]);
    expect(report).toEqual([]);
  });

  test("an unknown comparison is an exact match, and is reported", async () => {
    const { model, report } = await loadFake({
      redirections: [
        {
          id: 9,
          sources: sources(["x", "wildcard"]),
          url_to: "https://x.test/",
          header_code: 301,
          status: "active",
        },
      ],
    });
    expect(model.redirects.map((r) => r.comparison)).toEqual(["exact"]);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      severity: "warn",
      code: "wp.redirect-comparison-unknown",
      where: "redirect:9",
      data: { pattern: "x" },
    });
  });

  test("sources that do not parse, or hold nothing usable, are dropped with a report entry", async () => {
    const { model, report } = await loadFake({
      redirections: [
        {
          id: 1,
          sources: 'a:1:{i:0;a:1:{s:7:"pattern";s:9:"short";}}',
          url_to: "https://x.test/",
          header_code: 301,
          status: "active",
        },
        { id: 2, sources: null, url_to: "https://x.test/", header_code: 301, status: "active" },
        {
          id: 3,
          sources: "not serialized",
          url_to: "https://x.test/",
          header_code: 301,
          status: "active",
        },
        {
          id: 4,
          sources:
            'a:2:{i:0;a:1:{s:10:"comparison";s:5:"exact";}i:1;a:2:{s:7:"pattern";s:2:"ok";s:10:"comparison";s:5:"exact";}}',
          url_to: "https://x.test/",
          header_code: 301,
          status: "active",
        },
      ],
    });
    expect(model.redirects.map((r) => r.source)).toEqual(["ok"]);
    expect(report.map((e) => [e.code, e.where])).toEqual([
      ["wp.redirect-malformed", "redirect:1"],
      ["wp.redirect-malformed", "redirect:2"],
      ["wp.redirect-malformed", "redirect:3"],
      ["wp.redirect-malformed", "redirect:4"],
    ]);
  });

  test("a sources array with gaps in its keys is still read", async () => {
    const { model } = await loadFake({
      redirections: [
        {
          id: 1,
          sources:
            'a:2:{i:0;a:2:{s:7:"pattern";s:1:"a";s:10:"comparison";s:5:"exact";}i:5;a:2:{s:7:"pattern";s:1:"b";s:10:"comparison";s:5:"exact";}}',
          url_to: "https://x.test/",
          header_code: 301,
          status: "active",
        },
      ],
    });
    expect(model.redirects.map((r) => r.source)).toEqual(["a", "b"]);
  });

  test("a status that is not a number falls back to 301", async () => {
    const { model } = await loadFake({
      redirections: [
        {
          id: 1,
          sources: sources(["a", "exact"]),
          url_to: "https://x.test/",
          header_code: "",
          status: "active",
        },
      ],
    });
    expect(model.redirects[0]?.status).toBe(301);
  });
});

describe("rows are read in id order, whatever order the table stores them in", () => {
  test("posts, attachments and their meta", async () => {
    const { model } = await loadFake({
      posts: [
        { ID: 30, post_type: "post" },
        { ID: 12, post_type: "attachment", post_status: "inherit" },
        { ID: 10, post_type: "post" },
        { ID: 5, post_type: "attachment", post_status: "inherit" },
        { ID: 20, post_type: "post" },
      ],
      meta: [
        [10, "k", "third", 300],
        [10, "k", "first", 100],
        [10, "k", "second", 200],
        [10, "a", "z", 50],
      ],
    });
    expect([...model.posts.keys()]).toEqual([5, 10, 12, 20, 30]);
    expect([...model.attachments.keys()]).toEqual([5, 12]);
    expect(model.postMeta.get(10)).toEqual({ a: ["z"], k: ["first", "second", "third"] });
    expect(Object.keys(model.postMeta.get(10)!)).toEqual(["a", "k"]);
  });

  test("options", async () => {
    const { model } = await loadFake({
      options: { zebra: "z", apple: "a", mango: "m" },
      optionIds: { zebra: 300, apple: 100, mango: 200, siteurl: 1, home: 2 },
    });
    expect([...model.options.keys()]).toEqual(["siteurl", "home", "apple", "mango", "zebra"]);
  });

  test("terms, term meta, redirects", async () => {
    const { model } = await loadFake({
      taxonomies: [
        { ttId: 30, termId: 3, taxonomy: "category" },
        { ttId: 10, termId: 1, taxonomy: "category" },
        { ttId: 20, termId: 2, taxonomy: "category" },
      ],
      termmeta: [
        [1, "k", "last", 90],
        [1, "k", "first", 10],
      ],
      redirections: [
        {
          id: 9,
          sources: 'a:1:{i:0;a:2:{s:7:"pattern";s:1:"c";s:10:"comparison";s:5:"exact";}}',
          url_to: "/c",
          header_code: 301,
          status: "active",
        },
        {
          id: 2,
          sources: 'a:1:{i:0;a:2:{s:7:"pattern";s:1:"b";s:10:"comparison";s:5:"exact";}}',
          url_to: "/b",
          header_code: 301,
          status: "active",
        },
      ],
    });
    expect([...model.terms.keys()]).toEqual([1, 2, 3]);
    expect(model.terms.get(1)?.meta).toEqual({ k: "last" });
    expect(model.redirects.map((r) => r.source)).toEqual(["b", "c"]);
  });
});

describe("a table that is only a stub (the fixture helper's stand-in for an empty JSON file)", () => {
  const STUBBABLE = [
    "postmeta",
    "terms",
    "term_taxonomy",
    "term_relationships",
    "termmeta",
    "users",
    "rank_math_redirections",
  ];
  const data = (stub?: string): Fake => {
    const fake: Fake = { posts: [{ ID: 1, post_author: 3 }], redirections: [] };
    if (stub) fake.stubs = [stub];
    const noTerms = stub === "terms" || stub === "term_taxonomy";
    if (stub !== "postmeta") fake.meta = [[1, "k", "v"]];
    if (!noTerms) fake.taxonomies = [{ ttId: 10, termId: 7, taxonomy: "category" }];
    if (!noTerms && stub !== "term_relationships") fake.relationships = [[1, 10]];
    if (stub !== "termmeta") fake.termmeta = [[7, "c", "x"]];
    if (stub !== "users") fake.users = [{ ID: 3, user_nicename: "u", display_name: "U" }];
    return fake;
  };

  test("the baseline: with every table complete the model has all of it", async () => {
    const { model } = await loadFake(data());
    expect(model.postMeta.get(1)).toEqual({ k: ["v"] });
    expect(model.terms.get(7)?.meta).toEqual({ c: "x" });
    expect(model.termsByPost.get(1)).toEqual([7]);
    expect(model.users.get(3)?.displayName).toBe("U");
  });

  for (const stub of STUBBABLE) {
    test(`${stub} as a stub means no rows, not a failure`, async () => {
      const { model } = await loadFake(data(stub));
      expect(model.posts.get(1)?.authorId).toBe(3);
      expect(model.postMeta.size).toBe(stub === "postmeta" ? 0 : 1);
      const noTerms = stub === "terms" || stub === "term_taxonomy";
      expect(model.terms.size).toBe(noTerms ? 0 : 1);
      expect(model.termsByPost.size).toBe(noTerms || stub === "term_relationships" ? 0 : 1);
      expect(model.users.size).toBe(stub === "users" ? 0 : 1);
      if (!noTerms) expect(model.terms.get(7)?.meta).toEqual(stub === "termmeta" ? {} : { c: "x" });
      expect(model.redirects).toEqual([]);
    });
  }

  test("a stub menu setup yields no menu items, and no crash", async () => {
    const { model } = await loadFake({
      stubs: ["postmeta", "term_relationships"],
      posts: [{ ID: 1, post_type: "nav_menu_item", post_title: "Home" }],
    });
    expect(model.menuItems).toEqual([]);
    expect(model.posts.size).toBe(1);
  });

  test("everything stubbed at once still loads the posts and the options", async () => {
    const { model, report } = await loadFake({
      stubs: STUBBABLE,
      posts: [{ ID: 1, post_author: 3 }],
      redirections: [],
    });
    expect(model.posts.size).toBe(1);
    expect(model.options.size).toBe(2);
    expect(model.terms.size + model.users.size + model.postMeta.size + model.redirects.length).toBe(
      0,
    );
    expect(report.map((e) => e.code)).toEqual(["wp.users-missing"]);
  });
});

describe("a database that is empty of content", () => {
  test("loads to an empty model", async () => {
    const { model, report } = await loadFake({});
    expect(model.posts.size).toBe(0);
    expect(model.postMeta.size).toBe(0);
    expect(model.attachments.size).toBe(0);
    expect(model.terms.size).toBe(0);
    expect(model.termsByPost.size).toBe(0);
    expect(model.users.size).toBe(0);
    expect(model.menuItems).toEqual([]);
    expect(model.redirects).toEqual([]);
    expect([...model.options.keys()]).toEqual(["siteurl", "home"]);
    expect(report).toEqual([]);
  });

  test("without a report the same loads work and say nothing", async () => {
    const { db, done } = await fakeSite({
      posts: [{ ID: 1, post_date_gmt: "0000-00-00 00:00:00", post_date: "0000-00-00 00:00:00" }],
      redirections: [{ id: 1, sources: "junk", url_to: "", header_code: 301, status: "active" }],
    });
    const model = await loadModel(db);
    expect(model.posts.get(1)?.date).toBe("1970-01-01T00:00:00.000Z");
    expect(model.redirects).toEqual([]);
    await done();
  });
});

describe("publicUrl", () => {
  const site = { home: "https://x.test" };

  test("a published post of a public type has WordPress's short address, which redirects to its permalink", () => {
    // Checked against the two live sites: /?p=195 (a page), /?p=1078 (a project) and /?p=8819 (a post)
    // each answer 301 with the pretty address. The guid cannot stand in: it keeps the host a site had
    // when the post was made (finelinepainting.avunu.io, a staging copy), and encodes its `&`.
    for (const type of [
      "post",
      "page",
      "project",
      "service",
      "episode",
      "supporters_update",
      "captivate_podcast",
    ]) {
      expect(publicUrl(site, { id: 7, type, status: "publish" }), type).toBe("https://x.test/?p=7");
    }
  });

  test("a post nobody can visit has no address", () => {
    for (const status of [
      "draft",
      "private",
      "pending",
      "future",
      "inherit",
      "trash",
      "auto-draft",
    ]) {
      expect(publicUrl(site, { id: 7, type: "post", status }), status).toBeUndefined();
    }
    for (const type of [
      "nav_menu_item",
      "wp_block",
      "wp_template",
      "wp_template_part",
      "wp_navigation",
      "wp_global_styles",
      "revision",
      "attachment",
      "cc_block",
      "acf-field-group",
      "acf-field",
      "acf-post-type",
      "acf-taxonomy",
    ]) {
      expect(publicUrl(site, { id: 7, type, status: "publish" }), type).toBeUndefined();
    }
  });

  test("a site with no address has none to give", () => {
    expect(publicUrl({ home: "" }, { id: 7, type: "post", status: "publish" })).toBeUndefined();
  });

  test("on the two real sites, every published page, post and custom post has one, and nothing internal does", () => {
    for (const key of Object.keys(FIXTURES) as SiteKey[]) {
      const m = models[key];
      let withUrl = 0;
      for (const post of m.posts.values()) {
        const url = publicUrl(m.site, post);
        if (
          post.status === "publish" &&
          [
            "page",
            "post",
            "project",
            "service",
            "episode",
            "supporters_update",
            "captivate_podcast",
          ].includes(post.type)
        ) {
          expect(url, `${key} post ${post.id}`).toBe(`${m.site.home}/?p=${post.id}`);
          withUrl++;
        }
        if (post.type.startsWith("acf-") || post.type === "nav_menu_item")
          expect(url).toBeUndefined();
      }
      expect(withUrl, key).toBeGreaterThan(80);
    }
  });
});

describe("report entries about a post carry its address on the source site", () => {
  test("a post that has one is named by it, and a draft, an attachment or an internal type is not", async () => {
    const nodate = {
      post_date: null,
      post_date_gmt: null,
      post_modified: null,
      post_modified_gmt: null,
    };
    const broken = 'a:1:{i:0;s:9:"short";}';
    const { report } = await loadFake({
      posts: [
        { ID: 1, ...nodate },
        { ID: 2, post_type: "page", ...nodate },
        { ID: 3, post_status: "draft", ...nodate },
        { ID: 4, post_type: "wp_template", ...nodate },
        { ID: 5, post_type: "attachment", post_status: "inherit" },
        { ID: 6 },
      ],
      meta: [
        [5, "_wp_attachment_metadata", broken],
        [6, "damaged", broken],
      ],
    });
    expect(report.map((e) => [e.code, e.where, e.url])).toEqual([
      ["wp.date-invalid", "post:1", "https://x.test/?p=1"],
      ["wp.date-invalid", "post:2", "https://x.test/?p=2"],
      ["wp.date-invalid", "post:3", undefined],
      ["wp.date-invalid", "post:4", undefined],
      ["wp.serialized-malformed", "post:5", undefined],
      ["wp.serialized-malformed", "post:6", "https://x.test/?p=6"],
    ]);
    // Absent, not undefined: an entry without an address has no `url` key at all.
    expect("url" in report[2]!).toBe(false);
    expect("url" in report[4]!).toBe(false);
  });

  test("an entry about an option, a term or a table has none, since none exists", async () => {
    const { report } = await loadFake({
      options: { active_plugins: 'a:1:{i:0;s:9:"a/a.php";}' },
      taxonomies: [{ ttId: 10, termId: 7, taxonomy: "category" }],
      termmeta: [[7, "k", 'a:1:{i:0;s:9:"short";}']],
      users: null,
      posts: [{ ID: 1, post_author: 2 }],
    });
    expect(report.map((e) => [e.code, e.where])).toEqual([
      ["wp.serialized-malformed", "option:active_plugins"],
      ["wp.serialized-malformed", "term:7"],
      ["wp.users-missing", "table:wp_users"],
    ]);
    for (const e of report) expect("url" in e).toBe(false);
  });
});

describe("comments", () => {
  const posts: Partial<FakePost>[] = [
    { ID: 1 },
    { ID: 2 },
    { ID: 3 },
    { ID: 4, post_type: "give_payment" },
  ];

  test("the approved comments of a loaded post are reported, once per post, with how many", async () => {
    const { model, report } = await loadFake({
      posts,
      comments: [
        { id: 1, post: 1, approved: "1" },
        { id: 2, post: 1, approved: "1" },
        { id: 3, post: 1, approved: "1", type: "pingback" },
        { id: 4, post: 1, approved: "1", type: "trackback" },
        { id: 5, post: 2, approved: "1", type: "" },
        { id: 6, post: 3, approved: "1", type: "review" },
        // A visitor does not see these.
        { id: 7, post: 1, approved: "0" },
        { id: 8, post: 1, approved: "spam" },
        { id: 9, post: 1, approved: "trash" },
        { id: 10, post: 2, approved: "post-trashed" },
        // These are approved, and are not comments (a donation plugin's notes, a shop's order notes).
        { id: 11, post: 4, approved: "1", type: "give_sub_note" },
        { id: 12, post: 1, approved: "1", type: "order_note" },
        // A post that was not loaded.
        { id: 13, post: 99, approved: "1" },
      ],
    });
    expect(model.posts.size).toBe(4);
    expect(report.map((e) => [e.code, e.where, (e.data as { approved: number }).approved])).toEqual(
      [
        ["wp.comments-not-migrated", "post:1", 4],
        ["wp.comments-not-migrated", "post:2", 1],
        ["wp.comments-not-migrated", "post:3", 1],
      ],
    );
    expect(report[0]).toMatchObject({ severity: "warn", url: "https://x.test/?p=1" });
    // One message for every post, so that a report group reads as one thing; the number is data.
    expect(new Set(report.map((e) => e.message))).toEqual(
      new Set(["The post has approved comments, and comments are not migrated."]),
    );
  });

  test("a post that was not asked for is not reported, whatever its comments", async () => {
    const { report } = await loadFake(
      {
        posts: [
          { ID: 1, post_type: "page" },
          { ID: 2, post_type: "post" },
        ],
        comments: [
          { id: 1, post: 1, approved: "1" },
          { id: 2, post: 2, approved: "1" },
        ],
      },
      { postTypes: ["page"] },
    );
    expect(report.map((e) => e.where)).toEqual(["post:1"]);
  });

  test("a draft's comments are reported without an address, since nobody can visit it", async () => {
    const { report } = await loadFake({
      posts: [{ ID: 1, post_status: "draft" }],
      comments: [{ id: 1, post: 1, approved: "1" }],
    });
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ code: "wp.comments-not-migrated", where: "post:1" });
    expect("url" in report[0]!).toBe(false);
  });

  test("no comments table, or one that is only a stub, is nothing to say", async () => {
    expect((await loadFake({ posts })).report).toEqual([]);
    expect((await loadFake({ posts, stubs: ["comments"] })).report).toEqual([]);
    expect((await loadFake({ posts, comments: [] })).report).toEqual([]);
    expect(
      (await loadFake({ posts, comments: [{ id: 1, post: 1, approved: "0" }] })).report,
    ).toEqual([]);
  });

  test("with no report to put it in, the comments table is not even read", async () => {
    const { db, done } = await fakeSite({ posts, comments: [{ id: 1, post: 1, approved: "1" }] });
    const sql: string[] = [];
    const spy: WpDb = {
      prefix: db.prefix,
      table: (name) => db.table(name),
      close: () => db.close(),
      query: (text, params) => {
        sql.push(text);
        return db.query(text, params);
      },
    };
    await loadModel(spy);
    expect(sql.some((q) => /wp_comments/.test(q))).toBe(false);
    await loadModel(spy, { report: createReport() });
    expect(sql.some((q) => /wp_comments/.test(q))).toBe(true);
    await done();
  });

  test("on the real page, the comments reported are the ones its rendered page shows", async () => {
    // essays/the-cultural-captivity-of-the-gospel is post 8819 of anabaptistperspectives. Its committed
    // rendered page lists five comments. The fixture rows have no comments table, so the five (ids and
    // reply structure as the live database has them) go into a copy of the fixture, among rows a
    // visitor never sees.
    const html = readFixtureText("ap", "html/essays__the-cultural-captivity-of-the-gospel.html");
    const shown = [...html.matchAll(/id="comment-(\d+)"/g)]
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    expect(shown).toEqual([3032, 3034, 3046, 3049, 3050]);

    const { path } = await fixtureDb("ap");
    const copy = join(scratch, `ap-comments-${dbCounter++}.sqlite`);
    copyFileSync(path, copy);
    const sqlite = new Database(copy);
    sqlite.run(
      `create table wp_comments (comment_ID integer, comment_post_ID integer, comment_author text, comment_content text, comment_approved text, comment_type text, comment_parent integer)`,
    );
    const insert = sqlite.prepare(
      `insert into wp_comments values (?, ?, 'Someone', 'Hello', ?, ?, ?)`,
    );
    const parents: Record<number, number> = { 3032: 0, 3034: 3032, 3046: 0, 3049: 0, 3050: 3049 };
    for (const id of shown) insert.run(id, 8819, "1", "comment", parents[id]!);
    insert.run(3047, 8819, "0", "comment", 0); // awaiting moderation
    insert.run(3048, 8819, "spam", "comment", 0);
    insert.run(3051, 8819, "trash", "comment", 0);
    insert.run(9001, 773, "trash", "comment", 0); // another post, nothing approved
    sqlite.close();

    const db = await openDb(`sqlite:${copy}`);
    const report = createReport();
    const model = await loadModel(db, { report });
    await db.close();
    expect(model.posts.get(8819)).toMatchObject({ type: "post", status: "publish" });
    const entries = report.entries().filter((e) => e.code === "wp.comments-not-migrated");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: "warn",
      where: "post:8819",
      url: "https://anabaptistperspectives.org/?p=8819",
      data: { approved: shown.length },
    });
  });
});

describe("the unscaled original of an attachment", () => {
  /** `serialize()` of a flat PHP array of strings and integers. */
  const php = (fields: Record<string, string | number>): string =>
    `a:${Object.keys(fields).length}:{${Object.entries(fields)
      .map(
        ([k, v]) =>
          `s:${Buffer.byteLength(k)}:"${k}";${typeof v === "number" ? `i:${v};` : `s:${Buffer.byteLength(v)}:"${v}";`}`,
      )
      .join("")}}`;
  const attachment = (
    id: number,
    meta: [string, string][],
  ): [Partial<FakePost>, [number, string, string][]] => [
    { ID: id, post_type: "attachment", post_status: "inherit" },
    meta.map(([k, v]) => [id, k, v]),
  ];
  const load = async (
    items: [Partial<FakePost>, [number, string, string][]][],
    opts: LoadOptions = {},
  ) => loadFake({ posts: items.map(([p]) => p), meta: items.flatMap(([, m]) => m) }, opts);

  test("is the name WordPress keeps in original_image, beside the file, as its own path is", async () => {
    const { model } = await load([
      attachment(1, [
        ["_wp_attached_file", "2023/03/photo-scaled.jpg"],
        [
          "_wp_attachment_metadata",
          php({
            width: 2560,
            height: 1706,
            file: "2023/03/photo-scaled.jpg",
            original_image: "photo.jpg",
          }),
        ],
      ]),
      // A site that does not use year and month folders (every attachment of fineline).
      attachment(2, [
        ["_wp_attached_file", "photo-scaled.jpg"],
        [
          "_wp_attachment_metadata",
          php({ width: 2560, file: "photo-scaled.jpg", original_image: "photo.jpg" }),
        ],
      ]),
      // A media plugin's file, which is an address, not a path.
      attachment(3, [
        ["_wp_attached_file", "https://media.x.test/up/photo-scaled.jpg"],
        ["_wp_attachment_metadata", php({ width: 2560, original_image: "photo.jpg" })],
      ]),
      // No _wp_attached_file: the file comes from the metadata, and the original from beside it.
      attachment(4, [
        [
          "_wp_attachment_metadata",
          php({ width: 2560, file: "2024/01/a-scaled.png", original_image: "a.png" }),
        ],
      ]),
    ]);
    expect([1, 2, 3, 4].map((id) => originalFileOf(model.attachments.get(id)!))).toEqual([
      "2023/03/photo.jpg",
      "photo.jpg",
      "https://media.x.test/up/photo.jpg",
      "2024/01/a.png",
    ]);
  });

  test("is absent, not empty, when WordPress made no scaled copy or says nothing usable", async () => {
    const { model } = await load([
      attachment(1, [
        ["_wp_attached_file", "2023/03/photo.jpg"],
        ["_wp_attachment_metadata", php({ width: 800, file: "2023/03/photo.jpg" })],
      ]),
      attachment(2, [
        ["_wp_attached_file", "2023/03/b.jpg"],
        ["_wp_attachment_metadata", php({ width: 800, original_image: "" })],
      ]),
      attachment(3, [
        ["_wp_attached_file", "2023/03/c.jpg"],
        ["_wp_attachment_metadata", php({ width: 800, original_image: 5 })],
      ]),
      attachment(4, [["_wp_attached_file", "2023/03/d.jpg"]]),
    ]);
    for (const id of [1, 2, 3, 4]) {
      const a = model.attachments.get(id)!;
      expect(originalFileOf(a), `attachment ${id}`).toBeUndefined();
      expect("originalFile" in a, `attachment ${id}`).toBe(false);
    }
  });

  test("an attachment's file that is an address is reported, and one that is a path is not", async () => {
    const { model, report } = await load([
      attachment(1, [["_wp_attached_file", "2023/03/a.jpg"]]),
      attachment(2, [["_wp_attached_file", "https://media.x.test/a.jpg"]]),
      attachment(3, [["_wp_attached_file", "//cdn.x.test/b.jpg"]]),
      attachment(4, [["_wp_attachment_metadata", php({ file: "http://media.x.test/c.jpg" })]]),
      attachment(5, [["_wp_attached_file", "folder/https-not-an-address.jpg"]]),
    ]);
    expect(report.map((e) => [e.severity, e.code, e.where, e.url])).toEqual([
      ["info", "wp.attachment-file-absolute", "post:2", "https://media.x.test/a.jpg"],
      ["info", "wp.attachment-file-absolute", "post:3", "//cdn.x.test/b.jpg"],
      ["info", "wp.attachment-file-absolute", "post:4", "http://media.x.test/c.jpg"],
    ]);
    expect(report[0]!.data).toEqual({ file: "https://media.x.test/a.jpg" });
    // The value itself is still as stored.
    expect(model.attachments.get(2)!.file).toBe("https://media.x.test/a.jpg");
  });

  test("a load narrowed to the types a run migrates reads every attachment, menu item and term in full", async () => {
    // The documented way to run: postTypes names the content, and what the content refers to (media,
    // menus, terms) must still come out whole, whether or not attachments are among the posts.
    const full = {
      posts: [
        { ID: 1, post_type: "page" },
        { ID: 10, post_type: "attachment", post_status: "inherit", post_parent: 1 },
        { ID: 20, post_type: "nav_menu_item", post_title: "Home", menu_order: 1 },
      ] as Partial<FakePost>[],
      meta: [
        [10, "_wp_attached_file", "2023/03/a-scaled.png"],
        [10, "_wp_attachment_image_alt", "An alt text"],
        [
          10,
          "_wp_attachment_metadata",
          php({ width: 2560, height: 1700, file: "2023/03/a-scaled.png", original_image: "a.png" }),
        ],
        [20, "_menu_item_type", "custom"],
        [20, "_menu_item_url", "https://x.test/home"],
      ] as [number, string, string][],
      taxonomies: [
        { ttId: 30, termId: 300, taxonomy: "nav_menu" },
        { ttId: 31, termId: 310, taxonomy: "media_folder" },
      ],
      relationships: [
        [20, 30],
        [10, 31],
      ] as [number, number][],
    };
    const everything = await loadFake(full);
    for (const narrow of [
      { postTypes: ["page"] },
      { postTypes: [] },
      { postTypes: ["page"], metaKeys: () => false },
    ] satisfies LoadOptions[]) {
      const { model } = await loadFake(full, narrow);
      expect(model.attachments.get(10), JSON.stringify(narrow)).toEqual(
        everything.model.attachments.get(10)!,
      );
      expect(model.attachments.get(10)).toMatchObject({
        file: "2023/03/a-scaled.png",
        alt: "An alt text",
        width: 2560,
        height: 1700,
        parent: 1,
        originalFile: "2023/03/a.png",
      });
      expect(model.menuItems).toEqual(everything.model.menuItems);
      expect(model.menuItems[0]).toMatchObject({
        id: 20,
        menuTermId: 300,
        url: "https://x.test/home",
      });
      // The terms of an attachment come with it, though it is not among the posts.
      expect(model.termsByPost.get(10), JSON.stringify(narrow)).toEqual([310]);
    }
  });
});

describe("HTML entities in what WordPress stores", () => {
  test("decodeEntities turns character references into the characters, and touches nothing else", () => {
    expect(decodeEntities("Missions &amp; Evangelism")).toBe("Missions & Evangelism");
    expect(decodeEntities("Jesus&#039; kingdom &#x27;x&#X27; &quot;q&quot; &apos;")).toBe(
      `Jesus' kingdom 'x' "q" '`,
    );
    expect(decodeEntities("&lt;b&gt; &amp;lt;")).toBe("<b> &lt;"); // once, not twice
    expect(decodeEntities("a&nbsp;b &hellip; &copy; &mdash; &eacute;")).toBe("a b … © — é");
    expect(decodeEntities("&#128512; &#x1F3A8;")).toBe("😀 🎨");
    // What is not a reference is left alone: a bare ampersand, an unknown name, markup, whitespace.
    for (const plain of [
      "Colors & Options",
      "AT&T",
      "a && b",
      "&",
      "&;",
      "&foo; and &bar;",
      // A reference needs its semicolon, as it does for PHP's html_entity_decode.
      "R&amp D",
      "&copy 2020",
      "1 &gt 0 &lt 2",
      "&#35 and &#x41",
      "<b>bold</b> & <i>it</i>",
      "line one\r\nline two\t\ttabbed  ",
      "",
      "no entities here",
    ]) {
      expect(decodeEntities(plain), JSON.stringify(plain)).toBe(plain);
    }
    // Markup next to a reference stays markup (text), only the reference is decoded.
    expect(decodeEntities("<b>x</b> &amp; y")).toBe("<b>x</b> & y");
    expect(decodeEntities("a\r\nb &amp; c\t")).toBe("a\r\nb & c\t");
  });

  test("the real values: terms, authors and the site's description are stored encoded, post titles are not", () => {
    // Why menuItemTitle and the rest return text as stored, and why a consumer must decode exactly once.
    const ap = models.ap;
    const terms = [...ap.terms.values()].filter((t) => /&amp;/.test(t.name));
    expect(terms.map((t) => t.name).sort()).toEqual([
      "Diversity &amp; Race",
      "Heritage &amp; Tradition",
      "Missions &amp; Evangelism",
      "Study &amp; Education",
      "Testimony &amp; Life Experience",
    ]);
    expect(terms.map((t) => decodeEntities(t.name)).sort()).toEqual([
      "Diversity & Race",
      "Heritage & Tradition",
      "Missions & Evangelism",
      "Study & Education",
      "Testimony & Life Experience",
    ]);
    expect(
      [...ap.users.values()]
        .filter((u) => /&amp;/.test(u.displayName))
        .map((u) => decodeEntities(u.displayName))
        .sort(),
    ).toEqual(["Clyde & Judi Martin", "Heiko & Sabine Klien", "Steve & Deb Yoder"]);
    expect(ap.site.description).toBe("Encouraging allegiance to Jesus&#039; sacrificial kingdom");
    expect(decodeEntities(ap.site.description)).toBe(
      "Encouraging allegiance to Jesus' sacrificial kingdom",
    );
    // A title an administrator typed is stored as typed, and decoding it again changes nothing.
    const titles = [...models.fineline.posts.values()].filter((p) => p.title.includes("&"));
    expect(titles.length).toBeGreaterThan(3);
    for (const post of titles)
      expect(decodeEntities(post.title), `post ${post.id}`).toBe(post.title);
  });

  test("menuItemTitle gives the title as stored, entities and all, so decode it to show it as text", () => {
    const m = models.ap;
    const encoded = m.menuItems.filter((i) => /&amp;/.test(menuItemTitle(m, i)));
    // Three taxonomy items with no title of their own: the term's name, as the terms table has it.
    expect(encoded.map((i) => i.id)).toEqual([1885, 1888, 1889]);
    for (const item of encoded) {
      expect(item.title).toBe("");
      expect(item.kind).toBe("taxonomy");
      expect(menuItemTitle(m, item)).toBe(m.terms.get(item.objectId)!.name);
      expect(decodeEntities(menuItemTitle(m, item))).not.toContain("&amp;");
    }
  });
});

describe("the MySQL shapes of a value, on the real fixtures", () => {
  // MySQL answers a DATETIME with a Date (read as UTC) and the zero date with an Invalid Date. The
  // fixture databases are SQLite, which answers with text, so the default suite never ran the branch
  // production uses. This puts the MySQL shape in front of the same rows.
  const DATE_COLUMNS = ["post_date", "post_date_gmt", "post_modified", "post_modified_gmt"];
  function asMysql(db: WpDb): WpDb {
    return {
      prefix: db.prefix,
      table: (name) => db.table(name),
      close: () => db.close(),
      async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        const rows = await db.query<Record<string, unknown>>(sql, params);
        return rows.map((row) => {
          const out = { ...row };
          for (const column of DATE_COLUMNS) {
            if (!(column in out)) continue;
            const v = out[column];
            // The zero date is NULL in the fixture's rows; MySQL says Invalid Date.
            out[column] =
              v === null
                ? new Date(Number.NaN)
                : typeof v === "string"
                  ? new Date(`${v.replace(" ", "T")}Z`)
                  : v;
          }
          return out;
        }) as T[];
      },
    };
  }

  test("a Date for a DATETIME, and an Invalid Date for the zero date, give the model that text does", async () => {
    for (const key of Object.keys(FIXTURES) as SiteKey[]) {
      let invalid = 0;
      const shaped = asMysql(databases[key]);
      const spy: WpDb = {
        ...shaped,
        query: async <T>(sql: string, params?: unknown[]) => {
          const rows = await shaped.query<Record<string, unknown>>(sql, params);
          for (const r of rows)
            if (r.post_date_gmt instanceof Date && Number.isNaN(r.post_date_gmt.getTime()))
              invalid++;
          return rows as T[];
        },
      };
      const mysql = await loadModel(spy);
      expect(invalid, key).toBeGreaterThan(5); // the zero dates really did arrive as Invalid Dates
      expect([...mysql.posts], key).toEqual([...models[key].posts]);
    }
  });

  test("integers as bigint, which a driver can be told to return, give the same model", async () => {
    for (const key of Object.keys(FIXTURES) as SiteKey[]) {
      const db = databases[key];
      const bigints: WpDb = {
        prefix: db.prefix,
        table: (name) => db.table(name),
        close: () => db.close(),
        async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
          const rows = await db.query<Record<string, unknown>>(sql, params);
          return rows.map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [
                k,
                Number.isInteger(v) ? BigInt(v as number) : v,
              ]),
            ),
          ) as T[];
        },
      };
      const model = await loadModel(bigints);
      const plain = models[key];
      expect([...model.posts], key).toEqual([...plain.posts]);
      expect([...model.attachments], key).toEqual([...plain.attachments]);
      expect([...model.terms], key).toEqual([...plain.terms]);
      expect([...model.termsByPost], key).toEqual([...plain.termsByPost]);
      expect([...model.users], key).toEqual([...plain.users]);
      expect(model.menuItems, key).toEqual(plain.menuItems);
      expect(model.redirects, key).toEqual(plain.redirects);
    }
  });

  test("a Date that is Invalid in every date column falls to the epoch and says so", async () => {
    const { db, done } = await fakeSite({ posts: [{ ID: 1 }] });
    const dateless: WpDb = {
      ...db,
      query: async <T>(sql: string, params?: unknown[]) => {
        const rows = await db.query<Record<string, unknown>>(sql, params);
        return rows.map((r) =>
          "post_date" in r
            ? {
                ...r,
                post_date: new Date(Number.NaN),
                post_date_gmt: new Date(Number.NaN),
                post_modified: new Date(Number.NaN),
                post_modified_gmt: new Date(Number.NaN),
              }
            : r,
        ) as T[];
      },
    };
    const report = createReport();
    const model = await loadModel(dateless, { report });
    expect(model.posts.get(1)).toMatchObject({
      date: "1970-01-01T00:00:00.000Z",
      modified: "1970-01-01T00:00:00.000Z",
    });
    expect(report.entries().map((e) => [e.code, e.where])).toEqual([["wp.date-invalid", "post:1"]]);
    await done();
  });
});

// ── A real MySQL/MariaDB server, when one is configured ─────────────────────────────────────────
// Skipped unless WP2JX_TEST_DB is set. With the throwaway server up (scripts/dev-db.sh start):
//   WP2JX_TEST_DB=mysql://root@127.0.0.1:3399/s212682_fineline bun test --isolate tests/wp/model.test.ts
// The model is loaded from the server and from the fixture SQLite whose site url matches, and the
// two must agree; the AP database (s142094_anabapti) works the same way.

const LIVE = process.env.WP2JX_TEST_DB;
/** Keys the fixture builder deliberately left out of the cut (scripts/make-fixtures.ts). */
const NOT_FIXTURED = new Set([
  "_edit_lock",
  "_edit_last",
  "_pingme",
  "_encloseme",
  "_wp_old_slug",
  "_wp_old_date",
]);

describe.skipIf(!LIVE)("MySQL and SQLite agree (WP2JX_TEST_DB)", () => {
  test("the same site, the same posts, the same meta, the same everything else", async () => {
    const live = await openDb(LIVE!);
    try {
      const mysql = await loadModel(live);
      const siteKey = (Object.keys(FIXTURES) as SiteKey[]).find(
        (k) => FIXTURES[k].site.url === mysql.site.url,
      );
      expect(siteKey, `no fixture for ${mysql.site.url}`).toBeDefined();
      const lite = models[siteKey!];

      // Site fields.
      expect(mysql.site).toEqual(lite.site);

      // Every post the fixture holds is on the server, field for field. (The fixture keeps at most
      // 100 posts of a non-structural type, so the server may hold more.)
      const missing: number[] = [];
      for (const [id, post] of lite.posts) {
        const other = mysql.posts.get(id);
        if (!other) missing.push(id);
        else expect(other, `post ${id}`).toEqual(post);
      }
      expect(missing).toEqual([]);
      // Where the fixture is complete (no post type was capped), nothing extra is loaded either.
      const types = new Set([...lite.posts.values()].map((p) => p.type));
      const capped = [...types].filter((type) => postsOfType(lite, type).length >= 100);
      for (const type of types) {
        if (capped.includes(type)) continue;
        expect(
          postsOfType(mysql, type).map((p) => p.id),
          type,
        ).toEqual(postsOfType(lite, type).map((p) => p.id));
      }

      // Meta: every fixtured key matches value for value; the server may hold more rows, but only
      // of the kinds the fixture builder was told to leave out.
      let compared = 0;
      for (const [id, fixtureMeta] of lite.postMeta) {
        const serverMeta = mysql.postMeta.get(id) ?? {};
        for (const [k, values] of Object.entries(fixtureMeta)) {
          expect(serverMeta[k], `post ${id} meta ${k}`).toEqual(values);
          compared++;
        }
        for (const k of Object.keys(serverMeta))
          if (!(k in fixtureMeta))
            expect(NOT_FIXTURED.has(k), `post ${id} extra meta ${k}`).toBe(true);
      }
      expect(compared).toBeGreaterThan(1000);

      // Everything derived from the rest of the tables.
      expect([...mysql.terms]).toEqual([...lite.terms]);
      for (const [id, terms] of lite.termsByPost)
        expect(mysql.termsByPost.get(id), `terms of ${id}`).toEqual(terms);
      for (const [id, user] of lite.users) expect(mysql.users.get(id)).toEqual(user);
      for (const [id, attachment] of lite.attachments)
        expect(mysql.attachments.get(id), `attachment ${id}`).toEqual(attachment);
      expect(mysql.menuItems).toEqual(lite.menuItems);
      expect(mysql.redirects).toEqual(lite.redirects);
      // The options the fixture kept have the same text on the server.
      for (const [name, value] of lite.options) expect(mysql.options.get(name), name).toBe(value);
    } finally {
      await live.close();
    }
  });
});

describe.skipIf(!LIVE)(
  "what the live database says about comments and dates (WP2JX_TEST_DB)",
  () => {
    test("the approved comments a visitor can read are reported, per post, with the live counts", async () => {
      const live = await openDb(LIVE!);
      try {
        const report = createReport();
        const model = await loadModel(live, { report });
        const entries = report.entries().filter((e) => e.code === "wp.comments-not-migrated");
        const approved = (e: ReportEntry) => (e.data as { approved: number }).approved;
        if (model.site.url === "https://anabaptistperspectives.org") {
          // Counted on the server: 113 approved comments on 31 posts, 23 episodes and 1 supporters_update,
          // and two approved `give_sub_note` rows that are a donation plugin's notes and not comments.
          expect(entries).toHaveLength(55);
          expect(entries.reduce((n, e) => n + approved(e), 0)).toBe(113);
          const byType = new Map<string, number>();
          for (const e of entries) {
            const type = model.posts.get(Number(e.where!.slice("post:".length)))!.type;
            byType.set(type, (byType.get(type) ?? 0) + approved(e));
          }
          expect(Object.fromEntries(byType)).toEqual({
            post: 68,
            episode: 44,
            supporters_update: 1,
          });
          // post 8819 is the page whose rendered fixture lists five comments; 727 shows nine.
          expect(entries.find((e) => e.where === "post:8819")).toMatchObject({
            data: { approved: 5 },
            url: "https://anabaptistperspectives.org/?p=8819",
          });
          expect(approved(entries.find((e) => e.where === "post:727")!)).toBe(9);
        } else {
          // fineline's 708 comments are all trashed or awaiting moderation.
          expect(entries).toEqual([]);
        }
      } finally {
        await live.close();
      }
    });

    test("the drafts with no GMT date come out in the site's timezone, as the other column says", async () => {
      const live = await openDb(LIVE!);
      try {
        const model = await loadModel(live);
        // Where a draft was created and last modified in the same instant, post_modified_gmt is the truth.
        const rows = await live.query<{ id: number; date: Date; gmt: Date }>(
          `select ID as id, post_date as date, post_modified_gmt as gmt from ${live.table("posts")}
          where post_date_gmt = '0000-00-00 00:00:00' and post_modified_gmt <> '0000-00-00 00:00:00' and post_date = post_modified`,
        );
        expect(rows.length).toBeGreaterThan(3);
        for (const row of rows) {
          const post = model.posts.get(row.id);
          if (post) expect(post.date, `post ${row.id}`).toBe(row.gmt.toISOString());
        }
      } finally {
        await live.close();
      }
    });
  },
);
