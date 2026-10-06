/**
 * Routes: WordPress permalinks, the Jx route and file of every public object, and the URL tools.
 *
 * Two kinds of evidence. The hand-built models pin down what WordPress does (each expectation is
 * what `get_permalink`, `get_page_uri`, `get_term_link` and the rewrite rules produce, read from
 * wp-includes), because the fixtures only exercise two permalink structures. The fixture sites are
 * the oracle: every URL in the live sitemap of both sites must be a route's address.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createReport } from "../src/report.ts";
import { createUrlTools, buildRoutes, pathKey, type RouteOptions } from "../src/routes.ts";
import type { MediaPlan } from "../src/media.ts";
import type { AcfModel, AcfPostType, AcfTaxonomy } from "../src/wp/acf.ts";
import type { Report, WpModel, WpPost, WpSite, WpTerm, WpUser } from "../src/types.ts";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "./helpers/jx-build.ts";
import { loadSite, type SiteName } from "./helpers/ctx.ts";

// ── Hand-built models ────────────────────────────────────────────────────────────────────────────

const NOW = "2024-03-05T14:07:09.000Z";

function post(id: number, over: Partial<WpPost> = {}): WpPost {
  return {
    id,
    type: "post",
    status: "publish",
    slug: `post-${id}`,
    title: `Post ${id}`,
    content: "",
    excerpt: "",
    date: NOW,
    modified: NOW,
    parent: 0,
    menuOrder: 0,
    authorId: 1,
    guid: "",
    passwordProtected: false,
    ...over,
  };
}

function term(id: number, taxonomy: string, slug: string, parent = 0): WpTerm {
  return {
    termId: id,
    taxonomyId: id,
    taxonomy,
    slug,
    name: slug,
    description: "",
    parent,
    count: 1,
    meta: {},
  };
}

interface ModelInput {
  site?: Partial<WpSite>;
  options?: Record<string, string>;
  posts?: WpPost[];
  terms?: WpTerm[];
  termsByPost?: Record<number, number[]>;
  postMeta?: Record<number, Record<string, unknown[]>>;
  users?: WpUser[];
}

function model(input: ModelInput = {}): WpModel {
  const site: WpSite = {
    url: "https://example.com",
    home: "https://example.com",
    name: "Example",
    description: "",
    permalinkStructure: "/%postname%/",
    showOnFront: "posts",
    pageOnFront: 0,
    pageForPosts: 0,
    activePlugins: ["seo-by-rank-math/rank-math.php"],
    theme: "t",
    language: "en-US",
    ...input.site,
  };
  const posts = input.posts ?? [];
  return {
    site,
    options: new Map(Object.entries(input.options ?? {})),
    posts: new Map(posts.map((p) => [p.id, p])),
    postMeta: new Map(Object.entries(input.postMeta ?? {}).map(([id, meta]) => [Number(id), meta])),
    attachments: new Map(),
    terms: new Map((input.terms ?? []).map((t) => [t.termId, t])),
    termsByPost: new Map(Object.entries(input.termsByPost ?? {}).map(([id, t]) => [Number(id), t])),
    users: new Map(
      (input.users ?? [{ id: 1, slug: "ann", displayName: "Ann" }]).map((u) => [u.id, u]),
    ),
    menuItems: [],
    redirects: [],
  };
}

function acf(
  types: Partial<AcfPostType>[] = [],
  taxonomies: Partial<AcfTaxonomy>[] = [],
): AcfModel {
  return {
    postTypes: new Map(
      types.map((t) => [
        t.slug!,
        {
          key: "",
          postId: 0,
          active: true,
          singular: t.slug!,
          plural: t.slug!,
          hierarchical: false,
          hasArchive: false,
          rewriteSlug: t.slug!,
          rewriteWithFront: true,
          supports: [],
          taxonomies: [],
          public: true,
          labels: {},
          ...t,
        } as AcfPostType,
      ]),
    ),
    taxonomies: new Map(
      taxonomies.map((t) => [
        t.slug!,
        {
          key: "",
          postId: 0,
          active: true,
          singular: t.slug!,
          plural: t.slug!,
          objectTypes: [],
          hierarchical: false,
          rewriteSlug: t.slug!,
          rewriteWithFront: true,
          rewriteHierarchical: false,
          public: true,
          labels: {},
          ...t,
        } as AcfTaxonomy,
      ]),
    ),
    groups: [],
    optionsPages: [],
  };
}

/** Builds routes with a report; returns both. */
function build(m: WpModel, a: AcfModel = acf(), opts: RouteOptions = {}) {
  const report = createReport();
  const routes = buildRoutes(m, a, { report, attachments: false, ...opts });
  return { routes, report, codes: () => report.entries().map((e) => e.code) };
}

const wp = (routes: ReturnType<typeof build>["routes"], path: string) => routes.byWpPath(path);

/** A PHP-serialised array of strings, the way Rank Math's options are stored. */
function php(values: Record<string, string>): string {
  const entries = Object.entries(values).map(
    ([k, v]) => `s:${Buffer.byteLength(k)}:"${k}";s:${Buffer.byteLength(v)}:"${v}";`,
  );
  return `a:${entries.length}:{${entries.join("")}}`;
}

// ── Pages ────────────────────────────────────────────────────────────────────────────────────────

describe("pages", () => {
  test("a page is at its slug behind the slugs of its ancestors, and its file follows", () => {
    const { routes } = build(
      model({
        posts: [
          post(10, { type: "page", slug: "company" }),
          post(11, { type: "page", slug: "team", parent: 10 }),
          post(12, { type: "page", slug: "alice", parent: 11 }),
        ],
      }),
    );
    const route = routes.forPost(12)!;
    expect(route).toMatchObject({
      kind: "page",
      id: 12,
      wpPath: "/company/team/alice/",
      jxRoute: "/company/team/alice/",
      file: "pages/company/team/alice.json",
    });
    expect(route.reason).toBeUndefined();
    expect(routes.forPost(10)!.file).toBe("pages/company.json");
  });

  test("an ancestor that is a draft still lends its slug (get_page_uri walks post_parent whatever the status)", () => {
    const { routes } = build(
      model({
        posts: [
          post(10, { type: "page", slug: "secret", status: "draft" }),
          post(11, { type: "page", slug: "child", parent: 10 }),
        ],
      }),
    );
    expect(routes.forPost(11)!.wpPath).toBe("/secret/child/");
    expect(routes.forPost(10)).toBeUndefined();
  });

  test("a parent that is not in the model leaves the slug alone", () => {
    const { routes } = build(
      model({ posts: [post(11, { type: "page", slug: "child", parent: 99 })] }),
    );
    expect(routes.forPost(11)!.wpPath).toBe("/child/");
  });

  test("a parent cycle does not loop", () => {
    const { routes } = build(
      model({
        posts: [
          post(1, { type: "page", slug: "a", parent: 2 }),
          post(2, { type: "page", slug: "b", parent: 1 }),
        ],
      }),
    );
    expect(routes.forPost(1)!.wpPath).toBe("/b/a/");
    expect(routes.forPost(2)!.wpPath).toBe("/a/b/");
  });

  test("the front page is served at /, and its own slug URL is an alias of it", () => {
    const { routes } = build(
      model({
        site: { showOnFront: "page", pageOnFront: 10 },
        posts: [post(10, { type: "page", slug: "home-2" })],
      }),
    );
    const front = routes.forPost(10)!;
    expect(front).toMatchObject({
      kind: "front",
      wpPath: "/",
      jxRoute: "/",
      file: "pages/index.json",
      aliases: ["/home-2/"],
    });
    expect(wp(routes, "/")).toBe(front);
    expect(wp(routes, "/home-2/")).toBe(front);
    expect(wp(routes, "/home-2")).toBe(front);
  });

  test("the posts page is its own route and the blog index", () => {
    const { routes } = build(
      model({
        site: { showOnFront: "page", pageOnFront: 10, pageForPosts: 11 },
        posts: [
          post(10, { type: "page", slug: "welcome" }),
          post(11, { type: "page", slug: "essays" }),
        ],
      }),
    );
    const blog = routes.forPost(11)!;
    expect(blog).toMatchObject({
      kind: "posts-page",
      wpPath: "/essays/",
      file: "pages/essays.json",
    });
    expect(routes.forArchive("post")).toBe(blog);
  });

  test("a site that shows its posts on the front has the blog index at /", () => {
    const { routes } = build(model({ site: { showOnFront: "posts" } }));
    expect(routes.forArchive("post")).toMatchObject({
      kind: "posts-page",
      id: 0,
      wpPath: "/",
      file: "pages/index.json",
    });
    expect(wp(routes, "/")!.kind).toBe("posts-page");
  });

  test("a page called index goes under its own folder, because pages/index.json is its parent", () => {
    const { routes } = build(
      model({
        posts: [
          post(1, { type: "page", slug: "index" }),
          post(2, { type: "page", slug: "docs" }),
          post(3, { type: "page", slug: "index", parent: 2 }),
        ],
      }),
    );
    expect(routes.forPost(1)).toMatchObject({ jxRoute: "/index/", file: "pages/index/index.json" });
    expect(routes.forPost(3)).toMatchObject({
      jxRoute: "/docs/index/",
      file: "pages/docs/index/index.json",
    });
  });

  test("Jx does not route a segment that starts with an underscore: the page is renamed, said so, and reported", () => {
    const { routes, report } = build(
      model({ posts: [post(1, { type: "page", slug: "_hidden" })] }),
    );
    const route = routes.forPost(1)!;
    expect(route).toMatchObject({
      wpPath: "/_hidden/",
      jxRoute: "/hidden/",
      file: "pages/hidden.json",
    });
    expect(route.reason).toContain("underscore");
    const entry = report.entries().find((e) => e.code === "route.renamed")!;
    expect(entry).toMatchObject({ severity: "warn", where: "post:1" });
    expect(entry.url).toBe("https://example.com/?p=1");
    // The old address still finds the page.
    expect(wp(routes, "/_hidden/")).toBe(route);
  });

  test("a non-ASCII slug keeps WordPress's percent-encoding in wpPath and is readable in the Jx route", () => {
    const { routes } = build(
      model({ posts: [post(1, { type: "page", slug: "caf%c3%a9-au-lait" })] }),
    );
    const route = routes.forPost(1)!;
    expect(route.wpPath).toBe("/caf%c3%a9-au-lait/");
    expect(route.jxRoute).toBe("/café-au-lait/");
    expect(route.file).toBe("pages/café-au-lait.json");
    // Any spelling of the address finds it.
    for (const path of [
      "/caf%c3%a9-au-lait/",
      "/caf%C3%A9-au-lait",
      "/café-au-lait/",
      "/CAFÉ-au-lait/",
    ])
      expect(wp(routes, path)).toBe(route);
  });

  test("a slug that cannot be a file name is kept encoded instead of being decoded into a path", () => {
    const { routes } = build(model({ posts: [post(1, { type: "page", slug: "a%2fb" })] }));
    expect(routes.forPost(1)!.jxRoute).toBe("/a%2fb/");
    expect(routes.forPost(1)!.file).toBe("pages/a%2fb.json");
  });

  test("a page with no slug has no address: reported as unroutable", () => {
    const { routes, report } = build(model({ posts: [post(1, { type: "page", slug: "" })] }));
    expect(routes.forPost(1)).toBeUndefined();
    expect(report.entries().find((e) => e.code === "route.unroutable")).toMatchObject({
      severity: "error",
      where: "post:1",
    });
  });

  test("drafts are nobody's address and private pages are reported once", () => {
    const { routes, report } = build(
      model({
        posts: [
          post(1, { type: "page", slug: "a", status: "draft" }),
          post(2, { type: "page", slug: "b", status: "private" }),
          post(3, { type: "page", slug: "c", status: "private" }),
        ],
      }),
    );
    expect(routes.all()).toHaveLength(1); // only the blog index
    const skipped = report.entries().filter((e) => e.code === "route.skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      severity: "info",
      data: { type: "page", count: 2, status: "private" },
    });
  });

  test("a front page option that names nothing is reported", () => {
    const { report } = build(model({ site: { showOnFront: "page", pageOnFront: 77 } }));
    expect(report.entries().map((e) => e.code)).toContain("route.front-missing");
  });

  test("plain permalinks: the address is the query form, and the Jx route is still a path", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "" },
        posts: [post(5, { type: "page", slug: "about" })],
      }),
    );
    const route = routes.forPost(5)!;
    expect(route).toMatchObject({
      wpPath: "/?page_id=5",
      jxRoute: "/about/",
      file: "pages/about.json",
    });
    expect(route.reason).toContain("plain permalinks");
  });

  test("on a site that keeps index.php in its URLs the page address carries it, and both spellings resolve", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "/index.php/%postname%/" },
        posts: [post(5, { type: "page", slug: "about" }), post(6, { slug: "hello" })],
      }),
    );
    expect(routes.forPost(5)).toMatchObject({ wpPath: "/index.php/about/", jxRoute: "/about/" });
    expect(routes.forPost(6)).toMatchObject({ wpPath: "/index.php/hello/", jxRoute: "/hello/" });
    expect(wp(routes, "/about/")).toBe(routes.forPost(5));
    expect(wp(routes, "/index.php/about/")).toBe(routes.forPost(5));
  });
});

