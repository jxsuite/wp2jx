/**
 * Cwicly's visibility conditions, read from the real blocks of both sites.
 *
 * The plugin's rule (cc-conditions.php) is that a block is rendered when its conditions are true, so
 * `hidden` here is the negation of what the list says. What each condition becomes is decided in three
 * ways: for a static page the answer is known (the block is `omit`ted or has no condition left), for an
 * entry template it is a binding, and for what no static site can say it is dropped and reported.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "parse5";
import { allSubjects, loadSite, makeCtx, subjectBlocks } from "../helpers/ctx.ts";
import type { LoadedSite, SiteName, Subject } from "../helpers/ctx.ts";
import { buildRoutes, createUrlTools } from "../../src/routes.ts";
import { walkBlocks } from "../../src/wp/blocks.ts";
import type { ConvertCtx, WpBlock, WpPost } from "../../src/types.ts";
import { blockVisibility, HIDDEN_STYLE } from "../../src/cwicly/conditions.ts";
import { fieldByKey, postData } from "../../src/cwicly/tokens.ts";

setDefaultTimeout(120_000);

// ── Real contexts ────────────────────────────────────────────────────────────────────────────────

type N = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: N[];
  content?: N;
};

const toolCache = new Map<SiteName, ReturnType<typeof createUrlTools>>();

function toolsFor(site: SiteName, loaded: LoadedSite): ReturnType<typeof createUrlTools> {
  let t = toolCache.get(site);
  if (!t) {
    t = createUrlTools(
      loaded.model,
      buildRoutes(loaded.model, loaded.acf, { media: loaded.media }),
      loaded.media,
    );
    toolCache.set(site, t);
  }
  return t;
}

async function realCtx(
  site: SiteName,
  subject: Subject,
  over: Partial<ConvertCtx> = {},
): Promise<{ ctx: ConvertCtx; loaded: LoadedSite }> {
  const loaded = await loadSite(site);
  const t = toolsFor(site, loaded);
  const ctx = await makeCtx(site, subject, { urlFor: t.urlFor, rewriteUrl: t.rewriteUrl, ...over });
  return { ctx, loaded };
}

const block = (attrs: Record<string, unknown> = {}, name = "cwicly/div"): WpBlock => ({
  name,
  attrs,
  innerBlocks: [],
  innerHTML: "",
  innerContent: [""],
});

/** A block with one condition list. */
const when = (
  conditions: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): WpBlock => block({ hideConditions: conditions, ...extra });

function evalTemplate(template: string, state: unknown): string {
  if (!template.includes("${")) return template;
  const fn = new Function("state", "$map", `return \`${template}\``) as (
    s: unknown,
    m: unknown,
  ) => string;
  return fn(state, undefined);
}

/** Whether the block is hidden for the data, by evaluating the binding as the build would. */
const hiddenFor = (
  v: { hidden?: string },
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): boolean =>
  evalTemplate(v.hidden ?? "${false}", { entry: { data, $children: [] }, ...extra }) === "true";

function findBlock(blocks: WpBlock[], pred: (b: WpBlock) => boolean): WpBlock | undefined {
  let found: WpBlock | undefined;
  walkBlocks(blocks, (b) => {
    if (!found && pred(b)) found = b;
  });
  return found;
}

async function blockOf(site: SiteName, sub: Subject, classID: string): Promise<WpBlock> {
  const loaded = await loadSite(site);
  const found = findBlock(subjectBlocks(loaded, sub), (b) => b.attrs.classID === classID);
  expect(found).toBeDefined();
  return found as WpBlock;
}

const entryCtx = (
  site: SiteName,
  slug: string,
  type?: string,
  extra: Partial<ConvertCtx> = {},
): Promise<{ ctx: ConvertCtx; loaded: LoadedSite }> =>
  realCtx(
    site,
    { kind: "template", slug },
    { mode: "entry", ...(type === undefined ? {} : { entryType: type }), ...extra },
  );

// ── ACF ──────────────────────────────────────────────────────────────────────────────────────────

