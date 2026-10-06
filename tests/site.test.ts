/**
 * `src/site.ts` over the two fixture sites: the production loader, the subject contexts, the tag
 * names the emitters share, and the per-subject CSS index. Everything real: the committed database
 * rows and stylesheets; the only fake things are a stub database for the post-type census and a
 * loopback server for the "live site" stylesheet source.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertSubject, registerConverters } from "../src/convert.ts";
import { createReport } from "../src/report.ts";
import {
  allSubjects,
  componentInfos,
  componentTag,
  cssIndexFor,
  cssNamesFor,
  cssPlanFor,
  defaultPrefix,
  importedStyleRules,
  isCssFileName,
  loadSiteContext,
  ownCssName,
  partTag,
  publishedPostTypes,
  reportExcludedTypes,
  reportOwnCss,
  reusableTag,
  siteTags,
  subjectBlocks,
  subjectCtx,
  subjectDefaults,
  subjectId,
  subjectPost,
  subjectSession,
  subjectWhere,
  tagPrefix,
  type SiteContext,
  type Subject,
} from "../src/site.ts";
import type { BlockConverter, CssSource, WpBlock, WpModel, WpPost } from "../src/types.ts";
import * as realDb from "../src/wp/db.ts";
import { walkBlocks } from "../src/wp/blocks.ts";
import { loadSite } from "./helpers/ctx.ts";
import { fixtureCssDir } from "./helpers/fixture-css.ts";
import { FIXTURES, fixtureDb } from "./helpers/fixture-db.ts";
import { TMP_ROOT } from "./helpers/jx-build.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const customTag = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

// ── Tag names ────────────────────────────────────────────────────────────────────────────────────

describe("tag names", () => {
  test("tagPrefix keeps what a tag can start with and falls back to wp", () => {
    expect(tagPrefix("fp")).toBe("fp");
    expect(tagPrefix("Fine Line!")).toBe("fine-line");
    expect(tagPrefix("9lives")).toBe("lives");
    expect(tagPrefix("")).toBe("wp");
    expect(tagPrefix(undefined)).toBe("wp");
    expect(tagPrefix("---")).toBe("wp");
  });

  /** A model of only what componentInfos reads: the posts and their meta. */
  function fakeModel(
    blocks: {
      id: number;
      slug: string;
      ref: string | null;
      props?: unknown;
      variants?: unknown;
      status?: string;
      type?: string;
    }[],
  ): WpModel {
    const posts = new Map<number, WpPost>();
    const meta = new Map<number, Record<string, unknown[]>>();
    for (const b of blocks) {
      posts.set(b.id, {
        id: b.id,
        type: b.type ?? "cc_block",
        status: b.status ?? "publish",
        slug: b.slug,
      } as WpPost);
      meta.set(b.id, {
        ...(b.ref === null ? {} : { reference: [b.ref] }),
        ...(b.props === undefined ? {} : { properties: [b.props] }),
        ...(b.variants === undefined ? {} : { variants: [b.variants] }),
      });
    }
    return { posts, postMeta: meta } as unknown as WpModel;
  }

  test("component tags are <prefix>-<slug>, unique, and always a valid custom element name", () => {
    const model = fakeModel([
      { id: 1, slug: "icon-card", ref: "a" },
      { id: 2, slug: "Icon Card", ref: "b" },
      { id: 3, slug: "icon_card", ref: "c" },
      { id: 4, slug: "", ref: "d" },
      { id: 5, slug: "123", ref: "e" },
      { id: 6, slug: "x", ref: "f", status: "draft" },
      { id: 7, slug: "y", ref: null },
      { id: 8, slug: "y", ref: "a" },
      { id: 9, slug: "private-one", ref: "g", status: "private" },
    ]);
    const infos = componentInfos(model, "fp");
    expect([...infos.keys()]).toEqual(["a", "b", "c", "d", "e", "g"]);
    expect([...infos.values()].map((i) => i.tagName)).toEqual([
      "fp-icon-card",
      "fp-icon-card-2",
      "fp-icon-card-3",
      "fp-component-4",
      "fp-123",
      "fp-private-one",
    ]);
    for (const info of infos.values()) expect(info.tagName).toMatch(customTag);
    // a duplicate reference keeps the first component
    expect(infos.get("a")?.postId).toBe(1);
  });

  test("a prefix that is not a name is cleaned, and a reserved element name is never produced", () => {
    const infos = componentInfos(fakeModel([{ id: 1, slug: "face", ref: "a" }]), "font");
    expect([...infos.values()][0]?.tagName).toBe("font-face-2");
    expect(
      [...componentInfos(fakeModel([{ id: 1, slug: "a", ref: "r" }]), "9 Bad Prefix!").values()][0]
        ?.tagName,
    ).toBe("bad-prefix-a");
  });

  test("props get unique camelCase keys that cannot shadow Object.prototype; variants accept a list or a map", () => {
    const model = fakeModel([
      {
        id: 1,
        slug: "card",
        ref: "r",
        props: {
          p1: { name: "Card Title", type: "text", default: "x" },
          p2: { name: "card title", type: "richtext" },
          p3: { name: "constructor", type: "text" },
          p4: { name: "9 lives", type: "text" },
          p5: {},
          p6: { name: "", type: "link", default: { href: "/" } },
        },
        variants: [{ id: "v1", name: "Big" }, { id: 3 }, { name: "no id" }],
      },
      {
        id: 2,
        slug: "other",
        ref: "s",
        variants: { a: { id: "v2" }, b: { id: "v3", name: "Three" } },
      },
    ]);
    const card = componentInfos(model, "fp").get("r")!;
    expect(card.props.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    expect(card.props.map((p) => p.key)).toEqual([
      "cardTitle",
      "cardTitle_",
      "constructor_",
      "p9Lives",
      "p5",
      "p6",
    ]);
    expect(new Set(card.props.map((p) => p.key)).size).toBe(card.props.length);
    expect(card.props[0]).toEqual({
      id: "p1",
      key: "cardTitle",
      name: "Card Title",
      type: "text",
      default: "x",
    });
    expect(card.props[5]?.default).toEqual({ href: "/" });
    expect(card.variants).toEqual([{ id: "v1", name: "Big" }]);
    expect(componentInfos(model, "fp").get("s")!.variants).toEqual([
      { id: "v2", name: "v2" },
      { id: "v3", name: "Three" },
    ]);
  });

  for (const name of ["fineline", "ap"] as const) {
    test(`${name}: component, part and reusable tags are all distinct valid names under the site's prefix`, async () => {
      const site = await loadSite(name);
      const tags: string[] = [];
      for (const info of site.components.values()) tags.push(info.tagName);
      for (const post of site.model.posts.values()) {
        if (post.type === "wp_template_part" && post.status === "publish")
          tags.push(partTag(site, post.slug));
        if (post.type === "wp_block") tags.push(reusableTag(site, post.id));
      }
      expect(tags.length).toBeGreaterThan(5);
      expect(new Set(tags).size).toBe(tags.length);
      for (const tag of tags) {
        expect(tag).toMatch(customTag);
        expect(tag.startsWith("wp-")).toBe(true);
      }
    });
  }

  test("fineline: the plain names, and a numeric reusable-block slug", async () => {
    const site = await loadSite("fineline");
    expect(partTag(site, "header")).toBe("wp-header");
    expect(partTag(site, "footer")).toBe("wp-footer");
    expect(partTag(site, "header-updated-menu")).toBe("wp-header-updated-menu");
    expect(reusableTag(site, 63)).toBe("wp-block-63");
    expect(componentTag(site, "0a275b695a")).toBe("wp-icon-card");
    expect(componentTag(site, "nope")).toBeUndefined();
  });

  test("ap: a part and a reusable block with one slug do not collide, and a nameless block is numbered", async () => {
    const site = await loadSite("ap");
    expect(partTag(site, "contributor-teaser")).toBe("wp-contributor-teaser");
    // its reusable twin takes the longer name
    expect(reusableTag(site, 8)).toBe("wp-block-contributor-teaser");
    expect(reusableTag(site, 1069)).toBe("wp-block-1069");
    // a part nobody published still gets a name that cannot be a real one's
    expect(partTag(site, "missing part")).toBe("wp-part-missing-part");
    expect(reusableTag(site, 424242)).toBe("wp-block-424242");
  });

  test("a site loaded with another prefix names every tag with it", async () => {
    const { url, prefix } = await fixtureDb("fineline");
    const site = await loadSiteContext({
      db: url,
      prefix,
      cssFrom: { dir: fixtureCssDir("fineline") },
      componentPrefix: "FP",
    });
    expect(site.componentPrefix).toBe("fp");
    expect(componentTag(site, "0a275b695a")).toBe("fp-icon-card");
    expect(partTag(site, "header")).toBe("fp-header");
  });
});