// ── Posts and the permalink structure ───────────────────────────────────────────────────────────

describe("posts", () => {
  test("/%postname%/ makes the post an entry of the post collection, rendered by pages/[slug].json", () => {
    const { routes } = build(
      model({ posts: [post(1, { slug: "hello" }), post(2, { slug: "again" })] }),
    );
    expect(routes.forPost(1)).toMatchObject({
      kind: "entry",
      wpPath: "/hello/",
      jxRoute: "/hello/",
      file: "content/post/hello.md",
      collection: "post",
      entryId: "hello",
      type: "post",
    });
    const pages = routes.dynamicPages().filter((p) => p.kind === "entries");
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      file: "pages/[slug].json",
      pattern: "/:slug",
      kind: "entries",
      source: "post",
      param: "slug",
      paths: { contentType: "post", param: "slug" },
    });
    expect(pages[0]!.routes.map((r) => r.id)).toEqual([2, 1]); // by route: /again/ before /hello/
  });

  test("a static front is the base of the dynamic page and not part of the entry id", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "/essays/%postname%/" },
        posts: [post(1, { slug: "hello" })],
      }),
    );
    expect(routes.forPost(1)).toMatchObject({
      wpPath: "/essays/hello/",
      file: "content/post/hello.md",
      entryId: "hello",
    });
    expect(routes.dynamicPages().find((p) => p.kind === "entries")).toMatchObject({
      file: "pages/essays/[slug].json",
      pattern: "/essays/:slug",
    });
  });

  test("date tags are the stored local date: 02:30 UTC is still the previous evening in New York", () => {
    const m = model({
      site: { permalinkStructure: "/blog/%year%/%monthnum%/%day%/%postname%/" },
      options: { timezone_string: "America/New_York" },
      posts: [post(1, { slug: "late", date: "2024-03-05T02:30:09.000Z" })],
    });
    const { routes } = build(m);
    expect(routes.forPost(1)).toMatchObject({
      wpPath: "/blog/2024/03/04/late/",
      entryId: "2024/03/04/late",
      file: "content/post/2024/03/04/late.md",
    });
    const page = routes.dynamicPages().find((p) => p.kind === "entries")!;
    expect(page).toMatchObject({
      file: "pages/blog/[...path].json",
      pattern: "/blog/*",
      param: "path",
      paths: { contentType: "post", param: "path" },
    });
  });

  test("a numeric gmt_offset works where there is no timezone name", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "/%year%/%monthnum%/%day%/%postname%/" },
        options: { gmt_offset: "5.5" },
        posts: [post(1, { slug: "x", date: "2024-03-05T22:00:00.000Z" })],
      }),
    );
    expect(routes.forPost(1)!.wpPath).toBe("/2024/03/06/x/");
  });

  test("%hour% %minute% %second% and %post_id% are replaced", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "/%hour%-%minute%-%second%/%post_id%/%postname%/" },
        posts: [post(41, { slug: "t", date: "2024-03-05T07:08:09.000Z" })],
      }),
    );
    expect(routes.forPost(41)!.wpPath).toBe("/07-08-09/41/t/");
  });

  test("a structure that is a bare %post_id% gives every post a numeric route", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "/archives/%post_id%" },
        posts: [post(7, { slug: "x" })],
      }),
    );
    expect(routes.forPost(7)).toMatchObject({ wpPath: "/archives/7/", entryId: "7" });
    expect(routes.trailingSlash).toBe(false);
  });

  describe("%category%", () => {
    const cats = [
      term(1, "category", "uncategorized"),
      term(2, "category", "news"),
      term(3, "category", "local", 2),
      term(4, "category", "zebra"),
    ];
    const structure = { permalinkStructure: "/%category%/%postname%/" };

    test("a post with no category gets the default category's slug alone, never its parents", () => {
      const { routes } = build(
        model({
          site: structure,
          options: { default_category: "3" },
          terms: cats,
          posts: [post(1, { slug: "a" })],
        }),
      );
      expect(routes.forPost(1)!.wpPath).toBe("/local/a/");
    });

    test("the lowest term id wins, and its ancestors come first", () => {
      const { routes } = build(
        model({
          site: structure,
          terms: cats,
          termsByPost: { 1: [4, 3] },
          posts: [post(1, { slug: "a" })],
        }),
      );
      expect(routes.forPost(1)).toMatchObject({
        wpPath: "/news/local/a/",
        entryId: "news/local/a",
        file: "content/post/news/local/a.md",
      });
      expect(routes.dynamicPages().find((p) => p.kind === "entries")!.param).toBe("path");
    });

    test("Rank Math's primary category replaces the lowest id when that post type's primary taxonomy is on", () => {
      const m = (titles: string) =>
        model({
          site: structure,
          terms: cats,
          options: { "rank-math-options-titles": titles },
          termsByPost: { 1: [2, 4] },
          postMeta: { 1: { rank_math_primary_category: ["4"] } },
          posts: [post(1, { slug: "a" })],
        });
      const on = build(m(php({ pt_post_primary_taxonomy: "category" })));
      expect(on.routes.forPost(1)!.wpPath).toBe("/zebra/a/");
      const off = build(m(php({ pt_post_primary_taxonomy: "off" })));
      expect(off.routes.forPost(1)!.wpPath).toBe("/news/a/");
    });

    test("a primary category the post does not carry is ignored", () => {
      const { routes } = build(
        model({
          site: structure,
          terms: cats,
          options: { "rank-math-options-titles": php({ pt_post_primary_taxonomy: "category" }) },
          termsByPost: { 1: [2] },
          postMeta: { 1: { rank_math_primary_category: ["4"] } },
          posts: [post(1, { slug: "a" })],
        }),
      );
      expect(routes.forPost(1)!.wpPath).toBe("/news/a/");
    });

    test("no category and no default category: reported, and the post has no route", () => {
      const { routes, report } = build(model({ site: structure, posts: [post(1, { slug: "a" })] }));
      expect(routes.forPost(1)).toBeUndefined();
      expect(report.entries().find((e) => e.code === "route.unroutable")).toMatchObject({
        where: "post:1",
      });
    });
  });

  test("%author% is the author's nicename", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "/%author%/%postname%/" },
        users: [{ id: 2, slug: "bob-b", displayName: "Bob" }],
        posts: [post(1, { slug: "a", authorId: 2 })],
      }),
    );
    expect(routes.forPost(1)!.wpPath).toBe("/bob-b/a/");
  });

  test("%tag% is not something get_permalink replaces: posts are not routed and the structure is reported once", () => {
    const { routes, report } = build(
      model({
        site: { permalinkStructure: "/%tag%/%postname%/" },
        posts: [post(1), post(2), post(3, { type: "page", slug: "about" })],
      }),
    );
    expect(routes.forPost(1)).toBeUndefined();
    expect(routes.forPost(3)!.wpPath).toBe("/about/");
    const found = report.entries().filter((e) => e.code === "route.permalink-tag");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "error", data: { tags: ["tag"] } });
  });

  test("plain permalinks: ?p=ID, and the Jx route is the slug", () => {
    const { routes } = build(
      model({ site: { permalinkStructure: "" }, posts: [post(9, { slug: "hello" })] }),
    );
    expect(routes.forPost(9)).toMatchObject({
      wpPath: "/?p=9",
      jxRoute: "/hello/",
      entryId: "hello",
    });
    expect(routes.forPost(9)!.reason).toContain("plain permalinks");
  });

  test("old slugs are aliases of the post, unless a live address already has them", () => {
    const { routes } = build(
      model({
        posts: [post(1, { slug: "new" }), post(2, { slug: "taken" })],
        postMeta: { 1: { _wp_old_slug: ["old", "taken", "new"] } },
      }),
    );
    const route = routes.forPost(1)!;
    expect(route.aliases).toEqual(["/old/"]);
    expect(wp(routes, "/old/")).toBe(route);
    expect(wp(routes, "/taken/")).toBe(routes.forPost(2));
  });

  test("two posts with one old slug: the lower id has the alias", () => {
    const { routes } = build(
      model({
        posts: [post(1, { slug: "a" }), post(2, { slug: "b" })],
        postMeta: { 1: { _wp_old_slug: ["old"] }, 2: { _wp_old_slug: ["old"] } },
      }),
    );
    expect(routes.forPost(1)!.aliases).toEqual(["/old/"]);
    expect(routes.forPost(2)!.aliases).toBeUndefined();
    expect(wp(routes, "/old/")).toBe(routes.forPost(1));
  });

  test("a post without a slug is unroutable, a private one is skipped", () => {
    const { routes, codes } = build(
      model({ posts: [post(1, { slug: "" }), post(2, { status: "private", slug: "p" })] }),
    );
    expect(routes.forPost(1)).toBeUndefined();
    expect(routes.forPost(2)).toBeUndefined();
    expect(codes()).toContain("route.unroutable");
    expect(codes()).toContain("route.skipped");
  });
});

// ── Custom post types ────────────────────────────────────────────────────────────────────────────

