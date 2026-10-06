import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { serialize, unserialize } from "php-serialize";
import { stringify } from "yaml";
import { createReport } from "../../src/report.ts";
import type { Report, ReportEntry, WpModel, WpPost, WpSite, WpTerm } from "../../src/types.ts";
import {
  ACF_FIELD_TYPES,
  ACF_POST_STATUSES,
  ACF_POST_TYPES,
  type AcfField,
  type AcfModel,
  type AcfRaw,
  type AcfTarget,
  acfSchema,
  acfValues,
  BASE_KEYS,
  BASE_PROPERTIES,
  BASE_REQUIRED,
  type EntryHooks,
  type EntryImage,
  type EntryRef,
  entryKey,
  fieldsFor,
  groupsFor,
  loadAcf,
  postTarget,
  siteClock,
  taxonomiesFor,
  termTarget,
  toEntryData,
  zoneClock,
} from "../../src/wp/acf.ts";
import { openDb } from "../../src/wp/db.ts";
import { loadModel } from "../../src/wp/model.ts";
import { fixtureDb, readFixtureJson } from "../helpers/fixture-db.ts";
import { buildJxProject, cleanupJxProjects } from "../helpers/jx-build.ts";

// ── Real data ────────────────────────────────────────────────────────────────────────────────────

interface Loaded {
  model: WpModel;
  report: Report;
  acf: AcfModel;
}

async function load(
  site: "fineline" | "ap",
  opts: Parameters<typeof loadModel>[1] = {},
): Promise<Loaded> {
  const { url, prefix } = await fixtureDb(site);
  const db = await openDb(url, { prefix });
  try {
    const model = await loadModel(db, opts);
    const report = createReport();
    return { model, report, acf: loadAcf(model, report) };
  } finally {
    await db.close();
  }
}

/** What the media and routes modules will provide, made out of the model: enough to see the shapes. */
function hooksOf(model: WpModel, missing: [string, number, string][] = []): EntryHooks {
  return {
    attachment: (id) => {
      const a = model.attachments.get(id);
      return a
        ? {
            src: `/media/${a.file}`,
            ...(a.width ? { width: a.width } : {}),
            ...(a.height ? { height: a.height } : {}),
            alt: a.alt,
          }
        : undefined;
    },
    post: (id) => {
      const p = model.posts.get(id);
      return p ? { id, slug: p.slug, title: p.title, url: `/${p.slug}/` } : undefined;
    },
    term: (id) => {
      const t = model.terms.get(id);
      return t ? { id, slug: t.slug, title: t.name, url: `/${t.slug}/` } : undefined;
    },
    user: (id) => {
      const u = model.users.get(id);
      return u ? { id, slug: u.slug, title: u.displayName, url: `/author/${u.slug}/` } : undefined;
    },
    missing: (kind, id, field) => missing.push([kind, id, field]),
  };
}

const codes = (report: Report, code: string): ReportEntry[] =>
  report.entries().filter((e) => e.code === code);

let fineline: Loaded;
let ap: Loaded;

beforeAll(async () => {
  [fineline, ap] = await Promise.all([load("fineline"), load("ap")]);
});

// ── Hand-built models ────────────────────────────────────────────────────────────────────────────

let nextId = 1000;

function wpPost(o: Partial<WpPost> & { type: string }): WpPost {
  return {
    id: nextId++,
    status: "publish",
    slug: "",
    title: "",
    content: "",
    excerpt: "",
    date: "2024-01-01T00:00:00.000Z",
    modified: "2024-01-01T00:00:00.000Z",
    parent: 0,
    menuOrder: 0,
    authorId: 0,
    guid: "",
    passwordProtected: false,
    ...o,
  };
}

interface ModelParts {
  meta?: Record<number, Record<string, unknown[]>>;
  options?: Record<string, string>;
  terms?: WpTerm[];
  /** post id → term ids */
  rel?: Record<number, number[]>;
  site?: Partial<WpSite>;
}

function modelOf(posts: WpPost[], parts: ModelParts = {}): WpModel {
  return {
    site: {
      url: "https://x.test",
      home: "https://x.test",
      name: "X",
      description: "",
      permalinkStructure: "/%postname%/",
      showOnFront: "posts",
      pageOnFront: 0,
      pageForPosts: 0,
      activePlugins: [],
      theme: "t",
      language: "en-US",
      ...parts.site,
    },
    options: new Map(Object.entries(parts.options ?? {})),
    posts: new Map(posts.map((p) => [p.id, p])),
    postMeta: new Map(Object.entries(parts.meta ?? {}).map(([k, v]) => [Number(k), v])),
    attachments: new Map(),
    terms: new Map((parts.terms ?? []).map((t) => [t.termId, t])),
    termsByPost: new Map(Object.entries(parts.rel ?? {}).map(([k, v]) => [Number(k), v])),
    users: new Map(),
    menuItems: [],
    redirects: [],
  };
}

type FieldMaker = (parent: number, order: number) => WpPost[];

/** A field group with its fields (a field's children go under it), as the posts ACF keeps them in. */
function group(
  title: string,
  location: unknown,
  fields: FieldMaker[],
  extra: Partial<WpPost> = {},
): WpPost[] {
  const g = wpPost({
    type: "acf-field-group",
    title,
    slug: `group_${title.replace(/\W/g, "")}`,
    content: serialize({ location }),
    ...extra,
  });
  const out = [g];
  fields.forEach((f, i) => out.push(...f(g.id, i)));
  return out;
}

function field(
  type: string,
  name: string,
  settings: Record<string, unknown> = {},
  kids: FieldMaker[] = [],
  extra: Partial<WpPost> = {},
): FieldMaker {
  return (parent, order) => {
    const p = wpPost({
      type: "acf-field",
      title: name,
      excerpt: name,
      slug: `field_${name.replace(/\W/g, "")}`,
      parent,
      menuOrder: order,
      content: serialize({ type, ...settings }),
      ...extra,
    });
    const out = [p];
    kids.forEach((k, i) => out.push(...k(p.id, i)));
    return out;
  };
}

const loc = (param: string, value: string, operator = "=="): unknown => [
  [{ param, operator, value }],
];

const noHooks: EntryHooks = {
  attachment: () => undefined,
  post: () => undefined,
  term: () => undefined,
  user: () => undefined,
};

/** One page, with the given meta and field definitions, and everything read the long way round. */
function readPage(
  fields: FieldMaker[],
  meta: Record<string, unknown[]>,
  opts: { hooks?: EntryHooks; parts?: ModelParts; location?: unknown } = {},
): { entry: Record<string, unknown>; raw: Record<string, AcfRaw>; report: Report; acf: AcfModel } {
  const page = wpPost({ type: "page", slug: "p" });
  const defs = group("G", opts.location ?? loc("post_type", "page"), fields);
  const model = modelOf([...defs, page], { ...opts.parts, meta: { [page.id]: meta } });
  const report = createReport();
  const acf = loadAcf(model, report);
  const raw = acfValues(model, acf, postTarget(model, page));
  return { entry: toEntryData(raw, opts.hooks ?? noHooks), raw, report, acf };
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

// ── The definitions, from the real sites ─────────────────────────────────────────────────────────

describe("loadAcf: fineline", () => {
  test("post types: the registered name, labels, archive and permalink settings", () => {
    const { acf } = fineline;
    expect([...acf.postTypes.keys()]).toEqual(["project", "service"]);
    const project = acf.postTypes.get("project")!;
    expect(project).toMatchObject({
      slug: "project",
      key: "post_type_64fc5e8e5d94d",
      postId: 1077,
      active: true,
      singular: "Project",
      plural: "Projects",
      hierarchical: true,
      // `has_archive` is on and names its own slug, which is what a string answer means.
      hasArchive: "projects",
      rewriteSlug: "project",
      // The rewrite's `with_front` is "0".
      rewriteWithFront: false,
      supports: ["title", "editor", "thumbnail", "custom-fields"],
      taxonomies: ["post_format", "project_tag", "location"],
      public: true,
    });
    // `taxonomies` is the empty string in the settings of `service`: no taxonomies, not [""].
    expect(acf.postTypes.get("service")!.taxonomies).toEqual([]);
    expect(acf.postTypes.get("service")!.hasArchive).toBe("services");
  });

  test("taxonomies, with the custom rewrite slug of `location`", () => {
    const { acf } = fineline;
    expect([...acf.taxonomies.keys()]).toEqual([
      "location",
      "project_tag",
      "project_type",
      "service-type",
    ]);
    expect(acf.taxonomies.get("location")).toMatchObject({
      slug: "location",
      singular: "Location",
      plural: "Project Locations",
      hierarchical: true,
      rewriteSlug: "service_area",
      rewriteWithFront: false,
      objectTypes: ["project"],
    });
    expect(acf.taxonomies.get("project_tag")).toMatchObject({
      hierarchical: false,
      rewriteSlug: "project_tag",
      rewriteWithFront: true,
    });
    // `project_type` claims `project` and `post` from its own side; the post type's list does not name it.
    expect(acf.taxonomies.get("project_type")!.objectTypes).toEqual(["project", "post"]);
  });

  test("taxonomiesFor joins both sides of the relation", () => {
    const { acf } = fineline;
    expect(taxonomiesFor(acf, "project")).toEqual([
      "post_format",
      "project_tag",
      "location",
      "project_type",
    ]);
    expect(taxonomiesFor(acf, "post")).toEqual(["project_type"]);
    expect(taxonomiesFor(acf, "service")).toEqual(["service-type"]);
    expect(taxonomiesFor(acf, "page")).toEqual([]);
  });

  test("groups come in ACF's order with their fields in editor order", () => {
    const { acf } = fineline;
    expect(acf.groups.map((g) => [g.title, g.fields.length, g.active])).toEqual([
      ["Blogs", 6, true],
      ["Project Type", 3, true],
      ["Projects", 35, true],
      ["Service Area", 12, true],
      ["Service Type", 14, true],
    ]);
    const projects = acf.groups.find((g) => g.title === "Projects")!;
    expect(projects.fields.slice(0, 3).map((f) => [f.name, f.type])).toEqual([
      ["about", "textarea"],
      ["gallery", "gallery"],
      // An accordion has no name: it draws a heading and holds no value.
      ["", "accordion"],
    ]);
    expect(projects.location).toEqual([[{ param: "post_type", operator: "==", value: "project" }]]);
    // The Service Area group is on every post type ("all") and on the `location` taxonomy.
    expect(acf.groups.find((g) => g.title === "Service Area")!.location).toEqual([
      [{ param: "taxonomy", operator: "==", value: "location" }],
      [{ param: "post_type", operator: "==", value: "all" }],
    ]);
  });

  test("field settings: choices, requiredness, return formats, defaults", () => {
    const projects = fineline.acf.groups.find((g) => g.title === "Projects")!;
    const byName = (n: string): AcfField => projects.fields.find((f) => f.name === n)!;
    const where = byName("project_location");
    expect(where).toMatchObject({
      type: "select",
      required: true,
      multiple: false,
      returnFormat: "value",
    });
    expect(where.choices).toHaveLength(23);
    expect(where.choices[0]).toEqual({ value: "Adams County, PA", label: "Adams County, PA" });
    expect(where.default).toBe(false);
    expect(byName("project_type_link")).toMatchObject({
      type: "link",
      returnFormat: "array",
      required: false,
    });
    expect(byName("fp_image")).toMatchObject({ type: "image", returnFormat: "array" });
    // A gallery is a list whatever its settings say.
    expect(byName("gallery")).toMatchObject({
      type: "gallery",
      multiple: true,
      returnFormat: "array",
    });
    expect(byName("about").settings).toMatchObject({ rows: 4, new_lines: "" });
  });

  test("a sub-field under a field that holds none (the image left under the gallery) is ignored and reported", () => {
    const { acf, report } = fineline;
    const gallery = acf.groups
      .find((g) => g.title === "Projects")!
      .fields.find((f) => f.name === "gallery")!;
    expect(gallery.subFields).toEqual([]);
    const ignored = codes(report, "acf.subfield-ignored");
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ severity: "info", where: "post:1337" });
    // Nothing else about the definitions needed saying.
    expect(report.entries().filter((e) => e.severity !== "info")).toEqual([]);
  });

  test("every acf-field of the database is a field of some group", () => {
    const rows = readFixtureJson<{ ID: number; post_type: string; post_parent: number }[]>(
      "fineline",
      "rows/posts.json",
    );
    const fieldRows = rows.filter((r) => r.post_type === "acf-field");
    const seen = new Set<number>();
    const visit = (f: AcfField): void => {
      seen.add(f.postId);
      f.subFields.forEach(visit);
    };
    fineline.acf.groups.forEach((g) => g.fields.forEach(visit));
    // 70 fields in groups, and the gallery's image that was ignored.
    expect(fieldRows).toHaveLength(71);
    expect(fieldRows.filter((r) => !seen.has(r.ID)).map((r) => r.ID)).toEqual([1337]);
  });
});

describe("loadAcf: anabaptistperspectives", () => {
  test("a custom permalink slug and a post type with no archive", () => {
    const { acf } = ap;
    const episode = acf.postTypes.get("episode")!;
    expect(episode).toMatchObject({
      hasArchive: false,
      rewriteSlug: "episodes",
      rewriteWithFront: false,
      hierarchical: false,
    });
    expect(episode.taxonomies).toEqual(["category", "post_tag", "scripture", "season", "series"]);
    expect(acf.postTypes.get("supporters_update")).toMatchObject({
      rewriteSlug: "supporters_update",
      hasArchive: false,
    });
    expect(taxonomiesFor(acf, "post")).toEqual(["scripture", "series"]);
  });

  test("an inactive field group stays in the model, flagged, and is reported once", () => {
    const { acf, report } = ap;
    const deprecated = acf.groups.find((g) => g.title === "Deprecated Episode Fields")!;
    expect(deprecated).toMatchObject({ active: false, status: "acf-disabled" });
    expect(deprecated.fields.map((f) => f.name)).toEqual([
      "video",
      "narrator",
      "collection-resource",
    ]);
    // Its repeater keeps its sub-field.
    expect(deprecated.fields[2]!.subFields.map((f) => [f.name, f.type])).toEqual([
      ["resource", "post_object"],
    ]);
    const inactive = codes(report, "acf.group-inactive");
    expect(inactive).toHaveLength(1);
    expect(inactive[0]!.data).toMatchObject({
      status: "acf-disabled",
      fields: ["video", "narrator", "collection-resource"],
    });
  });

  test("a group attached to users applies to no post, and says so", () => {
    const { acf, report } = ap;
    const users = acf.groups.find((g) => g.title === "Users")!;
    expect(users.location).toEqual([[{ param: "user_form", operator: "==", value: "edit" }]]);
    expect(codes(report, "acf.location-other-object")).toHaveLength(1);
    expect(codes(report, "acf.location-other-object")[0]!.data).toEqual({ objects: "users" });
    expect(codes(report, "acf.location-unsupported")).toEqual([]);
  });

  test("a field named like a key of the entry data contract is reported and renamed", () => {
    const collision = codes(ap.report, "acf.field-name-collision");
    expect(collision).toHaveLength(1);
    expect(collision[0]!.data).toMatchObject({ name: "author", key: "acf_author", group: "Posts" });
    expect(entryKey("author")).toBe("acf_author");
    expect(entryKey("narrator")).toBe("narrator");
    for (const key of BASE_KEYS) expect(entryKey(key)).toBe(`acf_${key}`);
  });

  test("a repeater, its sub-field and a user field", () => {
    const posts = ap.acf.groups.find((g) => g.title === "Posts")!;
    expect(posts.fields.map((f) => [f.name, f.type, f.multiple])).toEqual([
      ["audio", "link", false],
      ["narrator", "user", true],
      ["author", "user", false],
      ["collection-resource", "repeater", false],
    ]);
    expect(posts.fields[3]!.subFields[0]).toMatchObject({
      name: "resource",
      type: "post_object",
      multiple: false,
    });
    expect(posts.fields[3]!.subFields[0]!.settings.post_type).toEqual(["resource"]);
  });
});

describe("loadAcf: a model that was loaded without the definitions", () => {
  test("a site that runs ACF but whose model has none of its posts is told so", async () => {
    // `postTypes` left the acf-* types out, as a CLI that listed only the content types would.
    const { report, acf } = await load("fineline", {
      postTypes: ["project", "page", "post", "service"],
    });
    expect(acf.groups).toEqual([]);
    expect(acf.postTypes.size).toBe(0);
    const entries = codes(report, "acf.not-loaded");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ severity: "warn", where: "option:acf_version" });
    expect(entries[0]!.message).toContain("ACF_POST_TYPES");
  });

  test("a status list without acf-disabled loses the inactive group (and the list names what to include)", async () => {
    const { acf } = await load("ap", { statuses: ["publish", "draft", "private"] });
    expect(acf.groups.map((g) => g.title)).not.toContain("Deprecated Episode Fields");
    expect(ACF_POST_STATUSES).toContain("acf-disabled");
    expect(ACF_POST_TYPES).toEqual([
      "acf-post-type",
      "acf-taxonomy",
      "acf-field-group",
      "acf-field",
      "acf-ui-options-page",
    ]);
  });

  test("a site with no ACF at all has nothing to read and nothing to say", () => {
    const model = modelOf([
      wpPost({ type: "page", slug: "a" }),
      wpPost({ type: "post", slug: "b" }),
    ]);
    const report = createReport();
    const acf = loadAcf(model, report);
    expect(acf).toEqual({
      postTypes: new Map(),
      taxonomies: new Map(),
      groups: [],
      optionsPages: [],
    });
    expect(report.entries()).toEqual([]);
    for (const post of model.posts.values()) {
      expect(groupsFor(acf, postTarget(model, post))).toEqual([]);
      expect(acfValues(model, acf, postTarget(model, post))).toEqual({});
    }
    expect(toEntryData({}, noHooks)).toEqual({});
    expect(acfSchema([])).toEqual({ type: "object", properties: {} });
  });
});

// ── Which groups apply ───────────────────────────────────────────────────────────────────────────

describe("groupsFor: real sites", () => {
  const titles = (acf: AcfModel, target: AcfTarget): string[] =>
    groupsFor(acf, target).map((g) => g.title);

  test("fineline: post types, and the group that is on all of them", () => {
    const { acf, model } = fineline;
    const of = (id: number): string[] => titles(acf, postTarget(model, model.posts.get(id)!));
    expect(of(5335)).toEqual(["Projects", "Service Area"]); // a project
    expect(of(5278)).toEqual(["Service Area", "Service Type"]); // a service
    expect(of(2602)).toEqual(["Blogs", "Service Area"]); // a post
    expect(of(1716)).toEqual(["Service Area"]); // a page (about-us)
  });

  test("fineline: terms", () => {
    const { acf, model } = fineline;
    const term = (taxonomy: string): WpTerm =>
      [...model.terms.values()].find((t) => t.taxonomy === taxonomy)!;
    expect(titles(acf, termTarget(model, term("location")))).toEqual(["Service Area"]);
    expect(titles(acf, termTarget(model, term("project_type")))).toEqual(["Project Type"]);
    // `post_type == all` is a screen of posts: it never matches a term.
    expect(titles(acf, termTarget(model, term("project_tag")))).toEqual([]);
    expect(titles(acf, termTarget(model, term("category")))).toEqual([]);
  });

  test("ap: the inactive group applies to nothing, the user group to no post", () => {
    const { acf, model } = ap;
    const episode = [...model.posts.values()].find((p) => p.type === "episode")!;
    expect(titles(acf, postTarget(model, episode))).toEqual(["Captivate Episode", "Episode"]);
    const post = [...model.posts.values()].find((p) => p.type === "post")!;
    expect(titles(acf, postTarget(model, post))).toEqual(["Captivate Episode", "Posts"]);
    const page = [...model.posts.values()].find((p) => p.type === "page")!;
    expect(titles(acf, postTarget(model, page))).toEqual([]);
  });

  test("a target built by hand with no more than a post type matches the post type rules", () => {
    const { acf } = fineline;
    expect(titles(acf, { kind: "post", postType: "project" })).toEqual([
      "Projects",
      "Service Area",
    ]);
    expect(titles(acf, { kind: "term", taxonomy: "location" })).toEqual(["Service Area"]);
    expect(titles(acf, { kind: "options", page: "anything" })).toEqual([]);
  });
});

describe("groupsFor: the rules of ACF's location types", () => {
  /** A model with one active group (rule groups given), and the answer for a target. */
  function applies(rules: unknown, target: AcfTarget, status = "publish"): boolean {
    const defs = group("Only", rules, [field("text", "x")], { status });
    const model = modelOf(defs);
    return groupsFor(loadAcf(model), target).length === 1;
  }
  const post = (extra: Partial<Extract<AcfTarget, { kind: "post" }>> = {}): AcfTarget => ({
    kind: "post",
    postType: "page",
    postId: 7,
    template: "default",
    status: "publish",
    format: "",
    parent: 0,
    terms: [],
    frontPage: false,
    postsPage: false,
    hasChildren: false,
    ...extra,
  });

  test("rule groups OR together and the rules inside one group AND", () => {
    const rules = [
      [
        { param: "post_type", operator: "==", value: "page" },
        { param: "post_status", operator: "==", value: "draft" },
      ],
      [{ param: "post_type", operator: "==", value: "post" }],
    ];
    expect(applies(rules, post({ status: "draft" }))).toBe(true); // both rules of the first group
    expect(applies(rules, post({ status: "publish" }))).toBe(false); // only one of them
    expect(applies(rules, post({ postType: "post" }))).toBe(true); // the second group
    expect(applies(rules, post({ postType: "project" }))).toBe(false);
    // No rules at all (or an empty group) means the group is shown nowhere.
    expect(applies([], post())).toBe(false);
    expect(applies([[]], post())).toBe(false);
  });

  test("post_type, with `all` and `!=`", () => {
    expect(applies(loc("post_type", "page"), post())).toBe(true);
    expect(applies(loc("post_type", "post"), post())).toBe(false);
    expect(applies(loc("post_type", "post", "!="), post())).toBe(true);
    expect(applies(loc("post_type", "page", "!="), post())).toBe(false);
    expect(applies(loc("post_type", "all"), post({ postType: "anything" }))).toBe(true);
    // `all` negated matches nothing.
    expect(applies(loc("post_type", "all", "!="), post())).toBe(false);
    // A term screen has no post type; `!=` does not make it match (ACF returns false before comparing).
    expect(applies(loc("post_type", "post", "!="), { kind: "term", taxonomy: "category" })).toBe(
      false,
    );
  });

  test("post and page: a specific post, which needs the target to name one", () => {
    expect(applies(loc("post", "7"), post({ postId: 7 }))).toBe(true);
    expect(applies(loc("post", "8"), post({ postId: 7 }))).toBe(false);
    expect(applies(loc("page", "7"), post({ postId: 7 }))).toBe(true);
    expect(applies(loc("post", "8", "!="), post({ postId: 7 }))).toBe(true);
    // No post id: false whatever the operator.
    expect(applies(loc("post", "7"), { kind: "post", postType: "page" })).toBe(false);
    expect(applies(loc("post", "7", "!="), { kind: "post", postType: "page" })).toBe(false);
  });

  test("page_template and post_template: pages always have templates, other types when they carry one", () => {
    expect(applies(loc("page_template", "default"), post({ template: "default" }))).toBe(true);
    expect(applies(loc("page_template", "default"), post({ template: "" }))).toBe(true);
    expect(applies(loc("page_template", "tpl.php"), post({ template: "tpl.php" }))).toBe(true);
    expect(applies(loc("page_template", "tpl.php", "!="), post({ template: "tpl.php" }))).toBe(
      false,
    );
    expect(applies(loc("page_template", "default", "!="), post({ template: "tpl.php" }))).toBe(
      true,
    );
    // The default template is a page's: a post type without templates never matches it.
    expect(
      applies(loc("page_template", "default"), post({ postType: "project", template: "default" })),
    ).toBe(false);
    expect(
      applies(
        loc("page_template", "default", "!="),
        post({ postType: "project", template: "default" }),
      ),
    ).toBe(false);
    // A project that carries a template shows the type has some.
    expect(
      applies(loc("post_template", "tpl.php"), post({ postType: "project", template: "tpl.php" })),
    ).toBe(true);
    expect(
      applies(
        loc("post_template", "default"),
        post({ postType: "page", template: undefined as never, postId: undefined as never }),
      ),
    ).toBe(true);
  });

  test("post_status treats auto-draft as draft", () => {
    expect(applies(loc("post_status", "draft"), post({ status: "auto-draft" }))).toBe(true);
    expect(applies(loc("post_status", "publish"), post({ status: "draft" }))).toBe(false);
    expect(applies(loc("post_status", "publish", "!="), post({ status: "draft" }))).toBe(true);
  });

  test("post_format", () => {
    expect(applies(loc("post_format", "aside"), post({ format: "aside" }))).toBe(true);
    expect(
      applies(loc("post_format", "standard"), post({ postType: "post", format: "standard" })),
    ).toBe(true);
    expect(applies(loc("post_format", "standard"), post({ format: "aside" }))).toBe(false);
  });

  test("post_category and post_taxonomy: a term by `taxonomy:slug` or id, uncategorised by default", () => {
    const filed = post({
      postType: "post",
      terms: [
        { termId: 5, taxonomy: "category", slug: "news" },
        { termId: 9, taxonomy: "post_tag", slug: "news" },
      ],
    });
    expect(applies(loc("post_category", "category:news"), filed)).toBe(true);
    expect(applies(loc("post_category", "category:other"), filed)).toBe(false);
    expect(applies(loc("post_category", "category:other", "!="), filed)).toBe(true);
    expect(applies(loc("post_taxonomy", "post_tag:news"), filed)).toBe(true);
    // The same slug in another taxonomy is not the term.
    expect(applies(loc("post_taxonomy", "project_tag:news"), filed)).toBe(false);
    expect(applies(loc("post_taxonomy", "5"), filed)).toBe(true);
    expect(applies(loc("post_taxonomy", "6"), filed)).toBe(false);
    // A post with no category is in the default one.
    expect(
      applies(
        loc("post_category", "category:uncategorized"),
        post({ postType: "post", terms: [] }),
      ),
    ).toBe(true);
    // Without a post there is nothing to look at.
    expect(applies(loc("post_category", "category:news"), { kind: "post", postType: "post" })).toBe(
      false,
    );
  });

  test("page_type: front page, posts page, top level, parent, child", () => {
    expect(applies(loc("page_type", "front_page"), post({ frontPage: true }))).toBe(true);
    expect(applies(loc("page_type", "front_page"), post())).toBe(false);
    expect(applies(loc("page_type", "front_page", "!="), post())).toBe(true);
    expect(applies(loc("page_type", "posts_page"), post({ postsPage: true }))).toBe(true);
    expect(applies(loc("page_type", "top_level"), post({ parent: 0 }))).toBe(true);
    expect(applies(loc("page_type", "top_level"), post({ parent: 3 }))).toBe(false);
    expect(applies(loc("page_type", "child"), post({ parent: 3 }))).toBe(true);
    expect(applies(loc("page_type", "parent"), post({ hasChildren: true }))).toBe(true);
    expect(applies(loc("page_type", "parent"), post({ hasChildren: false }))).toBe(false);
    // A value ACF does not have matches nothing.
    expect(applies(loc("page_type", "nonsense"), post())).toBe(false);
  });

  test("page_parent", () => {
    expect(applies(loc("page_parent", "3"), post({ parent: 3 }))).toBe(true);
    expect(applies(loc("page_parent", "3"), post({ parent: 4 }))).toBe(false);
    expect(applies(loc("page_parent", "3", "!="), post({ parent: 4 }))).toBe(true);
  });

  test("attachment: a mime type, or its kind", () => {
    const media = (mime: string): AcfTarget => post({ postType: "attachment", mime });
    expect(applies(loc("attachment", "image"), media("image/png"))).toBe(true);
    expect(applies(loc("attachment", "image/png"), media("image/png"))).toBe(true);
    expect(applies(loc("attachment", "image/jpeg"), media("image/png"))).toBe(false);
    expect(applies(loc("attachment", "video"), media("image/png"))).toBe(false);
    expect(applies(loc("attachment", "image"), post())).toBe(false);
  });

  test("taxonomy, term and options_page", () => {
    expect(applies(loc("taxonomy", "category"), { kind: "term", taxonomy: "category" })).toBe(true);
    expect(applies(loc("taxonomy", "all"), { kind: "term", taxonomy: "anything" })).toBe(true);
    expect(applies(loc("taxonomy", "category"), { kind: "term", taxonomy: "post_tag" })).toBe(
      false,
    );
    expect(applies(loc("taxonomy", "category", "!="), { kind: "term", taxonomy: "post_tag" })).toBe(
      true,
    );
    expect(applies(loc("taxonomy", "category"), post())).toBe(false);
    expect(applies(loc("term", "12"), { kind: "term", taxonomy: "category", termId: 12 })).toBe(
      true,
    );
    expect(
      applies(loc("term", "category:news"), { kind: "term", taxonomy: "category", slug: "news" }),
    ).toBe(true);
    expect(
      applies(loc("term", "category:news"), { kind: "term", taxonomy: "post_tag", slug: "news" }),
    ).toBe(false);
    expect(
      applies(loc("term", "12", "!="), { kind: "term", taxonomy: "category", termId: 13 }),
    ).toBe(true);
    expect(
      applies(loc("options_page", "site-settings"), { kind: "options", page: "site-settings" }),
    ).toBe(true);
    expect(applies(loc("options_page", "site-settings"), { kind: "options", page: "other" })).toBe(
      false,
    );
    expect(applies(loc("options_page", "site-settings"), post())).toBe(false);
    // "all" is every options page, and only those.
    expect(applies(loc("options_page", "all"), { kind: "options", page: "whatever" })).toBe(true);
    expect(applies(loc("options_page", "all"), post())).toBe(false);
  });

  test("a group that is not active applies to nothing", () => {
    expect(applies(loc("post_type", "page"), post(), "acf-disabled")).toBe(false);
    expect(applies(loc("post_type", "page"), post(), "draft")).toBe(false);
    expect(applies(loc("post_type", "page"), post(), "auto-draft")).toBe(true);
  });

  test("a rule on a parameter or with an operator that cannot be evaluated never matches, and is reported when read", () => {
    const defs = group(
      "Odd",
      [
        [{ param: "acfe_custom", operator: "==", value: "x" }],
        [{ param: "current_user_role", operator: "==", value: "administrator" }],
        [{ param: "post_type", operator: "contains", value: "page" }],
      ],
      [field("text", "x")],
    );
    const model = modelOf([...defs, wpPost({ type: "page" })]);
    const report = createReport();
    const acf = loadAcf(model, report);
    const unsupported = codes(report, "acf.location-unsupported");
    expect(unsupported).toHaveLength(3);
    expect(unsupported.map((e) => e.data)).toEqual(
      expect.arrayContaining([
        { param: "acfe_custom" },
        { param: "current_user_role" },
        { rule: "post_type contains page" },
      ]),
    );
    expect(
      unsupported.find((e) => (e.data as { param?: string }).param === "current_user_role")!
        .message,
    ).toContain("who is looking at the screen");
    // None of them ever applies the group, and evaluating again says nothing more.
    for (let i = 0; i < 3; i++)
      expect(groupsFor(acf, { kind: "post", postType: "page" })).toEqual([]);
    expect(codes(report, "acf.location-unsupported")).toHaveLength(3);
  });

  test("a rule whose answer is not in the target is reported once and does not match", () => {
    const defs = group("Tpl", loc("page_template", "tpl.php"), [field("text", "x")]);
    const model = modelOf([...defs, wpPost({ type: "page" })]);
    const report = createReport();
    const acf = loadAcf(model, report);
    // A post id, but no template: ACF would read the meta; a hand-built target cannot say.
    const target: AcfTarget = { kind: "post", postType: "page", postId: 5 };
    expect(groupsFor(acf, target)).toEqual([]);
    expect(groupsFor(acf, target)).toEqual([]);
    const entries = codes(report, "acf.location-unevaluable");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toContain("postTarget()");
    // postTarget() fills the template in from the post's meta.
    const page = [...model.posts.values()].find((p) => p.type === "page")!;
    const withMeta = modelOf([...defs, page], {
      meta: { [page.id]: { _wp_page_template: ["tpl.php"] } },
    });
    expect(groupsFor(loadAcf(withMeta), postTarget(withMeta, page))).toHaveLength(1);
  });

  test("postTarget reads the template, format, terms, parent and page roles from the model", () => {
    const parent = wpPost({ type: "page", slug: "parent" });
    const child = wpPost({ type: "page", slug: "child", parent: parent.id });
    const news = wpPost({ type: "post", slug: "news" });
    const terms: WpTerm[] = [
      {
        termId: 5,
        taxonomyId: 5,
        taxonomy: "category",
        slug: "cat",
        name: "Cat",
        description: "",
        parent: 0,
        count: 1,
        meta: {},
      },
      {
        termId: 6,
        taxonomyId: 6,
        taxonomy: "post_format",
        slug: "post-format-aside",
        name: "Aside",
        description: "",
        parent: 0,
        count: 1,
        meta: {},
      },
    ];
    const model = modelOf([parent, child, news], {
      meta: { [child.id]: { _wp_page_template: ["wide.php"] } },
      rel: { [news.id]: [5, 6] },
      terms,
      site: { showOnFront: "page", pageOnFront: parent.id, pageForPosts: child.id },
    });
    expect(postTarget(model, parent)).toMatchObject({
      kind: "post",
      postType: "page",
      postId: parent.id,
      template: "default",
      status: "publish",
      parent: 0,
      hasChildren: true,
      frontPage: true,
      postsPage: false,
    });
    expect(postTarget(model, child)).toMatchObject({
      template: "wide.php",
      parent: parent.id,
      hasChildren: false,
      frontPage: false,
      postsPage: true,
    });
    expect(postTarget(model, news)).toMatchObject({
      format: "aside",
      terms: [
        { termId: 5, taxonomy: "category", slug: "cat" },
        { termId: 6, taxonomy: "post_format", slug: "post-format-aside" },
      ],
    });
    expect(postTarget(model, parent).format).toBe("");
    expect(termTarget(model, terms[0]!)).toEqual({
      kind: "term",
      taxonomy: "category",
      termId: 5,
      slug: "cat",
    });
  });

  test("fieldsFor: the fields of every group that applies to some target, once each, in group order", () => {
    const defs = [
      ...group("B group", loc("post_type", "page"), [field("text", "b1")], { menuOrder: 2 }),
      ...group(
        "A group",
        [
          [{ param: "post_type", operator: "==", value: "page" }],
          [{ param: "post_type", operator: "==", value: "post" }],
        ],
        [field("text", "a1"), field("text", "a2")],
        { menuOrder: 1 },
      ),
      ...group("Z group", loc("post_type", "project"), [field("text", "z1")]),
    ];
    const acf = loadAcf(modelOf(defs));
    const names = (targets: AcfTarget[]): string[] => fieldsFor(acf, targets).map((f) => f.name);
    expect(
      names([
        { kind: "post", postType: "page" },
        { kind: "post", postType: "page" },
      ]),
    ).toEqual(["a1", "a2", "b1"]);
    expect(
      names([
        { kind: "post", postType: "post" },
        { kind: "post", postType: "page" },
      ]),
    ).toEqual(["a1", "a2", "b1"]);
    expect(names([{ kind: "post", postType: "project" }])).toEqual(["z1"]);
    expect(names([{ kind: "post", postType: "nothing" }])).toEqual([]);
  });
});

