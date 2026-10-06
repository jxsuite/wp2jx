import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unserialize as psUnserialize } from "php-serialize";
import {
  downloadMedia,
  type MediaFile,
  type MediaPlan,
  planMedia,
  sniffMediaType,
} from "../src/media.ts";
import { createReport } from "../src/report.ts";
import type { WpAttachment, WpModel, WpPost } from "../src/types.ts";
import { parseBlocks, walkBlocks } from "../src/wp/blocks.ts";
import { openDb } from "../src/wp/db.ts";
import { loadModel } from "../src/wp/model.ts";
import { fixtureDb, fixtureDir, readFixtureJson } from "./helpers/fixture-db.ts";

// ── What the two fixture sites are ───────────────────────────────────────────────────────────────
// Everything the planner is held to is worked out here from the committed JSON rows and the
// `php-serialize` package, never from the planner or from `loadModel`'s attachments: the number of
// attachments, which file each one is, which names it answers to. The model is only the planner's
// input, and the source of the loaded posts whose text is scanned for addresses; the one other
// piece of shared code is the block parser, which reads attribute values out of post content.

interface PostRow {
  ID: number;
  post_type: string;
  post_status: string;
  post_mime_type: string;
  post_content: string;
  post_excerpt: string;
  guid: string;
}
interface MetaRow {
  meta_id: number;
  post_id: number;
  meta_key: string;
  meta_value: string | null;
}

interface Truth {
  id: number;
  guid: string;
  mime: string;
  alt: string;
  /** Relative to uploads, as stored. */
  file: string;
  /** `original_image`, joined to the directory of `file`. */
  original?: string;
  /** Every `sizes` entry, joined to the directory of `file`. */
  sizes: string[];
  width?: number;
  height?: number;
  /** The largest pixel count among the `sizes` entries. */
  largestSizeArea: number;
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);
const encodePath = (rel: string): string => rel.split("/").map(encodeURIComponent).join("/");

/** A name as it must land on disk, for the characters these fixtures actually hold. */
const diskName = (rel: string): string =>
  rel.replace(/[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}._~/-]+/gu, "-");

function readTruth(site: string): Truth[] {
  const posts = readFixtureJson<PostRow[]>(site, "rows/posts.json");
  const metas = readFixtureJson<MetaRow[]>(site, "rows/postmeta.json").sort(
    (a, b) => a.meta_id - b.meta_id,
  );
  const first = new Map<string, string | null>();
  for (const m of metas) {
    const key = `${m.post_id}\0${m.meta_key}`;
    if (!first.has(key)) first.set(key, m.meta_value);
  }
  const out: Truth[] = [];
  for (const post of posts) {
    // Only a published attachment is shipped: ap's 670 private ones are social-login avatars.
    if (post.post_type !== "attachment" || !["inherit", "publish"].includes(post.post_status))
      continue;
    const raw = first.get(`${post.ID}\0_wp_attachment_metadata`);
    const metadata = (raw ? psUnserialize(raw) : {}) as Record<string, any>;
    let file = first.get(`${post.ID}\0_wp_attached_file`) || String(metadata.file ?? "");
    // Two of anabaptistperspectives' files are addresses on its media host, which serves the
    // uploads folder from its root: the path is the file.
    const absolute = /^https?:\/\//.test(file);
    if (absolute) file = decodeURIComponent(new URL(file).pathname.slice(1));
    const dir = dirOf(file);
    const sizes = (
      metadata.sizes && typeof metadata.sizes === "object" ? Object.values(metadata.sizes) : []
    ) as { file: string; width: number; height: number }[];
    const truth: Truth = {
      id: post.ID,
      guid: post.guid,
      mime: post.post_mime_type,
      alt: first.get(`${post.ID}\0_wp_attachment_image_alt`) ?? "",
      file,
      sizes: sizes.filter((s) => s.file).map((s) => dir + s.file),
      largestSizeArea: Math.max(0, ...sizes.map((s) => Number(s.width) * Number(s.height))),
    };
    if (typeof metadata.original_image === "string" && metadata.original_image !== "") {
      truth.original = dir + metadata.original_image;
    }
    const w = Number(metadata.width);
    const h = Number(metadata.height);
    // An SVG's metadata holds its root's width/height as written (inches, or 100 for `100%`), not pixels.
    if (w > 0 && h > 0 && post.post_mime_type !== "image/svg+xml") {
      truth.width = w;
      truth.height = h;
    }
    out.push(truth);
  }
  return out;
}

const SITES = {
  fineline: {
    host: "finelinepainting.pro",
    /** Where its uploads are served from (and so what content points at). */
    bases: ["https://finelinepainting.pro/wp-content/uploads/"],
  },
  ap: {
    host: "anabaptistperspectives.org",
    // 1,793 of 1,794 guids name the media host, which serves the uploads folder from its root; the
    // site's own wp-content/uploads is where old content still points.
    bases: [
      "https://media.anabaptistperspectives.org/",
      "https://anabaptistperspectives.org/wp-content/uploads/",
    ],
  },
} as const;
type SiteName = keyof typeof SITES;
const SITE_NAMES = Object.keys(SITES) as SiteName[];

const models = {} as Record<SiteName, WpModel>;
const truths = {} as Record<SiteName, Truth[]>;
const plans = {} as Record<SiteName, MediaPlan>;
for (const site of SITE_NAMES) {
  const { url, prefix } = await fixtureDb(site);
  const db = await openDb(url, { prefix });
  models[site] = await loadModel(db);
  await db.close();
  truths[site] = readTruth(site);
  plans[site] = planMedia(models[site]);
}

const fileOfId = (plan: MediaPlan, id: number): MediaFile => {
  const found = plan.files.find((f) => f.attachmentIds.includes(id));
  if (!found) throw new Error(`no planned file for attachment ${id}`);
  return found;
};

// ── Synthetic models, for what the fixtures lack ─────────────────────────────────────────────────

const SITE = "https://example.com";

function fakeModel(
  attachments: WpAttachment[],
  over: { url?: string; home?: string; options?: Record<string, string> } = {},
): WpModel {
  const url = over.url ?? SITE;
  return {
    site: {
      url,
      home: over.home ?? url,
      name: "",
      description: "",
      permalinkStructure: "",
      showOnFront: "posts",
      pageOnFront: 0,
      pageForPosts: 0,
      activePlugins: [],
      theme: "",
      language: "en-US",
    },
    options: new Map(Object.entries(over.options ?? {})),
    posts: new Map(),
    postMeta: new Map(),
    attachments: new Map(attachments.map((a) => [a.id, a])),
    terms: new Map(),
    termsByPost: new Map(),
    users: new Map(),
    menuItems: [],
    redirects: [],
  };
}

const MIMES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  csv: "text/csv",
  zip: "application/zip",
};

function att(id: number, file: string, over: Partial<WpAttachment> = {}): WpAttachment {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return {
    id,
    url: `${SITE}/wp-content/uploads/${encodePath(file.toWellFormed())}`,
    mime: MIMES[ext] ?? "application/octet-stream",
    title: "",
    alt: "",
    caption: "",
    file,
    sizes: [],
    parent: 0,
    ...over,
  };
}

const size = (file: string, width: number, height: number, name = `${width}x${height}`) => ({
  name,
  file,
  width,
  height,
});

// ── Counts, from the rows ────────────────────────────────────────────────────────────────────────

describe.each(SITE_NAMES)("planMedia over %s: what is planned", (site) => {
  const plan = plans[site];
  const truth = truths[site];
  const byId = new Map(truth.map((t) => [t.id, t]));

  test("the rows hold the attachments the model loaded, and every published one is planned", () => {
    const loaded = models[site].attachments.size;
    // ap's 670 private attachments are the only ones not published.
    const unpublished = site === "ap" ? 670 : 0;
    expect(truth.length).toBe(loaded - unpublished);
    expect(plan.stats.attachments).toBe(loaded);
    expect(plan.stats.unplanned).toBe(unpublished);
    expect(plan.unplanned.length).toBe(unpublished);
    expect(plan.stats.extraFiles).toBe(0);
    for (const t of truth) expect(plan.mediaFor(t.id)).toBeDefined();
  });

  test("there is one file per distinct file name, and none of them is a derivative", () => {
    const distinct = new Set(truth.map((t) => t.file));
    expect(plan.files.length).toBe(distinct.size);
    expect(new Set(plan.files.map((f) => f.file))).toEqual(distinct);
    // Every attachment id is on exactly one file.
    const ids = plan.files.flatMap((f) => f.attachmentIds);
    expect(ids.length).toBe(truth.length);
    expect(new Set(ids).size).toBe(truth.length);
    // Not one planned file is a size, or the unscaled upload of an attachment that has a scaled copy.
    const sizeNames = new Set(truth.flatMap((t) => t.sizes));
    const ownFiles = distinct;
    for (const f of plan.files) {
      if (sizeNames.has(f.file)) expect(ownFiles.has(f.file)).toBe(true);
    }
    const unscaled = truth.flatMap((t) =>
      t.original && t.original !== t.file ? [t.original] : [],
    );
    for (const name of unscaled) expect(plan.files.some((f) => f.file === name)).toBe(false);
  });

  test("the collapse removes names, not pictures: derivative names outnumber the files they fold into", () => {
    // Only an image's sizes are names to answer for: a PDF's thumbnails are not planned.
    const names = new Set(
      truth
        .filter((t) => t.mime.startsWith("image/"))
        .flatMap((t) => [...(t.original ? [t.original] : []), ...t.sizes]),
    );
    for (const t of truth) names.delete(t.file);
    expect(plan.stats.aliases).toBeGreaterThanOrEqual(names.size);
    expect(plan.stats.aliases).toBeGreaterThan(plan.files.length);
  });

  test("each file is the attachment's own full-size file, with its own type and dimensions", () => {
    for (const f of plan.files) {
      const t = byId.get(f.attachmentIds[0]!)!;
      expect(f.file).toBe(t.file);
      expect(f.mime).toBe(t.mime);
      expect(f.width).toBe(t.width);
      expect(f.height).toBe(t.height);
      expect(f.destPath).toBe(`public/media/${diskName(t.file)}`);
      expect(f.publicPath).toBe(`/media/${diskName(t.file)}`);
    }
  });

  test("mediaFor answers with the public path, the dimensions and the alt text, empty when there is none", () => {
    let withAlt = 0;
    let withoutAlt = 0;
    for (const t of truth) {
      const ref = plan.mediaFor(t.id)!;
      expect(ref.src).toBe(`/media/${diskName(t.file)}`);
      expect(ref.alt).toBe(t.alt);
      expect(ref.width).toBe(t.width);
      expect(ref.height).toBe(t.height);
      if (t.alt === "") withoutAlt++;
      else withAlt++;
    }
    expect(withAlt).toBeGreaterThan(0);
    expect(withoutAlt).toBeGreaterThan(0);
    expect(plan.mediaFor(-1)).toBeUndefined();
    expect(plan.mediaFor(99_999_999)).toBeUndefined();
  });

  test("every address, path and type in the plan is well formed", () => {
    for (const f of plan.files) {
      for (const url of [f.sourceUrl, ...f.fallbackUrls!]) {
        const parsed = new URL(url);
        expect(["http:", "https:"]).toContain(parsed.protocol);
        // The escapes survive: what is asked for decodes to the file WordPress holds.
        expect(decodeURIComponent(parsed.pathname).endsWith(`/${f.file}`)).toBe(true);
      }
      expect(new Set([f.sourceUrl, ...f.fallbackUrls!]).size).toBe(1 + f.fallbackUrls!.length);
      expect(f.destPath).toMatch(/^public\/media\/[^/]/);
      expect(f.destPath.split("/")).not.toContain("..");
      expect(f.destPath.split("/")).not.toContain("");
      expect(f.destPath).not.toContain("\\");
      expect(f.publicPath).toBe(f.destPath.replace(/^public\/media/, "/media"));
      expect(f.mime).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
      expect(f.attachmentIds).toEqual([...f.attachmentIds].sort((a, b) => a - b));
    }
  });

  test("a file with no dimensions in its metadata has none in the plan", () => {
    const without = truth.filter((t) => t.width === undefined);
    expect(without.length).toBeGreaterThan(0);
    for (const t of without) {
      const ref = plan.mediaFor(t.id)!;
      expect("width" in ref).toBe(false);
      expect("height" in ref).toBe(false);
    }
  });
});

describe("planMedia over the fixtures: the headline numbers", () => {
  test("finelinepainting: 1,233 attachments, 114 with an unscaled upload kept beside them", () => {
    const t = truths.fineline;
    expect(t.length).toBe(1233);
    expect(plans.fineline.files.length).toBe(1233);
    expect(t.filter((x) => x.original).length).toBe(114);
    expect(t.filter((x) => /-scaled\.[a-z]+$/.test(x.file)).length).toBe(112);
    expect(t.filter((x) => /-e\d{10,}/.test(x.file)).length).toBe(44);
  });

  test("anabaptistperspectives: 1,794 attachments of which 1,124 are published, 105 with an unscaled upload, 2 whose file is an address", () => {
    const t = truths.ap;
    expect(t.length).toBe(1124);
    expect(plans.ap.files.length).toBe(1124);
    expect(t.filter((x) => x.original).length).toBe(105);
    expect(models.ap.attachments.size).toBe(1794);
    const absolute = [...models.ap.attachments.values()].filter((a) => /^https?:\/\//.test(a.file));
    expect(absolute.map((a) => a.id)).toEqual([8832, 14607]);
  });

  test("both plans are deterministic: the same model plans the same files in the same order", () => {
    for (const site of SITE_NAMES) {
      expect(planMedia(models[site]).files).toEqual(plans[site].files);
    }
  });
});

// ── Resolving addresses ──────────────────────────────────────────────────────────────────────────

/** The spellings one address takes in content: how WordPress writes it, and how people and plugins mangle it. */
function spellings(base: string, name: string): string[] {
  const url = new URL(base);
  const encoded = encodePath(name);
  const www = url.host.startsWith("www.") ? url.host : `www.${url.host}`;
  return [
    `${base}${encoded}`,
    `${base}${name}`,
    `http://${url.host}${url.pathname}${encoded}`,
    `//${url.host}${url.pathname}${encoded}`,
    `https://${url.host.toUpperCase()}${url.pathname}${encoded}`,
    `https://${www}${url.pathname}${encoded}`,
    `${base}${encoded}?ver=6.4#top`,
    ` ${base}${encoded}\n`,
  ];
}

describe.each(SITE_NAMES)("mediaForUrl over %s: every name an attachment answers to", (site) => {
  const plan = plans[site];
  const truth = truths[site];

  // A name claimed by exactly one attachment has one right answer. (Both fixtures have no other kind:
  // WordPress refuses to reuse a file name, sizes included.)
  const claims = new Map<string, number[]>();
  const namesOf = (t: Truth): string[] => [
    t.file,
    ...(t.original ? [t.original] : []),
    // A PDF's preview images are not the PDF; see the test below.
    ...(t.mime.startsWith("image/") ? t.sizes : []),
  ];
  for (const t of truth) {
    for (const name of new Set(namesOf(t))) claims.set(name, [...(claims.get(name) ?? []), t.id]);
  }

  test("no name is claimed by two attachments", () => {
    expect([...claims].filter(([, ids]) => ids.length > 1)).toEqual([]);
  });

  test("the file, the unscaled upload and each size resolve to the attachment's file, in every spelling", () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const t of truth) {
      const expected = `/media/${diskName(t.file)}`;
      for (const name of namesOf(t)) {
        for (const base of SITES[site].bases) {
          for (const url of spellings(base, name)) {
            checked++;
            const got = plan.mediaForUrl(url)?.src;
            if (got !== expected) wrong.push(`${t.id} ${JSON.stringify(url)} -> ${got}`);
          }
        }
      }
    }
    expect(wrong.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(40_000);
  });

  test("a resolved address carries the dimensions of the shipped file and the attachment's alt text", () => {
    for (const t of truth.slice(0, 400)) {
      const ref = plan.mediaForUrl(`${SITES[site].bases[0]}${encodePath(t.file)}`)!;
      expect(ref.alt).toBe(t.alt);
      expect(ref.width).toBe(t.width);
      expect(ref.height).toBe(t.height);
    }
  });

  test("a name asked for never makes the plan's lists longer when it resolves", () => {
    const fresh = planMedia(models[site]);
    for (const t of truth) fresh.mediaForUrl(`${SITES[site].bases[0]}${encodePath(t.file)}`);
    expect(fresh.unresolved).toEqual([]);
    expect(fresh.external).toEqual([]);
  });
});

describe("mediaForUrl: the family of one picture, from the real attachments", () => {
  const fl = plans.fineline;
  const up = (name: string): string =>
    `https://finelinepainting.pro/wp-content/uploads/${encodePath(name)}`;

  test("a scaled upload ships its scaled copy; the unscaled upload and every size fold into it (fineline 105)", () => {
    const t = truths.fineline.find((x) => x.id === 105)!;
    expect(t.file).toBe("paintroller-repairs-isolated-black-background-yellow-paints-scaled.jpg");
    expect(t.original).toBe("paintroller-repairs-isolated-black-background-yellow-paints.jpg");
    expect(t.sizes.length).toBeGreaterThan(3);
    const file = fileOfId(fl, 105);
    expect(file.file).toBe(t.file);
    expect(file.width).toBe(2560);
    expect(file.height).toBe(1706);
    for (const name of [t.file, t.original!, ...t.sizes]) {
      expect(fl.mediaForUrl(up(name))?.src).toBe(file.publicPath);
    }
    // The unscaled upload is not a file of its own.
    expect(fl.files.some((f) => f.file === t.original)).toBe(false);
  });

  test("an edited image ships the edit, even when WordPress kept a size bigger than it (fineline 931)", () => {
    const t = truths.fineline.find((x) => x.id === 931)!;
    expect(t.file).toBe("interior-house-painting-in-lebanon-pa-e1698763417403.jpeg");
    expect(t.width! * t.height!).toBeLessThan(t.largestSizeArea);
    const file = fileOfId(fl, 931);
    expect(file.file).toBe(t.file);
    expect([file.width, file.height]).toEqual([1199, 788]);
    // The stale, bigger sizes are names of this picture, not candidates to ship.
    for (const name of t.sizes) expect(fl.mediaForUrl(up(name))?.src).toBe(file.publicPath);
    expect(fl.files.some((f) => t.sizes.includes(f.file))).toBe(false);
  });

  test("an edit of a scaled copy keeps the edit; its unscaled upload is the picture before the edit (fineline 1792, 4107)", () => {
    for (const id of [1792, 4107]) {
      const t = truths.fineline.find((x) => x.id === id)!;
      expect(t.file).toMatch(/-scaled-e\d{13}\.jpe?g$/);
      expect(t.original).toBeDefined();
      const file = fileOfId(fl, id);
      expect(file.file).toBe(t.file);
      expect(fl.mediaForUrl(up(t.original!))?.src).toBe(file.publicPath);
    }
  });

  test("the picture before an edit answers to the edit: the name without the stamp (fineline 814)", () => {
    // Content still says `professional-paint-services-in-lebanon-and-lancaster-pa.jpeg`, the name the
    // file had before the media editor saved `…-pa-e1698162036799.jpeg` beside it.
    const t = truths.fineline.find((x) => x.id === 814)!;
    expect(t.file).toBe(
      "professional-paint-services-in-lebanon-and-lancaster-pa-e1698162036799.jpeg",
    );
    const before = "professional-paint-services-in-lebanon-and-lancaster-pa.jpeg";
    expect(truths.fineline.some((x) => x.file === before || x.original === before)).toBe(false);
    expect(fl.mediaForUrl(up(before))?.src).toBe(fileOfId(fl, 814).publicPath);
  });

  test("a size the metadata never listed folds into its family by name (fineline 105 at 640x427)", () => {
    const t = truths.fineline.find((x) => x.id === 105)!;
    const unlisted = "paintroller-repairs-isolated-black-background-yellow-paints-640x427.jpg";
    expect(t.sizes).not.toContain(unlisted);
    expect(fl.mediaForUrl(up(unlisted))?.src).toBe(fileOfId(fl, 105).publicPath);
    // The scaled name with a size too.
    const scaledSize =
      "paintroller-repairs-isolated-black-background-yellow-paints-scaled-640x427.jpg";
    expect(fl.mediaForUrl(up(scaledSize))?.src).toBe(fileOfId(fl, 105).publicPath);
  });

  test("a renamed file still answers to its guid's name, and to the scaled copy of it (fineline 617)", () => {
    // An image-renaming plugin changed `file` and left the guid, `Judah-edited.jpg`; old content names
    // the scaled copy of the old name.
    const t = truths.fineline.find((x) => x.id === 617)!;
    expect(t.file).not.toContain("Judah");
    expect(t.guid).toBe("https://finelinepainting.pro/wp-content/uploads/Judah-edited.jpg");
    const want = fileOfId(fl, 617).publicPath;
    expect(fl.mediaForUrl(up("Judah-edited.jpg"))?.src).toBe(want);
    expect(fl.mediaForUrl(up("Judah-edited-scaled.jpg"))?.src).toBe(want);
    expect(fl.mediaForUrl(up("Judah-edited-300x200.jpg"))?.src).toBe(want);
  });

  test("WordPress's -rotated copy of an upload with an EXIF orientation is a family member too", () => {
    const plan = planMedia(
      fakeModel([
        att(1, "2023/03/foo-rotated.jpg", {
          url: `${SITE}/wp-content/uploads/2023/03/foo.jpg`,
          originalFile: "2023/03/foo.jpg",
          sizes: [size("foo-rotated-300x200.jpg", 300, 200)],
        }),
      ]),
    );
    const up2 = (n: string): string => `${SITE}/wp-content/uploads/2023/03/${n}`;
    expect(plan.files.map((f) => f.file)).toEqual(["2023/03/foo-rotated.jpg"]);
    // The rotated copy is the picture as it should be seen; the upload is its source, and answers to it.
    for (const name of [
      "foo.jpg",
      "foo-rotated.jpg",
      "foo-rotated-300x200.jpg",
      "foo-rotated-640x427.jpg",
      "foo-640x427.jpg",
    ]) {
      expect(plan.mediaForUrl(up2(name))?.src).toBe("/media/2023/03/foo-rotated.jpg");
    }
    const preferred = planMedia(
      fakeModel([att(1, "2023/03/foo-rotated.jpg", { originalFile: "2023/03/foo.jpg" })]),
      { preferUnscaled: true },
    );
    // An unscaled upload is only swapped for the `-scaled` copy it is the source of: a rotated copy has no
    // EXIF orientation left, and the upload does, which an image pipeline that drops metadata shows sideways.
    expect(preferred.files[0]!.file).toBe("2023/03/foo-rotated.jpg");
  });

  test("every planned file carries its fallbacks, an empty list when it has none", () => {
    for (const site of SITE_NAMES) {
      for (const f of plans[site].files) expect(Array.isArray(f.fallbackUrls)).toBe(true);
    }
    // finelinepainting serves everything from the site, so only the one on the staging host has another place to look;
    // anabaptistperspectives' media host leaves the site's own folder as one for every file.
    expect(plans.fineline.files.filter((f) => f.fallbackUrls!.length > 0).length).toBe(1);
    expect(plans.ap.files.every((f) => f.fallbackUrls!.length === 1)).toBe(true);
    expect(
      planMedia(fakeModel([]), { extraUrls: [`${SITE}/wp-content/uploads/a.jpg`] }).files[0]!
        .fallbackUrls,
    ).toEqual([]);
  });

  test("a name that is nobody's does not fall into a family by accident", () => {
    // `Lehigh-County-PA.png` is a real URL in content; the attachment that exists is `Lehigh-County-PA-1.png`,
    // a different upload (WordPress numbers a name that is taken).
    expect(truths.fineline.some((x) => x.file === "Lehigh-County-PA-1.png")).toBe(true);
    const fresh = planMedia(models.fineline);
    expect(fresh.mediaForUrl(up("Lehigh-County-PA.png"))).toBeUndefined();
    expect(fresh.mediaForUrl(up("Lehigh-County-PA-300x200.png"))).toBeUndefined();
    expect(fresh.unresolved).toEqual([
      up("Lehigh-County-PA.png"),
      up("Lehigh-County-PA-300x200.png"),
    ]);
  });

  test("an attachment's name beats another attachment's size of the same name, and a name is not matched by its case alone when the exact one exists", () => {
    const a = att(1, "2023/03/foo.jpg", { sizes: [size("foo-300x200.jpg", 300, 200)] });
    const b = att(2, "2023/03/foo-300x200.jpg");
    const plan = planMedia(fakeModel([a, b]));
    expect(plan.files.length).toBe(2);
    expect(plan.mediaForUrl(`${SITE}/wp-content/uploads/2023/03/foo-300x200.jpg`)?.src).toBe(
      "/media/2023/03/foo-300x200.jpg",
    );
    expect(plan.mediaForUrl(`${SITE}/wp-content/uploads/2023/03/foo-150x150.jpg`)?.src).toBe(
      "/media/2023/03/foo.jpg",
    );
    const cased = planMedia(fakeModel([att(1, "2023/03/Foo.jpg"), att(2, "2023/03/foo.jpg")]));
    // Each exact spelling finds its own file; on disk the later of the two gives way.
    expect(cased.mediaForUrl(`${SITE}/wp-content/uploads/2023/03/Foo.jpg`)?.src).toBe(
      "/media/2023/03/Foo.jpg",
    );
    expect(cased.mediaForUrl(`${SITE}/wp-content/uploads/2023/03/foo.jpg`)?.src).toBe(
      "/media/2023/03/foo-2.jpg",
    );
    // …and an address that differs only in case from a lone file still finds it.
    const lone = planMedia(fakeModel([att(1, "2023/03/Foo.jpg")]));
    expect(lone.mediaForUrl(`${SITE}/wp-content/uploads/2023/03/FOO.JPG`)?.src).toBe(
      "/media/2023/03/Foo.jpg",
    );
  });

  test("the second attachment of a file shares its file, and a name claimed twice goes to the lower tier, then the lower id", () => {
    const plan = planMedia(
      fakeModel([
        att(7, "2023/03/dup.jpg", { alt: "seven", width: 10, height: 10 }),
        att(3, "2023/03/dup.jpg", { alt: "three", width: 10, height: 10 }),
      ]),
    );
    expect(plan.files.length).toBe(1);
    expect(plan.files[0]!.attachmentIds).toEqual([3, 7]);
    expect(plan.mediaFor(7)?.alt).toBe("seven");
    expect(plan.mediaFor(3)?.alt).toBe("three");
    expect(plan.mediaFor(7)?.src).toBe(plan.mediaFor(3)?.src);
    expect(plan.mediaForUrl(`${SITE}/wp-content/uploads/2023/03/dup.jpg`)?.alt).toBe("three");
  });
});