// ── Loading ──────────────────────────────────────────────────────────────────────────────────────

describe("loadSiteContext", () => {
  test("publishedPostTypes: published and private types, less bookkeeping and commerce, plus the structural ones", async () => {
    const rows = [
      "post",
      "page",
      "give_payment",
      "product",
      "shop_order",
      "revision",
      "user_request",
      "episode",
      "wc_thing",
      "edd_payment",
      "oembed_cache",
      "give_log",
    ];
    const stub = {
      table: (name: string) => `x_${name}`,
      async query<T>(sql: string): Promise<T[]> {
        expect(sql).toContain("x_posts");
        expect(sql).toContain("post_status in ('publish', 'private')");
        return rows.map((post_type) => ({ post_type })) as T[];
      },
    };
    const types = await publishedPostTypes(stub);
    expect(types).toContain("post");
    expect(types).toContain("episode");
    for (const structural of [
      "wp_template",
      "wp_template_part",
      "wp_block",
      "cc_block",
      "acf-field",
      "custom_css",
      "wp_global_styles",
      "wp_navigation",
    ]) {
      expect(types).toContain(structural);
    }
    for (const gone of [
      "give_payment",
      "product",
      "shop_order",
      "revision",
      "user_request",
      "wc_thing",
      "edd_payment",
      "oembed_cache",
      "give_log",
    ]) {
      expect(types).not.toContain(gone);
    }
    expect(types).toEqual([...types].sort());
  });

  for (const name of ["fineline", "ap"] as const) {
    test(`${name}: everything the pipeline needs is there, and the database is closed`, async () => {
      const { url, prefix } = await fixtureDb(name);
      const report = createReport();
      const site = await loadSiteContext({
        db: url,
        prefix,
        cssFrom: { dir: fixtureCssDir(name) },
        report,
      });
      expect(site.report).toBe(report);
      expect(site.model.posts.size).toBeGreaterThan(300);
      expect(site.options.breakpoints.map((b) => b.key)).toEqual(["lg", "md", "sm"]);
      expect(site.acf.postTypes.size).toBeGreaterThan(0);
      expect(site.media.files.length).toBeGreaterThan(100);
      expect(site.routes.all().length).toBeGreaterThan(50);
      expect(
        site.urls.urlFor(
          "post",
          site.model.site.pageOnFront === 0 ? 1 : site.model.site.pageOnFront,
        ),
      ).toBe("/");
      expect(site.components.size).toBe(name === "fineline" ? 2 : 6);
      expect(site.pluginSource).toBeUndefined();
      expect(site.theme).toBeNull();
      // routes, ACF and the model's own findings went to the one report, with the stable codes
      expect(report.entries().length).toBeGreaterThan(0);
      expect(report.entries().every((e) => e.code.includes("."))).toBe(true);
      // the default prefix is the site name's initials where it has several words, else wp
      expect(site.componentPrefix).toBe(name === "fineline" ? "fp" : "ap");
    });
  }

  test("the default post types leave out the bookkeeping types and keep every routable one", async () => {
    const { url, prefix } = await fixtureDb("ap");
    const site = await loadSiteContext({ db: url, prefix, cssFrom: { dir: fixtureCssDir("ap") } });
    const types = new Set([...site.model.posts.values()].map((p) => p.type));
    for (const t of [
      "page",
      "post",
      "episode",
      "wp_template",
      "wp_block",
      "cc_block",
      "acf-field-group",
    ])
      expect(types.has(t)).toBe(true);
    for (const t of ["revision", "user_request"]) expect(types.has(t)).toBe(false);
  });

  test("postTypes restricts the model", async () => {
    const { url, prefix } = await fixtureDb("fineline");
    const site = await loadSiteContext({
      db: url,
      prefix,
      cssFrom: { dir: fixtureCssDir("fineline") },
      postTypes: ["page"],
    });
    expect(new Set([...site.model.posts.values()].map((p) => p.type))).toEqual(new Set(["page"]));
    expect(site.components.size).toBe(0);
  });

  test("routeTypes routes a plugin's post type that ACF does not know", async () => {
    const { url, prefix } = await fixtureDb("ap");
    const base = { db: url, prefix, cssFrom: { dir: fixtureCssDir("ap") } };
    const plain = await loadSiteContext(base);
    const podcast = [...plain.model.posts.values()].find(
      (p) => p.type === "captivate_podcast" && p.status === "publish",
    )!;
    expect(plain.routes.forPost(podcast.id)).toBeUndefined();
    expect(
      plain.report
        .entries()
        .some((e) => e.code === "route.unregistered" && e.where === "post-type:captivate_podcast"),
    ).toBe(true);
    const routed = await loadSiteContext({
      ...base,
      routeTypes: { captivate_podcast: { public: true, rewriteSlug: "podcast" } },
    });
    expect(routed.routes.forPost(podcast.id)?.kind).toBe("entry");
  });

  test("siteUrl is the address uploads resolve on when it differs from the stored one, and the stored one keeps resolving", async () => {
    const { url, prefix } = await fixtureDb("fineline");
    const plain = await loadSiteContext({
      db: url,
      prefix,
      cssFrom: { dir: fixtureCssDir("fineline") },
    });
    const staged = await loadSiteContext({
      db: url,
      prefix,
      cssFrom: { dir: fixtureCssDir("fineline") },
      siteUrl: "https://staging.example.test/",
    });
    const att = [...plain.model.attachments.values()].find((a) =>
      a.url.startsWith(plain.model.site.url),
    )!;
    const stored = `${plain.model.site.url}/wp-content/uploads/${att.file}`;
    const live = `https://staging.example.test/wp-content/uploads/${att.file}`;
    expect(plain.media.mediaForUrl(stored)?.src).toBeDefined();
    expect(plain.media.mediaForUrl(live)).toBeUndefined();
    expect(staged.media.mediaForUrl(stored)?.src).toBe(plain.media.mediaForUrl(stored)?.src);
    expect(staged.media.mediaForUrl(live)?.src).toBe(plain.media.mediaForUrl(stored)?.src);
  });

  test("a missing cssFrom is refused, and a bad database is a clear error", async () => {
    const { url, prefix } = await fixtureDb("fineline");
    await expect(loadSiteContext({ db: url, prefix, cssFrom: {} })).rejects.toThrow(
      /cssFrom needs a dir or a url/,
    );
    await expect(loadSiteContext({ db: "ftp://nope", cssFrom: { dir: "x" } })).rejects.toThrow(
      /unsupported database location/,
    );
  });

  test("pluginFrom a directory gives the plugin source and the theme's style.css; without the theme it says so", async () => {
    const { url, prefix } = await fixtureDb("fineline");
    const root = join(TMP_ROOT, `site-plugin-${process.pid}`);
    scratch.push(root);
    mkdirSync(join(root, "wp-content/plugins/cwicly/build"), { recursive: true });
    mkdirSync(join(root, "wp-content/themes/cwicly"), { recursive: true });
    writeFileSync(
      join(root, "wp-content/plugins/cwicly/build/style-index.css"),
      ".cc-sct{width:100%}",
    );
    writeFileSync(join(root, "wp-content/themes/cwicly/style.css"), "body{position:relative}");
    const site = await loadSiteContext({
      db: url,
      prefix,
      cssFrom: { dir: fixtureCssDir("fineline") },
      pluginFrom: root,
    });
    expect(site.pluginSource?.get("build/style-index.css")).toBe(".cc-sct{width:100%}");
    expect(site.pluginSource?.get("build/none.css")).toBeNull();
    expect(site.theme).toBe("body{position:relative}");
    expect(site.report.entries().some((e) => e.code === "site.theme-css-missing")).toBe(false);

    const bare = join(TMP_ROOT, `site-bare-${process.pid}`);
    scratch.push(bare);
    mkdirSync(bare, { recursive: true });
    const without = await loadSiteContext({
      db: url,
      prefix,
      cssFrom: { dir: fixtureCssDir("fineline") },
      pluginFrom: bare,
    });
    expect(without.theme).toBeNull();
    expect(without.report.entries().find((e) => e.code === "site.theme-css-missing")).toMatchObject(
      { severity: "info", where: "site" },
    );
  });

  test("cssFrom a url reads the live site's stylesheets, after the local folder", async () => {
    const live = new Map<string, string>([
      ["/wp-content/uploads/cwicly/css/cc-post-1078.css", ".from-live{color:red}"],
      ["/wp-content/uploads/cwicly/cc-global-classes.css", ".only-live{color:blue}"],
    ]);
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const body = live.get(new URL(request.url).pathname);
        return body === undefined
          ? new Response("no", { status: 404 })
          : new Response(body, { headers: { "content-type": "text/css" } });
      },
    });
    try {
      const { url, prefix } = await fixtureDb("fineline");
      const both = await loadSiteContext({
        db: url,
        prefix,
        cssFrom: { dir: fixtureCssDir("fineline"), url: `http://127.0.0.1:${server.port}` },
      });
      // the local copy wins where it has the file
      expect((await both.cssSource.get("cc-global-classes.css"))?.includes(".only-live")).toBe(
        false,
      );
      // a stylesheet is read from the live site when the folder lacks it
      const dir = join(TMP_ROOT, `site-css-${process.pid}`);
      scratch.push(dir);
      mkdirSync(dir, { recursive: true });
      const mixed = await loadSiteContext({
        db: url,
        prefix,
        cssFrom: { dir, url: `http://127.0.0.1:${server.port}` },
      });
      expect(await mixed.cssSource.get("cc-post-1078.css")).toBe(".from-live{color:red}");
      expect(await mixed.cssSource.get("cc-global-classes.css")).toBe(".only-live{color:blue}");
      expect(await mixed.cssSource.get("cc-post-9.css")).toBeNull();
      const only = await loadSiteContext({
        db: url,
        prefix,
        cssFrom: { url: `http://127.0.0.1:${server.port}` },
      });
      expect(await only.cssSource.get("cc-post-1078.css")).toBe(".from-live{color:red}");
    } finally {
      await server.stop(true);
    }
  });
});