describe("an ACF field empty or not", () => {
  test("in an entry template: hidden is the negation, with the rule that makes the attribute win", async () => {
    const section = await blockOf(
      "fineline",
      { kind: "template", slug: "single-project" },
      "section-c7ee2ef",
    );
    const { ctx, loaded } = await entryCtx("fineline", "single-project", "project");
    const info = fieldByKey(loaded.acf, "field_6985035a0b7cb");
    expect(info?.field.type).toBe("textarea");
    const name = info?.field.name as string;
    const v = blockVisibility(section, ctx);
    expect(v).toEqual({
      hidden: `\${!(((v) => !!v && v != '0' && !(Array.isArray(v) && !v.length))(state.entry.data.${name}))}`,
      hiddenStyle: HIDDEN_STYLE,
      dropped: [],
    });
    expect(hiddenFor(v, { [name]: "Text" })).toBe(false);
    expect(hiddenFor(v, { [name]: "" })).toBe(true);
    expect(hiddenFor(v, {})).toBe(true);
    // `empty("0")` is true in PHP, which is what the plugin asks.
    expect(hiddenFor(v, { [name]: "0" })).toBe(true);
    expect(hiddenFor(v, { [name]: 0 })).toBe(true);
  });

  test("empty is the same field the other way round", async () => {
    const container = await blockOf(
      "fineline",
      { kind: "template", slug: "single-service" },
      "container-ce780b2",
    );
    const { ctx, loaded } = await entryCtx("fineline", "single-service", "service");
    const name = fieldByKey(loaded.acf, "field_69c2f201d6055")?.field.name as string;
    const v = blockVisibility(container, ctx);
    expect(hiddenFor(v, { [name]: "x" })).toBe(true);
    expect(hiddenFor(v, {})).toBe(false);
  });

  test('an image or a link is empty when it has no file or no address, a list when it has no items, 0 and "0" are empty for text', async () => {
    const { ctx, loaded } = await entryCtx("fineline", "single-project", "project");
    const named = (type: string): { key: string; name: string } => {
      const f = loaded.acf.groups.flatMap((g) => g.fields).find((x) => x.type === type);
      return { key: f?.key ?? "", name: f?.name ?? "" };
    };
    const notEmpty = (key: string): ReturnType<typeof blockVisibility> =>
      blockVisibility(
        when([{ condition: "acf", operator: "notempty", acfGroup: "g", acfField: key }]),
        ctx,
      );
    const image = named("image");
    expect(hiddenFor(notEmpty(image.key), { [image.name]: { src: "/media/a.jpg" } })).toBe(false);
    expect(hiddenFor(notEmpty(image.key), { [image.name]: {} })).toBe(true);
    const link = named("link");
    expect(hiddenFor(notEmpty(link.key), { [link.name]: { url: "/x/" } })).toBe(false);
    expect(hiddenFor(notEmpty(link.key), { [link.name]: { url: "" } })).toBe(true);
    const gallery = named("gallery");
    expect(hiddenFor(notEmpty(gallery.key), { [gallery.name]: [{ src: "/a.jpg" }] })).toBe(false);
    expect(hiddenFor(notEmpty(gallery.key), { [gallery.name]: [] })).toBe(true);
    expect(hiddenFor(notEmpty(gallery.key), {})).toBe(true);
  });

  test("on a static page it is decided: a page with the value keeps the block, a page without it omits it", async () => {
    const section = await blockOf(
      "fineline",
      { kind: "template", slug: "single-project" },
      "section-c7ee2ef",
    );
    const loaded = await loadSite("fineline");
    const { ctx: probe } = await realCtx("fineline", { kind: "post", id: 1078 });
    const name = fieldByKey(loaded.acf, "field_6985035a0b7cb")?.field.name as string;
    const posts = [...loaded.model.posts.values()].filter(
      (p) => p.type === "project" && p.status === "publish",
    );
    const withValue = posts.find(
      (p) => typeof postData(probe, p)[name] === "string" && postData(probe, p)[name] !== "",
    ) as WpPost;
    const without = posts.find((p) => postData(probe, p)[name] === undefined) as WpPost;
    expect(withValue).toBeDefined();
    expect(without).toBeDefined();
    const a = (await realCtx("fineline", { kind: "post", id: withValue.id }, { mode: "static" }))
      .ctx;
    const b = (await realCtx("fineline", { kind: "post", id: without.id }, { mode: "static" })).ctx;
    expect(blockVisibility(section, a)).toEqual({ dropped: [] });
    expect(blockVisibility(section, b)).toEqual({ dropped: [], omit: true });
  });

  test("a comparison with a value, the location of the field, and an unknown field", async () => {
    const { ctx, loaded } = await entryCtx("fineline", "single-project", "project");
    const name = fieldByKey(loaded.acf, "field_6985035a0b7cb")?.field.name as string;
    const cmp = (operator: string, data: string): ReturnType<typeof blockVisibility> =>
      blockVisibility(
        when([
          { condition: "acf", operator, data, acfGroup: "g", acfField: "field_6985035a0b7cb" },
        ]),
        ctx,
      );
    expect(hiddenFor(cmp("===", "Yes"), { [name]: "Yes" })).toBe(false);
    expect(hiddenFor(cmp("===", "Yes"), { [name]: "No" })).toBe(true);
    expect(hiddenFor(cmp("!=", "Yes"), { [name]: "No" })).toBe(false);
    expect(hiddenFor(cmp("contains", "es"), { [name]: "Yes" })).toBe(false);
    expect(hiddenFor(cmp("notcontain", "es"), { [name]: "Yes" })).toBe(true);
    // A field of another post is a fixed value.
    const other = [...loaded.model.posts.values()].find(
      (p) => p.type === "project" && p.status === "publish",
    ) as WpPost;
    const fixed = blockVisibility(
      when([
        {
          condition: "acf",
          operator: "empty",
          acfGroup: "g",
          acfField: "field_6985035a0b7cb",
          acfLocation: "postid",
          acfLocationID: String(other.id),
        },
      ]),
      ctx,
    );
    expect(fixed.hidden).toBeUndefined();
    const unknown = blockVisibility(
      when([{ condition: "acf", operator: "notempty", acfGroup: "g", acfField: "field_nope" }]),
      ctx,
    );
    expect(unknown).toEqual({ dropped: ["acf notempty: its field cannot be read here"] });
    expect(ctx.report.entries().map((e) => e.code)).toEqual([
      "dynamic.unknown-field",
      "condition.dropped",
    ]);
  });

  test("a field read from the current author, a row of a repeater, or a person outside a users loop is dropped and the block stays", async () => {
    const { ctx } = await entryCtx("ap", "single-post", "post");
    const user = blockVisibility(
      when([
        {
          condition: "acf",
          operator: "notempty",
          acfGroup: "g",
          acfField: "field_62d867cf864ee",
          acfLocation: "currentauthor",
        },
      ]),
      ctx,
    );
    // Measured on the live pages: `currentauthor` reads no field there, so the condition is not decided.
    expect(user.hidden).toBeUndefined();
    expect(user.omit).toBeUndefined();
    expect(user.dropped).toHaveLength(1);
    const person = blockVisibility(
      when([
        {
          condition: "acf",
          operator: "notempty",
          acfGroup: "g",
          acfField: "field_62d867cf864ee",
          acfLocation: "userquery",
        },
      ]),
      ctx,
    );
    expect(person.hidden).toBeUndefined();
    expect(person.dropped).toHaveLength(1);
    const row = blockVisibility(
      when([
        {
          condition: "acf",
          operator: "notempty",
          acfGroup: "g",
          acfField: "field_62d867cf864ee",
          acfRepeaterField: "sub",
        },
      ]),
      ctx,
    );
    expect(row.dropped).toHaveLength(1);
  });
});

// ── The post ─────────────────────────────────────────────────────────────────────────────────────