// ── The schema ───────────────────────────────────────────────────────────────────────────────────

function fieldOf(type: string, name: string, settings: Record<string, unknown> = {}): AcfField {
  const page = wpPost({ type: "page" });
  const defs = group("G", loc("post_type", "page"), [field(type, name, settings)]);
  const acf = loadAcf(modelOf([...defs, page]));
  return acf.groups[0]!.fields[0]!;
}

const propertyOf = (
  type: string,
  settings: Record<string, unknown> = {},
): Record<string, unknown> =>
  (
    acfSchema([fieldOf(type, "f", { ...settings })]).properties as Record<
      string,
      Record<string, unknown>
    >
  ).f!;

describe("acfSchema: one field type at a time", () => {
  const image = {
    type: "object",
    properties: {
      src: { type: "string" },
      width: { type: "number" },
      height: { type: "number" },
      alt: { type: "string" },
    },
    required: ["src"],
  };
  const ref = {
    type: "object",
    properties: {
      id: { type: "number" },
      slug: { type: "string" },
      title: { type: "string" },
      url: { type: "string" },
    },
    required: ["id"],
  };

  test("text-like types are strings; wysiwyg stays HTML (a string)", () => {
    for (const type of [
      "text",
      "textarea",
      "wysiwyg",
      "password",
      "oembed",
      "color_picker",
      "time_picker",
    ]) {
      expect(propertyOf(type)).toEqual({ type: "string", title: "f" });
    }
    expect(propertyOf("url")).toEqual({ type: "string", format: "uri", title: "f" });
    expect(propertyOf("email")).toEqual({ type: "string", format: "email", title: "f" });
    expect(propertyOf("text", { instructions: "Say it" })).toEqual({
      type: "string",
      title: "f",
      description: "Say it",
    });
  });

  test("number and range carry their bounds; true_false is a boolean", () => {
    expect(propertyOf("number", { min: 1, max: "10" })).toEqual({
      type: "number",
      minimum: 1,
      maximum: 10,
      title: "f",
    });
    expect(propertyOf("range", { min: "", max: "" })).toEqual({ type: "number", title: "f" });
    expect(propertyOf("true_false")).toEqual({ type: "boolean", title: "f" });
  });

  test("choices become an enum, a list for a checkbox or a multi select, none when anything may be typed", () => {
    const choices = { red: "Red", green: "Green" };
    expect(propertyOf("select", { choices })).toEqual({
      type: "string",
      enum: ["red", "green"],
      title: "f",
    });
    expect(propertyOf("radio", { choices })).toEqual({
      type: "string",
      enum: ["red", "green"],
      title: "f",
    });
    expect(propertyOf("button_group", { choices })).toEqual({
      type: "string",
      enum: ["red", "green"],
      title: "f",
    });
    expect(propertyOf("select", { choices, multiple: 1 })).toEqual({
      type: "array",
      title: "f",
      items: { type: "string", enum: ["red", "green"] },
    });
    expect(propertyOf("checkbox", { choices })).toEqual({
      type: "array",
      title: "f",
      items: { type: "string", enum: ["red", "green"] },
    });
    expect(propertyOf("select", { choices, allow_custom: 1 })).toEqual({
      type: "string",
      title: "f",
    });
    expect(propertyOf("radio", { choices, other_choice: 1 })).toEqual({
      type: "string",
      title: "f",
    });
    expect(propertyOf("select", {})).toEqual({ type: "string", title: "f" });
  });

  test("choices stored as a list, a map or the text a person typed", () => {
    expect(fieldOf("select", "f", { choices: ["Zero", "One"] }).choices).toEqual([
      { value: "0", label: "Zero" },
      { value: "1", label: "One" },
    ]);
    expect(fieldOf("select", "f", { choices: { a: "A" } }).choices).toEqual([
      { value: "a", label: "A" },
    ]);
    expect(
      fieldOf("select", "f", { choices: "red : Red\n\n green : Green \nblue" }).choices,
    ).toEqual([
      { value: "red", label: "Red" },
      { value: "green", label: "Green" },
      { value: "blue", label: "blue" },
    ]);
    expect(fieldOf("select", "f", { choices: 5 }).choices).toEqual([]);
  });

  test("dates: format date and date-time, which is what makes Jx normalise them", () => {
    expect(propertyOf("date_picker")).toEqual({ type: "string", format: "date", title: "f" });
    expect(propertyOf("date_time_picker")).toEqual({
      type: "string",
      format: "date-time",
      title: "f",
    });
  });

  test("image and file are {src, width, height, alt}; a gallery a list of those", () => {
    expect(propertyOf("image")).toEqual({ ...image, title: "f" });
    expect(propertyOf("file")).toEqual({ ...image, title: "f" });
    expect(propertyOf("gallery")).toEqual({ type: "array", title: "f", items: image });
  });

  test("link is {url, title, target}", () => {
    expect(propertyOf("link")).toEqual({
      type: "object",
      properties: {
        url: { type: "string" },
        title: { type: "string" },
        target: { type: "string" },
      },
      required: ["url"],
      title: "f",
    });
  });

  test("relationship, post, page link, taxonomy and user are {id, slug, title, url}: a list only when the field holds several", () => {
    expect(propertyOf("relationship")).toEqual({ type: "array", title: "f", items: ref });
    expect(propertyOf("post_object")).toEqual({ ...ref, title: "f" });
    expect(propertyOf("post_object", { multiple: 1 })).toEqual({
      type: "array",
      title: "f",
      items: ref,
    });
    expect(propertyOf("page_link")).toEqual({ ...ref, title: "f" });
    expect(propertyOf("user")).toEqual({ ...ref, title: "f" });
    expect(propertyOf("user", { multiple: "1" })).toEqual({
      type: "array",
      title: "f",
      items: ref,
    });
    expect(propertyOf("taxonomy", { field_type: "checkbox" })).toEqual({
      type: "array",
      title: "f",
      items: ref,
    });
    expect(propertyOf("taxonomy", { field_type: "multi_select" })).toEqual({
      type: "array",
      title: "f",
      items: ref,
    });
    expect(propertyOf("taxonomy", { field_type: "radio" })).toEqual({ ...ref, title: "f" });
    expect(propertyOf("taxonomy", { field_type: "select" })).toEqual({ ...ref, title: "f" });
    // A menu (SCF 6.5's nav_menu field) is one term of the nav_menu taxonomy.
    expect(propertyOf("nav_menu")).toEqual({ ...ref, title: "f" });
  });

  test("map and icon picker are objects", () => {
    expect(propertyOf("google_map")).toMatchObject({
      type: "object",
      properties: { address: { type: "string" }, lat: { type: "number" } },
    });
    expect(propertyOf("icon_picker")).toMatchObject({
      type: "object",
      properties: { type: { type: "string" }, value: { type: "string" } },
    });
  });

  test("tabs, messages, accordions and separators hold no value and are left out", () => {
    const defs = group("G", loc("post_type", "page"), [
      field("tab", ""),
      field("message", ""),
      field("accordion", ""),
      field("separator", ""),
      field("text", "kept"),
    ]);
    const acf = loadAcf(modelOf([...defs, wpPost({ type: "page" })]));
    expect(Object.keys(acfSchema(acf.groups[0]!.fields).properties as object)).toEqual(["kept"]);
  });

  test("a type this module does not know promises nothing about its value", () => {
    expect(propertyOf("acfe_code_editor")).toEqual({ title: "f" });
  });

  test("repeater: a list of rows, with its row limits; group: an object", () => {
    const defs = group("G", loc("post_type", "page"), [
      field("repeater", "rows", { min: 1, max: 4 }, [
        field("text", "a", { required: 1 }),
        field("number", "b"),
      ]),
      field("group", "box", {}, [field("true_false", "on")]),
    ]);
    const acf = loadAcf(modelOf([...defs, wpPost({ type: "page" })]));
    expect(acfSchema(acf.groups[0]!.fields)).toEqual({
      type: "object",
      properties: {
        rows: {
          type: "array",
          title: "rows",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: { a: { type: "string", title: "a" }, b: { type: "number", title: "b" } },
            required: ["a"],
          },
        },
        box: { type: "object", title: "box", properties: { on: { type: "boolean", title: "on" } } },
      },
    });
  });

  test("flexible content: a list of rows, each with the layout it is and that layout's fields", () => {
    const defs = group("G", loc("post_type", "page"), [
      field(
        "flexible_content",
        "blocks",
        {
          layouts: {
            layout_a: { key: "layout_a", name: "hero", label: "Hero" },
            layout_b: { key: "layout_b", name: "quote", label: "Quote" },
          },
        },
        [
          field("text", "heading", { parent_layout: "layout_a", required: 1 }),
          field("textarea", "words", { parent_layout: "layout_b" }),
        ],
      ),
    ]);
    const acf = loadAcf(modelOf([...defs, wpPost({ type: "page" })]));
    const schema = acfSchema(acf.groups[0]!.fields).properties as Record<
      string,
      { items: { oneOf: Record<string, unknown>[] } }
    >;
    expect(schema.blocks!.items.oneOf).toEqual([
      {
        type: "object",
        title: "Hero",
        properties: {
          acf_fc_layout: { const: "hero" },
          heading: { type: "string", title: "heading" },
        },
        required: ["acf_fc_layout", "heading"],
      },
      {
        type: "object",
        title: "Quote",
        properties: {
          acf_fc_layout: { const: "quote" },
          words: { type: "string", title: "words" },
        },
        required: ["acf_fc_layout"],
      },
    ]);
  });

  test("required: only a required field that no condition can hide", () => {
    const defs = group("G", loc("post_type", "page"), [
      field("text", "always", { required: 1 }),
      field("text", "optional"),
      field("text", "sometimes", {
        required: 1,
        conditional_logic: [[{ field: "field_always", operator: "==", value: "x" }]],
      }),
    ]);
    const acf = loadAcf(modelOf([...defs, wpPost({ type: "page" })]));
    expect(acf.groups[0]!.fields[2]!.conditionalLogic).toEqual([
      [{ field: "field_always", operator: "==", value: "x" }],
    ]);
    expect(acfSchema(acf.groups[0]!.fields).required).toEqual(["always"]);
  });

  test("a field named like a contract key gets the contract-safe key, and two fields of one name keep the first", () => {
    const defs = [
      ...group("A", loc("post_type", "page"), [field("user", "author"), field("text", "same")]),
      ...group("B", loc("post_type", "page"), [field("number", "same"), field("text", "same")]),
    ];
    const acf = loadAcf(modelOf([...defs, wpPost({ type: "page" })]));
    const report = createReport();
    const schema = acfSchema(fieldsFor(acf, [{ kind: "post", postType: "page" }]), {
      report,
      where: "collection:pages",
    });
    expect(Object.keys(schema.properties as object)).toEqual(["acf_author", "same"]);
    expect((schema.properties as Record<string, { type: string }>).same!.type).toBe("string");
    const conflicts = codes(report, "acf.field-conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      severity: "warn",
      where: "collection:pages",
      data: { name: "same" },
    });
  });
});

describe("BASE_PROPERTIES", () => {
  test("is the contract's frontmatter keys, and is valid JSON Schema for an entry of them", () => {
    expect(Object.keys(BASE_PROPERTIES)).toEqual([...BASE_KEYS]);
    expect(BASE_REQUIRED).toEqual(["title", "slug"]);
    const validate = ajv.compile({
      type: "object",
      properties: BASE_PROPERTIES,
      required: [...BASE_REQUIRED],
    });
    const entry = {
      title: "T",
      slug: "t",
      date: "2025-01-02T15:49:34Z",
      modified: "2025-08-05T19:12:20Z",
      excerpt: "e",
      author: "Kris Bucher",
      url: "/t/",
      featuredImage: { src: "/media/a.png", width: 10, height: 10, alt: "" },
      terms: { category: [{ slug: "blog", name: "Blog", url: "/category/blog/" }] },
      seo: {
        title: "T",
        description: "d",
        image: { src: "/media/a.png", alt: "" },
        robots: "index, follow",
      },
    };
    expect(validate(entry)).toBe(true);
    expect(validate({ ...entry, date: "yesterday" })).toBe(false);
    expect(validate({ ...entry, featuredImage: { width: 1 } })).toBe(false);
    expect(validate({ ...entry, terms: { category: [{ slug: "blog" }] } })).toBe(false);
    expect(validate({ slug: "t" })).toBe(false);
    // A schema built from ACF fields and the base keys together is one valid schema.
    const merged = {
      type: "object",
      properties: {
        ...BASE_PROPERTIES,
        ...(acfSchema([fieldOf("text", "extra")]).properties as object),
      },
    };
    expect(ajv.validateSchema(merged)).toBe(true);
    // Each use of a fragment is its own object: editing one schema cannot change another.
    const a = acfSchema([fieldOf("image", "p")]).properties as Record<
      string,
      { properties: Record<string, unknown> }
    >;
    const b = acfSchema([fieldOf("image", "p")]).properties as Record<
      string,
      { properties: Record<string, unknown> }
    >;
    expect(a.p).not.toBe(b.p);
  });
});

// ── Values, from the real sites ──────────────────────────────────────────────────────────────────

describe("acfValues and toEntryData: fineline", () => {
  test("a project, with every kind of value the Projects group holds", () => {
    const { model, acf } = fineline;
    const missing: [string, number, string][] = [];
    const post = model.posts.get(5335)!;
    const raw = acfValues(model, acf, postTarget(model, post));
    // Raw: ids stay ids, a list of ids stays a list.
    expect(raw.fp_image).toMatchObject({ type: "image", id: 5943 });
    expect(raw.gallery).toMatchObject({ type: "gallery" });
    expect((raw.gallery as Extract<AcfRaw, { type: "gallery" }>).ids).toHaveLength(7);
    expect(raw.project_type_link).toMatchObject({ type: "link", value: { title: "", target: "" } });
    expect(raw.project_location).toMatchObject({ type: "select", values: ["Lebanon County, PA"] });
    expect(Object.keys(raw)).not.toContain("hide_field"); // empty

    const entry = toEntryData(raw, hooksOf(model, missing));
    expect(missing).toEqual([]);
    expect(entry.about).toStartWith("A fireplace is gorgeous and inviting");
    expect(entry.project_location).toBe("Lebanon County, PA");
    expect(entry.fp_title_1).toBe("High Quality");
    expect(entry.gallery).toHaveLength(7);
    expect((entry.gallery as Record<string, unknown>[])[0]).toEqual({
      src: "/media/Benefits-Of-A-Fresh-Painting-In-Lebanon-PA.png",
      width: 1800,
      height: 1200,
      alt: "",
    });
    expect(entry.fp_image).toEqual({
      src: "/media/Interior-Paint-Job-in-Lebanon.jpeg",
      width: 1600,
      height: 1204,
      alt: "",
    });
    expect(entry.type_icon).toEqual({
      src: "/media/interior-painting-icon.png",
      width: 1000,
      height: 1000,
      alt: "",
    });
    expect(entry.project_type_link).toEqual({
      url: expect.stringContaining("https://finelinepainting.pro/"),
      title: "",
      target: "",
    });
    // The key order is the editor's, which is what a person reading the frontmatter expects.
    expect(Object.keys(entry).slice(0, 3)).toEqual(["about", "gallery", "benefits_section_title"]);
    // Plain JSON: the contract's shapes, nothing else.
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });

  test("a service: text and wysiwyg HTML as written", () => {
    const { model, acf } = fineline;
    const entry = toEntryData(
      acfValues(model, acf, postTarget(model, model.posts.get(5278)!)),
      hooksOf(model),
    );
    expect(entry.page_title).toBe("Professional Hardwood Floor Finishing in Central PA");
    expect(entry.proud_intro).toStartWith('<p style="text-align: center;">We will work with you');
    expect(Object.keys(entry)).toContain("technique_text");
  });

  test("a post: text and url fields", () => {
    const { model, acf } = fineline;
    expect(
      toEntryData(acfValues(model, acf, postTarget(model, model.posts.get(2602)!)), hooksOf(model)),
    ).toEqual({
      cta_title: "Don't Wait, Take Action Now!",
      cta_text:
        "Call us today to schedule your next painting project. Our team of experts will work closely with you to bring your vision to life.",
      cta_button_1_title: "Get a Quote",
      cta_button_1_link: "https://finelinepainting.pro/quote/",
      cta_button_2_title: "717-669-8739",
      cta_button_2_link: "tel://7176698739",
    });
  });

  test("a project whose two groups both define county_image uses the definition its row points at", () => {
    const { model, acf } = fineline;
    const projects = [...model.posts.values()].filter(
      (p) => p.type === "project" && p.status === "publish",
    );
    const keys = new Set(["field_655673caeaa9a", "field_69a5a5664d77c"]);
    const seen = new Set<string>();
    for (const post of projects) {
      const ref = model.postMeta.get(post.id)?._county_image?.[0];
      const raw = acfValues(model, acf, postTarget(model, post)).county_image;
      if (typeof ref === "string" && keys.has(ref) && raw) {
        seen.add(ref);
        expect(raw.field.key).toBe(ref);
      }
    }
    // Both definitions are really in use on the site.
    expect([...seen].sort()).toEqual([...keys].sort());
  });

  test("terms: the Service Area fields of a location, and the Project Type fields", () => {
    const { model, acf } = fineline;
    const term = (id: number): WpTerm => model.terms.get(id)!;
    expect(
      toEntryData(acfValues(model, acf, termTarget(model, term(170))), hooksOf(model)),
    ).toEqual({
      county_image: { src: "/media/Adams-png.png", width: 1600, height: 1200, alt: "" },
    });
    expect(toEntryData(acfValues(model, acf, termTarget(model, term(56))), hooksOf(model))).toEqual(
      {
        project_type_title: "Interior Painting",
        project_type_image: {
          src: "/media/interior-painting-icon.png",
          width: 1000,
          height: 1000,
          alt: "",
        },
        parent_seo_page: "https://finelinepainting.pro/residential/interior-painting/",
      },
    );
    // A taxonomy no group is on has no values.
    const tag = [...model.terms.values()].find((t) => t.taxonomy === "project_tag")!;
    expect(acfValues(model, acf, termTarget(model, tag))).toEqual({});
  });

  test("values that are left in the database under a field that no longer exists are reported, not carried", () => {
    const { model, acf } = fineline;
    const report = createReport();
    acfValues(model, acf, postTarget(model, model.posts.get(1528)!), { report });
    const orphaned = codes(report, "acf.value-orphaned");
    expect(orphaned.map((e) => (e.data as { name: string }).name)).toEqual(["summary"]);
    expect(orphaned[0]).toMatchObject({
      severity: "warn",
      where: "post:1528",
      url: "https://finelinepainting.pro/?p=1528",
    });
    expect(orphaned[0]!.message).toContain("no longer exists");
    expect((orphaned[0]!.data as { value: string }).value).toStartWith(
      "This beautiful log sided cabin",
    );
  });

  test("a value under a name the field had before it was renamed is reported as that", () => {
    const { model, acf } = fineline;
    const report = createReport();
    const post = [...model.posts.values()].find(
      (p) => p.type === "project" && model.postMeta.get(p.id)?.featured_image?.[0] === "6292",
    )!;
    acfValues(model, acf, postTarget(model, post), { report });
    const renamed = codes(report, "acf.value-orphaned").find(
      (e) => (e.data as { name: string }).name === "featured_image",
    )!;
    expect(renamed.message).toContain('the field is now called "county_image"');
  });

  test("an empty or '0' orphan is not worth a report", () => {
    const { model, acf } = fineline;
    const report = createReport();
    for (const post of model.posts.values())
      acfValues(model, acf, postTarget(model, post), { report });
    for (const e of codes(report, "acf.value-orphaned")) {
      expect((e.data as { value: unknown }).value).not.toBe("");
      expect((e.data as { value: unknown }).value).not.toBe("0");
    }
  });
});

describe("acfValues and toEntryData: anabaptistperspectives", () => {
  test("an episode: users, a link, a boolean, a post that is not in the fixture", () => {
    const { model, acf } = ap;
    const missing: [string, number, string][] = [];
    const entry = toEntryData(
      acfValues(model, acf, postTarget(model, model.posts.get(11212)!)),
      hooksOf(model, missing),
    );
    expect(entry.guest).toEqual([
      {
        id: 201,
        slug: "michael-hochstetler",
        title: "Michael Hochstetler",
        url: "/author/michael-hochstetler/",
      },
    ]);
    // A single-valued user field is one object, not a list of one.
    expect(entry.host).toEqual({
      id: 226,
      slug: "reagan-schrock",
      title: "Reagan Schrock",
      url: "/author/reagan-schrock/",
    });
    expect(entry.id).toBe("260");
    expect(entry.youtube).toEqual({ url: "https://youtu.be/Af6cmBcC8tw", title: "", target: "" });
    // "0" is false, which is a value.
    expect(entry.premium).toBe(false);
    // The captivate_podcast the episode points at is older than the fixture keeps: dropped, and handed to `missing`.
    expect(entry).not.toHaveProperty("captivate_episode");
    expect(missing).toEqual([["post", 11202, "captivate_episode"]]);
  });

  test("the user field called author is kept under its own key, beside the contract's author", () => {
    const { model, acf } = ap;
    const entry = toEntryData(
      acfValues(model, acf, postTarget(model, model.posts.get(11669)!)),
      hooksOf(model),
    );
    expect(Object.keys(entry)).toEqual(["captivate_episode", "acf_author"]);
    expect(entry.acf_author).toEqual({
      id: 192,
      slug: "merle-burkholder",
      title: "Merle Burkholder",
      url: "/author/merle-burkholder/",
    });
    expect(entry.captivate_episode).toMatchObject({
      id: 11654,
      slug: "how-passionate-25-year-olds-become-fruitful-45-year-olds",
    });
  });

  test("a supporters update: an image with its own alt text", () => {
    const { model, acf } = ap;
    expect(
      toEntryData(acfValues(model, acf, postTarget(model, model.posts.get(1090)!)), hooksOf(model)),
    ).toEqual({
      image_media: {
        src: "/media/2022/06/2022-06_SU-19-Finances.png",
        width: 480,
        height: 353,
        alt: "SU 19 Finances",
      },
    });
  });

  test("a multi user field holding a single id (an older save) is still a list", () => {
    const { model, acf } = ap;
    const post = [...model.posts.values()].find(
      (p) =>
        p.type === "post" && model.postMeta.get(p.id)?._narrator?.[0] === "field_62d867cf7e15e",
    )!;
    expect(model.postMeta.get(post.id)!.narrator![0]).toBe("197");
    const raw = acfValues(model, acf, postTarget(model, post)).narrator!;
    expect(raw).toMatchObject({ type: "user", ids: [197] });
    // (The user is not an author of anything in the fixture, so the model does not hold it: a stand-in answers.)
    const user: EntryHooks = {
      ...hooksOf(model),
      user: (id) => ({ id, slug: `u${id}`, title: `User ${id}`, url: `/author/u${id}/` }),
    };
    expect(toEntryData({ narrator: raw }, user).narrator).toEqual([
      { id: 197, slug: "u197", title: "User 197", url: "/author/u197/" },
    ]);
  });

  test("a group that is switched off reads nothing, and the values under it that hold something are reported", () => {
    const { model, acf } = ap;
    const report = createReport();
    const episode = [...model.posts.values()].find((p) => p.type === "episode")!;
    const raw = acfValues(model, acf, postTarget(model, episode), { report });
    expect(Object.keys(raw)).not.toContain("video");
    expect(Object.keys(raw)).not.toContain("narrator");
    // The deprecated fields of the real episodes are all empty, so there is nothing to report here.
    expect(codes(report, "acf.value-orphaned")).toEqual([]);
  });
});

describe("every entry of both sites validates against the schema its fields make", () => {
  for (const site of ["fineline", "ap"] as const) {
    test(site, () => {
      const { model, acf } = site === "fineline" ? fineline : ap;
      const byType = new Map<string, WpPost[]>();
      for (const post of model.posts.values()) {
        if (post.type.startsWith("acf-")) continue;
        byType.set(post.type, [...(byType.get(post.type) ?? []), post]);
      }
      let entries = 0;
      const unexpected: string[] = [];
      for (const [type, posts] of byType) {
        const targets = posts.map((p) => postTarget(model, p));
        const fields = fieldsFor(acf, targets);
        if (fields.length === 0) continue;
        const schema = acfSchema(fields);
        const validate = ajv.compile(schema);
        const required = (schema.required as string[] | undefined) ?? [];
        posts.forEach((post, i) => {
          const entry = toEntryData(acfValues(model, acf, targets[i]!), hooksOf(model));
          entries++;
          if (!validate(entry)) {
            // The only way a real entry may fail is a field ACF requires that the post leaves empty.
            const errors = validate.errors ?? [];
            const onlyRequired = errors.every(
              (e) =>
                e.keyword === "required" &&
                required.includes(
                  String((e.params as { missingProperty: string }).missingProperty),
                ),
            );
            if (!onlyRequired)
              unexpected.push(`${type} ${post.id}: ${JSON.stringify(errors.slice(0, 2))}`);
          }
        });
      }
      expect(unexpected).toEqual([]);
      // Both sites have well over a hundred posts with fields (the rest are templates and menu items).
      expect(entries).toBeGreaterThan(200);
    });
  }

  test("the projects that fail are the ones ACF's required project_location is empty on, and none is published without it", () => {
    const { model, acf } = fineline;
    const projects = [...model.posts.values()].filter((p) => p.type === "project");
    const missing = projects.filter((p) => {
      const v = model.postMeta.get(p.id)?.project_location?.[0];
      return v === undefined || v === "";
    });
    expect(missing.length).toBeGreaterThan(0);
    for (const p of missing) {
      expect(
        toEntryData(acfValues(model, acf, postTarget(model, p)), hooksOf(model)),
      ).not.toHaveProperty("project_location");
    }
    // The schema asks for it, and says so.
    expect(
      acfSchema(
        fieldsFor(
          acf,
          projects.map((p) => postTarget(model, p)),
        ),
      ).required,
    ).toEqual(["project_location"]);
  });
});