describe("custom post types", () => {
  const project = {
    slug: "project",
    rewriteSlug: "project",
    rewriteWithFront: false,
    hasArchive: "projects",
  };

  test("an entry sits at <rewrite slug>/<slug>, and the archive at its own slug; with_front false drops the front", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "/blog/%postname%/" },
        posts: [post(1, { type: "project", slug: "barn" })],
      }),
      acf([project]),
    );
    expect(routes.forPost(1)).toMatchObject({
      kind: "entry",
      wpPath: "/project/barn/",
      file: "content/project/barn.md",
      collection: "project",
      entryId: "barn",
    });
    expect(routes.forArchive("project")).toMatchObject({
      kind: "post-archive",
      id: "project",
      wpPath: "/projects/",
      jxRoute: "/projects/",
      file: "pages/projects.json",
    });
    expect(routes.dynamicPages().find((p) => p.source === "project")).toMatchObject({
      file: "pages/project/[slug].json",
      pattern: "/project/:slug",
    });
  });

  test("with_front true puts the permalink front before the rewrite slug and the archive slug", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "/blog/%postname%/" },
        posts: [post(1, { type: "project", slug: "barn" })],
      }),
      acf([{ ...project, rewriteWithFront: true }]),
    );
    expect(routes.forPost(1)!.wpPath).toBe("/blog/project/barn/");
    expect(routes.forArchive("project")!.wpPath).toBe("/blog/projects/");
    expect(routes.dynamicPages().find((p) => p.source === "project")!.file).toBe(
      "pages/blog/project/[slug].json",
    );
  });

  test("has_archive true uses the rewrite slug; false has no archive", () => {
    const m = model({ posts: [] });
    expect(
      build(m, acf([{ slug: "event", hasArchive: true, rewriteSlug: "events" }])).routes.forArchive(
        "event",
      )!.wpPath,
    ).toBe("/events/");
    expect(
      build(m, acf([{ slug: "event", hasArchive: false }])).routes.forArchive("event"),
    ).toBeUndefined();
  });

  test("a hierarchical type puts get_page_uri where the slug goes, and its entry id is the path below the base", () => {
    const { routes } = build(
      model({
        posts: [
          post(1, { type: "service", slug: "exterior" }),
          post(2, { type: "service", slug: "doors", parent: 1 }),
          post(3, { type: "service", slug: "front", parent: 2 }),
        ],
      }),
      acf([{ slug: "service", hierarchical: true, rewriteWithFront: false }]),
    );
    expect(routes.forPost(3)).toMatchObject({
      wpPath: "/service/exterior/doors/front/",
      entryId: "exterior/doors/front",
      file: "content/service/exterior/doors/front.md",
    });
    expect(routes.forPost(1)!.entryId).toBe("exterior");
    const page = routes.dynamicPages().find((p) => p.source === "service")!;
    expect(page).toMatchObject({
      file: "pages/service/[...path].json",
      pattern: "/service/*",
      param: "path",
    });
    expect(page.paths).toEqual({ contentType: "service", param: "path" });
  });

  test("an old slug of an entry is an alias under the type's base", () => {
    const { routes } = build(
      model({
        posts: [post(3, { type: "project", slug: "barn" })],
        postMeta: { 3: { _wp_old_slug: ["shed"] } },
      }),
      acf([{ slug: "project", rewriteWithFront: false }]),
    );
    expect(routes.forPost(3)!.aliases).toEqual(["/project/shed/"]);
    expect(wp(routes, "/project/shed/")).toBe(routes.forPost(3));
  });

  test("a type that is not hierarchical ignores post_parent", () => {
    const { routes } = build(
      model({
        posts: [
          post(1, { type: "event", slug: "a" }),
          post(2, { type: "event", slug: "b", parent: 1 }),
        ],
      }),
      acf([{ slug: "event" }]),
    );
    expect(routes.forPost(2)!.wpPath).toBe("/event/b/");
  });

  test("pretty permalinks switched off for the type: ?type=slug, and the Jx route sits under the type", () => {
    const { routes } = build(
      model({ posts: [post(1, { type: "note", slug: "hi" })] }),
      acf([{ slug: "note", rewriteSlug: false }]),
    );
    expect(routes.forPost(1)).toMatchObject({ wpPath: "/?note=hi", jxRoute: "/note/hi/" });
    expect(routes.forPost(1)!.reason).toContain("pretty permalinks");
  });

  test("a rewrite slug that holds a tag only a plugin could replace is reported, once, and routes nothing", () => {
    const { routes, report } = build(
      model({ posts: [post(1, { type: "x", slug: "a" }), post(2, { type: "x", slug: "b" })] }),
      acf([{ slug: "x", rewriteSlug: "%region%/x" }]),
    );
    expect(routes.all().filter((r) => r.kind === "entry")).toHaveLength(0);
    expect(report.entries().filter((e) => e.code === "route.rewrite-tag")).toHaveLength(1);
  });

  test("a type registered in code is routed from what the caller says; one nobody knows is reported", () => {
    const m = model({
      posts: [post(1, { type: "episode", slug: "one" }), post(2, { type: "mystery", slug: "x" })],
    });
    const { routes, report } = build(m, acf(), {
      postTypes: { episode: { rewriteSlug: "episodes", rewriteWithFront: false } },
    });
    expect(routes.forPost(1)).toMatchObject({
      wpPath: "/episodes/one/",
      file: "content/episode/one.md",
    });
    expect(routes.forPost(2)).toBeUndefined();
    expect(report.entries().find((e) => e.code === "route.unregistered")).toMatchObject({
      severity: "warn",
      where: "post-type:mystery",
      data: { count: 1 },
    });
  });

  test("a type registered in code has its archive too, at the archive slug the caller gives", () => {
    const { routes } = build(model(), acf(), {
      postTypes: {
        event: { rewriteSlug: "events", hasArchive: "calendar", rewriteWithFront: false },
      },
    });
    expect(routes.forArchive("event")).toMatchObject({
      wpPath: "/calendar/",
      file: "pages/calendar.json",
    });
  });

  test("a type ACF has switched off, or that is not public, has no address", () => {
    const { routes, codes } = build(
      model({ posts: [post(1, { type: "a", slug: "x" }), post(2, { type: "b", slug: "y" })] }),
      acf([
        { slug: "a", active: false },
        { slug: "b", public: false },
      ]),
    );
    expect(routes.forPost(1)).toBeUndefined();
    expect(routes.forPost(2)).toBeUndefined();
    expect(codes().filter((c) => c === "route.skipped")).toHaveLength(2);
  });

  test("the plugin's own types, ACF's definitions and attachments are never routed or reported", () => {
    const { routes, report } = build(
      model({
        posts: [
          post(1, { type: "cc_block", slug: "c" }),
          post(2, { type: "wp_template", slug: "t" }),
          post(3, { type: "acf-field", slug: "f" }),
          post(4, { type: "nav_menu_item", slug: "4" }),
        ],
      }),
    );
    expect(routes.all().filter((r) => r.kind === "entry")).toHaveLength(0);
    expect(report.entries().filter((e) => e.code === "route.unregistered")).toHaveLength(0);
  });

  test("the collection of a type can be renamed", () => {
    const { routes } = build(
      model({ posts: [post(1, { type: "project", slug: "barn" })] }),
      acf([{ slug: "project" }]),
      { collection: (type) => `c-${type}` },
    );
    expect(routes.forPost(1)).toMatchObject({
      collection: "c-project",
      file: "content/c-project/barn.md",
    });
  });
});

// ── Terms and authors ────────────────────────────────────────────────────────────────────────────

describe("terms", () => {
  test("category and tag archives default to /category/ and /tag/, and a category's parents come first", () => {
    const { routes } = build(
      model({
        terms: [
          term(1, "category", "news"),
          term(2, "category", "local", 1),
          term(3, "post_tag", "paint"),
        ],
      }),
    );
    expect(routes.forTerm(2)).toMatchObject({
      kind: "term",
      id: 2,
      wpPath: "/category/news/local/",
      jxRoute: "/category/news/local/",
      file: "pages/category/[...path].json",
      type: "category",
    });
    expect(routes.forTerm(1)!.file).toBe("pages/category/[...path].json");
    expect(routes.forTerm(3)).toMatchObject({
      wpPath: "/tag/paint/",
      file: "pages/tag/[slug].json",
    });
    const tags = routes.dynamicPages().find((p) => p.source === "post_tag")!;
    expect(tags.paths).toEqual({ values: ["paint"], param: "slug" });
    const categories = routes.dynamicPages().find((p) => p.source === "category")!;
    expect(categories.paths).toEqual({ values: ["news", "news/local"], param: "path" });
  });

  test("category_base and tag_base replace the base and the permalink front", () => {
    const m = (extra: Record<string, string>) =>
      model({
        site: { permalinkStructure: "/essays/%postname%/" },
        options: extra,
        terms: [term(1, "category", "news"), term(2, "post_tag", "paint")],
      });
    const plain = build(m({})).routes;
    expect(plain.forTerm(1)!.wpPath).toBe("/essays/category/news/");
    expect(plain.forTerm(2)!.wpPath).toBe("/essays/tag/paint/");
    const based = build(m({ category_base: "/topics", tag_base: "labels" })).routes;
    expect(based.forTerm(1)!.wpPath).toBe("/topics/news/");
    expect(based.forTerm(2)!.wpPath).toBe("/labels/paint/");
  });

  test("an ACF taxonomy's rewrite slug, with_front, and a flat rewrite that ignores the term's parents", () => {
    const m = model({
      site: { permalinkStructure: "/essays/%postname%/" },
      terms: [term(1, "location", "pennsylvania"), term(2, "location", "lancaster", 1)],
    });
    const flat = build(
      m,
      acf([], [{ slug: "location", rewriteSlug: "service_area", rewriteWithFront: false }]),
    ).routes;
    expect(flat.forTerm(2)).toMatchObject({
      wpPath: "/service_area/lancaster/",
      file: "pages/service_area/[slug].json",
    });
    const fronted = build(
      m,
      acf([], [{ slug: "location", rewriteSlug: "service_area", rewriteWithFront: true }]),
    ).routes;
    expect(fronted.forTerm(2)!.wpPath).toBe("/essays/service_area/lancaster/");
    const hier = build(
      m,
      acf(
        [],
        [
          {
            slug: "location",
            rewriteSlug: "service_area",
            rewriteWithFront: false,
            rewriteHierarchical: true,
          },
        ],
      ),
    ).routes;
    expect(hier.forTerm(2)).toMatchObject({
      wpPath: "/service_area/pennsylvania/lancaster/",
      file: "pages/service_area/[...path].json",
    });
  });

  test("a term whose taxonomy nothing registers is reported once per taxonomy, not routed", () => {
    const { routes, report } = build(
      model({
        terms: [
          term(1, "wpcode_tags", "a"),
          term(2, "wpcode_tags", "b"),
          term(3, "nav_menu", "main"),
        ],
      }),
    );
    expect(routes.forTerm(1)).toBeUndefined();
    const entries = report.entries().filter((e) => e.code === "route.taxonomy-unregistered");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ data: { terms: 2 } });
  });

  test("pretty permalinks switched off for a taxonomy: ?taxonomy=slug", () => {
    const { routes } = build(
      model({ terms: [term(1, "kind", "a")] }),
      acf([], [{ slug: "kind", rewriteSlug: false }]),
    );
    expect(routes.forTerm(1)).toMatchObject({ wpPath: "/?kind=a", jxRoute: "/kind/a/" });
  });

  test("Rank Math's strip-category-base serves categories at the root; the Jx site keeps the base and redirects", () => {
    const { routes, report } = build(
      model({
        options: { "rank-math-options-general": php({ strip_category_base: "on" }) },
        terms: [term(1, "category", "news")],
      }),
    );
    const route = routes.forTerm(1)!;
    expect(route).toMatchObject({ wpPath: "/news/", jxRoute: "/category/news/" });
    expect(route.reason).toContain("stripped the category base");
    expect(report.entries().filter((e) => e.code === "route.category-base-stripped")).toHaveLength(
      1,
    );
  });
});