// ── Subjects ─────────────────────────────────────────────────────────────────────────────────────

describe("subjects", () => {
  test("allSubjects lists published and private content, templates, parts, components and reusable blocks", async () => {
    const fine = await loadSite("fineline");
    const counts = (subjects: Subject[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const s of subjects) out[s.kind] = (out[s.kind] ?? 0) + 1;
      return out;
    };
    expect(counts(allSubjects(fine))).toEqual({
      part: 3,
      reusable: 1,
      post: 135,
      template: 13,
      component: 2,
    });
    const ap = await loadSite("ap");
    expect(counts(allSubjects(ap))).toEqual({
      template: 20,
      part: 7,
      reusable: 7,
      post: 345,
      component: 6,
    });
    // drafts, attachments, menu items and ACF definitions are not subjects
    for (const subject of allSubjects(ap)) {
      const post = subjectPost(ap, subject)!;
      expect(["publish", "private"]).toContain(post.status);
      expect([
        "attachment",
        "nav_menu_item",
        "acf-field",
        "wp_navigation",
        "custom_css",
      ]).not.toContain(post.type);
    }
  });

  test("a subject's post, blocks, id and report location", async () => {
    const site = await loadSite("fineline");
    expect(subjectPost(site, { kind: "post", id: 5246 })?.slug).toBe("home-2");
    expect(subjectPost(site, { kind: "template", slug: "single-project" })?.type).toBe(
      "wp_template",
    );
    expect(subjectPost(site, { kind: "part", slug: "header" })?.type).toBe("wp_template_part");
    expect(subjectPost(site, { kind: "component", ref: "0a275b695a" })?.slug).toBe("icon-card");
    expect(subjectPost(site, { kind: "reusable", id: 63 })?.type).toBe("wp_block");
    expect(subjectPost(site, { kind: "template", slug: "nope" })).toBeUndefined();
    expect(subjectPost(site, { kind: "component", ref: "nope" })).toBeUndefined();
    expect(subjectBlocks(site, { kind: "template", slug: "nope" })).toEqual([]);
    expect(subjectBlocks(site, { kind: "post", id: 5246 }).length).toBeGreaterThan(0);
    expect(subjectId(site, { kind: "post", id: 5246 })).toBe("5246");
    expect(subjectId(site, { kind: "part", slug: "header" })).toBe("cwicly//header");
    expect(subjectId(site, { kind: "component", ref: "0a275b695a" })).toBe("0a275b695a");
    expect(subjectWhere(site, { kind: "template", slug: "single" })).toBe(
      "template:cwicly//single",
    );
    expect(subjectWhere(site, { kind: "reusable", id: 63 })).toBe("post:63");
    expect(subjectWhere(site, { kind: "part", slug: "footer" })).toBe("template:cwicly//footer");
    expect(subjectWhere(site, { kind: "component", ref: "0a275b695a" })).toBe(
      "component:0a275b695a",
    );
  });

  test("template defaults follow the template hierarchy's names", async () => {
    const fine = await loadSite("fineline");
    const d = (slug: string) => subjectDefaults(fine, { kind: "template", slug });
    expect(d("single")).toMatchObject({
      mode: "entry",
      entryType: "post",
      entryExpr: "state.entry",
      target: "page",
    });
    expect(d("single-project")).toMatchObject({ mode: "entry", entryType: "project" });
    expect(d("single-service")).toMatchObject({ mode: "entry", entryType: "service" });
    expect(d("singular")).toMatchObject({ mode: "entry" });
    expect(d("singular").entryType).toBeUndefined();
    expect(d("taxonomy-project_tag")).toMatchObject({ mode: "entry", termExpr: "state.term" });
    expect(d("taxonomy-location")).toMatchObject({ mode: "entry", termExpr: "state.term" });
    expect(d("category")).toMatchObject({ mode: "entry", termExpr: "state.term" });
    expect(d("tag")).toMatchObject({ mode: "entry", termExpr: "state.term" });
    expect(d("archive-project")).toMatchObject({ mode: "static", entryType: "project" });
    for (const slug of [
      "index",
      "page",
      "404",
      "search",
      "front-page",
      "home",
      "wp-custom-template-blank",
    ]) {
      expect(d(slug)).toMatchObject({ mode: "static", target: "page" });
      expect(d(slug).termExpr).toBeUndefined();
    }
    // a single template of a type nothing has is still an entry, of no known type
    expect(d("single-gadget")).toEqual({ mode: "entry", entryExpr: "state.entry", target: "page" });
    const ap = await loadSite("ap");
    expect(
      subjectDefaults(ap, { kind: "template", slug: "single-supporters_update" }),
    ).toMatchObject({ entryType: "supporters_update" });
    // a hyphenated taxonomy still reads as one
    expect(subjectDefaults(ap, { kind: "template", slug: "taxonomy-series" })).toMatchObject({
      termExpr: "state.term",
    });
  });

  test("post, part, component and reusable defaults: pages are pages, every other type is an entry", async () => {
    for (const name of ["fineline", "ap"] as const) {
      const site = await loadSite(name);
      for (const subject of allSubjects(site)) {
        const defaults = subjectDefaults(site, subject);
        const post = subjectPost(site, subject)!;
        if (subject.kind === "post") {
          expect(defaults.mode).toBe("static");
          expect(defaults.entryType).toBe(post.type);
          expect(defaults.target).toBe(post.type === "page" ? "page" : "markdown");
        } else if (subject.kind === "component") {
          expect(defaults).toEqual({ mode: "component", entryExpr: "state.entry", target: "page" });
        } else if (subject.kind === "part" || subject.kind === "reusable") {
          expect(defaults).toEqual({ mode: "static", entryExpr: "state.entry", target: "page" });
        }
      }
    }
  });

  test("subjectCtx for a page: static, a page, the post, its own stylesheet, URL tools bound to its report", async () => {
    const site = await loadSite("fineline");
    const ctx = await subjectCtx(site, { kind: "post", id: 5246 });
    expect(ctx.mode).toBe("static");
    expect(ctx.target).toBe("page");
    expect(ctx.entryExpr).toBe("state.entry");
    expect(ctx.entryType).toBe("page");
    expect(ctx.termExpr).toBeUndefined();
    expect(ctx.subject).toMatchObject({ kind: "post", id: "5246" });
    expect(ctx.subject.post?.slug).toBe("home-2");
    expect(ctx.model).toBe(site.model);
    expect(ctx.cwicly).toBe(site.options);
    expect(ctx.acf).toBe(site.acf);
    expect(ctx.components).toBe(site.components);
    expect(ctx.props).toBeUndefined();
    expect(ctx.css.classes.size).toBeGreaterThan(100);
    // the URL tools write into this subject's report, located at it, and an unresolvable address is unchanged
    const stray = `${site.model.site.url}/no-such-page-here/`;
    expect(ctx.rewriteUrl(stray)).toBe(stray);
    expect(ctx.report.entries()).toContainEqual(
      expect.objectContaining({ code: "url.unresolved", where: "post:5246" }),
    );
    expect(
      site.report.entries().some((e) => e.code === "url.unresolved" && e.where === "post:5246"),
    ).toBe(false);
    expect(ctx.rewriteUrl(`${site.model.site.url}/`)).toBe("/");
    expect(ctx.urlFor("post", 5246)).toBe("/");
    expect(ctx.urlForArchive?.("project")).toBe(site.urls.urlForArchive("project"));
    expect(ctx.urlForAuthor?.(1)).toBe(site.urls.urlForAuthor(1));
    const attachment = [...site.model.attachments.values()][0]!;
    expect(ctx.mediaFor(attachment.id)).toEqual(site.media.mediaFor(attachment.id));
    expect(ctx.mediaForUrl(attachment.url)).toEqual(site.media.mediaForUrl(attachment.url));
  });

  test("subjectCtx for a project is a Markdown entry of its type; for a template, a page at the template's id", async () => {
    const site = await loadSite("fineline");
    const project = [...site.model.posts.values()].find(
      (p) => p.type === "project" && p.status === "publish",
    )!;
    const entry = await subjectCtx(site, { kind: "post", id: project.id });
    expect(entry).toMatchObject({ mode: "static", target: "markdown", entryType: "project" });
    const template = await subjectCtx(site, { kind: "template", slug: "single-project" });
    expect(template).toMatchObject({ mode: "entry", target: "page", entryType: "project" });
    expect(template.subject).toMatchObject({ kind: "template", id: "cwicly//single-project" });
    const taxonomy = await subjectCtx(site, { kind: "template", slug: "taxonomy-location" });
    expect(taxonomy.termExpr).toBe("state.term");
    const part = await subjectCtx(site, { kind: "part", slug: "header" });
    expect(part).toMatchObject({ mode: "static", target: "page" });
    expect(part.subject.id).toBe("cwicly//header");
    const reusable = await subjectCtx(site, { kind: "reusable", id: 63 });
    expect(reusable.subject).toMatchObject({ kind: "post", id: "63" });
    expect(reusable.subject.post?.type).toBe("wp_block");
  });

  test("subjectCtx for a component maps its prop ids to state keys", async () => {
    const site = await loadSite("fineline");
    const ctx = await subjectCtx(site, { kind: "component", ref: "0a275b695a" });
    const info = site.components.get("0a275b695a")!;
    expect(ctx.mode).toBe("component");
    expect(ctx.subject).toMatchObject({ kind: "component", id: "0a275b695a" });
    expect([...ctx.props!]).toEqual(info.props.map((p) => [p.id, p.key]));
    expect(ctx.props!.size).toBe(5);
    // a component the model does not hold has no props and no post, and the context still builds
    const ghost = await subjectCtx(site, { kind: "component", ref: "ghost" });
    expect(ghost.props).toBeUndefined();
    expect(ghost.subject.post).toBeUndefined();
  });

  test("overrides replace any field, and a given report receives the URL tools' findings", async () => {
    const site = await loadSite("fineline");
    const report = createReport();
    const ctx = await subjectCtx(
      site,
      { kind: "post", id: 5246 },
      {
        mode: "entry",
        entryExpr: "$map.item",
        entryType: "project",
        termExpr: "state.term",
        target: "markdown",
        report,
      },
    );
    expect(ctx).toMatchObject({
      mode: "entry",
      entryExpr: "$map.item",
      entryType: "project",
      termExpr: "state.term",
      target: "markdown",
    });
    expect(ctx.report).toBe(report);
    ctx.rewriteUrl(`${site.model.site.url}/no-such-page-here/`);
    // the subject's own stylesheet findings are in it too; the URL tools' is the last
    expect(report.entries().at(-1)?.code).toBe("url.unresolved");
    expect(report.entries().filter((e) => e.code === "url.unresolved")).toHaveLength(1);
    const own = await subjectCtx(site, { kind: "post", id: 5246 }, { convert: () => ["mine"] });
    expect(own.convert([])).toEqual(["mine"]);
  });

  test("hoist collects rules in order and defineState keeps definitions apart", async () => {
    const site = await loadSite("fineline");
    const session = await subjectSession(site, { kind: "post", id: 5246 });
    session.ctx.hoist?.({ selector: "@keyframes spin", style: { from: {} } });
    session.ctx.hoist?.({ selector: ".a", style: { color: "red" } });
    expect(session.hoisted.map((r) => r.selector)).toEqual(["@keyframes spin", ".a"]);
    const { ctx } = session;
    expect(
      ctx.defineState("rows", { $prototype: "ContentCollection", contentType: "project" }),
    ).toBe("rows");
    // the same definition under the same key is one entry
    expect(
      ctx.defineState("rows", { $prototype: "ContentCollection", contentType: "project" }),
    ).toBe("rows");
    // another definition under a taken key gets its own key, and keeps counting
    expect(
      ctx.defineState("rows", { $prototype: "ContentCollection", contentType: "service" }),
    ).toBe("rows_2");
    expect(
      ctx.defineState("rows", { $prototype: "ContentCollection", contentType: "service" }),
    ).toBe("rows_2");
    expect(ctx.defineState("rows", { $prototype: "ContentCollection", contentType: "post" })).toBe(
      "rows_3",
    );
    expect([...session.state.keys()]).toEqual(["rows", "rows_2", "rows_3"]);
    // sessions do not share collectors
    const other = await subjectSession(site, { kind: "post", id: 5246 });
    expect(other.hoisted).toEqual([]);
    expect(other.state.size).toBe(0);
  });

  test("an @import statement is kept for the project head, never hoisted onto a page", async () => {
    const site = await loadSite("fineline");
    const session = await subjectSession(site, { kind: "part", slug: "header" });
    // the header's own stylesheet opens with the Google font its nav picks
    expect(importedStyleRules(site).map((rule) => rule.key)).toEqual([
      expect.stringContaining("fonts.googleapis.com/css?family=Reem Kufi"),
    ]);
    // a block that hoists the statement (every block of that stylesheet does) loses nothing and fills no page
    session.ctx.hoist?.({
      selector: '@import url("https://fonts.googleapis.com/css?family=Inter")',
      style: {},
    });
    session.ctx.hoist?.({ selector: "@keyframes spin", style: { from: {} } });
    expect(session.hoisted.map((r) => r.selector)).toEqual(["@keyframes spin"]);
    expect(importedStyleRules(site).map((rule) => rule.key)).toHaveLength(2);
    // another site has its own list
    expect(
      importedStyleRules(await loadSite("ap"))
        .map((r) => r.key)
        .join(),
    ).not.toContain("Reem");
  });

  test("ctx.convert goes through the registry, and overrides compose down the tree", async () => {
    const site = await loadSite("fineline");
    const seen: string[] = [];
    const outer: BlockConverter = (block, ctx) => {
      // a loop: its items are read through $map.item, in entry mode
      return ctx.convert(block.innerBlocks, { entryExpr: "$map.item", mode: "entry" });
    };
    const middle: BlockConverter = (block, ctx) => {
      seen.push(`middle ${ctx.entryExpr} ${ctx.mode}`);
      // a second override leaves the first in place
      return ctx.convert(block.innerBlocks, { rowExpr: "$map.row" });
    };
    const probe: BlockConverter = (_block, ctx) => {
      seen.push(`probe ${ctx.entryExpr} ${ctx.mode} ${ctx.rowExpr ?? "-"}`);
      return [`${ctx.entryExpr}|${ctx.mode}|${ctx.rowExpr ?? "-"}`];
    };
    registerConverters({ "test/outer": outer, "test/middle": middle, "test/probe": probe });
    const block = (name: string, innerBlocks: WpBlock[] = []): WpBlock => ({
      name,
      attrs: {},
      innerBlocks,
      innerHTML: "",
      innerContent: [],
    });
    const ctx = await subjectCtx(site, { kind: "post", id: 5246 });
    const nodes = ctx.convert([
      block("test/probe"),
      block("test/outer", [block("test/middle", [block("test/probe")]), block("test/probe")]),
    ]);
    expect(nodes).toEqual([
      "state.entry|static|-",
      "$map.item|entry|$map.row",
      "$map.item|entry|-",
    ]);
    // the parent's context is untouched
    expect(ctx.entryExpr).toBe("state.entry");
    expect(ctx.mode).toBe("static");
    expect(seen).toEqual([
      "probe state.entry static -",
      "middle $map.item entry",
      "probe $map.item entry $map.row",
      "probe $map.item entry -",
    ]);
  });
});