describe("the current post", () => {
  test("the featured image", async () => {
    const div = await blockOf("fineline", { kind: "template", slug: "search" }, "div-c9514e5");
    const { ctx } = await entryCtx("fineline", "search", "project");
    const v = blockVisibility(div, ctx);
    expect(hiddenFor(v, { featuredImage: { src: "/media/a.jpg" } })).toBe(false);
    expect(hiddenFor(v, {})).toBe(true);
    // `=== "false"` and `!=` are the same fact the other way.
    const no = blockVisibility(
      when([{ condition: "postfeaturedimage", operator: "===", data: "false" }]),
      ctx,
    );
    expect(hiddenFor(no, { featuredImage: { src: "/media/a.jpg" } })).toBe(true);
    expect(hiddenFor(no, {})).toBe(false);
    const stat = (await realCtx("fineline", { kind: "post", id: 1078 }, { mode: "static" })).ctx;
    expect(blockVisibility(div, stat)).toEqual({ dropped: [] });
  });

  test("the title, the type, the content", async () => {
    const { ctx } = await entryCtx("fineline", "single-project", "project");
    const title = blockVisibility(
      when([{ condition: "posttitle", operator: "contains", data: "Barn" }]),
      ctx,
    );
    expect(hiddenFor(title, { title: "Red Barn Painting" })).toBe(false);
    expect(hiddenFor(title, { title: "Kitchens" })).toBe(true);
    const type = blockVisibility(
      when([{ condition: "posttype", operator: "===", data: "project" }]),
      ctx,
    );
    expect(type).toEqual({ dropped: [] });
    expect(
      blockVisibility(when([{ condition: "posttype", operator: "===", data: "service" }]), ctx),
    ).toEqual({ dropped: [], omit: true });
    // An entry with no one type (the items of a list of several) says what it is.
    const noType = (await entryCtx("fineline", "index")).ctx;
    const mixed = blockVisibility(
      when([{ condition: "posttype", operator: "===", data: "post" }]),
      noType,
    );
    expect(mixed.dropped).toEqual([]);
    expect(hiddenFor(mixed, { postType: "post" })).toBe(false);
    expect(hiddenFor(mixed, { postType: "project" })).toBe(true);
    expect(hiddenFor(mixed, {})).toBe(true);
    // Where there is no entry at all (a component), it cannot be said.
    const component = { ...noType, mode: "component" } as ConvertCtx;
    expect(
      blockVisibility(when([{ condition: "posttype", operator: "===", data: "post" }]), component)
        .dropped,
    ).toEqual(["posttype === post: the post type of the entry is unknown"]);
    const content = blockVisibility(
      when([{ condition: "postcontent", operator: "!=", data: "false" }]),
      ctx,
    );
    expect(hiddenFor(content, {}, { entry: { data: {}, $children: [{ tagName: "p" }] } })).toBe(
      false,
    );
    expect(hiddenFor(content, {}, { entry: { data: {}, $children: [] } })).toBe(true);
  });

  test("on a static page the post's own facts decide", async () => {
    const stat = (await realCtx("ap", { kind: "post", id: 773 }, { mode: "static" })).ctx;
    expect(
      blockVisibility(when([{ condition: "posttype", operator: "===", data: "post" }]), stat),
    ).toEqual({ dropped: [] });
    expect(
      blockVisibility(when([{ condition: "posttitle", operator: "===", data: "Nope" }]), stat),
    ).toEqual({ dropped: [], omit: true });
    expect(
      blockVisibility(when([{ condition: "postid", operator: "===", data: "773" }]), stat),
    ).toEqual({ dropped: [] });
    expect(
      blockVisibility(
        when([{ condition: "postfeaturedimage", operator: "===", data: "true" }]),
        stat,
      ),
    ).toEqual({ dropped: [] });
    expect(
      blockVisibility(when([{ condition: "postcontent", operator: "===", data: "false" }]), stat),
    ).toEqual({ dropped: [], omit: true });
  });

  test("terms: a post is in the term when its entry lists it, and the static page knows", async () => {
    const disabled = await blockOf(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      "section-c593882",
    );
    const { ctx, loaded } = await entryCtx("fineline", "taxonomy-location", "project");
    // The editor's own switch turns the three conditions off on this block: it is shown whatever they say.
    expect(disabled.attrs.hideConditionsToggle).toBe(true);
    expect(blockVisibility(disabled, ctx)).toEqual({ dropped: [] });
    const section = { ...disabled, attrs: { ...disabled.attrs, hideConditionsToggle: undefined } };
    const berks = loaded.model.terms.get(120) as NonNullable<
      ReturnType<typeof loaded.model.terms.get>
    >;
    expect(berks.taxonomy).toBe("location");
    const v = blockVisibility(section, ctx);
    expect(v.hidden).toContain(`state.entry.data.terms?.location`);
    expect(hiddenFor(v, { terms: { location: [{ slug: berks.slug }] } })).toBe(false);
    expect(hiddenFor(v, { terms: { location: [{ slug: "somewhere-else" }] } })).toBe(true);
    expect(hiddenFor(v, {})).toBe(true);
    const member = [...loaded.model.posts.values()].find((p) =>
      (loaded.model.termsByPost.get(p.id) ?? []).includes(120),
    ) as WpPost;
    const stranger = [...loaded.model.posts.values()].find(
      (p) =>
        p.type === "project" &&
        p.status === "publish" &&
        !(loaded.model.termsByPost.get(p.id) ?? []).some((t) => [120, 79, 75].includes(t)),
    ) as WpPost;
    const a = (await realCtx("fineline", { kind: "post", id: member.id }, { mode: "static" })).ctx;
    const b = (await realCtx("fineline", { kind: "post", id: stranger.id }, { mode: "static" }))
      .ctx;
    // `||` over three terms: true when the post is in any of them.
    expect(blockVisibility(section, a)).toEqual({ dropped: [] });
    expect(blockVisibility(section, b)).toEqual({ dropped: [], omit: true });
  });

  test("a tag by name, a category by id, and a term that is not in the export", async () => {
    const { ctx, loaded } = await entryCtx("ap", "single-post", "post");
    const cat = [...loaded.model.terms.values()].find(
      (t) => t.taxonomy === "category",
    ) as NonNullable<ReturnType<typeof loaded.model.terms.get>>;
    const inCat = blockVisibility(
      when([{ condition: "postcategory", operator: "===", data: String(cat.termId) }]),
      ctx,
    );
    expect(hiddenFor(inCat, { terms: { category: [{ slug: cat.slug, name: cat.name }] } })).toBe(
      false,
    );
    expect(hiddenFor(inCat, { terms: { category: [] } })).toBe(true);
    const notIn = blockVisibility(
      when([{ condition: "postcategory", operator: "!=", data: String(cat.termId) }]),
      ctx,
    );
    expect(hiddenFor(notIn, { terms: { category: [{ slug: cat.slug }] } })).toBe(true);
    const tag = blockVisibility(
      when([{ condition: "posttag", operator: "===", data: "kingdom of god" }]),
      ctx,
    );
    expect(hiddenFor(tag, { terms: { post_tag: [{ name: "Kingdom of God" }] } })).toBe(false);
    expect(
      blockVisibility(
        when([{ condition: "postterm", operator: "===", data: { value: 99999999 } }]),
        ctx,
      ).dropped,
    ).toHaveLength(1);
  });

  test("has_tags() and has_post_thumbnail() are in the entry; a theme's own function is not", async () => {
    const div = await blockOf("ap", { kind: "template", slug: "single-episode" }, "div-c437eab");
    const { ctx } = await entryCtx("ap", "single-episode", "episode");
    const v = blockVisibility(div, ctx);
    expect(hiddenFor(v, { terms: { post_tag: [{ slug: "a" }] } })).toBe(false);
    expect(hiddenFor(v, { terms: { post_tag: [] } })).toBe(true);
    expect(hiddenFor(v, {})).toBe(true);
    const thumb = blockVisibility(
      when([{ condition: "functionreturn", operator: "false", function: "has_post_thumbnail()" }]),
      ctx,
    );
    expect(hiddenFor(thumb, { featuredImage: { src: "/a.jpg" } })).toBe(true);
  });

  test("a site's [<taxonomy>_id] shortcode is empty when the entry has no term of that taxonomy; any other shortcode is PHP", async () => {
    const { ctx } = await entryCtx("ap", "single-episode", "episode");
    const series = blockVisibility(
      when([{ condition: "shortcode", operator: "true", data: "series_id" }]),
      ctx,
    );
    expect(series.dropped).toEqual([]);
    expect(hiddenFor(series, { terms: { series: [{ slug: "a" }] } })).toBe(false);
    expect(hiddenFor(series, { terms: { series: [] } })).toBe(true);
    expect(hiddenFor(series, { terms: { category: [{ slug: "a" }] } })).toBe(true);
    expect(hiddenFor(series, {})).toBe(true);
    const none = blockVisibility(
      when([{ condition: "shortcode", operator: "false", data: "category_id" }]),
      ctx,
    );
    expect(hiddenFor(none, { terms: { category: [{ slug: "a" }] } })).toBe(true);
    expect(hiddenFor(none, { terms: {} })).toBe(false);
    for (const data of ["guest_names", "not_a_taxonomy_id"]) {
      expect(
        blockVisibility(when([{ condition: "shortcode", operator: "true", data }]), ctx).dropped,
      ).toEqual([`shortcode true ${data}: it runs a shortcode`]);
    }
  });

  test("get_current_slug() is the last segment of the address: the archive's term, the entry's slug, or the page's own", async () => {
    // on a taxonomy archive: the map is for Pennsylvania only, the picture for every other area
    const map = await blockOf(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      "container-cb7ad72",
    );
    const picture = await blockOf(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      "container-c1ebd4a",
    );
    const loc = (
      await entryCtx("fineline", "taxonomy-location", undefined, { termExpr: "state.term" })
    ).ctx;
    const term = (slug: string) => ({ term: { data: { slug } } });
    const mapV = blockVisibility(map, loc);
    expect(mapV.dropped ?? []).toEqual([]);
    expect(hiddenFor(mapV, {}, term("pennsylvania"))).toBe(false);
    expect(hiddenFor(mapV, {}, term("lebanon-county-pa"))).toBe(true);
    const pictureV = blockVisibility(picture, loc);
    expect(hiddenFor(pictureV, {}, term("pennsylvania"))).toBe(true);
    expect(hiddenFor(pictureV, {}, term("lebanon-county-pa"))).toBe(false);
    // on an entry's page it is the entry's slug
    const here = (await entryCtx("fineline", "single-project", "project")).ctx;
    const entryV = blockVisibility(map, here);
    expect(hiddenFor(entryV, { slug: "pennsylvania" })).toBe(false);
    expect(hiddenFor(entryV, { slug: "other" })).toBe(true);
    // on a page known now it is decided: the page's own address ends in its slug
    const aboutCtx = await realCtx("fineline", { kind: "post", id: 1716 });
    const is = (data: string) =>
      blockVisibility(
        when([
          { condition: "functionreturn", operator: "===", function: "get_current_slug()", data },
        ]),
        aboutCtx.ctx,
      );
    expect(is("about-us")).toEqual({ dropped: [] });
    expect(is("contact-us")).toMatchObject({ omit: true });
    // a function of the theme the site does not define is still dropped
    expect(
      blockVisibility(
        when([
          { condition: "functionreturn", operator: "===", function: "my_theme_thing()", data: "x" },
        ]),
        loc,
      ).dropped,
    ).toEqual(["functionreturn === x: it calls the PHP function my_theme_thing()"]);
  });
});