describe("authors", () => {
  const users: WpUser[] = [
    { id: 1, slug: "ann", displayName: "Ann" },
    { id: 2, slug: "bob", displayName: "Bob" },
    { id: 3, slug: "cy", displayName: "Cy" },
  ];

  test("an author archive is /author/<nicename>/, and only users with a published post have one", () => {
    const { routes } = build(
      model({
        users,
        posts: [
          post(1, { authorId: 1, slug: "a" }),
          post(2, { authorId: 2, status: "draft", slug: "b" }),
        ],
      }),
    );
    expect(routes.forAuthor(1)).toMatchObject({
      kind: "author",
      id: 1,
      wpPath: "/author/ann/",
      jxRoute: "/author/ann/",
      file: "pages/author/[slug].json",
    });
    expect(routes.forAuthor(2)).toBeUndefined();
    expect(routes.forAuthor(3)).toBeUndefined();
    expect(routes.dynamicPages().find((p) => p.kind === "authors")!.paths).toEqual({
      values: ["ann"],
      param: "slug",
    });
  });

  test("a published entry of a public custom type counts as work too (has_published_posts)", () => {
    const { routes } = build(
      model({ users, posts: [post(1, { authorId: 3, type: "episode", slug: "e" })] }),
      acf([{ slug: "episode", rewriteSlug: "episodes" }]),
    );
    expect(routes.forAuthor(3)).toBeDefined();
  });

  test("the permalink front is part of the default base; Rank Math's url_author_base replaces base and front", () => {
    const m = (options: Record<string, string> = {}) =>
      model({
        site: { permalinkStructure: "/essays/%postname%/" },
        users,
        options,
        posts: [post(1, { authorId: 1, slug: "a" })],
      });
    expect(build(m()).routes.forAuthor(1)!.wpPath).toBe("/essays/author/ann/");
    const rm = build(m({ "rank-math-options-titles": php({ url_author_base: "People" }) })).routes;
    expect(rm.forAuthor(1)!.wpPath).toBe("/people/ann/");
    expect(rm.dynamicPages().find((p) => p.kind === "authors")!.file).toBe(
      "pages/people/[slug].json",
    );
  });

  test("Rank Math can disable author archives: none are routed, and it is said", () => {
    const { routes, codes } = build(
      model({
        users,
        options: { "rank-math-options-titles": php({ disable_author_archives: "on" }) },
        posts: [post(1, { authorId: 1, slug: "a" })],
      }),
    );
    expect(routes.forAuthor(1)).toBeUndefined();
    expect(codes()).toContain("route.author-archives-disabled");
  });

  test("the author base can be given by the caller", () => {
    const { routes } = build(
      model({ users, posts: [post(1, { authorId: 1, slug: "a" })] }),
      acf(),
      { authorBase: "writers" },
    );
    expect(routes.forAuthor(1)!.wpPath).toBe("/writers/ann/");
  });
});

describe("settings and unusual registrations", () => {
  test("the statuses that have a public page can be widened", () => {
    const m = model({
      posts: [
        post(1, { type: "page", slug: "members", status: "private" }),
        post(2, { slug: "draft-post", status: "draft" }),
      ],
    });
    expect(build(m).routes.forPost(1)).toBeUndefined();
    const wide = build(m, acf(), { statuses: ["publish", "private"] }).routes;
    expect(wide.forPost(1)).toMatchObject({ wpPath: "/members/" });
    expect(wide.forPost(2)).toBeUndefined();
  });

  test("a timezone PHP knows and the runtime does not falls back to the numeric offset", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "/%year%/%monthnum%/%day%/%postname%/" },
        options: { timezone_string: "Not/AZone", gmt_offset: "-5" },
        posts: [post(1, { slug: "x", date: "2024-03-05T02:30:00.000Z" })],
      }),
    );
    expect(routes.forPost(1)!.wpPath).toBe("/2024/03/04/x/");
  });

  test("a slug that is . or .. cannot be a file name: unroutable, said", () => {
    const { routes, report } = build(
      model({ posts: [post(1, { type: "page", slug: ".." }), post(2, { slug: "." })] }),
    );
    expect(routes.forPost(1)).toBeUndefined();
    expect(routes.forPost(2)).toBeUndefined();
    expect(report.entries().filter((e) => e.code === "route.unroutable")).toHaveLength(2);
  });

  test("a taxonomy rewrite slug with a tag is reported once and routes nothing", () => {
    const { routes, report } = build(
      model({ terms: [term(1, "kind", "a"), term(2, "kind", "b")] }),
      acf([], [{ slug: "kind", rewriteSlug: "%region%/kind" }]),
    );
    expect(routes.forTerm(1)).toBeUndefined();
    expect(report.entries().filter((e) => e.code === "route.rewrite-tag")).toHaveLength(1);
  });

  test("an archive whose type has pretty permalinks off is at ?post_type= and reported", () => {
    const { routes, report } = build(
      model(),
      acf([{ slug: "note", rewriteSlug: false, hasArchive: true }]),
    );
    expect(routes.forArchive("note")).toMatchObject({ wpPath: "/?post_type=note" });
    expect(report.entries().map((e) => e.code)).toContain("route.archive-plain");
  });

  test("plain permalinks give terms, authors and archives their query addresses", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "" },
        posts: [post(1, { slug: "a" })],
        terms: [term(5, "category", "news"), term(6, "post_tag", "paint"), term(7, "kind", "k")],
      }),
      acf([{ slug: "note", hasArchive: true }], [{ slug: "kind" }]),
    );
    expect(routes.forTerm(5)!.wpPath).toBe("/?cat=5");
    expect(routes.forTerm(6)!.wpPath).toBe("/?tag=paint");
    expect(routes.forTerm(7)!.wpPath).toBe("/?kind=k");
    expect(routes.forAuthor(1)!.wpPath).toBe("/?author=1");
    expect(routes.forArchive("note")!.wpPath).toBe("/?post_type=note");
    // They are still Jx pages.
    expect(routes.forTerm(5)!.jxRoute).toBe("/category/news/");
  });
});

// ── Attachments ──────────────────────────────────────────────────────────────────────────────────

describe("attachment pages", () => {
  const media = {
    mediaFor: (id: number) =>
      id >= 100 ? { src: `/media/2024/03/file-${id}.jpg`, alt: "" } : undefined,
    mediaForUrl: () => undefined,
  } as unknown as MediaPlan;
  const base = (rankMath: boolean, extra: ModelInput = {}) =>
    model({
      options: rankMath
        ? {
            "rank-math-options-general": php({
              attachment_redirect_urls: "on",
              attachment_redirect_default: "https://example.com",
            }),
          }
        : {},
      posts: [
        post(1, { type: "page", slug: "about" }),
        post(100, { type: "attachment", status: "inherit", slug: "team-photo", parent: 1 }),
        post(101, { type: "attachment", status: "inherit", slug: "1234", parent: 1 }),
        post(102, { type: "attachment", status: "inherit", slug: "loose-file" }),
        post(103, { type: "attachment", status: "private", slug: "hidden", parent: 1 }),
        post(104, { type: "attachment", status: "inherit", slug: "of-draft", parent: 2 }),
        post(2, { type: "page", slug: "draft", status: "draft" }),
      ],
      ...extra,
    });

  test("the address is the parent's permalink plus the slug, 'attachment/' before a numeric slug, /<slug>/ with no parent", () => {
    const { routes } = build(base(true), acf(), { attachments: true, media });
    expect(routes.forPost(100)).toMatchObject({ kind: "attachment", wpPath: "/about/team-photo/" });
    expect(routes.forPost(101)!.wpPath).toBe("/about/attachment/1234/");
    expect(routes.forPost(102)!.wpPath).toBe("/loose-file/");
    expect(wp(routes, "/about/team-photo/")).toBe(routes.forPost(100));
  });

  test("with Rank Math redirecting attachments they lead to the parent, or to the configured address when orphaned", () => {
    const { routes } = build(base(true), acf(), { attachments: true, media });
    expect(routes.forPost(100)).toMatchObject({ jxRoute: "/about/", file: "pages/about.json" });
    expect(routes.forPost(102)).toMatchObject({ jxRoute: "/", file: "pages/index.json" });
    expect(routes.forPost(100)!.reason).toContain("Rank Math");
  });

  test("without it they lead to the media file", () => {
    const { routes } = build(base(false), acf(), { attachments: true, media });
    expect(routes.forPost(100)).toMatchObject({
      jxRoute: "/media/2024/03/file-100.jpg",
      file: "public/media/2024/03/file-100.jpg",
    });
  });

  test("private attachments and those of an unpublished page have no page; attachments: false routes none", () => {
    const { routes } = build(base(true), acf(), { attachments: true, media });
    expect(routes.forPost(103)).toBeUndefined();
    expect(routes.forPost(104)).toBeUndefined();
    const off = build(base(true), acf(), { attachments: false, media }).routes;
    expect(off.all().some((r) => r.kind === "attachment")).toBe(false);
  });

  test("the parent of a front page is spelled with its own slug", () => {
    const { routes } = build(
      model({
        site: { showOnFront: "page", pageOnFront: 1 },
        posts: [
          post(1, { type: "page", slug: "home" }),
          post(100, { type: "attachment", status: "inherit", slug: "hero", parent: 1 }),
        ],
      }),
      acf(),
      { attachments: true, media },
    );
    expect(routes.forPost(100)!.wpPath).toBe("/home/hero/");
  });

  test("on plain permalinks the address is ?attachment_id=", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "" },
        posts: [post(100, { type: "attachment", status: "inherit", slug: "x" })],
      }),
      acf(),
      { attachments: true, media },
    );
    expect(routes.forPost(100)!.wpPath).toBe("/?attachment_id=100");
  });
});

// ── Collisions ───────────────────────────────────────────────────────────────────────────────────