describe("scalar values against the raw rows, read by a second route", () => {
  interface MetaRow {
    post_id: number;
    meta_key: string;
    meta_value: string | null;
  }
  for (const site of ["fineline", "ap"] as const) {
    test(site, () => {
      const { model, acf } = site === "fineline" ? fineline : ap;
      const rows = readFixtureJson<MetaRow[]>(site, "rows/postmeta.json");
      // The first row under each key of each post, which is what get_post_meta( $id, $key, true ) answers.
      const first = new Map<string, string>();
      for (const r of rows) {
        const k = `${r.post_id}:${r.meta_key}`;
        if (!first.has(k) && r.meta_value !== null) first.set(k, r.meta_value);
      }
      let checked = 0;
      for (const post of model.posts.values()) {
        if (post.type === "attachment") continue;
        const raw = acfValues(model, acf, postTarget(model, post));
        for (const g of groupsFor(acf, postTarget(model, post))) {
          for (const f of g.fields) {
            if (!["text", "textarea", "wysiwyg", "url", "email"].includes(f.type) || f.name === "")
              continue;
            const stored = first.get(`${post.id}:${f.name}`);
            if (stored === undefined || stored === "") {
              // No row, or an empty one, is no value (a default may stand in only when there is no row at all).
              if (stored === "") expect(raw[f.name]).toBeUndefined();
              continue;
            }
            expect(raw[f.name]).toMatchObject({ type: f.type, value: stored });
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(site === "fineline" ? 700 : 150);
    });
  }

  test("images, galleries and links against php-serialize", () => {
    const { model, acf } = fineline;
    const rows = readFixtureJson<
      { post_id: number; meta_key: string; meta_value: string | null }[]
    >("fineline", "rows/postmeta.json");
    const first = new Map<string, string>();
    for (const r of rows)
      if (!first.has(`${r.post_id}:${r.meta_key}`) && r.meta_value !== null)
        first.set(`${r.post_id}:${r.meta_key}`, r.meta_value);
    let galleries = 0;
    let links = 0;
    let images = 0;
    for (const post of model.posts.values()) {
      if (post.type !== "project") continue;
      const raw = acfValues(model, acf, postTarget(model, post));
      const gallery = first.get(`${post.id}:gallery`);
      if (gallery) {
        galleries++;
        expect((raw.gallery as { ids: number[] }).ids).toEqual(
          (unserialize(gallery) as string[]).map(Number),
        );
      } else expect(raw.gallery).toBeUndefined();
      const link = first.get(`${post.id}:project_type_link`);
      if (link && link.startsWith("a:")) {
        const l = unserialize(link) as { url: string; title: string; target: string };
        if (l.url !== "" || l.title !== "") {
          links++;
          expect(raw.project_type_link).toMatchObject({ value: l });
        }
      }
      const icon = first.get(`${post.id}:type_icon`);
      if (icon) {
        images++;
        expect(raw.type_icon).toMatchObject({ id: Number(icon) });
      }
    }
    expect(galleries).toBeGreaterThan(10);
    expect(links).toBeGreaterThan(10);
    expect(images).toBeGreaterThan(10);
  });
});

describe("the census of field types", () => {
  test("every field type of both databases is one this module handles, and none is reported unsupported", () => {
    for (const site of ["fineline", "ap"] as const) {
      const rows = readFixtureJson<{ post_type: string; post_content: string }[]>(
        site,
        "rows/posts.json",
      );
      const types = new Set<string>();
      for (const r of rows) {
        if (r.post_type !== "acf-field") continue;
        const settings = unserialize(r.post_content, {}, { strict: false }) as { type: string };
        types.add(settings.type);
      }
      expect(types.size).toBeGreaterThan(5);
      for (const type of types) expect(ACF_FIELD_TYPES).toContain(type);
      expect(codes((site === "fineline" ? fineline : ap).report, "acf.field-unsupported")).toEqual(
        [],
      );
    }
    // What the two sites use between them.
    const used = new Set<string>();
    for (const site of ["fineline", "ap"] as const) {
      for (const r of readFixtureJson<{ post_type: string; post_content: string }[]>(
        site,
        "rows/posts.json",
      )) {
        if (r.post_type === "acf-field")
          used.add((unserialize(r.post_content, {}, { strict: false }) as { type: string }).type);
      }
    }
    expect([...used].sort()).toEqual(
      [
        "accordion",
        "gallery",
        "image",
        "link",
        "post_object",
        "repeater",
        "select",
        "text",
        "textarea",
        "true_false",
        "url",
        "user",
        "wysiwyg",
      ].sort(),
    );
  });

  test("every field type the plugin registers is known (the list is the plugin's own, SCF 6.9.5, which the sites run)", () => {
    const plugin = [
      "accordion",
      "button_group",
      "checkbox",
      "clone",
      "color_picker",
      "date_picker",
      "date_time_picker",
      "email",
      "file",
      "flexible_content",
      "gallery",
      "google_map",
      "group",
      "icon_picker",
      "image",
      "link",
      "message",
      "nav_menu",
      "number",
      "oembed",
      "page_link",
      "password",
      "post_object",
      "radio",
      "range",
      "relationship",
      "repeater",
      "select",
      "separator",
      "tab",
      "taxonomy",
      "text",
      "textarea",
      "time_picker",
      "true_false",
      "url",
      "user",
      "wysiwyg",
    ];
    for (const type of plugin) expect(ACF_FIELD_TYPES).toContain(type);
    // The plugin also registers `output`, deprecated since 6.3.2: it prints nothing, so it is not a field type to read.
    expect(ACF_FIELD_TYPES).not.toContain("output");
  });

  test("a type that is not known is reported, and its stored value is carried as it is", () => {
    const { entry, report, raw } = readPage([field("acfe_code_editor", "code")], {
      code: ["<?php echo 1;"],
      _code: ["field_code"],
    });
    const unsupported = codes(report, "acf.field-unsupported");
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toMatchObject({
      severity: "warn",
      data: { type: "acfe_code_editor", name: "code" },
    });
    expect(raw.code).toMatchObject({ type: "other", value: "<?php echo 1;" });
    expect(entry).toEqual({ code: "<?php echo 1;" });
  });
});

// ── Edge cases, by hand ──────────────────────────────────────────────────────────────────────────

describe("repeaters, groups and flexible content", () => {
  const fields = [
    field("text", "headline"),
    field("repeater", "rows", {}, [
      field("text", "label"),
      field("repeater", "cells", {}, [field("number", "n"), field("image", "pic")]),
      field("group", "meta", {}, [field("text", "a"), field("true_false", "b")]),
    ]),
    field(
      "flexible_content",
      "blocks",
      {
        layouts: {
          layout_1: { key: "layout_1", name: "hero", label: "Hero" },
          layout_2: { key: "layout_2", name: "quote", label: "Quote" },
        },
      },
      [
        field("text", "title", { parent_layout: "layout_1" }),
        field("textarea", "text", { parent_layout: "layout_2" }),
      ],
    ),
  ];
  const meta = {
    headline: ["Hi"],
    rows: ["2"],
    rows_0_label: ["A"],
    rows_0_cells: ["2"],
    rows_0_cells_0_n: ["5"],
    rows_0_cells_0_pic: ["12"],
    rows_0_cells_1_n: ["6"],
    rows_0_cells_1_pic: [""],
    rows_0_meta_a: ["x"],
    rows_0_meta_b: ["1"],
    rows_1_label: ["B"],
    rows_1_cells: ["0"],
    rows_1_meta_a: [""],
    rows_1_meta_b: [""],
    blocks: [["hero", "quote", "gone"]],
    blocks_0_title: ["T0"],
    blocks_1_text: ["Q1"],
  };

  test("a repeater inside a repeater, a group inside a row, a flexible field with a layout that no longer exists", () => {
    const { entry, report } = readPage(fields, meta, {
      hooks: { ...noHooks, attachment: (id) => ({ src: `/m/${id}.png`, alt: "" }) },
    });
    expect(entry).toEqual({
      headline: "Hi",
      rows: [
        {
          label: "A",
          cells: [{ n: 5, pic: { src: "/m/12.png", alt: "" } }, { n: 6 }],
          meta: { a: "x", b: true },
        },
        // A row with nothing in it (an empty inner repeater, empty text, no boolean) is dropped.
        { label: "B" },
      ],
      blocks: [
        { acf_fc_layout: "hero", title: "T0" },
        { acf_fc_layout: "quote", text: "Q1" },
      ],
    });
    const gone = codes(report, "acf.layout-unknown");
    expect(gone).toHaveLength(1);
    expect(gone[0]!.data).toEqual({ name: "blocks", layout: "gone" });
  });

  test("every position of the nesting is consumed, so none is called an orphan", () => {
    const { report } = readPage(fields, {
      ...meta,
      ...Object.fromEntries(Object.keys(meta).map((k) => [`_${k}`, ["field_x"]])),
    });
    expect(codes(report, "acf.value-orphaned")).toEqual([]);
  });

  test("a row that is all empty is dropped, and a repeater with no content at all is absent", () => {
    const { entry } = readPage([field("repeater", "rows", {}, [field("text", "a")])], {
      rows: ["3"],
      rows_0_a: [""],
      rows_1_a: ["x"],
    });
    expect(entry).toEqual({ rows: [{ a: "x" }] });
    expect(
      readPage([field("repeater", "rows", {}, [field("text", "a")])], { rows: ["0"] }).entry,
    ).toEqual({});
    expect(
      readPage([field("repeater", "rows", {}, [field("text", "a")])], { rows: [""] }).entry,
    ).toEqual({});
    expect(
      readPage([field("group", "g", {}, [field("text", "a")])], { g: [""], g_a: [""] }).entry,
    ).toEqual({});
  });

  test("a stored row count past the limit is capped, and reported", () => {
    const { raw, report } = readPage([field("repeater", "rows", {}, [field("text", "a")])], {
      rows: ["99999999"],
      rows_0_a: ["x"],
    });
    expect((raw.rows as Extract<AcfRaw, { type: "repeater" }>).rows).toEqual([
      { a: expect.objectContaining({ value: "x" }) },
    ]);
    expect(codes(report, "acf.value-unreadable")[0]!.message).toContain("only the first 5000");
  });

  test("a flexible content value written as a single layout name, and layouts whose sub-field names no layout", () => {
    const flexible = field(
      "flexible_content",
      "blocks",
      { layouts: [{ key: "layout_1", name: "hero", label: "Hero" }] },
      [
        field("text", "title", { parent_layout: "layout_1" }),
        field("text", "stray", { parent_layout: "layout_gone" }),
        field("text", "unnamed"),
      ],
    );
    const { entry, report } = readPage([flexible], {
      blocks: ["hero"],
      blocks_0_title: ["T"],
      blocks_0_stray: ["S"],
      blocks_0_unnamed: ["U"],
    });
    // `unnamed` has no `parent_layout`: ACF puts it in the first layout. `stray` names a layout that is not there.
    expect(entry).toEqual({ blocks: [{ acf_fc_layout: "hero", title: "T", unnamed: "U" }] });
    expect(codes(report, "acf.subfield-ignored").map((e) => e.where)).toHaveLength(1);
  });

  test("two layouts of one name (an import's doing): a row is read as the last of them, as ACF's load_value keeps it", () => {
    const flexible = field(
      "flexible_content",
      "blocks",
      {
        layouts: [
          { key: "layout_1", name: "hero", label: "Hero" },
          { key: "layout_2", name: "hero", label: "Hero again" },
        ],
      },
      [
        field("text", "first", { parent_layout: "layout_1" }),
        field("text", "second", { parent_layout: "layout_2" }),
      ],
    );
    const { entry } = readPage([flexible], {
      blocks: [["hero"]],
      blocks_0_first: ["F"],
      blocks_0_second: ["S"],
    });
    expect(entry).toEqual({ blocks: [{ acf_fc_layout: "hero", second: "S" }] });
  });

  test("a row an editor switched off (SCF 6.5's `_<name>_layout_meta`) is not on the site, so it is not in the entry, and is told", () => {
    const flexible = field(
      "flexible_content",
      "blocks",
      {
        layouts: [
          { key: "layout_1", name: "hero", label: "Hero" },
          { key: "layout_2", name: "quote", label: "Quote" },
        ],
      },
      [
        field("text", "title", { parent_layout: "layout_1" }),
        field("text", "text", { parent_layout: "layout_2" }),
      ],
    );
    const { entry, raw, report } = readPage([flexible], {
      blocks: [["hero", "quote", "hero"]],
      // The renamed labels are the editor's own and change nothing.
      _blocks_layout_meta: [{ disabled: [1], renamed: { 2: "Last" } }],
      blocks_0_title: ["T0"],
      blocks_1_text: ["Q1"],
      blocks_2_title: ["T2"],
    });
    expect(entry).toEqual({
      blocks: [
        { acf_fc_layout: "hero", title: "T0" },
        { acf_fc_layout: "hero", title: "T2" },
      ],
    });
    // The row positions are the stored ones: the third row's values are still `blocks_2_…`.
    expect(raw.blocks).toMatchObject({ rows: [{ layout: "hero" }, { layout: "hero" }] });
    const told = codes(report, "acf.layout-disabled");
    expect(told).toHaveLength(1);
    expect(told[0]!.data).toEqual({ name: "blocks", layout: "quote", row: 1 });
    expect(told[0]!.message).toContain("Row 2 (quote)");
    expect(told[0]!.severity).toBe("info");
    expect(codes(report, "acf.value-orphaned")).toEqual([]);
  });

  test("switched-off rows of a flexible field inside a repeater row, and a layout meta that says nothing", () => {
    const inner = (): FieldMaker =>
      field(
        "flexible_content",
        "blocks",
        { layouts: [{ key: "layout_1", name: "hero", label: "Hero" }] },
        [field("text", "title", { parent_layout: "layout_1" })],
      );
    const { entry } = readPage([field("repeater", "sections", {}, [inner()])], {
      sections: ["2"],
      sections_0_blocks: [["hero", "hero"]],
      _sections_0_blocks_layout_meta: [{ disabled: [0], renamed: [] }],
      sections_0_blocks_0_title: ["off"],
      sections_0_blocks_1_title: ["on"],
      sections_1_blocks: [["hero"]],
      // Nothing disabled, a list that is empty, a value that is no list.
      _sections_1_blocks_layout_meta: [{ disabled: [], renamed: [] }],
      sections_1_blocks_0_title: ["all"],
    });
    expect(entry).toEqual({
      sections: [
        { blocks: [{ acf_fc_layout: "hero", title: "on" }] },
        { blocks: [{ acf_fc_layout: "hero", title: "all" }] },
      ],
    });
    for (const odd of ["", "x", [], { disabled: "no" }, { disabled: [0.5, "x"] }]) {
      const read = readPage([inner()], {
        blocks: [["hero"]],
        _blocks_layout_meta: [odd],
        blocks_0_title: ["T"],
      });
      expect(read.entry).toEqual({ blocks: [{ acf_fc_layout: "hero", title: "T" }] });
    }
  });
});

describe("clone fields", () => {
  const base = group("Base", loc("post_type", "none"), [
    field("text", "street"),
    field("text", "city"),
  ]);
  const baseKey = base[0]!.slug;
  const meta = {
    street: ["1 Main"],
    city: ["Town"],
    seam_pref_street: ["2 Pref"],
    seam_pref_city: ["PrefTown"],
    billing_street: ["3 Bill"],
    billing_city: ["BillTown"],
    people: ["1"],
    people_0_home_street: ["4 Home"],
    people_0_home_city: ["HomeTown"],
    people_0_name: ["Ann"],
  };

  function readClone(
    fields: FieldMaker[],
    metaRows: Record<string, unknown[]>,
    extra: WpPost[] = base,
  ): ReturnType<typeof readPage> {
    const page = wpPost({ type: "page", slug: "p" });
    const defs = group("Host", loc("post_type", "page"), fields);
    const model = modelOf([...extra, ...defs, page], { meta: { [page.id]: metaRows } });
    const report = createReport();
    const acf = loadAcf(model, report);
    const raw = acfValues(model, acf, postTarget(model, page));
    return { entry: toEntryData(raw, noHooks), raw, report, acf };
  }

  test("seamless without a prefix: the copies are fields of the parent under their own names", () => {
    const { entry } = readClone(
      [field("clone", "seam_plain", { clone: [baseKey], display: "seamless", prefix_name: 0 })],
      meta,
    );
    expect(entry).toEqual({ street: "1 Main", city: "Town" });
  });

  test("seamless with a prefix: the clone's name in front of each", () => {
    const { entry } = readClone(
      [field("clone", "seam_pref", { clone: [baseKey], display: "seamless", prefix_name: 1 })],
      meta,
    );
    expect(entry).toEqual({ seam_pref_street: "2 Pref", seam_pref_city: "PrefTown" });
  });

  test("shown as a group: one object, whose values are stored with the prefix, or without it", () => {
    const prefixed = readClone(
      [field("clone", "billing", { clone: [baseKey], display: "group", prefix_name: 1 })],
      meta,
    );
    expect(prefixed.entry).toEqual({ billing: { street: "3 Bill", city: "BillTown" } });
    expect(prefixed.raw.billing).toMatchObject({ type: "group" });
    const plain = readClone(
      [field("clone", "shipping", { clone: [baseKey], display: "group", prefix_name: 0 })],
      meta,
    );
    expect(plain.entry).toEqual({ shipping: { street: "1 Main", city: "Town" } });
  });

  test("a clone of one field, and of a field of another group", () => {
    const { entry } = readClone(
      [field("clone", "one", { clone: ["field_street"], display: "seamless", prefix_name: 1 })],
      { one_street: ["only"] },
    );
    expect(entry).toEqual({ one_street: "only" });
  });

  test("inside a repeater the row's position comes before the clone's prefix", () => {
    const { entry } = readClone(
      [
        field("repeater", "people", {}, [
          field("clone", "home", { clone: [baseKey], display: "seamless", prefix_name: 1 }),
          field("text", "name"),
        ]),
      ],
      meta,
    );
    expect(entry).toEqual({
      people: [{ home_street: "4 Home", home_city: "HomeTown", name: "Ann" }],
    });
  });

  test("the schema expands a seamless clone in place and makes a group-shown one an object", () => {
    const { acf } = readClone(
      [
        field("clone", "seam", { clone: [baseKey], display: "seamless", prefix_name: 1 }),
        field("clone", "billing", { clone: [baseKey], display: "group", prefix_name: 1 }),
      ],
      meta,
    );
    const schema = acfSchema(acf.groups.find((g) => g.title === "Host")!.fields);
    expect(Object.keys(schema.properties as object)).toEqual([
      "seam_street",
      "seam_city",
      "billing",
    ]);
    expect(
      (schema.properties as Record<string, { properties: object }>).billing!.properties,
    ).toEqual({
      street: { type: "string", title: "street" },
      city: { type: "string", title: "city" },
    });
  });

  test("a clone of something that does not exist is reported and copies nothing", () => {
    const { entry, report } = readClone(
      [
        field("clone", "ghost", {
          clone: ["group_nope", "field_nope", "nonsense"],
          display: "seamless",
        }),
      ],
      meta,
    );
    expect(entry).toEqual({});
    const missing = codes(report, "acf.clone-missing");
    expect(missing.map((e) => (e.data as { selector: string }).selector)).toEqual([
      "group_nope",
      "field_nope",
      "nonsense",
    ]);
  });

  test("a clone that copies the group it sits in is cut short, and reported", () => {
    const page = wpPost({ type: "page", slug: "p" });
    const defs = group("Self", loc("post_type", "page"), [
      field("text", "own"),
      field("clone", "me", { clone: ["group_Self"], display: "group", prefix_name: 1 }),
    ]);
    const model = modelOf([...defs, page], { meta: { [page.id]: { own: ["x"], me_own: ["y"] } } });
    const report = createReport();
    const acf = loadAcf(model, report);
    expect(codes(report, "acf.clone-cycle")).toHaveLength(1);
    expect(toEntryData(acfValues(model, acf, postTarget(model, page)), noHooks)).toEqual({
      own: "x",
      me: { own: "y" },
    });
  });
});

describe("definitions that cannot be read", () => {
  test("a field whose settings do not parse is skipped and reported; its children are orphans; its siblings are fine", () => {
    const good = field("text", "good");
    const broken = field("group", "broken", {}, [field("text", "inside")], {
      content: 'a:2:{s:4:"type";s:5:"group";s:5:"label";s:2:"x";}',
    });
    const defs = group("G", loc("post_type", "page"), [good, broken]);
    const model = modelOf([...defs, wpPost({ type: "page" })]);
    const report = createReport();
    const acf = loadAcf(model, report);
    expect(acf.groups[0]!.fields.map((f) => f.name)).toEqual(["good"]);
    const malformed = codes(report, "acf.settings-malformed");
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({
      severity: "warn",
      data: { type: "acf-field", key: "field_broken" },
    });
    expect((malformed[0]!.data as { sample: string }).sample).toStartWith("a:2:{s:4:");
    const orphans = codes(report, "acf.field-orphan");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.message).toContain("inside");
  });

  test("a field group, post type, taxonomy or options page that does not parse is skipped", () => {
    const g = wpPost({
      type: "acf-field-group",
      title: "Bad group",
      slug: "group_bad",
      content: "not serialised at all",
    });
    const kid = field("text", "orphaned")(g.id, 0);
    const pt = wpPost({
      type: "acf-post-type",
      title: "Bad type",
      slug: "post_type_bad",
      content: 'a:1:{s:9:"post_type";s:99:"x";}',
    });
    const tx = wpPost({
      type: "acf-taxonomy",
      title: "Bad tax",
      slug: "taxonomy_bad",
      content: "a:2:{",
    });
    const op = wpPost({
      type: "acf-ui-options-page",
      title: "Bad page",
      slug: "ui_options_page_bad",
      content: "x",
    });
    const model = modelOf([g, ...kid, pt, tx, op]);
    const report = createReport();
    const acf = loadAcf(model, report);
    expect(acf.groups).toEqual([]);
    expect(acf.postTypes.size).toBe(0);
    expect(acf.taxonomies.size).toBe(0);
    expect(acf.optionsPages).toEqual([]);
    expect(codes(report, "acf.settings-malformed")).toHaveLength(4);
    expect(codes(report, "acf.field-orphan")).toHaveLength(1);
  });

  test("a definition that is an empty PHP array is valid but names nothing", () => {
    const pt = wpPost({
      type: "acf-post-type",
      title: "Empty type",
      slug: "post_type_empty",
      content: "a:0:{}",
    });
    const tx = wpPost({
      type: "acf-taxonomy",
      title: "Empty tax",
      slug: "taxonomy_empty",
      content: "a:0:{}",
    });
    const report = createReport();
    const acf = loadAcf(modelOf([pt, tx]), report);
    expect(acf.postTypes.size + acf.taxonomies.size).toBe(0);
    // Not malformed: they parse; they just have no name to register.
    expect(codes(report, "acf.settings-malformed")).toHaveLength(2);
    expect(codes(report, "acf.settings-malformed")[0]!.message).toContain("names no post type");
    expect(codes(report, "acf.settings-malformed")[1]!.message).toContain("names no taxonomy");
  });

  test("a field the site shows differently from how it is stored says so, once", () => {
    const defs = group("G", loc("post_type", "page"), [
      field("select", "colour", { choices: { r: "Red" }, return_format: "label" }),
      field("select", "same", { choices: { r: "r" }, return_format: "label" }),
      // One choice that reads differently is enough: the others map to themselves.
      field("select", "mixed", { choices: { a: "A", b: "b" }, return_format: "label" }),
      field("radio", "pair", { choices: { x: "X" }, return_format: "array" }),
      field("textarea", "paras", { new_lines: "wpautop" }),
      field("textarea", "breaks", { new_lines: "br" }),
      field("textarea", "plain", { new_lines: "" }),
    ]);
    const report = createReport();
    loadAcf(modelOf([...defs, wpPost({ type: "page" })]), report);
    expect(codes(report, "acf.return-format").map((e) => e.data)).toEqual([
      { name: "colour", returnFormat: "label" },
      { name: "mixed", returnFormat: "label" },
      { name: "pair", returnFormat: "array" },
    ]);
    expect(codes(report, "acf.return-format")[0]!.message).toContain("the label");
    expect(codes(report, "acf.return-format")[2]!.message).toContain("an array");
    const newlines = codes(report, "acf.textarea-newlines");
    expect(newlines.map((e) => e.data)).toEqual([{ name: "paras" }, { name: "breaks" }]);
    expect(newlines[0]!.message).toContain("paragraphs");
    expect(newlines[1]!.message).toContain("<br>");
  });

  test("a field with no settings at all is a text field", () => {
    const page = wpPost({ type: "page" });
    const defs = group("G", loc("post_type", "page"), [
      field("text", "x", {}, [], { content: "a:0:{}" }),
    ]);
    const acf = loadAcf(modelOf([...defs, page]));
    expect(acf.groups[0]!.fields[0]).toMatchObject({ name: "x", type: "text", required: false });
  });

  test("inactive, duplicate and disabled post types and taxonomies", () => {
    const settings = (name: string, extra: Record<string, unknown> = {}): string =>
      serialize({ post_type: name, labels: { name: `${name}s`, singular_name: name }, ...extra });
    const a = wpPost({
      type: "acf-post-type",
      title: "A",
      slug: "post_type_a",
      content: settings("thing"),
    });
    const dup = wpPost({
      type: "acf-post-type",
      title: "B",
      slug: "post_type_b",
      content: settings("thing"),
    });
    const off = wpPost({
      type: "acf-post-type",
      title: "C",
      slug: "post_type_c",
      status: "acf-disabled",
      content: settings("gone"),
    });
    const tOff = wpPost({
      type: "acf-taxonomy",
      title: "T",
      slug: "taxonomy_t",
      status: "acf-disabled",
      content: serialize({ taxonomy: "kind", object_type: ["thing"] }),
    });
    const tA = wpPost({
      type: "acf-taxonomy",
      title: "T1",
      slug: "taxonomy_t1",
      content: serialize({ taxonomy: "kind", object_type: ["thing"] }),
    });
    const tDup = wpPost({
      type: "acf-taxonomy",
      title: "T2",
      slug: "taxonomy_t2",
      content: serialize({ taxonomy: "kind", object_type: ["other"] }),
    });
    const report = createReport();
    const acf = loadAcf(modelOf([a, dup, off, tOff, tA, tDup]), report);
    expect([...acf.postTypes.keys()]).toEqual(["thing", "gone"]);
    expect(acf.postTypes.get("thing")!.postId).toBe(a.id);
    expect(acf.postTypes.get("gone")!.active).toBe(false);
    expect(codes(report, "acf.post-type-inactive").map((e) => e.where)).toEqual([`post:${off.id}`]);
    // The switched-off taxonomy was replaced by a live one of the same name, which is what WordPress registers.
    expect(codes(report, "acf.taxonomy-inactive")).toEqual([]);
    expect(codes(report, "acf.duplicate-definition")).toHaveLength(2);
    // The taxonomy that is off does not claim the type; the active one does.
    expect(acf.taxonomies.get("kind")!.active).toBe(true);
    expect(taxonomiesFor(acf, "thing")).toEqual(["kind"]);
    expect(taxonomiesFor(acf, "other")).toEqual([]);
  });

  test("the settings an ACF post type gets when they were never saved", () => {
    const pt = wpPost({
      type: "acf-post-type",
      title: "Bare",
      slug: "post_type_bare",
      content: serialize({ post_type: "bare" }),
    });
    const none = wpPost({
      type: "acf-post-type",
      title: "None",
      slug: "post_type_none",
      content: serialize({
        post_type: "none",
        supports: [],
        public: 0,
        rewrite: { permalink_rewrite: "no_permalink", slug: "ignored" },
        has_archive: "1",
        has_archive_slug: "",
      }),
    });
    const custom = wpPost({
      type: "acf-post-type",
      title: "Custom",
      slug: "post_type_custom",
      content: serialize({
        post_type: "custom",
        rewrite: { permalink_rewrite: "custom_permalink", slug: "things", with_front: "1" },
        has_archive: 0,
        taxonomies: ["", "kind"],
      }),
    });
    const acf = loadAcf(modelOf([pt, none, custom]));
    const bare = acf.postTypes.get("bare")!;
    expect(bare).toMatchObject({
      singular: "Bare",
      plural: "Bare",
      public: true,
      hierarchical: false,
      hasArchive: false,
      rewriteSlug: "bare",
      rewriteWithFront: true,
      supports: ["title", "editor", "thumbnail", "custom-fields"],
      taxonomies: [],
    });
    expect(acf.postTypes.get("none")).toMatchObject({
      supports: [],
      public: false,
      rewriteSlug: false,
      hasArchive: true,
    });
    expect(acf.postTypes.get("custom")).toMatchObject({
      rewriteSlug: "things",
      rewriteWithFront: true,
      hasArchive: false,
      taxonomies: ["kind"],
    });
  });
});

describe("defaults, references and meta that is not there", () => {
  test("a field with no meta row answers its default; a row that is empty does not", () => {
    const fields = [
      field("text", "greeting", { default_value: "Hello" }),
      field("true_false", "on", { default_value: 1 }),
      field("number", "n", { default_value: 7 }),
      field("text", "blank", { default_value: "Hello" }),
      field("text", "none", { default_value: false }),
      field("select", "pick", { choices: { a: "A" }, default_value: false }),
    ];
    const { entry } = readPage(fields, { blank: [""], _blank: ["field_blank"] });
    expect(entry).toEqual({ greeting: "Hello", on: true, n: 7 });
  });

  test("true_false: stored 0, 1, '0', '1' and an empty string", () => {
    for (const [stored, expected] of [
      ["1", true],
      ["0", false],
      [1, true],
      [0, false],
    ] as const) {
      expect(readPage([field("true_false", "t")], { t: [stored] }).entry).toEqual({ t: expected });
    }
    expect(readPage([field("true_false", "t")], { t: [""] }).entry).toEqual({});
  });

  test("of two fields with one name, the one the post's own _name row points at is used", () => {
    const defs = [
      ...group("A", loc("post_type", "page"), [
        field("text", "dup", {}, [], { slug: "field_dup_a" }),
      ]),
      ...group("B", loc("post_type", "page"), [
        field("number", "dup", {}, [], { slug: "field_dup_b" }),
      ]),
    ];
    const page = wpPost({ type: "page" });
    const model = modelOf([...defs, page], {
      meta: { [page.id]: { dup: ["5"], _dup: ["field_dup_b"] } },
    });
    const acf = loadAcf(model);
    expect(acfValues(model, acf, postTarget(model, page)).dup).toMatchObject({
      type: "number",
      value: 5,
    });
    // Pointing at neither, the first applies.
    const other = modelOf([...defs, page], {
      meta: { [page.id]: { dup: ["5"], _dup: ["field_other"] } },
    });
    expect(acfValues(other, loadAcf(other), postTarget(other, page)).dup).toMatchObject({
      type: "text",
      value: "5",
    });
  });

  test("a stored value of a shape the field does not store is reported and left out", () => {
    const { entry, report } = readPage(
      [
        field("text", "t"),
        field("number", "n"),
        field("image", "i"),
        field("gallery", "g"),
        field("select", "s", { choices: { a: "A" } }),
        field("google_map", "m"),
        field("link", "l"),
      ],
      {
        t: [{ unexpected: "array" }],
        n: ["twelve"],
        i: [{ a: 1 }],
        g: ["abc"],
        s: ["a"],
        m: ["a plain string"],
        l: [5],
      },
    );
    expect(entry).toEqual({ s: "a" });
    expect(
      codes(report, "acf.value-unreadable")
        .map((e) => (e.data as { name: string }).name)
        .sort(),
    ).toEqual(["g", "i", "l", "m", "n", "t"]);
  });

  test("a value whose id is in a form an import leaves: numbers, lists, comma separated text, rows with an ID", () => {
    const { raw } = readPage(
      [
        field("image", "i"),
        field("image", "url_only"),
        field("gallery", "g"),
        field("relationship", "r"),
        field("user", "u"),
        field("post_object", "p", { multiple: 1 }),
      ],
      {
        i: [{ ID: 14, url: "x" }],
        url_only: ["https://elsewhere.test/a.png"],
        g: ["3, 4,5"],
        r: [[7, "8", { ID: 9 }, 0, "nope"]],
        u: [12],
        p: ["4"],
      },
    );
    expect(raw.i).toMatchObject({ type: "image", id: 14 });
    expect(raw.url_only).toMatchObject({ type: "image", url: "https://elsewhere.test/a.png" });
    expect(raw.g).toMatchObject({ ids: [3, 4, 5] });
    expect(raw.r).toMatchObject({ ids: [7, 8, 9] });
    expect(raw.u).toMatchObject({ ids: [12] });
    expect(raw.p).toMatchObject({ ids: [4] });
    // An address instead of an attachment survives as a source with no alt text.
    expect(toEntryData({ url_only: raw.url_only! }, noHooks)).toEqual({
      url_only: { src: "https://elsewhere.test/a.png", alt: "" },
    });
  });

  test("a link written as a plain address, and an empty link", () => {
    const { entry } = readPage(
      [field("link", "a"), field("link", "b"), field("link", "c"), field("link", "d")],
      {
        a: ["https://x.test/"],
        b: [{ title: "", url: "", target: "" }],
        c: [{ title: "Only a title", url: "", target: "_blank" }],
        d: [{ url: "https://y.test/", title: "Y", target: "_blank" }],
      },
    );
    expect(entry).toEqual({
      a: { url: "https://x.test/", title: "", target: "" },
      c: { url: "", title: "Only a title", target: "_blank" },
      d: { url: "https://y.test/", title: "Y", target: "_blank" },
    });
  });

  test("select, radio, button group and checkbox: values are strings, a checkbox is always a list", () => {
    const { entry } = readPage(
      [
        field("select", "one", { choices: { a: "A" } }),
        field("select", "many", { choices: { a: "A", b: "B" }, multiple: 1 }),
        field("checkbox", "boxes", { choices: { x: "X", y: "Y" } }),
        field("radio", "r", { choices: { 1: "One" } }),
        field("button_group", "bg", { choices: { l: "L" } }),
      ],
      { one: ["a"], many: [["a", "b"]], boxes: [["x"]], r: [1], bg: ["l"] },
    );
    expect(entry).toEqual({ one: "a", many: ["a", "b"], boxes: ["x"], r: "1", bg: "l" });
  });

  test("a taxonomy field with load_terms takes the post's own terms, not the meta", () => {
    const page = wpPost({ type: "page" });
    const terms: WpTerm[] = [
      {
        termId: 3,
        taxonomyId: 3,
        taxonomy: "genre",
        slug: "jazz",
        name: "Jazz",
        description: "",
        parent: 0,
        count: 1,
        meta: {},
      },
      {
        termId: 4,
        taxonomyId: 4,
        taxonomy: "genre",
        slug: "blues",
        name: "Blues",
        description: "",
        parent: 0,
        count: 1,
        meta: {},
      },
      {
        termId: 5,
        taxonomyId: 5,
        taxonomy: "other",
        slug: "x",
        name: "X",
        description: "",
        parent: 0,
        count: 1,
        meta: {},
      },
    ];
    const defs = group("G", loc("post_type", "page"), [
      field("taxonomy", "genres", { taxonomy: "genre", load_terms: 1 }),
      field("taxonomy", "saved", { taxonomy: "genre", field_type: "radio" }),
    ]);
    const model = modelOf([...defs, page], {
      terms,
      rel: { [page.id]: [4, 5, 3] },
      meta: { [page.id]: { genres: ["99"], saved: ["3"] } },
    });
    const acf = loadAcf(model);
    const raw = acfValues(model, acf, postTarget(model, page));
    expect(raw.genres).toMatchObject({ ids: [4, 3] });
    expect(raw.saved).toMatchObject({ ids: [3] });
    expect(toEntryData(raw, hooksOf(model))).toEqual({
      genres: [
        { id: 4, slug: "blues", title: "Blues", url: "/blues/" },
        { id: 3, slug: "jazz", title: "Jazz", url: "/jazz/" },
      ],
      saved: { id: 3, slug: "jazz", title: "Jazz", url: "/jazz/" },
    });
  });

  test("a value saved under a field that is in a group that is switched off, or renamed, or gone, is reported", () => {
    const page = wpPost({ type: "page" });
    const defs = [
      ...group("Live", loc("post_type", "page"), [
        field("text", "renamed_now", {}, [], { slug: "field_moved" }),
      ]),
      ...group("Off", loc("post_type", "page"), [field("text", "old_one")], {
        status: "acf-disabled",
      }),
      ...group("Elsewhere", loc("post_type", "project"), [field("text", "not_here")]),
    ];
    const model = modelOf([...defs, page], {
      meta: {
        [page.id]: {
          renamed_was: ["kept"],
          _renamed_was: ["field_moved"],
          old_one: ["off"],
          _old_one: ["field_old_one"],
          not_here: ["elsewhere"],
          _not_here: ["field_not_here"],
          deleted: ["gone"],
          _deleted: ["field_deleted"],
          plain_meta: ["not ACF"],
          empty: [""],
          _empty: ["field_empty"],
          zero: ["0"],
          _zero: ["field_zero"],
        },
      },
    });
    const report = createReport();
    const acf = loadAcf(model, report);
    expect(acfValues(model, acf, postTarget(model, page), { report })).toEqual({});
    const messages = Object.fromEntries(
      codes(report, "acf.value-orphaned").map((e) => [
        (e.data as { name: string }).name,
        e.message,
      ]),
    );
    expect(Object.keys(messages).sort()).toEqual(["deleted", "not_here", "old_one", "renamed_was"]);
    expect(messages.renamed_was).toContain('the field is now called "renamed_now"');
    expect(messages.old_one).toContain("switched off");
    expect(messages.not_here).toContain("does not apply to this post");
    expect(messages.deleted).toContain("no longer exists");
  });

  test("reports go where loadAcf was told, or where acfValues is", () => {
    const page = wpPost({ type: "page" });
    const defs = group("G", loc("post_type", "page"), [field("number", "n")]);
    const model = modelOf([...defs, page], { meta: { [page.id]: { n: ["x"] } } });
    const quiet = loadAcf(model);
    expect(() => acfValues(model, quiet, postTarget(model, page))).not.toThrow();
    const report = createReport();
    acfValues(model, quiet, postTarget(model, page), { report });
    expect(codes(report, "acf.value-unreadable")).toHaveLength(1);
  });
});

describe("dates", () => {
  const dates = (
    type: string,
    stored: string,
    parts: ModelParts = {},
  ): Extract<AcfRaw, { type: "date_picker" | "date_time_picker" }> =>
    readPage([field(type, "d")], { d: [stored] }, { parts }).raw.d as never;

  test("date_picker: ACF stores Ymd, Jx reads YYYY-MM-DD", () => {
    expect(dates("date_picker", "20240215")).toMatchObject({
      value: "20240215",
      iso: "2024-02-15",
    });
    expect(dates("date_picker", "2024-02-15")).toMatchObject({ iso: "2024-02-15" });
    expect(dates("date_picker", "20240229").iso).toBe("2024-02-29");
    // Not days that exist.
    expect(dates("date_picker", "20230229").iso).toBeUndefined();
    expect(dates("date_picker", "20241301").iso).toBeUndefined();
    expect(dates("date_picker", "03/04/2025").iso).toBeUndefined();
  });

  test("date_time_picker: the site's wall clock becomes the UTC instant, daylight saving included", () => {
    const ny = { options: { timezone_string: "America/New_York" } };
    expect(dates("date_time_picker", "2024-07-04 12:00:00", ny).iso).toBe("2024-07-04T16:00:00Z"); // EDT, UTC-4
    expect(dates("date_time_picker", "2024-01-04 12:00:00", ny).iso).toBe("2024-01-04T17:00:00Z"); // EST, UTC-5
    // The hour that never happened (clocks went forward at 2am on 2024-03-10) is read with the offset before.
    expect(dates("date_time_picker", "2024-03-10 02:30:00", ny).iso).toBe("2024-03-10T07:30:00Z");
    // The hour that happened twice is read as its first time.
    expect(dates("date_time_picker", "2024-11-03 01:30:00", ny).iso).toBe("2024-11-03T05:30:00Z");
    // Minutes only, and a fractional second.
    expect(dates("date_time_picker", "2024-01-04 12:00", ny).iso).toBe("2024-01-04T17:00:00Z");
    expect(dates("date_time_picker", "2024-01-04T12:00:00.250", ny).iso).toBe(
      "2024-01-04T17:00:00Z",
    );
    // No zone configured: UTC. A numeric offset: that offset.
    expect(dates("date_time_picker", "2024-01-04 12:00:00").iso).toBe("2024-01-04T12:00:00Z");
    expect(
      dates("date_time_picker", "2024-01-04 12:00:00", { options: { gmt_offset: "5.5" } }).iso,
    ).toBe("2024-01-04T06:30:00Z");
    expect(
      dates("date_time_picker", "2024-01-04 12:00:00", { options: { gmt_offset: "-3" } }).iso,
    ).toBe("2024-01-04T15:00:00Z");
    // A zone the runtime does not know falls back to the offset, then to UTC.
    expect(
      dates("date_time_picker", "2024-01-04 12:00:00", {
        options: { timezone_string: "Not/AZone", gmt_offset: "1" },
      }).iso,
    ).toBe("2024-01-04T11:00:00Z");
    expect(
      dates("date_time_picker", "2024-01-04 12:00:00", {
        options: { timezone_string: "Not/AZone" },
      }).iso,
    ).toBe("2024-01-04T12:00:00Z");
  });

  test("a value that states its own zone is an instant already; nonsense is kept as written and reported", () => {
    const ny = { options: { timezone_string: "America/New_York" } };
    expect(dates("date_time_picker", "2024-01-04T12:00:00Z", ny).iso).toBe("2024-01-04T12:00:00Z");
    expect(dates("date_time_picker", "2024-01-04T12:00:00+02:00", ny).iso).toBe(
      "2024-01-04T10:00:00Z",
    );
    expect(dates("date_time_picker", "2024-01-04 12:00:00-0530", ny).iso).toBe(
      "2024-01-04T17:30:00Z",
    );
    const { raw, report, entry } = readPage(
      [field("date_time_picker", "d"), field("date_picker", "e")],
      { d: ["next tuesday"], e: ["20240215"] },
    );
    expect(raw.d).toMatchObject({ type: "date_time_picker", value: "next tuesday" });
    expect((raw.d as { iso?: string }).iso).toBeUndefined();
    expect(entry).toEqual({ e: "2024-02-15" }); // the unreadable one is not in the entry
    const bad = codes(report, "acf.value-unreadable");
    expect(bad).toHaveLength(1);
    expect(bad[0]!.data).toEqual({ name: "d", value: "next tuesday" });
    // A date that is not a string cannot be one.
    expect(
      codes(readPage([field("date_picker", "d")], { d: [[1]] }).report, "acf.value-unreadable"),
    ).toHaveLength(1);
  });

  test("a stored date as a number (an import) is read as its digits", () => {
    expect(dates("date_picker", 20240215 as never).iso).toBe("2024-02-15");
  });

  test("the zone clocks agree with each other", () => {
    const model = modelOf([], { options: { timezone_string: "Europe/London" } });
    const clock = siteClock(model);
    const summer = Date.UTC(2024, 6, 1, 12, 0, 0);
    expect(clock.toLocal(summer) - summer).toBe(3_600_000);
    expect(clock.toUtc(clock.toLocal(summer))).toBe(summer);
    expect(zoneClock("UTC").toLocal(summer)).toBe(summer);
    expect(() => zoneClock("Not/AZone")).toThrow();
    expect(siteClock(modelOf([])).toUtc(summer)).toBe(summer);
  });
});

describe("options pages and term targets", () => {
  test("the options table holds an options page's values, prefixed with the page's own id", () => {
    const defs = [
      wpPost({
        type: "acf-ui-options-page",
        title: "Site settings",
        slug: "ui_options_page_1",
        content: serialize({
          page_title: "Site Settings",
          menu_slug: "site-settings",
          post_id: "site",
        }),
      }),
      wpPost({
        type: "acf-ui-options-page",
        title: "Off",
        slug: "ui_options_page_2",
        status: "acf-disabled",
        content: serialize({ page_title: "Off", menu_slug: "off-page" }),
      }),
      wpPost({
        type: "acf-ui-options-page",
        title: "No slug",
        slug: "ui_options_page_3",
        content: serialize({ page_title: "x" }),
      }),
      ...group(
        "Settings",
        [
          [{ param: "options_page", operator: "==", value: "site-settings" }],
          [{ param: "options_page", operator: "==", value: "code-only" }],
          [{ param: "options_page", operator: "==", value: "" }],
        ],
        [
          field("text", "tagline"),
          field("repeater", "links", {}, [field("text", "label")]),
          field("image", "logo"),
        ],
      ),
    ];
    const model = modelOf(defs, {
      options: {
        site_tagline: "Hello",
        _site_tagline: "field_tagline",
        site_links: "2",
        site_links_0_label: "One",
        site_links_1_label: "Two",
        site_logo: "44",
        options_tagline: "from the default prefix",
        site_deep: serialize(["a"]),
      },
    });
    const report = createReport();
    const acf = loadAcf(model, report);
    // In ACF's order, which is the title's: "Off" comes before "Site settings".
    expect(acf.optionsPages).toEqual([
      {
        slug: "off-page",
        title: "Off",
        postId: defs[1]!.id,
        active: false,
        prefix: "options",
        source: "ui",
      },
      {
        slug: "site-settings",
        title: "Site Settings",
        postId: defs[0]!.id,
        active: true,
        prefix: "site",
        source: "ui",
      },
      {
        slug: "code-only",
        title: "code-only",
        active: true,
        prefix: "options",
        source: "location",
      },
    ]);
    const raw = acfValues(model, acf, { kind: "options", page: "site-settings" });
    expect(
      toEntryData(raw, { ...noHooks, attachment: (id) => ({ src: `/m/${id}`, alt: "" }) }),
    ).toEqual({
      tagline: "Hello",
      links: [{ label: "One" }, { label: "Two" }],
      logo: { src: "/m/44", alt: "" },
    });
    // A page registered only in code uses the default prefix.
    expect(
      toEntryData(acfValues(model, acf, { kind: "options", page: "code-only" }), noHooks),
    ).toEqual({ tagline: "from the default prefix" });
    // Options of a page no group is on.
    expect(acfValues(model, acf, { kind: "options", page: "nothing" })).toEqual({});
  });

  test("a term's values come from its meta; a term id that is not in the model has none", () => {
    const term: WpTerm = {
      termId: 9,
      taxonomyId: 9,
      taxonomy: "genre",
      slug: "jazz",
      name: "Jazz",
      description: "",
      parent: 0,
      count: 1,
      meta: { color: "red", _color: "field_color", empty: "", _empty: "field_empty" },
    };
    const defs = group("Genres", loc("taxonomy", "genre"), [field("text", "color")]);
    const model = modelOf(defs, { terms: [term] });
    const acf = loadAcf(model);
    expect(toEntryData(acfValues(model, acf, termTarget(model, term)), noHooks)).toEqual({
      color: "red",
    });
    expect(acfValues(model, acf, { kind: "term", taxonomy: "genre", termId: 404 })).toEqual({});
    expect(acfValues(model, acf, { kind: "term", taxonomy: "genre" })).toEqual({});
    expect(acfValues(model, acf, { kind: "post", postType: "page" })).toEqual({});
  });
});

describe("toEntryData", () => {
  const f = (type: string, settings: Record<string, unknown> = {}): AcfField =>
    fieldOf(type, "x", settings);

  test("each type of value in the shape the contract gives it", () => {
    const missing: [string, number, string][] = [];
    const hooks = hooksOf(
      modelOf([wpPost({ id: 5, type: "post", slug: "five", title: "Five" })]),
      missing,
    );
    const raw: Record<string, AcfRaw> = {
      text: { type: "text", field: f("text"), value: "t" },
      html: { type: "wysiwyg", field: f("wysiwyg"), value: "<p>h</p>" },
      count: { type: "number", field: f("number"), value: 3 },
      on: { type: "true_false", field: f("true_false"), value: false },
      one: { type: "select", field: f("select"), values: ["a", "b"] },
      many: { type: "select", field: f("select", { multiple: 1 }), values: ["a", "b"] },
      boxes: { type: "checkbox", field: f("checkbox"), values: ["a"] },
      day: { type: "date_picker", field: f("date_picker"), value: "20240215", iso: "2024-02-15" },
      bad_day: { type: "date_picker", field: f("date_picker"), value: "x" },
      img: { type: "image", field: f("image"), id: 404 },
      pics: { type: "gallery", field: f("gallery"), ids: [404, 405] },
      go: { type: "link", field: f("link"), value: { url: "/a", title: "A", target: "" } },
      post: { type: "post_object", field: f("post_object"), ids: [5, 6] },
      posts: { type: "relationship", field: f("relationship"), ids: [5, 6] },
      term: { type: "taxonomy", field: f("taxonomy", { field_type: "radio" }), ids: [1] },
      who: { type: "user", field: f("user"), ids: [2] },
      map: { type: "google_map", field: f("google_map"), value: { lat: 1, lng: 2n as never } },
      odd: { type: "other", field: f("acfe_thing"), value: { big: 12345678901234567890n } },
    };
    const entry = toEntryData(raw, hooks);
    expect(entry).toEqual({
      text: "t",
      html: "<p>h</p>",
      count: 3,
      on: false,
      // A select that holds one value answers with it; one that holds several, with the list.
      one: "a",
      many: ["a", "b"],
      boxes: ["a"],
      day: "2024-02-15",
      go: { url: "/a", title: "A", target: "" },
      post: { id: 5, slug: "five", title: "Five", url: "/five/" },
      posts: [{ id: 5, slug: "five", title: "Five", url: "/five/" }],
      map: { lat: 1, lng: "2" },
      odd: { big: "12345678901234567890" },
    });
    // Everything the hooks could not give was dropped and handed to `missing`, with the field it belonged to.
    expect(missing).toEqual([
      ["attachment", 404, "x"],
      ["attachment", 404, "x"],
      ["attachment", 405, "x"],
      ["post", 6, "x"],
      ["post", 6, "x"],
      ["term", 1, "x"],
      ["user", 2, "x"],
    ]);
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });

  test("works without a missing hook, and keeps what resolved", () => {
    const hooks: EntryHooks = {
      attachment: (id) => (id === 1 ? { src: "/a", alt: "" } : undefined),
      post: () => undefined,
      term: () => undefined,
      user: () => undefined,
    };
    expect(
      toEntryData({ pics: { type: "gallery", field: f("gallery"), ids: [2, 1, 3] } }, hooks),
    ).toEqual({ pics: [{ src: "/a", alt: "" }] });
    expect(
      toEntryData({ pics: { type: "gallery", field: f("gallery"), ids: [2] } }, hooks),
    ).toEqual({});
  });

  test("keys are entryKey of the name at the top level only", () => {
    const entry = toEntryData(
      {
        title: { type: "text", field: f("text"), value: "ACF title" },
        seo: {
          type: "group",
          field: f("group"),
          values: { title: { type: "text", field: f("text"), value: "inner" } },
        },
        plain: {
          type: "repeater",
          field: f("repeater"),
          rows: [{ url: { type: "text", field: f("text"), value: "/u" } }],
        },
      },
      noHooks,
    );
    expect(entry).toEqual({
      acf_title: "ACF title",
      acf_seo: { title: "inner" },
      plain: [{ url: "/u" }],
    });
  });

  test("groups, repeater rows and flexible rows that come out empty are left out", () => {
    expect(
      toEntryData(
        {
          g: {
            type: "group",
            field: f("group"),
            values: { a: { type: "image", field: f("image"), id: 1 } },
          },
          r: {
            type: "repeater",
            field: f("repeater"),
            rows: [{ a: { type: "image", field: f("image"), id: 1 } }],
          },
          fc: {
            type: "flexible_content",
            field: f("flexible_content"),
            rows: [{ layout: "hero", values: {} }],
          },
        },
        noHooks,
      ),
    ).toEqual({ fc: [{ acf_fc_layout: "hero" }] });
  });
});

// ── Definitions, setting by setting ──────────────────────────────────────────────────────────────

/** An `acf-post-type` or `acf-taxonomy` post with the given settings. */
function definition(
  type: "acf-post-type" | "acf-taxonomy",
  title: string,
  settings: Record<string, unknown>,
  extra: Partial<WpPost> = {},
): WpPost {
  const kind = type === "acf-post-type" ? "post_type" : "taxonomy";
  return wpPost({
    type,
    title,
    slug: `${kind}_${title.replace(/\W/g, "")}`,
    content: serialize(settings),
    ...extra,
  });
}

describe("ACF_POST_STATUSES", () => {
  test("is the statuses ACF's definitions come in: published, and switched off", () => {
    expect([...ACF_POST_STATUSES]).toEqual(["publish", "acf-disabled"]);
  });
});

describe("loadAcf: the settings of post types and taxonomies", () => {
  test("labels keep only text that says something; the names fall back to the definition's title", () => {
    const pt = definition("acf-post-type", "Thing", {
      post_type: "thing",
      labels: {
        name: "Things",
        singular_name: "",
        all_items: "All Things",
        menu_name: 5,
        add_new: "",
      },
    });
    const tx = definition("acf-taxonomy", "Kind", { taxonomy: "kind", labels: "not a list" });
    const acf = loadAcf(modelOf([pt, tx]));
    expect(acf.postTypes.get("thing")!.labels).toEqual({ name: "Things", all_items: "All Things" });
    expect(acf.postTypes.get("thing")).toMatchObject({ singular: "Thing", plural: "Things" });
    expect(acf.taxonomies.get("kind")).toMatchObject({
      singular: "Kind",
      plural: "Kind",
      labels: {},
    });
  });

  test("a taxonomy's defaults when its settings were never saved, and what each setting says when they were", () => {
    const bare = definition("acf-taxonomy", "Bare", { taxonomy: "bare" });
    const off = definition("acf-taxonomy", "Off", {
      taxonomy: "off",
      public: 0,
      hierarchical: "1",
      object_type: ["a", "", "b"],
      rewrite: { permalink_rewrite: "no_permalink", slug: "ignored" },
    });
    const custom = definition("acf-taxonomy", "Custom", {
      taxonomy: "custom",
      public: "1",
      rewrite: {
        permalink_rewrite: "custom_permalink",
        slug: "areas",
        with_front: 0,
        rewrite_hierarchical: 1,
      },
    });
    const keyed = definition("acf-taxonomy", "Keyed", {
      taxonomy: "keyed",
      rewrite: { permalink_rewrite: "taxonomy_key", slug: "ignored", with_front: "1" },
    });
    const blank = definition("acf-taxonomy", "Blank", {
      taxonomy: "blankslug",
      rewrite: { permalink_rewrite: "custom_permalink", slug: "" },
    });
    const acf = loadAcf(modelOf([bare, off, custom, keyed, blank]));
    const of = (name: string) => acf.taxonomies.get(name)!;
    expect(of("bare")).toMatchObject({
      public: true,
      hierarchical: false,
      objectTypes: [],
      rewriteSlug: "bare",
      rewriteWithFront: true,
      rewriteHierarchical: false,
    });
    expect(of("off")).toMatchObject({
      public: false,
      hierarchical: true,
      objectTypes: ["a", "b"],
      rewriteSlug: false,
    });
    expect(of("custom")).toMatchObject({
      public: true,
      rewriteSlug: "areas",
      rewriteWithFront: false,
      rewriteHierarchical: true,
    });
    // A custom slug counts only when the select says so, and a custom choice with no slug is the name.
    expect(of("keyed")).toMatchObject({ rewriteSlug: "keyed", rewriteWithFront: true });
    expect(of("blankslug").rewriteSlug).toBe("blankslug");
  });

  test("a post type's archive: a slug of its own counts only while the archive is on", () => {
    const named = definition("acf-post-type", "Named", {
      post_type: "named",
      has_archive: 1,
      has_archive_slug: "all-named",
    });
    const plain = definition("acf-post-type", "Plain", {
      post_type: "plain",
      has_archive: "1",
      has_archive_slug: "",
    });
    const off = definition("acf-post-type", "Off", {
      post_type: "off",
      has_archive: 0,
      has_archive_slug: "ignored",
      hierarchical: "0",
      public: "0",
    });
    const on = definition("acf-post-type", "On", { post_type: "on", hierarchical: 1, public: "1" });
    const acf = loadAcf(modelOf([named, plain, off, on]));
    expect(acf.postTypes.get("named")!.hasArchive).toBe("all-named");
    expect(acf.postTypes.get("plain")!.hasArchive).toBe(true);
    expect(acf.postTypes.get("off")).toMatchObject({
      hasArchive: false,
      hierarchical: false,
      public: false,
    });
    expect(acf.postTypes.get("on")).toMatchObject({ hierarchical: true, public: true });
  });

  test("a post type's rewrite: the custom slug only when the select says so", () => {
    const keyed = definition("acf-post-type", "Keyed", {
      post_type: "keyed",
      rewrite: { permalink_rewrite: "post_type_key", slug: "ignored" },
    });
    const blank = definition("acf-post-type", "Blank", {
      post_type: "blankslug",
      rewrite: { permalink_rewrite: "custom_permalink", slug: "" },
    });
    const acf = loadAcf(modelOf([keyed, blank]));
    expect(acf.postTypes.get("keyed")!.rewriteSlug).toBe("keyed");
    expect(acf.postTypes.get("blankslug")!.rewriteSlug).toBe("blankslug");
  });
});

describe("loadAcf: definitions that appear twice, or are switched off", () => {
  for (const kind of ["acf-post-type", "acf-taxonomy"] as const) {
    const noun = kind === "acf-post-type" ? "post-type" : "taxonomy";
    const settings = (name: string): Record<string, unknown> =>
      kind === "acf-post-type" ? { post_type: name } : { taxonomy: name };
    const mk = (title: string, status: string, name = "thing"): WpPost =>
      definition(kind, title, settings(name), { status });
    const run = (...posts: WpPost[]): { kept: number | undefined; report: Report } => {
      const report = createReport();
      const acf = loadAcf(modelOf(posts), report);
      const map = kind === "acf-post-type" ? acf.postTypes : acf.taxonomies;
      return { kept: map.get("thing")?.postId, report };
    };
    const duplicates = (r: Report): [string | undefined, unknown][] =>
      codes(r, "acf.duplicate-definition").map((e) => [e.where, (e.data as { kept: number }).kept]);
    const inactive = (r: Report): [string | undefined, unknown][] =>
      codes(r, `acf.${noun}-inactive`).map((e) => [e.where, (e.data as { status: string }).status]);

    test(`${noun}: the first of two live definitions is kept and the second is reported with what was kept`, () => {
      const a = mk("1", "publish");
      const b = mk("2", "publish");
      const { kept, report } = run(a, b);
      expect(kept).toBe(a.id);
      expect(duplicates(report)).toEqual([[`post:${b.id}`, a.id]]);
      expect(inactive(report)).toEqual([]);
    });

    test(`${noun}: a live definition replaces a switched-off one, which then has nothing to report`, () => {
      const dead = mk("1", "acf-disabled");
      const live = mk("2", "publish");
      const { kept, report } = run(dead, live);
      expect(kept).toBe(live.id);
      expect(duplicates(report)).toEqual([]);
      expect(inactive(report)).toEqual([]);
    });

    test(`${noun}: of a live one and a switched-off one that follows it, the live one stays`, () => {
      const live = mk("1", "publish");
      const dead = mk("2", "acf-disabled");
      const { kept, report } = run(live, dead);
      expect(kept).toBe(live.id);
      expect(duplicates(report)).toEqual([[`post:${dead.id}`, live.id]]);
      expect(inactive(report)).toEqual([]);
    });

    test(`${noun}: two switched-off definitions keep the first, and the one that is kept is reported as off`, () => {
      const a = mk("1", "acf-disabled");
      const b = mk("2", "acf-disabled");
      const { kept, report } = run(a, b);
      expect(kept).toBe(a.id);
      expect(duplicates(report)).toEqual([[`post:${b.id}`, a.id]]);
      expect(inactive(report)).toEqual([[`post:${a.id}`, "acf-disabled"]]);
    });

    test(`${noun}: a switched-off definition that is the only one is kept, inactive, and reported with its status`, () => {
      const dead = mk("1", "acf-disabled");
      const { kept, report } = run(dead, mk("2", "publish", "other"));
      expect(kept).toBe(dead.id);
      expect(inactive(report)).toEqual([[`post:${dead.id}`, "acf-disabled"]]);
      expect(duplicates(report)).toEqual([]);
    });
  }
});

describe("loadAcf: the order ACF reads definitions in", () => {
  test("by menu order, then title ignoring case, then id, whatever order the posts came in", () => {
    const g = (title: string, menuOrder: number, id: number): WpPost[] =>
      group(title, loc("post_type", "page"), [field("text", `f${id}`)], { menuOrder, id });
    const defs = [
      ...g("Banana", 0, 9003),
      ...g("apple", 0, 9002),
      ...g("Cherry", 0, 9001),
      ...g("Zed", -1, 9004),
      // Six that tie on everything but their id, in an order that is partly rising and partly falling.
      ...g("tie", 0, 9010),
      ...g("tie", 0, 9011),
      ...g("tie", 0, 9012),
      ...g("Tie", 0, 9023),
      ...g("Tie", 0, 9022),
      ...g("Tie", 0, 9021),
    ];
    const acf = loadAcf(modelOf(defs));
    expect(acf.groups.map((x) => x.postId)).toEqual([
      9004, 9002, 9003, 9001, 9010, 9011, 9012, 9021, 9022, 9023,
    ]);
    // A group with a later menu order comes after a title that sorts earlier.
    const later = loadAcf(modelOf([...g("A", 2, 9101), ...g("B", 1, 9102)]));
    expect(later.groups.map((x) => x.title)).toEqual(["B", "A"]);
  });
});

describe("loadAcf: settings that are not a PHP array", () => {
  test("whatever else they hold, they are reported as malformed with the first 80 characters, and nothing throws", () => {
    const contents = [
      "N;",
      "b:0;",
      "i:5;",
      's:1:"x";',
      "",
      'a:1:{i:0;s:1:"x";}',
      `a:1:{i:0;s:200:"${"x".repeat(200)}";}`,
    ];
    const posts = contents.map((content, i) =>
      wpPost({ type: "acf-post-type", title: `T${i}`, slug: `post_type_t${i}`, content }),
    );
    const report = createReport();
    const acf = loadAcf(modelOf(posts), report);
    expect(acf.postTypes.size).toBe(0);
    const bad = codes(report, "acf.settings-malformed");
    expect(bad).toHaveLength(contents.length);
    expect(bad.map((e) => (e.data as { sample: string }).sample)).toEqual(
      contents.map((c) => c.slice(0, 80)),
    );
    expect((bad[6]!.data as { sample: string }).sample).toHaveLength(80);
  });
});

describe("loadAcf: a site that runs ACF is told when its definitions were not loaded", () => {
  const warned = (o: {
    options?: Record<string, string>;
    plugins?: string[];
    posts?: WpPost[];
  }): ReportEntry[] => {
    const model = modelOf(o.posts ?? [wpPost({ type: "page" })], {
      options: o.options ?? {},
      site: { activePlugins: o.plugins ?? [] },
    });
    const report = createReport();
    loadAcf(model, report);
    return codes(report, "acf.not-loaded");
  };

  test("by the option ACF writes, or by its plugin being active under any of its three names", () => {
    expect(warned({ options: { acf_version: "6.4.1" } })).toMatchObject([
      { severity: "warn", where: "option:acf_version" },
    ]);
    expect(warned({ plugins: ["secure-custom-fields/secure-custom-fields.php"] })).toHaveLength(1);
    expect(warned({ plugins: ["advanced-custom-fields/acf.php"] })).toHaveLength(1);
    expect(warned({ plugins: ["advanced-custom-fields-pro/acf.php"] })).toHaveLength(1);
  });

  test("not for a plugin that only has ACF in its name, nor for a site without ACF", () => {
    expect(warned({ plugins: ["my-advanced-custom-fields-addon/x.php"] })).toEqual([]);
    expect(warned({ plugins: ["advanced-custom-fields-extended/acf-extended.php"] })).toEqual([]);
    expect(warned({ plugins: ["secure-custom-fields-helper/x.php"] })).toEqual([]);
    expect(warned({})).toEqual([]);
  });

  test("not when any one kind of definition is in the model", () => {
    for (const type of ACF_POST_TYPES) {
      const posts = [wpPost({ type, title: "x", slug: "x", content: "a:0:{}" })];
      expect(warned({ options: { acf_version: "1" }, posts })).toEqual([]);
    }
    const defs = group("G", loc("post_type", "page"), [field("text", "x")]);
    expect(warned({ options: { acf_version: "6.4.1" }, posts: defs })).toEqual([]);
  });
});

// ── Fields, setting by setting ───────────────────────────────────────────────────────────────────

describe("loadAcf: what a field's settings say", () => {
  const setting = (name: string, value: unknown): AcfField =>
    fieldOf("text", "f", { [name]: value });

  test("a setting is true or false as PHP's (bool) has it", () => {
    for (const yes of [1, "1", "yes", "0.0", true, [1], { a: 1 }, 0.5]) {
      expect(setting("required", yes).required).toBe(true);
    }
    for (const no of [0, "0", "", false, null, [], 0.0]) {
      expect(setting("required", no).required).toBe(false);
    }
  });

  test("text, numbers and a big integer in a setting read as PHP would hand them over", () => {
    expect(setting("instructions", 5).instructions).toBe("5");
    expect(setting("instructions", 0).instructions).toBe("0");
    expect(setting("instructions", true).instructions).toBe("1");
    expect(setting("instructions", false).instructions).toBe("");
    expect(setting("instructions", [1]).instructions).toBe("");
    expect(setting("instructions", "Say it").instructions).toBe("Say it");
    // A bound that is text, empty or not a number is no bound.
    expect(fieldOf("number", "f", { min: "3.5", max: " 9 " })).toMatchObject({ min: 3.5, max: 9 });
    expect(fieldOf("number", "f", { min: "", max: "ten" }).max).toBeUndefined();
    expect(fieldOf("number", "f", { min: "", max: "ten" }).min).toBeUndefined();
    // Past 2^53 an integer stays exact as a bigint in the parsed settings; it is still true, text and a number.
    const content =
      'a:4:{s:4:"type";s:4:"text";s:8:"required";i:99999999999999999999;s:12:"instructions";i:99999999999999999999;s:3:"min";i:99999999999999999999;}';
    const defs = group("G", loc("post_type", "page"), [field("text", "big", {}, [], { content })]);
    const big = loadAcf(modelOf(defs)).groups[0]!.fields[0]!;
    expect(big.required).toBe(true);
    expect(big.instructions).toBe("99999999999999999999");
    expect(big.min).toBe(1e20);
  });

  test("conditional logic: groups with no rule left are dropped, and rule values are text", () => {
    const field_ = setting("conditional_logic", [
      [1, "x"],
      [
        { field: "field_a", operator: "!=", value: 5 },
        { field: "field_b", operator: "==", value: "y" },
      ],
      [],
    ]);
    expect(field_.conditionalLogic).toEqual([
      [
        { field: "field_a", operator: "!=", value: "5" },
        { field: "field_b", operator: "==", value: "y" },
      ],
    ]);
    for (const none of [0, "0", "", false, null, []])
      expect(setting("conditional_logic", none).conditionalLogic).toEqual([]);
  });

  test("a type that is not given is a text field, and a name that is not given is none", () => {
    const defs = group("G", loc("post_type", "page"), [
      field("text", "x", {}, [], { content: serialize({ label: "no type" }), excerpt: "" }),
    ]);
    expect(loadAcf(modelOf(defs)).groups[0]!.fields[0]).toMatchObject({ type: "text", name: "" });
  });

  test("choices exist for the types that choose, and for no other", () => {
    expect(fieldOf("text", "f", { choices: { a: "A" } }).choices).toEqual([]);
    for (const type of ["select", "radio", "button_group", "checkbox"]) {
      expect(fieldOf(type, "f", { choices: { a: "A" } }).choices).toEqual([
        { value: "a", label: "A" },
      ]);
    }
  });

  test("which types hold a list: by type, by `multiple`, by the taxonomy field's way of choosing", () => {
    const multiple = (type: string, settings: Record<string, unknown> = {}): boolean =>
      fieldOf(type, "f", settings).multiple;
    for (const type of ["checkbox", "gallery", "relationship"]) expect(multiple(type)).toBe(true);
    for (const type of ["select", "post_object", "page_link", "user"]) {
      expect(multiple(type)).toBe(false);
      expect(multiple(type, { multiple: 0 })).toBe(false);
      expect(multiple(type, { multiple: 1 })).toBe(true);
    }
    expect(multiple("taxonomy", { field_type: "checkbox" })).toBe(true);
    expect(multiple("taxonomy", { field_type: "multi_select" })).toBe(true);
    expect(multiple("taxonomy")).toBe(true);
    expect(multiple("taxonomy", { field_type: "radio" })).toBe(false);
    expect(multiple("taxonomy", { field_type: "select" })).toBe(false);
    for (const type of ["text", "image", "repeater", "link", "radio", "button_group", "true_false"])
      expect(multiple(type, { multiple: 1 })).toBe(false);
  });

  test("a flexible content field's layouts: label, display, limits, and the fields each holds", () => {
    const layouts = {
      layout_a: {
        key: "layout_a",
        name: "hero",
        label: "Hero",
        display: "table",
        min: "1",
        max: 3,
      },
      layout_b: {
        key: "layout_b",
        name: "quote",
        label: "Quote",
        display: "",
        min: "",
        max: "none",
      },
    };
    const defs = group("G", loc("post_type", "page"), [
      field("flexible_content", "blocks", { layouts }, [
        field("text", "heading", { parent_layout: "layout_a" }),
        field("text", "words", { parent_layout: "layout_b" }),
        field("text", "also_words", { parent_layout: "layout_b" }),
      ]),
    ]);
    const blocks = loadAcf(modelOf(defs)).groups[0]!.fields[0]!;
    expect(
      blocks.layouts.map((l) => ({ ...l, subFields: l.subFields.map((f) => f.name) })),
    ).toStrictEqual([
      {
        key: "layout_a",
        name: "hero",
        label: "Hero",
        display: "table",
        min: 1,
        max: 3,
        subFields: ["heading"],
      },
      {
        key: "layout_b",
        name: "quote",
        label: "Quote",
        display: "block",
        subFields: ["words", "also_words"],
      },
    ]);
    expect(blocks.subFields).toEqual([]);
  });

  test("a sub-field of a flexible content field that names no layout belongs to the first; one that names a missing layout is ignored", () => {
    const flexible = field(
      "flexible_content",
      "blocks",
      {
        layouts: [
          { key: "l1", name: "one", label: "One" },
          { key: "l2", name: "two", label: "Two" },
        ],
      },
      [
        field("text", "plain"),
        field("text", "named", { parent_layout: "l2" }),
        field("text", "stray", { parent_layout: "l9" }),
      ],
    );
    const report = createReport();
    const acf = loadAcf(modelOf(group("G", loc("post_type", "page"), [flexible])), report);
    const [one, two] = acf.groups[0]!.fields[0]!.layouts;
    expect(one!.subFields.map((f) => f.name)).toEqual(["plain"]);
    expect(two!.subFields.map((f) => f.name)).toEqual(["named"]);
    expect(codes(report, "acf.subfield-ignored")).toHaveLength(1);
    expect(codes(report, "acf.subfield-ignored")[0]!.message).toContain('"stray"');
  });

  test("a field that holds no sub-fields says nothing when it has none, and names each leftover when it has", () => {
    const report = createReport();
    const defs = group("G", loc("post_type", "page"), [
      field("text", "clean"),
      field("gallery", "pics", {}, [field("image", "left_over"), field("text", "left_over_too")]),
    ]);
    loadAcf(modelOf(defs), report);
    const ignored = codes(report, "acf.subfield-ignored");
    expect(ignored).toHaveLength(2);
    expect(ignored.map((e) => e.severity)).toEqual(["info", "info"]);
    expect(ignored[0]!.message).toContain('image field "left_over"');
    expect(ignored[0]!.message).toContain("pics");
  });

  test("a clone's settings: what it copies, how it shows, whether it prefixes", () => {
    const base = group("Base", loc("post_type", "none"), [field("text", "street")]);
    const host = group("Host", loc("post_type", "page"), [
      field("clone", "a", {
        clone: [base[0]!.slug, "field_street"],
        display: "group",
        prefix_name: 1,
        prefix_label: 1,
      }),
      field("clone", "b", { clone: "", display: "something else" }),
    ]);
    const [a, b] = loadAcf(modelOf([...base, ...host])).groups.find(
      (g) => g.title === "Host",
    )!.fields;
    expect(a!.clone).toEqual({
      selectors: [base[0]!.slug, "field_street"],
      display: "group",
      prefixName: true,
      prefixLabel: true,
    });
    expect(b!.clone).toEqual({
      selectors: [],
      display: "seamless",
      prefixName: false,
      prefixLabel: false,
    });
    expect(fieldOf("text", "plain").clone).toBeUndefined();
  });

  test("return format, a default and the settings as stored", () => {
    const f = fieldOf("select", "f", {
      return_format: "label",
      default_value: "x",
      choices: { x: "X" },
      odd: [1],
    });
    expect(f.returnFormat).toBe("label");
    expect(f.default).toBe("x");
    expect(f.settings).toMatchObject({ odd: [1], return_format: "label" });
    expect(fieldOf("select", "f", { return_format: "" }).returnFormat).toBeUndefined();
    expect("returnFormat" in fieldOf("text", "f")).toBe(false);
    expect("default" in fieldOf("text", "f")).toBe(false);
    expect("default" in fieldOf("text", "f", { default_value: false })).toBe(true);
  });
});

describe("loadAcf: clones that copy clones", () => {
  const base = group("Base", loc("post_type", "none"), [
    field("text", "street"),
    field("text", "city"),
  ]);
  const baseKey = base[0]!.slug;

  test("a clone of a group that holds a clone is followed all the way down", () => {
    const mid = group("Mid", loc("post_type", "none"), [
      field("clone", "addr", { clone: [baseKey], display: "seamless", prefix_name: 1 }),
      field("text", "label"),
    ]);
    const host = group("Host", loc("post_type", "page"), [
      field("clone", "box", { clone: [mid[0]!.slug], display: "group", prefix_name: 1 }),
    ]);
    const page = wpPost({ type: "page" });
    const model = modelOf([...base, ...mid, ...host, page], {
      meta: {
        [page.id]: { box_addr_street: ["1 Main"], box_addr_city: ["Town"], box_label: ["Home"] },
      },
    });
    const report = createReport();
    const acf = loadAcf(model, report);
    expect(toEntryData(acfValues(model, acf, postTarget(model, page)), noHooks)).toEqual({
      box: { addr_street: "1 Main", addr_city: "Town", label: "Home" },
    });
    expect(report.entries().filter((e) => e.severity !== "info")).toEqual([]);
  });

  test("a clone that two other clones copy is resolved once: its report is filed once", () => {
    const first = group("First", loc("post_type", "none"), [
      field("clone", "ghost", { clone: ["group_nope"], display: "seamless" }),
    ]);
    const second = group("Second", loc("post_type", "page"), [
      field("clone", "all_first", { clone: [first[0]!.slug], display: "seamless" }),
    ]);
    const third = group("Third", loc("post_type", "page"), [
      field("clone", "again", { clone: [first[0]!.slug], display: "seamless" }),
    ]);
    const report = createReport();
    loadAcf(modelOf([...first, ...second, ...third]), report);
    expect(codes(report, "acf.clone-missing")).toHaveLength(1);
    expect(codes(report, "acf.clone-cycle")).toEqual([]);
  });

  test("two groups that clone each other are cut where they meet, once, and both still read", () => {
    const a = group("Ay", loc("post_type", "page"), [field("text", "a1")]);
    const b = group("Bee", loc("post_type", "none"), [field("text", "b1")]);
    // Each clones the other: the fields are added after both groups exist, so the keys are known.
    const aClone = field("clone", "from_b", { clone: [b[0]!.slug], display: "seamless" })(
      a[0]!.id,
      1,
    );
    const bClone = field("clone", "from_a", { clone: [a[0]!.slug], display: "seamless" })(
      b[0]!.id,
      1,
    );
    const page = wpPost({ type: "page" });
    const model = modelOf([...a, ...aClone, ...b, ...bClone, page], {
      meta: { [page.id]: { a1: ["x"], b1: ["y"] } },
    });
    const report = createReport();
    const acf = loadAcf(model, report);
    expect(codes(report, "acf.clone-cycle")).toHaveLength(1);
    expect(toEntryData(acfValues(model, acf, postTarget(model, page)), noHooks)).toEqual({
      a1: "x",
      b1: "y",
    });
  });

  test("a field that is cloned is reported once for what it is, not once per copy", () => {
    const odd = group("Odd", loc("post_type", "none"), [field("acfe_thing", "thing")]);
    const one = group("One", loc("post_type", "page"), [
      field("clone", "c1", { clone: [odd[0]!.slug], display: "seamless" }),
    ]);
    const two = group("Two", loc("post_type", "page"), [
      field("clone", "c2", { clone: [odd[0]!.slug], display: "group" }),
    ]);
    const report = createReport();
    loadAcf(modelOf([...odd, ...one, ...two]), report);
    expect(codes(report, "acf.field-unsupported")).toHaveLength(1);
  });
});

describe("loadAcf: options pages", () => {
  test("a page the definitions or a rule name once, never `all`, never nothing", () => {
    const rules = (...values: string[]): unknown =>
      values.map((value) => [{ param: "options_page", operator: "==", value }]);
    const defs = [
      ...group("One", rules("code-only", "all", "", "code-only"), [field("text", "a")]),
      ...group("Two", rules("code-only", "other-code"), [field("text", "b")]),
      wpPost({
        type: "acf-ui-options-page",
        title: "Titled",
        slug: "ui_options_page_t",
        content: serialize({ menu_slug: "titled" }),
      }),
      wpPost({
        type: "acf-ui-options-page",
        title: "Known",
        slug: "ui_options_page_k",
        content: serialize({ menu_slug: "known", page_title: "Known Page" }),
      }),
      ...group("Three", rules("known"), [field("text", "c")]),
    ];
    const acf = loadAcf(modelOf(defs));
    expect(acf.optionsPages.map((p) => [p.slug, p.title, p.source])).toEqual([
      ["known", "Known Page", "ui"],
      ["titled", "Titled", "ui"],
      ["code-only", "code-only", "location"],
      ["other-code", "other-code", "location"],
    ]);
  });

  test("a page the definitions mention is read with its own prefix, and any other with `options`", () => {
    const defs = [
      wpPost({
        type: "acf-ui-options-page",
        title: "Site",
        slug: "ui_options_page_s",
        content: serialize({ menu_slug: "site", post_id: "site" }),
      }),
      ...group(
        "Any",
        [[{ param: "options_page", operator: "==", value: "all" }]],
        [field("text", "tagline")],
      ),
    ];
    const model = modelOf(defs, {
      options: {
        site_tagline: "From site",
        options_tagline: "From options",
        other_tagline: "Other",
      },
    });
    const acf = loadAcf(model);
    expect(acfValues(model, acf, { kind: "options", page: "site" }).tagline).toMatchObject({
      value: "From site",
    });
    // A page nothing defines (it exists only in code) falls back to the prefix ACF's own default has.
    expect(acfValues(model, acf, { kind: "options", page: "unlisted" }).tagline).toMatchObject({
      value: "From options",
    });
  });
});

// ── Location rules, parameter by parameter ───────────────────────────────────────────────────────

/** One active group with the given rules in a model, and what applies to `target` (with the report). */
function locate(
  rules: unknown,
  target: AcfTarget,
): { applied: boolean; report: Report; acf: AcfModel; group: WpPost } {
  const defs = group("Only", rules, [field("text", "x")]);
  const report = createReport();
  const acf = loadAcf(modelOf(defs), report);
  return { applied: groupsFor(acf, target).length === 1, report, acf, group: defs[0]! };
}

const page = (
  extra: Partial<Extract<AcfTarget, { kind: "post" }>> = {},
): Extract<AcfTarget, { kind: "post" }> => ({
  kind: "post",
  postType: "page",
  postId: 7,
  template: "default",
  status: "publish",
  format: "",
  parent: 0,
  terms: [],
  frontPage: false,
  postsPage: false,
  hasChildren: false,
  ...extra,
});

describe("groupsFor: a rule is false, whatever its operator, on a target that has no such thing", () => {
  const postOnly: [string, string][] = [
    ["post_type", "page"],
    ["post", "7"],
    ["page", "7"],
    ["page_template", "default"],
    ["post_template", "default"],
    ["post_status", "publish"],
    ["post_format", "standard"],
    ["post_category", "category:news"],
    ["post_taxonomy", "post_tag:news"],
    ["page_type", "front_page"],
    ["page_parent", "0"],
    ["attachment", "image"],
  ];
  const termOnly: [string, string][] = [
    ["taxonomy", "category"],
    ["term", "category:news"],
  ];
  const term: AcfTarget = { kind: "term", taxonomy: "category", termId: 5, slug: "news" };
  const options: AcfTarget = { kind: "options", page: "site" };

  for (const operator of ["==", "!="]) {
    test(`rules on a post are false on a term or an options page (${operator})`, () => {
      for (const [param, value] of postOnly) {
        for (const target of [term, options]) {
          expect(locate(loc(param, value, operator), target).applied).toBe(false);
        }
      }
    });

    test(`rules on a term are false on a post or an options page (${operator})`, () => {
      for (const [param, value] of termOnly) {
        for (const target of [page(), options])
          expect(locate(loc(param, value, operator), target).applied).toBe(false);
      }
      for (const target of [page(), term])
        expect(locate(loc("options_page", "site", operator), target).applied).toBe(false);
    });
  }
});

describe("groupsFor: a rule the target cannot answer", () => {
  const withId: AcfTarget = { kind: "post", postType: "page", postId: 5 };
  const withoutId: AcfTarget = { kind: "post", postType: "page" };
  const askedAboutAPost: [string, string][] = [
    ["page_template", "tpl.php"],
    ["post_template", "tpl.php"],
    ["post_status", "publish"],
    ["post_format", "aside"],
    ["post_category", "category:news"],
    ["post_taxonomy", "post_tag:news"],
    ["page_type", "front_page"],
    ["page_type", "posts_page"],
    ["page_type", "top_level"],
    ["page_type", "child"],
    ["page_type", "parent"],
    ["page_parent", "3"],
  ];

  test("a target with a post id that lacks the answer is reported, once per rule, and does not match", () => {
    for (const [param, value] of askedAboutAPost) {
      for (const operator of ["==", "!="]) {
        const { applied, report, acf, group: g } = locate(loc(param, value, operator), withId);
        expect(applied).toBe(false);
        groupsFor(acf, withId);
        const entries = codes(report, "acf.location-unevaluable");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          severity: "warn",
          where: `post:${g.id}`,
          data: { param, value },
        });
        // The message says which target it could not read.
        expect(entries[0]!.message).toContain("post:5");
        expect(entries[0]!.message).toContain("Only");
      }
    }
  });

  test("a target with no post id has no post to ask, so the rule is false and nothing is said", () => {
    for (const [param, value] of askedAboutAPost) {
      if (param === "page_template" || param === "post_template") continue;
      const { applied, report } = locate(loc(param, value), withoutId);
      expect(applied).toBe(false);
      expect(codes(report, "acf.location-unevaluable")).toEqual([]);
    }
    // A page with no template given is on the default template, which is an answer.
    for (const param of ["page_template", "post_template"]) {
      expect(locate(loc(param, "default"), withoutId).applied).toBe(true);
      const tpl = locate(loc(param, "tpl.php"), withoutId);
      expect(tpl.applied).toBe(false);
      expect(codes(tpl.report, "acf.location-unevaluable")).toEqual([]);
    }
  });

  test("the same rule with a different value is its own report", () => {
    const defs = group(
      "Two",
      [
        [{ param: "post_status", operator: "==", value: "publish" }],
        [{ param: "post_status", operator: "==", value: "draft" }],
      ],
      [field("text", "x")],
    );
    const report = createReport();
    const acf = loadAcf(modelOf(defs), report);
    groupsFor(acf, withId);
    groupsFor(acf, withId);
    expect(
      codes(report, "acf.location-unevaluable").map((e) => (e.data as { value: string }).value),
    ).toEqual(["publish", "draft"]);
  });

  test("an attachment whose mime type is not given is unevaluable, with or without an id", () => {
    // The message names the post when there is one, and the post type when there is not.
    for (const [target, named] of [
      [{ kind: "post", postType: "attachment", postId: 5 }, "post:5"],
      [{ kind: "post", postType: "attachment" }, "post:attachment"],
    ] as [AcfTarget, string][]) {
      const { applied, report } = locate(loc("attachment", "image"), target);
      expect(applied).toBe(false);
      expect(codes(report, "acf.location-unevaluable")).toHaveLength(1);
      expect(codes(report, "acf.location-unevaluable")[0]!.message).toContain(named);
    }
    // Not an attachment at all: there is no mime type to ask for.
    const other = locate(loc("attachment", "image"), withId);
    expect(other.applied).toBe(false);
    expect(codes(other.report, "acf.location-unevaluable")).toEqual([]);
  });

  test("a term rule needs what it names in the target, and says which target lacked it", () => {
    const byId = locate(loc("term", "12"), { kind: "term", taxonomy: "category" });
    expect(byId.applied).toBe(false);
    expect(codes(byId.report, "acf.location-unevaluable")[0]!.message).toContain("term:category");
    const bySlug = locate(loc("term", "category:news"), {
      kind: "term",
      taxonomy: "category",
      termId: 12,
    });
    expect(bySlug.applied).toBe(false);
    expect(codes(bySlug.report, "acf.location-unevaluable")[0]!.message).toContain("term:12");
    // A bare slug, and a slug in a taxonomy.
    expect(
      locate(loc("term", "news"), { kind: "term", taxonomy: "category", slug: "news" }).applied,
    ).toBe(true);
    expect(
      locate(loc("term", "news"), { kind: "term", taxonomy: "category", slug: "other" }).applied,
    ).toBe(false);
    expect(
      locate(loc("term", "news", "!="), { kind: "term", taxonomy: "category", slug: "other" })
        .applied,
    ).toBe(true);
  });

  test("rules are tried in order and stop at the first that fails: a later rule is not evaluated", () => {
    const failsFirst = locate(
      [
        [
          { param: "post_type", operator: "==", value: "project" },
          { param: "page_template", operator: "==", value: "tpl.php" },
        ],
      ],
      withId,
    );
    expect(failsFirst.applied).toBe(false);
    expect(codes(failsFirst.report, "acf.location-unevaluable")).toEqual([]);
    const unevaluableFirst = locate(
      [
        [
          { param: "page_template", operator: "==", value: "tpl.php" },
          { param: "post_type", operator: "==", value: "project" },
        ],
      ],
      withId,
    );
    expect(unevaluableFirst.applied).toBe(false);
    expect(codes(unevaluableFirst.report, "acf.location-unevaluable")).toHaveLength(1);
  });

  test("a group that two rule groups both match applies once", () => {
    const { acf } = locate(
      [
        [{ param: "post_type", operator: "==", value: "page" }],
        [{ param: "post_type", operator: "==", value: "page" }],
      ],
      page(),
    );
    expect(groupsFor(acf, page())).toHaveLength(1);
  });

  test("a group none of whose rule groups match is left out, and the later groups are still tried", () => {
    const defs = [
      ...group("No", loc("post_type", "project"), [field("text", "a")], { menuOrder: 0 }),
      ...group(
        "Yes",
        [
          [{ param: "post_type", operator: "==", value: "project" }],
          [{ param: "post_type", operator: "==", value: "page" }],
        ],
        [field("text", "b")],
        { menuOrder: 1 },
      ),
      ...group("Also", loc("post_type", "page"), [field("text", "c")], { menuOrder: 2 }),
    ];
    expect(groupsFor(loadAcf(modelOf(defs)), page()).map((g) => g.title)).toEqual(["Yes", "Also"]);
  });
});