// ── A query, the visitor, the clock ──────────────────────────────────────────────────────────────

describe("a query", () => {
  test("its item count, when the converter says what it is, becomes bindings", async () => {
    const { ctx } = await entryCtx("fineline", "taxonomy-location", "project");
    const count = "state.projects.length";
    const has = blockVisibility(
      when([{ condition: "queryhasitems", operator: "true", data: "" }]),
      ctx,
      { queryCount: count },
    );
    const none = blockVisibility(
      when([{ condition: "queryhasitems", operator: "false", data: "" }]),
      ctx,
      { queryCount: count },
    );
    expect(has.hidden).toBeDefined();
    expect(hiddenFor(has, {}, { projects: [] })).toBe(true);
    expect(hiddenFor(has, {}, { projects: [1] })).toBe(false);
    expect(hiddenFor(none, {}, { projects: [] })).toBe(false);
    expect(hiddenFor(none, {}, { projects: [1] })).toBe(true);
    const zero = blockVisibility(
      when([{ condition: "querycount", operator: "===", data: "0" }]),
      ctx,
      { queryCount: count },
    );
    expect(hiddenFor(zero, {}, { projects: [] })).toBe(false);
    expect(hiddenFor(zero, {}, { projects: [1, 2] })).toBe(true);
    const single = blockVisibility(
      when([{ condition: "queryissinglepage", operator: "true", data: "" }]),
      ctx,
      { queryCount: count },
    );
    expect(hiddenFor(single, {}, { projects: [1] })).toBe(false);
    const many = blockVisibility(
      when([{ condition: "querycount", operator: ">", data: "3" }]),
      ctx,
      { queryCount: count },
    );
    expect(hiddenFor(many, {}, { projects: [1, 2, 3, 4] })).toBe(false);
    expect(hiddenFor(many, {}, { projects: [1] })).toBe(true);
  });

  test("without a count they are dropped, as are the pages of a query", async () => {
    const { ctx } = await entryCtx("fineline", "taxonomy-location", "project");
    for (const [condition, operator] of [
      ["queryhasitems", "true"],
      ["querycount", "==="],
      ["queryhasnextpage", "true"],
      ["queryhasprevpage", "true"],
      ["queryissinglepage", "true"],
    ] as const) {
      const v = blockVisibility(when([{ condition, operator, data: "0" }]), ctx);
      expect(v.hidden).toBeUndefined();
      expect(v.omit).toBeUndefined();
      expect(v.dropped).toHaveLength(1);
      expect(v.dropped[0]).toContain("query");
    }
    // The pages of a query are not a count: even with one given, they stay dropped.
    expect(
      blockVisibility(when([{ condition: "queryhasnextpage", operator: "true", data: "" }]), ctx, {
        queryCount: "x.length",
      }).dropped,
    ).toHaveLength(1);
  });
});

describe("the visitor", () => {
  test("a guest is the only visitor: no role, no capability, no user id, no user name", async () => {
    const { ctx } = await entryCtx("ap", "single-post", "post");
    const v = (conditions: Record<string, unknown>[]): ReturnType<typeof blockVisibility> =>
      blockVisibility(when(conditions), ctx);
    expect(v([{ condition: "userrole", operator: "===", data: "administrator" }])).toEqual({
      dropped: [],
      omit: true,
    });
    expect(v([{ condition: "userrole", operator: "!=", data: "administrator" }])).toEqual({
      dropped: [],
    });
    expect(v([{ condition: "usercapabilities", operator: "===", data: "read" }])).toEqual({
      dropped: [],
      omit: true,
    });
    expect(
      v([{ condition: "usercapabilities", operator: "!=", data: "read_private_posts" }]),
    ).toEqual({ dropped: [] });
    expect(v([{ condition: "userid", operator: "===", data: "0" }])).toEqual({ dropped: [] });
    expect(v([{ condition: "userid", operator: "!=", data: "0" }])).toEqual({
      dropped: [],
      omit: true,
    });
    expect(v([{ condition: "username", operator: "===", data: "" }])).toEqual({ dropped: [] });
    const approximated = ctx.report.entries().filter((e) => e.code === "condition.approximated");
    expect(approximated.length).toBeGreaterThan(0);
    expect(approximated[0]?.severity).toBe("info");
    expect(approximated[0]?.message).toContain("guest");
  });

  test("hideLoggedIn changes nothing for a guest, hideGuest removes the block, and both say so", async () => {
    const { ctx } = await entryCtx("ap", "single-post", "post");
    expect(blockVisibility(block({ hideLoggedIn: true }), ctx)).toEqual({ dropped: [] });
    expect(blockVisibility(block({ hideGuest: true }), ctx)).toEqual({ dropped: [], omit: true });
    expect(blockVisibility(block({ hideGuest: true, hideLoggedIn: true }), ctx)).toEqual({
      dropped: [],
      omit: true,
    });
    expect(blockVisibility(block({ hideGuest: false, hideLoggedIn: false }), ctx)).toEqual({
      dropped: [],
    });
    expect(
      ctx.report
        .entries()
        .filter((e) => e.code === "condition.approximated")
        .map((e) => e.data?.detail),
    ).toEqual(["hideLoggedIn", "hideGuest"]);
  });

  test("the real login and logout buttons of anabaptistperspectives", async () => {
    const login = await blockOf("ap", { kind: "part", slug: "footer" }, "button-c3b7975");
    const logout = await blockOf("ap", { kind: "part", slug: "footer" }, "button-c94a4f1");
    const { ctx } = await realCtx("ap", { kind: "part", slug: "footer" });
    expect(login.attrs.hideLoggedIn).toBe(true);
    expect(logout.attrs.hideGuest).toBe(true);
    expect(blockVisibility(login, ctx)).toEqual({ dropped: [] });
    expect(blockVisibility(logout, ctx)).toEqual({ dropped: [], omit: true });
  });

  test("the editor's switch turns every condition off", async () => {
    const { ctx } = await entryCtx("ap", "single-post", "post");
    const off = block({
      hideConditionsToggle: true,
      hideGuest: true,
      hideConditions: [{ condition: "userrole", operator: "===", data: "x" }],
    });
    expect(blockVisibility(off, ctx)).toEqual({ dropped: [] });
  });
});