// ── CSS per subject ──────────────────────────────────────────────────────────────────────────────

describe("the CSS of a subject", () => {
  test("a page loads the global files, its own, and its parts', components' and reusable blocks'", async () => {
    const site = await loadSite("fineline");
    const names = cssNamesFor(site, { kind: "post", id: 1078 });
    // the live head's order: the global stylesheets, the global classes, the parts and components, the post's own file last
    expect(names.slice(0, 2)).toEqual(["cc-global-stylesheets.css", "cc-global-classes.css"]);
    expect(names.at(-1)).toBe("cc-post-1078.css");
    const refs = new Set<string>();
    walkBlocks(subjectBlocks(site, { kind: "post", id: 1078 }), (b) => {
      if (b.name === "cwicly/component" && typeof b.attrs.ref === "string") refs.add(b.attrs.ref);
    });
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) expect(names).toContain(`cc-cm-${ref}.css`);
    expect(new Set(names).size).toBe(names.length);
  });

  test("a template pulls in the parts it embeds, and a part that embeds a component pulls in the component's file", async () => {
    const site = await loadSite("fineline");
    const names = cssNamesFor(site, { kind: "template", slug: "single-project" });
    expect(names).toContain("cc-tp-cwicly_single-project.css");
    expect(names).toContain("cc-tp-cwicly_header.css");
    expect(names).toContain("cc-tp-cwicly_footer.css");
    const ap = await loadSite("ap");
    const reusable = cssNamesFor(ap, {
      kind: "post",
      id: Number(
        [...ap.model.posts.values()].find((p) => /<!-- wp:block \{"ref":\d+/.test(p.content))?.id,
      ),
    });
    expect(reusable.some((n) => n.startsWith("cc-rb-"))).toBe(true);
  });

  test("ownCssName is the subject's own file", async () => {
    const site = await loadSite("fineline");
    expect(ownCssName(site, { kind: "post", id: 5 })).toBe("cc-post-5.css");
    expect(ownCssName(site, { kind: "template", slug: "single" })).toBe("cc-tp-cwicly_single.css");
    expect(ownCssName(site, { kind: "part", slug: "header" })).toBe("cc-tp-cwicly_header.css");
    expect(ownCssName(site, { kind: "component", ref: "abc" })).toBe("cc-cm-abc.css");
    expect(ownCssName(site, { kind: "reusable", id: 9 })).toBe("cc-rb-9.css");
  });

  test("the index knows the page's own classes, and two subjects never share a style object", async () => {
    const site = await loadSite("fineline");
    const a = await cssIndexFor(site, { kind: "post", id: 5246 });
    const b = await cssIndexFor(site, { kind: "post", id: 5246 });
    expect(a).not.toBe(b);
    let styled = 0;
    let resolved = 0;
    walkBlocks(subjectBlocks(site, { kind: "post", id: 5246 }), (block) => {
      const classID = block.attrs.classID;
      if (
        block.name?.startsWith("cwicly/") &&
        block.attrs.isStyling === true &&
        typeof classID === "string"
      ) {
        styled++;
        if (a.classes.has(classID)) resolved++;
      }
    });
    expect(resolved / styled).toBeGreaterThan(0.6);
    const [name, entry] = [...a.classes][0]!;
    entry.style.color = "mutated";
    expect((b.classes.get(name)!.style as Record<string, unknown>).color).not.toBe("mutated");
    const c = await cssIndexFor(site, { kind: "post", id: 5246 });
    expect((c.classes.get(name)!.style as Record<string, unknown>).color).not.toBe("mutated");
  });

  test("a file is read once per site however many subjects load it", async () => {
    const loaded = await loadSite("fineline");
    const calls: string[] = [];
    const counted: SiteContext = {
      ...loaded,
      cssSource: {
        get(name) {
          calls.push(name);
          return loaded.cssSource.get(name);
        },
      },
    };
    await subjectCtx(counted, { kind: "post", id: 5246 });
    await subjectCtx(counted, { kind: "post", id: 1078 });
    await subjectCtx(counted, { kind: "template", slug: "single-project" });
    expect(calls.filter((n) => n === "cc-global-classes.css")).toHaveLength(1);
    expect(calls.filter((n) => n === "cc-tp-cwicly_header.css")).toHaveLength(1);
    expect(new Set(calls).size).toBe(calls.length);
  });

  for (const name of ["fineline", "ap"] as const) {
    test(`${name}: the findings about a stylesheet are the subject's own file's, located at the subject`, async () => {
      const site = await loadSite(name);
      let missing = 0;
      let artifacts = 0;
      for (const subject of allSubjects(site)) {
        const report = createReport();
        await reportOwnCss(site, subject, report, subjectWhere(site, subject));
        const own = ownCssName(site, subject);
        for (const entry of report.entries()) {
          if (!entry.code.startsWith("css.")) continue;
          expect(entry.where).toBe(subjectWhere(site, subject));
          expect((entry.data as { file: string }).file).toBe(own!);
          if (entry.code === "css.missing-file") {
            missing++;
            // a subject whose Cwicly blocks style themselves has lost something; one with none has not
            const styled = [] as WpBlock[];
            walkBlocks(subjectBlocks(site, subject), (b) => {
              if (b.name?.startsWith("cwicly/") && b.attrs.isStyling === true) styled.push(b);
            });
            expect(entry.severity).toBe(styled.length > 0 ? "warn" : "info");
          } else artifacts++;
        }
      }
      expect(missing).toBeGreaterThan(0);
      console.log(`css findings ${name}: ${missing} missing files, ${artifacts} artifacts`);
    });
  }

  test("a missing file that a remembered 404 answered says so, with the marker to delete and the flag that asks again", async () => {
    const site = await loadSite("fineline");
    const subject = { kind: "post", id: 1078 } as const;
    const own = ownCssName(site, subject)!;
    const marker = `/cache/site/.absent/${own}`;
    const plain = createReport();
    await reportOwnCss(
      { ...site, cssSource: { get: async () => null } },
      subject,
      plain,
      "page:1078",
    );
    const [asked] = plain.entries().filter((e) => e.code === "css.missing-file");
    expect(asked!.message).not.toContain("remembered");
    const remembering = createReport();
    const cssSource = {
      get: async () => null,
      remembered: (name: string) => (name === own ? { file: marker, expires: 1e12 } : undefined),
    };
    await reportOwnCss({ ...site, cssSource }, subject, remembering, "page:1078");
    const [entry] = remembering.entries().filter((e) => e.code === "css.missing-file");
    expect(entry!.message).toContain(`stylesheet ${own} was not found`);
    expect(entry!.message).toContain("remembered");
    expect(entry!.message).toContain(marker);
    expect(entry!.message).toContain("--css-cache-absent-ttl 0");
    expect(entry!.data).toMatchObject({ file: own, remembered: true });
  });

  test("a subject with a stylesheet of its own and nothing wrong in it reports nothing about it", async () => {
    const site = await loadSite("fineline");
    const report = createReport();
    await reportOwnCss(site, { kind: "part", slug: "footer" }, report, "template:cwicly//footer");
    expect(report.entries().filter((e) => e.code === "css.missing-file")).toEqual([]);
  });

  test("a context starts with an empty report: the stylesheet findings are the conversion's", async () => {
    const site = await loadSite("fineline");
    // the stylesheet of fineline's page 1013 holds an artifact the reader reports
    const subject = { kind: "post", id: 1013 } as const;
    const ctx = await subjectCtx(site, subject);
    expect(ctx.report.entries()).toEqual([]);
    const converted = await convertSubject(site, subject);
    expect(converted.report.entries().filter((e) => e.code.startsWith("css."))).not.toEqual([]);
    expect(converted.report.entries().every((e) => e.where === "post:1013")).toBe(true);
  });
});