describe("mediaForUrl: PDFs, audio and other attachments", () => {
  test("a PDF is planned as itself; its preview images are not the PDF (anabaptistperspectives 11602)", () => {
    const t = truths.ap.find((x) => x.id === 11602)!;
    expect(t.mime).toBe("application/pdf");
    expect(t.sizes.length).toBeGreaterThan(0);
    const file = fileOfId(plans.ap, 11602);
    expect(file.file).toBe(t.file);
    expect(file.mime).toBe("application/pdf");
    expect(
      plans.ap.mediaForUrl(`https://media.anabaptistperspectives.org/${encodePath(t.file)}`)?.src,
    ).toBe(file.publicPath);
    const preview = `https://media.anabaptistperspectives.org/${encodePath(t.sizes[0]!)}`;
    const fresh = planMedia(models.ap);
    expect(fresh.mediaForUrl(preview)).toBeUndefined();
    expect(fresh.unresolved).toEqual([preview]);
  });

  test("audio, CSV, ZIP and PDF files keep their types", () => {
    const mimes = new Set(plans.ap.files.map((f) => f.mime));
    for (const m of ["application/pdf", "text/csv", "audio/mpeg", "image/svg+xml", "image/webp"]) {
      expect(mimes.has(m)).toBe(true);
    }
    expect(plans.fineline.files.some((f) => f.mime === "application/zip")).toBe(true);
  });
});

describe("mediaForUrl: hosts", () => {
  test("a guid on a media host is where to fetch from, and content on the site's own host still resolves (anabaptistperspectives)", () => {
    const plan = plans.ap;
    let onMedia = 0;
    let elsewhere = 0;
    for (const f of plan.files) {
      if (new URL(f.sourceUrl).host === "media.anabaptistperspectives.org") onMedia++;
      else elsewhere++;
    }
    // 1,793 of 1,794 guids name the media host (docs/design.md); the other is on the site.
    // Of the 1,124 published ones; the 670 private avatars are not planned.
    expect(onMedia).toBe(1123);
    expect(elsewhere).toBe(1);
    const t = truths.ap.find((x) => x.id === 692)!;
    expect(fileOfId(plan, 692).sourceUrl).toBe(
      `https://media.anabaptistperspectives.org/${encodePath(t.file)}`,
    );
    const viaSite = plan.mediaForUrl(
      `https://anabaptistperspectives.org/wp-content/uploads/${encodePath(t.file)}`,
    );
    expect(viaSite?.src).toBe(plan.mediaFor(692)?.src);
    // The site's own uploads folder is the fallback.
    expect(fileOfId(plan, 692).fallbackUrls).toEqual([
      `https://anabaptistperspectives.org/wp-content/uploads/${encodePath(t.file)}`,
    ]);
  });

  test("a guid an offload plugin left on the site's host still finds the file, on the media host the library lives on (anabaptistperspectives 16206)", () => {
    // Its guid is https://anabaptistperspectives.org/wp-content/uploads/Reed-Merino-profile.png, which 404s;
    // the file is at https://media.anabaptistperspectives.org/Reed-Merino-profile.png, where the other 1,793 are.
    const file = fileOfId(plans.ap, 16206);
    expect(file.sourceUrl).toBe(
      "https://anabaptistperspectives.org/wp-content/uploads/Reed-Merino-profile.png",
    );
    expect(file.fallbackUrls).toEqual([
      "https://media.anabaptistperspectives.org/Reed-Merino-profile.png",
    ]);
    // Either host's address resolves.
    for (const url of file.fallbackUrls!.concat(file.sourceUrl))
      expect(plans.ap.mediaForUrl(url)?.src).toBe(file.publicPath);
  });

  test("a file whose own `file` is an address is planned relative to the host it names (anabaptistperspectives 8832, 14607)", () => {
    const plan = plans.ap;
    for (const [id, name] of [
      [8832, "download.jpg"],
      [14607, "IMG_20250618_1907359143.jpg"],
    ] as const) {
      const file = fileOfId(plan, id);
      expect(file.file).toBe(name);
      expect(file.sourceUrl).toBe(`https://media.anabaptistperspectives.org/${name}`);
      expect(file.destPath).toBe(`public/media/${name}`);
      expect(plan.mediaForUrl(`https://media.anabaptistperspectives.org/${name}`)?.src).toBe(
        file.publicPath,
      );
    }
  });

  test("a guid on a dead staging host is tried first, and the site's own address after it (fineline 29)", () => {
    const file = fileOfId(plans.fineline, 29);
    expect(file.sourceUrl).toBe(
      "https://finelinepainting.avunu.io/wp-content/uploads/Screen-Shot-2022-10-08-at-12.49.17-PM.png",
    );
    expect(file.fallbackUrls).toEqual([
      "https://finelinepainting.pro/wp-content/uploads/Screen-Shot-2022-10-08-at-12.49.17-PM.png",
    ]);
    // Content written on the staging host resolves too.
    expect(
      plans.fineline.mediaForUrl(
        "https://finelinepainting.avunu.io/wp-content/uploads/Screen-Shot-2022-10-08-at-12.49.17-PM-300x143.png",
      )?.src,
    ).toBe(file.publicPath);
  });

  test("a guid that is a page address says nothing about where the file is (fineline 130, 166)", () => {
    for (const id of [130, 166]) {
      const t = truths.fineline.find((x) => x.id === id)!;
      expect(t.guid).not.toMatch(/\.(jpe?g|png)$/);
      expect(fileOfId(plans.fineline, id).sourceUrl).toBe(
        `https://finelinepainting.pro/wp-content/uploads/${encodePath(t.file)}`,
      );
    }
  });

  test("every file is fetched from where its guid says when the guid is a file address, else from the site", () => {
    for (const site of SITE_NAMES) {
      const wrong: string[] = [];
      for (const t of truths[site]) {
        const file = fileOfId(plans[site], t.id);
        const dir = dirOf(t.file);
        let expected = `https://${SITES[site].host}/wp-content/uploads/${encodePath(t.file)}`;
        const guid = new URL(t.guid);
        const path = decodeURIComponent(guid.pathname);
        const guidDir = path.slice(0, path.lastIndexOf("/") + 1);
        const named = path.slice(path.lastIndexOf("/") + 1);
        if (
          guid.search === "" &&
          /\.(?:jpe?g|png|gif|webp|svg|pdf|mp3|csv|zip)$/i.test(named) &&
          guidDir.endsWith(`/${dir}`) &&
          !/^https?:\/\//.test(file.file)
        ) {
          const prefix = guidDir.slice(0, guidDir.length - dir.length);
          const origin =
            guid.host === SITES[site].host ? `https://${SITES[site].host}` : guid.origin;
          expected = `${origin}${prefix}${encodePath(t.file)}`;
        }
        // The two files that are addresses are planned against the host they name.
        if (/^https?:\/\//.test(models[site].attachments.get(t.id)!.file))
          expected = file.sourceUrl;
        if (file.sourceUrl !== expected) wrong.push(`${t.id}: ${file.sourceUrl} != ${expected}`);
      }
      expect(wrong.slice(0, 5)).toEqual([]);
    }
  });

  test("an address on a host the site does not own is left alone, whatever its path is (anabaptistperspectives)", () => {
    const plan = planMedia(models.ap);
    const t = truths.ap.find((x) => x.id === 692)!;
    const foreign = [
      `https://example.org/wp-content/uploads/${encodePath(t.file)}`,
      `https://cdn.example.net/${encodePath(t.file)}`,
      "https://churchplantersforum.org/wp-content/uploads/2023/02/1921-and-1964-Edsel-Burdge.pdf",
      "https://img.youtube.com/vi/MT8mSQKnx38/maxresdefault.jpg",
    ];
    for (const url of foreign) expect(plan.mediaForUrl(url)).toBeUndefined();
    expect(plan.external).toEqual(foreign);
    expect(plan.unresolved).toEqual([]);
    // Asked again, listed once.
    plan.mediaForUrl(foreign[0]!);
    expect(plan.external.length).toBe(foreign.length);
  });

  test("a hostname's case, a leading www and a default port do not make a site's address a stranger", () => {
    const plan = planMedia(models.fineline);
    const name = encodePath(truths.fineline[0]!.file);
    for (const host of [
      "FineLinePainting.PRO",
      "www.finelinepainting.pro",
      "finelinepainting.pro:443",
    ]) {
      expect(plan.mediaForUrl(`https://${host}/wp-content/uploads/${name}`)?.src).toBe(
        plan.mediaFor(truths.fineline[0]!.id)?.src,
      );
    }
    // A port that is not the default is another server.
    expect(
      plan.mediaForUrl(`https://finelinepainting.pro:8443/wp-content/uploads/${name}`),
    ).toBeUndefined();
    expect(plan.external).toEqual([`https://finelinepainting.pro:8443/wp-content/uploads/${name}`]);
  });

  test("addresses that are not web addresses, and links that are not media, are recorded nowhere", () => {
    const plan = planMedia(models.fineline);
    for (const url of [
      "",
      "   ",
      "data:image/png;base64,iVBORw0KGgo=",
      "mailto:someone@finelinepainting.pro",
      "javascript:void(0)",
      "tel:+17175551212",
      "#top",
      "https://finelinepainting.pro/blog/",
      "https://finelinepainting.pro/wp-content/uploads/cwicly/css/cc-post-5246.css?ver=1",
      "https://finelinepainting.pro/wp-content/plugins/cwicly/assets/js/darkmode/dist/darkmode.min.js",
      "https://finelinepainting.pro/wp-admin/post.php?post=4097&action=edit",
      "https://finelinepainting.pro/?attachment_id=166",
      "https://www.youtube.com/watch?v=abc",
      "http://[bad",
    ]) {
      expect(plan.mediaForUrl(url)).toBeUndefined();
    }
    expect(plan.unresolved).toEqual([]);
    expect(plan.external).toEqual([]);
  });

  test("a relative address is read against the site", () => {
    const plan = planMedia(models.fineline);
    const t = truths.fineline[5]!;
    const want = plan.mediaFor(t.id)?.src;
    expect(plan.mediaForUrl(`/wp-content/uploads/${encodePath(t.file)}`)?.src).toBe(want);
    expect(plan.mediaForUrl(`wp-content/uploads/${encodePath(t.file)}`)?.src).toBe(want);
  });

  test("the lists a plan keeps are copies: changing one changes nothing", () => {
    const plan = planMedia(models.fineline);
    plan.mediaForUrl("https://finelinepainting.pro/wp-content/uploads/nobody-1.jpg");
    plan.unresolved.push("tampered");
    expect(plan.unresolved).toEqual([
      "https://finelinepainting.pro/wp-content/uploads/nobody-1.jpg",
    ]);
  });
});

// ── Options ──────────────────────────────────────────────────────────────────────────────────────

describe("planMedia: where files go and how they are referenced", () => {
  const one = (over: Parameters<typeof planMedia>[1] = {}) =>
    planMedia(fakeModel([att(1, "2023/03/foo.jpg", { width: 800, height: 600 })]), over);

  test("the defaults are public/media on disk and /media in markup", () => {
    const f = one().files[0]!;
    expect(f.destPath).toBe("public/media/2023/03/foo.jpg");
    expect(f.publicPath).toBe("/media/2023/03/foo.jpg");
    expect(one().mediaFor(1)?.src).toBe("/media/2023/03/foo.jpg");
    expect(one().mediaForUrl(`${SITE}/wp-content/uploads/2023/03/foo-300x200.jpg`)?.src).toBe(
      "/media/2023/03/foo.jpg",
    );
  });

  test("outDir and urlBase move the file and what points at it, and are tidied", () => {
    const plan = one({ outDir: "./static//img/", urlBase: "/assets/img/" });
    expect(plan.files[0]!.destPath).toBe("static/img/2023/03/foo.jpg");
    expect(plan.files[0]!.publicPath).toBe("/assets/img/2023/03/foo.jpg");
    expect(plan.mediaFor(1)?.src).toBe("/assets/img/2023/03/foo.jpg");
    expect(one({ urlBase: "media" }).files[0]!.publicPath).toBe("/media/2023/03/foo.jpg");
    expect(one({ urlBase: "https://cdn.example.com/m/" }).files[0]!.publicPath).toBe(
      "https://cdn.example.com/m/2023/03/foo.jpg",
    );
    expect(one({ urlBase: "" }).files[0]!.publicPath).toBe("/2023/03/foo.jpg");
    expect(one({ urlBase: "/" }).files[0]!.publicPath).toBe("/2023/03/foo.jpg");
    expect(one({ outDir: "" }).files[0]!.destPath).toBe("2023/03/foo.jpg");
    expect(one({ outDir: "public\\media" }).files[0]!.destPath).toBe(
      "public/media/2023/03/foo.jpg",
    );
  });

  test("an outDir that leaves the project, or is not inside one, is refused", () => {
    expect(() => one({ outDir: "../elsewhere" })).toThrow(/outDir/);
    expect(() => one({ outDir: "public/../../x" })).toThrow(/outDir/);
    expect(() => one({ outDir: "/var/www/public/media" })).toThrow(/outDir/);
    expect(() => one({ outDir: "C:\\site\\public" })).toThrow(/outDir/);
    expect(() => one({ outDir: "c:public" })).toThrow(/outDir/);
    // A name that merely contains dots is fine.
    expect(one({ outDir: "public/media..v2" }).files[0]!.destPath).toBe(
      "public/media..v2/2023/03/foo.jpg",
    );
  });

  test("a model with no site address cannot be planned unless an uploads base is given", () => {
    const model = fakeModel([att(1, "a.jpg", { url: "/?attachment_id=1" })], { url: "", home: "" });
    expect(() => planMedia(model)).toThrow(/site URL/);
    const plan = planMedia(model, { uploadsBase: "https://cdn.example.com/up/" });
    expect(plan.files[0]!.sourceUrl).toBe("https://cdn.example.com/up/a.jpg");
  });

  describe("the uploads base is what WordPress would compute", () => {
    const base = (options: Record<string, string>, url = SITE): string =>
      planMedia(fakeModel([att(1, "a.jpg", { url: `${url}/?attachment_id=1` })], { url, options }))
        .uploadsBase;

    test("by default, wp-content/uploads under the site", () => {
      expect(base({})).toBe("https://example.com/wp-content/uploads");
      expect(base({}, "https://example.com/blog")).toBe(
        "https://example.com/blog/wp-content/uploads",
      );
      expect(base({ upload_path: "wp-content/uploads" })).toBe(
        "https://example.com/wp-content/uploads",
      );
    });

    test("upload_url_path wins, absolute or root-relative", () => {
      expect(base({ upload_url_path: "https://cdn.example.com/media/" })).toBe(
        "https://cdn.example.com/media",
      );
      expect(base({ upload_url_path: "/files", upload_path: "wp-content/other" })).toBe("/files");
    });

    test("a relative upload_path is under the site; an absolute one is a file system path and means nothing here", () => {
      expect(base({ upload_path: "wp-content/files" })).toBe(
        "https://example.com/wp-content/files",
      );
      expect(base({ upload_path: "/var/www/html/wp-content/uploads" })).toBe(
        "https://example.com/wp-content/uploads",
      );
      expect(base({ upload_path: "C:\\inetpub\\uploads" })).toBe(
        "https://example.com/wp-content/uploads",
      );
    });

    test("it is where a file with no address of its own is fetched from", () => {
      const model = fakeModel([att(1, "2023/03/a.jpg", { url: `${SITE}/?attachment_id=1` })], {
        options: { upload_url_path: "https://cdn.example.com/media" },
      });
      const plan = planMedia(model);
      expect(plan.files[0]!.sourceUrl).toBe("https://cdn.example.com/media/2023/03/a.jpg");
      expect(plan.mediaForUrl("https://cdn.example.com/media/2023/03/a-300x200.jpg")?.src).toBe(
        "/media/2023/03/a.jpg",
      );
      // …and the default location is still recognised, and still a fallback.
      expect(plan.mediaForUrl(`${SITE}/wp-content/uploads/2023/03/a.jpg`)?.src).toBe(
        "/media/2023/03/a.jpg",
      );
      expect(plan.files[0]!.fallbackUrls).toEqual([`${SITE}/wp-content/uploads/2023/03/a.jpg`]);
    });

    test("an uploadsBase option beats the options table", () => {
      const model = fakeModel([att(1, "a.jpg", { url: `${SITE}/?attachment_id=1` })], {
        options: { upload_url_path: "https://cdn.example.com/media" },
      });
      expect(
        planMedia(model, { uploadsBase: "https://other.example.net/u/" }).files[0]!.sourceUrl,
      ).toBe("https://other.example.net/u/a.jpg");
    });
  });

  test("siteUrl moves the fetch address; content written against the database's own address still resolves", () => {
    const model = fakeModel(
      [att(1, "a.jpg", { url: "https://old.example.org/?attachment_id=1" })],
      {
        url: "https://old.example.org",
      },
    );
    const plan = planMedia(model, { siteUrl: "https://new.example.com" });
    expect(plan.files[0]!.sourceUrl).toBe("https://new.example.com/wp-content/uploads/a.jpg");
    expect(plan.mediaForUrl("https://old.example.org/wp-content/uploads/a.jpg")?.src).toBe(
      "/media/a.jpg",
    );
    expect(plan.mediaForUrl("https://new.example.com/wp-content/uploads/a-1024x768.jpg")?.src).toBe(
      "/media/a.jpg",
    );
    expect(plan.files[0]!.fallbackUrls).toEqual([]);
  });

  test("a site served over http says so only if the site does: a guid's old scheme does not win", () => {
    const model = fakeModel([
      att(1, "a.jpg", { url: "http://example.com/wp-content/uploads/a.jpg" }),
    ]);
    expect(planMedia(model).files[0]!.sourceUrl).toBe(
      "https://example.com/wp-content/uploads/a.jpg",
    );
  });

  test("an attachment with no file and no address is reported unplanned, not guessed at", () => {
    const plan = planMedia(fakeModel([att(1, ""), att(2, "ok.jpg")]));
    expect(plan.unplanned).toEqual([
      { attachmentId: 1, reason: expect.stringContaining("no file") },
    ]);
    expect(plan.stats).toMatchObject({ attachments: 2, unplanned: 1, files: 1 });
    expect(plan.mediaFor(1)).toBeUndefined();
    expect(plan.mediaFor(2)).toBeDefined();
  });

  test("a file with a dir and a guid under a CDN prefix: the prefix is read off the guid", () => {
    const model = fakeModel([
      att(1, "2023/03/a.jpg", { url: "https://cdn.example.net/site-uploads/2023/03/a.jpg" }),
    ]);
    const plan = planMedia(model);
    expect(plan.files[0]!.sourceUrl).toBe("https://cdn.example.net/site-uploads/2023/03/a.jpg");
    expect(
      plan.mediaForUrl("https://cdn.example.net/site-uploads/2023/03/a-300x300.jpg")?.src,
    ).toBe("/media/2023/03/a.jpg");
    // The CDN's host is the site's to resolve, but a path on it outside that prefix is nobody's.
    expect(plan.mediaForUrl("https://cdn.example.net/other/2023/03/a.jpg")).toBeUndefined();
    expect(plan.unresolved).toEqual(["https://cdn.example.net/other/2023/03/a.jpg"]);
  });

  test("a guid whose directory is not the file's says nothing about the host's layout", () => {
    const model = fakeModel([
      att(1, "2023/03/a.jpg", { url: "https://cdn.example.net/x/y/a.jpg" }),
    ]);
    expect(planMedia(model).files[0]!.sourceUrl).toBe(
      "https://example.com/wp-content/uploads/2023/03/a.jpg",
    );
  });
});

// ── The unscaled upload, on request ──────────────────────────────────────────────────────────────

describe("planMedia: preferUnscaled", () => {
  const scaledTwin = (t: Truth): boolean => {
    if (!t.original) return false;
    const stem = (p: string) => p.slice(0, p.lastIndexOf("."));
    const ext = (p: string) => p.slice(p.lastIndexOf(".")).toLowerCase();
    return (
      dirOf(t.file) === dirOf(t.original) &&
      stem(t.file) === `${stem(t.original)}-scaled` &&
      ext(t.file) === ext(t.original)
    );
  };

  test.each([
    ["fineline", 111],
    ["ap", 104],
  ] as const)(
    "%s: the unscaled upload is shipped exactly where it is the scaled copy's source (%d files)",
    (site, swapped) => {
      const plan = planMedia(models[site], { preferUnscaled: true });
      const base = planMedia(models[site]);
      expect(plan.files.length).toBe(base.files.length);
      const twins = truths[site].filter(scaledTwin);
      expect(twins.length).toBe(swapped);
      for (const t of truths[site]) {
        const file = fileOfId(plan, t.id);
        if (scaledTwin(t)) {
          expect(file.file).toBe(t.original!);
          expect(file.destPath).toBe(`public/media/${diskName(t.original!)}`);
          // Its dimensions are not recorded anywhere, so none are claimed.
          expect(file.width).toBeUndefined();
          expect(file.height).toBeUndefined();
          // If the upload is gone, the scaled copy is the first thing to try instead.
          expect(file.fallbackUrls![0]).toBe(
            file.sourceUrl.replace(t.original!.split("/").pop()!, t.file.split("/").pop()!),
          );
          // Every name still leads to the one file.
          for (const name of [t.file, t.original!, ...t.sizes]) {
            expect(plan.mediaForUrl(`${SITES[site].bases[0]}${encodePath(name)}`)?.src).toBe(
              file.publicPath,
            );
          }
        } else {
          expect(file.file).toBe(t.file);
          expect(file.width).toBe(t.width);
        }
      }
    },
  );

  test("an edit of a scaled copy, and a scaled copy whose original was renamed, keep the file WordPress serves (fineline 1792, 1871)", () => {
    const plan = planMedia(models.fineline, { preferUnscaled: true });
    for (const id of [1792, 1871, 4107]) {
      const t = truths.fineline.find((x) => x.id === id)!;
      expect(t.original).toBeDefined();
      expect(fileOfId(plan, id).file).toBe(t.file);
    }
  });

  test("it never swaps a file that is not an image", () => {
    const model = fakeModel([att(1, "doc-scaled.pdf", { originalFile: "doc.pdf" })]);
    expect(planMedia(model, { preferUnscaled: true }).files[0]!.file).toBe("doc-scaled.pdf");
  });

  test("it is off by default", () => {
    expect(planMedia(models.fineline).files).toEqual(
      planMedia(models.fineline, { preferUnscaled: false }).files,
    );
    const t = truths.fineline.find((x) => x.id === 105)!;
    expect(fileOfId(plans.fineline, 105).file).toBe(t.file);
  });
});

// ── Names on disk ────────────────────────────────────────────────────────────────────────────────

const SAFE_PATH = /^[\p{L}\p{N}\p{M}\p{Extended_Pictographic}._~/-]+$/u;

describe("planMedia: names on disk", () => {
  const plan1 = (file: string) => planMedia(fakeModel([att(1, file)])).files[0]!;

  test("a name that is already safe is kept exactly, across both fixtures", () => {
    for (const site of SITE_NAMES) {
      const rewritten = plans[site].files.filter((f) => f.destPath !== `public/media/${f.file}`);
      for (const f of plans[site].files) {
        if (SAFE_PATH.test(f.file)) expect(f.destPath).toBe(`public/media/${f.file}`);
      }
      // The only names that change are the three macOS screenshots, whose time has a narrow no-break
      // space (U+202F) before the PM.
      expect(rewritten.map((f) => f.file)).toEqual(
        site === "fineline"
          ? [
              "Screenshot-2025-04-24-at-4.04.46\u202fPM-e1753846571462.png",
              "Screenshot-2025-04-24-at-4.32.10\u202fPM.png",
            ]
          : ["Screenshot-2024-08-05-at-3.34.48\u202fPM.png"],
      );
      for (const f of rewritten) expect(f.destPath).toMatch(/\d-PM/);
    }
  });

  test("letters of any script and emoji are kept as they are (fineline 202, anabaptistperspectives 12712, 12289)", () => {
    const cyr = fileOfId(plans.fineline, 202);
    expect(cyr.file).toBe("Дизайн-без-назви-10.png");
    expect(cyr.destPath).toBe("public/media/Дизайн-без-назви-10.png");
    expect(cyr.sourceUrl).toBe(
      "https://finelinepainting.pro/wp-content/uploads/%D0%94%D0%B8%D0%B7%D0%B0%D0%B9%D0%BD-%D0%B1%D0%B5%D0%B7-%D0%BD%D0%B0%D0%B7%D0%B2%D0%B8-10.png",
    );
    for (const id of [12712, 12289, 13507]) {
      const f = fileOfId(plans.ap, id);
      expect(f.destPath).toBe(`public/media/${f.file}`);
      expect(f.file).toMatch(/\p{Extended_Pictographic}/u);
    }
    // Both the percent-encoded and the written-out address find them.
    expect(
      plans.fineline.mediaForUrl(
        "https://finelinepainting.pro/wp-content/uploads/Дизайн-без-назви-10.png",
      )?.src,
    ).toBe(cyr.publicPath);
    expect(plans.fineline.mediaForUrl(cyr.sourceUrl)?.src).toBe(cyr.publicPath);
  });

  test("what a URL, a shell or Windows would trip on becomes a hyphen, and the address needs no escaping", () => {
    const cases: [string, string][] = [
      ["2023/03/a b.jpg", "2023/03/a-b.jpg"],
      ["2023/03/a  \t b.jpg", "2023/03/a-b.jpg"],
      ["a#b.jpg", "a-b.jpg"],
      ["a%20b.jpg", "a-20b.jpg"],
      ["a?b=c.jpg", "a-b-c.jpg"],
      ["a&b.jpg", "a-b.jpg"],
      ['a"b<c>d|e*f:g.jpg', "a-b-c-d-e-f-g.jpg"],
      ["a'b(c)d,e;f=g+h.jpg", "a-b-c-d-e-f-g-h.jpg"],
      ["a\u00a0b\u202fc.jpg", "a-b-c.jpg"],
      ["a\u200db\u202ec.jpg", "a-b-c.jpg"],
      ["a\u0000b\u001fc.jpg", "a-b-c.jpg"],
      ["trailing.dot.", "trailing.dot-"],
      [".hidden.jpg", "-hidden.jpg"],
      ["a/../b.jpg", "a/-/b.jpg"],
      ["a/./b.jpg", "a/-/b.jpg"],
      ["con.jpg", "_con.jpg"],
      ["2023/AUX.png", "2023/_AUX.png"],
      ["com1", "_com1"],
      ["lpt9.tar.zip", "_lpt9.tar.zip"],
      ["console.jpg", "console.jpg"],
    ];
    for (const [file, want] of cases) {
      const f = plan1(file);
      expect(f.destPath).toBe(`public/media/${want}`);
      expect(f.publicPath).toBe(`/media/${want}`);
      expect(f.destPath.slice("public/media/".length)).toMatch(SAFE_PATH);
      // The address built for the original name still names it.
      expect(f.sourceUrl).toBe(`${SITE}/wp-content/uploads/${encodePath(f.file)}`);
    }
  });

  test("a file name is Unicode-normalised on disk, and a lone surrogate cannot reach it", () => {
    const nfd = "caf\u0065\u0301.jpg";
    expect(plan1(nfd).destPath).toBe("public/media/caf\u00e9.jpg");
    const bad = plan1("a\ud800b.jpg");
    expect(bad.destPath).toBe("public/media/a-b.jpg");
    expect(bad.sourceUrl).toBe(`${SITE}/wp-content/uploads/a%EF%BF%BDb.jpg`);
  });

  test("a name too long for a file system is cut on a character boundary and made unique by a hash, extension kept", () => {
    const long = `${"é".repeat(150)}-final.png`;
    const f = plan1(`2023/03/${long}`);
    const name = f.destPath.split("/").pop()!;
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
    expect(name).toMatch(/^é+-[0-9a-f]{8}\.png$/);
    expect(f.file).toBe(`2023/03/${long}`);
    const other = plan1(`2023/03/${long}x`);
    expect(other.destPath.split("/").pop()).not.toBe(name);
    // A name just under the limit is left alone.
    const fits = `${"a".repeat(190)}.png`;
    expect(plan1(fits).destPath).toBe(`public/media/${fits}`);
  });

  test("the separators WordPress on Windows stores are read as the slashes a browser reads", () => {
    const f = plan1("2023\\03\\a b.jpg");
    expect(f.file).toBe("2023/03/a b.jpg");
    expect(f.destPath).toBe("public/media/2023/03/a-b.jpg");
    expect(f.sourceUrl).toBe(`${SITE}/wp-content/uploads/2023/03/a%20b.jpg`);
  });

  test("directories are made safe too", () => {
    expect(plan1("my uploads/2023 03/a.jpg").destPath).toBe(
      "public/media/my-uploads/2023-03/a.jpg",
    );
    expect(plan1("a///b.jpg").destPath).toBe("public/media/a/b.jpg");
  });
});

describe("planMedia: no two files share a path", () => {
  const folded = (p: string): string => p.normalize("NFD").toUpperCase().toLowerCase();
  const paths = (files: MediaFile[]): string[] => files.map((f) => f.destPath);

  test("names that differ only in case get different paths, and the first keeps its own", () => {
    const plan = planMedia(
      fakeModel([
        att(1, "a/Foo.jpg"),
        att(2, "a/foo.jpg"),
        att(3, "a/FOO.JPG"),
        att(4, "a/fOo.jpg"),
      ]),
    );
    const dest = paths(plan.files);
    expect(new Set(dest.map(folded)).size).toBe(4);
    expect(dest[0]).toBe("public/media/a/Foo.jpg");
    expect(dest.map((d) => d.toLowerCase())).toContain("public/media/a/foo-2.jpg");
    // Each is still its own file, with its own address to fetch.
    expect(plan.files.map((f) => f.sourceUrl)).toEqual(
      ["a/Foo.jpg", "a/foo.jpg", "a/FOO.JPG", "a/fOo.jpg"].map(
        (n) => `${SITE}/wp-content/uploads/${n}`,
      ),
    );
  });

  test("a name that was rewritten gives way to one that was not, whatever their ids", () => {
    const plan = planMedia(fakeModel([att(1, "a b.png"), att(2, "a-b.png"), att(3, "a  b.png")]));
    expect(plan.mediaFor(2)?.src).toBe("/media/a-b.png");
    expect(plan.mediaFor(1)?.src).toBe("/media/a-b-2.png");
    expect(plan.mediaFor(3)?.src).toBe("/media/a-b-3.png");
  });

  test("a numbered name does not take the name of a later file that has it", () => {
    const plan = planMedia(fakeModel([att(1, "a.png"), att(2, "A.png"), att(3, "a-2.png")]));
    expect(plan.mediaFor(1)?.src).toBe("/media/a.png");
    expect(plan.mediaFor(3)?.src).toBe("/media/a-2.png");
    expect(plan.mediaFor(2)?.src).toBe("/media/A-3.png");
  });

  test("canonically equivalent names, which a Mac cannot tell apart, are two files", () => {
    const plan = planMedia(fakeModel([att(1, "caf\u00e9.jpg"), att(2, "cafe\u0301.jpg")]));
    expect(plan.files.length).toBe(2);
    expect(new Set(paths(plan.files).map(folded)).size).toBe(2);
    // Each is fetched under the bytes WordPress stored.
    expect(plan.files[0]!.sourceUrl).toBe(`${SITE}/wp-content/uploads/caf%C3%A9.jpg`);
    expect(plan.files[1]!.sourceUrl).toBe(`${SITE}/wp-content/uploads/cafe%CC%81.jpg`);
  });

  test("a file cannot also be a directory", () => {
    const plan = planMedia(fakeModel([att(1, "a/b"), att(2, "a/b/c.jpg"), att(3, "A/B/d.jpg")]));
    const dest = paths(plan.files);
    expect(dest[0]).toBe("public/media/a/b");
    expect(dest[1]).toBe("public/media/a/b-2/c.jpg");
    expect(dest[2]).toBe("public/media/A/B-2/d.jpg");
    for (const a of dest)
      for (const b of dest) {
        if (a !== b) expect(folded(b).startsWith(`${folded(a)}/`)).toBe(false);
      }
  });

  test("a file placed after the directory it would be is the one that gives way", () => {
    const plan = planMedia(fakeModel([att(1, "x/y/c.jpg"), att(2, "x/y"), att(3, "X/Y")]));
    expect(paths(plan.files)).toEqual([
      "public/media/x/y/c.jpg",
      "public/media/x/y-2",
      "public/media/X/Y-3",
    ]);
  });

  test("letters a case-insensitive file system treats as one are two files here too (long s, dotless i)", () => {
    const plan = planMedia(
      fakeModel([att(1, "s.jpg"), att(2, "\u017f.jpg"), att(3, "I.jpg"), att(4, "\u0131.jpg")]),
    );
    expect(new Set(paths(plan.files).map(folded)).size).toBe(4);
    expect(paths(plan.files).slice(0, 2)).toEqual([
      "public/media/s.jpg",
      "public/media/\u017f-2.jpg",
    ]);
  });

  test("the fixtures' own files, case-folded and normalised, are all distinct", () => {
    for (const site of SITE_NAMES) {
      expect(new Set(paths(plans[site].files).map(folded)).size).toBe(plans[site].files.length);
    }
  });

  test("two hundred names built to collide never do", () => {
    let seed = 12345;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return Math.abs(seed) % n;
    };
    const pieces = [
      "a",
      "A",
      "b",
      "B",
      "é",
      "e\u0301",
      "É",
      " ",
      "-",
      "_",
      "1",
      ".",
      "ß",
      "ss",
      "İ",
      "i",
    ];
    const attachments: WpAttachment[] = [];
    for (let id = 1; id <= 200; id++) {
      let name = "";
      for (let n = 1 + next(4); n > 0; n--) name += pieces[next(pieces.length)];
      const dir = ["", "x/", "X/", "x/y/"][next(4)]!;
      attachments.push(att(id, `${dir}${name}.jpg`));
    }
    const plan = planMedia(fakeModel(attachments));
    const dest = paths(plan.files);
    expect(new Set(dest.map(folded)).size).toBe(dest.length);
    expect(plan.files.length).toBe(new Set(attachments.map((a) => a.file)).size);
    for (const f of plan.files) {
      expect(f.destPath.startsWith("public/media/")).toBe(true);
      expect(f.destPath.slice("public/media/".length)).toMatch(SAFE_PATH);
    }
    // And no path is the directory of another.
    const dirs = new Set(
      dest.flatMap((d) =>
        d
          .split("/")
          .slice(0, -1)
          .map((_, i, all) => folded(all.slice(0, i + 1).join("/"))),
      ),
    );
    for (const d of dest) expect(dirs.has(folded(d))).toBe(false);
  });

  test("planning is independent of the order the model lists its attachments in", () => {
    const attachments = [
      att(5, "a/B.jpg"),
      att(2, "a/b.jpg"),
      att(9, "a b.jpg"),
      att(1, "a-b.jpg"),
      att(4, "é.jpg"),
      att(3, "e\u0301.jpg"),
    ];
    const forward = planMedia(fakeModel(attachments)).files;
    const reversed = planMedia(fakeModel([...attachments].reverse())).files;
    expect(reversed).toEqual(forward);
    expect(forward.map((f) => f.attachmentIds[0])).toEqual([1, 2, 3, 4, 5, 9]);
  });
});