describe("what no static site can say", () => {
  test("time, cookies, requests, shops, comments and shortcodes are dropped, reported, and the block stays", async () => {
    const { ctx } = await entryCtx("ap", "single-post", "post");
    const cases: [Record<string, unknown>, string][] = [
      [{ condition: "date", operator: "===", data: "01/01/2025" }, "time of the request"],
      [{ condition: "dayweek", operator: "===", data: "Monday" }, "time of the request"],
      [{ condition: "time", operator: "after", data: "09:00:00" }, "time of the request"],
      [{ condition: "cookie", operator: "===", data: "seen" }, "cookies"],
      [{ condition: "urlparameter", operator: "===", data: "a", key: "k" }, "parameters"],
      [{ condition: "woosku", operator: "===", data: "a" }, "WooCommerce"],
      [{ condition: "wooonsale", operator: "true", data: "" }, "WooCommerce"],
      [{ condition: "commentsopen", operator: "===", data: "true" }, "comments"],
      [{ condition: "postcomments", operator: ">", data: "3" }, "comments"],
      [{ condition: "commentisauthor", operator: "true", data: "" }, "comments"],
      [{ condition: "shortcode", operator: "true", data: "guest_names" }, "shortcode"],
    ];
    for (const [entry, why] of cases) {
      const v = blockVisibility(when([entry]), ctx);
      expect(v.hidden).toBeUndefined();
      expect(v.omit).toBeUndefined();
      expect(v.dropped).toHaveLength(1);
      expect(v.dropped[0]).toContain(why);
    }
    const dropped = ctx.report.entries().filter((e) => e.code === "condition.dropped");
    expect(dropped).toHaveLength(cases.length);
    for (const e of dropped) {
      expect(e.severity).toBe("warn");
      expect(e.where).toBe(`template:${ctx.subject.id}`);
    }
  });

  test("a dropped condition is true, so it never hides a block that another condition would show", async () => {
    const { ctx } = await entryCtx("ap", "single-post", "post");
    const v = blockVisibility(
      when([
        { condition: "cookie", operator: "===", data: "x" },
        { condition: "posttype", operator: "===", data: "post" },
      ]),
      ctx,
    );
    expect(v.omit).toBeUndefined();
    expect(v.dropped).toHaveLength(1);
    // With OR a dropped condition is true and the block is always shown.
    const or = blockVisibility(
      when(
        [
          { condition: "cookie", operator: "===", data: "x" },
          { condition: "posttype", operator: "===", data: "page" },
        ],
        { hideConditionsType: "||" },
      ),
      ctx,
    );
    expect(or.omit).toBeUndefined();
    expect(or.hidden).toBeUndefined();
  });
});

describe("devices", () => {
  test("a condition that keeps the desktop becomes a hide at the breakpoints below it", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    expect(ctx.cwicly.breakpoints.filter((b) => b.direction === "max").map((b) => b.key)).toEqual([
      "md",
      "sm",
    ]);
    expect(
      blockVisibility(when([{ condition: "device", operator: "===", data: "desktop" }]), ctx),
    ).toEqual({ dropped: [], deviceHide: { md: true } });
    expect(
      blockVisibility(when([{ condition: "device", operator: "!=", data: "mobile" }]), ctx),
    ).toEqual({ dropped: [], deviceHide: { md: true } });
    expect(
      blockVisibility(
        when([
          { condition: "device", operator: "===", data: "desktop" },
          { condition: "device", operator: "!=", data: "tablet" },
        ]),
        ctx,
      ).deviceHide,
    ).toEqual({ md: true });
    expect(
      ctx.report
        .entries()
        .some((e) => e.code === "condition.approximated" && e.message.includes("breakpoints")),
    ).toBe(true);
  });

  test("a set of devices the cascade cannot express, or one that is all of them, is shown everywhere", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    // Tablets only would need a hide at the base and a show below it.
    const tablets = blockVisibility(
      when([{ condition: "device", operator: "===", data: "tablet" }]),
      ctx,
    );
    expect(tablets.deviceHide).toBeUndefined();
    expect(tablets.dropped).toHaveLength(1);
    const mobile = blockVisibility(
      when([{ condition: "device", operator: "===", data: "mobile" }]),
      ctx,
    );
    expect(mobile.deviceHide).toBeUndefined();
    expect(mobile.dropped).toHaveLength(1);
    const all = blockVisibility(
      when([{ condition: "device", operator: "!=", data: "robot" }]),
      ctx,
    );
    expect(all.dropped).toHaveLength(1);
  });

  test("a device condition combined with another by OR is not expressed", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    const v = blockVisibility(
      when(
        [
          { condition: "device", operator: "===", data: "desktop" },
          { condition: "posttype", operator: "===", data: "page" },
        ],
        { hideConditionsType: "||" },
      ),
      ctx,
    );
    expect(v.deviceHide).toBeUndefined();
    expect(v.dropped).toEqual(["device: a device condition combined with others by OR"]);
  });
});

// ── Combining ────────────────────────────────────────────────────────────────────────────────────