describe("collisions", () => {
  test("a CPT archive and a page of the same address: WordPress serves the archive, the page is reported and dropped", () => {
    const { routes, report } = build(
      model({ posts: [post(5, { type: "page", slug: "services" })] }),
      acf([{ slug: "service", hasArchive: "services", rewriteWithFront: false }]),
    );
    // Not a route of its own, but WordPress served the archive for it: the id leads there.
    expect(routes.forPost(5)).toBe(wp(routes, "/services/"));
    expect(routes.all().some((r) => r.id === 5)).toBe(false);
    expect(wp(routes, "/services/")!.kind).toBe("post-archive");
    const entry = report.entries().find((e) => e.code === "route.collision")!;
    expect(entry).toMatchObject({
      severity: "warn",
      where: "post:5",
      url: "https://example.com/services/",
    });
    expect(entry.data).toMatchObject({
      on: "wordpress-path",
      loser: { kind: "page", id: 5 },
      winner: { kind: "post-archive", id: "service" },
    });
  });

  test("a page and a post at one address under /%postname%/: the page wins, as the page rules come first", () => {
    const { routes, report } = build(
      model({ posts: [post(1, { slug: "about" }), post(2, { type: "page", slug: "about" })] }),
    );
    expect(wp(routes, "/about/")!.kind).toBe("page");
    expect(routes.forPost(1)).toBe(routes.forPost(2));
    expect(routes.all().some((r) => r.kind === "entry" && r.id === 1)).toBe(false);
    expect(report.entries().find((e) => e.code === "route.collision")).toMatchObject({
      where: "post:1",
    });
  });

  test("a structure that does not start with a catch-all tag puts the post rules first: the post beats a page of the address", () => {
    const { routes, report } = build(
      model({
        site: { permalinkStructure: "/%year%/%postname%/" },
        posts: [
          post(1, { type: "page", slug: "2024" }),
          post(2, { type: "page", slug: "about", parent: 1 }),
          post(3, { slug: "about", date: "2024-06-01T12:00:00.000Z" }),
        ],
      }),
    );
    expect(wp(routes, "/2024/about/")).toMatchObject({ kind: "entry", id: 3 });
    expect(routes.forPost(2)).toBe(routes.forPost(3));
    expect(routes.all().some((r) => r.kind === "page" && r.id === 2)).toBe(false);
    expect(report.entries().find((e) => e.code === "route.collision")).toMatchObject({
      where: "post:2",
    });
  });

  test("with a date structure the post rules come first, so the post wins", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "/%postname%/" },
        posts: [post(1, { slug: "about" })],
      }),
    );
    const dated = build(
      model({
        site: { permalinkStructure: "/%year%/%postname%/" },
        posts: [post(1, { slug: "about" }), post(2, { type: "page", slug: "about" })],
      }),
    ).routes;
    expect(routes.forPost(1)).toBeDefined();
    // Different addresses: the two coexist.
    expect(dated.forPost(1)!.wpPath).toBe("/2024/about/");
    expect(dated.forPost(2)!.wpPath).toBe("/about/");
  });

  test("two addresses that become one Jx route (an underscore dropped): the address that is its own route keeps it", () => {
    const { routes, report } = build(
      model({
        posts: [post(1, { type: "page", slug: "_team" }), post(2, { type: "page", slug: "team" })],
      }),
    );
    expect(routes.forPost(2)).toMatchObject({ wpPath: "/team/", jxRoute: "/team/" });
    expect(routes.forPost(1)).toBeUndefined();
    const entry = report.entries().find((e) => e.code === "route.collision")!;
    expect(entry).toMatchObject({ where: "post:1" });
    expect(entry.data).toMatchObject({ on: "jx-route", winner: { id: 2 } });
  });

  test("a post type and a taxonomy that want one base cannot share a page file: the later by WordPress's order is dropped", () => {
    const { routes, report } = build(
      model({
        posts: [post(1, { type: "show", slug: "a" })],
        terms: [term(7, "genre", "drama")],
      }),
      acf(
        [{ slug: "show", rewriteSlug: "watch", rewriteWithFront: false }],
        [{ slug: "genre", rewriteSlug: "watch", rewriteWithFront: false }],
      ),
    );
    expect(routes.forPost(1)).toBeDefined();
    expect(routes.forTerm(7)).toBeUndefined();
    const entry = report.entries().find((e) => e.code === "route.collision")!;
    expect(entry).toMatchObject({ severity: "error", where: "taxonomy:genre" });
    expect(entry.data).toMatchObject({ on: "dynamic-page", base: "/watch/" });
  });

  test("the same collision resolves the same way whatever order the model lists things in", () => {
    const posts = [
      post(1, { type: "page", slug: "services" }),
      post(2, { type: "page", slug: "_a" }),
      post(3, { type: "page", slug: "a" }),
      post(4, { slug: "zed" }),
    ];
    const a = build(
      model({ posts }),
      acf([{ slug: "service", hasArchive: "services", rewriteWithFront: false }]),
    );
    const b = build(
      model({ posts: [...posts].reverse() }),
      acf([{ slug: "service", hasArchive: "services", rewriteWithFront: false }]),
    );
    expect(b.routes.all()).toEqual(a.routes.all());
    expect(
      b.report
        .entries()
        .map((e) => `${e.code} ${e.where}`)
        .sort(),
    ).toEqual(
      a.report
        .entries()
        .map((e) => `${e.code} ${e.where}`)
        .sort(),
    );
  });
});

// ── The table ────────────────────────────────────────────────────────────────────────────────────