// ── The URLs the sites' content actually holds ───────────────────────────────────────────────────
// The collector below is the test's own: a regular expression over the text of every loaded post,
// over every string inside every block's attributes (`imageURL`, `galleries[].urls`,
// `backgroundPictureURL`, a component's `maker.src`, `icb/image-compare`'s `sizes.*.url`…), over every
// string in post meta, and over the rendered pages under tests/fixtures/<site>/html.

const URL_IN_TEXT = /(?:https?:)?\/\/[^\s"'<>()\\,;|{}[\]]+/gi;

/** WordPress writes `--` as `--` and `/` as `\/` inside a block comment. */
const unescapeJson = (text: string): string =>
  text
    .replace(/\\\//g, "/")
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );

function urlsIn(text: string): string[] {
  return (unescapeJson(text).match(URL_IN_TEXT) ?? [])
    .map((u) => u.replace(/&(?:amp|#038|nbsp).*$/i, "").replace(/[.:!]+$/, ""))
    .map((u) => (u.startsWith("//") ? `https:${u}` : u));
}

function* leaves(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* leaves(v);
  else if (value !== null && typeof value === "object")
    for (const v of Object.values(value)) yield* leaves(v);
}

const MEDIA_EXTENSION = /\.(?:jpe?g|png|gif|webp|svg|pdf|mp3|csv|zip)$/i;
const OWNED_HOSTS: Record<SiteName, string[]> = {
  fineline: ["finelinepainting.pro", "finelinepainting.avunu.io"],
  ap: ["anabaptistperspectives.org", "media.anabaptistperspectives.org"],
};

/** An address under the site's uploads that names a media file (not Cwicly's own stylesheets, which are uploads too). */
function isUploadsUrl(site: SiteName, url: string): boolean {
  let parsed: URL;
  let path: string;
  try {
    parsed = new URL(url);
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  const host = parsed.host.replace(/^www\./, "");
  if (!OWNED_HOSTS[site].includes(host)) return false;
  const underUploads =
    path.startsWith("/wp-content/uploads/") && !path.startsWith("/wp-content/uploads/cwicly/");
  const mediaHost = host.startsWith("media.") && path !== "/";
  return (underUploads || mediaHost) && MEDIA_EXTENSION.test(path);
}

/** The addresses of a site's content, by where they were found: the text of its posts, its block attributes, its post meta. */
function contentUrls(site: SiteName): {
  text: Set<string>;
  blocks: Set<string>;
  meta: Set<string>;
} {
  const text = new Set<string>();
  const blocks = new Set<string>();
  const meta = new Set<string>();
  for (const post of models[site].posts.values()) {
    for (const u of urlsIn(post.content)) text.add(u);
    for (const u of urlsIn(post.excerpt)) text.add(u);
    walkBlocks(parseBlocks(post.content), (block) => {
      for (const leaf of leaves(block.attrs)) for (const u of urlsIn(leaf)) blocks.add(u);
    });
  }
  for (const record of models[site].postMeta.values()) {
    for (const values of Object.values(record)) {
      for (const v of values)
        for (const leaf of leaves(v)) for (const u of urlsIn(leaf)) meta.add(u);
    }
  }
  return { text, blocks, meta };
}

function htmlUrls(site: SiteName): Map<string, string> {
  const dir = join(fixtureDir(site), "html");
  const found = new Map<string, string>();
  for (const file of readdirSync(dir).sort()) {
    for (const u of urlsIn(readFileSync(join(dir, file), "utf8")))
      if (!found.has(u)) found.set(u, `html:${file}`);
  }
  return found;
}

/** A name with the markers WordPress and its editors add taken off, so two names of one picture meet. */
function reduceName(rel: string): string {
  const dir = dirOf(rel);
  const name = rel.slice(dir.length);
  const dot = name.lastIndexOf(".");
  let stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  for (;;) {
    const next = stem.replace(/-(?:\d{1,5}x\d{1,5}|scaled|e\d{10,}|rotated)$/, "");
    if (next === stem || next === "") break;
    stem = next;
  }
  return dir + stem + ext;
}

/** The path an uploads address names, relative to the uploads folder it sits in. */
function uploadsRel(site: SiteName, url: string): string {
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname);
  return parsed.host.startsWith("media.")
    ? path.slice(1)
    : path.slice("/wp-content/uploads/".length);
}

/** Every name an attachment answers to, from the rows alone. */
function namesOfTruth(t: Truth): string[] {
  const guidPath = decodeURIComponent(new URL(t.guid).pathname);
  const guidName =
    /\.[a-z0-9]+$/i.test(guidPath) && new URL(t.guid).search === ""
      ? guidPath.slice(guidPath.lastIndexOf("/") + 1)
      : undefined;
  return [
    t.file,
    ...(t.original ? [t.original] : []),
    ...(t.mime.startsWith("image/") ? t.sizes : []),
    ...(guidName ? [dirOf(t.file) + guidName] : []),
  ];
}

/** What is known of the real unresolved addresses (uploads only), frozen from the fixtures. */
const UNRESOLVED_IN_CONTENT: Record<SiteName, string[]> = {
  fineline: [
    "https://finelinepainting.pro/wp-content/uploads/Lehigh-County-PA.png",
    "https://finelinepainting.pro/wp-content/uploads/iorqsmssqh0.jpg",
  ],
  ap: [
    "https://media.anabaptistperspectives.org/2019/08/maxresdefault.jpg",
    "https://media.anabaptistperspectives.org/2021/04/2021-03-audience-chart-1.png",
    "https://media.anabaptistperspectives.org/2021/04/office-with-flooring-2-scaled.jpg",
    "https://media.anabaptistperspectives.org/2022/07/Horizontal-White.svg",
  ],
};

describe.each(SITE_NAMES)("the uploads URLs in %s's content, meta and block attributes", (site) => {
  const sources = contentUrls(site);
  const uploads = [...new Set([...sources.text, ...sources.blocks, ...sources.meta])].filter((u) =>
    isUploadsUrl(site, u),
  );
  const truth = truths[site];

  const exactOwner = new Map<string, number>();
  const familyOf = new Map<number, Set<string>>();
  for (const t of truth) {
    const names = namesOfTruth(t);
    familyOf.set(t.id, new Set(names.map(reduceName)));
    for (const n of names) if (!exactOwner.has(n)) exactOwner.set(n, t.id);
  }

  test("the collector reads the markup and the parsed blocks alike, and finds what the design notes say is there", () => {
    expect(uploads.length).toBeGreaterThan(site === "fineline" ? 600 : 90);
    // Parsing the blocks yields no address the unescaped markup does not hold.
    expect([...sources.blocks].filter((u) => !sources.text.has(u))).toEqual([]);
    expect(sources.blocks.size).toBeGreaterThan(site === "fineline" ? 700 : 100);
    expect(sources.meta.size).toBeGreaterThan(50);
    // The Cwicly attribute that holds an image address, and the media host of the second site.
    const holds = (host: string): boolean => uploads.some((u) => new URL(u).host === host);
    expect(
      holds(site === "fineline" ? "finelinepainting.pro" : "media.anabaptistperspectives.org"),
    ).toBe(true);
  });

  test("each one resolves, or is listed unresolved; the ratio that is not resolved is reported", () => {
    const plan = planMedia(models[site]);
    const unresolved: string[] = [];
    let exact = 0;
    let byName = 0;
    for (const url of uploads) {
      const ref = plan.mediaForUrl(url);
      if (!ref) {
        unresolved.push(url);
        continue;
      }
      if (exactOwner.has(uploadsRel(site, url))) exact++;
      else byName++;
    }
    const ratio = unresolved.length / uploads.length;
    console.log(
      `[media] ${site}: ${uploads.length} distinct uploads URLs in post content, post meta and block attributes: ` +
        `${exact} resolve by an exact name, ${byName} through the family (a size or edit the metadata did not list), ` +
        `${unresolved.length} do not (${(ratio * 100).toFixed(2)}%)`,
    );
    // Listed once each, in the order they were met; none of them is another host's.
    expect(plan.unresolved).toEqual(unresolved);
    expect(plan.external).toEqual([]);
    expect([...unresolved].sort()).toEqual(UNRESOLVED_IN_CONTENT[site]);
    expect(ratio).toBeLessThan(0.05);
    expect(byName).toBe(site === "fineline" ? 4 : 0);
  });

  test.skipIf(site !== "fineline")(
    "the four that resolve only through the family are an edited or renamed image each",
    () => {
      const plan = planMedia(models[site]);
      const up = (n: string): string => `https://finelinepainting.pro/wp-content/uploads/${n}`;
      // Renamed by a plugin after the page was written: the guid still has the old name.
      expect(plan.mediaForUrl(up("Judah-edited-scaled.jpg"))?.src).toBe(plan.mediaFor(617)?.src);
      // The picture as it was before an edit.
      expect(
        plan.mediaForUrl(up("professional-paint-services-in-lebanon-and-lancaster-pa.jpeg"))?.src,
      ).toBe(plan.mediaFor(814)?.src);
      // An edit stamp that is not the latest one, and one that has since been undone.
      expect(
        plan.mediaForUrl(up("Great-Metal-Roof-Painting-lebanon-e1787858278687.png"))?.src,
      ).toBe("/media/Great-Metal-Roof-Painting-lebanon-e1787859195114.png");
      expect(
        plan.mediaForUrl(up("Great-Metal-Roof-Painting-lebanon-pa-e1787858324335.png"))?.src,
      ).toBe("/media/Great-Metal-Roof-Painting-lebanon-pa.png");
      for (const id of [617, 814, 6748, 6749])
        expect(fileOfId(plan, id).attachmentIds).toEqual([id]);
    },
  );

  test("an exact name resolves to its attachment, and a derived one to a file of the same picture", () => {
    const plan = planMedia(models[site]);
    const wrong: string[] = [];
    for (const url of uploads) {
      const ref = plan.mediaForUrl(url);
      if (!ref) continue;
      const rel = uploadsRel(site, url);
      const owner = exactOwner.get(rel);
      if (owner !== undefined) {
        if (ref.src !== plan.mediaFor(owner)?.src)
          wrong.push(`${url} is attachment ${owner}'s, not ${ref.src}`);
        continue;
      }
      const target = truth.find((t) => plan.mediaFor(t.id)?.src === ref.src);
      if (!target || !familyOf.get(target.id)!.has(reduceName(rel)))
        wrong.push(`${url} -> ${ref.src}, another picture`);
    }
    expect(wrong).toEqual([]);
  });

  test("with the unresolved ones as extraUrls every address resolves, each family of them is one more file", () => {
    const base = planMedia(models[site]);
    const unresolved = uploads.filter((u) => !base.mediaForUrl(u));
    const plan = planMedia(models[site], { extraUrls: unresolved });
    for (const url of uploads) expect(plan.mediaForUrl(url)).toBeDefined();
    expect(plan.unresolved).toEqual([]);
    expect(plan.stats.extraFiles).toBe(
      new Set(unresolved.map((u) => reduceName(uploadsRel(site, u)))).size,
    );
    expect(plan.files.length).toBe(base.files.length + plan.stats.extraFiles);
    // The attachments' files are untouched, and the extras follow them.
    expect(plan.files.slice(0, base.files.length)).toEqual(base.files);
    for (const f of plan.files.slice(base.files.length)) expect(f.attachmentIds).toEqual([]);
  });

  test("every uploads URL as extraUrls plans nothing the attachments already account for", () => {
    const base = planMedia(models[site]);
    const unresolved = uploads.filter((u) => !base.mediaForUrl(u));
    const all = planMedia(models[site], { extraUrls: uploads });
    const some = planMedia(models[site], { extraUrls: unresolved });
    expect(all.files).toEqual(some.files);
  });
});

// The pages were rendered after the database was taken (about-us.html says it was last modified on
// 2026-09-17; the newest post row in the database is from 2026-09-16), so they hold images the
// database has no attachment for: real families of sizes with no attachment behind them.
describe.each(SITE_NAMES)("the uploads URLs in %s's rendered pages", (site) => {
  const found = htmlUrls(site);
  const uploads = [...found.keys()].filter((u) => isUploadsUrl(site, u));

  test("a page lists every size of an image in its srcset, and they fold into one file", () => {
    const plan = planMedia(models[site]);
    const resolved = uploads.filter((u) => plan.mediaForUrl(u));
    const unresolved = uploads.filter((u) => !plan.mediaForUrl(u));
    console.log(
      `[media] ${site}: ${uploads.length} distinct uploads URLs in the rendered pages, ${resolved.length} resolve, ` +
        `${unresolved.length} do not (${((unresolved.length / uploads.length) * 100).toFixed(1)}%)`,
    );
    expect(plan.unresolved).toEqual(unresolved);
    expect(resolved.length).toBeGreaterThan(unresolved.length);
    // Every resolved size is the same file as the full one.
    const bySrc = new Map<string, Set<string>>();
    for (const u of resolved) {
      const src = plan.mediaForUrl(u)!.src;
      bySrc.set(src, new Set([...(bySrc.get(src) ?? []), reduceName(uploadsRel(site, u))]));
    }
    for (const [src, names] of bySrc) expect([src, names.size]).toEqual([src, 1]);
  });

  test("every address that resolves is the same picture as the file it resolves to, by exact name or by family", () => {
    const plan = planMedia(models[site]);
    const exactOwner = new Map<string, number>();
    const familyOf = new Map<number, Set<string>>();
    for (const t of truths[site]) {
      const names = namesOfTruth(t);
      familyOf.set(t.id, new Set(names.map(reduceName)));
      for (const n of names) if (!exactOwner.has(n)) exactOwner.set(n, t.id);
    }
    const bySrc = new Map(truths[site].map((t) => [plan.mediaFor(t.id)!.src, t.id]));
    const wrong: string[] = [];
    let derived = 0;
    for (const url of uploads) {
      const ref = plan.mediaForUrl(url);
      if (!ref) continue;
      const rel = uploadsRel(site, url);
      const owner = exactOwner.get(rel);
      if (owner !== undefined) {
        if (plan.mediaFor(owner)!.src !== ref.src) wrong.push(`${url} is attachment ${owner}'s`);
        continue;
      }
      derived++;
      if (!familyOf.get(bySrc.get(ref.src)!)?.has(reduceName(rel)))
        wrong.push(`${url} -> ${ref.src}`);
    }
    expect(wrong).toEqual([]);
    console.log(
      `[media] ${site}: of the rendered pages' resolved addresses, ${derived} resolve through the family rather than an exact name`,
    );
  });

  test("the images the database does not know come in families, and extraUrls turns each family into one file", () => {
    const base = planMedia(models[site]);
    const unresolved = uploads.filter((u) => !base.mediaForUrl(u));
    const families = new Map<string, string[]>();
    for (const u of unresolved) {
      const key = reduceName(uploadsRel(site, u));
      families.set(key, [...(families.get(key) ?? []), u]);
    }
    const plan = planMedia(models[site], { extraUrls: unresolved });
    expect(plan.stats.extraFiles).toBe(families.size);
    for (const [key, urls] of families) {
      const files = new Set(urls.map((u) => plan.mediaForUrl(u)!.src));
      expect([key, files.size]).toEqual([key, 1]);
      const file = plan.files.find((f) => f.publicPath === [...files][0]);
      expect(file?.attachmentIds).toEqual([]);
      // The file is the upload itself when a page named it; the page may name only sizes.
      const undecorated = urls.find((u) => uploadsRel(site, u) === key);
      if (undecorated) expect(file?.file).toBe(key);
      // Fetched from an address the page used.
      expect(urls).toContain(file!.sourceUrl);
    }
  });
});

describe("the images the database does not know, from the real home page", () => {
  test("six addresses of one picture are one file: the upload itself, with the sizes as fallbacks", () => {
    const urls = [...htmlUrls("fineline").keys()].filter((u) =>
      u.includes("log-cabin-staining-fairfield-pa"),
    );
    expect(urls.length).toBe(6);
    const plan = planMedia(models.fineline, { extraUrls: urls });
    expect(plan.stats.extraFiles).toBe(1);
    const file = plan.files.at(-1)!;
    expect(file.file).toBe("log-cabin-staining-fairfield-pa.jpeg");
    expect(file.sourceUrl).toBe(
      "https://finelinepainting.pro/wp-content/uploads/log-cabin-staining-fairfield-pa.jpeg",
    );
    expect(file.mime).toBe("image/jpeg");
    expect(file.attachmentIds).toEqual([]);
    expect(file.destPath).toBe("public/media/log-cabin-staining-fairfield-pa.jpeg");
    expect(file.fallbackUrls!.slice(0, 5)).toEqual(
      [
        "log-cabin-staining-fairfield-pa-1536x1156.jpeg",
        "log-cabin-staining-fairfield-pa-1024x771.jpeg",
        "log-cabin-staining-fairfield-pa-768x578.jpeg",
        "log-cabin-staining-fairfield-pa-300x226.jpeg",
        "log-cabin-staining-fairfield-pa-150x113.jpeg",
      ].map((n) => `https://finelinepainting.pro/wp-content/uploads/${n}`),
    );
    for (const u of urls) {
      const ref = plan.mediaForUrl(u)!;
      expect(ref.src).toBe(file.publicPath);
      expect("alt" in ref).toBe(false);
    }
    // A size of it nobody listed is the same picture.
    expect(
      plan.mediaForUrl(
        "https://finelinepainting.pro/wp-content/uploads/log-cabin-staining-fairfield-pa-640x482.jpeg",
      )?.src,
    ).toBe(file.publicPath);
  });
});

// ── Stylesheets, and hosts that carry a copy of the uploads ──────────────────────────────────────

/** Every `url(...)` in the Cwicly stylesheets of a site's fixtures. */
function cssUrls(site: SiteName): string[] {
  const dir = join(fixtureDir(site), "css");
  const found = new Set<string>();
  for (const file of readdirSync(dir).sort()) {
    for (const m of readFileSync(join(dir, file), "utf8").matchAll(
      /url\(\s*(['"]?)(.*?)\1\s*\)/g,
    )) {
      found.add(m[2]!);
    }
  }
  return [...found];
}

describe("the url() references in the Cwicly stylesheets", () => {
  test("finelinepainting: every uploads image resolves, and a font stylesheet is no media", () => {
    const urls = cssUrls("fineline");
    const uploads = urls.filter((u) => isUploadsUrl("fineline", u));
    expect(uploads.length).toBe(7);
    const plan = planMedia(models.fineline);
    for (const u of uploads) expect(plan.mediaForUrl(u)).toBeDefined();
    for (const u of urls.filter((x) => x.startsWith("https://fonts.googleapis.com/"))) {
      expect(plan.mediaForUrl(u)).toBeUndefined();
    }
    expect(plan.unresolved).toEqual([]);
    expect(plan.external).toEqual([]);
  });

  test("anabaptistperspectives: one points at the sandbox the stylesheet was compiled on", () => {
    const sandbox =
      "https://sandbox.anabaptistperspectives.org/wp-content/uploads/A47A2262-scaled.jpg";
    const urls = cssUrls("ap");
    expect(urls).toContain(sandbox);
    const bare = planMedia(models.ap);
    expect(bare.mediaForUrl(sandbox)).toBeUndefined();
    expect(bare.external).toEqual([sandbox]);
    // Told that the sandbox carries a copy of the uploads, the same plan resolves it, to the file the live address is.
    const plan = planMedia(models.ap, { aliasHosts: ["sandbox.anabaptistperspectives.org"] });
    const live = plan.mediaForUrl("https://media.anabaptistperspectives.org/A47A2262-scaled.jpg");
    expect(live?.src).toBe("/media/A47A2262-scaled.jpg");
    expect(plan.mediaForUrl(sandbox)).toEqual(live);
    expect(plan.external).toEqual([]);
    expect(plan.unresolved).toEqual([]);
    // It is never somewhere to fetch from.
    expect(
      plan.files.every(
        (f) =>
          !f.sourceUrl.includes("sandbox") && !f.fallbackUrls!.some((u) => u.includes("sandbox")),
      ),
    ).toBe(true);
    expect(plan.files).toEqual(planMedia(models.ap).files);
  });
});

describe("planMedia: aliasHosts", () => {
  const model = fakeModel([att(1, "2023/03/a.jpg", { sizes: [size("a-300x200.jpg", 300, 200)] })]);
  const via = (aliasHosts: string[], url: string) =>
    planMedia(model, { aliasHosts }).mediaForUrl(url)?.src;

  test("a host is read as WordPress lays uploads out, in any spelling of the host", () => {
    for (const alias of [
      "staging.example.org",
      "https://staging.example.org",
      "//staging.example.org/",
      " STAGING.example.org ",
      "http://www.staging.example.org",
    ]) {
      expect([
        alias,
        via([alias], "https://staging.example.org/wp-content/uploads/2023/03/a-300x200.jpg"),
      ]).toEqual([alias, "/media/2023/03/a.jpg"]);
    }
    expect(
      via(
        ["staging.example.org:8080"],
        "http://staging.example.org:8080/wp-content/uploads/2023/03/a.jpg",
      ),
    ).toBe("/media/2023/03/a.jpg");
    // Another port is another server.
    expect(
      via(
        ["staging.example.org:8080"],
        "http://staging.example.org/wp-content/uploads/2023/03/a.jpg",
      ),
    ).toBeUndefined();
  });

  test("an address with a path names the folder, and the default layout is then not assumed", () => {
    expect(
      via(["https://cdn.example.org/media/"], "https://cdn.example.org/media/2023/03/a.jpg"),
    ).toBe("/media/2023/03/a.jpg");
    expect(
      via(["https://cdn.example.org/media"], "https://cdn.example.org/media/2023/03/a.jpg"),
    ).toBe("/media/2023/03/a.jpg");
    expect(
      via(
        ["https://cdn.example.org/media/"],
        "https://cdn.example.org/wp-content/uploads/2023/03/a.jpg",
      ),
    ).toBeUndefined();
    expect(
      via(["https://cdn.example.org/"], "https://cdn.example.org/wp-content/uploads/2023/03/a.jpg"),
    ).toBe("/media/2023/03/a.jpg");
  });

  test("a bare host also follows a custom uploads folder of the site", () => {
    const custom = fakeModel([att(1, "2023/03/a.jpg", { url: `${SITE}/?attachment_id=1` })], {
      options: { upload_path: "files" },
    });
    const plan = planMedia(custom, { aliasHosts: ["staging.example.org"] });
    expect(plan.uploadsBase).toBe(`${SITE}/files`);
    expect(plan.mediaForUrl("https://staging.example.org/files/2023/03/a.jpg")?.src).toBe(
      "/media/2023/03/a.jpg",
    );
    expect(
      plan.mediaForUrl("https://staging.example.org/wp-content/uploads/2023/03/a.jpg")?.src,
    ).toBe("/media/2023/03/a.jpg");
  });

  test("a host that is not named is not guessed at, even when the path and file are the site's", () => {
    expect(via([], "https://staging.example.org/wp-content/uploads/2023/03/a.jpg")).toBeUndefined();
    expect(
      via(["other.example.org"], "https://staging.example.org/wp-content/uploads/2023/03/a.jpg"),
    ).toBeUndefined();
    expect(
      via(["staging.example.org"], "https://staging.example.org/blog/2023/03/a.jpg"),
    ).toBeUndefined();
  });

  test("an alias is the site's own: a miss on it is unresolved, not external; nonsense is ignored", () => {
    const plan = planMedia(model, {
      aliasHosts: ["staging.example.org", "", "http://[bad", "   "],
    });
    plan.mediaForUrl("https://staging.example.org/wp-content/uploads/2023/03/missing.jpg");
    expect(plan.unresolved).toEqual([
      "https://staging.example.org/wp-content/uploads/2023/03/missing.jpg",
    ]);
    expect(plan.external).toEqual([]);
  });

  test("an address on an alias can be an extra, and is fetched from where it was written", () => {
    const plan = planMedia(model, {
      aliasHosts: ["staging.example.org"],
      extraUrls: ["https://staging.example.org/wp-content/uploads/2024/01/new.jpg"],
    });
    expect(plan.files.at(-1)).toMatchObject({
      file: "2024/01/new.jpg",
      sourceUrl: "https://staging.example.org/wp-content/uploads/2024/01/new.jpg",
    });
    expect(plan.files.at(-1)!.fallbackUrls).toEqual([`${SITE}/wp-content/uploads/2024/01/new.jpg`]);
  });
});

// ── Names that only look like markers, and markers a table does not list ─────────────────────────

describe("mediaForUrl: reading a name for the markers WordPress put on it", () => {
  const up = (name: string): string => `${SITE}/wp-content/uploads/${name}`;
  const lone = (file: string, over: Partial<WpAttachment> = {}) =>
    planMedia(fakeModel([att(1, file, { url: `${SITE}/?attachment_id=1`, ...over })]));

  test("an edit stamp is a millisecond (or second) timestamp: ten digits or more, not `-e500`", () => {
    const plan = lone("product.jpg");
    expect(plan.mediaForUrl(up("product-e1698162036799.jpg"))?.src).toBe("/media/product.jpg");
    expect(plan.mediaForUrl(up("product-e1698162036.jpg"))?.src).toBe("/media/product.jpg");
    // A product code is not an edit.
    expect(plan.mediaForUrl(up("product-e500.jpg"))).toBeUndefined();
    expect(plan.mediaForUrl(up("product-e123456789.jpg"))).toBeUndefined();
    expect(plan.mediaForUrl(up("product-e500-300x200.jpg"))).toBeUndefined();
  });

  test("a stamp is read wherever WordPress left it: before a size, before -scaled, after both", () => {
    const plan = lone("foo.jpg");
    for (const name of [
      "foo-e1698162036799-300x200.jpg",
      "foo-scaled-e1698162036799.jpg",
      "foo-scaled-e1698162036799-300x200.jpg",
      "foo-e1698162036799-scaled.jpg",
    ]) {
      expect(plan.mediaForUrl(up(name))?.src).toBe("/media/foo.jpg");
    }
  });

  test("the pre-edit name of the picture an exact name belongs to is not taken by the edit", () => {
    // 1 is an edit of foo.jpg; 2 is a different attachment that has the name `foo.jpg` itself.
    const plan = planMedia(fakeModel([att(1, "foo-e1698162036799.jpg"), att(2, "foo.jpg")]));
    expect(plan.mediaForUrl(up("foo.jpg"))?.src).toBe("/media/foo.jpg");
    expect(plan.mediaFor(1)?.src).toBe("/media/foo-e1698162036799.jpg");
    expect(plan.mediaForUrl(up("foo-e1698162036799.jpg"))?.src).toBe(
      "/media/foo-e1698162036799.jpg",
    );
    // …and with the ids the other way round.
    const swapped = planMedia(fakeModel([att(2, "foo-e1698162036799.jpg"), att(1, "foo.jpg")]));
    expect(swapped.mediaForUrl(up("foo.jpg"))?.src).toBe("/media/foo.jpg");
  });

  test("-rotated is a marker: the upload and the rotated copy are one picture", () => {
    const plan = lone("foo.jpg");
    expect(plan.mediaForUrl(up("foo-rotated.jpg"))?.src).toBe("/media/foo.jpg");
    expect(plan.mediaForUrl(up("foo-rotated-640x427.jpg"))?.src).toBe("/media/foo.jpg");
  });

  test("-scaled in the middle of a name is not a marker", () => {
    const plan = lone("foo.jpg");
    expect(plan.mediaForUrl(up("foo-scaled-down.jpg"))).toBeUndefined();
    expect(plan.mediaForUrl(up("foo-scaled-down-300x200.jpg"))).toBeUndefined();
    expect(plan.mediaForUrl(up("foo-scaled-300x200.jpg"))?.src).toBe("/media/foo.jpg");
  });

  test("a table that lists only the scaled copy answers for the upload's own name", () => {
    const plan = lone("2023/03/foo-scaled.jpg");
    const dir = `${SITE}/wp-content/uploads/2023/03/`;
    expect(plan.mediaForUrl(`${dir}foo.jpg`)?.src).toBe("/media/2023/03/foo-scaled.jpg");
    expect(plan.mediaForUrl(`${dir}foo-300x200.jpg`)?.src).toBe("/media/2023/03/foo-scaled.jpg");
    // And a name that is only scaled-looking on the other side is nobody's.
    expect(plan.mediaForUrl(`${dir}bar.jpg`)).toBeUndefined();
  });

  test("a size marker needs both numbers, and a name that is nothing but a marker has no family", () => {
    // Two attachments whose names are all marker: neither is the family of the other.
    const plan = planMedia(fakeModel([att(1, "foo.jpg"), att(2, "-scaled.jpg")]));
    expect(plan.mediaForUrl(up("foo-300x.jpg"))).toBeUndefined();
    expect(plan.mediaForUrl(up("foo-x200.jpg"))).toBeUndefined();
    expect(plan.mediaForUrl(up("foo-123456x200.jpg"))).toBeUndefined();
    expect(plan.mediaForUrl(up("-300x200.jpg"))).toBeUndefined();
    expect(plan.mediaForUrl(up("-scaled-300x200.jpg"))?.src).toBe("/media/-scaled.jpg");
    expect(plan.mediaForUrl(up("-scaled.jpg"))?.src).toBe("/media/-scaled.jpg");
  });

  test("an address spelled with another Unicode normal form is the same name", () => {
    const plan = lone("café.jpg");
    expect(plan.mediaForUrl(up("café.jpg"))?.src).toBe("/media/café.jpg");
    expect(plan.mediaForUrl(up("cafe%CC%81.jpg"))?.src).toBe("/media/café.jpg");
    expect(plan.mediaForUrl(up("caf%C3%A9-300x200.jpg"))?.src).toBe("/media/café.jpg");
    const decomposed = lone("café.jpg");
    expect(decomposed.mediaForUrl(up("caf%C3%A9.jpg"))?.src).toBe("/media/café.jpg");
  });

  test("a name that differs only in case still finds a file when no exact name does", () => {
    const plan = lone("Photos/Hero.JPG");
    expect(plan.mediaForUrl(up("photos/hero.jpg"))?.src).toBe("/media/Photos/Hero.JPG");
    expect(plan.mediaForUrl(up("PHOTOS/HERO-300x200.JPG"))?.src).toBe("/media/Photos/Hero.JPG");
  });
});

describe("planMedia: dimensions", () => {
  const dims = (over: Partial<WpAttachment>) =>
    planMedia(fakeModel([att(1, "a.jpg", over)])).files[0]!;

  test("both are stated or neither is", () => {
    expect(dims({ width: 800, height: 600 })).toMatchObject({ width: 800, height: 600 });
    for (const over of [
      { width: 800, height: 0 },
      { width: 0, height: 600 },
      { width: 0, height: 0 },
      { width: 800 },
      { height: 600 },
      {},
    ] as Partial<WpAttachment>[]) {
      const file = dims(over);
      expect("width" in file || "height" in file).toBe(false);
    }
  });

  test("the first attachment of a shared file that states them gives them", () => {
    const plan = planMedia(
      fakeModel([
        att(1, "a.jpg"),
        att(2, "a.jpg", { width: 10, height: 20 }),
        att(3, "a.jpg", { width: 30, height: 40 }),
      ]),
    );
    expect(plan.files[0]).toMatchObject({ width: 10, height: 20 });
  });
});

describe("planMedia: where a file is fetched from", () => {
  const A = "https://a.example.net";
  const B = "https://b.example.net";

  test("the guid's host, then the host most of the library is on, then the site's own uploads", () => {
    const model = fakeModel([
      att(1, "2023/03/one.jpg", { url: `${A}/uploads/2023/03/one.jpg` }),
      att(2, "2023/03/two.jpg", { url: `${A}/uploads/2023/03/two.jpg` }),
      att(3, "2023/03/odd.jpg", { url: `${B}/files/2023/03/odd.jpg` }),
    ]);
    const plan = planMedia(model);
    const [one, , odd] = plan.files;
    expect(one!.sourceUrl).toBe(`${A}/uploads/2023/03/one.jpg`);
    expect(one!.fallbackUrls).toEqual([`${SITE}/wp-content/uploads/2023/03/one.jpg`]);
    expect(odd!.sourceUrl).toBe(`${B}/files/2023/03/odd.jpg`);
    expect(odd!.fallbackUrls).toEqual([
      `${A}/uploads/2023/03/odd.jpg`,
      `${SITE}/wp-content/uploads/2023/03/odd.jpg`,
    ]);
  });

  test("an unscaled upload that is asked for falls back to its scaled copy at each host in turn", () => {
    const model = fakeModel([
      att(1, "2023/03/one.jpg", { url: `${A}/uploads/2023/03/one.jpg` }),
      att(2, "2023/03/two.jpg", { url: `${A}/uploads/2023/03/two.jpg` }),
      att(3, "2023/03/odd-scaled.jpg", {
        url: `${B}/files/2023/03/odd.jpg`,
        originalFile: "2023/03/odd.jpg",
      }),
    ]);
    const odd = planMedia(model, { preferUnscaled: true }).files[2]!;
    expect(odd.file).toBe("2023/03/odd.jpg");
    expect(odd.sourceUrl).toBe(`${B}/files/2023/03/odd.jpg`);
    expect(odd.fallbackUrls).toEqual([
      `${B}/files/2023/03/odd-scaled.jpg`,
      `${A}/uploads/2023/03/odd.jpg`,
      `${A}/uploads/2023/03/odd-scaled.jpg`,
      `${SITE}/wp-content/uploads/2023/03/odd.jpg`,
      `${SITE}/wp-content/uploads/2023/03/odd-scaled.jpg`,
    ]);
  });

  test("an unscaled upload is only swapped in beside its own scaled copy", () => {
    const swapped = (file: string, originalFile: string) =>
      planMedia(fakeModel([att(1, file, { originalFile })]), { preferUnscaled: true }).files[0]!
        .file;
    expect(swapped("2023/03/foo-scaled.jpg", "2023/03/foo.jpg")).toBe("2023/03/foo.jpg");
    // Another directory, another name, another extension (even in case): not its source.
    expect(swapped("2023/03/foo-scaled.jpg", "2024/01/foo.jpg")).toBe("2023/03/foo-scaled.jpg");
    expect(swapped("2023/03/foo-scaled.jpg", "2023/03/bar.jpg")).toBe("2023/03/foo-scaled.jpg");
    expect(swapped("2023/03/foo-scaled.jpg", "2023/03/foo.png")).toBe("2023/03/foo-scaled.jpg");
    expect(swapped("2023/03/foo-scaled.JPG", "2023/03/foo.jpg")).toBe("2023/03/foo-scaled.JPG");
    expect(swapped("2023/03/foo-scaled-e1698162036799.jpg", "2023/03/foo.jpg")).toBe(
      "2023/03/foo-scaled-e1698162036799.jpg",
    );
    expect(swapped("2023/03/foo.jpg", "2023/03/foo.jpg")).toBe("2023/03/foo.jpg");
  });

  test("a guid on the site's own host with a folder of its own is fetched over the scheme the site uses", () => {
    const model = fakeModel([att(1, "a.jpg", { url: "http://example.com/media/uploads/a.jpg" })]);
    const plan = planMedia(model);
    expect(plan.files[0]!.sourceUrl).toBe("https://example.com/media/uploads/a.jpg");
    expect(plan.mediaForUrl("http://example.com/media/uploads/a-300x200.jpg")?.src).toBe(
      "/media/a.jpg",
    );
  });

  test("a folder in a guid keeps its escapes in the address built from it", () => {
    const model = fakeModel([
      att(1, "2023/03/a b.jpg", { url: "https://cdn.example.net/my%20uploads/2023/03/a%20b.jpg" }),
    ]);
    const file = planMedia(model).files[0]!;
    expect(file.sourceUrl).toBe("https://cdn.example.net/my%20uploads/2023/03/a%20b.jpg");
    expect(file.destPath).toBe("public/media/2023/03/a-b.jpg");
  });

  test("a site address with a slash or spaces on it is the same address", () => {
    const model = fakeModel([att(1, "a.jpg", { url: "/?attachment_id=1" })]);
    for (const siteUrl of [
      "https://example.com/",
      " https://example.com ",
      "https://example.com//",
    ]) {
      expect(planMedia(model, { siteUrl }).files[0]!.sourceUrl).toBe(
        "https://example.com/wp-content/uploads/a.jpg",
      );
    }
  });

  test("a file name with whitespace round it is the name inside", () => {
    expect(planMedia(fakeModel([att(1, "  2023/03/a.jpg\n")])).files[0]!.file).toBe(
      "2023/03/a.jpg",
    );
  });

  test("an attachment with no MIME type is an image when its file is", () => {
    // A size with a name nothing could derive from the file's: only the table can know it.
    const sized = (file: string) =>
      planMedia(
        fakeModel([att(1, file, { mime: "", sizes: [size("thumb-of-it.jpg", 150, 150)] })]),
      );
    expect(sized("a.jpg").mediaForUrl(`${SITE}/wp-content/uploads/thumb-of-it.jpg`)?.src).toBe(
      "/media/a.jpg",
    );
    expect(
      sized("a.pdf").mediaForUrl(`${SITE}/wp-content/uploads/thumb-of-it.jpg`),
    ).toBeUndefined();
    expect(sized("a.pdf").files[0]!.mime).toBe("application/pdf");
    expect(planMedia(fakeModel([att(1, "a.xyz", { mime: "" })])).files[0]!.mime).toBe(
      "application/octet-stream",
    );
  });

  test("a guid that is not a file address (a page, a script, a query) names no host", () => {
    for (const guid of [
      "https://cdn.example.net/download.php",
      "https://cdn.example.net/2023/03/download.php",
      "https://cdn.example.net/2023/03/",
      "https://cdn.example.net/2023/03",
      "https://cdn.example.net/?attachment_id=1",
      "https://cdn.example.net/photo-by-someone/",
      "not an address at all",
      "",
    ]) {
      const plan = planMedia(fakeModel([att(1, "2023/03/a.jpg", { url: guid })]));
      expect([guid, plan.files[0]!.sourceUrl]).toEqual([
        guid,
        `${SITE}/wp-content/uploads/2023/03/a.jpg`,
      ]);
    }
  });

  test("a signed guid (a query on a real file address) still names its host", () => {
    const model = fakeModel([
      att(1, "2023/03/a.jpg", {
        url: "https://cdn.example.net/up/2023/03/a.jpg?X-Amz-Signature=abc",
      }),
    ]);
    expect(planMedia(model).files[0]!.sourceUrl).toBe("https://cdn.example.net/up/2023/03/a.jpg");
  });
});

describe("mediaForUrl: more than one place on a host", () => {
  const H = "https://m.example.net";
  const model = fakeModel([
    att(1, "2023/03/a.jpg", { url: `${H}/wp-content/uploads/2023/03/a.jpg` }),
    att(2, "2023/04/b.jpg", { url: `${H}/2023/04/b.jpg` }),
  ]);

  test("the longest prefix that fits names the file, whichever order the bases were met in", () => {
    const plan = planMedia(model, { extraUrls: [`${H}/wp-content/uploads/2024/01/new.jpg`] });
    expect(plan.files.map((f) => f.file)).toEqual([
      "2023/03/a.jpg",
      "2023/04/b.jpg",
      "2024/01/new.jpg",
    ]);
    expect(plan.files[2]!.sourceUrl).toBe(`${H}/wp-content/uploads/2024/01/new.jpg`);
    // Both layouts resolve.
    expect(plan.mediaForUrl(`${H}/wp-content/uploads/2023/03/a-300x200.jpg`)?.src).toBe(
      "/media/2023/03/a.jpg",
    );
    expect(plan.mediaForUrl(`${H}/2023/04/b-300x200.jpg`)?.src).toBe("/media/2023/04/b.jpg");
    // An address under the shorter prefix is read against it only.
    expect(plan.mediaForUrl(`${H}/2024/01/new.jpg`)?.src).toBe(plan.files[2]!.publicPath);
  });

  test("an absolute file name is read against the longest base too", () => {
    const abs = fakeModel([
      att(1, "2023/03/a.jpg", { url: `${H}/wp-content/uploads/2023/03/a.jpg` }),
      att(2, `${H}/wp-content/uploads/2023/04/b.jpg`, {
        url: `${H}/wp-content/uploads/2023/04/b.jpg`,
      }),
    ]);
    expect(planMedia(abs).files.map((f) => f.file)).toEqual(["2023/03/a.jpg", "2023/04/b.jpg"]);
  });

  test("doubled slashes in an address are one slash", () => {
    const plan = planMedia(fakeModel([att(1, "2023/03/a.jpg")]));
    expect(plan.mediaForUrl(`${SITE}/wp-content/uploads//2023//03///a.jpg`)?.src).toBe(
      "/media/2023/03/a.jpg",
    );
  });
});

describe("mediaForUrl: what is recorded when nothing answers", () => {
  test("an upload with no extension is recorded; a page on the same host is not", () => {
    const plan = planMedia(fakeModel([att(1, "a.jpg")]));
    const names = [
      `${SITE}/wp-content/uploads/Professional-Kitchen-Cabinet-Painters-Pa`,
      `${SITE}/blog/`,
      `${SITE}/blog/hello-world`,
    ];
    for (const url of names) plan.mediaForUrl(url);
    expect(plan.unresolved).toEqual([names[0]!]);
  });

  test("the lists a plan hands out are copies, both of them", () => {
    const plan = planMedia(fakeModel([att(1, "a.jpg")]));
    plan.mediaForUrl("https://elsewhere.example.org/x.jpg");
    plan.mediaForUrl(`${SITE}/wp-content/uploads/missing.jpg`);
    plan.external.push("tampered");
    plan.unresolved.push("tampered");
    expect(plan.external).toEqual(["https://elsewhere.example.org/x.jpg"]);
    expect(plan.unresolved).toEqual([`${SITE}/wp-content/uploads/missing.jpg`]);
    expect(plan.external).not.toBe(plan.external);
  });
});

// ── extraUrls: families of addresses no attachment stands behind ─────────────────────────────────

describe("planMedia: extraUrls", () => {
  const up = (name: string, base = `${SITE}/wp-content/uploads/`): string => `${base}${name}`;
  const extras = (names: string[], over: Parameters<typeof planMedia>[1] = {}) =>
    planMedia(fakeModel([]), { extraUrls: names.map((n) => up(n)), ...over });

  test("the upload itself is the file, then the scaled copy, then the largest crop", () => {
    expect(
      extras(["a-300x200.jpg", "a-1024x683.jpg", "a-scaled.jpg", "a.jpg"]).files.map((f) => f.file),
    ).toEqual(["a.jpg"]);
    expect(
      extras(["a-300x200.jpg", "a-1024x683.jpg", "a-scaled.jpg"]).files.map((f) => f.file),
    ).toEqual(["a-scaled.jpg"]);
    expect(
      extras(["a-300x200.jpg", "a-1024x683.jpg", "a-768x512.jpg"]).files.map((f) => f.file),
    ).toEqual(["a-1024x683.jpg"]);
  });

  test("a crop that is all there is carries its own dimensions, and a sized scaled copy joins the family", () => {
    const plan = extras(["a-300x200.jpg", "a-1024x683.jpg"]);
    expect(plan.files[0]).toMatchObject({
      file: "a-1024x683.jpg",
      width: 1024,
      height: 683,
      mime: "image/jpeg",
    });
    const stacked = extras(["a-scaled-1024x683.jpg", "a-scaled.jpg"]);
    expect(stacked.files.map((f) => f.file)).toEqual(["a-scaled.jpg"]);
    expect("width" in stacked.files[0]!).toBe(false);
    // Two crops of the same area: the name decides, so the plan does not depend on what was met first.
    const tie = extras(["a-200x300.jpg", "a-300x200.jpg"]);
    expect(tie.files.map((f) => f.file)).toEqual(["a-200x300.jpg"]);
    expect(extras(["a-300x200.jpg", "a-200x300.jpg"]).files).toEqual(tie.files);
  });

  test("a family is a directory, a stem and an extension: nothing else merges", () => {
    const plan = extras([
      "a.jpg",
      "a.png",
      "2023/a.jpg",
      "b.jpg",
      "a-1.jpg",
      "A.jpg",
      "a.JPG",
      "a-300x200.png",
    ]);
    // Extensions are not case-sensitive (as in the importer), names are; of `a.JPG` and `a.jpg` the name decides.
    expect(plan.files.map((f) => f.file)).toEqual([
      "2023/a.jpg",
      "A.jpg",
      "a-1.jpg",
      "a.JPG",
      "a.png",
      "b.jpg",
    ]);
    expect(plan.stats.extraFiles).toBe(plan.files.length);
    expect(plan.mediaForUrl(up("a-300x200.png"))?.src).toBe(plan.mediaForUrl(up("a.png"))?.src);
    expect(plan.mediaForUrl(up("a-300x200.png"))?.src).not.toBe(plan.mediaForUrl(up("a.jpg"))?.src);
    expect(plan.mediaForUrl(up("a.jpg"))?.src).toBe(plan.mediaForUrl(up("a.JPG"))?.src);
  });

  test("the same address in other spellings is one member", () => {
    const plan = planMedia(fakeModel([]), {
      extraUrls: [
        `${SITE}/wp-content/uploads/a.jpg`,
        `http://example.com/wp-content/uploads/a.jpg`,
        `//example.com/wp-content/uploads/a.jpg`,
        `https://www.EXAMPLE.com/wp-content/uploads/a.jpg?ver=2`,
        `/wp-content/uploads/a.jpg`,
      ],
    });
    expect(plan.files.length).toBe(1);
    expect(plan.files[0]!.fallbackUrls).toEqual([]);
    expect(plan.files[0]!.sourceUrl).toBe(`${SITE}/wp-content/uploads/a.jpg`);
  });

  test("the order the addresses arrive in changes nothing; any iterable will do", () => {
    const names = [
      "z-300x200.jpg",
      "m.png",
      "z.jpg",
      "a-768x512.webp",
      "m-scaled.png",
      "2022/k.jpg",
      "z-scaled.jpg",
    ];
    const forward = extras(names).files;
    expect(extras([...names].reverse()).files).toEqual(forward);
    expect(forward.map((f) => f.file)).toEqual(["2022/k.jpg", "a-768x512.webp", "m.png", "z.jpg"]);
    const set = planMedia(fakeModel([]), { extraUrls: new Set(names.map((n) => up(n))) });
    expect(set.files).toEqual(forward);
    function* generate(): Generator<string> {
      for (const n of names) yield up(n);
    }
    expect(planMedia(fakeModel([]), { extraUrls: generate() }).files).toEqual(forward);
  });

  test("an address an attachment accounts for is not planned again, whatever size it names", () => {
    const model = fakeModel([
      att(1, "2023/03/a.jpg", { sizes: [size("a-300x200.jpg", 300, 200)] }),
    ]);
    const plan = planMedia(model, {
      extraUrls: [
        up("2023/03/a.jpg"),
        up("2023/03/a-300x200.jpg"),
        up("2023/03/a-640x427.jpg"),
        up("2023/03/b.jpg"),
      ],
    });
    expect(plan.files.map((f) => f.file)).toEqual(["2023/03/a.jpg", "2023/03/b.jpg"]);
    expect(plan.stats).toMatchObject({ attachments: 1, files: 2, extraFiles: 1 });
    // The attachment answers for its own, with its alt text; the extra has none.
    expect(plan.mediaForUrl(up("2023/03/a-640x427.jpg"))?.src).toBe("/media/2023/03/a.jpg");
    expect("alt" in plan.mediaForUrl(up("2023/03/b.jpg"))!).toBe(false);
  });

  test("an address on another host is external, one on the site outside uploads is unresolved; neither is planned", () => {
    const plan = planMedia(fakeModel([]), {
      extraUrls: [
        "https://other.example.org/wp-content/uploads/a.jpg",
        `${SITE}/sites/default/files/b.jpg`,
        `${SITE}/wp-content/uploads/c.jpg`,
        "data:image/gif;base64,R0lGOD",
        "",
      ],
    });
    expect(plan.files.map((f) => f.file)).toEqual(["c.jpg"]);
    expect(plan.external).toEqual(["https://other.example.org/wp-content/uploads/a.jpg"]);
    expect(plan.unresolved).toEqual([`${SITE}/sites/default/files/b.jpg`]);
  });

  test("it is fetched from where the address was seen, with the site's own uploads and the other sizes as fallbacks", () => {
    const model = fakeModel([
      att(1, "2023/03/x.jpg", { url: "https://media.example.net/2023/03/x.jpg" }),
    ]);
    const plan = planMedia(model, {
      extraUrls: [
        "https://media.example.net/2024/01/new-300x200.jpg",
        "https://media.example.net/2024/01/new-1024x683.jpg",
      ],
    });
    const file = plan.files.at(-1)!;
    expect(file.file).toBe("2024/01/new-1024x683.jpg");
    expect(file.sourceUrl).toBe("https://media.example.net/2024/01/new-1024x683.jpg");
    expect(file.fallbackUrls).toEqual([
      "https://media.example.net/2024/01/new-300x200.jpg",
      `${SITE}/wp-content/uploads/2024/01/new-1024x683.jpg`,
    ]);
  });

  test("names are made safe like an attachment's, and never take an attachment's path", () => {
    const model = fakeModel([att(1, "a-b.png")]);
    const plan = planMedia(model, { extraUrls: [up("a%20b.png"), up("c%20d.jpg")] });
    expect(plan.files.map((f) => f.destPath)).toEqual([
      "public/media/a-b.png",
      "public/media/a-b-2.png",
      "public/media/c-d.jpg",
    ]);
    expect(plan.files[1]!.file).toBe("a b.png");
    expect(plan.files[1]!.sourceUrl).toBe(`${SITE}/wp-content/uploads/a%20b.png`);
    expect(plan.mediaForUrl(up("a%20b.png"))?.src).toBe("/media/a-b-2.png");
    expect(plan.mediaForUrl(up("a-b.png"))?.src).toBe("/media/a-b.png");
  });

  test("a size nobody listed folds into a family that was listed, and a stranger's does not", () => {
    const plan = extras(["a.jpg"]);
    expect(plan.mediaForUrl(up("a-1536x1024.jpg"))?.src).toBe("/media/a.jpg");
    expect(plan.mediaForUrl(up("a-scaled.jpg"))?.src).toBe("/media/a.jpg");
    expect(plan.mediaForUrl(up("b-1536x1024.jpg"))).toBeUndefined();
    expect(plan.mediaForUrl(up("a.png"))).toBeUndefined();
    expect(plan.unresolved).toEqual([up("b-1536x1024.jpg"), up("a.png")]);
  });

  test("a bare marker is a name like any other", () => {
    const plan = extras(["-scaled.jpg", ".jpg", "a-scaled.jpg", "a.jpg"]);
    expect(plan.files.map((f) => f.file)).toEqual(["-scaled.jpg", ".jpg", "a.jpg"]);
  });

  test("nothing is planned without addresses", () => {
    const plan = planMedia(fakeModel([]));
    expect(plan.files).toEqual([]);
    expect(plan.stats).toEqual({
      attachments: 0,
      unplanned: 0,
      files: 0,
      extraFiles: 0,
      aliases: 0,
    });
    expect(planMedia(fakeModel([]), { extraUrls: [] }).files).toEqual([]);
  });
});

// ── Property tests: families as WordPress makes them ─────────────────────────────────────────────
// A seeded generator writes attachments by WordPress's rules: an upload past 2,560 pixels gets a
// `-scaled` copy and keeps itself as `original_image`; sizes are named after the upload and exist only
// where the image is bigger than the box; an edit in the media editor writes `<name>-e<ms>.<ext>`,
// regenerates the sizes it can and leaves the ones it cannot (so a stale size can be bigger than the
// edit); the guid is the upload's address. Names are never reused, as `wp_unique_filename` sees to.

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

function fitWithin(w: number, h: number, bw: number, bh: number): [number, number] | undefined {
  const f = Math.min(bw / w, bh / h);
  return f >= 1 ? undefined : [Math.max(1, Math.round(w * f)), Math.max(1, Math.round(h * f))];
}

const BOXES = [
  ["medium", 300, 300],
  ["medium_large", 768, 100_000],
  ["large", 1024, 1024],
  ["1536x1536", 1536, 1536],
  ["2048x2048", 2048, 2048],
] as const;

interface Generated {
  att: WpAttachment;
  /** The upload's name, which is the guid's, relative to uploads. */
  upload: string;
  /** Every name WordPress knows for the picture. */
  names: string[];
  /** Sizes WordPress kept from before an edit: bigger than the edit when the edit shrank it. */
  stale: string[];
  scaled: boolean;
  edited: boolean;
  /** `file` without its extension, for deriving sizes nobody listed. */
  fileStem: string;
  ext: string;
  dir: string;
  stem: string;
}

const WORDS = [
  "barn",
  "kitchen",
  "log-cabin",
  "IMG",
  "photo",
  "Banner",
  "hero",
  "team",
  "DSC_0042",
  "résumé",
  "Дом",
  "a",
  "x1",
  "Pa-",
];

function stemOf(r: Rng): string {
  let stem = pick(r, WORDS);
  if (r() < 0.5) stem += `-${between(r, 1, 4000)}`;
  const k = r();
  if (k < 0.2) stem += `-${between(r, 1, 9)}`;
  else if (k < 0.3) stem += `-${between(r, 100, 2000)}x${between(r, 100, 2000)}`; // an upload whose name looks like a size
  else if (k < 0.35) stem += "-edited";
  else if (k < 0.4) stem += `_${between(r, 10, 99)}`;
  return stem;
}

function generate(r: Rng, id: number, dir: string, stem: string, ext: string): Generated {
  const upload = `${dir}${stem}.${ext}`;
  let w = between(r, 120, 6500);
  let h = between(r, 120, 6500);
  let file = upload;
  let original: string | undefined;
  let fileStem = stem;
  const scaled = Math.max(w, h) > 2560;
  if (scaled) {
    [w, h] = fitWithin(w, h, 2560, 2560)!;
    fileStem = `${stem}-scaled`;
    file = `${dir}${fileStem}.${ext}`;
    original = upload;
  }
  let sizes: ReturnType<typeof size>[] = [];
  const addSizes = (named: string, fromW: number, fromH: number): void => {
    if (fromW >= 150 && fromH >= 150)
      sizes.push(size(`${named}-150x150.${ext}`, 150, 150, "thumbnail"));
    for (const [name, bw, bh] of BOXES) {
      const fit = fitWithin(fromW, fromH, bw, bh);
      if (fit) sizes.push(size(`${named}-${fit[0]}x${fit[1]}.${ext}`, fit[0], fit[1], name));
    }
  };
  addSizes(stem, w, h);
  let stale: string[] = [];
  const edited = r() < 0.3;
  if (edited) {
    const stamp = 1_500_000_000_000 + between(r, 0, 900_000_000_000);
    const nw = Math.max(40, Math.round(w * (0.4 + r() * 0.5)));
    const nh = Math.max(40, Math.round(h * (0.4 + r() * 0.5)));
    fileStem = `${fileStem}-e${stamp}`;
    file = `${dir}${fileStem}.${ext}`;
    sizes = sizes.filter((s) => s.width > nw || s.height > nh);
    stale = sizes.map((s) => dir + s.file);
    addSizes(fileStem, nw, nh);
    w = nw;
    h = nh;
  }
  const attachment = att(id, file, {
    url: `${SITE}/wp-content/uploads/${encodePath(upload)}`,
    width: w,
    height: h,
    sizes,
    ...(original === undefined ? {} : { originalFile: original }),
  });
  const names = [
    ...new Set([file, ...(original ? [original] : []), upload, ...sizes.map((s) => dir + s.file)]),
  ];
  return { att: attachment, upload, names, stale, scaled, edited, fileStem, ext, dir, stem };
}

/** Families whose names never meet, in a few directories, with names built to confuse a matcher. */
function generateSite(seed: number, count: number): Generated[] {
  const r = mulberry32(seed);
  const used = new Set<string>();
  const out: Generated[] = [];
  for (let id = 1; out.length < count && id < count * 20; id++) {
    const dir = pick(r, ["", "2023/03/", "2023/04/", "2024/01/"]);
    const g = generate(r, out.length + 1, dir, stemOf(r), pick(r, ["jpg", "jpeg", "png", "webp"]));
    // WordPress never writes a name twice, in any case-folding a server might apply.
    const keys = g.names.map((n) => n.toLowerCase());
    if (new Set(keys).size !== keys.length || keys.some((k) => used.has(k))) continue;
    for (const k of keys) used.add(k);
    out.push(g);
  }
  return out;
}

describe.each([1, 2, 3, 4])("family collapse, seed %d", (seed) => {
  const families = generateSite(seed * 7919, 250);
  const model = fakeModel(families.map((g) => g.att));
  const plan = planMedia(model);
  const urlFor = (name: string, i = 0): string =>
    spellings(`${SITE}/wp-content/uploads/`, name)[i]!;

  test("the generator really makes the hard cases", () => {
    expect(families.length).toBe(250);
    expect(families.filter((g) => g.scaled).length).toBeGreaterThan(20);
    expect(families.filter((g) => g.edited).length).toBeGreaterThan(40);
    expect(families.filter((g) => g.scaled && g.edited).length).toBeGreaterThan(5);
    // An edit that left a size bigger than itself.
    const att0 = (g: Generated) => g.att;
    expect(
      families.filter(
        (g) =>
          g.edited &&
          g.att.sizes.some((s) => s.width * s.height > att0(g).width! * att0(g).height!),
      ).length,
    ).toBeGreaterThan(10);
  });

  test("one file per family, the one WordPress serves, with its own dimensions", () => {
    expect(plan.files.length).toBe(families.length);
    for (const g of families) {
      const file = plan.files.find((f) => f.attachmentIds[0] === g.att.id)!;
      expect(file.file).toBe(g.att.file);
      expect([file.width, file.height]).toEqual([g.att.width, g.att.height]);
      expect(plan.mediaFor(g.att.id)?.src).toBe(file.publicPath);
    }
    // No size, stale or fresh, and no unscaled upload is ever a file.
    const shipped = new Set(plan.files.map((f) => f.file));
    for (const g of families) {
      for (const n of g.names) if (n !== g.att.file) expect(shipped.has(n)).toBe(false);
    }
  });

  test("every name of a family, in every spelling, is that family's file and no other's", () => {
    const wrong: string[] = [];
    for (const g of families) {
      const want = plan.mediaFor(g.att.id)!.src;
      for (const name of g.names) {
        for (let i = 0; i < 8; i++) {
          const got = plan.mediaForUrl(urlFor(name, i))?.src;
          if (got !== want) wrong.push(`${name} #${i}: ${got} != ${want}`);
        }
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  test("a size nobody listed, named after the upload or the file, is still the family's", () => {
    const r = mulberry32(seed);
    const all = new Set(families.flatMap((g) => g.names.map((n) => n.toLowerCase())));
    const wrong: string[] = [];
    let probes = 0;
    for (const g of families) {
      for (const base of new Set([g.stem, g.fileStem])) {
        for (let n = 0; n < 2; n++) {
          const name = `${g.dir}${base}-${between(r, 20, 3000)}x${between(r, 20, 3000)}.${g.ext}`;
          if (all.has(name.toLowerCase())) continue;
          probes++;
          const got = plan.mediaForUrl(urlFor(name))?.src;
          if (got !== plan.mediaFor(g.att.id)!.src) wrong.push(`${name}: ${got}`);
        }
      }
    }
    expect(probes).toBeGreaterThan(500);
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  test("a name outside every family is nobody's", () => {
    const fresh = planMedia(model);
    const asked = new Set<string>();
    for (const g of families.slice(0, 60)) {
      for (const name of [
        `${g.dir}${g.stem}-nobody.${g.ext}`,
        `${g.dir}other-${g.stem}.${g.ext}`,
        // The same name in another directory is another file.
        `1999/12/${g.stem}.${g.ext}`,
      ]) {
        expect(fresh.mediaForUrl(urlFor(name))).toBeUndefined();
        asked.add(urlFor(name));
      }
    }
    expect(fresh.unresolved).toEqual([...asked]);
  });

  test("paths are unique when case-folded, and inside the output directory", () => {
    const keys = plan.files.map((f) => f.destPath.normalize("NFD").toLowerCase());
    expect(new Set(keys).size).toBe(plan.files.length);
    for (const f of plan.files) expect(f.destPath.startsWith("public/media/")).toBe(true);
  });

  test("the plan does not depend on the order the attachments come in", () => {
    const r = mulberry32(seed);
    const shuffled = families.map((g) => g.att).sort(() => r() - 0.5);
    expect(planMedia(fakeModel(shuffled)).files).toEqual(plan.files);
  });

  test("with preferUnscaled the upload is shipped where the scaled copy is its twin, and every name still resolves", () => {
    const unscaled = planMedia(model, { preferUnscaled: true });
    expect(unscaled.files.length).toBe(plan.files.length);
    const wrong: string[] = [];
    for (const g of families) {
      const file = unscaled.files.find((f) => f.attachmentIds[0] === g.att.id)!;
      // A scaled copy that was then edited is no longer the upload's twin.
      const expected = g.scaled && !g.edited ? g.upload : g.att.file;
      if (file.file !== expected) wrong.push(`${g.att.id}: ${file.file} != ${expected}`);
      for (const name of g.names) {
        if (unscaled.mediaForUrl(urlFor(name))?.src !== file.publicPath)
          wrong.push(`${name} does not reach ${file.publicPath}`);
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });
});

describe.each([1, 2, 3])("family collapse of addresses with no attachment, seed %d", (seed) => {
  // Families of addresses as a page's srcset lists them: some have the upload, some only sizes.
  const r = mulberry32(seed * 104729);
  interface Cluster {
    dir: string;
    stem: string;
    ext: string;
    members: string[];
    winner: string;
    area?: [number, number];
  }
  const clusters: Cluster[] = [];
  const taken = new Set<string>();
  while (clusters.length < 150) {
    const dir = pick(r, ["", "2023/03/", "2024/01/"]);
    const stem = `${pick(r, ["hero", "barn", "Kitchen", "x"])}-${between(r, 1, 400)}`;
    const ext = pick(r, ["jpg", "png", "webp"]);
    if (taken.has(`${dir}${stem}.${ext}`)) continue;
    taken.add(`${dir}${stem}.${ext}`);
    const upload = r() < 0.5;
    const scaled = r() < 0.4;
    const crops: [number, number][] = [];
    for (let n = between(r, 0, 4); n > 0; n--) {
      const c: [number, number] = [between(r, 50, 2000), between(r, 50, 2000)];
      if (!crops.some((x) => x[0] === c[0] && x[1] === c[1])) crops.push(c);
    }
    const members = [
      ...(upload ? [`${dir}${stem}.${ext}`] : []),
      ...(scaled ? [`${dir}${stem}-scaled.${ext}`] : []),
      ...crops.map(([cw, ch]) => `${dir}${stem}-${cw}x${ch}.${ext}`),
    ];
    if (members.length === 0) continue;
    let winner: string;
    let area: [number, number] | undefined;
    if (upload) winner = `${dir}${stem}.${ext}`;
    else if (scaled) winner = `${dir}${stem}-scaled.${ext}`;
    else {
      const best = [...crops].sort(
        (a, b) =>
          b[0] * b[1] - a[0] * a[1] ||
          (`${dir}${stem}-${a[0]}x${a[1]}.${ext}` < `${dir}${stem}-${b[0]}x${b[1]}.${ext}`
            ? -1
            : 1),
      )[0]!;
      winner = `${dir}${stem}-${best[0]}x${best[1]}.${ext}`;
      area = best;
    }
    clusters.push({ dir, stem, ext, members, winner, ...(area ? { area } : {}) });
  }
  const urls = clusters.flatMap((c) =>
    c.members.map((m) => `${SITE}/wp-content/uploads/${encodePath(m)}`),
  );

  test("one file per cluster, the upload, else the scaled copy, else the largest crop", () => {
    const plan = planMedia(fakeModel([]), { extraUrls: urls });
    expect(plan.files.length).toBe(clusters.length);
    for (const c of clusters) {
      const file = plan.files.find((f) => f.file === c.winner);
      expect(file).toBeDefined();
      expect([file!.width, file!.height]).toEqual(c.area ?? [undefined, undefined]);
      for (const m of c.members)
        expect(plan.mediaForUrl(`${SITE}/wp-content/uploads/${encodePath(m)}`)?.src).toBe(
          file!.publicPath,
        );
    }
    expect(plan.unresolved).toEqual([]);
  });

  test("the plan does not depend on the order of the addresses", () => {
    const forward = planMedia(fakeModel([]), { extraUrls: urls }).files;
    const shuffled = [...urls].sort(() => r() - 0.5);
    expect(planMedia(fakeModel([]), { extraUrls: shuffled }).files).toEqual(forward);
  });
});

// ── Sniffing ─────────────────────────────────────────────────────────────────────────────────────

const b64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/** One-pixel files that real decoders accept, one per format. */
const PNG = b64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
);
const JPEG = b64(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
);
const GIF = b64("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
const WEBP = b64("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==");
const SVG = utf8(
  '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: Adobe Illustrator 26 -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>\n',
);
const PDF = utf8("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const MP3 = Uint8Array.from([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00,
]);
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00]);
const CSV = utf8("email,name\nsomeone@example.com,Someone\n");
const HTML_404 = utf8(
  "<!DOCTYPE html>\n<html><head><title>Page not found</title></head><body><h1>404</h1><p>Nothing here.</p></body></html>",
);

describe("sniffMediaType", () => {
  test("it knows the common image formats, SVG, PDF, ZIP and MP3 by their first bytes", () => {
    expect(sniffMediaType(JPEG)).toBe("image/jpeg");
    expect(sniffMediaType(PNG)).toBe("image/png");
    expect(sniffMediaType(GIF)).toBe("image/gif");
    expect(sniffMediaType(WEBP)).toBe("image/webp");
    expect(sniffMediaType(SVG)).toBe("image/svg+xml");
    expect(sniffMediaType(PDF)).toBe("application/pdf");
    expect(sniffMediaType(ZIP)).toBe("application/zip");
    expect(sniffMediaType(MP3)).toBe("audio/mpeg");
    expect(sniffMediaType(Uint8Array.from([0xff, 0xf3, 0x44, 0xc4]))).toBe("audio/mpeg");
  });

  test("it knows the other signatures a media library holds", () => {
    const ftyp = (brand: string): Uint8Array =>
      Uint8Array.from([
        0,
        0,
        0,
        0x18,
        0x66,
        0x74,
        0x79,
        0x70,
        ...[...brand].map((c) => c.charCodeAt(0)),
        0,
        0,
        0,
        0,
      ]);
    expect(sniffMediaType(ftyp("avif"))).toBe("image/avif");
    expect(sniffMediaType(ftyp("heic"))).toBe("image/heic");
    expect(sniffMediaType(ftyp("isom"))).toBe("video/mp4");
    expect(sniffMediaType(ftyp("qt  "))).toBe("video/quicktime");
    expect(sniffMediaType(Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]))).toBe(
      "image/tiff",
    );
    expect(sniffMediaType(Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]))).toBe(
      "image/tiff",
    );
    expect(
      sniffMediaType(Uint8Array.from([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0])),
    ).toBe("image/bmp");
    expect(sniffMediaType(Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16]))).toBe("image/x-icon");
    expect(sniffMediaType(utf8("OggS\0\u0002"))).toBe("audio/ogg");
    expect(sniffMediaType(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe("video/webm");
    expect(sniffMediaType(utf8("RIFF$\0\0\0WAVEfmt "))).toBe("audio/wav");
  });

  test("an SVG may start with a byte order mark, a declaration, comments and a doctype", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    for (const head of [
      "",
      "﻿",
      '<?xml version="1.0" standalone="no"?>',
      "  \n<!-- one --><!-- two -->\n",
      '<?xml version="1.0"?>\n<!-- Created with Inkscape -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n',
      '<!DOCTYPE svg [ <!ENTITY ns_svg "http://www.w3.org/2000/svg"> ]>\n',
    ]) {
      expect(sniffMediaType(utf8(head + svg))).toBe("image/svg+xml");
    }
    expect(sniffMediaType(utf8("<SVG\n width='1'/>"))).toBe("image/svg+xml");
    expect(sniffMediaType(utf8("<svg>"))).toBe("image/svg+xml");
  });

  test("an error page is HTML, however it starts", () => {
    for (const page of [
      "<!DOCTYPE html><html><body>nope</body></html>",
      "  \n<!doctype HTML>\n<html>",
      "<html><head></head></html>",
      "﻿<HTML>",
      "<head><title>Forbidden</title></head>",
      "<body>nope</body>",
      "<title>404</title>",
      '<meta http-equiv="refresh" content="0; url=/login">',
      "<script>location='/login'</script>",
      "<div class='error'>Not found</div>",
      "<h1>Not Found</h1>",
      "<br />\n<b>Warning</b>:  Undefined variable in <b>/var/www/x.php</b>",
      "<?php die('no'); ?>",
      "<!-- cached -->\n<!DOCTYPE html>\n<html lang=en>",
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">',
    ]) {
      expect([page, sniffMediaType(utf8(page))]).toEqual([page, "text/html"]);
    }
    expect(sniffMediaType(HTML_404)).toBe("text/html");
  });

  test("what is not a known format is undefined: text, JSON, empty, a header cut short, noise", () => {
    expect(sniffMediaType(new Uint8Array())).toBeUndefined();
    expect(sniffMediaType(CSV)).toBeUndefined();
    expect(sniffMediaType(utf8('{"error":"gone"}'))).toBeUndefined();
    expect(sniffMediaType(utf8("plain text"))).toBeUndefined();
    expect(sniffMediaType(utf8("<root><child/></root>"))).toBeUndefined();
    expect(sniffMediaType(utf8("<svgfoo/>"))).toBeUndefined();
    expect(sniffMediaType(utf8("<svg"))).toBeUndefined();
    expect(sniffMediaType(Uint8Array.from([0xff, 0xd8]))).toBeUndefined();
    expect(sniffMediaType(PNG.slice(0, 7))).toBeUndefined();
    expect(sniffMediaType(utf8("GIF8"))).toBeUndefined();
    expect(sniffMediaType(utf8("GIF90a"))).toBeUndefined();
    expect(sniffMediaType(utf8("RIFF\0\0\0\0AVI "))).toBeUndefined();
    expect(sniffMediaType(utf8("%PDF"))).toBeUndefined();
    expect(sniffMediaType(utf8("BM is a word"))).toBeUndefined();
    // Text that merely mentions markup is not a page.
    expect(
      sniffMediaType(utf8('post,content\n1,"<html><body>hi</body></html>"\n')),
    ).toBeUndefined();
    expect(sniffMediaType(utf8("a <body> in the middle"))).toBeUndefined();
  });

  test("a real format's bytes are never taken for an error page, and noise is never taken for either", () => {
    for (const real of [JPEG, PNG, GIF, WEBP, SVG, PDF, ZIP, MP3])
      expect(sniffMediaType(real)).not.toBe("text/html");
    let seed = 99;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0;
      return (seed >>> 16) & 0xff;
    };
    let known = 0;
    for (let n = 0; n < 2000; n++) {
      const bytes = Uint8Array.from({ length: 1 + (next() % 40) }, next);
      const kind = sniffMediaType(bytes);
      if (kind !== undefined) known++;
    }
    // Two-byte signatures (BM, FF Ex) will turn up in noise; nothing like a majority.
    expect(known).toBeLessThan(200);
  });
});

// ── Downloading, against a server that fails every way a real one does ───────────────────────────

const SAMPLE_BY_EXT: Record<string, { bytes: Uint8Array<ArrayBuffer>; type: string }> = {
  jpg: { bytes: JPEG, type: "image/jpeg" },
  jpeg: { bytes: JPEG, type: "image/jpeg" },
  png: { bytes: PNG, type: "image/png" },
  gif: { bytes: GIF, type: "image/gif" },
  webp: { bytes: WEBP, type: "image/webp" },
  svg: { bytes: SVG, type: "image/svg+xml" },
  pdf: { bytes: PDF, type: "application/pdf" },
  mp3: { bytes: MP3, type: "audio/mpeg" },
  csv: { bytes: CSV, type: "text/csv" },
  zip: { bytes: ZIP, type: "application/zip" },
};
const sampleFor = (path: string) =>
  SAMPLE_BY_EXT[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? SAMPLE_BY_EXT.jpg!;

interface Fake {
  origin: string;
  /** Requests per path. */
  hits: Map<string, number>;
  maxInFlight(): number;
  total(): number;
  stop(): void;
}

/**
 * The first path segment says how the server misbehaves: `ok`, `octet` (right bytes, wrong type),
 * `missing` (404), `forbidden`, `html200` (an error page with a 200), `html-as-image`, `json200`,
 * `empty`, `redirect` (to `ok`), `redirect-login` (to a login page), `flaky` (503 twice, then
 * fine), `limited` (429 once), `s408` and `s425` (once), `down` (503 always), `slow` (answers after
 * 60 ms), `veryslow`, `labelled-html` and `labelled-xhtml` (the right bytes under a web page's type),
 * `no-type`.
 */
function fakeServer(): Fake {
  const hits = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  let total = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const n = (hits.get(path) ?? 0) + 1;
      hits.set(path, n);
      total++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const [, kind = "", ...rest] = path.split("/");
        const sample = sampleFor(path);
        const ok = (): Response =>
          new Response(sample.bytes, { headers: { "content-type": sample.type } });
        switch (kind) {
          case "ok":
            return ok();
          case "octet":
            return new Response(sample.bytes, {
              headers: { "content-type": "application/octet-stream" },
            });
          case "missing":
            return new Response(HTML_404, {
              status: 404,
              headers: { "content-type": "text/html" },
            });
          case "forbidden":
            return new Response("no", { status: 403 });
          case "html200":
            return new Response(HTML_404, {
              headers: { "content-type": "text/html; charset=UTF-8" },
            });
          case "html-as-image":
            return new Response(HTML_404, { headers: { "content-type": "image/jpeg" } });
          case "json200":
            return new Response('{"error":"gone"}', {
              headers: { "content-type": "application/json" },
            });
          case "empty":
            return new Response(new Uint8Array(), { headers: { "content-type": "image/jpeg" } });
          case "redirect":
            return new Response(null, {
              status: 302,
              headers: { location: `/ok/${rest.join("/")}` },
            });
          case "redirect-login":
            return new Response(null, { status: 302, headers: { location: "/login" } });
          case "login":
            return new Response(HTML_404, { headers: { "content-type": "text/html" } });
          case "flaky":
            return n <= 2 ? new Response("busy", { status: 503 }) : ok();
          case "limited":
            return n === 1
              ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
              : ok();
          case "down":
            return new Response("down", { status: 503 });
          case "s408":
            return n === 1 ? new Response("timeout", { status: 408 }) : ok();
          case "s425":
            return n === 1 ? new Response("early", { status: 425 }) : ok();
          case "labelled-html":
            return new Response(sample.bytes, { headers: { "content-type": "text/html" } });
          case "labelled-xhtml":
            return new Response(sample.bytes, {
              headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
            });
          case "no-type":
            return new Response(sample.bytes);
          case "slow":
            await Bun.sleep(60);
            return ok();
          case "veryslow":
            await Bun.sleep(600);
            return ok();
          default:
            return new Response("?", { status: 500 });
        }
      } finally {
        inFlight--;
      }
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    hits,
    maxInFlight: () => maxInFlight,
    total: () => total,
    stop: () => void server.stop(true),
  };
}

/** What went wrong, file by file: short enough to read in a failure message. */
const problems = (result: {
  outcomes: { status: string; file: MediaFile; error?: string }[];
}): string[] =>
  result.outcomes.filter((o) => o.status === "failed").map((o) => `${o.file.file}: ${o.error}`);

function memoryIo(): {
  written: Map<string, Uint8Array>;
  write(destPath: string, bytes: Uint8Array): Promise<void>;
} {
  const written = new Map<string, Uint8Array>();
  return {
    written,
    async write(destPath, bytes) {
      if (written.has(destPath)) throw new Error(`written twice: ${destPath}`);
      written.set(destPath, bytes);
    },
  };
}

describe("downloadMedia", () => {
  let fake: Fake;
  beforeAll(() => {
    fake = fakeServer();
  });
  afterAll(() => fake.stop());

  beforeEach(() => fake.hits.clear());

  /**
   * A plan whose attachments live at the given server paths (`ok/a.jpg`). The site's own uploads folder
   * would be one more address to try, which these tests only want when they ask for it.
   */
  const planOf = (...paths: string[]): MediaPlan => {
    const plan = planMedia(
      fakeModel(
        paths.map((p, i) => att(i + 1, p, { url: `${fake.origin}/${p}` })),
        { url: fake.origin },
      ),
    );
    return { ...plan, files: plan.files.map((f) => ({ ...f, fallbackUrls: [] })) };
  };
  const quick = { retryDelayMs: 1 };

  test("writes what was served, byte for byte, at each file's destPath, in the plan's order", async () => {
    const paths = [
      "ok/a.jpg",
      "ok/b.png",
      "ok/c.gif",
      "ok/d.webp",
      "ok/e.svg",
      "ok/f.pdf",
      "ok/g.mp3",
      "ok/h.csv",
      "ok/i.zip",
      "ok/2023/03/j.jpeg",
    ];
    const plan = planOf(...paths);
    const io = memoryIo();
    const result = await downloadMedia(plan, io, quick);
    expect(problems(result)).toEqual([]);
    expect(result).toMatchObject({ ok: 10, skipped: 0, failed: 0 });
    expect(result.outcomes.map((o) => o.file.file)).toEqual(paths);
    expect(result.outcomes.every((o) => o.status === "ok" && o.attempts === 1)).toBe(true);
    expect([...io.written.keys()]).toHaveLength(10);
    for (const f of plan.files) {
      expect(io.written.get(f.destPath)).toEqual(sampleFor(f.file).bytes);
      expect(f.destPath).toBe(`public/media/${f.file}`);
    }
    expect(result.bytes).toBe([...io.written.values()].reduce((n, b) => n + b.length, 0));
    expect(result.outcomes[0]!.url).toBe(`${fake.origin}/ok/a.jpg`);
    expect(result.outcomes[0]!.bytes).toBe(JPEG.length);
  });

  test("a 404 or a 403 is a failure at once, with no retry, and goes in the report", async () => {
    const plan = planOf("missing/a.jpg", "forbidden/b.jpg", "ok/c.jpg");
    const io = memoryIo();
    const report = createReport();
    const result = await downloadMedia(plan, io, { ...quick, report });
    expect(result).toMatchObject({ ok: 1, failed: 2, skipped: 0 });
    expect(fake.hits.get("/missing/a.jpg")).toBe(1);
    expect(fake.hits.get("/forbidden/b.jpg")).toBe(1);
    expect([...io.written.keys()]).toEqual(["public/media/ok/c.jpg"]);
    expect(result.outcomes[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(result.outcomes[0]!.error).toContain("HTTP 404");
    const entries = report.entries();
    expect(entries.length).toBe(2);
    expect(entries[0]).toMatchObject({
      severity: "error",
      code: "media.download-failed",
      where: "post:1",
      url: `${fake.origin}/missing/a.jpg`,
      data: { file: "missing/a.jpg", destPath: "public/media/missing/a.jpg", attachmentIds: [1] },
    });
    expect(entries[0]!.message).toContain("/media/missing/a.jpg");
    expect(entries[1]).toMatchObject({ where: "post:2", url: `${fake.origin}/forbidden/b.jpg` });
    expect((entries[0]!.data as { attempts: unknown[] }).attempts).toEqual([
      { url: `${fake.origin}/missing/a.jpg`, error: "HTTP 404" },
    ]);
  });

  test("an HTML page served with status 200 is never written as an image, whatever it says it is", async () => {
    const plan = planOf(
      "html200/a.jpg",
      "html-as-image/b.png",
      "json200/c.webp",
      "empty/d.jpg",
      "html200/e.svg",
      "html200/f.pdf",
      "html200/g.csv",
      "html200/h.mp3",
    );
    const io = memoryIo();
    const report = createReport();
    const result = await downloadMedia(plan, io, { ...quick, report });
    expect(result).toMatchObject({ ok: 0, failed: 8 });
    expect(io.written.size).toBe(0);
    const why = result.outcomes.map((o) => o.error!);
    expect(why[0]).toContain("HTML page");
    expect(why[1]).toContain("HTML page");
    expect(why[2]).toContain("not an image");
    expect(why[3]).toContain("body is empty");
    expect(why[4]).toContain("HTML page");
    expect(why[5]).toContain("HTML page");
    expect(why[6]).toContain("HTML page");
    expect(why[7]).toContain("HTML page");
    // Deterministic failures are not retried.
    for (const p of ["html200/a.jpg", "html-as-image/b.png", "json200/c.webp", "empty/d.jpg"])
      expect(fake.hits.get(`/${p}`)).toBe(1);
    expect(report.entries().every((e) => e.code === "media.download-failed")).toBe(true);
  });

  test("a type the bytes confirm is accepted whatever the server calls it; a type they contradict is not", async () => {
    const plan = planOf("octet/a.jpg", "octet/b.png", "octet/c.svg", "octet/d.pdf", "octet/e.zip");
    const io = memoryIo();
    expect(await downloadMedia(plan, io, quick)).toMatchObject({ ok: 5, failed: 0 });
    // A PNG under a .jpg name is a picture all the same; a PDF under a .jpg name is not.
    const swapped = planOf("ok/x.png");
    const mismatch = {
      ...swapped.files[0]!,
      file: "x.jpg",
      mime: "image/jpeg",
      destPath: "public/media/x.jpg",
    };
    const io2 = memoryIo();
    expect(await downloadMedia({ files: [mismatch] }, io2, quick)).toMatchObject({ ok: 1 });
    const pdfAsJpg = {
      ...swapped.files[0]!,
      sourceUrl: `${fake.origin}/ok/y.pdf`,
      fallbackUrls: [],
    };
    const io3 = memoryIo();
    const r3 = await downloadMedia({ files: [pdfAsJpg] }, io3, quick);
    expect(r3.failed).toBe(1);
    expect(r3.outcomes[0]!.error).toContain("not an image");
  });

  test("a redirect is followed; a redirect to a login page is a failure", async () => {
    const plan = planOf("redirect/a.jpg", "redirect-login/b.jpg");
    const io = memoryIo();
    const result = await downloadMedia(plan, io, quick);
    expect(result.outcomes.map((o) => o.status)).toEqual(["ok", "failed"]);
    expect(io.written.get("public/media/redirect/a.jpg")).toEqual(JPEG);
    expect(fake.hits.get("/ok/a.jpg")).toBe(1);
    expect(result.outcomes[1]!.error).toContain("HTML page");
  });

  test("a failure that may pass is retried: 503 twice then fine, 429 once, a dropped connection", async () => {
    const plan = planOf("flaky/a.jpg", "limited/b.jpg");
    const io = memoryIo();
    const result = await downloadMedia(plan, io, quick);
    expect(result).toMatchObject({ ok: 2, failed: 0 });
    expect(result.outcomes.map((o) => o.attempts)).toEqual([3, 2]);
    expect(fake.hits.get("/flaky/a.jpg")).toBe(3);
    expect(fake.hits.get("/limited/b.jpg")).toBe(2);
    // A connection that never opens is retried the same way.
    let calls = 0;
    const unreliable = async (url: string, init?: RequestInit): Promise<Response> => {
      if (++calls < 3) throw new Error("ECONNRESET");
      return fetch(url, init);
    };
    const again = await downloadMedia(planOf("ok/z.jpg"), memoryIo(), {
      ...quick,
      fetch: unreliable,
    });
    expect(again.outcomes[0]).toMatchObject({ status: "ok", attempts: 3 });
  });

  test("retries is how many more attempts an address gets, and every one of them is reported", async () => {
    const report = createReport();
    for (const [retries, requests] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [4, 5],
    ] as const) {
      const path = `/down/r${retries}.jpg`;
      const result = await downloadMedia(planOf(`down/r${retries}.jpg`), memoryIo(), {
        ...quick,
        retries,
        report,
      });
      expect(result.outcomes[0]).toMatchObject({ status: "failed", attempts: requests });
      expect(fake.hits.get(path)).toBe(requests);
    }
    const attempts = (report.entries()[3]!.data as { attempts: unknown[] }).attempts;
    expect(attempts.length).toBe(5);
    expect(new Set(attempts.map((a) => JSON.stringify(a))).size).toBe(1);
  });

  test("a file no address can give is failed, with every address and what it said", async () => {
    const base = planOf("missing/a.jpg").files[0]!;
    const file: MediaFile = {
      ...base,
      fallbackUrls: [`${fake.origin}/forbidden/a.jpg`, `${fake.origin}/html200/a.jpg`],
    };
    const report = createReport();
    const result = await downloadMedia({ files: [file] }, memoryIo(), { ...quick, report });
    expect(result.failed).toBe(1);
    expect(result.outcomes[0]!.attempts).toBe(3);
    expect(result.outcomes[0]!.error).toBe(
      `${fake.origin}/missing/a.jpg: HTTP 404; ${fake.origin}/forbidden/a.jpg: HTTP 403; ${fake.origin}/html200/a.jpg: the response is an HTML page, not the file`,
    );
    expect(
      (report.entries()[0]!.data as { attempts: { url: string }[] }).attempts.map((a) => a.url),
    ).toEqual([file.sourceUrl, ...file.fallbackUrls!]);
  });

  test("a fallback is tried when the address before it fails, whatever the way it fails", async () => {
    for (const first of ["missing", "html200", "down", "forbidden"]) {
      const base = planOf(`${first}/a.jpg`).files[0]!;
      const file: MediaFile = { ...base, fallbackUrls: [`${fake.origin}/ok/a.jpg`] };
      const io = memoryIo();
      const result = await downloadMedia({ files: [file] }, io, { ...quick, retries: 1 });
      expect(result.outcomes[0]).toMatchObject({ status: "ok", url: `${fake.origin}/ok/a.jpg` });
      expect(io.written.get(file.destPath)).toEqual(JPEG);
    }
    // And a file that has a good first address never touches its fallback.
    const base = planOf("ok/never.jpg").files[0]!;
    await downloadMedia(
      { files: [{ ...base, fallbackUrls: [`${fake.origin}/ok/never-2.jpg`] }] },
      memoryIo(),
      quick,
    );
    expect(fake.hits.has("/ok/never-2.jpg")).toBe(false);
  });

  test("skipExisting decides before any request is made", async () => {
    const plan = planOf("ok/s1.jpg", "ok/s2.jpg", "ok/s3.jpg");
    const asked: string[] = [];
    const io = memoryIo();
    const result = await downloadMedia(plan, io, {
      ...quick,
      skipExisting: async (dest) => {
        asked.push(dest);
        return dest.endsWith("s2.jpg");
      },
    });
    expect(asked.sort()).toEqual(plan.files.map((f) => f.destPath).sort());
    expect(result).toMatchObject({ ok: 2, skipped: 1, failed: 0, bytes: JPEG.length * 2 });
    expect(result.outcomes[1]).toEqual({ file: plan.files[1]!, status: "skipped", attempts: 0 });
    expect(fake.hits.has("/ok/s2.jpg")).toBe(false);
    expect(io.written.has("public/media/ok/s2.jpg")).toBe(false);
  });

  test("a skipExisting that throws fails that file only", async () => {
    const plan = planOf("ok/t1.jpg", "ok/t2.jpg");
    const report = createReport();
    const result = await downloadMedia(plan, memoryIo(), {
      ...quick,
      report,
      skipExisting: async (dest) => {
        if (dest.endsWith("t1.jpg")) throw new Error("disk on fire");
        return false;
      },
    });
    expect(result.outcomes.map((o) => o.status)).toEqual(["failed", "ok"]);
    expect(result.outcomes[0]!.error).toContain("disk on fire");
    expect(report.entries().map((e) => e.code)).toEqual(["media.download-failed"]);
    expect(fake.hits.has("/ok/t1.jpg")).toBe(false);
  });

  test("a sink that cannot write fails that file only, and is not retried", async () => {
    const plan = planOf("ok/w1.jpg", "ok/w2.jpg");
    const written: string[] = [];
    const report = createReport();
    const result = await downloadMedia(
      plan,
      {
        async write(dest, bytes) {
          if (dest.endsWith("w1.jpg")) throw new Error("EACCES");
          written.push(dest);
          expect(bytes).toEqual(JPEG);
        },
      },
      { ...quick, report },
    );
    expect(result.outcomes.map((o) => o.status)).toEqual(["failed", "ok"]);
    expect(result.outcomes[0]!.error).toContain("could not write: EACCES");
    expect(fake.hits.get("/ok/w1.jpg")).toBe(1);
    expect(written).toEqual(["public/media/ok/w2.jpg"]);
    expect(report.entries()[0]!.data).toMatchObject({ file: "ok/w1.jpg" });
  });

  test("no more than `concurrency` files are in flight at once", async () => {
    for (const [concurrency, want] of [
      [1, 1],
      [3, 3],
      [8, 8],
    ] as const) {
      const local = fakeServer();
      try {
        const paths = Array.from({ length: 16 }, (_, i) => `slow/c${concurrency}-${i}.jpg`);
        const plan = planMedia(
          fakeModel(
            paths.map((p, i) => att(i + 1, p, { url: `${local.origin}/${p}` })),
            { url: local.origin },
          ),
        );
        const result = await downloadMedia(plan, memoryIo(), { ...quick, concurrency });
        expect(result.ok).toBe(16);
        // Never more than asked for; and, unless asked for one, really in parallel.
        expect(local.maxInFlight()).toBeLessThanOrEqual(want);
        expect(local.maxInFlight()).toBeGreaterThanOrEqual(want === 1 ? 1 : Math.ceil(want / 2));
      } finally {
        local.stop();
      }
    }
  });

  test("a request that takes longer than timeoutMs is abandoned", async () => {
    const started = performance.now();
    const result = await downloadMedia(planOf("veryslow/a.jpg"), memoryIo(), {
      ...quick,
      timeoutMs: 40,
      retries: 0,
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.outcomes[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(result.outcomes[0]!.error).toMatch(/timed out|abort/i);
  });

  test("a body shorter than its Content-Length is a failure that is retried; a compressed one is not judged by it", async () => {
    const respond = (headers: Record<string, string>, body: Uint8Array): Response =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(headers),
        arrayBuffer: async () => body.slice().buffer,
      }) as unknown as Response;
    let calls = 0;
    const cut = async (): Promise<Response> =>
      ++calls < 3
        ? respond(
            { "content-type": "image/jpeg", "content-length": String(JPEG.length + 50) },
            JPEG,
          )
        : respond({ "content-type": "image/jpeg", "content-length": String(JPEG.length) }, JPEG);
    const plan = planOf("ok/trunc.jpg");
    const io = memoryIo();
    const result = await downloadMedia(plan, io, { ...quick, fetch: cut });
    expect(result.outcomes[0]).toMatchObject({ status: "ok", attempts: 3 });
    const always = async (): Promise<Response> => respond({ "content-length": "9999" }, JPEG);
    const failed = await downloadMedia(planOf("ok/trunc2.jpg"), memoryIo(), {
      ...quick,
      fetch: always,
      retries: 0,
    });
    expect(failed.outcomes[0]!.error).toMatch(/\d+ bytes, not the 9999 announced/);
    const gzip = async (): Promise<Response> =>
      respond(
        { "content-type": "image/svg+xml", "content-length": "20", "content-encoding": "gzip" },
        SVG,
      );
    const svg = await downloadMedia(planOf("ok/z.svg"), memoryIo(), { ...quick, fetch: gzip });
    expect(svg.ok).toBe(1);
  });

  test("a body that is not the kind of file the plan says is refused, whatever status it came with", async () => {
    const plan = planOf("json200/a.svg", "json200/b.pdf", "json200/c.png", "json200/d.webp");
    const result = await downloadMedia(plan, memoryIo(), quick);
    expect(result.failed).toBe(4);
    expect(result.outcomes[0]!.error).toContain("not an SVG");
    expect(result.outcomes[1]!.error).toContain("not a PDF");
    expect(result.outcomes[2]!.error).toContain("not an image");
    expect(result.outcomes[3]!.error).toContain("not an image");
    // An SVG that is a PNG, or a PDF-named image, is still not what was planned, but an image is an image.
    const svgAsPng = planOf("ok/e.png");
    expect(
      await downloadMedia(
        { files: [{ ...svgAsPng.files[0]!, mime: "image/svg+xml" }] },
        memoryIo(),
        quick,
      ),
    ).toMatchObject({ ok: 1 });
    expect(
      (
        await downloadMedia(
          { files: [{ ...svgAsPng.files[0]!, mime: "application/pdf" }] },
          memoryIo(),
          quick,
        )
      ).failed,
    ).toBe(1);
  });

  test("a type that only the label can speak for: a CSV sent as a web page is refused, bytes that are a known format are not", async () => {
    const plan = planOf(
      "labelled-html/a.csv",
      "labelled-html/b.zip",
      "labelled-html/c.mp3",
      "labelled-xhtml/d.csv",
      "no-type/e.csv",
      "no-type/f.jpg",
      "no-type/g.pdf",
    );
    const io = memoryIo();
    const result = await downloadMedia(plan, io, quick);
    expect(result.outcomes.map((o) => o.status)).toEqual([
      "failed",
      "ok",
      "ok",
      "failed",
      "ok",
      "ok",
      "ok",
    ]);
    expect(result.outcomes[0]!.error).toContain("labelled text/html");
    expect(result.outcomes[3]!.error).toContain("labelled application/xhtml+xml");
    expect(io.written.get("public/media/labelled-html/b.zip")).toEqual(ZIP);
  });

  test("a content type is read without regard to case or parameters", async () => {
    const respond = (type: string): Response =>
      new Response(CSV, { headers: { "content-type": type } });
    for (const type of ["TEXT/HTML", "Text/Html; Charset=UTF-8", "application/XHTML+xml"]) {
      const result = await downloadMedia(planOf("ok/case.csv"), memoryIo(), {
        ...quick,
        fetch: async () => respond(type),
      });
      expect([type, result.outcomes[0]!.status]).toEqual([type, "failed"]);
    }
    for (const type of ["TEXT/CSV", "text/csv; charset=utf-8", "Application/Octet-Stream"]) {
      const result = await downloadMedia(planOf("ok/case.csv"), memoryIo(), {
        ...quick,
        fetch: async () => respond(type),
      });
      expect([type, result.outcomes[0]!.status]).toEqual([type, "ok"]);
    }
  });

  test("the body of an error answer is let go of", async () => {
    let cancelled = 0;
    const answer = async (): Promise<Response> =>
      ({
        ok: false,
        status: 404,
        headers: new Headers(),
        body: { cancel: () => (cancelled++, Promise.resolve()) },
      }) as unknown as Response;
    await downloadMedia(planOf("ok/cancel.jpg"), memoryIo(), { ...quick, fetch: answer });
    expect(cancelled).toBe(1);
    // A body that refuses to be cancelled is no reason to fail anything else.
    const stubborn = async (): Promise<Response> =>
      ({
        ok: false,
        status: 404,
        headers: new Headers(),
        body: { cancel: () => Promise.reject(new Error("locked")) },
      }) as unknown as Response;
    expect(
      (await downloadMedia(planOf("ok/cancel2.jpg"), memoryIo(), { ...quick, fetch: stubborn }))
        .failed,
    ).toBe(1);
  });

  test("a file that is a web page, by its own type, is written as one", async () => {
    const plan = planOf("ok/page.html");
    const html = {
      ...plan.files[0]!,
      mime: "text/html",
      sourceUrl: `${fake.origin}/html200/page.html`,
    };
    const io = memoryIo();
    expect(await downloadMedia({ files: [html] }, io, quick)).toMatchObject({ ok: 1 });
    expect(io.written.get(html.destPath)).toEqual(HTML_404);
  });

  test("408 and 425 are worth another try, like 429 and the 5xx", async () => {
    const plan = planOf("s408/a.jpg", "s425/b.jpg");
    const result = await downloadMedia(plan, memoryIo(), quick);
    expect(result.outcomes.map((o) => [o.status, o.attempts])).toEqual([
      ["ok", 2],
      ["ok", 2],
    ]);
  });

  test("an error that cannot pass is not retried: 400, 401, 404, 410, 451", async () => {
    for (const status of [400, 401, 404, 410, 451]) {
      let calls = 0;
      const gone = async (): Promise<Response> => (
        ++calls,
        { ok: false, status, headers: new Headers() } as unknown as Response
      );
      const result = await downloadMedia(planOf("ok/gone.jpg"), memoryIo(), {
        ...quick,
        fetch: gone,
        retries: 5,
      });
      expect([status, calls, result.outcomes[0]!.attempts]).toEqual([status, 1, 1]);
    }
  });

  test("it says who it is, and takes a name for itself", async () => {
    const seen: Record<string, string>[] = [];
    const spy = async (_url: string, init?: RequestInit): Promise<Response> => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
    };
    await downloadMedia(planOf("ok/h1.jpg"), memoryIo(), { fetch: spy });
    await downloadMedia(planOf("ok/h2.jpg"), memoryIo(), {
      fetch: spy,
      userAgent: "migrator/2 (+https://example.com)",
    });
    expect(seen[0]).toMatchObject({ "user-agent": "wp2jx", accept: "*/*" });
    expect(seen[1]).toMatchObject({ "user-agent": "migrator/2 (+https://example.com)" });
  });

  test("the wait before a retry doubles each time, never passes ten seconds, and does what the server asked", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return real(handler, 0);
    }) as unknown as typeof setTimeout;
    try {
      const respond = (status: number, headers: Record<string, string> = {}): Response =>
        status === 200
          ? new Response(JPEG, { headers: { "content-type": "image/jpeg" } })
          : ({ ok: false, status, headers: new Headers(headers) } as unknown as Response);
      const script = (...statuses: ([number] | [number, Record<string, string>])[]) => {
        let n = 0;
        return async (): Promise<Response> => {
          const [status, headers] = statuses[Math.min(n++, statuses.length - 1)]!;
          return respond(status, headers);
        };
      };
      // 30, 60, 120, 240, capped at ten seconds.
      await downloadMedia(planOf("ok/b1.jpg"), memoryIo(), {
        retryDelayMs: 30,
        retries: 4,
        fetch: script([503], [503], [503], [503], [200]),
      });
      expect(delays).toEqual([30, 60, 120, 240]);
      delays.length = 0;
      await downloadMedia(planOf("ok/b2.jpg"), memoryIo(), {
        retryDelayMs: 4000,
        retries: 3,
        fetch: script([503], [503], [503], [200]),
      });
      expect(delays).toEqual([4000, 8000, 10_000]);
      delays.length = 0;
      // The server's own Retry-After wins when it asks for more, and is never trusted past the cap.
      await downloadMedia(planOf("ok/b3.jpg"), memoryIo(), {
        retryDelayMs: 30,
        retries: 3,
        fetch: script(
          [429, { "retry-after": "2" }],
          [429, { "retry-after": "5000" }],
          [429, { "retry-after": "0" }],
          [200],
        ),
      });
      expect(delays).toEqual([2000, 10_000, 120]);
      delays.length = 0;
      // A date in the past asks for nothing.
      await downloadMedia(planOf("ok/b4.jpg"), memoryIo(), {
        retryDelayMs: 30,
        retries: 1,
        fetch: script([503, { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }], [200]),
      });
      expect(delays).toEqual([30]);
    } finally {
      globalThis.setTimeout = real;
    }
  });

  test("a file without a fallbackUrls field is fetched from its sourceUrl alone", async () => {
    const { fallbackUrls: _dropped, ...bare } = planOf("ok/bare.jpg").files[0]!;
    const io = memoryIo();
    expect(await downloadMedia({ files: [bare] }, io, quick)).toMatchObject({ ok: 1 });
    expect(io.written.get("public/media/ok/bare.jpg")).toEqual(JPEG);
  });

  test("Retry-After is honoured, and capped", async () => {
    const delays: number[] = [];
    const start = performance.now();
    let calls = 0;
    const limited = async (): Promise<Response> => {
      delays.push(performance.now() - start);
      return ++calls === 1
        ? ({
            ok: false,
            status: 429,
            headers: new Headers({ "retry-after": "0.15" }),
          } as unknown as Response)
        : new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
    };
    const result = await downloadMedia(planOf("ok/ra.jpg"), memoryIo(), {
      retryDelayMs: 1,
      fetch: limited,
    });
    expect(result.ok).toBe(1);
    expect(delays[1]! - delays[0]!).toBeGreaterThanOrEqual(140);
  });

  test("progress is reported once per file, counting up; an observer that throws changes nothing", async () => {
    const plan = planOf("ok/p1.jpg", "missing/p2.jpg", "ok/p3.jpg");
    const seen: { done: number; total: number; status: string }[] = [];
    let first = true;
    const result = await downloadMedia(plan, memoryIo(), {
      ...quick,
      concurrency: 1,
      onProgress(p) {
        seen.push({ done: p.done, total: p.total, status: p.outcome.status });
        if (first) {
          first = false;
          throw new Error("observer bug");
        }
      },
    });
    expect(seen).toEqual([
      { done: 1, total: 3, status: "ok" },
      { done: 2, total: 3, status: "failed" },
      { done: 3, total: 3, status: "ok" },
    ]);
    expect(result).toMatchObject({ ok: 2, failed: 1 });
  });

  test("an empty plan downloads nothing", async () => {
    const result = await downloadMedia({ files: [] }, memoryIo());
    expect(result).toEqual({ outcomes: [], ok: 0, skipped: 0, failed: 0, bytes: 0 });
  });

  test("a file found only through extraUrls is reported by its name; a file without an address says so", async () => {
    const model = fakeModel([], { url: fake.origin });
    const plan = planMedia(model, { extraUrls: [`${fake.origin}/wp-content/uploads/gone.jpg`] });
    const report = createReport();
    const result = await downloadMedia(plan, memoryIo(), { ...quick, report });
    expect(result.failed).toBe(1);
    expect(report.entries()[0]).toMatchObject({
      where: "media:gone.jpg",
      data: { attachmentIds: [] },
    });
    const nowhere: MediaFile = { ...planOf("ok/n.jpg").files[0]!, sourceUrl: "", fallbackUrls: [] };
    const r2 = await downloadMedia({ files: [nowhere] }, memoryIo(), { report });
    expect(r2.outcomes[0]!.error).toBe("the file has no source address");
    expect(report.entries().at(-1)).not.toHaveProperty("url");
  });

  test("a Sink from the rest of wp2jx is a valid destination", async () => {
    const files = new Map<string, string | Uint8Array>();
    const sink = {
      async write(path: string, data: string | Uint8Array) {
        files.set(path, data);
      },
    };
    await downloadMedia(planOf("ok/sink.jpg"), sink, quick);
    expect(files.get("public/media/ok/sink.jpg")).toEqual(JPEG);
  });
});

describe("downloadMedia over a real plan, with the network replaced", () => {
  let fake: Fake;
  beforeAll(() => {
    fake = fakeServer();
  });
  afterAll(() => fake.stop());

  /** Sends every request for `hosts` (the keys) to the fake server as `/<kind>/<host>/<path>`. */
  const through =
    (kinds: Record<string, string>, log: string[] = []) =>
    async (url: string, init?: RequestInit): Promise<Response> => {
      const u = new URL(url);
      log.push(u.host);
      const kind = kinds[u.host];
      if (kind === undefined) throw new Error(`getaddrinfo ENOTFOUND ${u.host}`);
      return fetch(`${fake.origin}/${kind}/${u.host}${u.pathname}`, init);
    };

  test("fineline: all 1,233 files arrive, once each, where the plan says", async () => {
    const plan = planMedia(models.fineline);
    const io = memoryIo();
    const log: string[] = [];
    const result = await downloadMedia(plan, io, {
      retryDelayMs: 1,
      fetch: through({ "finelinepainting.pro": "ok", "finelinepainting.avunu.io": "ok" }, log),
      concurrency: 8,
    });
    expect(result).toMatchObject({ ok: 1233, failed: 0, skipped: 0 });
    expect(io.written.size).toBe(1233);
    expect(fake.total()).toBe(1233);
    for (const f of plan.files) {
      expect(sniffMediaType(io.written.get(f.destPath)!)).toBe(
        f.mime === "application/zip" ? "application/zip" : sampleFor(f.file).type,
      );
    }
  });

  test("fineline: the one guid on a dead staging host is fetched from the site after the staging host fails (attachment 29)", async () => {
    const plan = planMedia(models.fineline);
    const file = fileOfId(plan, 29);
    const log: string[] = [];
    const report = createReport();
    const io = memoryIo();
    const result = await downloadMedia({ files: [file] }, io, {
      retryDelayMs: 1,
      fetch: through({ "finelinepainting.pro": "ok" }, log),
      report,
    });
    expect(result.outcomes[0]).toMatchObject({
      status: "ok",
      url: file.fallbackUrls![0],
      attempts: 4,
    });
    // Three tries at the host that does not resolve, one at the site.
    expect(log).toEqual([
      "finelinepainting.avunu.io",
      "finelinepainting.avunu.io",
      "finelinepainting.avunu.io",
      "finelinepainting.pro",
    ]);
    expect(report.entries()).toEqual([]);
    expect(io.written.has(file.destPath)).toBe(true);
  });

  test("anabaptistperspectives: the media host serves everything, the site's own uploads folder serves nothing", async () => {
    const plan = planMedia(models.ap);
    const io = memoryIo();
    const log: string[] = [];
    const result = await downloadMedia(plan, io, {
      retryDelayMs: 1,
      fetch: through(
        { "media.anabaptistperspectives.org": "ok", "anabaptistperspectives.org": "missing" },
        log,
      ),
      concurrency: 8,
    });
    expect(result).toMatchObject({ ok: 1124, failed: 0 });
    // The one guid on the site's own host 404s there (as it does live), and is found on the media host.
    const onSite = plan.files.filter(
      (f) => new URL(f.sourceUrl).host === "anabaptistperspectives.org",
    );
    expect(onSite.map((f) => f.attachmentIds)).toEqual([[16206]]);
    const outcome = result.outcomes.find((o) => o.file === onSite[0])!;
    expect(outcome).toMatchObject({
      status: "ok",
      attempts: 2,
      url: "https://media.anabaptistperspectives.org/Reed-Merino-profile.png",
    });
    expect(log.filter((h) => h === "media.anabaptistperspectives.org").length).toBe(1124);
    expect(log.filter((h) => h === "anabaptistperspectives.org").length).toBe(1);
  });

  test("a media library with dead files: failures are listed with the attachment and the address, the rest arrive", async () => {
    const plan = planMedia(models.fineline);
    const report = createReport();
    const io = memoryIo();
    const dead = new Set(plan.files.filter((_, i) => i % 100 === 7).map((f) => f.file));
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      const name = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      return fetch(`${fake.origin}/${dead.has(name) ? "missing" : "ok"}/${name}`, init);
    };
    const result = await downloadMedia(plan, io, {
      retryDelayMs: 1,
      fetch: fetcher,
      report,
      concurrency: 8,
    });
    expect(result.failed).toBe(dead.size);
    expect(result.ok).toBe(plan.files.length - dead.size);
    expect(
      report
        .entries()
        .map((e) => (e.data as { file: string }).file)
        .sort(),
    ).toEqual([...dead].sort());
    for (const e of report.entries()) {
      expect(e.where).toMatch(/^post:\d+$/);
      expect(e.url).toMatch(
        /^https:\/\/finelinepainting\.(?:pro|avunu\.io)\/wp-content\/uploads\//,
      );
    }
  });
});

// ── The network, once, if asked ──────────────────────────────────────────────────────────────────

// ── Review findings ──────────────────────────────────────────────────────────────────────────────

/**
 * The model with each attachment's `post_status` stated the way `loadModel` is to state it: as the
 * attachment's own `status`, taken from the committed rows rather than from the planner.
 */
function withStatuses(site: SiteName): WpModel {
  const rows = readFixtureJson<PostRow[]>(site, "rows/posts.json");
  const status = new Map(rows.map((r) => [r.ID, r.post_status]));
  return {
    ...models[site],
    attachments: new Map(
      [...models[site].attachments].map(([id, a]) => [id, { ...a, status: status.get(id) }]),
    ),
  } as WpModel;
}

describe("planMedia: only published attachments are shipped", () => {
  test("anabaptistperspectives: the 670 private social-login avatars are reported, not planned", () => {
    const plan = planMedia(withStatuses("ap"));
    expect(plan.files.length).toBe(1124);
    expect(plan.unplanned.length).toBe(670);
    expect(plan.stats).toMatchObject({ attachments: 1794, unplanned: 670, files: 1124 });
    expect(plan.files.some((f) => f.file.startsWith("nsl_avatars/"))).toBe(false);
    for (const u of plan.unplanned) {
      expect(models.ap.attachments.get(u.attachmentId)!.file).toStartWith("nsl_avatars/");
      expect(u.reason).toContain("private");
      expect(plan.mediaFor(u.attachmentId)).toBeUndefined();
    }
  });

  test("finelinepainting has nothing private, so nothing changes", () => {
    expect(planMedia(withStatuses("fineline")).files).toEqual(plans.fineline.files);
    expect(planMedia(withStatuses("fineline")).unplanned).toEqual([]);
  });

  test("inherit, publish and an unstated status ship; anything else does not", () => {
    const plan = planMedia(
      fakeModel([
        att(1, "a.jpg", { status: "inherit" } as Partial<WpAttachment>),
        att(2, "b.jpg", { status: "publish" } as Partial<WpAttachment>),
        att(3, "c.jpg"),
        att(4, "d.jpg", { status: "private" } as Partial<WpAttachment>),
        att(5, "e.jpg", { status: "draft" } as Partial<WpAttachment>),
      ]),
    );
    expect(plan.files.map((f) => f.file)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(plan.unplanned.map((u) => u.attachmentId)).toEqual([4, 5]);
  });

  test("the status of an attachment that is in model.posts is read from there", () => {
    const model = {
      ...fakeModel([att(1, "a.jpg"), att(2, "b.jpg")]),
      posts: new Map([[1, { id: 1, type: "attachment", status: "private" } as WpPost]]),
    };
    const plan = planMedia(model);
    expect(plan.files.map((f) => f.file)).toEqual(["b.jpg"]);
    expect(plan.unplanned).toEqual([
      { attachmentId: 1, reason: expect.stringContaining("private") },
    ]);
  });
});

describe("planMedia: used() and include", () => {
  test("used() is the files content asked for, in plan order; files stays the whole library", () => {
    const plan = planMedia(
      fakeModel([att(1, "a.jpg"), att(2, "b.jpg"), att(3, "c.csv"), att(4, "d.jpg")]),
      { extraUrls: [`${SITE}/wp-content/uploads/x.png`] },
    );
    expect(plan.files.map((f) => f.file)).toEqual(["a.jpg", "b.jpg", "c.csv", "d.jpg", "x.png"]);
    expect(plan.used().map((f) => f.file)).toEqual(["x.png"]);
    plan.mediaFor(4);
    plan.mediaForUrl(`${SITE}/wp-content/uploads/b-300x200.jpg`);
    plan.mediaFor(99);
    plan.mediaForUrl(`${SITE}/wp-content/uploads/missing.jpg`);
    expect(plan.used().map((f) => f.file)).toEqual(["b.jpg", "d.jpg", "x.png"]);
  });

  test("on ap, asking for a handful of attachments leaves the avatars and the CSV exports out", () => {
    const plan = planMedia(models.ap);
    const csv = [...models.ap.attachments.values()].filter((a) => a.mime === "text/csv");
    expect(csv.length).toBe(8);
    const logo = plan.mediaFor(1309)!;
    expect(logo.src).toContain("Horizontal-White-2.svg");
    expect(plan.used().map((f) => f.file)).toEqual(["2022/07/Horizontal-White-2.svg"]);
  });

  test("include decides which attachments are planned; the rest are reported", () => {
    const plan = planMedia(fakeModel([att(1, "a.jpg"), att(2, "data.csv"), att(3, "b.pdf")]), {
      include: (a) => a.mime !== "text/csv",
    });
    expect(plan.files.map((f) => f.file)).toEqual(["a.jpg", "b.pdf"]);
    expect(plan.unplanned).toEqual([{ attachmentId: 2, reason: expect.stringContaining("exclu") }]);
  });

  test("include never overrides a private status", () => {
    const plan = planMedia(
      fakeModel([att(1, "a.jpg", { status: "private" } as Partial<WpAttachment>)]),
      { include: () => true },
    );
    expect(plan.files).toEqual([]);
    expect(plan.unplanned.length).toBe(1);
  });
});

describe("planMedia: SVG dimensions are not pixels", () => {
  test("ap's logo (100 for width=100%) and patreon icon (3.2679 inches) state none", () => {
    for (const id of [1309, 1435]) {
      const t = truths.ap.find((x) => x.id === id)!;
      expect(models.ap.attachments.get(id)!.mime).toBe("image/svg+xml");
      expect(t.width === undefined || t.file.endsWith(".svg")).toBe(true);
      const ref = plans.ap.mediaFor(id)!;
      expect("width" in ref).toBe(false);
      expect("height" in ref).toBe(false);
      const file = fileOfId(plans.ap, id);
      expect("width" in file).toBe(false);
      expect("height" in file).toBe(false);
    }
  });

  test("no SVG of either fixture carries dimensions; rasters still do", () => {
    for (const site of SITE_NAMES) {
      for (const f of plans[site].files) {
        if (f.mime === "image/svg+xml") expect(f.width).toBeUndefined();
      }
    }
    expect(plans.ap.files.filter((f) => f.width !== undefined).length).toBeGreaterThan(100);
  });

  test("by mime or by extension, with any numbers", () => {
    for (const over of [
      { mime: "image/svg+xml" },
      { mime: "" },
      { mime: "application/octet-stream" },
    ]) {
      const f = planMedia(fakeModel([att(1, "i.svg", { ...over, width: 100, height: 100 })]))
        .files[0]!;
      expect("width" in f).toBe(false);
    }
    const raster = planMedia(fakeModel([att(1, "i.png", { width: 100, height: 100 })])).files[0]!;
    expect(raster).toMatchObject({ width: 100, height: 100 });
  });
});

describe("planMedia: an attachment with no file but an address in its guid", () => {
  test("the guid under the uploads folder gives the file", () => {
    const plan = planMedia(
      fakeModel([att(1, "", { url: "https://example.com/wp-content/uploads/2020/05/a.jpg" })]),
    );
    expect(plan.unplanned).toEqual([]);
    expect(plan.files[0]).toMatchObject({
      file: "2020/05/a.jpg",
      sourceUrl: "https://example.com/wp-content/uploads/2020/05/a.jpg",
      attachmentIds: [1],
    });
    expect(plan.mediaFor(1)?.src).toBe("/media/2020/05/a.jpg");
    expect(
      plan.mediaForUrl("https://example.com/wp-content/uploads/2020/05/a-300x200.jpg")?.src,
    ).toBe("/media/2020/05/a.jpg");
  });

  test("a guid on another host is that host's root", () => {
    const plan = planMedia(
      fakeModel([att(1, "", { url: "https://cdn.example.net/2020/05/a.jpg" })]),
    );
    expect(plan.files[0]).toMatchObject({
      file: "2020/05/a.jpg",
      sourceUrl: "https://cdn.example.net/2020/05/a.jpg",
    });
  });

  test("a guid that is not a file address still leaves the attachment unplanned", () => {
    for (const url of [
      "",
      "https://example.com/?attachment_id=7",
      "https://example.com/a-page/",
      "/wp-content/uploads/a.jpg",
    ]) {
      const plan = planMedia(fakeModel([att(1, "", { url })]));
      expect(plan.files).toEqual([]);
      expect(plan.unplanned).toEqual([
        { attachmentId: 1, reason: expect.stringContaining("no file") },
      ]);
    }
  });
});

describe("downloadMedia: numeric options that are not numbers", () => {
  const plan = (): Pick<MediaPlan, "files"> => ({
    files: planMedia(fakeModel([att(1, "a.jpg"), att(2, "b.jpg")])).files,
  });
  const fetchJpeg = (calls: string[]) => async (url: string) => {
    calls.push(url);
    return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
  };

  test("NaN concurrency falls back to the default and every file downloads", async () => {
    const calls: string[] = [];
    const result = await downloadMedia(plan(), memoryIo(), {
      fetch: fetchJpeg(calls),
      concurrency: Number.NaN,
    });
    expect(result).toMatchObject({ ok: 2, failed: 0 });
    expect(calls.length).toBe(2);
  });

  test("Infinity concurrency is the file count at most", async () => {
    const result = await downloadMedia(plan(), memoryIo(), {
      fetch: fetchJpeg([]),
      concurrency: Number.POSITIVE_INFINITY,
    });
    expect(result.ok).toBe(2);
  });

  test("NaN retries falls back to the default: the request is made, and a failure says why", async () => {
    const calls: string[] = [];
    const ok = await downloadMedia(plan(), memoryIo(), {
      fetch: fetchJpeg(calls),
      retries: Number.NaN,
    });
    expect(ok).toMatchObject({ ok: 2, failed: 0 });
    const down = await downloadMedia(plan(), memoryIo(), {
      fetch: async () => new Response("", { status: 404 }),
      retries: Number.NaN,
      retryDelayMs: 1,
    });
    expect(down.failed).toBe(2);
    expect(down.outcomes[0]!.attempts).toBeGreaterThan(0);
    expect(down.outcomes[0]!.error).toContain("404");
  });

  test("Infinity retries is capped, so a persistent 503 ends", async () => {
    let n = 0;
    const result = await downloadMedia({ files: plan().files.slice(0, 1) }, memoryIo(), {
      fetch: async () => {
        n++;
        return new Response("", { status: 503 });
      },
      retries: Number.POSITIVE_INFINITY,
      retryDelayMs: 0,
    });
    expect(result.failed).toBe(1);
    expect(n).toBeLessThan(50);
  });
});

describe.skipIf(process.env.WP2JX_TEST_LIVE !== "1")(
  "live: two real finelinepainting images",
  () => {
    test("a small image and the one whose guid sits on a dead host download, and are images", async () => {
      // 29 is a 527x252 PNG whose guid names finelinepainting.avunu.io, which no longer resolves, and
      // 123 a 1920x... PNG on the site itself: both small, both real.
      const plan = planMedia(models.fineline);
      const picked = [29, 123].map((id) => fileOfId(plan, id));
      const dir = mkdtempSync(join(tmpdir(), "wp2jx-media-"));
      try {
        const io = memoryIo();
        const report = createReport();
        const result = await downloadMedia({ files: picked }, io, { report, retries: 1 });
        expect(report.entries()).toEqual([]);
        expect(result).toMatchObject({ ok: 2, failed: 0 });
        for (const f of picked) {
          const bytes = io.written.get(f.destPath)!;
          expect(sniffMediaType(bytes)).toBe("image/png");
          expect(bytes.length).toBeGreaterThan(1000);
        }
        // The PNG header states its size: the dimensions the database recorded are the file's.
        const png = io.written.get(picked[0]!.destPath)!;
        const view = new DataView(png.buffer, png.byteOffset);
        expect([view.getUint32(16), view.getUint32(20)]).toEqual([
          picked[0]!.width!,
          picked[0]!.height!,
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