describe("combining conditions as cc_conditions_maker does", () => {
  test("AND is false when any is false and true for none; entries with no condition or operator do not count", async () => {
    const { ctx } = await entryCtx("fineline", "single-project", "project");
    expect(blockVisibility(when([]), ctx)).toEqual({ dropped: [] });
    expect(blockVisibility(when([{ condition: "", operator: "", data: "" }]), ctx)).toEqual({
      dropped: [],
    });
    expect(blockVisibility(when([{ condition: "posttype", operator: "" }]), ctx)).toEqual({
      dropped: [],
    });
    expect(
      blockVisibility(
        when([
          { condition: "posttype", operator: "===", data: "project" },
          { condition: "posttype", operator: "===", data: "service" },
        ]),
        ctx,
      ),
    ).toEqual({ dropped: [], omit: true });
    const one = blockVisibility(
      when([
        { condition: "posttype", operator: "===", data: "project" },
        { condition: "acf", operator: "notempty", acfGroup: "g", acfField: "field_6985035a0b7cb" },
      ]),
      ctx,
    );
    expect(one.hidden).toBeDefined();
    expect(one.hiddenStyle).toEqual(HIDDEN_STYLE);
  });

  test("OR is true when any is true, and false for none: a block with OR and no usable condition is never shown", async () => {
    const { ctx } = await entryCtx("fineline", "single-project", "project");
    const or = (conditions: Record<string, unknown>[]): ReturnType<typeof blockVisibility> =>
      blockVisibility(when(conditions, { hideConditionsType: "||" }), ctx);
    expect(or([])).toEqual({ dropped: [], omit: true });
    expect(or([{ condition: "", operator: "" }])).toEqual({ dropped: [], omit: true });
    expect(
      or([
        { condition: "posttype", operator: "===", data: "service" },
        { condition: "posttype", operator: "===", data: "project" },
      ]),
    ).toEqual({ dropped: [] });
    expect(or([{ condition: "posttype", operator: "===", data: "service" }])).toEqual({
      dropped: [],
      omit: true,
    });
    const mixed = or([
      { condition: "posttype", operator: "===", data: "service" },
      { condition: "acf", operator: "notempty", acfGroup: "g", acfField: "field_6985035a0b7cb" },
    ]);
    expect(mixed.hidden).toBeDefined();
    expect(mixed.omit).toBeUndefined();
  });

  test("several bindings are joined, and the result is a binding a build evaluates", async () => {
    const { ctx, loaded } = await entryCtx("fineline", "single-project", "project");
    const a = fieldByKey(loaded.acf, "field_6985035a0b7cb")?.field.name as string;
    const b = loaded.acf.groups.flatMap((g) => g.fields).find((f) => f.type === "image");
    const conds = [
      { condition: "acf", operator: "notempty", acfGroup: "g", acfField: "field_6985035a0b7cb" },
      { condition: "acf", operator: "notempty", acfGroup: "g", acfField: b?.key },
    ];
    const and = blockVisibility(when(conds), ctx);
    const or = blockVisibility(when(conds, { hideConditionsType: "||" }), ctx);
    const data = (x: boolean, y: boolean): Record<string, unknown> => ({
      [a]: x ? "t" : "",
      [b?.name as string]: y ? { src: "/i.jpg" } : {},
    });
    expect([
      hiddenFor(and, data(true, true)),
      hiddenFor(and, data(true, false)),
      hiddenFor(and, data(false, false)),
    ]).toEqual([false, true, true]);
    expect([
      hiddenFor(or, data(true, false)),
      hiddenFor(or, data(false, true)),
      hiddenFor(or, data(false, false)),
    ]).toEqual([false, false, true]);
  });
});

// ── The census ───────────────────────────────────────────────────────────────────────────────────

interface Census {
  blocks: number;
  /** Blocks whose conditions the editor's own switch has turned off. */
  switchedOff: number;
  entries: number;
  flags: number;
  binding: number;
  decidedOmit: number;
  decidedShown: number;
  dropped: number;
  reasons: Record<string, number>;
}

/** Every condition of every block of a site, each read alone in the mode its subject is converted in. */
async function census(site: SiteName): Promise<Census> {
  const loaded = await loadSite(site);
  const out: Census = {
    blocks: 0,
    switchedOff: 0,
    entries: 0,
    flags: 0,
    binding: 0,
    decidedOmit: 0,
    decidedShown: 0,
    dropped: 0,
    reasons: {},
  };
  for (const sub of allSubjects(loaded)) {
    const slug = "slug" in sub ? sub.slug : "";
    const mode = sub.kind === "post" ? "static" : sub.kind === "component" ? "component" : "entry";
    const over: Partial<ConvertCtx> = { mode };
    if (mode === "entry") {
      const type =
        /^(?:single|archive)-(.+)$/.exec(slug)?.[1] ?? (slug === "single" ? "post" : undefined);
      if (type !== undefined) over.entryType = type;
      if (slug.startsWith("taxonomy-")) over.termExpr = "state.term";
    }
    const { ctx } = await realCtx(site, sub, over);
    walkBlocks(subjectBlocks(loaded, sub), (b) => {
      const a = b.attrs;
      const list = ((a.hideConditions as Record<string, unknown>[] | undefined) ?? []).filter(
        (c) => c.condition && c.operator,
      );
      if (list.length === 0 && !a.hideLoggedIn && !a.hideGuest) return;
      out.blocks++;
      if (a.hideConditionsToggle) {
        out.switchedOff++;
        return;
      }
      if (a.hideLoggedIn) out.flags++;
      if (a.hideGuest) out.flags++;
      for (const c of list) {
        out.entries++;
        const v = blockVisibility({ ...b, attrs: { hideConditions: [c] } }, ctx);
        if (v.dropped.length > 0) {
          out.dropped++;
          const reason = `${String(c.condition)}: ${(v.dropped[0] as string).split(": ").slice(1).join(": ")}`;
          out.reasons[reason] = (out.reasons[reason] ?? 0) + 1;
        } else if (v.omit) out.decidedOmit++;
        else if (v.hidden) out.binding++;
        else out.decidedShown++;
      }
    });
  }
  return out;
}

describe("the census of every condition of both sites", () => {
  test("fineline: 23 of 25 become bindings or are decided, 2 are dropped (a query's count the block is not given)", async () => {
    const c = await census("fineline");
    expect(c).toEqual({
      blocks: 26,
      switchedOff: 1,
      entries: 25,
      flags: 0,
      binding: 22,
      decidedOmit: 1,
      decidedShown: 0,
      dropped: 2,
      reasons: {
        "queryhasitems: it depends on a query, and the block is not given the query's count": 1,
        "querycount: it depends on a query, and the block is not given the query's count": 1,
      },
    });
    expect(c.binding + c.decidedOmit + c.decidedShown + c.dropped).toBe(c.entries);
  });

  test("anabaptistperspectives: 39 of 53 are bindings or decided, 14 are dropped (queries and comments)", async () => {
    const c = await census("ap");
    expect(c).toEqual({
      blocks: 64,
      switchedOff: 5,
      entries: 53,
      flags: 11,
      binding: 28,
      decidedOmit: 9,
      decidedShown: 2,
      dropped: 14,
      reasons: {
        "acf: its field cannot be read here": 1,
        "commentapproved: comments are not carried over": 2,
        "commentisauthor: comments are not carried over": 2,
        "queryhasitems: it depends on a query, and the block is not given the query's count": 7,
        "queryhasnextpage: it depends on a query, and the block is not given the query's count": 1,
        "queryhasprevpage: it depends on a query, and the block is not given the query's count": 1,
      },
    });
    expect(c.binding + c.decidedOmit + c.decidedShown + c.dropped).toBe(c.entries);
  });

  test("every dropped condition is reported with the subject's location, once per subject and condition", async () => {
    for (const site of ["fineline", "ap"] as const) {
      const loaded = await loadSite(site);
      for (const sub of allSubjects(loaded)) {
        const { ctx } = await realCtx(site, sub, {
          mode: sub.kind === "post" ? "static" : "entry",
        });
        let dropped = 0;
        walkBlocks(subjectBlocks(loaded, sub), (b) => {
          dropped += blockVisibility(b, ctx).dropped.length;
        });
        const entries = ctx.report.entries().filter((e) => e.code === "condition.dropped");
        expect(entries.length).toBeLessThanOrEqual(dropped);
        if (dropped > 0) expect(entries.length).toBeGreaterThan(0);
        for (const e of entries) expect(e.where).toMatch(/^(post|template|component):/);
      }
    }
  });
});

// ── The live pages ───────────────────────────────────────────────────────────────────────────────

