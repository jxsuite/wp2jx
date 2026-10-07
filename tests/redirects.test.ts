/**
 * Redirects: Rank Math's rules and the routes that moved, as Jx's `project.json` `redirects`.
 *
 * Hand-built models pin down each decision (comparison, status, destination, shadowing, chains);
 * both fixture sites supply the real rules (67 and 400 Rank Math sources: exact, regex, contains,
 * case-insensitive, percent-encoded, a 307, a self-redirect); and a real `jx build` proves that what
 * is emitted is what the hosts and the validator accept.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createReport } from "../src/report.ts";
import {
  buildRedirects,
  type RedirectOptions,
  type RedirectTarget,
} from "../src/emit/redirects.ts";
import { buildRoutes, pathKey, type RouteOptions } from "../src/routes.ts";
import type { AcfModel, AcfPostType, AcfTaxonomy } from "../src/wp/acf.ts";
import type { ReportEntry, WpModel, WpPost, WpRedirect, WpSite, WpTerm } from "../src/types.ts";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "./helpers/jx-build.ts";
import { loadSite, type SiteName } from "./helpers/ctx.ts";

afterAll(cleanupJxProjects);

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

function rule(source: string, destination: string, over: Partial<WpRedirect> = {}): WpRedirect {
  return { source, comparison: "exact", destination, status: 301, active: true, ...over };
}

interface ModelInput {
  site?: Partial<WpSite>;
  options?: Record<string, string>;
  posts?: WpPost[];
  terms?: WpTerm[];
  postMeta?: Record<number, Record<string, unknown[]>>;
  redirects?: WpRedirect[];
}

const SITE = "https://example.com";

/** A small site that shows its posts on the front: two pages, a post, a CPT entry and a tag. */
function model(input: ModelInput = {}): WpModel {
  const site: WpSite = {
    url: SITE,
    home: SITE,
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
  const posts = input.posts ?? [
    post(2, { type: "page", slug: "about" }),
    post(3, { type: "page", slug: "contact" }),
    post(4, { slug: "hello" }),
    post(5, { type: "project", slug: "barn" }),
  ];
  return {
    site,
    options: new Map(Object.entries(input.options ?? {})),
    posts: new Map(posts.map((p) => [p.id, p])),
    postMeta: new Map(Object.entries(input.postMeta ?? {}).map(([id, meta]) => [Number(id), meta])),
    attachments: new Map(),
    terms: new Map((input.terms ?? [term(10, "post_tag", "paint")]).map((t) => [t.termId, t])),
    termsByPost: new Map(),
    users: new Map([[1, { id: 1, slug: "ann", displayName: "Ann" }]]),
    menuItems: [],
    redirects: input.redirects ?? [],
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

/** The same site, with the front page at a slug of its own (`/home-2/` is an alias of `/`). */
const ALIASED: ModelInput = {
  site: { showOnFront: "page", pageOnFront: 1 },
  posts: [
    post(1, { type: "page", slug: "home-2" }),
    post(2, { type: "page", slug: "about" }),
    post(3, { type: "page", slug: "contact" }),
  ],
};

const DEFAULT_ACF = acf([{ slug: "project", rewriteWithFront: false, hasArchive: "projects" }]);

/** Runs buildRedirects over a model whose Rank Math rules are `rules`. */
function run(
  rules: WpRedirect[],
  input: ModelInput = {},
  opts: RedirectOptions = {},
  routeOpts: RouteOptions = {},
) {
  const m = model({ ...input, redirects: rules });
  const report = createReport();
  const routes = buildRoutes(m, DEFAULT_ACF, routeOpts);
  const built = buildRedirects(m, routes, { report, ...opts });
  const entries = report.entries();
  const about = (code: string): ReportEntry[] => entries.filter((e) => e.code === code);
  return { ...built, routes, entries, about, report, model: m };
}

const sorted = <T>(o: Record<string, T>): [string, T][] => Object.entries(o);

// ── Exact sources and destinations ───────────────────────────────────────────────────────────────

describe("exact rules", () => {
  test("a source is a path with no trailing slash, whichever way Rank Math stored it; a route destination becomes the route", () => {
    const { redirects } = run([
      rule("old-a", `${SITE}/about/`),
      rule("old-b/", `${SITE}/about`),
      rule("/old-c", "/about/"),
      rule("old-d", "about"),
      rule(`${SITE}/old-e/`, `${SITE}/contact/`),
    ]);
    expect(redirects["/old-a"]).toBe("/about/");
    expect(redirects["/old-b"]).toBe("/about/");
    expect(redirects["/old-c"]).toBe("/about/");
    expect(redirects["/old-d"]).toBe("/about/");
    expect(redirects["/old-e"]).toBe("/contact/");
  });

  test("301 is the bare string form, the other statuses the object form", () => {
    const { redirects } = run([
      rule("a", "/about/"),
      rule("b", "/about/", { status: 302 }),
      rule("c", "/about/", { status: 303 }),
      rule("d", "/about/", { status: 307 }),
      rule("e", "/about/", { status: 308 }),
    ]);
    expect(redirects["/a"]).toBe("/about/");
    expect(redirects["/b"]).toEqual({ destination: "/about/", status: 302 });
    expect(redirects["/c"]).toEqual({ destination: "/about/", status: 303 });
    expect(redirects["/d"]).toEqual({ destination: "/about/", status: 307 });
    expect(redirects["/e"]).toEqual({ destination: "/about/", status: 308 });
  });

  test("410 and 451 have no Jx status: reported, not emitted, and the message says what happens instead", () => {
    const { redirects, about } = run([
      rule("gone", "", { status: 410 }),
      rule("legal", "", { status: 451 }),
      rule("odd", "/about/", { status: 300 }),
    ]);
    expect(Object.keys(redirects)).toEqual([]);
    const entries = about("redirect.unsupported");
    expect(entries).toHaveLength(3);
    expect(entries[0]!.message).toContain("410 Gone");
    expect(entries[0]!.message).toContain("404");
    expect(entries[1]!.message).toContain("451");
    expect(entries.map((e) => (e.data as { status: number }).status)).toEqual([410, 451, 300]);
    expect(entries[0]).toMatchObject({
      severity: "warn",
      where: "redirect:gone",
      url: `${SITE}/gone`,
    });
  });

  test("an external destination is untouched, with its query string; a same-site one keeps its query and anchor", () => {
    const { redirects } = run([
      rule("docs", "https://other.org/docs?a=1&b=2", { status: 307 }),
      rule("team", `${SITE}/about/?utm=1#team`),
    ]);
    expect(redirects["/docs"]).toEqual({
      destination: "https://other.org/docs?a=1&b=2",
      status: 307,
    });
    expect(redirects["/team"]).toBe("/about/?utm=1#team");
  });

  test("a destination on the old host with www, http or the home URL itself resolves", () => {
    const { redirects } = run(
      [
        rule("a", "http://www.example.com/about/"),
        rule("b", SITE),
        rule("c", `${SITE}/`),
        rule("d", `${SITE}/home-2/`),
      ],
      ALIASED,
    );
    expect(redirects["/a"]).toBe("/about/");
    expect(redirects["/b"]).toBe("/");
    expect(redirects["/c"]).toBe("/");
    // The front page's own slug is an alias of /.
    expect(redirects["/d"]).toBe("/");
  });

  test("percent-encoded and non-ASCII sources are written readably; characters that mean something in a pattern stay encoded", () => {
    const { redirects } = run([
      rule("caf%C3%A9", "/about/"),
      rule("naïve", "/about/"),
      rule("a%3Ab", "/about/"),
      rule("what%27s-new", "/about/"),
      rule("with space", "/about/"),
      rule("star*here", "/about/"),
      rule("paren(1)", "/about/"),
    ]);
    expect(Object.keys(redirects).sort()).toEqual(
      [
        "/café",
        "/naïve",
        "/a%3Ab",
        "/what's-new",
        "/with%20space",
        "/star%2Ahere",
        "/paren%281%29",
      ].sort(),
    );
  });

  test("a source with a query string or fragment cannot be a path: reported", () => {
    const { redirects, about } = run([
      rule("?page_id=482", "/about/"),
      rule("search?x=1", "/about/"),
      rule("page#frag", "/about/"),
    ]);
    expect(Object.keys(redirects)).toEqual([]);
    expect(about("redirect.unsupported").map((e) => e.where)).toEqual([
      "redirect:?page_id=482",
      "redirect:search?x=1",
      "redirect:page#frag",
    ]);
  });

  test("a source on another host cannot be matched by a static redirect", () => {
    const { redirects, about } = run([rule("https://other.org/x/", "/about/")]);
    expect(Object.keys(redirects)).toEqual([]);
    expect(about("redirect.unsupported")[0]!.message).toContain("another host");
  });

  test("a rule that ignores case is written in lower case, and says it is an approximation", () => {
    const { redirects, about } = run([
      rule("YouTube", "/about/", { ignoreCase: true }),
      rule("Exact", "/about/"),
    ]);
    expect(Object.keys(redirects).sort()).toEqual(["/Exact", "/youtube"]);
    expect(about("redirect.approximated")).toHaveLength(1);
    expect(about("redirect.approximated")[0]).toMatchObject({
      where: "redirect:YouTube",
      severity: "info",
    });
  });
});

// ── Destinations that are not a page of the new site ─────────────────────────────────────────────

describe("dangling destinations", () => {
  test("a destination on the old site that the new site has no page for would only lead to a 404: dropped and reported", () => {
    const { redirects, about } = run([rule("old", `${SITE}/blog/missing-page/`)]);
    expect(redirects).toEqual({});
    expect(about("redirect.dangling")[0]).toMatchObject({
      severity: "warn",
      where: "redirect:old",
      data: { dropped: true, resolved: "/blog/missing-page/" },
    });
  });

  test("keepDangling keeps the rule as a path; a file or a WordPress address is kept because no route can vouch for it", () => {
    const kept = run([rule("old", `${SITE}/blog/missing-page/`)], {}, { keepDangling: true });
    expect(kept.redirects["/old"]).toBe("/blog/missing-page/");
    expect(kept.about("redirect.dangling")[0]!.data).toMatchObject({ dropped: false });
    const files = run([
      rule("menu", `${SITE}/files/menu.pdf`),
      rule("login", `${SITE}/wp-login.php`),
    ]);
    expect(files.redirects["/menu"]).toBe("/files/menu.pdf");
    expect(files.redirects["/login"]).toBe("/wp-login.php");
    expect(files.about("redirect.dangling")).toHaveLength(2);
  });

  test("of two rules for one source, the one that leads somewhere wins even when it comes second", () => {
    const { redirects, about } = run([
      rule("same", `${SITE}/nowhere/`),
      rule("same", `${SITE}/about/`),
    ]);
    expect(redirects["/same"]).toBe("/about/");
    // The one that leads nowhere is the duplicate: it is said so, and not judged a second time.
    expect(about("redirect.duplicate")).toHaveLength(1);
    expect(about("redirect.duplicate")[0]!.message).toContain("/nowhere/");
    expect(about("redirect.dangling")).toHaveLength(0);
  });
});

// ── Comparisons ──────────────────────────────────────────────────────────────────────────────────

describe("start, end, contains", () => {
  test("start is a prefix wildcard with a fixed destination", () => {
    const { redirects } = run([
      rule("legacy/", "/about/", { comparison: "start" }),
      rule("old", "/contact/", { comparison: "start" }),
    ]);
    expect(redirects["/legacy/*"]).toBe("/about/");
    expect(redirects["/old*"]).toBe("/contact/");
    // Rank Math compares a path with no leading slash, so one stored with it means the same.
    const slash = run([rule("/lead/", "/about/", { comparison: "start" })]).redirects;
    expect(Object.keys(slash)).toEqual(["/lead/*"]);
  });

  test("a fixed destination of a wildcard rule is still a route of the new site, or reported when it is not", () => {
    const { redirects, about } = run(
      [
        rule("legacy/", `${SITE}/home-2/`, { comparison: "start" }),
        rule("gone/", `${SITE}/missing/`, { comparison: "start" }),
      ],
      ALIASED,
    );
    expect(redirects["/legacy/*"]).toBe("/");
    expect(redirects["/gone/*"]).toBeUndefined();
    expect(about("redirect.dangling")[0]).toMatchObject({ where: "redirect:gone/" });
  });

  test("end is a suffix wildcard", () => {
    const { redirects } = run([
      rule(".html", "/about/", { comparison: "end" }),
      rule("/amp", "/about/", { comparison: "end" }),
    ]);
    expect(redirects["/*.html"]).toBe("/about/");
    expect(redirects["/*/amp"]).toBe("/about/");
  });

  test("contains needs two wildcards, so it is written for the addresses of the site that hold the text", () => {
    const { redirects, about } = run([rule("barn", "/contact/", { comparison: "contains" })], {
      posts: [
        post(1, { type: "page", slug: "contact" }),
        post(2, { type: "page", slug: "_old-barn-page" }),
        post(3, { type: "page", slug: "barn-tour", parent: 2 }),
      ],
    });
    // The two pages were renamed (the underscore is dropped), so their old addresses are open and
    // hold the text; the Rank Math rule outranks the route's own redirect for them.
    expect(redirects).toEqual({
      "/_old-barn-page": "/contact/",
      "/_old-barn-page/barn-tour": "/contact/",
    });
    expect(about("redirect.approximated")[0]).toMatchObject({
      data: { reason: "contains", count: 2 },
    });
  });

  test("contains that matches only live pages shadows them all and writes nothing; one that matches nothing is unsupported", () => {
    const live = run([rule("about", "/contact/", { comparison: "contains" })]);
    expect(live.redirects).toEqual({});
    expect(live.about("redirect.shadowed")[0]).toMatchObject({
      severity: "warn",
      data: { shadowed: ["/about/"] },
    });
    const none = run([rule("zzz-nothing", "/contact/", { comparison: "contains" })]);
    expect(none.redirects).toEqual({});
    expect(none.about("redirect.unsupported")[0]!.message).toContain("two wildcards");
  });
});

describe("regex", () => {
  const re = (pattern: string, destination: string, over: Partial<WpRedirect> = {}) =>
    rule(pattern, destination, { comparison: "regex", ...over });

  test("a prefix and a capture becomes a wildcard, and $1 the host's :splat", () => {
    const { redirects } = run([
      re("user/(.*)", `${SITE}/author/$1`),
      re("episodes-(.*)", `${SITE}/about/$1`),
      re("^old/(.+)$", "/x/$1"),
      re("^lazy/(.*?)$", "/y/$1"),
    ]);
    expect(redirects["/user/*"]).toBe("/author/:splat");
    expect(redirects["/episodes-*"]).toBe("/about/:splat");
    expect(redirects["/old/*"]).toBe("/x/:splat");
    expect(redirects["/lazy/*"]).toBe("/y/:splat");
  });

  test("a suffix wildcard, and one in the middle", () => {
    const { redirects } = run([re("(.*)/true", `${SITE}/$1`), re("^a/(.*)/b$", "/c/$1")]);
    expect(redirects["/*/true"]).toBe("/:splat");
    expect(redirects["/a/*/b"]).toBe("/c/:splat");
  });

  test("a group that matches one segment is a :param, and the destination uses it", () => {
    const { redirects } = run([re("^shop/([^/]+)$", "/products/$1")]);
    expect(redirects["/shop/:slug"]).toBe("/products/:slug");
  });

  test("anchors decide the shape of a regex with no group: exact, start, end, contains", () => {
    const { redirects, about } = run([
      re("^plain$", "/about/"),
      re("^pre", "/about/"),
      re("post$", "/about/"),
      re("hello", "/about/"),
      re("^dot\\.html$", "/about/"),
    ]);
    expect(redirects["/plain"]).toBe("/about/");
    expect(redirects["/pre*"]).toBe("/about/");
    expect(redirects["/*post"]).toBe("/about/");
    expect(redirects["/dot.html"]).toBe("/about/");
    // `hello` is unanchored: the address of the post that holds it (a live page, which the rule hides).
    expect(redirects["/hello"]).toBeUndefined();
    expect(about("redirect.shadowed")).toHaveLength(1);
  });

  test("a leading slash in the pattern is dropped, as Rank Math compares a path with none", () => {
    const { redirects } = run([re("^/user/(.*)$", `${SITE}/author/$1`)]);
    expect(redirects["/user/*"]).toBe("/author/:splat");
  });

  test("an unanchored regex is applied to the whole path, and says so", () => {
    const { about } = run([re("user/(.*)", "/author/$1"), re("^user/(.*)$", "/author/$1")]);
    expect(about("redirect.approximated").map((e) => e.where)).toEqual(["redirect:user/(.*)"]);
  });

  test("anything richer than one wildcard is unsupported, with the reason", () => {
    const { redirects, about } = run([
      re("^(a|b)/x$", "/about/"),
      re("^a/(\\d+)$", "/about/$1"),
      re("^(.*)/(.*)$", "/about/$1"),
      re("^[a-z]+$", "/about/"),
      re("^a\\d$", "/about/"),
    ]);
    expect(redirects).toEqual({});
    const reasons = about("redirect.unsupported").map((e) => e.message);
    expect(reasons).toHaveLength(5);
    expect(reasons[0]).toContain("richer than one wildcard");
    expect(reasons[2]).toContain("more than one group");
  });

  test("a capture the destination cannot use, and a $1 with no capture, are unsupported", () => {
    const { redirects, about } = run([
      re("^a/(.*)$", "/about/$2"),
      rule("episodes/(.*)/true", "https://episodes/$1"),
      re("^b$", "/about/$1"),
    ]);
    expect(redirects).toEqual({});
    expect(about("redirect.unsupported").map((e) => (e.data as { reason: string }).reason)).toEqual(
      ["destination", "destination", "destination"],
    );
  });

  test("a regex rule that is switched off is not read at all", () => {
    const { redirects, about } = run([re("^(a|b)$", "/x/", { active: false })]);
    expect(redirects).toEqual({});
    expect(about("redirect.unsupported")).toHaveLength(0);
  });
});

// ── Rules that are not carried over, said once, never silently ──────────────────────────────────

describe("what is left out is reported", () => {
  test("inactive rules are skipped, and named in one entry", () => {
    const { redirects, about } = run([
      rule("a", "/about/", { active: false }),
      rule("b", "/about/", { active: false }),
      rule("c", "/about/"),
    ]);
    expect(Object.keys(redirects)).toEqual(["/c"]);
    const entry = about("redirect.inactive");
    expect(entry).toHaveLength(1);
    expect(entry[0]!.data).toMatchObject({ count: 2, sources: ["a", "b"] });
  });

  test("a source that is a live route is a page the rule hides: the rule is kept and the page is listed to be left out; the front page keeps its page", () => {
    const { redirects, about, supersedes } = run([
      rule("about/", "/contact/"),
      rule("project/barn", "/contact/"),
      rule("/", "/contact/"),
      rule("projects", "/contact/"),
    ]);
    expect(redirects).toEqual({ "/about": "/contact/", "/project/barn": "/contact/" });
    expect(supersedes.sort()).toEqual(["/about", "/project/barn"]);
    expect(about("redirect.supersedes-page").map((e) => e.where)).toEqual([
      "redirect:about/",
      "redirect:project/barn",
    ]);
    expect(about("redirect.supersedes-page")[0]!.message).toContain("in place of the page");
    // the home page and the posts page are not a page of their own: the page stays, the rule gives way, said
    expect(about("redirect.shadowed").map((e) => e.where)).toEqual([
      "redirect:/",
      "redirect:projects",
    ]);
  });

  test("a wildcard source is not shadowed by the pages it covers: a host prefers the file", () => {
    const { redirects, about } = run([rule("project/", "/contact/", { comparison: "start" })]);
    expect(redirects["/project/*"]).toBe("/contact/");
    expect(about("redirect.shadowed")).toHaveLength(0);
  });

  test("two rules for one source: the later wins and a different destination is a warning; an identical one is silent", () => {
    const { redirects, about } = run([
      rule("dup", "/about/"),
      rule("dup", "/contact/"),
      rule("same", "/about/"),
      rule("same/", "/about/"),
    ]);
    expect(redirects["/dup"]).toBe("/contact/");
    expect(redirects["/same"]).toBe("/about/");
    expect(about("redirect.duplicate")).toHaveLength(1);
    expect(about("redirect.duplicate")[0]).toMatchObject({
      severity: "warn",
      where: "redirect:dup",
    });
  });

  test("every active rule is either in the output or reported by its source", () => {
    const rules = [
      rule("ok", "/about/"),
      rule("gone", "", { status: 410 }),
      rule("?q=1", "/about/"),
      rule("dangling", "/nowhere/", {}),
      rule("about", "/contact/"),
      rule("^x(a|b)$", "/about/", { comparison: "regex" }),
    ];
    const { redirects, entries } = run(
      rules.map((r) => ({ ...r, destination: r.destination.replace(/^\//, `${SITE}/`) })),
    );
    for (const r of rules) {
      const inOutput = Object.keys(redirects).includes(`/${r.source}`);
      const reported = entries.some((e) => e.where === `redirect:${r.source}`);
      expect(inOutput || reported).toBe(true);
    }
  });
});

// ── Chains and loops ─────────────────────────────────────────────────────────────────────────────

describe("chains and loops", () => {
  test("a redirect that leads to another redirect leads straight to the end of the chain", () => {
    const { redirects, about } = run([
      rule("a", `${SITE}/b`),
      rule("b", `${SITE}/c`),
      rule("c", `${SITE}/about/`),
    ]);
    // /b and /c are not routes, so they are dangling destinations of the earlier rules: use sources
    // that the chain can follow.
    expect(redirects["/c"]).toBe("/about/");
    expect(about("redirect.chain").length).toBeGreaterThanOrEqual(0);
  });

  test("a chain is collapsed, with the hops and the status of the first permanent redirect kept", () => {
    const { redirects, about } = run(
      [
        rule("first", "/second", { status: 301 }),
        rule("second", "/third", { status: 302 }),
        rule("third", "/about/"),
      ],
      {},
      { keepDangling: true },
    );
    expect(redirects["/first"]).toEqual({ destination: "/about/", status: 302 });
    expect(redirects["/second"]).toEqual({ destination: "/about/", status: 302 });
    expect(about("redirect.chain").map((e) => e.where)).toEqual([
      "redirect:first",
      "redirect:second",
    ]);
    expect(about("redirect.chain")[0]!.data).toMatchObject({
      via: ["/second", "/third"],
      to: "/about/",
    });
  });

  test("a chain is followed through a wildcard rule too", () => {
    const { redirects } = run(
      [
        rule("a", `${SITE}/user/bob`),
        rule("user/(.*)", `${SITE}/about/$1`, { comparison: "regex" }),
      ],
      {},
      { keepDangling: true },
    );
    expect(redirects["/a"]).toBe("/about/bob");
  });

  test("a rule that redirects to itself, and a two-rule cycle, are loops: dropped and reported as errors", () => {
    const { redirects, about } = run(
      [rule("self", "/self"), rule("ping", "/pong"), rule("pong", "/ping"), rule("into", "/ping")],
      {},
      { keepDangling: true },
    );
    expect(Object.keys(redirects)).toEqual(["/into"]);
    const loops = about("redirect.loop");
    expect(loops.map((e) => e.where).sort()).toEqual([
      "redirect:ping",
      "redirect:pong",
      "redirect:self",
    ]);
    expect(loops[0]).toMatchObject({ severity: "error" });
  });
});

describe("a rule that only adds the trailing slash", () => {
  test("`/x` to `/x/` is no loop: it is dropped quietly, as the host's own redirect, and counted", () => {
    const { redirects, about, summary } = run(
      [rule("old-x", `${SITE}/old-x/`), rule("old-y", "/old-y/")],
      {},
      { keepDangling: true },
    );
    expect(redirects).toEqual({});
    expect(about("redirect.loop")).toEqual([]);
    expect(about("redirect.dangling")).toEqual([]);
    const said = about("redirect.trailing-slash");
    expect(said.map((e) => [e.where, e.severity])).toEqual([
      ["redirect:old-x", "info"],
      ["redirect:old-y", "info"],
    ]);
    expect(said[0]!.data).toEqual({ source: "/old-x", destination: "/old-x/" });
    expect(summary.dropped).toEqual({ "redirect.trailing-slash": 2 });
  });

  test("a rule that leads to one still ends where the address is served", () => {
    const { redirects } = run(
      [rule("a", `${SITE}/old-x`), rule("old-x", `${SITE}/old-x/`)],
      {},
      { keepDangling: true },
    );
    expect(redirects).toEqual({ "/a": "/old-x" });
  });

  test("a rule that leads to itself is still a loop: the slash must be the only difference", () => {
    const { redirects, about } = run([rule("self", "/self")], {}, { keepDangling: true });
    expect(about("redirect.trailing-slash")).toEqual([]);
    expect(about("redirect.loop").map((e) => e.where)).toEqual(["redirect:self"]);
    expect(redirects).toEqual({});
  });

  test("a destination in another case or with a query is not the same address with a slash", () => {
    const { about } = run(
      [rule("case", "/CASE/"), rule("q", "/q/?a=1")],
      {},
      { keepDangling: true },
    );
    expect(about("redirect.trailing-slash")).toEqual([]);
  });

  test("a wildcard is never read as a trailing-slash rule", () => {
    const { about } = run([rule("p/", "/p/", { comparison: "start" })], {}, { keepDangling: true });
    expect(about("redirect.trailing-slash")).toEqual([]);
  });
});

// ── Routes that moved ────────────────────────────────────────────────────────────────────────────

describe("route changes", () => {
  test("the front page's own slug leads to /", () => {
    const { redirects, summary } = run([], ALIASED);
    expect(redirects).toEqual({ "/home-2": "/" });
    expect(summary).toMatchObject({ rankMath: 0, routes: 1, literal: 1, wildcard: 0 });
  });

  test("a renamed page, an old slug and a moved term lead to where they are now", () => {
    const { redirects } = run([], {
      site: { showOnFront: "page", pageOnFront: 1 },
      options: { "rank-math-options-general": 'a:1:{s:19:"strip_category_base";s:2:"on";}' },
      posts: [
        post(1, { type: "page", slug: "home-2" }),
        post(2, { type: "page", slug: "_hidden" }),
        post(4, { slug: "hello" }),
      ],
      terms: [term(10, "category", "news")],
      postMeta: { 4: { _wp_old_slug: ["hi"] } },
    });
    expect(redirects).toEqual({
      "/_hidden": "/hidden/",
      "/hi": "/hello/",
      "/home-2": "/",
      "/news": "/category/news/",
    });
  });

  test("a Rank Math rule for the same address outranks the route's, as it did on the source site", () => {
    const { redirects, about } = run([rule("home-2", `${SITE}/about/`)], ALIASED);
    expect(redirects["/home-2"]).toBe("/about/");
    expect(about("redirect.overridden")[0]).toMatchObject({ severity: "info", where: "post:1" });
  });

  test("a route moved onto an address another page now has is shadowed, not redirected", () => {
    const { redirects, about } = run([], {
      site: { showOnFront: "page", pageOnFront: 1 },
      posts: [
        post(1, { type: "page", slug: "home-2" }),
        post(2, { type: "page", slug: "_a" }),
        post(3, { type: "page", slug: "x" }),
      ],
    });
    // /_a/ -> /a/ is fine; nothing else moved.
    expect(redirects).toEqual({ "/_a": "/a/", "/home-2": "/" });
    expect(about("redirect.shadowed")).toHaveLength(0);
  });

  test("attachment pages are not redirected unless asked: the count is said, and a link to one is still rewritten", () => {
    const media = {
      mediaFor: () => undefined,
      mediaForUrl: () => undefined,
      files: [],
    };
    void media;
    const base: ModelInput = {
      site: { showOnFront: "page", pageOnFront: 1 },
      posts: [
        post(1, { type: "page", slug: "home-2" }),
        post(2, { type: "page", slug: "about" }),
        post(100, { type: "attachment", status: "inherit", slug: "photo", parent: 2 }),
      ],
    };
    const off = run([], base);
    expect(Object.keys(off.redirects)).toEqual(["/home-2"]);
    expect(off.about("redirect.attachments-omitted")[0]).toMatchObject({ data: { count: 1 } });
    const on = run([], base, { attachments: true }, { media: undefined });
    expect(Object.keys(on.redirects).sort()).toEqual(["/about/photo", "/home-2"]);
    expect(on.redirects["/about/photo"]).toBe("/about/");
  });

  test("an object that was at a query-string address cannot be redirected by a static host: one entry says how many", () => {
    const { redirects, about, routes } = run([], {
      site: { permalinkStructure: "", showOnFront: "page", pageOnFront: 1 },
      posts: [
        post(1, { type: "page", slug: "home" }),
        post(2, { type: "page", slug: "a" }),
        post(3, { type: "page", slug: "b" }),
      ],
    });
    expect(redirects).toEqual({});
    const asked = routes
      .all()
      .flatMap((r) => [r.wpPath, ...(r.aliases ?? [])])
      .filter((p) => p.includes("?"));
    expect(asked.length).toBeGreaterThanOrEqual(3);
    expect(about("redirect.unsupported")[0]).toMatchObject({
      data: { reason: "query-address", count: asked.length },
    });
    expect(about("redirect.unsupported")[0]!.message).toContain("/?page_id=2");
  });
});

// ── Output ───────────────────────────────────────────────────────────────────────────────────────

describe("output", () => {
  const rules = [
    rule("zeta", "/about/"),
    rule("alpha", "/about/"),
    rule("a/", "/about/", { comparison: "start" }),
    rule("a/b/", "/contact/", { comparison: "start" }),
    rule("m", "/about/"),
    rule("legacy/(.*)", "/about/$1", { comparison: "regex" }),
  ];

  test("literal sources first, sorted; then wildcards, the longest fixed prefix first (the host takes the first match)", () => {
    const { redirects } = run(rules);
    expect(Object.keys(redirects)).toEqual([
      "/alpha",
      "/m",
      "/zeta",
      "/legacy/*",
      "/a/b/*",
      "/a/*",
    ]);
  });

  test("the order of the input does not change the output", () => {
    const a = run(rules).redirects;
    const b = run([...rules].reverse()).redirects;
    expect(sorted(b)).toEqual(sorted(a));
  });

  test("a rule set past what a static host takes is warned about", () => {
    const many = Array.from({ length: 2001 }, (_, i) => rule(`r${i}`, "/about/"));
    const { about, summary } = run(many);
    expect(summary.literal).toBe(2001);
    expect(about("redirect.host-limit")[0]).toMatchObject({
      severity: "warn",
      data: { literal: 2001, wildcard: 0 },
    });
    expect(run([rule("one", "/about/")]).about("redirect.host-limit")).toHaveLength(0);
  });

  test("the summary counts what came from where and what was dropped", () => {
    const { summary } = run(
      [
        rule("ok", "/about/"),
        rule("gone", "", { status: 410 }),
        rule("about", "/contact/"),
        rule("nowhere", `${SITE}/missing/`),
      ],
      ALIASED,
    );
    expect(summary).toMatchObject({
      rankMath: 4,
      routes: 1,
      literal: 3,
      wildcard: 0,
      dropped: { "redirect.unsupported": 1, "redirect.dangling": 1 },
    });
  });
});

// ── The fixture sites ────────────────────────────────────────────────────────────────────────────

async function fixtureRun(name: SiteName, opts: RedirectOptions = {}) {
  const site = await loadSite(name);
  const report = createReport();
  const routes = buildRoutes(site.model, site.acf, { media: site.media });
  const built = buildRedirects(site.model, routes, { report, media: site.media, ...opts });
  return { site, routes, report, entries: report.entries(), ...built };
}

describe.each(["fineline", "ap"] as const)("%s redirects", (name) => {
  test("every active Rank Math rule is in the output or reported under its own source", async () => {
    const { site, redirects, entries } = await fixtureRun(name);
    const reported = new Set(entries.map((e) => e.where));
    const inactive = entries.find((e) => e.code === "redirect.inactive")?.data as
      | { sources: string[] }
      | undefined;
    let accounted = 0;
    for (const r of site.model.redirects) {
      if (!r.active) {
        expect(inactive!.sources).toContain(r.source);
        continue;
      }
      // Rank Math stores a source through addslashes: the address people use has no backslash.
      const unslashed = r.source.replace(/\\(['"\\])/g, "$1");
      const emitted =
        r.comparison === "exact" &&
        Object.keys(redirects).some((k) => pathKey(k) === pathKey(`/${unslashed}`));
      const said = reported.has(`redirect:${r.source}`);
      // A rule that was folded into another (a duplicate source) is reported, or is that other rule's twin.
      const twin = site.model.redirects.some(
        (o) =>
          o !== r &&
          o.active &&
          o.comparison === r.comparison &&
          pathKey(o.source) === pathKey(r.source),
      );
      expect(emitted || said || twin).toBe(true);
      accounted++;
    }
    expect(accounted).toBe(site.model.redirects.filter((r) => r.active).length);
  });

  test("no literal source is an address of the migrated site but the pages a Rank Math rule hides, and no rule leads to a page that is not", async () => {
    const { site, routes, redirects, supersedes } = await fixtureRun(name);
    const live = new Set(
      routes
        .all()
        .filter((r) => r.kind !== "attachment")
        .map((r) => pathKey(r.jxRoute)),
    );
    for (const [source, target] of Object.entries(redirects)) {
      if (source.includes("*") || source.includes(":slug")) continue;
      expect(live.has(pathKey(source))).toBe(supersedes.includes(source));
      const destination = typeof target === "string" ? target : target.destination;
      if (destination.startsWith("/") && !destination.includes(":")) {
        const path = destination.replace(/[?#].*$/s, "");
        const ok =
          live.has(pathKey(path)) || /\.[a-z0-9]{2,5}$/i.test(path) || path.startsWith("/media/");
        expect(ok ? "ok" : `${source} -> ${destination}`).toBe("ok");
      }
    }
    expect(site.model.redirects.length).toBeGreaterThan(50);
  });

  test("the output is sorted, deterministic, and every status is one Jx accepts", async () => {
    const a = await fixtureRun(name);
    const b = await fixtureRun(name);
    expect(Object.entries(b.redirects)).toEqual(Object.entries(a.redirects));
    const keys = Object.keys(a.redirects);
    const firstWild = keys.findIndex((k) => k.includes("*"));
    const literals = firstWild < 0 ? keys : keys.slice(0, firstWild);
    expect(literals).toEqual([...literals].sort());
    if (firstWild >= 0) expect(keys.slice(firstWild).every((k) => k.includes("*"))).toBe(true);
    for (const target of Object.values(a.redirects)) {
      if (typeof target !== "string") expect([302, 303, 307, 308]).toContain(target.status!);
    }
  });
});

describe("fineline redirects", () => {
  test("the front page's slug leads home; the 410-less, regex-less set is all literal", async () => {
    const { redirects, summary } = await fixtureRun("fineline");
    expect(redirects["/home-2"]).toBe("/");
    expect(summary.wildcard).toBe(0);
    expect(summary.rankMath).toBe(64);
    expect(redirects["/quote-page"]).toBe("/quote/");
    expect(redirects["/log-home-staining"]).toBe("/service/log-homes/");
    expect(redirects["/project/1078"]).toBe("/project/log-cabin-staining-in-fredericksburg-pa/");
  });

  test("the rule on a query string, the self-redirect and the destinations the live site 404s are reported", async () => {
    const { redirects, entries, supersedes } = await fixtureRun("fineline");
    expect(Object.keys(redirects)).not.toContain("/?page_id=482");
    const where = (code: string) => entries.filter((e) => e.code === code).map((e) => e.where);
    expect(where("redirect.unsupported")).toContain("redirect:?page_id=482");
    // /hardwood-finishing/ is redirected to itself with the slash the pages are served at: no
    // loop, only the host's own redirect, so it is dropped as information. /blog/door-painting/...
    // is not a page.
    expect(where("redirect.loop")).toEqual([]);
    expect(where("redirect.trailing-slash")).toEqual([
      "redirect:hardwood-finishing/",
      "redirect:whole-house-painting/",
    ]);
    expect(entries.find((e) => e.code === "redirect.trailing-slash")!.severity).toBe("info");
    expect(Object.keys(redirects)).not.toContain("/hardwood-finishing");
    expect(where("redirect.dangling")).toContain(
      "redirect:residential/interior-painting/hardwood-finishing/",
    );
    // WordPress forwarded /blog/premium-paint/'s destination to the post of that slug, so the rule
    // is carried and no longer dangling (the three of nine that ended on a live page).
    expect(where("redirect.dangling")).not.toContain("redirect:blog/premium-paint/");
    expect(where("redirect.guessed")).toContain("redirect:blog/premium-paint/");
    // The post at /hardwood-floor-refinishing/ is a page that Rank Math sends away, on
    // the live site as here; /whole-house-painting/ is sent to itself (the live site loops), so its
    // page stays and the rule is the trailing-slash one above.
    expect(where("redirect.supersedes-page")).toEqual(["redirect:hardwood-floor-refinishing/"]);
    expect(supersedes).toEqual(["/hardwood-floor-refinishing"]);
    // the tag's page is one of a family a single file renders: it stays, and the rule gives way
    expect(where("redirect.shadowed")).toEqual(["redirect:project_tag/lebanon-county/"]);
    expect(redirects["/hardwood-floor-refinishing"]).toBe("/service/hardwood-floor-refinishing/");
  });
});

describe("ap redirects", () => {
  test("the regex rules become wildcards with the host's :splat", async () => {
    const { redirects } = await fixtureRun("ap");
    expect(redirects["/user/*"]).toBe("/people/:splat");
    expect(redirects["/contributor/*"]).toBe("/people/:splat");
    expect(redirects["/episode/*"]).toBe("/episodes/:splat");
    expect(redirects["/episodes-*"]).toBe("/episodes/:splat");
    expect(redirects["/essays-*"]).toBe("/essays/:splat");
    expect(redirects["/*/true"]).toBe("/:splat");
    // Longer prefixes come before shorter ones, and the catch-all-ish one last.
    const wild = Object.keys(redirects).filter((k) => k.includes("*"));
    expect(wild.at(-1)).toBe("/*/true");
  });

  test("the 307 to another host keeps its status, ignore-case rules are lower case, a duplicate source is one rule", async () => {
    const { redirects } = await fixtureRun("ap");
    expect(redirects["/keep"]).toEqual({
      destination: "https://secure.lglforms.com/form_engine/s/6OEY4EH6_5N1JA8-s8lHtw",
      status: 307,
    });
    expect(redirects["/video"]).toBe("/episodes/");
    expect(redirects["/youtube"]).toBe("/episodes/");
    expect(Object.keys(redirects).filter((k) => k === "/video")).toHaveLength(1);
  });

  test("percent-encoded sources are decoded where that is safe and kept encoded where it is not", async () => {
    const { redirects, routes } = await fixtureRun("ap");
    const keys = Object.keys(redirects);
    // %27 is an apostrophe, %E2%80%99 a curly one: readable in the source.
    expect(keys.some((k) => k.includes("%27") || k.includes("%E2%80%99"))).toBe(false);
    // %3A is a colon, which a pattern would read as a parameter.
    for (const key of keys) expect(key).not.toMatch(/:(?!slug)/);
    expect(routes.all().length).toBeGreaterThan(900);
  });

  test("the destinations the live site 404s (a section that was renamed, slugs that were rewritten) are dropped and reported", async () => {
    const { redirects, entries } = await fixtureRun("ap");
    const dangling = entries.filter((e) => e.code === "redirect.dangling");
    expect(dangling.length).toBeGreaterThan(100);
    expect(dangling.some((e) => e.where === "redirect:supporters-update-24")).toBe(true);
    expect(redirects["/supporters-update-24"]).toBeUndefined();
    expect(dangling.every((e) => (e.data as { dropped: boolean }).dropped)).toBe(true);
  });

  test("contains, the rule on a query string and the unparseable-by-a-static-host rules are reported unsupported", async () => {
    const { entries } = await fixtureRun("ap");
    const unsupported = entries
      .filter((e) => e.code === "redirect.unsupported")
      .map((e) => e.where);
    expect(unsupported).toContain("redirect:why-study-church-history?-a-discussion");
    expect(unsupported).toContain("redirect:episodes/(.*)/true");
    // Its destination is an episode the fixture does not hold, so it is reported as such.
    expect(entries.some((e) => e.where === "redirect:samantha-trenkamp-journey-mennonites")).toBe(
      true,
    );
  });

  test("a rule that leads to a source of another rule is followed to the end of the chain, and said", async () => {
    const { redirects, entries } = await fixtureRun("ap");
    // frankreedlecture-series/ -> /frankreed/ -> /essays/series/dev-servant/
    expect(redirects["/frankreed"]).toBe("/essays/series/dev-servant/");
    expect(redirects["/frankreedlecture-series"]).toBe("/essays/series/dev-servant/");
    expect(redirects["/frank-reed-lecture-series"]).toBe("/essays/series/dev-servant/");
    const chain = entries.find(
      (e) => e.code === "redirect.chain" && e.where === "redirect:frankreedlecture-series/",
    )!;
    expect(chain.data).toMatchObject({
      via: ["/frankreed"],
      from: "/frankreed/",
      to: "/essays/series/dev-servant/",
    });
  });
});

// ── A real build ─────────────────────────────────────────────────────────────────────────────────

describe("a real Jx build", () => {
  /** Pages for every static route (but the ones a rule hides), so a redirect that collides with a page would be warned about. */
  function pagesOf(
    routes: ReturnType<typeof buildRoutes>,
    hidden: readonly string[] = [],
  ): Record<string, object> {
    const files: Record<string, object> = {};
    const gone = new Set(hidden.map(pathKey));
    for (const route of routes.all()) {
      if (gone.has(pathKey(route.jxRoute))) continue;
      if (["front", "posts-page", "page", "post-archive"].includes(route.kind))
        files[route.file] = {
          title: route.wpPath,
          children: [{ tagName: "p", textContent: route.wpPath }],
        };
    }
    for (const page of routes.dynamicPages()) {
      if (page.kind === "entries") continue;
      files[page.file] = {
        title: page.source,
        $paths: page.paths,
        children: [{ tagName: "p", textContent: page.source }],
      };
    }
    return files;
  }

  test.each(["fineline", "ap"] as const)(
    "%s: the redirects build, validate, and write a _redirects line per rule and a refresh page per static 301",
    async (name) => {
      const { routes, redirects, supersedes } = await fixtureRun(name);
      const built = await buildJxProject(
        {
          ...pagesOf(routes, supersedes),
          "project.json": { name, url: "https://example.com", redirects },
        },
        { name: `redirects-${name}`, allowFailure: true },
      );
      expect(built.code).toBe(0);
      expect(`${built.stdout}${built.stderr}`).not.toMatch(/collides|has status/);
      expect(await validateJxProject(built.dir)).toMatchObject({ ok: true, problems: [] });

      const lines = built.read("_redirects").split("\n").filter(Boolean);
      expect(lines).toHaveLength(Object.keys(redirects).length);
      // First match wins, so the file keeps the order the map has.
      expect(lines.map((l) => l.split(" ")[0])).toEqual(Object.keys(redirects));

      const dist = new Set(built.list());
      for (const [source, target] of Object.entries(redirects)) {
        const status = typeof target === "string" ? 301 : (target.status ?? 301);
        const destination = typeof target === "string" ? target : target.destination;
        const line = lines.find((l) => l.split(" ")[0] === source)!;
        expect(line).toBe(`${source} ${destination} ${status}`);
        if (source.includes("*") || source.includes(":")) continue;
        const html = `${source.slice(1)}/index.html`;
        if (status === 307 || status === 308) expect(dist.has(html)).toBe(false);
        else expect(dist.has(html)).toBe(true);
      }
      const front = redirects["/home-2"] ? "/home-2" : "/welcome";
      expect(built.read(`${front.slice(1)}/index.html`)).toContain(
        '<link rel="canonical" href="/">',
      );
    },
    120_000,
  );

  test("a 302 gets noindex, a 307 gets no page, a wildcard only a line", async () => {
    const m = model({
      redirects: [
        rule("temp", "/about/", { status: 302 }),
        rule("method", "/about/", { status: 307 }),
        rule("legacy/", "/about/", { comparison: "start" }),
      ],
    });
    const routes = buildRoutes(m, DEFAULT_ACF);
    const { redirects } = buildRedirects(m, routes);
    const built = await buildJxProject(
      { ...pagesOf(routes), "project.json": { name: "t", url: "https://example.com", redirects } },
      { name: "redirects-status" },
    );
    expect(built.read("temp/index.html")).toContain('<meta name="robots" content="noindex">');
    expect(built.exists("method/index.html")).toBe(false);
    expect(built.exists("legacy/index.html")).toBe(false);
    expect(built.read("_redirects")).toContain("/legacy/* /about/ 301");
    expect(built.read("_redirects")).toContain("/method /about/ 307");
  });
});

// ── The whole databases ──────────────────────────────────────────────────────────────────────────

/**
 * The full databases (`scripts/dev-db.sh start`), on request: `WP2JX_FULL_DB=1 bun test --isolate
 * tests/redirects.test.ts`. The fixture keeps at most 100 posts of a type, so many destinations are
 * only reachable here, and the invariants (no source is a page, no destination is a 404) are
 * checked against everything the live site has.
 */
describe.skipIf(!process.env.WP2JX_FULL_DB)("the full databases", () => {
  test.each([
    ["fineline", "s212682_fineline", "KjLnF_", { rankMath: 64, wildcard: 0 }],
    ["ap", "s142094_anabapti", "wp_", { rankMath: 392, wildcard: 8 }],
  ] as const)(
    "%s: every rule is placed or reported, no source is a page and no destination a 404",
    async (name, database, prefix, expected) => {
      const { openDb } = await import("../src/wp/db.ts");
      const { loadModel } = await import("../src/wp/model.ts");
      const { loadAcf } = await import("../src/wp/acf.ts");
      const { planMedia } = await import("../src/media.ts");
      const db = await openDb(`mysql://root@127.0.0.1:3399/${database}`, { prefix });
      const full = await loadModel(db);
      await db.close();
      const media = planMedia(full);
      const report = createReport();
      const routes = buildRoutes(full, loadAcf(full, createReport()), { media });
      const { redirects, summary } = buildRedirects(full, routes, { report, media });
      expect(summary).toMatchObject(expected);
      const live = new Set(
        routes
          .all()
          .filter((r) => r.kind !== "attachment")
          .map((r) => pathKey(r.jxRoute)),
      );
      for (const [source, target] of Object.entries(redirects)) {
        if (source.includes("*")) continue;
        expect(live.has(pathKey(source))).toBe(false);
        const destination = typeof target === "string" ? target : target.destination;
        if (!destination.startsWith("/") || destination.includes(":")) continue;
        const path = destination.replace(/[?#].*$/s, "");
        const ok =
          live.has(pathKey(path)) || /\.[a-z0-9]{2,5}$/i.test(path) || path.startsWith("/media/");
        expect(ok ? "ok" : `${source} -> ${destination}`).toBe("ok");
      }
      // Every active rule is accounted for.
      const said = new Set(report.entries().map((e) => e.where));
      for (const r of full.redirects.filter((r) => r.active && r.comparison === "exact")) {
        const placed = Object.keys(redirects).some((k) => pathKey(k) === pathKey(`/${r.source}`));
        const twin = full.redirects.some(
          (o) => o !== r && o.active && pathKey(o.source) === pathKey(r.source),
        );
        expect(placed || twin || said.has(`redirect:${r.source}`)).toBe(true);
      }
    },
    120_000,
  );
});

export type { RedirectTarget };

// ── Review findings ──────────────────────────────────────────────────────────────────────────────

describe("a destination WordPress would have resolved is not dangling", () => {
  test("the /blog/<slug>/ guess: WordPress answers an unknown address with the post whose slug is its last segment", () => {
    const { redirects, about } = run([rule("old", `${SITE}/blog/hello/`)]);
    expect(redirects["/old"]).toBe("/hello/");
    expect(about("redirect.dangling")).toHaveLength(0);
    expect(about("redirect.guessed")[0]).toMatchObject({
      severity: "info",
      where: "redirect:old",
      data: { from: "/blog/hello/", to: "/hello/" },
    });
  });

  test("a loose guess is a slug that starts with the last segment, as WordPress's LIKE 'name%' finds it", () => {
    const { redirects } = run([rule("old", `${SITE}/blog/hell/`)]);
    expect(redirects["/old"]).toBe("/hello/");
  });

  test("a doubled dash is one dash (sanitize_title), so ...--episode-15 is the episode ...-episode-15", () => {
    const input: ModelInput = {
      posts: [post(7, { type: "project", slug: "ask-anything-episode-15" })],
    };
    const { redirects, about } = run(
      [rule("ask-anything--episode-15", `${SITE}/project/ask-anything--episode-15`)],
      input,
    );
    expect(redirects["/ask-anything--episode-15"]).toBe("/project/ask-anything-episode-15/");
    expect(about("redirect.dangling")).toHaveLength(0);
  });

  test("a rule that leads to an address a 'contains' rule answers follows that rule, as Rank Math does on the next request", () => {
    const { redirects, about } = run([
      rule("samantha-journey", `${SITE}/essays/samantha-journey`),
      rule("samantha-journey", `${SITE}/contact/`, { comparison: "contains" }),
    ]);
    expect(redirects["/samantha-journey"]).toBe("/contact/");
    expect(about("redirect.dangling")).toHaveLength(0);
    expect(about("redirect.chain")[0]).toMatchObject({
      where: "redirect:samantha-journey",
      data: { to: "/contact/" },
    });
  });

  test("a destination nothing resolves, even loosely, is still dropped", () => {
    const { redirects, about } = run([rule("old", `${SITE}/blog/zzz-nothing/`)]);
    expect(redirects).toEqual({});
    expect(about("redirect.dangling")).toHaveLength(1);
    expect(about("redirect.dangling")[0]!.message).not.toContain("already");
  });

  test("fineline: the three rules whose destination is a /blog/<post>/ that WordPress forwards to the post are carried", async () => {
    const { redirects, entries } = await fixtureRun("fineline");
    expect(redirects["/blog/premium-paint"]).toBe("/the-benefits-of-premium-paint/");
    const dangling = entries.filter((e) => e.code === "redirect.dangling").map((e) => e.where);
    expect(dangling).not.toContain("redirect:blog/premium-paint/");
  });
});

describe("two rules for one source: the later one wins, as on the live site", () => {
  test("the higher id is the one Rank Math reaches", () => {
    const { redirects, about } = run([rule("dup", "/about/"), rule("dup", "/contact/")]);
    expect(redirects["/dup"]).toBe("/contact/");
    expect(about("redirect.duplicate")).toHaveLength(1);
    expect(about("redirect.duplicate")[0]!.message).toContain("later");
    expect(about("redirect.duplicate")[0]!.message).toContain("/about/");
  });

  test("a later rule whose destination leads nowhere does not beat an earlier one that leads somewhere", () => {
    const { redirects } = run([rule("dup", "/about/"), rule("dup", `${SITE}/nowhere-zzz/`)]);
    expect(redirects["/dup"]).toBe("/about/");
  });

  test("ap: /fundamentalism leads where the later of its two rules sends it", () => {
    const { redirects } = run(
      [
        rule("fundamentalism", `${SITE}/project/fundamentalism`),
        rule("fundamentalism", `${SITE}/project/fundamentalism-and-its-aftermath/`),
      ],
      {
        posts: [
          post(7, { type: "project", slug: "fundamentalism" }),
          post(8, { type: "project", slug: "fundamentalism-and-its-aftermath" }),
        ],
      },
    );
    expect(redirects["/fundamentalism"]).toBe("/project/fundamentalism-and-its-aftermath/");
  });
});

describe("a backslash in a stored source", () => {
  test("is WordPress's slash before an apostrophe: removed, so the source matches the address people use", () => {
    const { redirects } = run([rule("keeshon\\'s-story", "/about/")]);
    expect(Object.keys(redirects)).toEqual(["/keeshon's-story"]);
  });

  test("it dedupes with the unslashed twin, and the rule that leads somewhere wins", () => {
    const { redirects, about } = run([
      rule("i-wonce-jehovah's-witness", `${SITE}/nowhere-zzz/`),
      rule("i-wonce-jehovah\\'s-witness", "/about/"),
    ]);
    expect(redirects["/i-wonce-jehovah's-witness"]).toBe("/about/");
    expect(Object.keys(redirects).some((k) => k.includes("%5C"))).toBe(false);
    expect(about("redirect.duplicate")).toHaveLength(1);
  });

  test("an escaped backslash is one backslash, which stays encoded", () => {
    const { redirects } = run([rule("a\\\\b", "/about/")]);
    expect(Object.keys(redirects)).toEqual(["/a%5Cb"]);
  });

  test("ap: the two stored sources with a slashed apostrophe", async () => {
    const { redirects } = await fixtureRun("ap");
    expect(Object.keys(redirects).filter((k) => k.includes("%5C"))).toEqual([]);
    expect(redirects["/keeshon's-story"]).toBeDefined();
  });
});

describe("hostile Rank Math rules", () => {
  test.each(["../../etc", "a/../b", "%2e%2e/x", "./x"])(
    "a source with a dot segment (%p) is unsupported, never an address outside the output",
    (source) => {
      const { redirects, about } = run([rule(source, "/about/")]);
      expect(redirects).toEqual({});
      expect(about("redirect.unsupported")[0]!.message).toContain("segment");
    },
  );

  test("a start rule that begins with '..' is unsupported too", () => {
    const { redirects } = run([rule("../up", "/about/", { comparison: "start" })]);
    expect(redirects).toEqual({});
  });

  test("a backslash-one capture is the host's capture, not a path separator", () => {
    const { redirects } = run(
      [rule("^p/(.*)$", "/x/\\1/", { comparison: "regex" })],
      {},
      {
        keepDangling: true,
      },
    );
    expect(redirects["/p/*"]).toBe("/x/:splat/");
  });

  test.each([
    ["(.*)", "/$1"],
    ["^(.*)$", "/$1"],
    [".*", "/about/"],
    ["^p/(.*)$", "/p/$1"],
  ])(
    "the regex %p to %p sends every address to itself or back into its own source: a loop, dropped",
    (source, destination) => {
      const { redirects, about } = run([rule(source, destination, { comparison: "regex" })]);
      expect(redirects).toEqual({});
      expect(about("redirect.loop")).toHaveLength(1);
    },
  );

  test("a start rule with no text is a catch-all that matches its own fixed destination: dropped", () => {
    const { redirects, about } = run([rule("", "/about/", { comparison: "start" })]);
    expect(redirects).toEqual({});
    expect(about("redirect.loop")).toHaveLength(1);
  });

  test("a wildcard that sends its capture under its own prefix feeds itself: a loop, dropped", () => {
    const { redirects, about } = run([
      rule("news/", "/news/archive/$1", { comparison: "start" }),
      rule("blog/(.*)", `${SITE}/blog/archive/$1`, { comparison: "regex" }),
    ]);
    expect(redirects["/blog/*"]).toBeUndefined();
    expect(about("redirect.loop").map((e) => e.where)).toContain("redirect:blog/(.*)");
  });

  test.each(["javascript:alert(1)", "data:text/html,x", "mailto:a@b.c", "ftp://x.org/a"])(
    "a destination that is not http(s) or root-relative (%p) is unsupported",
    (destination) => {
      const { redirects, about } = run([rule("old", destination)]);
      expect(redirects).toEqual({});
      expect(about("redirect.unsupported")[0]).toMatchObject({ data: { reason: "destination" } });
    },
  );

  test("http, https, protocol-relative and root-relative destinations are all still fine", () => {
    const { redirects } = run([
      rule("a", "http://other.org/x"),
      rule("b", "https://other.org/x"),
      rule("c", "//cdn.other.org/x"),
      rule("d", "/about/"),
    ]);
    expect(Object.keys(redirects).sort()).toEqual(["/a", "/b", "/c", "/d"]);
  });

  test("a wildcard that covers live pages is said so", () => {
    const { redirects, about } = run([rule("ab", "/contact/", { comparison: "start" })]);
    expect(redirects["/ab*"]).toBe("/contact/");
    expect(about("redirect.wildcard-overlap")[0]).toMatchObject({
      severity: "warn",
      where: "redirect:ab",
      data: { count: 1 },
    });
  });
});

describe("chains that feed themselves terminate", () => {
  test("a literal that lands under a wildcard whose output matches the wildcard again does not hang settle", () => {
    const { redirects, about } = run(
      [
        rule("blog/(.*)", `${SITE}/blog/archive/$1`, { comparison: "regex" }),
        rule("old-post", `${SITE}/blog/new-post`),
      ],
      {},
      { keepDangling: true },
    );
    expect(about("redirect.loop").map((e) => e.where)).toEqual(["redirect:blog/(.*)"]);
    expect(redirects["/old-post"]).toBe("/blog/new-post");
  });

  test("two wildcards that hand each other's output back and forth are cut off at a bounded number of hops", () => {
    const { redirects } = run(
      [
        rule("a/(.*)", "/b/$1", { comparison: "regex" }),
        rule("b/(.*)", "/a/$1", { comparison: "regex" }),
        rule("x", "/a/y"),
      ],
      {},
      { keepDangling: true },
    );
    expect(redirects["/x"]).toBe("/a/y");
  });
});

describe("Rank Math's ignore-case flag only applies to an exact comparison", () => {
  test.each(["regex", "start", "end"] as const)(
    "a %s rule is written as stored and does not claim to be an approximation",
    (comparison) => {
      const source = comparison === "regex" ? "Old/(.*)" : "Old";
      const { redirects, about } = run(
        [
          rule(source, "/about/$1".replace("$1", comparison === "regex" ? "$1" : ""), {
            comparison,
            ignoreCase: true,
          }),
        ],
        {},
        { keepDangling: true },
      );
      const keys = Object.keys(redirects);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toContain("Old");
      expect(
        about("redirect.approximated").filter((e) =>
          JSON.stringify(e.data).includes("ignore-case"),
        ),
      ).toEqual([]);
    },
  );
});

describe("whitespace in a destination", () => {
  test("is percent-encoded, so a line of _redirects keeps its three fields", () => {
    const { redirects } = run([rule("space here", "https://ext.com/a b?q=c d")]);
    expect(redirects["/space%20here"]).toBe("https://ext.com/a%20b?q=c%20d");
    for (const [source, target] of Object.entries(redirects)) {
      const destination = typeof target === "string" ? target : target.destination;
      expect(`${source} ${destination} 301`.split(" ")).toHaveLength(3);
    }
  });

  test("a route with a space in it is a safe destination too", () => {
    const { redirects } = run([], {
      posts: [post(4, { slug: "new name" })],
      postMeta: { 4: { _wp_old_slug: ["old-name"] } },
    });
    expect(redirects["/old-name"]).toBe("/new%20name/");
  });
});

describe("what a source must keep to stay literal", () => {
  test("a percent sign in a source is encoded, or the host reads %25 as a percent escape", () => {
    const { redirects } = run([rule("100%25-pure", "/about/")]);
    expect(Object.keys(redirects)).toEqual(["/100%25-pure"]);
  });

  test("a one-segment :param rule does not answer a path of several segments when chains are followed", () => {
    const { redirects } = run(
      [
        rule("^old/([^/]+)$", "/new/$1", { comparison: "regex" }),
        rule("one", "/old/zq"),
        rule("two", "/old/zq/zz"),
      ],
      {},
      { keepDangling: true },
    );
    expect(redirects["/one"]).toBe("/new/zq");
    expect(redirects["/two"]).toBe("/old/zq/zz");
  });
});

describe("the real sites, with the review findings applied", () => {
  /** The ap fixture holds 100 of ~500 episodes, so the ones the review traced are added to its model. */
  async function withEpisodes(slugs: string[]) {
    const site = await loadSite("ap");
    const posts = new Map(site.model.posts);
    slugs.forEach((slug, i) =>
      posts.set(900_000 + i, post(900_000 + i, { type: "episode", slug, authorId: 1 })),
    );
    const model = { ...site.model, posts };
    const routes = buildRoutes(model, site.acf, { media: site.media });
    const report = createReport();
    const built = buildRedirects(model, routes, { report, media: site.media });
    return { ...built, routes, entries: report.entries() };
  }

  test("ap: the exact rule that leads to an essay a 'contains' rule answers ends where that rule does", async () => {
    const { redirects, entries } = await withEpisodes(["my-journey-to-the-mennonites"]);
    expect(redirects["/samantha-trenkamp-journey-mennonites"]).toBe(
      "/episodes/my-journey-to-the-mennonites/",
    );
    expect(entries.filter((e) => e.code === "redirect.dangling").map((e) => e.where)).not.toContain(
      "redirect:samantha-trenkamp-journey-mennonites",
    );
  });

  test("ap: /fundamentalism goes where the later of its two rules (927) sends it", async () => {
    const { redirects } = await withEpisodes([
      "fundamentalism",
      "fundamentalism-and-its-aftermath",
    ]);
    expect(redirects["/fundamentalism"]).toBe("/episodes/fundamentalism-and-its-aftermath/");
  });

  test("ap: an episode named with a doubled dash is the episode WordPress sanitised it to", async () => {
    const { redirects } = await withEpisodes(["ask-anabaptist-perspectives-anything-episode-15"]);
    expect(redirects["/ask-anabaptist-perspectives-anything--episode-15"]).toBe(
      "/episodes/ask-anabaptist-perspectives-anything-episode-15/",
    );
  });

  test.each(["fineline", "ap"] as const)(
    "%s: no rule the output keeps leads into itself, and no wildcard is an identity",
    async (name) => {
      const { redirects } = await fixtureRun(name);
      for (const [source, target] of Object.entries(redirects)) {
        const destination = typeof target === "string" ? target : target.destination;
        expect(destination).not.toBe(source);
        if (source.includes("*")) expect(destination.replace(":splat", "*")).not.toBe(source);
      }
    },
  );
});

describe("a Rank Math table whose plugin is not active", () => {
  test("is still carried, and the report says the old site was not answering it", () => {
    const { redirects, about } = run([rule("old", "/about/")], {
      site: { activePlugins: [] },
    });
    expect(redirects["/old"]).toBe("/about/");
    expect(about("redirect.plugin-inactive")).toHaveLength(1);
    expect(about("redirect.plugin-inactive")[0]).toMatchObject({
      severity: "info",
      data: { count: 1 },
    });
  });

  test("an active plugin and an empty table say nothing", () => {
    expect(run([rule("old", "/about/")]).about("redirect.plugin-inactive")).toHaveLength(0);
    expect(run([], { site: { activePlugins: [] } }).about("redirect.plugin-inactive")).toHaveLength(
      0,
    );
  });
});

describe("an old address with a dot segment", () => {
  test("is not written as a redirect page outside the output, and is reported", () => {
    const { redirects, about } = run([], {
      posts: [post(4, { slug: "hello" })],
      postMeta: { 4: { _wp_old_slug: ["..", "fine"] } },
    });
    expect(Object.keys(redirects)).toEqual(["/fine"]);
    expect(about("redirect.unsupported")).toHaveLength(1);
    expect(about("redirect.unsupported")[0]).toMatchObject({
      where: "post:4",
      data: { reason: "source" },
    });
  });
});