describe("groupsFor: the values the rules compare, and how PHP's == compares them", () => {
  test("numbers compare as numbers: a post, a page, a parent", () => {
    expect(locate(loc("post", "07"), page({ postId: 7 })).applied).toBe(true);
    expect(locate(loc("post", "7.0"), page({ postId: 7 })).applied).toBe(true);
    expect(locate(loc("post", "1e1"), page({ postId: 10 })).applied).toBe(true);
    expect(locate(loc("page_parent", "03"), page({ parent: 3 })).applied).toBe(true);
    expect(locate(loc("page_parent", "3"), page({ parent: 4 })).applied).toBe(false);
    expect(locate(loc("post", "seven"), page({ postId: 7 })).applied).toBe(false);
    expect(locate(loc("post", ""), page({ postId: 0 })).applied).toBe(false);
    expect(locate(loc("page_parent", "0"), page({ parent: 0 })).applied).toBe(true);
  });

  test("text compares as text: exactly, and numeric strings by value", () => {
    expect(locate(loc("post_type", "Page"), page()).applied).toBe(false);
    expect(locate(loc("post_type", "page"), page({ postType: "page" })).applied).toBe(true);
    expect(locate(loc("post_type", "page2"), page({ postType: "page" })).applied).toBe(false);
    expect(locate(loc("post_type", "page", "!="), page({ postType: "page2" })).applied).toBe(true);
    expect(locate(loc("post_status", "Publish"), page()).applied).toBe(false);
    // Two numeric strings are numbers, as in PHP: a post type called "10" is the one called "1e1".
    expect(locate(loc("post_type", "1e1"), page({ postType: "10" })).applied).toBe(true);
    expect(locate(loc("post_type", "10"), page({ postType: "10.0" })).applied).toBe(true);
    // A numeric string is not equal to a word, nor to an empty one.
    expect(locate(loc("post_type", "0"), page({ postType: "" })).applied).toBe(false);
    expect(locate(loc("post_type", "0"), page({ postType: "abc" })).applied).toBe(false);
  });

  test("a term in a rule is `taxonomy:slug` or an id; the colon must follow a name", () => {
    const filed = (...terms: { termId: number; taxonomy: string; slug: string }[]): AcfTarget =>
      page({ postType: "post", terms });
    expect(
      locate(loc("post_taxonomy", "t:news"), filed({ termId: 5, taxonomy: "t", slug: "news" }))
        .applied,
    ).toBe(true);
    expect(
      locate(loc("post_taxonomy", "t:news"), filed({ termId: 5, taxonomy: "u", slug: "news" }))
        .applied,
    ).toBe(false);
    expect(
      locate(loc("post_taxonomy", ":news"), filed({ termId: 5, taxonomy: "t", slug: "news" }))
        .applied,
    ).toBe(false);
    expect(
      locate(loc("post_taxonomy", "news"), filed({ termId: 5, taxonomy: "t", slug: "news" }))
        .applied,
    ).toBe(true);
    expect(
      locate(loc("post_taxonomy", "5"), filed({ termId: 5, taxonomy: "t", slug: "news" })).applied,
    ).toBe(true);
    expect(
      locate(loc("post_taxonomy", "5", "!="), filed({ termId: 5, taxonomy: "t", slug: "news" }))
        .applied,
    ).toBe(false);
    // A post with none is in the default category, by name only.
    expect(locate(loc("post_category", "category:uncategorized"), filed()).applied).toBe(true);
    expect(locate(loc("post_category", "category:news"), filed()).applied).toBe(false);
    expect(locate(loc("post_category", "category:news", "!="), filed()).applied).toBe(true);
    expect(locate(loc("post_taxonomy", "post_tag:uncategorized"), filed()).applied).toBe(false);
  });
});