// ── Findings of the driver review: each one reproduced on real data first ───────────────────────

/** A post with only what a test sets: the rest is what a plain published post has. */
const probePost = (id: number, patch: Partial<WpPost>): WpPost => ({
  id,
  type: "page",
  status: "publish",
  slug: `probe-${id}`,
  title: "Probe",
  content: "",
  excerpt: "",
  date: "2024-01-01T00:00:00Z",
  modified: "2024-01-01T00:00:00Z",
  parent: 0,
  menuOrder: 0,
  authorId: 1,
  guid: "",
  passwordProtected: false,
  ...patch,
});

/** The site with extra posts, FIRST in the model's order (the position a first-match lookup would take), and their meta and terms. */
function withExtra(
  site: SiteContext,
  extra: {
    posts: WpPost[];
    meta?: Record<number, Record<string, unknown[]>>;
    terms?: Record<number, number[]>;
  },
): SiteContext {
  const posts = new Map<number, WpPost>(extra.posts.map((post) => [post.id, post]));
  for (const [id, post] of site.model.posts) posts.set(id, post);
  const postMeta = new Map(site.model.postMeta);
  for (const [id, meta] of Object.entries(extra.meta ?? {})) postMeta.set(Number(id), meta);
  const termsByPost = new Map(site.model.termsByPost);
  for (const [id, terms] of Object.entries(extra.terms ?? {})) termsByPost.set(Number(id), terms);
  return { ...site, model: { ...site.model, posts, postMeta, termsByPost } };
}