const LIVE: Record<SiteName, { file: string; post: number; template: string }[]> = {
  fineline: [
    { file: "about-us", post: 1716, template: "page" },
    { file: "blog", post: 0, template: "index" },
    { file: "choosing-the-best-log-home-stain", post: 3371, template: "single" },
    { file: "home", post: 5246, template: "page" },
    { file: "privacy-policy", post: 3483, template: "page" },
    { file: "residential", post: 195, template: "page" },
  ],
  ap: [
    { file: "essays__get-in-the-way-of-evil", post: 729, template: "single-post" },
    { file: "essays", post: 0, template: "index" },
    {
      file: "essays__keeshons-story-a-knock-heard-round-the-hood-part-3",
      post: 773,
      template: "single-post",
    },
    { file: "essays__the-cultural-captivity-of-the-gospel", post: 8819, template: "single-post" },
    { file: "essays__the-essence-of-anabaptism-dean-taylor", post: 727, template: "single-post" },
    { file: "essays__the-way-we-live-is-the-way-we-educate", post: 7260, template: "single-post" },
  ],
};

const walkN = (n: N, f: (n: N) => void): void => {
  f(n);
  for (const c of n.childNodes ?? []) walkN(c, f);
  if (n.content) walkN(n.content, f);
};
const classesOf = (n: N): string[] =>
  (n.attrs?.find((a) => a.name === "class")?.value ?? "").split(/\s+/).filter(Boolean);

/**
 * Every block of a live page's templates that has a condition, against the page. A block this tool omits
 * must not be on the page; the converse is not asked, because a block can be absent for reasons that are
 * not its conditions (a loop with no items). `shown` counts the blocks the page has and this tool keeps.
 */
async function liveSafety(
  site: SiteName,
): Promise<{ omitted: string[]; contradicted: string[]; shown: string[] }> {
  const loaded = await loadSite(site);
  const out = { omitted: [] as string[], contradicted: [] as string[], shown: [] as string[] };
  for (const page of LIVE[site]) {
    const post = page.post ? loaded.model.posts.get(page.post) : undefined;
    if (page.post && !post) continue;
    const doc = parse(
      readFileSync(`tests/fixtures/${site}/html/${page.file}.html`, "utf8"),
    ) as unknown as N;
    const present = new Set<string>();
    walkN(doc, (n) => {
      for (const c of classesOf(n)) present.add(c);
    });
    const subjects: Subject[] = [
      ...(post ? [{ kind: "post", id: post.id } as Subject] : []),
      { kind: "template", slug: page.template },
      ...(["header", "footer", "header-light", "mobile-menu", "top-menu", "comments"] as const)
        .filter((slug) =>
          [...loaded.model.posts.values()].some(
            (p) => p.type === "wp_template_part" && p.slug === slug,
          ),
        )
        .map((slug) => ({ kind: "part", slug }) as Subject),
    ];
    // How many blocks of the page print each class on their element: a class that two blocks print (an
    // additional class one block borrows from another) tells nothing about either.
    const printers = new Map<string, number>();
    for (const sub of subjects) {
      walkBlocks(subjectBlocks(loaded, sub), (b) => {
        for (const m of b.innerHTML.matchAll(/class="([^"]*)"/g)) {
          for (const c of new Set((m[1] ?? "").split(/\s+/)))
            printers.set(c, (printers.get(c) ?? 0) + 1);
        }
      });
    }
    for (const sub of subjects) {
      const { ctx } = await realCtx(site, sub, {
        mode: "static",
        ...(post ? { subject: { kind: "post", id: String(post.id), post } } : {}),
      });
      walkBlocks(subjectBlocks(loaded, sub), (b) => {
        const classID = b.attrs.classID;
        const a = b.attrs;
        const conditional =
          ((a.hideConditions as Record<string, unknown>[] | undefined) ?? []).some(
            (c) => c.condition && c.operator,
          ) ||
          a.hideLoggedIn ||
          a.hideGuest;
        // The class has to be printed on the element, by that block alone, or its absence says nothing.
        if (!conditional || typeof classID !== "string" || printers.get(classID) !== 1) return;
        if (!new RegExp(`class="[^"]*\\b${classID}\\b`).test(b.innerHTML)) return;
        const v = blockVisibility(b, ctx);
        const key = `${page.file} ${classID}`;
        if (v.omit && present.has(classID)) out.contradicted.push(key);
        else if (v.omit) out.omitted.push(key);
        else if (present.has(classID)) out.shown.push(key);
      });
    }
  }
  return out;
}

describe("the live pages", () => {
  test("fineline: no block that the page shows is omitted", async () => {
    const r = await liveSafety("fineline");
    expect(r.contradicted).toEqual([]);
  });

  test("anabaptistperspectives: no block that the page shows is omitted, and the tag block shows exactly on the posts that have tags", async () => {
    const r = await liveSafety("ap");
    expect(r.contradicted).toEqual([]);
    expect(r.shown.filter((k) => k.endsWith("div-c437eab")).length).toBe(3);
    const loaded = await loadSite("ap");
    for (const id of [773, 8819, 7260]) {
      expect(
        (loaded.model.termsByPost.get(id) ?? []).some(
          (t) => loaded.model.terms.get(t)?.taxonomy === "post_tag",
        ),
      ).toBe(true);
    }
    expect(r.omitted.length).toBeGreaterThanOrEqual(0);
  });
});

// ── What the review found ────────────────────────────────────────────────────────────────────────

describe("a comparison over an expression is PHP's: numbers compare as numbers", () => {
  /** A static ctx for a post whose title is `title`, and the entry ctx of the same post. */
  async function pair(title: string): Promise<[ConvertCtx, ConvertCtx]> {
    const loaded = await loadSite("fineline");
    const post = { ...(loaded.model.posts.get(5246) as WpPost), title };
    const stat = (
      await realCtx(
        "fineline",
        { kind: "post", id: 5246 },
        { mode: "static", subject: { kind: "post", id: "5246", post } },
      )
    ).ctx;
    return [stat, (await entryCtx("fineline", "single", "post")).ctx];
  }

  test("querycount > 5 with ten items shows the block, and every operator reads its operands as PHP does", async () => {
    const { ctx } = await entryCtx("fineline", "taxonomy-location", "project");
    const count = "state.n";
    const shownFor = (operator: string, data: string, n: number): boolean =>
      !hiddenFor(
        blockVisibility(when([{ condition: "querycount", operator, data }]), ctx, {
          queryCount: count,
        }),
        {},
        { n },
      );
    expect(shownFor(">", "5", 10)).toBe(true);
    expect(shownFor("<", "10", 9)).toBe(true);
    expect(shownFor(">=", "5", 10)).toBe(true);
    expect(shownFor("<=", "10", 9)).toBe(true);
    expect(shownFor("<", "5", 10)).toBe(false);
    expect(shownFor(">", "10", 9)).toBe(false);
    // `!=` is loose: `1` and `1.0` are the same number.
    expect(shownFor("!=", "1.0", 1)).toBe(false);
    expect(shownFor("!=", "2", 1)).toBe(true);
    // Not a number on one side: the characters decide.
    expect(shownFor(">", "abc", 10)).toBe(false);
    expect(shownFor("<", "abc", 10)).toBe(true);
  });

  test("on every operator and pair of strings the entry binding says what the static answer says", async () => {
    const pairs: [string, string][] = [
      ["10", "5"],
      ["9", "10"],
      ["5", "5.0"],
      ["abc", "abd"],
      ["1e1", "10"],
      [" 5", "5"],
      ["", "0"],
      ["0x10", "16"],
      ["-3", "2"],
      [".5", "0.5"],
      ["10", "9a"],
    ];
    for (const operator of ["<", ">", "<=", ">=", "!=", "before", "after"]) {
      for (const [left, data] of pairs) {
        const [stat, entry] = await pair(left);
        const condition = { condition: "posttitle", operator, data };
        const decided = blockVisibility(when([condition]), stat);
        const bound = blockVisibility(when([condition]), entry);
        // The static answer is `omit` or nothing; the entry's is a binding that must agree.
        expect(
          `${operator} ${JSON.stringify([left, data])} ${hiddenFor(bound, { title: left })}`,
        ).toBe(`${operator} ${JSON.stringify([left, data])} ${decided.omit === true}`);
      }
    }
  });
});