describe("groupsFor: templates, status, format and the page types", () => {
  test("a template rule on a type that has no templates is false, however the rule is worded", () => {
    const project = (template: string | undefined): AcfTarget =>
      page({ postType: "project", ...(template === undefined ? {} : { template }) });
    // The default template is a page's; another type has none to name until it carries a template of its own.
    expect(locate(loc("post_template", "default"), project("default")).applied).toBe(false);
    expect(locate(loc("post_template", "default", "!="), project("default")).applied).toBe(false);
    expect(locate(loc("post_template", "default"), project("")).applied).toBe(false);
    expect(locate(loc("page_template", "default", "!="), project("default")).applied).toBe(false);
    expect(
      locate(loc("post_template", "tpl.php"), { kind: "post", postType: "project" }).applied,
    ).toBe(false);
    // Once it carries one, the rule is about that: `!= default` is about the carrying type, not a page.
    expect(locate(loc("post_template", "tpl.php"), project("tpl.php")).applied).toBe(true);
    expect(locate(loc("post_template", "other.php", "!="), project("tpl.php")).applied).toBe(true);
    expect(locate(loc("post_template", "default", "!="), project("tpl.php")).applied).toBe(true);
    expect(locate(loc("page_template", "tpl.php"), project("tpl.php")).applied).toBe(true);
    // `page_template == default` on a type other than a page is never what a person meant.
    expect(locate(loc("page_template", "default"), project("tpl.php")).applied).toBe(false);
    expect(locate(loc("page_template", "default", "!="), project("tpl.php")).applied).toBe(false);
  });

  test("a page with no template stored (the empty string) is on `default`", () => {
    expect(locate(loc("page_template", "default"), page({ template: "" })).applied).toBe(true);
    expect(locate(loc("page_template", "tpl.php", "!="), page({ template: "" })).applied).toBe(
      true,
    );
  });

  test("post status: auto-draft is a draft, and nothing else is changed", () => {
    expect(locate(loc("post_status", "auto-draft"), page({ status: "auto-draft" })).applied).toBe(
      false,
    );
    expect(locate(loc("post_status", "draft", "!="), page({ status: "auto-draft" })).applied).toBe(
      false,
    );
    expect(locate(loc("post_status", "private"), page({ status: "private" })).applied).toBe(true);
  });

  test("post format: the format the post has, `standard` for a post with none, nothing for another type", () => {
    expect(locate(loc("post_format", "aside", "!="), page({ format: "aside" })).applied).toBe(
      false,
    );
    expect(locate(loc("post_format", "aside", "!="), page({ format: "gallery" })).applied).toBe(
      true,
    );
    expect(
      locate(loc("post_format", "standard"), page({ postType: "post", format: "standard" }))
        .applied,
    ).toBe(true);
  });

  test("page types: each one against the facts it needs, and not against the others", () => {
    // The posts page may itself be a child; the front page may have children.
    expect(
      locate(loc("page_type", "posts_page"), page({ postsPage: true, parent: 3 })).applied,
    ).toBe(true);
    expect(
      locate(loc("page_type", "posts_page", "!="), page({ postsPage: true, parent: 3 })).applied,
    ).toBe(false);
    expect(
      locate(loc("page_type", "posts_page"), page({ postsPage: false, parent: 0 })).applied,
    ).toBe(false);
    expect(
      locate(loc("page_type", "front_page"), page({ frontPage: true, postsPage: false, parent: 3 }))
        .applied,
    ).toBe(true);
    expect(
      locate(
        loc("page_type", "front_page"),
        page({ frontPage: false, postsPage: true, hasChildren: true }),
      ).applied,
    ).toBe(false);
    expect(locate(loc("page_type", "top_level"), page({ parent: 1 })).applied).toBe(false);
    expect(locate(loc("page_type", "top_level", "!="), page({ parent: 1 })).applied).toBe(true);
    expect(locate(loc("page_type", "child"), page({ parent: 1 })).applied).toBe(true);
    expect(locate(loc("page_type", "child"), page({ parent: 0 })).applied).toBe(false);
    expect(locate(loc("page_type", "parent"), page({ hasChildren: true, parent: 0 })).applied).toBe(
      true,
    );
    expect(locate(loc("page_type", "parent", "!="), page({ hasChildren: true })).applied).toBe(
      false,
    );
    // Whatever the value, an operator that is not == or != matches nothing.
    expect(locate(loc("page_type", "front_page", ">"), page({ frontPage: true })).applied).toBe(
      false,
    );
  });

  test("an attachment's kind or mime type", () => {
    const media = (mime: string): AcfTarget => page({ postType: "attachment", mime });
    expect(locate(loc("attachment", "image"), media("image/png")).applied).toBe(true);
    expect(locate(loc("attachment", "image", "!="), media("image/png")).applied).toBe(false);
    expect(locate(loc("attachment", "image", "!="), media("video/mp4")).applied).toBe(true);
    expect(locate(loc("attachment", "image/png"), media("image/png")).applied).toBe(true);
    expect(locate(loc("attachment", "image/png", "!="), media("image/png")).applied).toBe(false);
    expect(locate(loc("attachment", "image/jpeg", "!="), media("image/png")).applied).toBe(true);
    expect(locate(loc("attachment", "all"), media("application/pdf")).applied).toBe(true);
  });
});