describe("a stylesheet read that fails", () => {
  test("is asked for again, and one transient failure does not poison every subject that shares the file", async () => {
    const loaded = await loadSite("fineline");
    const calls: string[] = [];
    let failures = 1;
    const flaky: SiteContext = {
      ...loaded,
      cssSource: {
        async get(name) {
          calls.push(name);
          if (name === "cc-global-classes.css" && failures-- > 0)
            throw new Error("ECONNRESET (transient)");
          return loaded.cssSource.get(name);
        },
      },
    };
    await expect(cssIndexFor(flaky, { kind: "post", id: 5246 })).rejects.toThrow("ECONNRESET");
    // the next subject that needs the shared file reads it again, and succeeds
    const index = await cssIndexFor(flaky, { kind: "post", id: 1078 });
    expect(index.classes.size).toBeGreaterThan(0);
    expect(calls.filter((n) => n === "cc-global-classes.css")).toHaveLength(2);
    // and a success is remembered as before: nobody asks a third time
    await cssIndexFor(flaky, { kind: "post", id: 5246 });
    await convertSubject(flaky, { kind: "post", id: 5246 });
    expect(calls.filter((n) => n === "cc-global-classes.css")).toHaveLength(2);
  });
});

describe("stylesheet names built from block attributes", () => {
  const hostile = [
    `<!-- wp:template-part {"slug":"../../x"} /-->`,
    `<!-- wp:template-part {"slug":"header","theme":"a/b"} /-->`,
    `<!-- wp:cwicly/component {"ref":"a/b"} /-->`,
    `<!-- wp:template-part {"slug":"x\\u0000y"} /-->`,
    `<!-- wp:template-part {"slug":"ok","theme":"t?x#y"} /-->`,
    `<!-- wp:cwicly/component {"ref":"0a275b695a"} /-->`,
  ].join("\n");

  test("isCssFileName accepts a plain file name and nothing that could leave the folder or change the address", () => {
    for (const ok of ["cc-post-5.css", "cc-tp-cwicly_header-light.css", "cc-cm-0a275b695a.css"])
      expect(isCssFileName(ok)).toBe(true);
    for (const bad of [
      "",
      ".",
      "..",
      "a/b.css",
      "a\\b.css",
      "a\0b.css",
      "a?b.css",
      "a#b.css",
      "a\nb",
    ])
      expect(isCssFileName(bad)).toBe(false);
  });

  test("a hostile slug, theme or reference is a finding of the subject, not a failure of the conversion", async () => {
    const loaded = await loadSite("fineline");
    const site = withExtra(loaded, {
      posts: [probePost(990010, { content: hostile })],
    });
    const subject = { kind: "post", id: 990010 } as const;
    const plan = cssPlanFor(site, subject);
    expect(plan.invalid).toEqual([
      "cc-tp-cwicly_../../x.css",
      "cc-tp-a/b_header.css",
      "cc-cm-a/b.css",
      "cc-tp-cwicly_x\0y.css",
      "cc-tp-t?x#y_ok.css",
    ]);
    // a source that refuses such a name (the real directory one does) is never asked
    expect(plan.names.every(isCssFileName)).toBe(true);
    expect(plan.names).toContain("cc-cm-0a275b695a.css");
    expect(cssNamesFor(site, subject)).toEqual(plan.names);
    await expect(cssIndexFor(site, subject)).resolves.toBeDefined();
    const converted = await convertSubject(site, subject);
    const found = converted.report.entries().filter((e) => e.code === "css.invalid-reference");
    expect(found.map((e) => (e.data as { file: string }).file)).toEqual(plan.invalid);
    expect(found.every((e) => e.severity === "warn" && e.where === "post:990010")).toBe(true);
    // the valid component beside them still contributed its file
    expect(converted.used.cssFiles.has("cc-cm-0a275b695a.css")).toBe(true);
    expect(converted.used.cssFiles.has("cc-tp-a/b_header.css")).toBe(false);
  });

  test("an invalid subject (a component reference with a slash) is reported and converts to nothing instead of throwing", async () => {
    const site = await loadSite("fineline");
    const subject = { kind: "component", ref: "a/b" } as const;
    const converted = await convertSubject(site, subject);
    expect(converted.report.entries().map((e) => e.code)).toEqual(
      expect.arrayContaining(["css.invalid-reference", "subject.missing"]),
    );
    expect(converted.nodes).toEqual([]);
  });
});

describe("the order of a subject's stylesheets is the live head's", () => {
  const liveOrder = (site: "ap" | "fineline", page: string): string[] => {
    const html = readFileSync(join(FIXTURES, site, "html", page), "utf8");
    return [...new Set([...html.matchAll(/(cc-[A-Za-z0-9_.-]+\.css)/g)].map((m) => m[1]!))];
  };

  test("the global stylesheets, then the global classes: on the same selector the classes win, as live", async () => {
    const loaded = await loadSite("fineline");
    const source: CssSource = {
      async get(name) {
        if (name === "cc-global-stylesheets.css") return ".x{color:red}";
        if (name === "cc-global-classes.css") return ".x{color:blue}";
        return null;
      },
    };
    const site: SiteContext = { ...loaded, cssSource: source };
    const index = await cssIndexFor(site, { kind: "post", id: 5246 });
    expect(index.classes.get("x")?.style).toMatchObject({ color: "blue" });
    expect(cssNamesFor(loaded, { kind: "post", id: 5246 }).slice(0, 2)).toEqual([
      "cc-global-stylesheets.css",
      "cc-global-classes.css",
    ]);
  });

  test("a post's own file comes after everything it embeds, a template's before its parts: the order of the live pages", async () => {
    const ap = await loadSite("ap");
    const live = liveOrder("ap", "essays__the-essence-of-anabaptism-dean-taylor.html");
    // live: globals, the template's file, its parts and components, and the post's file last
    expect(live.at(-1)).toBe("cc-post-727.css");
    const post = cssNamesFor(ap, { kind: "post", id: 727 });
    expect(post).toEqual(["cc-global-stylesheets.css", "cc-global-classes.css", "cc-post-727.css"]);
    const before = (names: string[], a: string, b: string): boolean =>
      names.indexOf(a) < names.indexOf(b);
    expect(before(live, post[0]!, post[1]!)).toBe(true);
    expect(before(live, post[1]!, post[2]!)).toBe(true);

    const template = cssNamesFor(ap, { kind: "template", slug: "single-post" });
    expect(template.slice(0, 3)).toEqual([
      "cc-global-stylesheets.css",
      "cc-global-classes.css",
      "cc-tp-cwicly_single-post.css",
    ]);
    const own = "cc-tp-cwicly_single-post.css";
    for (const embedded of template.slice(3)) {
      if (!live.includes(embedded)) continue;
      expect(before(live, own, embedded)).toBe(true);
      expect(before(template, own, embedded)).toBe(true);
    }
  });

  test("a post that embeds a part still ends with its own file", async () => {
    const fine = await loadSite("fineline");
    const site = withExtra(fine, {
      posts: [
        probePost(990011, {
          content: `<!-- wp:template-part {"slug":"footer","theme":"cwicly"} /-->`,
        }),
      ],
    });
    const names = cssNamesFor(site, { kind: "post", id: 990011 });
    expect(names).toEqual([
      "cc-global-stylesheets.css",
      "cc-global-classes.css",
      "cc-tp-cwicly_footer.css",
      "cc-post-990011.css",
    ]);
  });
});