describe("RouteTable", () => {
  const m = model({
    site: { showOnFront: "page", pageOnFront: 1 },
    users: [{ id: 1, slug: "ann", displayName: "Ann" }],
    posts: [
      post(1, { type: "page", slug: "home" }),
      post(2, { type: "page", slug: "about" }),
      post(3, { slug: "Hello World", authorId: 1 }),
    ],
    terms: [term(9, "post_tag", "paint")],
  });
  const { routes } = build(m);

  test("byWpPath ignores case, repeated and missing slashes, the query string and the fragment, and takes a full URL", () => {
    const about = routes.forPost(2)!;
    for (const path of [
      "/about/",
      "/about",
      "about",
      "/ABOUT/",
      "//about//",
      "/about/?utm_source=x",
      "/about/#team",
      "https://example.com/about/",
    ])
      expect(routes.byWpPath(path)).toBe(about);
    expect(routes.byWpPath("/nope/")).toBeUndefined();
    // A site without rewrite rules is reached through /index.php/…, whatever its permalinks say.
    expect(routes.byWpPath("/index.php/about/")).toBe(about);
    expect(routes.byWpPath("/index.php/")).toBe(routes.forPost(1));
  });

  test("pathKey is the one comparison", () => {
    expect(pathKey("/A%20b/C/")).toBe("/a b/c/");
    expect(pathKey("")).toBe("/");
    expect(pathKey("https://x.org/Y?z#w")).toBe("/y/");
    expect(pathKey("/%E0%A4%A/")).toBe("/%e0%a4%a/");
  });

  test("forPost, forTerm, forArchive, forAuthor answer by id", () => {
    expect(routes.forPost(1)!.kind).toBe("front");
    expect(routes.forTerm(9)!.wpPath).toBe("/tag/paint/");
    expect(routes.forAuthor(1)!.wpPath).toBe("/author/ann/");
    expect(routes.forTerm(404)).toBeUndefined();
    expect(routes.forPost(404)).toBeUndefined();
    expect(routes.forArchive("nope")).toBeUndefined();
  });

  test("all() is sorted by kind and address, and the dynamic pages by file", () => {
    const kinds = routes.all().map((r) => r.kind);
    const order = [
      "front",
      "posts-page",
      "page",
      "post-archive",
      "entry",
      "term",
      "author",
      "attachment",
    ];
    expect(kinds).toEqual([...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    const files = routes.dynamicPages().map((p) => p.file);
    expect(files).toEqual([...files].sort());
    expect(routes.trailingSlash).toBe(true);
  });

  test("an entry whose slug needs encoding is addressed readably and findable by the encoded spelling", () => {
    const entry = routes.forPost(3)!;
    expect(entry.jxRoute).toBe("/Hello World/");
    expect(entry.file).toBe("content/post/Hello World.md");
    expect(routes.byWpPath("/hello%20world/")).toBe(entry);
  });
});

// ── URL tools ────────────────────────────────────────────────────────────────────────────────────

describe("createUrlTools", () => {
  const media = {
    mediaFor: () => undefined,
    mediaForUrl: (url: string) =>
      /\/wp-content\/uploads\/2024\/03\/photo(?:-\d+x\d+)?\.jpg$/.test(url)
        ? { src: "/media/2024/03/photo.jpg" }
        : undefined,
  } as unknown as MediaPlan;
  const m = model({
    site: { showOnFront: "page", pageOnFront: 1, pageForPosts: 3 },
    users: [{ id: 1, slug: "ann", displayName: "Ann" }],
    posts: [
      post(1, { type: "page", slug: "home" }),
      post(2, { type: "page", slug: "about" }),
      post(3, { type: "page", slug: "blog" }),
      post(4, { slug: "hello", authorId: 1 }),
      post(5, { type: "project", slug: "barn" }),
    ],
    terms: [term(9, "category", "news"), term(10, "post_tag", "paint"), term(11, "location", "pa")],
  });
  const a = acf(
    [{ slug: "project", rewriteSlug: "project", hasArchive: "projects", rewriteWithFront: false }],
    [{ slug: "location", rewriteSlug: "area" }],
  );
  const routes = buildRoutes(m, a);
  const make = (report?: Report) => createUrlTools(m, routes, media, report ? { report } : {});

  test("urlFor answers for posts and terms, and says nothing for what it does not know", () => {
    const tools = make();
    expect(tools.urlFor("post", 2)).toBe("/about/");
    expect(tools.urlFor("post", 1)).toBe("/");
    expect(tools.urlFor("post", 5)).toBe("/project/barn/");
    expect(tools.urlFor("term", 9)).toBe("/category/news/");
    expect(tools.urlFor("term", 11)).toBe("/area/pa/");
    expect(tools.urlFor("post", 999)).toBeUndefined();
    expect(tools.urlFor("term", 999)).toBeUndefined();
    expect(tools.urlForArchive("project")).toBe("/projects/");
    expect(tools.urlForArchive("post")).toBe("/blog/");
    expect(tools.urlForAuthor(1)).toBe("/author/ann/");
  });

  test("permalinks in every spelling: http, https, www, siteurl, with or without the slash", () => {
    const tools = make();
    for (const url of [
      "https://example.com/about/",
      "https://example.com/about",
      "http://example.com/about/",
      "https://www.example.com/about/",
      "//example.com/about/",
      "/about/",
      "/about",
      "  https://example.com/about/  ",
    ])
      expect(tools.rewriteUrl(url)).toBe("/about/");
    expect(tools.rewriteUrl("https://example.com")).toBe("/");
    expect(tools.rewriteUrl("https://example.com/")).toBe("/");
    expect(tools.rewriteUrl("https://example.com/home/")).toBe("/");
  });

  test("the query string and the anchor are kept", () => {
    const tools = make();
    expect(tools.rewriteUrl("https://example.com/about/?utm_source=a&x=1#team")).toBe(
      "/about/?utm_source=a&x=1#team",
    );
    expect(tools.rewriteUrl("https://example.com/project/barn/#photos")).toBe(
      "/project/barn/#photos",
    );
  });

  test("?p=ID, ?page_id=ID, ?cat=ID, ?tag=slug and the other id forms resolve, and keep what they did not use", () => {
    const tools = make();
    expect(tools.rewriteUrl("https://example.com/?p=4")).toBe("/hello/");
    expect(tools.rewriteUrl("https://example.com/?page_id=2")).toBe("/about/");
    expect(tools.rewriteUrl("https://example.com/?page_id=2&utm=1#x")).toBe("/about/?utm=1#x");
    expect(tools.rewriteUrl("https://example.com/?cat=9")).toBe("/category/news/");
    expect(tools.rewriteUrl("https://example.com/?tag=paint")).toBe("/tag/paint/");
    expect(tools.rewriteUrl("https://example.com/?author=1")).toBe("/author/ann/");
    expect(tools.rewriteUrl("https://example.com/?author_name=ann")).toBe("/author/ann/");
    expect(tools.rewriteUrl("https://example.com/?post_type=project")).toBe("/projects/");
    expect(tools.rewriteUrl("https://example.com/?project=barn")).toBe("/project/barn/");
    expect(tools.rewriteUrl("https://example.com/?location=pa")).toBe("/area/pa/");
    expect(tools.rewriteUrl("https://example.com/?category_name=news")).toBe("/category/news/");
    expect(tools.rewriteUrl("/?page_id=2")).toBe("/about/");
  });

  test("uploads go through the media plan, in any size, and lose the query string but keep the anchor", () => {
    const tools = make();
    expect(tools.rewriteUrl("https://example.com/wp-content/uploads/2024/03/photo.jpg")).toBe(
      "/media/2024/03/photo.jpg",
    );
    expect(
      tools.rewriteUrl("http://www.example.com/wp-content/uploads/2024/03/photo-300x200.jpg?ver=2"),
    ).toBe("/media/2024/03/photo.jpg");
  });

  test("external addresses and things that are not addresses of a page come back unchanged and unreported", () => {
    const report = createReport();
    const tools = make(report);
    for (const url of [
      "https://other.org/about/",
      "https://example.com.evil.org/about/",
      "mailto:ann@example.com",
      "tel:+15555550100",
      "#top",
      "",
      "javascript:void(0)",
      "relative/page/",
      "data:image/png;base64,AAAA",
    ])
      expect(tools.rewriteUrl(url)).toBe(url);
    expect(report.entries()).toHaveLength(0);
  });

  test("a same-site address nothing accounts for is unchanged and reported url.unresolved, once per distinct URL", () => {
    const report = createReport();
    const tools = make(report);
    expect(tools.rewriteUrl("https://example.com/gone/")).toBe("https://example.com/gone/");
    expect(tools.rewriteUrl("https://example.com/gone/")).toBe("https://example.com/gone/");
    expect(tools.rewriteUrl("https://example.com/other/")).toBe("https://example.com/other/");
    expect(tools.rewriteUrl("https://example.com/?p=999")).toBe("https://example.com/?p=999");
    const entries = report.entries();
    expect(entries.map((e) => e.code)).toEqual([
      "url.unresolved",
      "url.unresolved",
      "url.unresolved",
    ]);
    expect(entries[0]).toMatchObject({
      severity: "warn",
      url: "https://example.com/gone/",
      data: { reason: "no-route" },
    });
    expect(entries[2]!.data).toMatchObject({ reason: "query" });
  });

  test("what the migrated site does not have is told apart: feeds, pagination, date archives, search, WordPress itself, missing uploads", () => {
    const report = createReport();
    const tools = make(report);
    const reasons: Record<string, string> = {
      "https://example.com/feed/": "feed",
      "https://example.com/about/feed/": "feed",
      "https://example.com/blog/page/2/": "pagination",
      "https://example.com/2024/03/": "date-archive",
      "https://example.com/?s=paint": "search",
      "https://example.com/wp-login.php": "wordpress",
      "https://example.com/wp-content/themes/t/style.css": "wordpress",
      "https://example.com/wp-content/uploads/2024/03/missing.jpg": "media",
    };
    for (const url of Object.keys(reasons)) expect(tools.rewriteUrl(url)).toBe(url);
    for (const entry of report.entries()) {
      expect((entry.data as { reason: string }).reason).toBe(reasons[entry.url!]!);
    }
    expect(report.entries()).toHaveLength(Object.keys(reasons).length);
  });

  test("bind() reports into another report with a location, once per URL in each", () => {
    const tools = make();
    const one = createReport();
    const two = createReport();
    const a1 = tools.bind(one, "post:1");
    const a2 = tools.bind(two, "post:2");
    a1.rewriteUrl("https://example.com/gone/");
    a1.rewriteUrl("https://example.com/gone/");
    a2.rewriteUrl("https://example.com/gone/");
    expect(one.entries()).toHaveLength(1);
    expect(one.entries()[0]!.where).toBe("post:1");
    expect(two.entries()[0]!.where).toBe("post:2");
    expect(a1.urlFor("post", 2)).toBe("/about/");
  });

  test("a WordPress installed under a path resolves addresses relative to it", () => {
    const sub = model({
      site: { url: "https://example.com/wp", home: "https://example.com/blog" },
      posts: [post(2, { type: "page", slug: "about" })],
    });
    const subRoutes = buildRoutes(sub, acf());
    const tools = createUrlTools(sub, subRoutes, media);
    expect(tools.rewriteUrl("https://example.com/blog/about/")).toBe("/about/");
    expect(tools.rewriteUrl("https://example.com/blog/")).toBe("/");
  });
});

// ── Jx builds what the table says ────────────────────────────────────────────────────────────────

afterAll(cleanupJxProjects);

describe("a real Jx build", () => {
  /** A site with every kind of route, so one build proves each file lands at its route. */
  const everything = model({
    site: {
      permalinkStructure: "/blog/%year%/%monthnum%/%postname%/",
      showOnFront: "page",
      pageOnFront: 1,
      pageForPosts: 3,
    },
    users: [{ id: 1, slug: "ann", displayName: "Ann" }],
    posts: [
      post(1, { type: "page", slug: "home" }),
      post(2, { type: "page", slug: "about" }),
      post(3, { type: "page", slug: "news" }),
      post(4, { type: "page", slug: "team", parent: 2 }),
      post(5, { type: "page", slug: "index", parent: 4 }),
      post(6, { slug: "hello", date: "2024-03-05T12:00:00.000Z" }),
      post(7, { slug: "again", date: "2023-12-31T12:00:00.000Z" }),
      post(8, { type: "service", slug: "exterior" }),
      post(9, { type: "service", slug: "doors", parent: 8 }),
      post(10, { type: "project", slug: "barn" }),
      post(11, { type: "page", slug: "caf%c3%a9" }),
      post(12, { slug: "na%c3%afve", date: "2024-03-05T12:00:00.000Z" }),
    ],
    terms: [
      term(1, "category", "news"),
      term(2, "category", "local", 1),
      term(3, "location", "pa"),
      term(4, "post_tag", "paint"),
    ],
    termsByPost: { 6: [2] },
  });
  const types = acf(
    [
      { slug: "service", hierarchical: true, rewriteWithFront: false, hasArchive: "services" },
      { slug: "project", rewriteWithFront: false, rewriteSlug: "work" },
    ],
    [{ slug: "location", rewriteSlug: "area", rewriteWithFront: false }],
  );

  test("every route's file is where Jx serves its jxRoute, entries and terms through dynamic pages included", async () => {
    const routes = buildRoutes(everything, types, { attachments: false });
    const files: Record<string, object | string> = {};
    const collections = new Set<string>();
    const doc = (title: string) => ({ title, children: [{ tagName: "p", textContent: title }] });
    for (const route of routes.all()) {
      if (route.kind === "entry") {
        collections.add(route.collection!);
        files[route.file] = `---\ntitle: ${route.entryId}\n---\n\nBody\n`;
      } else if (["front", "posts-page", "page", "post-archive"].includes(route.kind)) {
        files[route.file] = doc(route.wpPath);
      }
    }
    for (const page of routes.dynamicPages()) {
      files[page.file] =
        page.kind === "entries"
          ? {
              title: "Entry",
              $paths: page.paths,
              state: {
                entry: {
                  $prototype: "ContentEntry",
                  contentType: page.source,
                  field: "id",
                  id: { $ref: `#/$params/${page.param}` },
                  $src: "@jxsuite/parser/ContentEntry.class.json",
                },
              },
              children: [{ tagName: "h1", textContent: "${state.entry.id}" }],
            }
          : {
              title: page.source,
              $paths: page.paths,
              children: [{ tagName: "p", textContent: page.source }],
            };
    }
    const project = {
      name: "routes",
      url: "https://example.com",
      extensions: ["@jxsuite/parser"],
      content: Object.fromEntries(
        [...collections].map((c) => [
          c,
          {
            source: `content/${c}`,
            format: "Markdown",
            schema: { type: "object", properties: { title: { type: "string" } } },
          },
        ]),
      ),
    };
    const built = await buildJxProject({ ...files, "project.json": project }, { name: "routes" });
    const dist = new Set(built.list());
    const missing = routes
      .all()
      .filter((r) => r.kind !== "attachment")
      .map((r) => `${r.jxRoute.slice(1)}index.html`)
      .filter((path) => !dist.has(path));
    expect(missing).toEqual([]);
    expect(await validateJxProject(built.dir)).toMatchObject({ ok: true, problems: [] });
    // The entry id Jx hands the page is the one the table says.
    expect(built.read("blog/2024/03/hello/index.html")).toContain("2024/03/hello");
    expect(built.read("services/index.html")).toContain("/services/");
    // No two routes share a file but the dynamic ones, which render a family.
    const written = routes
      .all()
      .filter((r) => r.kind !== "attachment" && r.kind !== "entry")
      .map((r) => r.file);
    expect(new Set(written).size).toBeLessThan(written.length);
    const own = routes
      .all()
      .filter((r) => ["front", "posts-page", "page", "post-archive"].includes(r.kind))
      .map((r) => r.file);
    expect(new Set(own).size).toBe(own.length);
  }, 60_000);
});

// ── The live sites ───────────────────────────────────────────────────────────────────────────────

/**
 * The oracle: `tests/fixtures/<site>/urls.json` is the live sitemap. The fixture database keeps at
 * most 100 posts of a type, so a URL may name an object the fixture does not hold; such a URL is
 * explained by the object's absence (and checked against the whole database in the opt-in test
 * below). Anything else is a mismatch.
 */
async function sitemapReport(name: SiteName) {
  const site = await loadSite(name);
  const report = createReport();
  const routes = buildRoutes(site.model, site.acf, { report, media: site.media });
  const urls: string[] = JSON.parse(
    readFileSync(new URL(`./fixtures/${name}/urls.json`, import.meta.url), "utf8"),
  );
  return { site, routes, report, urls };
}

/** Whether the fixture model holds the object a sitemap URL names, judged from the URL's own shape. */
function holds(
  site: Awaited<ReturnType<typeof loadSite>>,
  routes: ReturnType<typeof buildRoutes>,
  path: string,
): boolean {
  const segments = pathKey(path).split("/").filter(Boolean);
  const slug = segments.at(-1) ?? "";
  const page = routes.dynamicPages().find((p) => {
    const base = p.pattern.split("/").filter((s) => s && s !== "*" && !s.startsWith(":"));
    return base.every((s, i) => segments[i] === s.toLowerCase()) && segments.length > base.length;
  });
  const published = (type: string): boolean =>
    [...site.model.posts.values()].some(
      (p) => p.type === type && p.status === "publish" && pathKey(`/${p.slug}/`) === `/${slug}/`,
    );
  if (page?.kind === "entries") return published(page.source);
  if (page?.kind === "terms")
    return [...site.model.terms.values()].some(
      (t) => t.taxonomy === page.source && pathKey(`/${t.slug}/`) === `/${slug}/`,
    );
  if (page?.kind === "authors") {
    const user = [...site.model.users.values()].find((u) => pathKey(`/${u.slug}/`) === `/${slug}/`);
    return (
      !!user &&
      [...site.model.posts.values()].some((p) => p.authorId === user.id && p.status === "publish")
    );
  }
  return [...site.model.posts.values()].some(
    (p) => p.type === "page" && p.status === "publish" && pathKey(`/${p.slug}/`) === `/${slug}/`,
  );
}

describe.each(["fineline", "ap"] as const)("%s sitemap oracle", (name) => {
  test("every URL in the live sitemap whose object the fixture holds is a route's address", async () => {
    const { site, routes, urls } = await sitemapReport(name);
    let hit = 0;
    let absent = 0;
    const wrong: string[] = [];
    for (const url of urls) {
      const path = new URL(url).pathname;
      const route = routes.byWpPath(path);
      if (route && pathKey(route.wpPath) === pathKey(path)) hit++;
      else if (!holds(site, routes, path)) absent++;
      else wrong.push(`${url} -> ${route ? route.wpPath : "no route"}`);
    }
    expect(wrong).toEqual([]);
    expect(hit + absent).toBe(urls.length);
    // Not vacuous: the match rate over what the fixture holds is total, and substantial.
    expect(hit).toBeGreaterThan(name === "fineline" ? 140 : 440);
  });

  test("every routed page, entry and archive is in the sitemap, except those the sites themselves keep out of it", async () => {
    const { routes, urls } = await sitemapReport(name);
    const listed = new Set(urls.map((u) => pathKey(new URL(u).pathname)));
    const unlisted = routes
      .all()
      .filter((r) => ["front", "posts-page", "page", "entry", "post-archive"].includes(r.kind))
      .filter((r) => !listed.has(pathKey(r.wpPath)))
      .map((r) => r.wpPath);
    // ap's /dashboard/ is noindex.
    expect(unlisted).toEqual(name === "ap" ? ["/dashboard/"] : []);
  });

  test("the front page, the posts page and the permalink structure come out as the live site has them", async () => {
    const { site, routes } = await sitemapReport(name);
    const front = routes.forPost(site.model.site.pageOnFront)!;
    expect(front).toMatchObject({
      kind: "front",
      wpPath: "/",
      jxRoute: "/",
      file: "pages/index.json",
    });
    expect(front.aliases).toEqual([name === "fineline" ? "/home-2/" : "/welcome/"]);
    const blog = routes.forPost(site.model.site.pageForPosts)!;
    expect(blog).toMatchObject({
      kind: "posts-page",
      wpPath: name === "fineline" ? "/blog/" : "/essays/",
    });
    expect(routes.forArchive("post")).toBe(blog);
  });

  test("the whole table is deterministic and every route has a file", async () => {
    const { routes } = await sitemapReport(name);
    for (const route of routes.all()) {
      expect(route.file).toMatch(/^(pages|content|public)\//);
      expect(route.jxRoute).toMatch(/^\//);
      expect(route.wpPath).toMatch(/^\//);
    }
    const again = buildRoutes((await loadSite(name)).model, (await loadSite(name)).acf, {
      media: (await loadSite(name)).media,
    });
    expect(again.all()).toEqual(routes.all());
  });
});

describe("fineline specifics", () => {
  test("/services/ is the CPT archive, not the page of that slug: the page is reported as a collision", async () => {
    const { routes, report } = await sitemapReport("fineline");
    expect(wp(routes, "/services/")).toMatchObject({
      kind: "post-archive",
      id: "service",
      file: "pages/services.json",
    });
    expect(wp(routes, "/projects/")).toMatchObject({ kind: "post-archive", id: "project" });
    const entry = report.entries().find((e) => e.code === "route.collision")!;
    expect(entry.data).toMatchObject({
      loser: { kind: "page" },
      winner: { kind: "post-archive", id: "service" },
    });
  });

  test("posts are /<slug>/, projects and services sit under their rewrite slugs without the front, locations under service_area", async () => {
    const { site, routes } = await sitemapReport("fineline");
    const first = (type: string) =>
      [...site.model.posts.values()].find((p) => p.type === type && p.status === "publish")!;
    expect(routes.forPost(first("post").id)!.wpPath).toBe(`/${first("post").slug}/`);
    expect(routes.forPost(first("project").id)!.wpPath).toBe(`/project/${first("project").slug}/`);
    expect(routes.forPost(first("service").id)!.wpPath).toMatch(/^\/service\//);
    const pages = routes.dynamicPages().map((p) => `${p.file} ${p.kind}:${p.source}`);
    expect(pages).toContain("pages/[slug].json entries:post");
    expect(pages).toContain("pages/service_area/[slug].json terms:location");
    expect(pages).toContain("pages/service/[slug].json entries:service");
  });

  test("a hierarchical service stays flat when the fixture's services have no parents", async () => {
    const { routes } = await sitemapReport("fineline");
    const service = routes.dynamicPages().find((p) => p.source === "service")!;
    expect(service.param).toBe("slug");
  });
});

describe("ap specifics", () => {
  test("posts live under /essays/, the posts page is /essays/ itself, and categories keep category_base without the front", async () => {
    const { site, routes } = await sitemapReport("ap");
    const essay = [...site.model.posts.values()].find(
      (p) => p.type === "post" && p.status === "publish",
    )!;
    expect(routes.forPost(essay.id)).toMatchObject({
      wpPath: `/essays/${essay.slug}/`,
      entryId: essay.slug,
      file: `content/post/${essay.slug}.md`,
    });
    const category = [...site.model.terms.values()].find((t) => t.taxonomy === "category")!;
    expect(routes.forTerm(category.termId)!.wpPath).toBe(`/category/${category.slug}/`);
    const tag = [...site.model.terms.values()].find((t) => t.taxonomy === "post_tag")!;
    expect(routes.forTerm(tag.termId)!.wpPath).toBe(`/tag/${tag.slug}/`);
  });

  test("series are under the front (with_front), authors under Rank Math's people base", async () => {
    const { site, routes } = await sitemapReport("ap");
    const series = [...site.model.terms.values()].find((t) => t.taxonomy === "series")!;
    expect(routes.forTerm(series.termId)!.wpPath).toBe(`/essays/series/${series.slug}/`);
    const author = routes.all().find((r) => r.kind === "author")!;
    expect(author.wpPath).toMatch(/^\/people\//);
    expect(author.file).toBe("pages/people/[slug].json");
  });

  test("captivate_podcast belongs to a plugin ACF does not know: reported, not guessed", async () => {
    const { report } = await sitemapReport("ap");
    const entry = report
      .entries()
      .find((e) => e.code === "route.unregistered" && e.where === "post-type:captivate_podcast");
    expect(entry).toMatchObject({ severity: "warn" });
  });

  test("a plugin type the caller puts under /episodes/ cannot share the page file of ACF's episodes: ACF's keeps it, and the collision is an error", async () => {
    const { site, urls } = await sitemapReport("ap");
    const report = createReport();
    const routes = buildRoutes(site.model, site.acf, {
      report,
      postTypes: { captivate_podcast: { rewriteSlug: "episodes", rewriteWithFront: false } },
      media: site.media,
    });
    expect(routes.all().some((r) => r.type === "captivate_podcast")).toBe(false);
    const entry = report
      .entries()
      .find((e) => e.code === "route.collision" && e.severity === "error")!;
    expect(entry).toMatchObject({ where: "post-type:captivate_podcast" });
    expect(entry.data).toMatchObject({
      on: "dynamic-page",
      base: "/episodes/",
      kept: { kind: "entries", source: "episode" },
      dropped: { source: "captivate_podcast" },
    });
    // The sitemap's episodes are still all there.
    const episodes = urls.filter(
      (u) => u.includes("/episodes/") && routes.byWpPath(new URL(u).pathname),
    );
    expect(episodes.length).toBeGreaterThan(90);
  });
});

// ── The whole databases ──────────────────────────────────────────────────────────────────────────

/**
 * The complete cross-check: the full database through `loadModel` against the whole sitemap. It
 * needs the throwaway MariaDB (scripts/dev-db.sh start), so it only runs on request:
 * `WP2JX_FULL_DB=1 bun test --isolate tests/routes.test.ts`.
 *
 * The dump is older than the live sites: these sitemap URLs name objects it does not hold (pages
 * and posts created after it was taken; checked by slug against the database and, for /events/,
 * on the live page, which has page-id 16325 where the dump's highest id is 16267).
 */
const STALE_DUMP: Record<string, string[]> = {
  fineline: [
    "/project/interior-paint-project-in-lancaster/",
    "/project/log-cabin-staining-project-in-fairfield/",
    "/project/interior-paint-project-in-lebanon-pa/",
  ],
  ap: [
    "/events/",
    "/episodes/for-37-years-i-thought-my-church-made-me-a-christian-it-didnt/",
    "/episodes/evolutionary-biology-phd-but-also-young-earth-creationist-heres-why/",
  ],
};

describe.skipIf(!process.env.WP2JX_FULL_DB)("the full databases", () => {
  test.each([
    ["fineline", "s212682_fineline", "KjLnF_"],
    ["ap", "s142094_anabapti", "wp_"],
  ] as const)(
    "%s: the whole sitemap is accounted for",
    async (name, database, prefix) => {
      const { openDb } = await import("../src/wp/db.ts");
      const { loadModel } = await import("../src/wp/model.ts");
      const { loadAcf } = await import("../src/wp/acf.ts");
      const db = await openDb(`mysql://root@127.0.0.1:3399/${database}`, { prefix });
      const full = await loadModel(db);
      await db.close();
      const routes = buildRoutes(full, loadAcf(full, createReport()), { attachments: false });
      const urls: string[] = JSON.parse(
        readFileSync(new URL(`./fixtures/${name}/urls.json`, import.meta.url), "utf8"),
      );
      const missing = urls
        .map((u) => new URL(u).pathname)
        .filter((path) => {
          const route = routes.byWpPath(path);
          return !route || pathKey(route.wpPath) !== pathKey(path);
        });
      expect(missing.sort()).toEqual([...STALE_DUMP[name]!].sort());
    },
    120_000,
  );
});

// ── Review findings ──────────────────────────────────────────────────────────────────────────────

describe("uploads served from another host", () => {
  const cdn = "https://media.example.org";
  const media = {
    mediaFor: () => undefined,
    mediaForUrl: (url: string) => {
      const m = /^(?:https?:)?\/\/media\.example\.org\/(.+?)(?:-\d+x\d+)?(\.\w+)$/.exec(
        url.replace(/[?#].*$/s, ""),
      );
      return m ? { src: `/media/${m[1]}${m[2]}` } : undefined;
    },
  } as unknown as MediaPlan;
  const m = model({ posts: [post(1, { slug: "hello" })] });
  const tools = (report?: Report) =>
    createUrlTools(m, buildRoutes(m, acf()), media, report ? { report } : {});

  test("an uploads URL on a CDN host is the media plan's path, in every spelling, with the anchor kept", () => {
    const t = tools();
    expect(t.rewriteUrl(`${cdn}/2024/03/photo.jpg`)).toBe("/media/2024/03/photo.jpg");
    expect(t.rewriteUrl(`${cdn}/2024/03/photo-300x200.jpg?ver=2#top`)).toBe(
      "/media/2024/03/photo.jpg#top",
    );
    expect(t.rewriteUrl("//media.example.org/2024/03/photo.jpg")).toBe("/media/2024/03/photo.jpg");
  });

  test("a URL on another host that the plan does not ship is still returned as it was, unreported", () => {
    const report = createReport();
    const t = tools(report);
    for (const url of ["https://other.org/a.jpg", `${cdn}/page/`, "//other.org/x"])
      expect(t.rewriteUrl(url)).toBe(url);
    expect(report.entries()).toHaveLength(0);
  });

  test("anabaptistperspectives: every attachment guid (on media.anabaptistperspectives.org) becomes its /media path", async () => {
    const site = await loadSite("ap");
    const routes = buildRoutes(site.model, site.acf, { media: site.media });
    const t = createUrlTools(site.model, routes, site.media);
    let foreign = 0;
    for (const att of [...site.model.attachments.values()].slice(0, 300)) {
      const expected = site.media.mediaForUrl(att.url)?.src;
      if (!expected) continue;
      if (new URL(att.url).host !== new URL(site.model.site.home).host) foreign++;
      expect(t.rewriteUrl(att.url)).toBe(expected);
    }
    expect(foreign).toBeGreaterThan(100);
  });
});

describe("an object that lost its address", () => {
  const services = (extra: ModelInput = {}) =>
    model({
      posts: [post(5, { type: "page", slug: "services" })],
      ...extra,
    });
  const types = () => acf([{ slug: "service", hasArchive: "services", rewriteWithFront: false }]);

  test("a page that loses to a CPT archive still answers forPost and urlFor with the winner's route, and stays out of all()", () => {
    const m = services();
    const { routes } = build(m, types());
    const archive = routes.forArchive("service")!;
    expect(routes.forPost(5)).toBe(archive);
    expect(routes.all().filter((r) => r.id === 5)).toEqual([]);
    expect(routes.all().filter((r) => r === archive)).toHaveLength(1);
    expect(
      routes.dynamicPages().some((p) => p.routes.some((r) => r.id === 5 || r.id === "service")),
    ).toBe(false);
    const tools = createUrlTools(m, routes, {
      mediaFor: () => undefined,
      mediaForUrl: () => undefined,
    } as unknown as MediaPlan);
    expect(tools.urlFor("post", 5)).toBe("/services/");
    expect(tools.rewriteUrl("https://example.com/services/")).toBe("/services/");
  });

  test("a term that loses an address to another term answers forTerm with the winner's route", () => {
    const { routes } = build(
      model({ terms: [term(7, "genre", "drama"), term(8, "mood", "drama")] }),
      acf(
        [],
        [
          { slug: "genre", rewriteSlug: "topic", rewriteWithFront: false },
          { slug: "mood", rewriteSlug: "topic", rewriteWithFront: false },
        ],
      ),
    );
    expect(routes.forTerm(7)).toMatchObject({ kind: "term", id: 7 });
    expect(routes.forTerm(8)).toBe(routes.forTerm(7));
    expect(routes.all().some((r) => r.kind === "term" && r.id === 8)).toBe(false);
  });

  test("an object nobody serves at all (a draft) still has no route", () => {
    const { routes } = build(
      services({
        posts: [post(5, { type: "page", slug: "services" }), post(6, { status: "draft" })],
      }),
      types(),
    );
    expect(routes.forPost(6)).toBeUndefined();
  });

  test("the fineline /services/ page (menu items 6069 and 6113 point at it) has the archive's route", async () => {
    const { site, routes } = await sitemapReport("fineline");
    const page = [...site.model.posts.values()].find(
      (p) => p.type === "page" && p.slug === "services",
    );
    expect(page).toBeDefined();
    expect(routes.forPost(page!.id)).toBe(routes.forArchive("service"));
    for (const item of site.model.menuItems.filter((i) => i.kind === "post_type"))
      expect(routes.forPost(item.objectId)).toBeDefined();
  });
});

describe("attachment collisions", () => {
  const media = {
    mediaFor: () => undefined,
    mediaForUrl: () => undefined,
  } as unknown as MediaPlan;

  test("two attachments with one slug under one parent: the earlier is the winner the report names, and the loser's id still resolves", () => {
    const { routes, report } = build(
      model({
        posts: [
          post(1, { type: "page", slug: "gallery" }),
          post(30, { type: "attachment", status: "inherit", slug: "image", parent: 1 }),
          post(31, { type: "attachment", status: "inherit", slug: "image", parent: 1 }),
        ],
      }),
      acf(),
      { attachments: true, media },
    );
    const entry = report.entries().find((e) => e.code === "route.collision")!;
    expect(entry.where).toBe("post:31");
    expect(entry.data).toMatchObject({
      on: "wordpress-path",
      loser: { kind: "attachment", id: 31 },
      winner: { kind: "attachment", id: 30 },
    });
    expect(entry.message).toContain("attachment");
    expect(entry.message).not.toContain("another object");
    expect(routes.forPost(31)).toBe(routes.forPost(30));
    expect(routes.all().filter((r) => r.kind === "attachment")).toHaveLength(1);
  });

  test("an attachment page that meets a page still names the page as the winner", () => {
    const { report } = build(
      model({
        posts: [
          post(1, { type: "page", slug: "gallery" }),
          post(2, { type: "page", slug: "image", parent: 1 }),
          post(30, { type: "attachment", status: "inherit", slug: "image", parent: 1 }),
        ],
      }),
      acf(),
      { attachments: true, media },
    );
    const entry = report.entries().find((e) => e.code === "route.collision")!;
    expect(entry.data).toMatchObject({
      loser: { kind: "attachment", id: 30 },
      winner: { kind: "page", id: 2 },
    });
  });

  test("with %category% in the structure the attachment address has the attachment/ marker, as get_attachment_link writes it", () => {
    const { routes } = build(
      model({
        site: { permalinkStructure: "/%category%/%postname%/" },
        posts: [
          post(1, { slug: "hello" }),
          post(30, { type: "attachment", status: "inherit", slug: "pic", parent: 1 }),
        ],
        terms: [term(2, "category", "news")],
        termsByPost: { 1: [2] },
      }),
      acf(),
      { attachments: true, media },
    );
    expect(routes.forPost(1)!.wpPath).toBe("/news/hello/");
    expect(routes.forPost(30)!.wpPath).toBe("/news/hello/attachment/pic/");
  });
});

describe("dates that are not dates, and slugs that are not slugs", () => {
  const dated = (date: string, options: Record<string, string> = {}) =>
    build(
      model({
        site: { permalinkStructure: "/%year%/%monthnum%/%postname%/" },
        options,
        posts: [post(1, { slug: "hello", date }), post(2, { slug: "fine" })],
      }),
    );

  test.each(["", "garbage", "0000-00-00 00:00:00"])(
    "a post dated %p has no address when the structure needs its date: reported, not routed as /0NaN/NaN/",
    (date) => {
      const { routes, report } = dated(date);
      expect(routes.forPost(1)).toBeUndefined();
      expect(routes.all().some((r) => r.wpPath.includes("NaN"))).toBe(false);
      const entry = report.entries().find((e) => e.code === "route.unroutable")!;
      expect(entry).toMatchObject({ severity: "error", where: "post:1" });
      expect(entry.message).toContain("date");
      expect(routes.forPost(2)).toMatchObject({
        wpPath: "/2024/03/post-2/".replace("post-2", "fine"),
      });
    },
  );

  test("a gmt_offset that moves the date out of range is reported the same way", () => {
    const { routes, report } = dated(NOW, { gmt_offset: "99999999999" });
    expect(routes.forPost(1)).toBeUndefined();
    expect(report.entries().some((e) => e.code === "route.unroutable")).toBe(true);
  });

  test("a structure with no date tag does not care what the post's date is", () => {
    const { routes, codes } = build(model({ posts: [post(1, { slug: "hello", date: "" })] }));
    expect(routes.forPost(1)!.wpPath).toBe("/hello/");
    expect(codes()).not.toContain("route.unroutable");
  });

  test("a term whose slug is empty or '..' is reported, not skipped silently", () => {
    const { routes, report } = build(
      model({
        terms: [term(7, "category", ""), term(8, "post_tag", ".."), term(9, "post_tag", "ok")],
      }),
    );
    expect(routes.forTerm(7)).toBeUndefined();
    expect(routes.forTerm(8)).toBeUndefined();
    expect(routes.forTerm(9)).toBeDefined();
    const where = report
      .entries()
      .filter((e) => e.code === "route.unroutable")
      .map((e) => e.where);
    expect(where).toEqual(["term:7", "term:8"]);
  });

  test("an author whose nicename cannot be a path segment is reported", () => {
    const { routes, report } = build(
      model({
        users: [
          { id: 1, slug: "ann", displayName: "Ann" },
          { id: 2, slug: "..", displayName: "Dots" },
          { id: 3, slug: "", displayName: "None" },
        ],
        posts: [
          post(1, { slug: "a", authorId: 1 }),
          post(2, { slug: "b", authorId: 2 }),
          post(3, { slug: "c", authorId: 3 }),
        ],
      }),
    );
    expect(routes.forAuthor(1)).toBeDefined();
    expect(routes.forAuthor(2)).toBeUndefined();
    expect(routes.forAuthor(3)).toBeUndefined();
    const where = report
      .entries()
      .filter((e) => e.code === "route.unroutable")
      .map((e) => e.where);
    expect(where).toEqual(["user:2", "user:3"]);
  });
});

describe("Rank Math is only read while it is active", () => {
  const titles = php({ url_author_base: "people" });
  const general = php({ strip_category_base: "on" });
  const input = (activePlugins: string[]) =>
    model({
      site: { activePlugins },
      options: { "rank-math-options-titles": titles, "rank-math-options-general": general },
      posts: [post(1, { slug: "hello", authorId: 1 })],
      terms: [term(2, "category", "news")],
    });

  test("with the plugin active its author base and stripped category base apply", () => {
    const { routes } = build(input(["seo-by-rank-math/rank-math.php"]));
    expect(routes.forAuthor(1)!.wpPath).toBe("/people/ann/");
    expect(routes.forTerm(2)!.wpPath).toBe("/news/");
  });

  test("with it deactivated the options it left behind are ignored, as WordPress ignores them", () => {
    const { routes } = build(input([]));
    expect(routes.forAuthor(1)!.wpPath).toBe("/author/ann/");
    expect(routes.forTerm(2)!.wpPath).toBe("/category/news/");
  });

  test("a deactivated plugin's author-archive switch does not remove the author pages", () => {
    const { routes } = build(
      model({
        site: { activePlugins: [] },
        options: { "rank-math-options-titles": php({ disable_author_archives: "on" }) },
        posts: [post(1, { slug: "hello", authorId: 1 })],
      }),
    );
    expect(routes.forAuthor(1)).toBeDefined();
  });
});

describe("old slugs are only redirected for what WordPress redirects", () => {
  test("a hierarchical type has no old-slug aliases (wp_old_slug_redirect returns for it); a flat one does", () => {
    const { routes } = build(
      model({
        posts: [
          post(1, { type: "service", slug: "exterior" }),
          post(2, { type: "service", slug: "doors", parent: 1 }),
          post(3, { type: "project", slug: "barn" }),
        ],
        postMeta: { 2: { _wp_old_slug: ["gates"] }, 3: { _wp_old_slug: ["shed"] } },
      }),
      acf([
        { slug: "service", hierarchical: true, rewriteWithFront: false },
        { slug: "project", rewriteWithFront: false },
      ]),
    );
    expect(routes.forPost(2)!.aliases).toBeUndefined();
    expect(wp(routes, "/service/exterior/gates/")).toBeUndefined();
    expect(routes.forPost(3)!.aliases).toEqual(["/project/shed/"]);
  });
});

describe("%hour% is a 24-hour clock in the site's own zone", () => {
  const at = (iso: string) =>
    build(
      model({
        site: { permalinkStructure: "/%hour%-%minute%/%postname%/" },
        options: { timezone_string: "America/New_York" },
        posts: [post(1, { slug: "t", date: iso })],
      }),
    ).routes.forPost(1)!.wpPath;

  test("an afternoon, an evening and the first hour after midnight", () => {
    expect(at("2024-03-05T20:30:00.000Z")).toBe("/15-30/t/");
    expect(at("2024-03-05T23:05:00.000Z")).toBe("/18-05/t/");
    expect(at("2024-03-05T05:05:00.000Z")).toBe("/00-05/t/");
  });
});