describe("groupsFor: parameters, as the report on loading says them", () => {
  const evaluated = [
    "post_type",
    "post",
    "page",
    "page_template",
    "post_template",
    "post_status",
    "post_format",
    "post_category",
    "post_taxonomy",
    "page_type",
    "page_parent",
    "attachment",
    "taxonomy",
    "term",
    "options_page",
  ];

  test("every parameter that is evaluated is said nothing about", () => {
    const defs = group(
      "All of them",
      evaluated.map((param) => [{ param, operator: "==", value: "x" }]),
      [field("text", "x")],
    );
    const report = createReport();
    loadAcf(modelOf(defs), report);
    expect(report.entries().filter((e) => e.code.startsWith("acf.location"))).toEqual([]);
  });

  test("the screens of other objects are told once each, with what they are, and apply to no post or term", () => {
    const objects: [string, string][] = [
      ["user_form", "users"],
      ["user_role", "users"],
      ["comment", "comments"],
      ["nav_menu", "menus"],
      ["nav_menu_item", "menu items"],
      ["widget", "widgets"],
      ["block", "blocks"],
    ];
    for (const [param, object] of objects) {
      const rules = [
        [{ param, operator: "==", value: "x" }],
        [{ param, operator: "!=", value: "y" }],
      ];
      const { report, acf } = locate(rules, page());
      const entries = codes(report, "acf.location-other-object");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ severity: "info", data: { objects: object } });
      expect(entries[0]!.message).toContain(object);
      expect(codes(report, "acf.location-unsupported")).toEqual([]);
      for (const target of [
        page(),
        { kind: "term", taxonomy: "category", termId: 1, slug: "a" },
        { kind: "options", page: "p" },
      ] as AcfTarget[]) {
        expect(groupsFor(acf, target)).toEqual([]);
      }
    }
  });

  test("a rule about the viewer is a warning of its own, and a parameter nobody knows is another", () => {
    for (const param of ["current_user", "current_user_role"]) {
      const { report, group: g } = locate(loc(param, "administrator"), page());
      const entries = codes(report, "acf.location-unsupported");
      expect(entries).toMatchObject([{ severity: "warn", where: `post:${g.id}`, data: { param } }]);
      expect(entries[0]!.message).toContain("who is looking at the screen");
      expect(codes(report, "acf.location-other-object")).toEqual([]);
    }
    const unknown = locate(loc("acfe_whatever", "x"), page());
    const entries = codes(unknown.report, "acf.location-unsupported");
    expect(entries).toMatchObject([{ severity: "warn", data: { param: "acfe_whatever" } }]);
    expect(entries[0]!.message).toContain("cannot evaluate");
    expect(unknown.applied).toBe(false);
  });

  test("an operator ACF does not have is told with the rule, for an evaluated parameter too", () => {
    const { report, applied } = locate(
      [[{ param: "post_type", operator: ">", value: "page" }]],
      page(),
    );
    expect(applied).toBe(false);
    expect(codes(report, "acf.location-unsupported")).toMatchObject([
      { severity: "warn", data: { rule: "post_type > page" } },
    ]);
    expect(codes(report, "acf.location-unsupported")[0]!.message).toContain("operator");
    // `==` and `!=` are the operators; a rule with none is `==`.
    expect(locate([[{ param: "post_type", value: "page" }]], page()).applied).toBe(true);
  });

  test("a rule's value and operator are text, and a rule that is not a map is ignored", () => {
    const { acf } = locate(
      [
        [{ param: "post", operator: "==", value: 7 }, "junk", 5],
        "not a rule group",
        [],
        [["nested"]],
      ],
      page({ postId: 7 }),
    );
    expect(acf.groups[0]!.location).toEqual([[{ param: "post", operator: "==", value: "7" }]]);
  });
});

// ── What a post says about itself ────────────────────────────────────────────────────────────────

describe("postTarget: the facts a location rule can ask for", () => {
  const term = (termId: number, taxonomy: string, slug: string): WpTerm => ({
    termId,
    taxonomyId: termId,
    taxonomy,
    slug,
    name: slug,
    description: "",
    parent: 0,
    count: 1,
    meta: {},
  });

  test("a post with no format is `standard`; any other type has none", () => {
    const post = wpPost({ type: "post" });
    const other = wpPost({ type: "project" });
    const model = modelOf([post, other]);
    expect(postTarget(model, post).format).toBe("standard");
    expect(postTarget(model, other).format).toBe("");
  });

  test("a term the model does not hold is not one of the post's terms", () => {
    const post = wpPost({ type: "post" });
    const model = modelOf([post], {
      terms: [term(5, "category", "news")],
      rel: { [post.id]: [404, 5, 405] },
    });
    expect(postTarget(model, post).terms).toEqual([
      { termId: 5, taxonomy: "category", slug: "news" },
    ]);
  });

  test("only a post of the same type with this one as its parent makes it a parent", () => {
    const parent = wpPost({ type: "page" });
    const otherType = wpPost({ type: "project", parent: parent.id });
    const unrelated = wpPost({ type: "page", parent: parent.id + 9999 });
    expect(postTarget(modelOf([parent, otherType, unrelated]), parent).hasChildren).toBe(false);
    const child = wpPost({ type: "page", parent: parent.id });
    expect(postTarget(modelOf([parent, otherType, unrelated, child]), parent).hasChildren).toBe(
      true,
    );
  });

  test("the front page and the posts page exist only when the site shows a page on the front", () => {
    const home = wpPost({ type: "page" });
    const blog = wpPost({ type: "page" });
    const both = { pageOnFront: home.id, pageForPosts: blog.id };
    const asPage = modelOf([home, blog], { site: { showOnFront: "page", ...both } });
    expect([postTarget(asPage, home).frontPage, postTarget(asPage, home).postsPage]).toEqual([
      true,
      false,
    ]);
    expect([postTarget(asPage, blog).frontPage, postTarget(asPage, blog).postsPage]).toEqual([
      false,
      true,
    ]);
    const asPosts = modelOf([home, blog], { site: { showOnFront: "posts", ...both } });
    expect([postTarget(asPosts, home).frontPage, postTarget(asPosts, home).postsPage]).toEqual([
      false,
      false,
    ]);
    expect([postTarget(asPosts, blog).frontPage, postTarget(asPosts, blog).postsPage]).toEqual([
      false,
      false,
    ]);
  });

  test("an attachment carries its mime type; no other post does", () => {
    const media = wpPost({ type: "attachment", status: "inherit" });
    const model: WpModel = {
      ...modelOf([media]),
      attachments: new Map([
        [
          media.id,
          {
            id: media.id,
            url: "",
            mime: "image/webp",
            title: "",
            alt: "",
            caption: "",
            file: "a.webp",
            sizes: [],
            parent: 0,
          },
        ],
      ]),
    };
    expect(postTarget(model, media)).toMatchObject({
      postType: "attachment",
      mime: "image/webp",
      status: "inherit",
    });
    expect("mime" in postTarget(model, wpPost({ type: "page" }))).toBe(false);
  });

  test("a template is the stored `_wp_page_template`, and `default` when there is none or it is empty", () => {
    const [a, b, c] = [
      wpPost({ type: "page" }),
      wpPost({ type: "page" }),
      wpPost({ type: "page" }),
    ];
    const model = modelOf([a!, b!, c!], {
      meta: { [a!.id]: { _wp_page_template: ["wide.php"] }, [b!.id]: { _wp_page_template: [""] } },
    });
    expect(postTarget(model, a!).template).toBe("wide.php");
    expect(postTarget(model, b!).template).toBe("default");
    expect(postTarget(model, c!).template).toBe("default");
  });
});

// ── Values, every type ───────────────────────────────────────────────────────────────────────────

describe("every field type, read and handed over", () => {
  const image = (id: number): EntryImage => ({ src: `/m/${id}.png`, alt: `alt ${id}` });
  const ref = (kind: string, id: number): EntryRef => ({
    id,
    slug: `${kind}${id}`,
    title: `${kind.toUpperCase()}${id}`,
    url: `/${kind}${id}/`,
  });
  const hooks: EntryHooks = {
    attachment: image,
    post: (id) => ref("p", id),
    term: (id) => ref("t", id),
    user: (id) => ref("u", id),
  };

  interface Row {
    type: string;
    settings?: Record<string, unknown>;
    stored: unknown;
    /** What `acfValues` makes of it, matched as a subset. */
    raw: Record<string, unknown>;
    entry: unknown;
  }
  const rows: Row[] = [
    { type: "text", stored: "t", raw: { value: "t" }, entry: "t" },
    { type: "textarea", stored: "a\nb", raw: { value: "a\nb" }, entry: "a\nb" },
    { type: "wysiwyg", stored: "<p>x</p>", raw: { value: "<p>x</p>" }, entry: "<p>x</p>" },
    {
      type: "url",
      stored: "https://x.test/",
      raw: { value: "https://x.test/" },
      entry: "https://x.test/",
    },
    { type: "email", stored: "a@b.test", raw: { value: "a@b.test" }, entry: "a@b.test" },
    { type: "password", stored: "secret", raw: { value: "secret" }, entry: "secret" },
    {
      type: "oembed",
      stored: "https://youtu.be/abc",
      raw: { value: "https://youtu.be/abc" },
      entry: "https://youtu.be/abc",
    },
    { type: "color_picker", stored: "#ff0000", raw: { value: "#ff0000" }, entry: "#ff0000" },
    { type: "time_picker", stored: "14:30:00", raw: { value: "14:30:00" }, entry: "14:30:00" },
    { type: "number", stored: "12.5", raw: { value: 12.5 }, entry: 12.5 },
    { type: "range", stored: "7", raw: { value: 7 }, entry: 7 },
    { type: "true_false", stored: "1", raw: { value: true }, entry: true },
    {
      type: "select",
      settings: { choices: { a: "A" } },
      stored: "a",
      raw: { values: ["a"] },
      entry: "a",
    },
    {
      type: "select",
      settings: { choices: { a: "A" }, multiple: 1 },
      stored: ["a", "b"],
      raw: { values: ["a", "b"] },
      entry: ["a", "b"],
    },
    {
      type: "radio",
      settings: { choices: { b: "B" } },
      stored: "b",
      raw: { values: ["b"] },
      entry: "b",
    },
    {
      type: "button_group",
      settings: { choices: { c: "C" } },
      stored: "c",
      raw: { values: ["c"] },
      entry: "c",
    },
    {
      type: "checkbox",
      settings: { choices: { a: "A", b: "B" } },
      stored: ["a", "b"],
      raw: { values: ["a", "b"] },
      entry: ["a", "b"],
    },
    {
      type: "checkbox",
      settings: { choices: { a: "A" } },
      stored: "a",
      raw: { values: ["a"] },
      entry: ["a"],
    },
    {
      type: "date_picker",
      stored: "20240215",
      raw: { value: "20240215", iso: "2024-02-15" },
      entry: "2024-02-15",
    },
    {
      type: "date_time_picker",
      stored: "2024-02-15 17:30:00",
      raw: { value: "2024-02-15 17:30:00", iso: "2024-02-15T17:30:00Z" },
      entry: "2024-02-15T17:30:00Z",
    },
    { type: "image", stored: "12", raw: { id: 12 }, entry: image(12) },
    { type: "file", stored: "13", raw: { id: 13 }, entry: image(13) },
    { type: "gallery", stored: ["1", "2"], raw: { ids: [1, 2] }, entry: [image(1), image(2)] },
    {
      type: "link",
      stored: { url: "/a", title: "A", target: "_blank" },
      raw: { value: { url: "/a", title: "A", target: "_blank" } },
      entry: { url: "/a", title: "A", target: "_blank" },
    },
    { type: "post_object", stored: "5", raw: { ids: [5] }, entry: ref("p", 5) },
    { type: "page_link", stored: "6", raw: { ids: [6] }, entry: ref("p", 6) },
    {
      type: "page_link",
      settings: { multiple: 1 },
      stored: ["6", "7"],
      raw: { ids: [6, 7] },
      entry: [ref("p", 6), ref("p", 7)],
    },
    {
      type: "relationship",
      stored: ["5", "6"],
      raw: { ids: [5, 6] },
      entry: [ref("p", 5), ref("p", 6)],
    },
    {
      type: "taxonomy",
      settings: { field_type: "radio" },
      stored: "3",
      raw: { ids: [3] },
      entry: ref("t", 3),
    },
    {
      type: "taxonomy",
      settings: { field_type: "checkbox" },
      stored: ["3", "4"],
      raw: { ids: [3, 4] },
      entry: [ref("t", 3), ref("t", 4)],
    },
    { type: "user", stored: "2", raw: { ids: [2] }, entry: ref("u", 2) },
    // A menu is a term of the `nav_menu` taxonomy, whatever the `save_format` the site prints it in.
    {
      type: "nav_menu",
      settings: { save_format: "object" },
      stored: "7",
      raw: { type: "nav_menu", ids: [7] },
      entry: ref("t", 7),
    },
    {
      type: "user",
      settings: { multiple: 1 },
      stored: ["2"],
      raw: { ids: [2] },
      entry: [ref("u", 2)],
    },
    {
      type: "google_map",
      stored: { address: "A", lat: 1.5, lng: 2.5, zoom: 10 },
      raw: { value: { address: "A", lat: 1.5, lng: 2.5, zoom: 10 } },
      entry: { address: "A", lat: 1.5, lng: 2.5, zoom: 10 },
    },
    {
      type: "icon_picker",
      stored: { type: "dashicons", value: "dashicons-admin-home" },
      raw: { value: { type: "dashicons", value: "dashicons-admin-home" } },
      entry: { type: "dashicons", value: "dashicons-admin-home" },
    },
    { type: "acfe_thing", stored: "x", raw: { type: "other", value: "x" }, entry: "x" },
  ];

  for (const row of rows) {
    test(`${row.type}${row.settings === undefined ? "" : ` ${JSON.stringify(row.settings)}`}`, () => {
      const { raw, entry, report } = readPage(
        [field(row.type, "f", row.settings ?? {})],
        { f: [row.stored] },
        { hooks },
      );
      const expectedType = row.type === "acfe_thing" ? "other" : row.type;
      expect(raw.f).toMatchObject({ type: expectedType, ...row.raw });
      expect(entry).toEqual({ f: row.entry });
      expect(codes(report, "acf.value-unreadable")).toEqual([]);
    });
  }

  test("a value that is a number or a big integer is text in a text field (an options page can hold either)", () => {
    for (const type of ["text", "textarea", "email", "password", "time_picker"]) {
      const { entry } = readPage([field(type, "a"), field(type, "b")], {
        a: [5],
        b: [12345678901234567890n],
      });
      expect(entry).toEqual({ a: "5", b: "12345678901234567890" });
    }
  });

  test("a date can be stored as a number (an import), and a date-time cannot be a list", () => {
    expect(readPage([field("date_picker", "d")], { d: [20240215] }).entry).toEqual({
      d: "2024-02-15",
    });
    expect(
      codes(
        readPage([field("date_time_picker", "d")], { d: [["2024-02-15 10:00:00"]] }).report,
        "acf.value-unreadable",
      ),
    ).toHaveLength(1);
  });

  test("a select that stores a list of values, some of them empty, keeps the others; one that has none is empty", () => {
    const choices = { choices: { a: "A", b: "B" } };
    expect(readPage([field("checkbox", "f", choices)], { f: [["a", "", "b"]] }).entry).toEqual({
      f: ["a", "b"],
    });
    expect(readPage([field("checkbox", "f", choices)], { f: [[""]] }).entry).toEqual({});
    expect(readPage([field("select", "f", choices)], { f: [5] }).entry).toEqual({ f: "5" });
    expect(readPage([field("radio", "f", choices)], { f: [true] }).entry).toEqual({ f: "1" });
  });
});

describe("a value that says nothing says nothing", () => {
  const types: [string, Record<string, unknown>][] = [
    ["text", {}],
    ["textarea", {}],
    ["wysiwyg", {}],
    ["url", {}],
    ["email", {}],
    ["password", {}],
    ["oembed", {}],
    ["color_picker", {}],
    ["time_picker", {}],
    ["number", {}],
    ["range", {}],
    ["true_false", {}],
    ["select", { choices: { a: "A" } }],
    ["radio", {}],
    ["button_group", {}],
    ["checkbox", {}],
    ["date_picker", {}],
    ["date_time_picker", {}],
    ["image", {}],
    ["file", {}],
    ["gallery", {}],
    ["link", {}],
    ["post_object", {}],
    ["page_link", {}],
    ["relationship", {}],
    ["taxonomy", {}],
    ["user", {}],
    ["nav_menu", {}],
    ["google_map", {}],
    ["icon_picker", {}],
    ["acfe_thing", {}],
  ];

  test("no row, an empty row, null and an empty list are none of them a value, and none is reported", () => {
    for (const [type, settings] of types) {
      for (const meta of [{}, { f: [""] }, { f: [null] }, { f: [[]] }]) {
        const { entry, raw, report } = readPage([field(type, "f", settings)], meta);
        expect([type, entry, raw]).toEqual([type, {}, {}]);
        expect(report.entries().filter((e) => e.code.startsWith("acf.value"))).toEqual([]);
      }
    }
  });

  test("a repeater, a group and a flexible content field with nothing stored are absent", () => {
    const fields = [
      field("repeater", "r", {}, [field("text", "a")]),
      field("group", "g", {}, [field("text", "a")]),
      field("flexible_content", "x", { layouts: [{ key: "l", name: "n", label: "N" }] }, [
        field("text", "a"),
      ]),
    ];
    for (const meta of [
      {},
      { r: [""], g: [""], x: [""] },
      { r: [null], x: [null] },
      { r: [[]], x: [[]] },
    ]) {
      const { entry, report } = readPage(fields, meta);
      expect(entry).toEqual({});
      expect(report.entries().filter((e) => e.code.startsWith("acf.value"))).toEqual([]);
    }
  });
});

describe("defaults", () => {
  test('a default answers only where there is no row at all: 0 and "0" are defaults, false, null and the empty string are none', () => {
    const fields = [
      field("number", "zero", { default_value: 0 }),
      field("true_false", "off", { default_value: 0 }),
      field("true_false", "on", { default_value: 1 }),
      field("text", "word", { default_value: "0" }),
      field("text", "nothing", { default_value: null }),
      field("text", "falsy", { default_value: false }),
      field("text", "empty", { default_value: "" }),
      field("text", "has_row", { default_value: "default" }),
    ];
    const { entry, report } = readPage(fields, { has_row: [""] });
    expect(entry).toEqual({ zero: 0, off: false, on: true, word: "0" });
    expect(codes(report, "acf.value-unreadable")).toEqual([]);
  });
});

describe("ids, and the shapes they come in", () => {
  test("numbers, numeric text, comma lists and rows with an id are ids; zero, negatives, fractions and words are not", () => {
    const { raw } = readPage(
      [field("gallery", "g"), field("relationship", "r"), field("user", "u", { multiple: 1 })],
      {
        g: ["1, 2,3"],
        r: [[1, "2", "1.5", 0, -4, "x", { id: 9 }, { term_id: 8 }, { ID: 7 }]],
        u: [[1]],
      },
    );
    expect(raw.g).toMatchObject({ ids: [1, 2, 3] });
    expect(raw.r).toMatchObject({ ids: [1, 2, 9, 8, 7] });
    expect(raw.u).toMatchObject({ ids: [1] });
  });

  test("a list of nothing but words is unreadable; so is a post value that is not an id", () => {
    const { entry, report } = readPage(
      [field("gallery", "g"), field("post_object", "p"), field("taxonomy", "t")],
      { g: [["x", "y"]], p: ["x"], t: [["0"]] },
    );
    expect(entry).toEqual({});
    expect(
      codes(report, "acf.value-unreadable").map((e) => (e.data as { name: string }).name),
    ).toEqual(["g", "p", "t"]);
  });

  test("an image with the id 0 is no image; so is a record with it; nothing is said", () => {
    for (const stored of ["0", 0, { ID: 0 }, { id: "0" }]) {
      const { entry, raw, report } = readPage([field("image", "i"), field("file", "f")], {
        i: [stored],
        f: [stored],
      });
      expect(raw).toEqual({});
      expect(entry).toEqual({});
      expect(codes(report, "acf.value-unreadable")).toEqual([]);
    }
    expect(readPage([field("image", "i")], { i: [{ id: 5 }] }).raw.i).toMatchObject({ id: 5 });
    // The smallest id there is.
    expect(readPage([field("image", "i")], { i: ["1"] }).raw.i).toMatchObject({ id: 1 });
    // An address, or a record that holds neither, or a list.
    expect(readPage([field("image", "i")], { i: ["/a.png"] }).raw.i).toMatchObject({
      url: "/a.png",
    });
    expect(
      codes(readPage([field("image", "i")], { i: [[3]] }).report, "acf.value-unreadable"),
    ).toHaveLength(1);
  });
});

describe("taxonomy fields that take their value from the post's terms", () => {
  const term = (termId: number, taxonomy: string, slug: string): WpTerm => ({
    termId,
    taxonomyId: termId,
    taxonomy,
    slug,
    name: slug,
    description: "",
    parent: 0,
    count: 1,
    meta: {},
  });

  test("one term, none, and a term screen that has no relationships", () => {
    const page = wpPost({ type: "page" });
    const terms = [term(3, "genre", "jazz"), term(5, "other", "x")];
    const defs = [
      ...group("G", loc("post_type", "page"), [
        field("taxonomy", "genres", { taxonomy: "genre", load_terms: 1 }),
      ]),
      ...group("T", loc("taxonomy", "genre"), [
        field("taxonomy", "genres", { taxonomy: "genre", load_terms: 1 }),
      ]),
    ];
    const one = modelOf([...defs, page], { terms, rel: { [page.id]: [3, 5] } });
    expect(acfValues(one, loadAcf(one), postTarget(one, page)).genres).toMatchObject({ ids: [3] });
    const none = modelOf([...defs, page], { terms, rel: { [page.id]: [5] } });
    expect(acfValues(none, loadAcf(none), postTarget(none, page))).toEqual({});
    const unfiled = modelOf([...defs, page], { terms });
    expect(acfValues(unfiled, loadAcf(unfiled), postTarget(unfiled, page))).toEqual({});
    // Reading a term, the relationships of posts are not what the field means: its own meta is.
    const genre = { ...term(3, "genre", "jazz"), meta: { genres: "4" } };
    const onTerm = modelOf(defs, { terms: [genre] });
    expect(acfValues(onTerm, loadAcf(onTerm), termTarget(onTerm, genre)).genres).toMatchObject({
      ids: [4],
    });
  });
});