describe("the component prefix", () => {
  test("defaultPrefix: the initials of at most four words, and wp for a name with fewer than two", () => {
    expect(defaultPrefix("Anabaptist Perspectives")).toBe("ap");
    expect(defaultPrefix("Fine Line Painting")).toBe("flp");
    expect(defaultPrefix("A B C D E F")).toBe("abcd");
    expect(defaultPrefix("Solo")).toBe("wp");
    expect(defaultPrefix("")).toBe("wp");
    expect(defaultPrefix("2024 2025")).toBe("wp");
  });

  test("it is made from the site name as text: an entity in the stored name is decoded first", async () => {
    const { url, path, prefix } = await fixtureDb("fineline");
    const dir = join(TMP_ROOT, `site-prefix-${process.pid}`);
    scratch.push(dir);
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, "site.sqlite");
    copyFileSync(path, copy);
    const db = new Database(copy);
    db.run(`update ${prefix}options set option_value = ? where option_name = 'blogname'`, [
      "Missions &amp; Evangelism",
    ]);
    db.close();
    const site = await loadSiteContext({
      db: `sqlite:${copy}`,
      prefix,
      cssFrom: { dir: fixtureCssDir("fineline") },
    });
    expect(site.model.site.name).toBe("Missions &amp; Evangelism");
    // `Missions`, `amp`, `Evangelism` would be "mae": the entity is not a word
    expect(site.componentPrefix).toBe("me");
    expect(url).toContain("fixture-fineline");
  });
});

describe("loading closes the database", () => {
  test("once the model is read, and when reading it fails", async () => {
    const openDb = realDb.openDb;
    const closed: string[] = [];
    let failQueries = false;
    const file = resolve(import.meta.dir, "../src/wp/db.ts");
    mock.module(file, () => ({
      ...realDb,
      openDb: async (...args: Parameters<typeof openDb>) => {
        const db = await openDb(...args);
        return {
          prefix: db.prefix,
          table: (name: string) => db.table(name),
          query: (...q: Parameters<typeof db.query>) =>
            failQueries ? Promise.reject(new Error("connection lost")) : db.query(...q),
          async close() {
            closed.push("close");
            await db.close();
          },
        };
      },
    }));
    try {
      const { url, prefix } = await fixtureDb("fineline");
      const cssFrom = { dir: fixtureCssDir("fineline") };
      await loadSiteContext({ db: url, prefix, cssFrom });
      expect(closed).toEqual(["close"]);
      closed.length = 0;
      failQueries = true;
      await expect(loadSiteContext({ db: url, prefix, cssFrom })).rejects.toThrow(
        "connection lost",
      );
      expect(closed).toEqual(["close"]);
    } finally {
      mock.module(file, () => ({ ...realDb, openDb }));
    }
  });
});

describe("the post types the census leaves out are reported", () => {
  const stub = (rows: { post_type: string; n: number | string }[]) => ({
    table: (name: string) => `x_${name}`,
    async query<T>(sql: string): Promise<T[]> {
      expect(sql).toContain("x_posts");
      return rows as T[];
    },
  });

  test("reportExcludedTypes: one info entry per type with rows that is not loaded, with its count and why", async () => {
    const report = createReport();
    await reportExcludedTypes(
      stub([
        { post_type: "give_payment", n: "3780" },
        { post_type: "post", n: 5 },
        { post_type: "oembed_cache", n: 2 },
        { post_type: "fc_template", n: 1 },
      ]),
      ["post"],
      report,
    );
    expect(report.entries().map((e) => [e.severity, e.code, e.data])).toEqual([
      [
        "info",
        "site.post-type-excluded",
        { type: "give_payment", rows: 3780, reason: "commerce or payment records" },
      ],
      ["info", "site.post-type-excluded", { type: "oembed_cache", rows: 2, reason: "bookkeeping" }],
      [
        "info",
        "site.post-type-excluded",
        { type: "fc_template", rows: 1, reason: "no published or private row" },
      ],
    ]);
    expect(report.entries().every((e) => e.where === "site")).toBe(true);
  });

  test("loading ap says which of its post types were left out (types with only drafts, here)", async () => {
    const { url, prefix } = await fixtureDb("ap");
    const report = createReport();
    await loadSiteContext({ db: url, prefix, cssFrom: { dir: fixtureCssDir("ap") }, report });
    const left = report
      .entries()
      .filter((e) => e.code === "site.post-type-excluded")
      .map((e) => (e.data as { type: string }).type);
    expect(left.sort()).toEqual(["fc_template", "fcrm-dummy", "rm_content_editor"]);
    // an explicit list is the caller's own decision, and is not second-guessed
    const explicit = createReport();
    await loadSiteContext({
      db: url,
      prefix,
      cssFrom: { dir: fixtureCssDir("ap") },
      postTypes: ["post", "page"],
      report: explicit,
    });
    expect(explicit.entries().filter((e) => e.code === "site.post-type-excluded")).toEqual([]);
  });

  test("a custom type that starts with shop_ is content; WooCommerce's own order types are not", async () => {
    const types = await publishedPostTypes(
      stub([
        { post_type: "shop_location", n: 4 },
        { post_type: "shop_order", n: 9 },
        { post_type: "shop_order_refund", n: 1 },
        { post_type: "shop_coupon", n: 1 },
      ]),
    );
    expect(types).toContain("shop_location");
    for (const gone of ["shop_order", "shop_order_refund", "shop_coupon"])
      expect(types).not.toContain(gone);
  });
});