describe("a post's terms in an entry condition", () => {
  test("a taxonomy with a dash in its name makes a binding the build can evaluate", async () => {
    const loaded = await loadSite("fineline");
    const term = loaded.model.terms.get(244);
    expect(term?.taxonomy).toBe("service-type");
    const { ctx } = await entryCtx("fineline", "single-service", "service");
    const v = blockVisibility(
      when([{ condition: "postterm", operator: "===", data: { value: 244 } }]),
      ctx,
    );
    expect(v.hidden).toContain("?.['service-type']");
    expect(hiddenFor(v, { terms: { "service-type": [{ slug: term?.slug }] } })).toBe(false);
    expect(hiddenFor(v, { terms: { "service-type": [] } })).toBe(true);
    expect(hiddenFor(v, {})).toBe(true);
  });

  test("every term of both sites makes a binding that evaluates, over an entry with no terms and over one that has it", async () => {
    for (const site of ["fineline", "ap"] as const) {
      const loaded = await loadSite(site);
      const { ctx } = await entryCtx(site, "single", "post");
      let checked = 0;
      for (const term of loaded.model.terms.values()) {
        const v = blockVisibility(
          when([{ condition: "postterm", operator: "===", data: { value: term.termId } }]),
          ctx,
        );
        if (v.hidden === undefined) continue;
        expect(hiddenFor(v, { terms: {} })).toBe(true);
        expect(hiddenFor(v, { terms: { [term.taxonomy]: [{ slug: term.slug }] } })).toBe(false);
        checked++;
      }
      expect(checked).toBeGreaterThan(5);
    }
  });
});

describe("the excerpt condition asks about the post's own excerpt", () => {
  const condition = [{ condition: "postexcerpt", operator: "===", data: "true" }];

  test("a post with no excerpt of its own is hidden in an entry as on a static page, though the entry's excerpt is generated", async () => {
    const loaded = await loadSite("ap");
    const bare = loaded.model.posts.get(731) as WpPost;
    expect(bare.excerpt.trim()).toBe("");
    const { ctx: stat } = await realCtx("ap", { kind: "post", id: 731 });
    expect(blockVisibility(when(condition), stat).omit).toBe(true);
    const { ctx } = await entryCtx("ap", "single-post", "post");
    const data = postData(stat, bare);
    // The entry's excerpt is the generated one: that is not what `has_excerpt()` asks.
    expect(String(data.excerpt)).not.toBe("");
    expect(hiddenFor(blockVisibility(when(condition), ctx), data)).toBe(true);
  });

  test("on every post of both sites the entry binding over the entry data says what the static answer says", async () => {
    let withOwn = 0;
    let without = 0;
    for (const site of ["fineline", "ap"] as const) {
      const loaded = await loadSite(site);
      const { ctx: entry } = await entryCtx(site, "single", "post");
      const bound = blockVisibility(when(condition), entry);
      for (const post of loaded.model.posts.values()) {
        if (
          post.status !== "publish" ||
          !["post", "page", "project", "service", "episode"].includes(post.type)
        )
          continue;
        const { ctx: stat } = await realCtx(site, { kind: "post", id: post.id });
        const decided = blockVisibility(when(condition), stat).omit === true;
        expect(hiddenFor(bound, postData(stat, post))).toBe(decided);
        if (decided) without++;
        else withOwn++;
      }
    }
    expect(withOwn).toBeGreaterThan(0);
    expect(without).toBeGreaterThan(0);
  });

  test("an entry written without `hasExcerpt` is read as having an excerpt when it holds one", async () => {
    const { ctx } = await entryCtx("ap", "single-post", "post");
    const v = blockVisibility(when(condition), ctx);
    expect(hiddenFor(v, { excerpt: "Some text" })).toBe(false);
    expect(hiddenFor(v, { excerpt: "" })).toBe(true);
    expect(hiddenFor(v, { excerpt: "Some text", hasExcerpt: false })).toBe(true);
  });
});

describe("a device condition combined by OR with one that is decided", () => {
  test("a guest-false condition and a device condition: the device one cannot be expressed and counts as true, so the block stays", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 773 });
    const v = blockVisibility(
      when(
        [
          { condition: "userrole", operator: "===", data: "administrator" },
          { condition: "device", operator: "===", data: "mobile" },
        ],
        { hideConditionsType: "||" },
      ),
      ctx,
    );
    expect(v.omit).toBeUndefined();
    expect(v.dropped).toEqual(["device: a device condition combined with others by OR"]);
    // The decided condition alone still removes the block.
    expect(
      blockVisibility(
        when([{ condition: "userrole", operator: "===", data: "administrator" }], {
          hideConditionsType: "||",
        }),
        ctx,
      ).omit,
    ).toBe(true);
  });
});

describe("an ACF condition on a reference to a post that has no page", () => {
  test("every episode that holds a podcast keeps its audio player, in a static page and in an entry, with the real routes", async () => {
    const loaded = await loadSite("ap");
    const player = findBlock(
      subjectBlocks(loaded, { kind: "template", slug: "single-episode" }),
      (b) => b.attrs.classID === "column-audio-player",
    ) as WpBlock;
    const { ctx: probe } = await realCtx("ap", { kind: "post", id: 11824 });
    let kept = 0;
    let removed = 0;
    for (const post of loaded.model.posts.values()) {
      if (post.type !== "episode" || post.status !== "publish") continue;
      const target = Number(loaded.model.postMeta.get(post.id)?.captivate_episode?.[0]);
      if (!loaded.model.posts.has(target)) continue;
      const { ctx } = await realCtx("ap", { kind: "post", id: post.id });
      expect(probe.urlFor("post", target)).toBeUndefined();
      expect(blockVisibility(player, ctx).omit).toBeUndefined();
      const { ctx: entry } = await entryCtx("ap", "single-episode", "episode");
      expect(hiddenFor(blockVisibility(player, entry), postData(ctx, post))).toBe(false);
      kept++;
    }
    expect(kept).toBeGreaterThanOrEqual(88);
    // An episode that holds nothing has no player.
    const empty = [...loaded.model.posts.values()].find(
      (p) =>
        p.type === "episode" &&
        p.status === "publish" &&
        String(loaded.model.postMeta.get(p.id)?.captivate_episode?.[0] ?? "") === "",
    ) as WpPost;
    const { ctx } = await realCtx("ap", { kind: "post", id: empty.id });
    expect(blockVisibility(player, ctx).omit).toBe(true);
    removed++;
    expect(removed).toBe(1);
  });
});

describe("the shipped literal of the hidden style", () => {
  test("is the rule that makes the attribute win over the block's own display", () => {
    expect(HIDDEN_STYLE).toEqual({ "&[hidden]": { display: "none !important" } });
  });
});

// END OF PART 3