describe("repeaters, groups and flexible content: counts and limits", () => {
  const rows = [field("repeater", "rows", {}, [field("text", "a")])];

  test("a repeater is its stored count and nothing else: without one it has no rows", () => {
    expect(readPage(rows, { rows_0_a: ["x"] }).entry).toEqual({});
    expect(readPage(rows, { rows: ["not a number"], rows_0_a: ["x"] }).entry).toEqual({});
    expect(readPage(rows, { rows: ["1.5"], rows_0_a: ["x"] }).entry).toEqual({});
    expect(readPage(rows, { rows: ["-1"], rows_0_a: ["x"] }).entry).toEqual({});
    expect(readPage(rows, { rows: ["0"], rows_0_a: ["x"] }).entry).toEqual({});
  });

  test("rows 0 up to the count are read and no further", () => {
    expect(
      readPage(rows, { rows: ["2"], rows_0_a: ["x"], rows_1_a: ["y"], rows_2_a: ["z"] }).entry,
    ).toEqual({ rows: [{ a: "x" }, { a: "y" }] });
    expect(readPage(rows, { rows: ["1"], rows_0_a: ["x"], rows_1_a: ["y"] }).entry).toEqual({
      rows: [{ a: "x" }],
    });
    expect(readPage(rows, { rows: [2], rows_0_a: [""], rows_1_a: ["y"] }).entry).toEqual({
      rows: [{ a: "y" }],
    });
  });

  test("the cap on rows: exactly the cap is read without comment; one more is cut to it and told", () => {
    const at = readPage(rows, { rows: ["5000"], rows_0_a: ["x"], rows_4999_a: ["last"] });
    expect(codes(at.report, "acf.value-unreadable")).toEqual([]);
    expect(at.entry).toEqual({ rows: [{ a: "x" }, { a: "last" }] });
    const over = readPage(rows, { rows: ["5001"], rows_4999_a: ["last"], rows_5000_a: ["beyond"] });
    expect(over.entry).toEqual({ rows: [{ a: "last" }] });
    expect(codes(over.report, "acf.value-unreadable")).toMatchObject([
      { data: { name: "rows", count: 5001 } },
    ]);
  });

  test("a group with one value in it is a group", () => {
    const group_ = [field("group", "g", {}, [field("text", "a"), field("text", "b")])];
    expect(readPage(group_, { g_a: ["x"] }).entry).toEqual({ g: { a: "x" } });
    expect(readPage(group_, { g_b: ["y"], g_a: [""] }).entry).toEqual({ g: { b: "y" } });
  });

  test("a flexible content field skips a layout name that is empty, and counts its rows from the names that are left", () => {
    const flexible = field(
      "flexible_content",
      "blocks",
      { layouts: [{ key: "l1", name: "hero", label: "Hero" }] },
      [field("text", "title", { parent_layout: "l1" })],
    );
    const { entry, report } = readPage([flexible], {
      blocks: [["hero", ""]],
      blocks_0_title: ["T"],
    });
    expect(entry).toEqual({ blocks: [{ acf_fc_layout: "hero", title: "T" }] });
    expect(codes(report, "acf.layout-unknown")).toEqual([]);
    // A row of a layout with nothing in it is still a row of that layout.
    expect(readPage([flexible], { blocks: [["hero"]] }).entry).toEqual({
      blocks: [{ acf_fc_layout: "hero" }],
    });
  });
});

describe("what is reported about a value, and where", () => {
  test("an unreadable value carries the first 80 characters of what was stored, the post and its address", () => {
    const long = { word: "x".repeat(200) };
    const { report, raw } = readPage([field("number", "n")], { n: [long] });
    expect(raw).toEqual({});
    const entry = codes(report, "acf.value-unreadable")[0]!;
    const sample = (entry.data as { sample: string }).sample;
    expect(sample).toBe(JSON.stringify(long).slice(0, 80));
    expect(sample).toHaveLength(80);
    expect(entry.where).toMatch(/^post:\d+$/);
    expect(entry.url).toBe(`https://x.test/?p=${entry.where!.slice(5)}`);
  });

  test("on a term the place is the term and there is no address; on an options page, the page", () => {
    const term: WpTerm = {
      termId: 9,
      taxonomyId: 9,
      taxonomy: "genre",
      slug: "jazz",
      name: "Jazz",
      description: "",
      parent: 0,
      count: 1,
      meta: { n: "x" },
    };
    const defs = [
      ...group("T", loc("taxonomy", "genre"), [field("number", "n")]),
      ...group(
        "O",
        [[{ param: "options_page", operator: "==", value: "site" }]],
        [field("number", "n")],
      ),
    ];
    const model = modelOf(defs, { terms: [term], options: { options_n: "y" } });
    const report = createReport();
    const acf = loadAcf(model);
    acfValues(model, acf, termTarget(model, term), { report });
    acfValues(model, acf, { kind: "options", page: "site" }, { report });
    const [onTerm, onPage] = codes(report, "acf.value-unreadable");
    expect(onTerm).toMatchObject({ where: "term:9" });
    expect(onPage).toMatchObject({ where: "options:site" });
    expect("url" in onTerm! && onTerm.url !== undefined).toBe(false);
    expect("url" in onPage! && onPage.url !== undefined).toBe(false);
  });

  test("meta ACF keeps for itself, whose name begins with an underscore, is never an orphan", () => {
    const { report } = readPage([field("text", "x")], {
      x: ["v"],
      _x: ["field_x"],
      _hidden: ["data"],
      __hidden: ["field_zzz"],
    });
    expect(codes(report, "acf.value-orphaned")).toEqual([]);
  });

  test("an orphan's value is shown whole up to 80 characters and cut after, as text for a long list and whole for a short one", () => {
    const long = Array.from({ length: 60 }, (_, i) => i);
    const meta: Record<string, unknown[]> = {};
    const stored: Record<string, unknown> = {
      exact: "e".repeat(80),
      over: "o".repeat(81),
      list: [1, 2, 3],
      longlist: long,
      // A list is told whole while its JSON is at most 80 characters (`["` and `"]` are four of them).
      jsonExact: ["j".repeat(76)],
      jsonOver: ["j".repeat(77)],
      big: 12345678901234567890n,
    };
    let n = 0;
    for (const [name, value] of Object.entries(stored)) {
      meta[name] = [value];
      meta[`_${name}`] = [`field_gone${n++}`];
    }
    const { report } = readPage([field("text", "x")], meta);
    const value = (name: string): unknown =>
      (
        codes(report, "acf.value-orphaned").find((e) => (e.data as { name: string }).name === name)!
          .data as { value: unknown }
      ).value;
    expect(value("exact")).toBe("e".repeat(80));
    expect(value("over")).toBe(`${"o".repeat(80)}…`);
    expect(value("list")).toEqual([1, 2, 3]);
    expect(value("longlist")).toBe(`${JSON.stringify(long).slice(0, 80)}…`);
    expect(JSON.stringify(["j".repeat(76)])).toHaveLength(80);
    expect(value("jsonExact")).toEqual(["j".repeat(76)]);
    expect(value("jsonOver")).toBe(`${JSON.stringify(["j".repeat(77)]).slice(0, 80)}…`);
    expect(value("big")).toBe(12345678901234567890n);
  });

  test("orphans on an options page are found by the page's prefix: a name that merely contains it is not one", () => {
    const defs = [
      wpPost({
        type: "acf-ui-options-page",
        title: "Site",
        slug: "ui_options_page_s",
        content: serialize({ menu_slug: "site", post_id: "site" }),
      }),
      ...group(
        "Any",
        [[{ param: "options_page", operator: "==", value: "site" }]],
        [field("text", "kept")],
      ),
    ];
    const model = modelOf(defs, {
      options: {
        site_kept: "v",
        _site_kept: "field_kept",
        site_old: "gone",
        _site_old: "field_gone",
        other_site_late: "elsewhere",
        _other_site_late: "field_gone2",
      },
    });
    const report = createReport();
    const acf = loadAcf(model);
    expect(acfValues(model, acf, { kind: "options", page: "site" }, { report }).kept).toMatchObject(
      { value: "v" },
    );
    expect(codes(report, "acf.value-orphaned")).toMatchObject([
      { where: "options:site", data: { name: "old", field: "field_gone", value: "gone" } },
    ]);
  });
});

// ── Dates and the site's clock, against PHP ──────────────────────────────────────────────────────

/**
 * What PHP 8.3 (`DateTime::createFromFormat("Y-m-d H:i:s", $wall, new DateTimeZone($zone))->getTimestamp()`) says
 * for wall times around every 2024 transition of twelve zones, and some ordinary ones: `zone wall timestamp`.
 */
const PHP_WALL_TIMES = String.raw`America/New_York 2024-03-10 01:30:00 1710052200
America/New_York 2024-03-10 02:00:00 1710054000
America/New_York 2024-03-10 02:15:00 1710054900
America/New_York 2024-03-10 02:30:00 1710055800
America/New_York 2024-03-10 02:45:00 1710056700
America/New_York 2024-03-10 03:00:00 1710054000
America/New_York 2024-03-10 03:15:00 1710054900
America/New_York 2024-03-10 03:30:00 1710055800
America/New_York 2024-03-10 03:45:00 1710056700
America/New_York 2024-03-10 04:00:00 1710057600
America/New_York 2024-03-10 04:30:00 1710059400
America/New_York 2024-11-02 23:30:00 1730604600
America/New_York 2024-11-03 00:00:00 1730606400
America/New_York 2024-11-03 00:15:00 1730607300
America/New_York 2024-11-03 00:30:00 1730608200
America/New_York 2024-11-03 00:45:00 1730609100
America/New_York 2024-11-03 01:00:00 1730610000
America/New_York 2024-11-03 01:15:00 1730610900
America/New_York 2024-11-03 01:30:00 1730611800
America/New_York 2024-11-03 01:45:00 1730612700
America/New_York 2024-11-03 02:00:00 1730617200
America/New_York 2024-11-03 02:30:00 1730619000
America/New_York 2024-01-15 12:00:00 1705338000
America/New_York 2024-07-15 12:00:00 1721059200
America/New_York 2024-12-31 23:59:59 1735707599
America/New_York 2024-02-29 00:00:00 1709182800
America/Los_Angeles 2024-03-10 01:30:00 1710063000
America/Los_Angeles 2024-03-10 02:00:00 1710064800
America/Los_Angeles 2024-03-10 02:15:00 1710065700
America/Los_Angeles 2024-03-10 02:30:00 1710066600
America/Los_Angeles 2024-03-10 02:45:00 1710067500
America/Los_Angeles 2024-03-10 03:00:00 1710064800
America/Los_Angeles 2024-03-10 03:15:00 1710065700
America/Los_Angeles 2024-03-10 03:30:00 1710066600
America/Los_Angeles 2024-03-10 03:45:00 1710067500
America/Los_Angeles 2024-03-10 04:00:00 1710068400
America/Los_Angeles 2024-03-10 04:30:00 1710070200
America/Los_Angeles 2024-11-02 23:30:00 1730615400
America/Los_Angeles 2024-11-03 00:00:00 1730617200
America/Los_Angeles 2024-11-03 00:15:00 1730618100
America/Los_Angeles 2024-11-03 00:30:00 1730619000
America/Los_Angeles 2024-11-03 00:45:00 1730619900
America/Los_Angeles 2024-11-03 01:00:00 1730620800
America/Los_Angeles 2024-11-03 01:15:00 1730621700
America/Los_Angeles 2024-11-03 01:30:00 1730622600
America/Los_Angeles 2024-11-03 01:45:00 1730623500
America/Los_Angeles 2024-11-03 02:00:00 1730628000
America/Los_Angeles 2024-11-03 02:30:00 1730629800
America/Los_Angeles 2024-01-15 12:00:00 1705348800
America/Los_Angeles 2024-07-15 12:00:00 1721070000
America/Los_Angeles 2024-12-31 23:59:59 1735718399
America/Los_Angeles 2024-02-29 00:00:00 1709193600
Europe/London 2024-03-31 00:30:00 1711845000
Europe/London 2024-03-31 01:00:00 1711846800
Europe/London 2024-03-31 01:15:00 1711847700
Europe/London 2024-03-31 01:30:00 1711848600
Europe/London 2024-03-31 01:45:00 1711849500
Europe/London 2024-03-31 02:00:00 1711846800
Europe/London 2024-03-31 02:15:00 1711847700
Europe/London 2024-03-31 02:30:00 1711848600
Europe/London 2024-03-31 02:45:00 1711849500
Europe/London 2024-03-31 03:00:00 1711850400
Europe/London 2024-03-31 03:30:00 1711852200
Europe/London 2024-10-26 23:30:00 1729981800
Europe/London 2024-10-27 00:00:00 1729983600
Europe/London 2024-10-27 00:15:00 1729984500
Europe/London 2024-10-27 00:30:00 1729985400
Europe/London 2024-10-27 00:45:00 1729986300
Europe/London 2024-10-27 01:00:00 1729990800
Europe/London 2024-10-27 01:15:00 1729991700
Europe/London 2024-10-27 01:30:00 1729992600
Europe/London 2024-10-27 01:45:00 1729993500
Europe/London 2024-10-27 02:00:00 1729994400
Europe/London 2024-10-27 02:30:00 1729996200
Europe/London 2024-01-15 12:00:00 1705320000
Europe/London 2024-07-15 12:00:00 1721041200
Europe/London 2024-12-31 23:59:59 1735689599
Europe/London 2024-02-29 00:00:00 1709164800
Europe/Berlin 2024-03-31 01:30:00 1711845000
Europe/Berlin 2024-03-31 02:00:00 1711846800
Europe/Berlin 2024-03-31 02:15:00 1711847700
Europe/Berlin 2024-03-31 02:30:00 1711848600
Europe/Berlin 2024-03-31 02:45:00 1711849500
Europe/Berlin 2024-03-31 03:00:00 1711846800
Europe/Berlin 2024-03-31 03:15:00 1711847700
Europe/Berlin 2024-03-31 03:30:00 1711848600
Europe/Berlin 2024-03-31 03:45:00 1711849500
Europe/Berlin 2024-03-31 04:00:00 1711850400
Europe/Berlin 2024-03-31 04:30:00 1711852200
Europe/Berlin 2024-10-27 00:30:00 1729981800
Europe/Berlin 2024-10-27 01:00:00 1729983600
Europe/Berlin 2024-10-27 01:15:00 1729984500
Europe/Berlin 2024-10-27 01:30:00 1729985400
Europe/Berlin 2024-10-27 01:45:00 1729986300
Europe/Berlin 2024-10-27 02:00:00 1729990800
Europe/Berlin 2024-10-27 02:15:00 1729991700
Europe/Berlin 2024-10-27 02:30:00 1729992600
Europe/Berlin 2024-10-27 02:45:00 1729993500
Europe/Berlin 2024-10-27 03:00:00 1729994400
Europe/Berlin 2024-10-27 03:30:00 1729996200
Europe/Berlin 2024-01-15 12:00:00 1705316400
Europe/Berlin 2024-07-15 12:00:00 1721037600
Europe/Berlin 2024-12-31 23:59:59 1735685999
Europe/Berlin 2024-02-29 00:00:00 1709161200
Australia/Sydney 2024-04-07 00:30:00 1712410200
Australia/Sydney 2024-04-07 01:00:00 1712412000
Australia/Sydney 2024-04-07 01:15:00 1712412900
Australia/Sydney 2024-04-07 01:30:00 1712413800
Australia/Sydney 2024-04-07 01:45:00 1712414700
Australia/Sydney 2024-04-07 02:00:00 1712419200
Australia/Sydney 2024-04-07 02:15:00 1712420100
Australia/Sydney 2024-04-07 02:30:00 1712421000
Australia/Sydney 2024-04-07 02:45:00 1712421900
Australia/Sydney 2024-04-07 03:00:00 1712422800
Australia/Sydney 2024-04-07 03:30:00 1712424600
Australia/Sydney 2024-10-06 01:30:00 1728142200
Australia/Sydney 2024-10-06 02:00:00 1728144000
Australia/Sydney 2024-10-06 02:15:00 1728144900
Australia/Sydney 2024-10-06 02:30:00 1728145800
Australia/Sydney 2024-10-06 02:45:00 1728146700
Australia/Sydney 2024-10-06 03:00:00 1728144000
Australia/Sydney 2024-10-06 03:15:00 1728144900
Australia/Sydney 2024-10-06 03:30:00 1728145800
Australia/Sydney 2024-10-06 03:45:00 1728146700
Australia/Sydney 2024-10-06 04:00:00 1728147600
Australia/Sydney 2024-10-06 04:30:00 1728149400
Australia/Sydney 2024-01-15 12:00:00 1705280400
Australia/Sydney 2024-07-15 12:00:00 1721008800
Australia/Sydney 2024-12-31 23:59:59 1735649999
Australia/Sydney 2024-02-29 00:00:00 1709125200
Australia/Lord_Howe 2024-04-07 00:00:00 1712408400
Australia/Lord_Howe 2024-04-07 00:30:00 1712410200
Australia/Lord_Howe 2024-04-07 00:45:00 1712411100
Australia/Lord_Howe 2024-04-07 01:00:00 1712412000
Australia/Lord_Howe 2024-04-07 01:15:00 1712412900
Australia/Lord_Howe 2024-04-07 01:30:00 1712415600
Australia/Lord_Howe 2024-04-07 01:45:00 1712416500
Australia/Lord_Howe 2024-04-07 02:00:00 1712417400
Australia/Lord_Howe 2024-04-07 02:15:00 1712418300
Australia/Lord_Howe 2024-04-07 02:30:00 1712419200
Australia/Lord_Howe 2024-04-07 03:00:00 1712421000
Australia/Lord_Howe 2024-10-06 01:00:00 1728138600
Australia/Lord_Howe 2024-10-06 01:30:00 1728140400
Australia/Lord_Howe 2024-10-06 01:45:00 1728141300
Australia/Lord_Howe 2024-10-06 02:00:00 1728142200
Australia/Lord_Howe 2024-10-06 02:15:00 1728143100
Australia/Lord_Howe 2024-10-06 02:30:00 1728142200
Australia/Lord_Howe 2024-10-06 02:45:00 1728143100
Australia/Lord_Howe 2024-10-06 03:00:00 1728144000
Australia/Lord_Howe 2024-10-06 03:15:00 1728144900
Australia/Lord_Howe 2024-10-06 03:30:00 1728145800
Australia/Lord_Howe 2024-10-06 04:00:00 1728147600
Australia/Lord_Howe 2024-01-15 12:00:00 1705280400
Australia/Lord_Howe 2024-07-15 12:00:00 1721007000
Australia/Lord_Howe 2024-12-31 23:59:59 1735649999
Australia/Lord_Howe 2024-02-29 00:00:00 1709125200
Pacific/Auckland 2024-04-07 00:30:00 1712403000
Pacific/Auckland 2024-04-07 01:00:00 1712404800
Pacific/Auckland 2024-04-07 01:15:00 1712405700
Pacific/Auckland 2024-04-07 01:30:00 1712406600
Pacific/Auckland 2024-04-07 01:45:00 1712407500
Pacific/Auckland 2024-04-07 02:00:00 1712412000
Pacific/Auckland 2024-04-07 02:15:00 1712412900
Pacific/Auckland 2024-04-07 02:30:00 1712413800
Pacific/Auckland 2024-04-07 02:45:00 1712414700
Pacific/Auckland 2024-04-07 03:00:00 1712415600
Pacific/Auckland 2024-04-07 03:30:00 1712417400
Pacific/Auckland 2024-09-29 01:30:00 1727530200
Pacific/Auckland 2024-09-29 02:00:00 1727532000
Pacific/Auckland 2024-09-29 02:15:00 1727532900
Pacific/Auckland 2024-09-29 02:30:00 1727533800
Pacific/Auckland 2024-09-29 02:45:00 1727534700
Pacific/Auckland 2024-09-29 03:00:00 1727532000
Pacific/Auckland 2024-09-29 03:15:00 1727532900
Pacific/Auckland 2024-09-29 03:30:00 1727533800
Pacific/Auckland 2024-09-29 03:45:00 1727534700
Pacific/Auckland 2024-09-29 04:00:00 1727535600
Pacific/Auckland 2024-09-29 04:30:00 1727537400
Pacific/Auckland 2024-01-15 12:00:00 1705273200
Pacific/Auckland 2024-07-15 12:00:00 1721001600
Pacific/Auckland 2024-12-31 23:59:59 1735642799
Pacific/Auckland 2024-02-29 00:00:00 1709118000
America/St_Johns 2024-03-10 01:30:00 1710046800
America/St_Johns 2024-03-10 02:00:00 1710048600
America/St_Johns 2024-03-10 02:15:00 1710049500
America/St_Johns 2024-03-10 02:30:00 1710050400
America/St_Johns 2024-03-10 02:45:00 1710051300
America/St_Johns 2024-03-10 03:00:00 1710048600
America/St_Johns 2024-03-10 03:15:00 1710049500
America/St_Johns 2024-03-10 03:30:00 1710050400
America/St_Johns 2024-03-10 03:45:00 1710051300
America/St_Johns 2024-03-10 04:00:00 1710052200
America/St_Johns 2024-03-10 04:30:00 1710054000
America/St_Johns 2024-11-02 23:30:00 1730599200
America/St_Johns 2024-11-03 00:00:00 1730601000
America/St_Johns 2024-11-03 00:15:00 1730601900
America/St_Johns 2024-11-03 00:30:00 1730602800
America/St_Johns 2024-11-03 00:45:00 1730603700
America/St_Johns 2024-11-03 01:00:00 1730604600
America/St_Johns 2024-11-03 01:15:00 1730605500
America/St_Johns 2024-11-03 01:30:00 1730606400
America/St_Johns 2024-11-03 01:45:00 1730607300
America/St_Johns 2024-11-03 02:00:00 1730611800
America/St_Johns 2024-11-03 02:30:00 1730613600
America/St_Johns 2024-01-15 12:00:00 1705332600
America/St_Johns 2024-07-15 12:00:00 1721053800
America/St_Johns 2024-12-31 23:59:59 1735702199
America/St_Johns 2024-02-29 00:00:00 1709177400
America/Sao_Paulo 2024-01-15 12:00:00 1705330800
America/Sao_Paulo 2024-07-15 12:00:00 1721055600
America/Sao_Paulo 2024-12-31 23:59:59 1735700399
America/Sao_Paulo 2024-02-29 00:00:00 1709175600
Asia/Kolkata 2024-01-15 12:00:00 1705300200
Asia/Kolkata 2024-07-15 12:00:00 1721025000
Asia/Kolkata 2024-12-31 23:59:59 1735669799
Asia/Kolkata 2024-02-29 00:00:00 1709145000
Asia/Tehran 2024-01-15 12:00:00 1705307400
Asia/Tehran 2024-07-15 12:00:00 1721032200
Asia/Tehran 2024-12-31 23:59:59 1735676999
Asia/Tehran 2024-02-29 00:00:00 1709152200
UTC 2024-01-15 12:00:00 1705320000
UTC 2024-07-15 12:00:00 1721044800
UTC 2024-12-31 23:59:59 1735689599
UTC 2024-02-29 00:00:00 1709164800`;

describe("zoneClock.toUtc, against PHP's own answer", () => {
  const formats = new Map<string, Intl.DateTimeFormat>();
  /** The zone's wall clock at a UTC instant, by a route that shares nothing with the code under test. */
  function localAt(zone: string, utcMs: number): number {
    let format = formats.get(zone);
    if (!format) {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
      formats.set(zone, format);
    }
    const part: Record<string, number> = {};
    for (const { type, value } of format.formatToParts(utcMs)) part[type] = Number(value);
    return Date.UTC(part.year!, part.month! - 1, part.day!, part.hour!, part.minute!, part.second!);
  }
  /** Every instant, on a quarter-hour grid, at which the zone's clock reads `wall`: none (a gap), one, or two (a repeated hour). */
  function candidates(zone: string, wall: number): number[] {
    const out: number[] = [];
    for (let t = wall - 30 * 3_600_000; t <= wall + 30 * 3_600_000; t += 900_000)
      if (localAt(zone, t) === wall) out.push(t);
    return out;
  }

  const rows = PHP_WALL_TIMES.split("\n").map((line) => {
    const [zone, date, time, stamp] = line.split(" ") as [string, string, string, string];
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)!;
    const t = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time)!;
    const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +t[1]!, +t[2]!, +t[3]!);
    return { zone, text: `${date} ${time}`, wall, php: Number(stamp) * 1000 };
  });

  test("every wall time is a time that exists once, never, or twice, and each kind is read as it should be", () => {
    const seen = { once: 0, never: 0, twice: 0 };
    for (const row of rows) {
      const ours = zoneClock(row.zone).toUtc(row.wall);
      const found = candidates(row.zone, row.wall);
      const label = `${row.zone} ${row.text}`;
      if (found.length === 1) {
        seen.once++;
        // Exactly one instant has this wall time: ours is it, and PHP's is it.
        expect([label, ours]).toEqual([label, found[0]!]);
        expect([label, row.php]).toEqual([label, found[0]!]);
      } else if (found.length === 0) {
        seen.never++;
        // A time the clocks skipped is read with the offset from before the skip, as PHP reads it.
        expect([label, ours]).toEqual([label, row.php]);
        // ... which lands after the skip: the clock then reads the wall time an hour (or the skip) later.
        expect(localAt(row.zone, ours)).toBeGreaterThan(row.wall);
      } else {
        seen.twice++;
        // A repeated hour is read as its first time; PHP takes either one, by which side of UTC the zone is on,
        // and both read back as this wall time.
        expect(found).toHaveLength(2);
        expect([label, ours]).toEqual([label, found[0]!]);
        expect(found).toContain(row.php);
      }
    }
    expect(seen).toEqual({ once: 164, never: 30, twice: 30 });
  });

  test("the cases a person would try first", () => {
    const ny = zoneClock("America/New_York");
    const at = (y: number, mo: number, d: number, h: number, mi = 0, s = 0): number =>
      Date.UTC(y, mo - 1, d, h, mi, s);
    const iso = (ms: number): string => new Date(ms).toISOString();
    // Autumn: 03:00 on the day the clocks went back is standard time already; a day earlier it is still summer time.
    expect(iso(ny.toUtc(at(2024, 11, 3, 3)))).toBe("2024-11-03T08:00:00.000Z");
    expect(iso(ny.toUtc(at(2024, 11, 2, 3)))).toBe("2024-11-02T07:00:00.000Z");
    // Spring: 03:30 on the day the clocks went forward is summer time already.
    expect(iso(ny.toUtc(at(2024, 3, 10, 3, 30)))).toBe("2024-03-10T07:30:00.000Z");
    expect(iso(ny.toUtc(at(2024, 3, 9, 3, 30)))).toBe("2024-03-09T08:30:00.000Z");
    // The southern hemisphere turns the other way round.
    const sydney = zoneClock("Australia/Sydney");
    expect(iso(sydney.toUtc(at(2024, 10, 6, 3, 30)))).toBe("2024-10-05T16:30:00.000Z");
    expect(iso(sydney.toUtc(at(2024, 4, 7, 3, 30)))).toBe("2024-04-06T17:30:00.000Z");
    // Half-hour zones and a half-hour of daylight saving.
    expect(iso(zoneClock("Asia/Kolkata").toUtc(at(2024, 6, 1, 12)))).toBe(
      "2024-06-01T06:30:00.000Z",
    );
    expect(iso(zoneClock("Australia/Lord_Howe").toUtc(at(2024, 1, 15, 12)))).toBe(
      "2024-01-15T01:00:00.000Z",
    );
    expect(iso(zoneClock("Australia/Lord_Howe").toUtc(at(2024, 7, 15, 12)))).toBe(
      "2024-07-15T01:30:00.000Z",
    );
  });

  test("toLocal is the inverse of toUtc away from the transitions, and moves a UTC instant onto the wall clock", () => {
    const ny = zoneClock("America/New_York");
    const summer = Date.UTC(2024, 6, 4, 16, 0, 0);
    const winter = Date.UTC(2024, 0, 4, 17, 0, 0);
    expect(ny.toLocal(summer)).toBe(Date.UTC(2024, 6, 4, 12, 0, 0));
    expect(ny.toLocal(winter)).toBe(Date.UTC(2024, 0, 4, 12, 0, 0));
    expect(ny.toUtc(ny.toLocal(summer))).toBe(summer);
    expect(ny.toUtc(ny.toLocal(winter))).toBe(winter);
    // A fraction of a second is carried over as it is.
    expect(ny.toLocal(summer + 999)).toBe(Date.UTC(2024, 6, 4, 12, 0, 0) + 999);
  });
});

describe("siteClock: the zone name, else the offset, else UTC", () => {
  const clockOf = (options: Record<string, string>): ReturnType<typeof siteClock> =>
    siteClock(modelOf([], { options }));
  const noon = Date.UTC(2024, 0, 4, 12, 0, 0);

  test("a named zone, with spaces around it, and daylight saving", () => {
    expect(clockOf({ timezone_string: " America/New_York " }).toLocal(noon)).toBe(
      noon - 5 * 3_600_000,
    );
    expect(clockOf({ timezone_string: "America/New_York", gmt_offset: "9" }).toLocal(noon)).toBe(
      noon - 5 * 3_600_000,
    );
  });

  test("an offset in hours, whole or fractional, in either direction, both ways round", () => {
    for (const [stated, hours] of [
      ["2", 2],
      ["-5.5", -5.5],
      [" 1 ", 1],
      ["0", 0],
    ] as const) {
      const clock = clockOf({ gmt_offset: stated });
      expect(clock.toLocal(noon)).toBe(noon + hours * 3_600_000);
      expect(clock.toUtc(noon)).toBe(noon - hours * 3_600_000);
    }
  });

  test("an offset that is not a number, an empty one and none at all are UTC", () => {
    for (const options of [
      { gmt_offset: "abc" },
      { gmt_offset: "" },
      { gmt_offset: "Infinity" },
      {},
      { timezone_string: "Not/AZone", gmt_offset: "x" },
    ]) {
      const clock = clockOf(options);
      expect([clock.toLocal(noon), clock.toUtc(noon)]).toEqual([noon, noon]);
    }
  });
});