describe("templates, parts and components that a slug or a reference can name twice", () => {
  test("a private template or part is listed AND converted: allSubjects, subjectPost and the tag table agree", async () => {
    const fine = await loadSite("fineline");
    const single = [...fine.model.posts.values()].find(
      (p) => p.type === "wp_template" && p.slug === "single-project",
    )!;
    const header = [...fine.model.posts.values()].find(
      (p) => p.type === "wp_template_part" && p.slug === "footer",
    )!;
    const site = withExtra(fine, {
      posts: [
        probePost(990020, {
          type: "wp_template",
          slug: "single-private",
          status: "private",
          content: single.content,
        }),
        probePost(990021, {
          type: "wp_template_part",
          slug: "aside-private",
          status: "private",
          content: header.content,
        }),
      ],
    });
    const subjects = allSubjects(site);
    expect(subjects).toContainEqual({ kind: "template", slug: "single-private" });
    expect(subjects).toContainEqual({ kind: "part", slug: "aside-private" });
    for (const subject of subjects.filter(
      (s) => (s.kind === "template" && s.slug === "single-private") || s.kind === "part",
    )) {
      expect(subjectPost(site, subject)).toBeDefined();
      const converted = await convertSubject(site, subject);
      expect(converted.report.entries().filter((e) => e.code === "subject.missing")).toEqual([]);
      expect(converted.nodes.length).toBeGreaterThan(0);
    }
    expect(partTag(site, "aside-private")).toBe("wp-aside-private");
    expect(siteTags(site).has("wp-aside-private")).toBe(true);
  });

  test("a draft is no template or part, however early it comes, and a published post beats a private one", async () => {
    const fine = await loadSite("fineline");
    const real = subjectPost(fine, { kind: "part", slug: "footer" })!;
    const site = withExtra(fine, {
      posts: [
        probePost(990030, {
          type: "wp_template_part",
          slug: "footer",
          status: "draft",
          content: "STALE DRAFT",
        }),
        probePost(990031, {
          type: "wp_template_part",
          slug: "footer",
          status: "private",
          content: "PRIVATE COPY",
        }),
        probePost(990032, { type: "wp_template", slug: "only-draft", status: "draft" }),
      ],
    });
    expect(subjectPost(site, { kind: "part", slug: "footer" })?.id).toBe(real.id);
    expect(subjectPost(site, { kind: "template", slug: "only-draft" })).toBeUndefined();
    const subjects = allSubjects(site);
    expect(subjects.filter((s) => s.kind === "part" && s.slug === "footer")).toHaveLength(1);
    expect(subjects).not.toContainEqual({ kind: "template", slug: "only-draft" });
    // the private copy alone would be used
    const lone = withExtra(fine, {
      posts: [
        probePost(990033, {
          type: "wp_template_part",
          slug: "lonely",
          status: "private",
          content: "ONLY ONE",
        }),
      ],
    });
    expect(subjectPost(lone, { kind: "part", slug: "lonely" })?.id).toBe(990033);
  });

  test("a template of an inactive theme does not shadow the active theme's, and is the fallback when nothing else has the slug", async () => {
    const ap = await loadSite("ap");
    const themes = [...ap.model.terms.values()].filter((t) => t.taxonomy === "wp_theme");
    const inactive = themes.find((t) => t.slug !== ap.model.site.theme)!;
    const active = themes.find((t) => t.slug === ap.model.site.theme)!;
    expect(inactive).toBeDefined();
    const real = subjectPost(ap, { kind: "part", slug: "header" })!;
    expect(ap.model.termsByPost.get(real.id)).toContain(active.termId);
    const site = withExtra(ap, {
      posts: [
        // lower in the model's order than the real header: a first match would take it
        probePost(990040, {
          type: "wp_template_part",
          slug: "header",
          content: "STALE OLD THEME HEADER",
        }),
        probePost(990041, {
          type: "wp_template_part",
          slug: "header",
          content: "HAND MADE, NO THEME",
        }),
        probePost(990042, { type: "wp_template_part", slug: "old-only", content: "OLD ONLY" }),
      ],
      terms: { 990040: [inactive.termId], 990042: [inactive.termId] },
    });
    expect(subjectPost(site, { kind: "part", slug: "header" })?.id).toBe(real.id);
    expect(subjectPost(site, { kind: "part", slug: "old-only" })?.id).toBe(990042);
    // one subject for the slug, not one per post, and the tag table names it once
    expect(allSubjects(site).filter((s) => s.kind === "part" && s.slug === "header")).toHaveLength(
      1,
    );
    expect(partTag(site, "header")).toBe(partTag(ap, "header"));
    // without the active theme's post the theme-less one beats another theme's
    const without = withExtra(
      {
        ...ap,
        model: {
          ...ap.model,
          posts: new Map([...ap.model.posts].filter(([id]) => id !== real.id)),
        },
      },
      {
        posts: [
          probePost(990043, { type: "wp_template_part", slug: "header", content: "OLD" }),
          probePost(990044, { type: "wp_template_part", slug: "header", content: "PLAIN" }),
        ],
        terms: { 990043: [inactive.termId] },
      },
    );
    expect(subjectPost(without, { kind: "part", slug: "header" })?.id).toBe(990044);
  });

  test("a component reference two posts share is converted once, as the first, and the other is reported", async () => {
    const fine = await loadSite("fineline");
    const first = [...fine.model.posts.values()].find(
      (p) => p.type === "cc_block" && p.slug === "icon-card",
    )!;
    const ref = "0a275b695a";
    const site = withExtra(fine, {
      posts: [
        probePost(990050, { type: "cc_block", slug: "stale-draft", status: "draft", content: "x" }),
      ],
      meta: { 990050: { reference: [ref] } },
    });
    // a draft is not a component, so the published post still answers for the reference
    expect(subjectPost(site, { kind: "component", ref })?.id).toBe(first.id);

    const copy = { ...first, id: 990051, slug: "icon-card-copy" };
    const orphan = probePost(990052, { type: "cc_block", slug: "no-reference" });
    const dup = withExtra(fine, {
      posts: [],
      meta: { 990051: fine.model.postMeta.get(first.id)!, 990052: {} },
    });
    const posts = new Map(dup.model.posts);
    posts.set(copy.id, copy);
    posts.set(orphan.id, orphan);
    const model: WpModel = { ...dup.model, posts };
    const report = createReport();
    const infos = componentInfos(model, "fp", report);
    expect(infos.get(ref)?.postId).toBe(first.id);
    expect(infos.size).toBe(fine.components.size);
    const entries = report.entries();
    expect(entries.find((e) => e.code === "component.duplicate-reference")).toMatchObject({
      severity: "warn",
      where: "post:990051",
      data: { ref, kept: first.id, ignored: 990051 },
    });
    expect(entries.find((e) => e.code === "component.no-reference")).toMatchObject({
      severity: "warn",
      where: "post:990052",
    });
    const all = allSubjects({ model });
    expect(all.filter((s) => s.kind === "component" && s.ref === ref)).toHaveLength(1);
    expect(all.filter((s) => s.kind === "component")).toHaveLength(fine.components.size);
    // without a report, nothing is said and nothing throws
    expect(componentInfos(model, "fp").size).toBe(fine.components.size);
  });
});

describe("allSubjects routedOnly", () => {
  test("drops the configuration posts of plugins that have no route, and keeps pages, templates, parts, components and reusable blocks", async () => {
    const ap = await loadSite("ap");
    const all = allSubjects(ap);
    const routed = allSubjects(ap, { routedOnly: true });
    const type = (s: Subject): string =>
      s.kind === "post" ? ap.model.posts.get(s.id)!.type : s.kind;
    // plugin configuration is in the default sweep ...
    expect(all.some((s) => type(s) === "uip-ui-template")).toBe(true);
    expect(all.some((s) => type(s) === "captivate_podcast")).toBe(true);
    // ... and out of the routed one, which holds what a site would serve
    for (const s of routed) {
      if (s.kind === "post" && type(s) !== "page") expect(ap.routes.forPost(s.id)).toBeDefined();
    }
    for (const gone of [
      "uip-ui-template",
      "uipress_admin_menu",
      "give_pdf_template",
      "captivate_podcast",
    ])
      expect(routed.some((s) => type(s) === gone)).toBe(false);
    const kinds = (list: Subject[], kind: Subject["kind"]): number =>
      list.filter((s) => s.kind === kind).length;
    for (const kind of ["template", "part", "component", "reusable"] as const)
      expect(kinds(routed, kind)).toBe(kinds(all, kind));
    expect(routed.filter((s) => type(s) === "page")).toEqual(all.filter((s) => type(s) === "page"));
    expect(routed.length).toBeLessThan(all.length);
    // without a route table the option has nothing to ask, and does nothing
    expect(allSubjects({ model: ap.model }, { routedOnly: true })).toEqual(
      allSubjects({ model: ap.model }),
    );
  });
});

describe("template defaults for names that start like a term archive", () => {
  test("tag-<slug> and category-<slug> render a term; a `tag-` prefix is not just any template", async () => {
    const fine = await loadSite("fineline");
    for (const slug of ["tag-news", "category-news", "tag", "category", "taxonomy-genre"]) {
      expect(subjectDefaults(fine, { kind: "template", slug })).toMatchObject({
        mode: "entry",
        termExpr: "state.term",
      });
    }
    for (const slug of ["tagline", "categories", "front-page"]) {
      expect(subjectDefaults(fine, { kind: "template", slug }).termExpr).toBeUndefined();
    }
  });
});