describe("date values: what is read, and what is kept as written", () => {
  const iso = (
    type: string,
    stored: unknown,
    options: Record<string, string> = {},
  ): string | undefined =>
    (
      readPage([field(type, "d")], { d: [stored] }, { parts: { options } }).raw.d as
        | { iso?: string }
        | undefined
    )?.iso;

  test("a date-time is read second by second, whatever the day", () => {
    expect(iso("date_time_picker", "2024-07-25 13:45:59")).toBe("2024-07-25T13:45:59Z");
    expect(iso("date_time_picker", "2024-12-31 23:59:59")).toBe("2024-12-31T23:59:59Z");
    expect(iso("date_time_picker", "2024-07-25T13:45:59.123Z")).toBe("2024-07-25T13:45:59Z");
    expect(iso("date_time_picker", "2024-07-25 13:45")).toBe("2024-07-25T13:45:00Z");
    expect(iso("date_time_picker", " 2024-07-25 13:45:59 ")).toBe("2024-07-25T13:45:59Z");
  });

  test("a date-time that states a zone is that instant, in any of the ways of writing one", () => {
    const ny = { timezone_string: "America/New_York" };
    expect(iso("date_time_picker", "2024-01-04T12:00:00z", ny)).toBe("2024-01-04T12:00:00Z");
    expect(iso("date_time_picker", "2024-01-04 12:00:00+0000", ny)).toBe("2024-01-04T12:00:00Z");
    expect(iso("date_time_picker", "2024-01-04T12:00:00+02:00", ny)).toBe("2024-01-04T10:00:00Z");
    expect(iso("date_time_picker", "2024-01-04T12:00:00-03:30", ny)).toBe("2024-01-04T15:30:00Z");
    expect(iso("date_time_picker", "2024-01-04T12:00:00+05:45", ny)).toBe("2024-01-04T06:15:00Z");
    expect(iso("date_time_picker", "2024-01-04 12:00:00-0530", ny)).toBe("2024-01-04T17:30:00Z");
  });

  test("a day that does not exist is not a date: it is kept as written and told", () => {
    for (const bad of [
      "2024-02-30 10:00:00",
      "2023-02-29 10:00:00",
      "2024-13-01 10:00:00",
      "2024-00-10 10:00:00",
    ]) {
      expect(iso("date_time_picker", bad)).toBeUndefined();
    }
    for (const bad of ["20230229", "20240230", "20241301", "20240001", "2024-02-30"])
      expect(iso("date_picker", bad)).toBeUndefined();
    const { raw, report } = readPage([field("date_picker", "d")], { d: ["20240230"] });
    expect(raw.d).toMatchObject({ value: "20240230" });
    expect(codes(report, "acf.value-unreadable")).toHaveLength(1);
  });

  test("a date is Ymd or Y-m-d, with a time after it that is ignored", () => {
    expect(iso("date_picker", "20240215")).toBe("2024-02-15");
    expect(iso("date_picker", "2024-02-15")).toBe("2024-02-15");
    expect(iso("date_picker", "2024-02-15 10:00:00")).toBe("2024-02-15");
    expect(iso("date_picker", "2024-02-15T10:00:00Z")).toBe("2024-02-15");
    expect(iso("date_picker", " 20240215 ")).toBe("2024-02-15");
    expect(iso("date_picker", "2024-2-15")).toBeUndefined();
    expect(iso("date_picker", "15/02/2024")).toBeUndefined();
    expect(iso("date_picker", "202402")).toBeUndefined();
  });

  test("a year before 1000 keeps its four digits", () => {
    expect(iso("date_picker", "09990101")).toBe("0999-01-01");
    expect(iso("date_time_picker", "0999-01-01 00:00:00")).toBe("0999-01-01T00:00:00Z");
  });
});

// ── The schema, the rest of it ───────────────────────────────────────────────────────────────────

describe("acfSchema: what a schema says about each kind of field", () => {
  const schemaOf = (
    fields: FieldMaker[],
    opts: { report?: Report; where?: string } = {},
  ): JsonSchemaLike => {
    const defs = group("G", loc("post_type", "page"), fields);
    const acf = loadAcf(modelOf([...defs, wpPost({ type: "page" })]));
    return acfSchema(acf.groups[0]!.fields, opts);
  };
  type JsonSchemaLike = Record<string, unknown>;
  const props = (schema: JsonSchemaLike): Record<string, Record<string, unknown>> =>
    schema.properties as Record<string, Record<string, unknown>>;

  test("a map and an icon picker are objects with the keys the plugin stores", () => {
    expect(propertyOf("google_map")).toEqual({
      type: "object",
      title: "f",
      properties: {
        address: { type: "string" },
        lat: { type: "number" },
        lng: { type: "number" },
        zoom: { type: "number" },
      },
    });
    expect(propertyOf("icon_picker")).toEqual({
      type: "object",
      title: "f",
      properties: { type: { type: "string" }, value: { type: "string" } },
    });
  });

  test("a label that is empty gives no title, and instructions that are empty no description", () => {
    const defs = group("G", loc("post_type", "page"), [
      field("text", "t", { instructions: "" }, [], { title: "" }),
    ]);
    const acf = loadAcf(modelOf([...defs, wpPost({ type: "page" })]));
    expect(props(acfSchema(acf.groups[0]!.fields)).t).toEqual({ type: "string" });
  });

  test("a choice whose value is empty is not one of the values", () => {
    expect(propertyOf("select", { choices: { "": "None", a: "A" } })).toEqual({
      type: "string",
      enum: ["a"],
      title: "f",
    });
    expect(propertyOf("select", { choices: { "": "None" } })).toEqual({
      type: "string",
      title: "f",
    });
  });

  test("a repeater's limits: a minimum and a maximum above zero, and none for zero, empty or absent", () => {
    const rows = (settings: Record<string, unknown>): Record<string, unknown> =>
      props(schemaOf([field("repeater", "rows", settings, [field("text", "a")])])).rows!;
    for (const none of [{}, { min: 0, max: 0 }, { min: "", max: "" }, { min: "0", max: "0" }]) {
      expect(rows(none)).not.toHaveProperty("minItems");
      expect(rows(none)).not.toHaveProperty("maxItems");
    }
    expect(rows({ min: 1 })).toMatchObject({ minItems: 1 });
    expect(rows({ min: 1 })).not.toHaveProperty("maxItems");
    expect(rows({ max: 1 })).toMatchObject({ maxItems: 1 });
    expect(rows({ max: 1 })).not.toHaveProperty("minItems");
    expect(rows({ min: "2", max: "3" })).toMatchObject({ minItems: 2, maxItems: 3 });
  });

  test("a flexible content field: one layout is a one-way choice, none is anything, a layout with no label or no fields is still a layout", () => {
    const flexible = (layouts: unknown[], kids: FieldMaker[] = []): Record<string, unknown> =>
      props(schemaOf([field("flexible_content", "blocks", { layouts }, kids)])).blocks!;
    expect(
      flexible(
        [{ key: "l", name: "one", label: "One" }],
        [field("text", "t", { parent_layout: "l", required: 1 })],
      ),
    ).toEqual({
      type: "array",
      title: "blocks",
      items: {
        oneOf: [
          {
            type: "object",
            title: "One",
            properties: { acf_fc_layout: { const: "one" }, t: { type: "string", title: "t" } },
            required: ["acf_fc_layout", "t"],
          },
        ],
      },
    });
    expect(flexible([])).toEqual({ type: "array", title: "blocks", items: {} });
    expect(flexible([{ key: "l", name: "bare", label: "" }])).toEqual({
      type: "array",
      title: "blocks",
      items: {
        oneOf: [
          {
            type: "object",
            properties: { acf_fc_layout: { const: "bare" } },
            required: ["acf_fc_layout"],
          },
        ],
      },
    });
  });

  test("only the top level is frontmatter: a name that collides with the contract's is kept as it is below it", () => {
    const schema = schemaOf([
      field("text", "title"),
      field("repeater", "rows", {}, [field("text", "title"), field("text", "slug")]),
      field("group", "box", {}, [field("text", "url")]),
      field("flexible_content", "blocks", { layouts: [{ key: "l", name: "n", label: "N" }] }, [
        field("text", "excerpt", { parent_layout: "l" }),
      ]),
      field("clone", "shown", { clone: ["field_title"], display: "group", prefix_name: 1 }),
    ]);
    expect(Object.keys(props(schema))).toEqual(["acf_title", "rows", "box", "blocks", "shown"]);
    expect(Object.keys((props(schema).rows!.items as { properties: object }).properties)).toEqual([
      "title",
      "slug",
    ]);
    expect(Object.keys(props(schema).box!.properties as object)).toEqual(["url"]);
    const layout = (props(schema).blocks!.items as { oneOf: { properties: object }[] }).oneOf[0]!;
    expect(Object.keys(layout.properties)).toEqual(["acf_fc_layout", "excerpt"]);
  });

  test("a seamless clone's copies are on the top level too, under the names they get there", () => {
    const base = group("Base", loc("post_type", "none"), [
      field("text", "title"),
      field("text", "city"),
    ]);
    const host = group("Host", loc("post_type", "page"), [
      field("clone", "seam", { clone: [base[0]!.slug], display: "seamless", prefix_name: 0 }),
    ]);
    const acf = loadAcf(modelOf([...base, ...host, wpPost({ type: "page" })]));
    const schema = acfSchema(acf.groups.find((g) => g.title === "Host")!.fields);
    expect(Object.keys(props(schema))).toEqual(["acf_title", "city"]);
  });

  test("fields that hold no value, and fields that have no name, are not in the schema, or read, whatever is stored under their name", () => {
    const named = (type: string): FieldMaker => field(type, "intro");
    const nameless = field("text", "", {}, [], { excerpt: "" });
    const { entry, raw } = readPage(
      [
        named("message"),
        named("accordion"),
        named("tab"),
        named("separator"),
        nameless,
        field("text", "kept"),
      ],
      {
        intro: ["stored anyway"],
        "": ["stored under nothing"],
        kept: ["yes"],
      },
    );
    expect(entry).toEqual({ kept: "yes" });
    expect(Object.keys(raw)).toEqual(["kept"]);
    const schema = schemaOf([
      named("message"),
      named("accordion"),
      named("tab"),
      named("separator"),
      nameless,
      field("text", "kept"),
    ]);
    expect(Object.keys(props(schema))).toEqual(["kept"]);
  });

  test("two fields of one name: the same kind of value is no conflict, a different one is, and the first schema stays", () => {
    const report = createReport();
    schemaOf([field("text", "same"), field("textarea", "same"), field("email", "same")], {
      report,
    });
    expect(codes(report, "acf.field-conflict")).toEqual([]);

    const typed = createReport();
    const schema = schemaOf(
      [
        field("text", "x"),
        field("number", "x"),
        field("true_false", "y"),
        field("true_false", "y"),
      ],
      { report: typed },
    );
    expect(props(schema).x!.type).toBe("string");
    const conflicts = codes(typed, "acf.field-conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.message).toContain("(string, number)");
    expect(conflicts[0]).toMatchObject({ severity: "warn", data: { name: "x" } });
    // Without a place given, the report is placed at the second field's post.
    expect(conflicts[0]!.where).toMatch(/^post:\d+$/);
  });

  test("a type that promises nothing conflicts with one that promises something, but not with another that promises nothing", () => {
    const quiet = createReport();
    schemaOf([field("acfe_a", "x"), field("acfe_b", "x")], { report: quiet });
    expect(codes(quiet, "acf.field-conflict")).toEqual([]);
    const loud = createReport();
    schemaOf([field("acfe_a", "x"), field("text", "x")], { report: loud });
    const conflicts = codes(loud, "acf.field-conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.message).toContain("(undefined, string)");
  });

  test("the place a conflict is reported at is the one the caller gave", () => {
    const report = createReport();
    schemaOf([field("text", "x"), field("number", "x")], { report, where: "collection:pages" });
    expect(codes(report, "acf.field-conflict")[0]!.where).toBe("collection:pages");
  });

  test("two fields of one name that are both required are listed once", () => {
    expect(
      schemaOf([field("text", "x", { required: 1 }), field("text", "x", { required: 1 })]).required,
    ).toEqual(["x"]);
  });

  test("the dates of the base keys are date-times, and a date that is not one fails", () => {
    const validate = ajv.compile({ type: "object", properties: BASE_PROPERTIES });
    expect(validate({ modified: "2025-08-05T19:12:20Z" })).toBe(true);
    expect(validate({ modified: "yesterday" })).toBe(false);
    expect(validate({ modified: "2025-08-05" })).toBe(false);
    expect(validate({ date: "2025-08-05" })).toBe(false);
    expect(BASE_PROPERTIES.modified).toEqual({ type: "string", format: "date-time" });
    expect(BASE_PROPERTIES.date).toEqual({ type: "string", format: "date-time" });
  });
});

describe("toEntryData: what is left out", () => {
  const f = (type: string, settings: Record<string, unknown> = {}): AcfField =>
    fieldOf(type, "x", settings);

  test("a date-time that is not a date, a file with neither id nor address, and a gallery that resolves to nothing", () => {
    const entry = toEntryData(
      {
        when: { type: "date_time_picker", field: f("date_time_picker"), value: "soon" },
        nothing: { type: "file", field: f("file") },
        pics: { type: "gallery", field: f("gallery"), ids: [1] },
        kept: {
          type: "date_time_picker",
          field: f("date_time_picker"),
          value: "x",
          iso: "2024-01-01T00:00:00Z",
        },
      },
      noHooks,
    );
    expect(entry).toEqual({ kept: "2024-01-01T00:00:00Z" });
  });

  test("a file given by id is resolved, and one given by address is that address", () => {
    const hooks: EntryHooks = {
      ...noHooks,
      attachment: (id) => (id === 3 ? { src: "/m/3.pdf", alt: "" } : undefined),
    };
    expect(
      toEntryData(
        {
          a: { type: "file", field: f("file"), id: 3 },
          b: { type: "file", field: f("file"), url: "/x.pdf" },
        },
        hooks,
      ),
    ).toEqual({
      a: { src: "/m/3.pdf", alt: "" },
      b: { src: "/x.pdf", alt: "" },
    });
  });

  test("a value several fields hold is copied: changing the entry does not change what was read", () => {
    const link = {
      type: "link" as const,
      field: f("link"),
      value: { url: "/a", title: "A", target: "" },
    };
    const entry = toEntryData({ link }, noHooks);
    (entry.link as { url: string }).url = "/changed";
    expect(link.value.url).toBe("/a");
  });
});

// ── The real Jx build ────────────────────────────────────────────────────────────────────────────

describe("the real Jx build reads the schema and the entries these functions make", () => {
  afterAll(cleanupJxProjects);

  /** The warnings Jx's content loader prints for a collection: date coercion and schema validation. */
  const complaints = (output: string): string[] =>
    output.split("\n").filter((line) => /^Content (validation|dates):/.test(line));

  const entryFile = (data: Record<string, unknown>): string =>
    `---\n${stringify(data)}---\n\nBody.\n`;

  const project = (
    collections: Record<
      string,
      { schema: Record<string, unknown>; entries: Record<string, unknown>[] }
    >,
  ): Record<string, string | object> => {
    const files: Record<string, string | object> = {
      "project.json": {
        name: "acf-test",
        url: "https://example.com",
        extensions: ["@jxsuite/parser"],
        content: Object.fromEntries(
          Object.entries(collections).map(([name, { schema }]) => [
            name,
            { source: `content/${name}`, format: "Markdown", schema },
          ]),
        ),
      },
      "pages/index.json": { title: "Home", children: [{ tagName: "p", textContent: "Home" }] },
    };
    for (const [name, { entries }] of Object.entries(collections)) {
      entries.forEach((data, i) => {
        files[`content/${name}/entry-${i}.md`] = entryFile(data);
      });
    }
    return files;
  };

  const schemaWithBase = (fields: readonly AcfField[]): Record<string, unknown> => {
    const own = acfSchema(fields);
    return {
      type: "object",
      properties: { ...BASE_PROPERTIES, ...(own.properties as object) },
      required: [...BASE_REQUIRED, ...((own.required as string[] | undefined) ?? [])],
    };
  };

  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: every published entry loads without a validation or a date warning`, async () => {
      const { model, acf } = site === "fineline" ? fineline : ap;
      const byType = new Map<string, WpPost[]>();
      for (const post of model.posts.values()) {
        if (post.status !== "publish" || post.type.startsWith("acf-")) continue;
        byType.set(post.type, [...(byType.get(post.type) ?? []), post]);
      }
      const collections: Record<
        string,
        { schema: Record<string, unknown>; entries: Record<string, unknown>[] }
      > = {};
      let withFields = 0;
      for (const [type, posts] of byType) {
        if (!["post", "page"].includes(type) && !acf.postTypes.has(type)) continue;
        const targets = posts.map((p) => postTarget(model, p));
        const fields = fieldsFor(acf, targets);
        if (fields.length === 0) continue;
        withFields += posts.length;
        collections[type] = {
          schema: schemaWithBase(fields),
          entries: posts.map((post, i) => ({
            title: post.title,
            slug: post.slug,
            date: post.date,
            modified: post.modified,
            ...toEntryData(acfValues(model, acf, targets[i]!), hooksOf(model)),
          })),
        };
      }
      expect(Object.keys(collections).length).toBeGreaterThan(0);
      expect(withFields).toBeGreaterThan(site === "fineline" ? 90 : 20);
      const built = await buildJxProject(project(collections), { name: `acf-${site}` });
      expect(complaints(built.stdout + built.stderr)).toEqual([]);
    }, 120_000);
  }

  test("dates ACF stores as 20240215 and 2024-02-15 17:30:00 are accepted by the date coercion as they come out", async () => {
    const page = wpPost({ type: "page", slug: "p" });
    const defs = group("G", loc("post_type", "page"), [
      field("date_picker", "starts", { required: 1 }),
      field("date_time_picker", "doors"),
    ]);
    const model = modelOf([...defs, page], {
      options: { timezone_string: "America/New_York" },
      meta: { [page.id]: { starts: ["20240215"], doors: ["2024-02-15 17:30:00"] } },
    });
    const acf = loadAcf(model);
    const target = postTarget(model, page);
    const entry = toEntryData(acfValues(model, acf, target), noHooks);
    expect(entry).toEqual({ starts: "2024-02-15", doors: "2024-02-15T22:30:00Z" });
    const built = await buildJxProject(
      project({
        events: {
          schema: schemaWithBase(fieldsFor(acf, [target])),
          entries: [
            {
              title: "E",
              slug: "e",
              date: "2024-02-01T00:00:00Z",
              modified: "2024-02-01T00:00:00Z",
              ...entry,
            },
          ],
        },
      }),
      { name: "acf-dates" },
    );
    expect(complaints(built.stdout + built.stderr)).toEqual([]);
  }, 60_000);

  test("the same check complains about what ACF stores unconverted, so a clean run means something", async () => {
    const page = wpPost({ type: "page", slug: "p" });
    const defs = group("G", loc("post_type", "page"), [
      field("date_picker", "starts"),
      field("number", "seats", { required: 1 }),
    ]);
    const model = modelOf([...defs, page]);
    const acf = loadAcf(model);
    const built = await buildJxProject(
      project({
        events: {
          schema: schemaWithBase(fieldsFor(acf, [postTarget(model, page)])),
          entries: [
            {
              title: "E",
              slug: "e",
              date: "2024-02-01T00:00:00Z",
              modified: "2024-02-01T00:00:00Z",
              starts: "20240215",
              seats: "12",
            },
          ],
        },
      }),
      { name: "acf-bad" },
    );
    const found = complaints(built.stdout + built.stderr);
    expect(found.some((l) => l.includes('field "starts"') && l.includes("20240215"))).toBe(true);
    expect(found.some((l) => l.includes('field "seats" expected number, got string'))).toBe(true);
  }, 60_000);
});

describe("a default that says nothing", () => {
  test("`false`, an empty string and nothing are ACF's none: no value, and nothing to report", () => {
    for (const none of [false, "", null]) {
      const { raw, report } = readPage([field("text", "a", { default_value: none })], {});
      expect(raw).toEqual({});
      expect(codes(report, "acf.value-unreadable")).toEqual([]);
    }
    // A default that is something is the value of a post that has no row.
    const { raw } = readPage([field("text", "a", { default_value: "hi" })], {});
    expect(raw.a).toMatchObject({ type: "text", value: "hi" });
  });
});

// <review-fixes>
describe("review findings: two names that become one frontmatter key lose neither value", () => {
  const fields = [field("text", "author"), field("text", "acf_author")];
  const meta = { author: ["A"], acf_author: ["B"] };

  test("both values are in the entry, the second under a numbered key", () => {
    const { entry, report } = readPage(fields, meta);
    expect(entry).toEqual({ acf_author: "A", acf_author_2: "B" });
    const found = codes(report, "acf.field-conflict");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warn" });
    expect(found[0]!.message).toContain("acf_author_2");
  });

  test("the schema lists both, under the same keys the entry has", () => {
    const { entry, acf } = readPage(fields, meta);
    const schema = acfSchema(fieldsFor(acf, [{ kind: "post", postType: "page" }]));
    expect(Object.keys(schema.properties as object).sort()).toEqual(Object.keys(entry).sort());
  });

  test("a field that is the only one of its name is kept as acf_<name>, as before", () => {
    expect(readPage([field("text", "author")], { author: ["A"] }).entry).toEqual({
      acf_author: "A",
    });
  });

  test("a numbered key that a field already has is skipped", () => {
    const { entry } = readPage(
      [field("text", "author"), field("text", "acf_author"), field("text", "acf_author_2")],
      { author: ["A"], acf_author: ["B"], acf_author_2: ["C"] },
    );
    expect(Object.values(entry).sort()).toEqual(["A", "B", "C"]);
    expect(Object.keys(entry)).toHaveLength(3);
  });

  test("two fields of one name in two groups are still one key, not a conflict", () => {
    const page = wpPost({ type: "page", slug: "p" });
    const model = modelOf(
      [
        ...group("One", loc("post_type", "page"), [field("text", "sub")]),
        ...group("Two", loc("post_type", "page"), [field("text", "sub")]),
        page,
      ],
      { meta: { [page.id]: { sub: ["x"] } } },
    );
    const report = createReport();
    const acf = loadAcf(model, report);
    const schema = acfSchema(fieldsFor(acf, [postTarget(model, page)]), { report });
    expect(Object.keys(schema.properties as object)).toEqual(["sub"]);
    expect(codes(report, "acf.field-conflict")).toEqual([]);
  });

  test("it is told when the definitions are loaded, and the plain case is only noted", () => {
    const both = readPage(fields, meta).report;
    expect(codes(both, "acf.field-name-collision")).toEqual([]);
    expect(codes(both, "acf.field-conflict")).toHaveLength(1);
    const alone = readPage([field("text", "author")], { author: ["A"] }).report;
    expect(codes(alone, "acf.field-name-collision")).toHaveLength(1);
    expect(codes(alone, "acf.field-conflict")).toEqual([]);
  });
});

describe("review findings: a name that is an Object.prototype member is a name like any other", () => {
  const names = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

  for (const name of names) {
    test(`a text field named ${name}: value, schema and entry`, () => {
      const { entry, raw, acf, report } = readPage([field("text", name)], { [name]: ["v"] });
      expect(Object.hasOwn(raw, name)).toBe(true);
      expect(Object.hasOwn(entry, name)).toBe(true);
      expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
      expect(Object.keys(entry)).toEqual([name]);
      expect(Object.getOwnPropertyDescriptor(entry, name)!.value).toBe("v");
      expect(JSON.parse(JSON.stringify(entry))[name]).toBe("v");
      const schema = acfSchema(fieldsFor(acf, [{ kind: "post", postType: "page" }]), { report });
      expect(Object.keys(schema.properties as object)).toEqual([name]);
      expect(Object.getOwnPropertyDescriptor(schema.properties, name)!.value).toMatchObject({
        type: "string",
      });
      expect(codes(report, "acf.field-conflict")).toEqual([]);
    });

    test(`a ${name} sub-field of a repeater, a group and a flexible layout`, () => {
      const { entry } = readPage(
        [
          field("repeater", "rows", {}, [field("text", name)]),
          field("group", "grp", {}, [field("text", name)]),
          field(
            "flexible_content",
            "blocks",
            { layouts: [{ key: "layout_1", name: "hero", label: "Hero" }] },
            [field("text", name, { parent_layout: "layout_1" })],
          ),
        ],
        {
          rows: ["1"],
          [`rows_0_${name}`]: ["r"],
          [`grp_${name}`]: ["g"],
          blocks: [["hero"]],
          [`blocks_0_${name}`]: ["f"],
        },
      );
      const own = (o: unknown): unknown => Object.getOwnPropertyDescriptor(o, name)?.value;
      expect(own((entry.rows as object[])[0])).toBe("r");
      expect(own(entry.grp)).toBe("g");
      expect(own((entry.blocks as object[])[0])).toBe("f");
    });
  }

  test("a field called __proto__ does not change the prototype of anything", () => {
    const { entry } = readPage([field("text", "__proto__")], JSON.parse('{"__proto__":["v"]}'));
    expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).v).toBeUndefined();
  });
});

describe("review findings: post_category and post_taxonomy name a term that must exist", () => {
  const terms = [
    {
      termId: 1,
      taxonomyId: 1,
      taxonomy: "category",
      slug: "uncategorized",
      name: "Uncategorized",
      description: "",
      parent: 0,
      count: 1,
      meta: {},
    },
    {
      termId: 5,
      taxonomyId: 5,
      taxonomy: "category",
      slug: "news",
      name: "News",
      description: "",
      parent: 0,
      count: 1,
      meta: {},
    },
    {
      termId: 9,
      taxonomyId: 9,
      taxonomy: "post_tag",
      slug: "news",
      name: "news",
      description: "",
      parent: 0,
      count: 1,
      meta: {},
    },
  ];
  const filed = (...held: { termId: number; taxonomy: string; slug: string }[]): AcfTarget =>
    page({ postType: "post", terms: held });
  const locateWith = (rules: unknown, target: AcfTarget) => {
    const defs = group("Only", rules, [field("text", "x")]);
    const report = createReport();
    const acf = loadAcf(modelOf(defs, { terms }), report);
    return { applied: groupsFor(acf, target).length === 1, report, acf, group: defs[0]! };
  };

  for (const param of ["post_category", "post_taxonomy"]) {
    test(`${param}: a term that is gone matches no post, with either operator`, () => {
      for (const target of [filed(), filed({ termId: 5, taxonomy: "category", slug: "news" })]) {
        expect(locateWith(loc(param, "category:x"), target).applied).toBe(false);
        expect(locateWith(loc(param, "category:x", "!="), target).applied).toBe(false);
        expect(locateWith(loc(param, "99", "!="), target).applied).toBe(false);
        expect(locateWith(loc(param, "99"), target).applied).toBe(false);
        // The taxonomy exists in the rule's name only: there is no such term in it.
        expect(locateWith(loc(param, "post_tag:x", "!="), target).applied).toBe(false);
      }
    });

    test(`${param}: a term that exists is matched as before`, () => {
      const news = filed({ termId: 5, taxonomy: "category", slug: "news" });
      expect(locateWith(loc(param, "category:news"), news).applied).toBe(true);
      expect(locateWith(loc(param, "category:news", "!="), news).applied).toBe(false);
      expect(locateWith(loc(param, "category:news", "!="), filed()).applied).toBe(true);
      expect(locateWith(loc(param, "post_tag:news", "!="), news).applied).toBe(true);
      expect(locateWith(loc(param, "9"), news).applied).toBe(false);
      expect(locateWith(loc(param, "9", "!="), news).applied).toBe(true);
      expect(locateWith(loc(param, "category:uncategorized"), filed()).applied).toBe(true);
    });
  }

  test("the missing term is reported, once per rule", () => {
    const { report, acf } = locateWith(loc("post_category", "category:x", "!="), filed());
    groupsFor(acf, filed());
    const found = codes(report, "acf.location-term-missing");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "warn",
      data: { param: "post_category", value: "category:x" },
    });
  });

  test("a model that holds no terms at all cannot say a term is missing", () => {
    // (WordPress always has the default category, so a model with none was loaded without its terms.)
    expect(locate(loc("post_category", "category:news", "!="), filed()).applied).toBe(true);
  });

  test("the fixtures: no rule of either site names a term that is gone", () => {
    for (const { model, acf, report } of [fineline, ap]) {
      for (const post of model.posts.values()) groupsFor(acf, postTarget(model, post));
      expect(codes(report, "acf.location-term-missing")).toEqual([]);
    }
  });
});

describe("review findings: the values of a switched-off group are still there to read", () => {
  const off = (): {
    entry: Record<string, unknown>;
    raw: Record<string, AcfRaw>;
    report: Report;
  } => {
    const page = wpPost({ type: "page", slug: "p" });
    const model = modelOf(
      [
        ...group("Old", loc("post_type", "page"), [field("text", "narrator")], {
          status: "acf-disabled",
        }),
        ...group("Live", loc("post_type", "page"), [field("text", "title2")]),
        page,
      ],
      { meta: { [page.id]: { narrator: ["N"], title2: ["T"], _narrator: ["field_narrator"] } } },
    );
    const report = createReport();
    const acf = loadAcf(model, report);
    const target = postTarget(model, page);
    const raw = acfValues(model, acf, target, { report, includeInactive: true });
    expect(Object.keys(acfValues(model, acf, target, { report: createReport() }))).toEqual([
      "title2",
    ]);
    return { entry: toEntryData(raw, noHooks), raw, report };
  };

  test("a switched-off group's fields are read when asked for", () => {
    const { entry, report } = off();
    expect(entry).toEqual({ narrator: "N", title2: "T" });
    expect(codes(report, "acf.value-orphaned")).toEqual([]);
  });

  test("groupsFor and fieldsFor take the same option, and leave inactive groups out by default", () => {
    const page = wpPost({ type: "page", slug: "p" });
    const model = modelOf([
      ...group("Old", loc("post_type", "page"), [field("text", "narrator")], {
        status: "acf-disabled",
      }),
      page,
    ]);
    const acf = loadAcf(model, createReport());
    const target = postTarget(model, page);
    expect(groupsFor(acf, target)).toEqual([]);
    expect(groupsFor(acf, target, { includeInactive: true }).map((g) => g.title)).toEqual(["Old"]);
    expect(fieldsFor(acf, [target])).toEqual([]);
    expect(fieldsFor(acf, [target], { includeInactive: true }).map((f) => f.name)).toEqual([
      "narrator",
    ]);
  });

  test("the report says only the screens are switched off, and that the values are still served", () => {
    const { report } = readPage([field("text", "a")], {});
    expect(codes(report, "acf.group-inactive")).toEqual([]);
    const model = modelOf(
      group("Old", loc("post_type", "page"), [field("text", "narrator")], {
        status: "acf-disabled",
      }),
    );
    const r = createReport();
    loadAcf(model, r);
    const message = codes(r, "acf.group-inactive")[0]!.message;
    expect(message).toContain("no screen");
    expect(message).toContain("includeInactive");
    expect(message).not.toContain("so its fields are not read");
  });

  test("on the real ap episodes (whose deprecated fields are all empty) asking for them changes nothing", () => {
    const { model, acf } = ap;
    let episodes = 0;
    for (const post of model.posts.values()) {
      if (post.type !== "episode") continue;
      episodes++;
      const target = postTarget(model, post);
      expect(acfValues(model, acf, target, { includeInactive: true })).toEqual(
        acfValues(model, acf, target),
      );
    }
    expect(episodes).toBeGreaterThan(10);
    const deprecated = acf.groups.find((g) => g.title === "Deprecated Episode Fields")!;
    const episode = postTarget(
      model,
      [...model.posts.values()].find((p) => p.type === "episode")!,
    );
    expect(groupsFor(acf, episode)).not.toContain(deprecated);
    expect(groupsFor(acf, episode, { includeInactive: true })).toContain(deprecated);
  });
});
// </review-fixes>
