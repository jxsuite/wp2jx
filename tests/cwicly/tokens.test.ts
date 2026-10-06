/**
 * Cwicly's render-time tokens, resolved against the two real sites.
 *
 * Four kinds of evidence, in this order:
 * 1. the table itself, on small inputs (what is left alone, what is removed, what becomes a marker);
 * 2. the census: every token of every block of both sites is either resolved or reported, never
 *    silently dropped, and the numbers are pinned;
 * 3. the live pages (`tests/fixtures/<site>/html`) as the oracle: the static resolution of each block's
 *    saved markup agrees with the element the live page printed for it;
 * 4. entry mode against static mode: a binding, evaluated over the entry data of a real post, prints
 *    what the static resolution of the same token prints for that post.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse, parseFragment } from "parse5";
import { loadSite, makeCtx, subjectBlocks, allSubjects, type Subject } from "../helpers/ctx.ts";
import type { LoadedSite, SiteName } from "../helpers/ctx.ts";
import { buildRoutes, createUrlTools } from "../../src/routes.ts";
import { walkBlocks } from "../../src/wp/blocks.ts";
import { decodeEntities } from "../../src/wp/model.ts";
import { php } from "../../src/wp/seo.ts";
import { bindingMarker } from "../../src/jx-util.ts";
import { createReport } from "../../src/report.ts";
import type { ConvertCtx, WpBlock, WpPost } from "../../src/types.ts";
import type { AcfField } from "../../src/wp/acf.ts";
import { blockImage } from "../../src/cwicly/dynamic.ts";
import {
  cwiclyFormat,
  dateExpr,
  escapeHtml,
  excerptOf,
  exprV,
  fieldText,
  findTokens,
  formatDate,
  humanTimeDiff,
  isKnownToken,
  jsString,
  limitExcerpt,
  litV,
  MENU_TAG,
  orElse,
  optPath,
  parseToken,
  POST_CONTENT_TAG,
  postData,
  printsAcfRaw,
  propPath,
  postFacts,
  resolveTokens,
  siteZone,
  termData,
  texturize,
  texturizeHtml,
  tokenContent,
  tokenNodes,
  type Val,
} from "../../src/cwicly/tokens.ts";

setDefaultTimeout(120_000);

// ── Real contexts ────────────────────────────────────────────────────────────────────────────────

type N = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: N[];
  content?: N;
};

const tools = new Map<SiteName, Promise<ReturnType<typeof createUrlTools>>>();

/** The routes module's own URL tools for a site: what the conversion hands every converter. */
function toolsFor(site: SiteName, loaded: LoadedSite): Promise<ReturnType<typeof createUrlTools>> {
  let t = tools.get(site);
  if (!t) {
    t = Promise.resolve(
      createUrlTools(
        loaded.model,
        buildRoutes(loaded.model, loaded.acf, { media: loaded.media }),
        loaded.media,
      ),
    );
    tools.set(site, t);
  }
  return t;
}

interface Made {
  ctx: ConvertCtx;
  loaded: LoadedSite;
}

/** A context for a subject, with the real URL tools, in the mode asked for. */
async function realCtx(
  site: SiteName,
  subject: Subject,
  over: Partial<ConvertCtx> & { post?: WpPost } = {},
): Promise<Made> {
  const loaded = await loadSite(site);
  const t = await toolsFor(site, loaded);
  const { post, ...rest } = over;
  const ctx = await makeCtx(site, subject, {
    urlFor: t.urlFor,
    rewriteUrl: t.rewriteUrl,
    ...(post
      ? {
          subject: {
            kind: subject.kind === "post" ? "post" : "template",
            id: String("slug" in subject ? subject.slug : "id" in subject ? subject.id : ""),
            post,
          },
        }
      : {}),
    ...rest,
  });
  Object.assign(ctx, { urlForAuthor: t.urlForAuthor, urlForArchive: t.urlForArchive });
  return { ctx, loaded };
}

const block = (name: string, attrs: Record<string, unknown> = {}, innerHTML = ""): WpBlock => ({
  name,
  attrs,
  innerBlocks: [],
  innerHTML,
  innerContent: [innerHTML],
});

/** A template string as the Jx build evaluates it, over a scope. */
function evalTemplate(template: string, state: unknown, map: unknown = undefined): string {
  const fn = new Function("state", "$map", `return \`${template}\``) as (
    s: unknown,
    m: unknown,
  ) => string;
  return fn(state, map);
}

const entryScope = (
  data: Record<string, unknown>,
): { entry: { data: Record<string, unknown>; $children: unknown[]; id: string } } => ({
  entry: { data, $children: [], id: "x" },
});

describe("jsString", () => {
  test("nothing in a literal can unbalance a template: braces, a dollar and a backtick are escapes, a backslash is doubled", () => {
    const text = "a{b}c${d}`e\\f'g\nh\u2028i";
    const literal = jsString(text);
    // The build counts braces without reading strings, so none may be left in the literal.
    expect(literal).not.toMatch(/[{}$`]/);
    expect(literal).toContain("\\\\f");
    expect(literal).toContain("\\u007b");
    expect(literal).toContain("\\u0024");
    expect(literal).not.toContain("\u2028");
    expect(new Function(`return ${literal}`)()).toBe(text);
  });
});

// ── The table ────────────────────────────────────────────────────────────────────────────────────

describe("parsing", () => {
  test("a token is a name and its arguments split on =, as cc_parser splits it", () => {
    expect(parseToken("acffield=field_1=currentauthor=false=35=0-1-1-image")).toEqual({
      name: "acffield",
      args: ["field_1", "currentauthor", "false", "35", "0-1-1-image"],
    });
    expect(parseToken("title")).toEqual({ name: "title", args: [] });
    // An = in first place is not an argument separator.
    expect(parseToken("=x")).toEqual({ name: "=x", args: [] });
  });

  test("findTokens uses cc_parser's regular expression: {} and JSON are not tokens, <ccd> is", () => {
    const found = findTokens(
      'a {title} {} {"k":1} {&quot;k&quot;} <ccd>custom_current_date=Y</ccd> {a=b=c}',
    );
    expect(found.map((f) => f.token)).toEqual([
      "{title}",
      "<ccd>custom_current_date=Y</ccd>",
      "{a=b=c}",
    ]);
    expect(found[1]).toMatchObject({ name: "custom_current_date", args: ["Y"] });
  });

  test("isKnownToken follows the plugin's table, aliases included", () => {
    for (const name of [
      "title",
      "post_title",
      "acffield",
      "pageobject",
      "idadd",
      "gcl",
      "woocheckouturl",
      "commentquery",
      "filter",
    ]) {
      expect(isKnownToken(name)).toBe(true);
    }
    for (const name of ["brace", "color", "display"]) expect(isKnownToken(name)).toBe(false);
  });
});

describe("what is left alone, removed, or turned into a marker", () => {
  test("the class tokens are returned exactly as written, whatever their arguments", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    const classes =
      "{class}{cs-index} {gcl} {acl} {sacl} {aclv} {gclv=true} {cccomp} {currentpageclass=static=https://finelinepainting.pro/projects/} {darkmode_force=dark}";
    expect(resolveTokens(classes, ctx)).toBe(classes);
    expect(resolveTokens(classes, ctx, undefined, { where: "html" })).toBe(classes);
  });

  test("loop and id bookkeeping is removed", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    expect(
      resolveTokens(
        '<button id="load-more-button{idadd}" data-i="{loop-index}{loop-id}{loop-position}" href="{empty}">',
        ctx,
      ),
    ).toBe('<button id="load-more-button" data-i="" href="">');
  });

  test("CSS and other braces that are not tokens survive, and an unknown token is reported once", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    const css = "p{display:none} a{color:red;} {position:absolute;width:100vw} {} {brace} {brace}";
    expect(resolveTokens(css, ctx)).toBe(css);
    const unknown = ctx.report.entries().filter((e) => e.code === "token.unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({
      severity: "info",
      where: "post:5246",
      data: { token: "{brace}" },
    });
  });

  test("{menu} and {postcontent} become marker elements, {menuname} the menu's own label", async () => {
    const { ctx, loaded } = await realCtx("fineline", { kind: "part", slug: "header" });
    const menu = subjectBlocks(loaded, { kind: "part", slug: "header" });
    let found: WpBlock | undefined;
    walkBlocks(menu, (b) => {
      if (b.name === "cwicly/menu" && !found) found = b;
    });
    expect(found?.innerHTML).toContain("{menu}");
    const out = resolveTokens(found?.innerHTML ?? "", ctx, found, { where: "html" });
    expect(out).toContain(`<${MENU_TAG}`);
    expect(out).toContain(`</${MENU_TAG}>`);
    const id = found?.attrs.menuSelected;
    expect(out).toContain(`data-menu="${String(id)}"`);
    expect(out).toContain(
      `aria-label="${decodeEntities(loaded.model.terms.get(Number(id))?.name ?? "")}"`,
    );
    expect(resolveTokens("<article>{postcontent}</article>", ctx)).toBe(
      `<article><${POST_CONTENT_TAG}></${POST_CONTENT_TAG}></article>`,
    );
  });

  test("a stated menu label wins over the menu's name", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    expect(
      resolveTokens(
        "{menuname}",
        ctx,
        block("cwicly/menu", { menuSelected: "5", menuAriaLabel: "Site navigation" }),
      ),
    ).toBe("Site navigation");
    expect(resolveTokens("{menuname}", ctx, block("cwicly/menu", { menuSelected: "5" }))).toBe(
      "Main Menu",
    );
  });
});

describe("tokens nothing on a static site can answer", () => {
  test("each is reported once as token.unresolved with its location, and prints nothing", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 819 });
    const text =
      "a{loginurl}b{directlogout}c{commentquery=comment_author}d{userquery=display_name}e{woocheckouturl}f{filter=name}g<ccd>shortcode=x</ccd>h{pagination}i{loginurl}";
    expect(resolveTokens(text, ctx)).toBe("abcdefghi");
    const entries = ctx.report.entries().filter((e) => e.code === "token.unresolved");
    expect(entries.map((e) => (e.data as { token: string }).token)).toEqual([
      "{loginurl}",
      "{directlogout}",
      "{commentquery=comment_author}",
      "{userquery=display_name}",
      "{woocheckouturl}",
      "{filter=name}",
      "<ccd>shortcode=x</ccd>",
      "{pagination}",
    ]);
    for (const e of entries) {
      expect(e.severity).toBe("warn");
      expect(e.where).toBe("post:819");
      expect(e.url).toBe("https://anabaptistperspectives.org/?p=819");
      expect(String((e.data as { reason: string }).reason).length).toBeGreaterThan(10);
    }
  });

  test("the current user is nobody: a guest sees the block's fallback, and no user id", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 819 });
    expect(
      resolveTokens("{username}", ctx, block("cwicly/div", { dynamicStaticFallback: "Guest" })),
    ).toBe("Guest");
    expect(resolveTokens("{username}|{userinfo}|{userid}|{usercustomfield=x}", ctx)).toBe("||0|");
  });
});

// ── The site ─────────────────────────────────────────────────────────────────────────────────────

describe("the site", () => {
  test("title, tagline and addresses come from the model", async () => {
    const { ctx, loaded } = await realCtx("ap", { kind: "post", id: 819 });
    expect(resolveTokens("{sitetitle}", ctx)).toBe("Anabaptist Perspectives");
    // The tagline is stored entity-encoded and printed once decoded.
    expect(loaded.model.site.description).toContain("&#039;");
    expect(resolveTokens("{sitetagline}", ctx)).toBe(
      "Encouraging allegiance to Jesus' sacrificial kingdom",
    );
    // In markup it is texturized like any text; in an attribute it is as stored.
    expect(resolveTokens("{sitetagline}", ctx, undefined, { where: "html" })).toBe(
      "Encouraging allegiance to Jesus’ sacrificial kingdom",
    );
    expect(resolveTokens('<a href="{homeurl}">{siteurl}</a>', ctx)).toBe('<a href="/">/</a>');
    // A path after the token supplies the slash itself.
    expect(resolveTokens("{homeurl}/essays/ {siteurl}/about", ctx)).toBe("/essays/ /about");
  });

  test("an option is its stored text, a structured one is unresolved", async () => {
    const { ctx, loaded } = await realCtx("fineline", { kind: "post", id: 5246 });
    expect(resolveTokens("{siteoption=blogname}", ctx)).toBe(
      loaded.model.options.get("blogname") ?? "",
    );
    expect(resolveTokens("[{siteoption=no_such_option_x}]", ctx)).toBe("[]");
    const structured = [...loaded.model.options].find(([, v]) => /^a:\d+:\{/.test(v));
    expect(structured).toBeDefined();
    expect(resolveTokens(`[{siteoption=${structured?.[0]}}]`, ctx)).toBe("[]");
    expect(
      ctx.report
        .entries()
        .some((e) => e.code === "token.unresolved" && e.message.includes("structure")),
    ).toBe(true);
  });

  test("the current date is an expression the build evaluates, in the site's zone", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    const year = resolveTokens("(c) <ccd>custom_current_date=Y</ccd>", ctx);
    expect(year).toMatch(/^\(c\) \$\{.*\}$/s);
    expect(evalTemplate(year, {})).toBe(`(c) ${php.date("Y", Date.now(), "America/New_York")}`);
    expect(evalTemplate(resolveTokens("{currentdate=2=2}", ctx), {})).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} [AP]M$/,
    );
    expect(evalTemplate(resolveTokens("{currentdate=4=3}", ctx), {})).toMatch(
      /^\d{2}\/\d{2}\/\d{4} $/,
    );
    expect(evalTemplate(resolveTokens("{dayweek}", ctx), {})).toBe(
      php.date("l", Date.now(), "America/New_York"),
    );
    const entries = ctx.report.entries().filter((e) => e.code === "token.frozen-date");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.severity).toBe("info");
  });
});

// ── The current post, static ─────────────────────────────────────────────────────────────────────

describe("the current post on a static page", () => {
  test("title, excerpt, URL, type and id", async () => {
    const { ctx, loaded } = await realCtx("ap", { kind: "post", id: 773 });
    const post = loaded.model.posts.get(773) as WpPost;
    // wptexturize turns the apostrophe curly (it already is) and the spaced hyphen into an en dash.
    expect(post.title).toBe("Keeshon’s Story: A Knock Heard Round The Hood  - Part 3");
    expect(resolveTokens("{title}", ctx)).toBe(
      "Keeshon’s Story: A Knock Heard Round The Hood  – Part 3",
    );
    expect(resolveTokens("{post_title}|{pagetitle}", ctx)).toBe(
      "Keeshon’s Story: A Knock Heard Round The Hood  – Part 3|Keeshon’s Story: A Knock Heard Round The Hood  – Part 3",
    );
    expect(resolveTokens("{id}|{posttype}|{pageurl}", ctx)).toBe(
      `773|post|${ctx.urlFor("post", 773)}`,
    );
    expect(resolveTokens("{pageurl}", ctx)).toBe(
      "/essays/keeshons-story-a-knock-heard-round-the-hood-part-3/",
    );
    expect(resolveTokens("{postexcerpt=60}", ctx)).toBe(
      "Life is not always easy, but having kind friends that are",
    );
    expect(resolveTokens("{postexcerpt}", ctx)).toBe(
      post.excerpt.trim() === post.excerpt ? post.excerpt : php.stripAllTags(post.excerpt),
    );
  });

  test("an excerpt keeps its character references and is cut at the last space inside the limit", () => {
    expect(limitExcerpt("<p>One two three four</p>", 0)).toBe("One two three four");
    expect(limitExcerpt("One two three four", 18)).toBe("One two three four");
    expect(limitExcerpt("One two three four", 17)).toBe("One two three");
    // PHP's strrpos finds no space in the cut: substr(…, 0, false) is empty.
    expect(limitExcerpt("Supercalifragilistic and more", 10)).toBe("");
    expect(limitExcerpt("a &nbsp;b", 0)).toBe("a &nbsp;b");
    // The limit counts bytes, as PHP's substr does: a curly quote is three of them.
    expect(limitExcerpt("“We know we sing", 12)).toBe("“We know");
    expect(limitExcerpt('"We know we sing', 12)).toBe('"We know we');
  });

  test("an excerpt with a character reference prints it as the reference, not as text", async () => {
    const loaded = await loadSite("fineline");
    const base = loaded.model.posts.get(1382) as WpPost;
    const { ctx } = await realCtx(
      "fineline",
      { kind: "post", id: 1382 },
      { post: { ...base, excerpt: "<p>Are you ready?&nbsp;Call us.</p>" } },
    );
    const html = resolveTokens("{postexcerpt}", ctx, undefined, { where: "html" });
    expect(html).toBe("Are you ready?&nbsp;Call us.");
    expect(resolveTokens("{postexcerpt}", ctx)).toBe("Are you ready?\u00a0Call us.");
  });

  test("with no excerpt of its own a post's text blocks stand in, as Cwicly's filter builds it", async () => {
    const { ctx, loaded } = await realCtx("fineline", { kind: "post", id: 1382 });
    expect(loaded.model.posts.get(1382)?.excerpt).toBe("");
    const out = resolveTokens("{postexcerpt}", ctx);
    expect(out).toContain("House Painting In Pine Grove, PA");
    expect(out).not.toMatch(/[{}<>]/);
    // The text of a button or an image is not an excerpt's.
    expect(out).not.toContain("Learn More About Our Professional Painting Services".repeat(2));
  });

  test("the excerpts the live index of anabaptistperspectives prints are the ones the token makes", async () => {
    const loaded = await loadSite("ap");
    const doc = parse(readFileSync("tests/fixtures/ap/html/essays.html", "utf8")) as unknown as N;
    const live: string[] = [];
    walkN(doc, (n) => {
      const noClass = !(n.attrs ?? []).some((a) => a.name === "class");
      if (n.nodeName === "p" && noClass && text(n).endsWith("…")) live.push(text(n));
    });
    expect(live.length).toBeGreaterThanOrEqual(18);
    let matched = 0;
    for (const post of loaded.model.posts.values()) {
      if (post.status !== "publish" || post.type !== "post") continue;
      const { ctx } = await realCtx("ap", { kind: "post", id: post.id });
      // The card prints {postexcerpt=150} and then an "after" text of three dots, which wptexturize turns into one character.
      const mine = `${resolveTokens("{postexcerpt=150}", ctx).replace(/\s+/g, " ").trim()}…`;
      if (mine.length < 40) continue;
      const found = live.find((l) => l.startsWith(mine.slice(0, 60)));
      if (!found) continue;
      matched++;
      expect(found).toBe(mine);
    }
    expect(matched).toBeGreaterThanOrEqual(18);
  });

  test("a fallback replaces an empty value", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 819 });
    const empty = ctx.model.posts.get(819) as WpPost;
    expect(empty.excerpt).toBe("");
    const fb = block("cwicly/paragraph", { dynamicStaticFallback: "Read More" });
    expect(resolveTokens("{postexcerpt=250}", ctx, fb)).not.toBe("Read More");
    const plain = block("cwicly/paragraph", { dynamicStaticFallback: "Nothing here" });
    expect(resolveTokens("{acffield=field_62d867cf7cced}", ctx, plain)).toBe("Nothing here");
  });

  test("dates are formatted in the site's zone with the seven formats of Cwicly and PHP's custom ones", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 773 });
    // 2020-12-20T06:49:00Z is 1:49 in the morning in New York.
    const pairs: [string, string][] = [
      ["{postdate=published=default}", "December 20, 2020"],
      ["{postdate=published=1}", "December 20, 2020"],
      ["{postdate=published=2}", "2020-12-20"],
      ["{postdate=published=3}", "12/20/2020"],
      ["{postdate=published=4}", "20/12/2020"],
      ["{postdate=published=6}", "20.12.20"],
      ["{postdate=published=7}", "20.12.2020"],
      ["{postdate=published=custom=l, jS \\o\\f F}", "Sunday, 20th of December"],
      ["{postdate=modified=default}", "March 12, 2024"],
      ["{postdate}", "December 20, 2020"],
      ["{time=published=default}", "1:49 am"],
      ["{time=published=2}", "1:49 AM"],
      ["{time=published=3}", "01:49"],
      ["{time=modified=3}", "15:10"],
    ];
    for (const [token, want] of pairs) expect(resolveTokens(token, ctx)).toBe(want);
  });

  test("a relative date is evaluated at conversion time and says so", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 773 });
    expect(resolveTokens("{postdate=published=5}", ctx)).toMatch(/^\d+ (year|years) ago$/);
    expect(ctx.report.entries().some((e) => e.code === "token.frozen-date")).toBe(true);
    expect(humanTimeDiff(0, 59 * 60_000)).toBe("59 minutes");
    expect(humanTimeDiff(0, 90 * 60_000)).toBe("2 hours");
    expect(humanTimeDiff(0, 36 * 3600_000)).toBe("2 days");
    expect(humanTimeDiff(0, 400 * 86_400_000)).toBe("1 year");
  });

  test("author, terms and the featured image", async () => {
    const { ctx, loaded } = await realCtx("ap", { kind: "post", id: 773 });
    expect(resolveTokens("{authorname}", ctx)).toBe("Keeshon Washington");
    expect(
      resolveTokens(
        "{authorinfo}",
        ctx,
        block("cwicly/paragraph", { dynamicWordPressAuthorInfo: "display_name" }),
      ),
    ).toBe("Keeshon Washington");
    expect(
      resolveTokens(
        "{authorinfo}",
        ctx,
        block("cwicly/paragraph", { dynamicWordPressAuthorInfo: "user_nicename" }),
      ),
    ).toBe(
      loaded.model.users.get((loaded.model.posts.get(773) as WpPost).authorId)?.slug as string,
    );
    expect(resolveTokens("{postcategories}|{posttags}", ctx)).toBe(
      "Testimony & Life Experience|Testimony",
    );
    expect(resolveTokens("{postcategories}", ctx, undefined, { where: "html" })).toBe(
      "Testimony &amp; Life Experience",
    );
    expect(resolveTokens("{postcategory}", ctx)).toBe("Testimony & Life Experience");
    expect(resolveTokens("{tag}", ctx)).toBe("Testimony");
    expect(
      resolveTokens("{postcategory}", ctx, block("cwicly/x", { dynamicCategoryIndex: 2 })),
    ).toBe("");
    expect(resolveTokens("{featuredimage}", ctx)).toBe(
      "/media/A-Knock-Heard-Round-the-Hood-3.jpeg",
    );
    expect(resolveTokens("{featuredimage=true=medium_large=false=true=false}", ctx)).toBe(
      "/media/A-Knock-Heard-Round-the-Hood-3.jpeg",
    );
    expect(resolveTokens('style="--b:url({bgfeaturedimage})"', ctx)).toBe(
      'style="--b:url(/media/A-Knock-Heard-Round-the-Hood-3.jpeg)"',
    );
  });

  test("the author's address is the routes module's, and an entry binds an authorUrl key", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 773 });
    expect(resolveTokens("{authorurl}", ctx)).toMatch(/^\/people\/[a-z-]+\/$/);
    const entry = await realCtx(
      "ap",
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryType: "post" },
    );
    expect(resolveTokens("{authorurl}", entry.ctx)).toBe("${state.entry.data.authorUrl ?? ''}");
  });

  test("a post with no featured image takes the block's fallback, an attachment id or a URL", async () => {
    const { ctx, loaded } = await realCtx("ap", { kind: "post", id: 819 });
    expect(loaded.model.postMeta.get(819)?._thumbnail_id).toBeUndefined();
    const id = [...loaded.model.attachments.keys()].find(
      (k) => loaded.media.mediaFor(k) !== undefined,
    ) as number;
    const want = loaded.media.mediaFor(id)?.src;
    expect(resolveTokens("{featuredimage=true=false=false=true=" + String(id) + "}", ctx)).toBe(
      want ?? "",
    );
    expect(
      resolveTokens("{featuredimage}", ctx, block("cwicly/image", { dynamicStaticFallbackID: id })),
    ).toBe(want ?? "");
    expect(
      resolveTokens(
        "{bgfeaturedimage}",
        ctx,
        block("cwicly/div", { backgroundDynamicStaticFallbackID: String(id) }),
      ),
    ).toBe(want ?? "");
    expect(resolveTokens("{featuredimage}", ctx)).toBe("");
  });

  test("a token that reads the post, on a conversion that has none, is unresolved", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" }, { mode: "static" });
    expect(resolveTokens("a{title}b{pageurl}c{postdate}d", ctx)).toBe("abcd");
    const reasons = ctx.report
      .entries()
      .filter((e) => e.code === "token.unresolved")
      .map((e) => (e.data as { reason: string }).reason);
    expect(reasons).toHaveLength(3);
    expect(reasons.every((r) => r.includes("current post"))).toBe(true);
  });
});

describe("images by attachment id", () => {
  test("src, width, height and alt come from the media plan's one original", async () => {
    const { ctx, loaded } = await realCtx("fineline", { kind: "post", id: 1078 });
    const media = loaded.media.mediaFor(815);
    expect(media).toBeDefined();
    expect(resolveTokens("{image=815}|{imagesrc=815=full}|{imagesrc=815=medium}", ctx)).toBe(
      `${media?.src}|${media?.src}|${media?.src}`,
    );
    expect(resolveTokens("{imagewidth=815}x{imageheight=815}", ctx)).toBe(
      `${media?.width}x${media?.height}`,
    );
    expect(resolveTokens("[{imagealt=815}]", ctx)).toBe(`[${media?.alt}]`);
    expect(resolveTokens("{attachmenturl=815}", ctx)).toBe(media?.src as string);
  });

  test("srcset and sizes are Jx's to make: they print nothing", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 1078 });
    expect(resolveTokens('<img srcset="{imageset=815}" sizes="{imagesizes=815=false}">', ctx)).toBe(
      '<img srcset="" sizes="">',
    );
  });

  test("an attachment that has no file is reported once per token and prints nothing", async () => {
    const { ctx, loaded } = await realCtx("fineline", { kind: "post", id: 1078 });
    expect(loaded.media.mediaFor(4009)).toBeUndefined();
    expect(resolveTokens("{imagewidth=4009}{imagewidth=4009}{imagealt=4009}", ctx)).toBe("");
    const missing = ctx.report.entries().filter((e) => e.code === "dynamic.missing-image");
    expect(missing.map((e) => (e.data as { token: string }).token)).toEqual([
      "{imagewidth}:4009",
      "{imagealt}:4009",
    ]);
    expect(missing[0]?.severity).toBe("warn");
  });
});

describe("objects and URLs", () => {
  test("{pageobject} is the Jx address of the post or term", async () => {
    const { ctx, loaded } = await realCtx("fineline", { kind: "post", id: 5246 });
    expect(resolveTokens("{pageobject=1013=page=post-type}", ctx)).toBe(
      ctx.urlFor("post", 1013) as string,
    );
    expect(resolveTokens("{pageobject=1013=page=post-type}", ctx)).toBe("/quote/");
    const term = [...loaded.model.terms.values()].find(
      (t) => t.taxonomy === "location" && ctx.urlFor("term", t.termId),
    );
    expect(term).toBeDefined();
    expect(resolveTokens(`{pageobject=${term?.termId}=taxonomy=taxonomy}`, ctx)).toBe(
      ctx.urlFor("term", term?.termId as number) as string,
    );
    // The kind alone decides when the type says nothing.
    expect(resolveTokens(`{pageobject=${term?.termId}==taxonomy}`, ctx)).toBe(
      ctx.urlFor("term", term?.termId as number) as string,
    );
    expect(resolveTokens("{pageobject=815=attachment=}", ctx)).toBe(
      loaded.media.mediaFor(815)?.src as string,
    );
  });

  test("an object that is not on the converted site is link.unresolved and prints nothing", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    expect(resolveTokens('<a href="{pageobject=482=page=post-type}">', ctx)).toBe('<a href="">');
    const entries = ctx.report.entries().filter((e) => e.code === "link.unresolved");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: "warn",
      where: "post:5246",
      data: { token: "pageobject=482=page=post-type" },
    });
  });

  test("a share link carries the page's absolute address, encoded", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 3371 });
    expect(ctx.urlFor("post", 3371)).toBe("/choosing-the-best-log-home-stain/");
    expect(resolveTokens("{pageurl=false=encoded}", ctx)).toBe(
      encodeURIComponent("https://finelinepainting.pro/choosing-the-best-log-home-stain/"),
    );
    expect(ctx.report.entries().some((e) => e.code === "token.approximated")).toBe(true);
  });

  test("the archive of a post type is the routes module's", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 1078 });
    expect(resolveTokens("{archiveurl}|{postarchiveurl}", ctx)).toBe(
      `${(ctx as unknown as { urlForArchive: (t: string) => string }).urlForArchive("project")}|${(ctx as unknown as { urlForArchive: (t: string) => string }).urlForArchive("project")}`,
    );
  });
});

// ── texturize, and dates against PHP ─────────────────────────────────────────────────────────────

describe("texturize", () => {
  test("quotes, apostrophes, dashes and ellipses as wptexturize writes them", () => {
    const cases: [string, string][] = [
      ["Women's Magazine", "Women’s Magazine"],
      ['"End Those Muslims!" - A Response', "“End Those Muslims!” – A Response"],
      ["Jesus' Kingdom and the Nation", "Jesus’ Kingdom and the Nation"],
      ['Do We Need the "Church Fathers"?', "Do We Need the “Church Fathers”?"],
      ["Wait... what", "Wait… what"],
      ["a -- b --- c", "a — b — c"],
      ["pages 1--5", "pages 1–5"],
      ["'tis the 'season'", "’tis the ‘season’"],
      ["in the '90s", "in the ’90s"],
      ["a 5'6\" tall", "a 5’6″ tall"],
      ["10x20", "10×20"],
      ["no change here", "no change here"],
    ];
    for (const [from, to] of cases) expect(texturize(from)).toBe(to);
  });

  test("the live titles of anabaptistperspectives are what texturize makes of the stored ones", async () => {
    const loaded = await loadSite("ap");
    const page = readFileSync(
      "tests/fixtures/ap/html/essays__keeshons-story-a-knock-heard-round-the-hood-part-3.html",
      "utf8",
    );
    // The related-episode cards on the page print other posts' titles.
    const live = new Set<string>();
    walkN(parse(page) as unknown as N, (n) => {
      if (/^h[1-6]$/.test(n.nodeName)) live.add(text(n));
    });
    let checked = 0;
    for (const p of loaded.model.posts.values()) {
      if (p.status !== "publish" || p.type !== "post") continue;
      const stored = decodeEntities(p.title).replace(/\s+/g, " ").trim();
      if (!/['"]|\s-\s/.test(stored)) continue;
      const printed = texturize(decodeEntities(p.title)).replace(/\s+/g, " ").trim();
      if (live.has(printed)) checked++;
      // A stored title with a quote or a spaced hyphen is never on the page as it is stored.
      expect(live.has(stored) && printed !== stored).toBe(false);
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});

/**
 * Strings and what WordPress's own `wptexturize()` (wp-includes/formatting.php of the live site's
 * WordPress, run under PHP 8.3) made of them, with the character references it writes decoded. They are
 * the cases the live pages and the real text of both sites turned up: an apostrophe after a digit, a
 * no-break space before a dash, a quote after a no-break space, the cockney words, a quotation that
 * closes with a prime, and the rest of the rules in their order.
 */
const WPTEXTURIZE: [string, string][] = [
  ["Women's Magazine", "Women’s Magazine"],
  ["'Tis the season", "‘Tis the season"],
  ["'tis", "’tis"],
  ["'embrace the day", "’embrace the day"],
  ["he said 'em", "he said ’em"],
  ["9' x 12'", "9′ x 12′"],
  ["5'10\" tall", "5’10” tall"],
  ["a 5'6\" tall", "a 5’6″ tall"],
  ["'99 was great", "’99 was great"],
  ["In '99", "In ’99"],
  ["'99'", "’99’"],
  ['"42"', "“42”"],
  ["'0.42'", "‘0.42’"],
  ["foo (tm) bar", "foo ™ bar"],
  ["foo (TM)", "foo (TM)"],
  ["a -- b", "a — b"],
  ["a --- b", "a — b"],
  ["a-b", "a-b"],
  ["pre-war", "pre-war"],
  ["xn--foo", "xn--foo"],
  ["3x4", "3×4"],
  ["0x9999", "0x9999"],
  ["10x20 grid", "10×20 grid"],
  ["5x", "5x"],
  ["1,000x2,000", "1,000×2,000"],
  ["Tom & Jerry", "Tom & Jerry"],
  ["rock 'n' roll", "rock ‘n’ roll"],
  ["'quoted' text", "‘quoted’ text"],
  ['"Hello," she said.', "“Hello,” she said."],
  ["He said \"it's 'fine'\"", "He said “it’s ‘fine'”"],
  ["the '90s", "the ’90s"],
  ["the 90's", "the 90’s"],
  ["a... b", "a… b"],
  ["wait....", "wait…."],
  ["``tick''", "“tick”"],
  ["'Round midnight", "‘Round midnight"],
  ["'bout time", "’bout time"],
  ["'nuff said", "’nuff said"],
  ["Dr. O'Brien's", "Dr. O’Brien’s"],
  ["O'", "O’"],
  ["'", "‘"],
  ['"', "“"],
  ["'a", "‘a"],
  ["a'", "a’"],
  ['("x")', "(“x”)"],
  ['["x"]', "[“x”]"],
  ["{'x'}", "{‘x’}"],
  ["-'x'", "-‘x’"],
  [" 'x'", " ‘x’"],
  ["line\n'x'", "line\n‘x’"],
  ["'x'\n", "‘x’\n"],
  ['9"', "9″"],
  ["x' y", "x’ y"],
  ["foo 'bar", "foo ‘bar"],
  ["foo'bar", "foo’bar"],
  ["foo' bar", "foo’ bar"],
  ["foo'.", "foo’."],
  ["foo'!", "foo’!"],
  ["'foo", "‘foo"],
  ["5 - 3", "5 – 3"],
  ["5 -3", "5 -3"],
  ["- 3", "– 3"],
  ["-", "–"],
  ["--", "—"],
  [" -- ", " — "],
  ["a -  b", "a –  b"],
  ["pages 1--5", "pages 1–5"],
  ["in the 1930's to 1950's", "in the 1930’s to 1950’s"],
  ["the 60's and 70's", "the 60’s and 70’s"],
  ["durable&nbsp;- can", "durable&nbsp;– can"],
  ['in&nbsp;"The Feminine Mystique" and', "in&nbsp;“The Feminine Mystique” and"],
  ["an 'embolden' idea", "an ’embolden’ idea"],
  ["she said '\"hello\"'", "she said ‘”hello”‘"],
  ["it's '\"", "it’s ‘”"],
  ['"Don\'t" "Stop"', "“Don’t” “Stop”"],
  ['Say "hi" to Bob\'s "friend"', "Say “hi” to Bob’s “friend”"],
  ["A 12\" pipe and a 5' pole", "A 12″ pipe and a 5′ pole"],
  ["'em all", "’em all"],
  ["ROCK 'N' ROLL", "ROCK ‘N’ ROLL"],
  ["the '20s and '30s", "the ’20s and ’30s"],
  ["'Twas the night", "‘Twas the night"],
  ["'twas", "’twas"],
  ["twas'", "twas’"],
  ["&lt;'x'&gt;", "&lt;‘x’&gt;"],
  ["&gt;'x'", "&gt;’x’"],
  ["a &amp; b's", "a &amp; b’s"],
  ["He's 6'2\"", "He’s 6’2″"],
  ["12:30 'o clock'", "12:30 ‘o clock’"],
  ["“already” curly’s", "“already” curly’s"],
  ["mix 'it' up \"and\" down", "mix ‘it’ up “and” down"],
  ['"a" "b"', "“a” “b”"],
  ['"unclosed', "“unclosed"],
  ["'unclosed", "‘unclosed"],
  ["\"a 'b' c\"", "“a ‘b’ c”"],
  ["'a \"b\" c'", "‘a “b” c’"],
  ["...", "…"],
  ["a…b", "a…b"],
  ["Wait... what", "Wait… what"],
  ["No change here", "No change here"],
  ["", ""],
  ["100%", "100%"],
  ["'50%", "‘50%"],
  ["'5", "‘5"],
  ["'555", "‘555"],
  ["'55.5", "‘55.5"],
  ["'55,5", "‘55,5"],
];

/** The same for markup: elements, comments, `pre`, `code`, `script` and an element that never closes. */
const WPTEXTURIZE_HTML: [string, string][] = [
  ["<p>it's a <code>don't</code> it's</p>", "<p>it’s a <code>don't</code> it’s</p>"],
  ["<a href=\"x'y\">it's</a>", '<a href="x\'y">it’s</a>'],
  ["<pre>it's</pre> it's", "<pre>it's</pre> it’s"],
  ["<b>'foo</b>", "<b>‘foo</b>"],
  ["<b>foo</b>'s", "<b>foo</b>‘s"],
  ["A <b>'quoted'</b> b", "A <b>‘quoted’</b> b"],
  ["<!-- it's --> it's", "<!-- it's --> it’s"],
  ["<script>var a = 'x';</script> it's", "<script>var a = 'x';</script> it’s"],
  ["a < b it's", "a < b it's"],
  ['<p class="x">"quoted"</p>', '<p class="x">“quoted”</p>'],
  ["<style>a{b:'c'}</style>don't", "<style>a{b:'c'}</style>don’t"],
  ["<PRE>don't</PRE> don't", "<PRE>don’t</PRE> don’t"],
  ["<pre\nclass=x>don't</pre> don't", "<pre\nclass=x>don’t</pre> don’t"],
  ["<code>a</pre> 'x' </code> 'y'", "<code>a</pre> 'x' </code> ‘y’"],
  ["<kbd>'k'</kbd> 'z'", "<kbd>'k'</kbd> ‘z’"],
  ["<br/>it's<br>it's", "<br/>it’s<br>it’s"],
  ["text <unclosed it's", "text <unclosed it's"],
  ["<tt>it's</tt> it's", "<tt>it's</tt> it’s"],
  ["<pre><code>it's</code> it's</pre> it's", "<pre><code>it's</code> it's</pre> it’s"],
  ['<p>"a</p><p>b"</p>', "<p>“a</p><p>b”</p>"],
  ["<h2>Don't - stop</h2>", "<h2>Don’t – stop</h2>"],
  ["<img alt=\"it's\"> it's", '<img alt="it\'s"> it’s'],
  ["x<!---->'y'", "x<!---->‘y’"],
  ["<!--> it's", "<!--> it’s"],
  ["&nbsp;'x'", "&nbsp;‘x’"],
  ["a&nbsp;'x'", "a&nbsp;‘x’"],
];

describe("texturize against WordPress's own wptexturize", () => {
  test("every string of the differential gives what the real function gave", () => {
    for (const [from, want] of WPTEXTURIZE)
      expect(`${JSON.stringify(from)} => ${texturize(from)}`).toBe(
        `${JSON.stringify(from)} => ${want}`,
      );
  });

  test("every markup of the differential gives what the real function gave", () => {
    for (const [from, want] of WPTEXTURIZE_HTML)
      expect(`${JSON.stringify(from)} => ${texturizeHtml(from)}`).toBe(
        `${JSON.stringify(from)} => ${want}`,
      );
  });

  test("an apostrophe after a digit is an apostrophe, not a prime, and a no-break space counts as a space", () => {
    expect(texturize("in the 1930's to 1950's")).toBe("in the 1930’s to 1950’s");
    expect(texturize("durable&nbsp;- can")).toBe("durable&nbsp;– can");
    expect(texturizeHtml('<p>in&nbsp;"The Feminine Mystique" and</p>')).toBe(
      "<p>in&nbsp;“The Feminine Mystique” and</p>",
    );
    expect(texturize("foo (tm) bar")).toBe("foo ™ bar");
    expect(texturize("0x9999")).toBe("0x9999");
  });

  test("a binding's placeholder is not text: no rule reaches into it", () => {
    const placeholder = bindingMarker("a--b ? 4x5 : x", "text");
    expect(texturizeHtml(`<p>it's ${placeholder} - it's</p>`)).toBe(
      `<p>it’s ${placeholder} – it’s</p>`,
    );
  });

  test("an element that never closes is not texturized, and the scan stays linear", () => {
    expect(texturizeHtml("a it's <b it's")).toBe("a it’s <b it's");
    const started = performance.now();
    texturizeHtml("<p ".repeat(100_000) + "it's");
    texturizeHtml("it's ".repeat(50_000));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

function walkN(n: N, f: (n: N) => void): void {
  f(n);
  for (const c of n.childNodes ?? []) walkN(c, f);
  if (n.content) walkN(n.content, f);
}

function text(n: N): string {
  let t = "";
  walkN(n, (x) => {
    if (x.nodeName === "#text") t += x.value ?? "";
  });
  return t.replace(/\s+/g, " ").trim();
}

describe("date expressions agree with PHP's date()", () => {
  const instants = [
    Date.UTC(2020, 11, 20, 6, 49, 3),
    Date.UTC(2024, 1, 29, 23, 59, 59),
    Date.UTC(2023, 2, 12, 7, 30, 0),
    Date.UTC(2023, 10, 5, 6, 30, 0),
    Date.UTC(2026, 0, 1, 0, 0, 0),
    Date.UTC(2021, 5, 15, 12, 0, 0),
    // The 1st, 2nd, 3rd, 11th, 12th, 13th, 21st, 22nd and 23rd, where the ordinal suffix changes.
    ...[1, 2, 3, 11, 12, 13, 21, 22, 23, 31].map((d) => Date.UTC(2024, 2, d, 14, 5, 9, 123)),
    // The ISO week of the first days of a year, and a leap day.
    Date.UTC(2021, 0, 3, 10, 0, 0),
    Date.UTC(2024, 11, 30, 10, 0, 0),
  ];
  const formats = [
    "F j, Y",
    "Y-m-d",
    "m/d/Y",
    "d/m/Y",
    "d.m.y",
    "d.m.Y",
    "g:i a",
    "g:i A",
    "H:i",
    "l, jS \\o\\f F",
    "D, d M Y H:i:s",
    "n/j/y G:i:s",
    "h:i a",
    "N w t L",
    "\\Y\\e\\a\\r: Y",
    // The characters the expression used to leave out.
    "z W o B u v",
    "I O P p Z e",
    "c",
    "r",
    "U",
    "jS \\of F",
    "Y B",
  ];
  const zones = [
    "America/New_York",
    "+05:30",
    "UTC",
    "Europe/London",
    "Europe/Dublin",
    "Asia/Kolkata",
    "Australia/Sydney",
  ];

  /** A context whose site is in `zone`: a name, or a fixed offset the way `gmt_offset` states it. */
  async function inZone(zone: string): Promise<ConvertCtx> {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    return Object.assign(Object.create(ctx), {
      model: {
        ...ctx.model,
        options: new Map([
          ...ctx.model.options,
          ["timezone_string", zone.startsWith("+") ? "" : zone],
          ["gmt_offset", zone.startsWith("+") ? "5.5" : "0"],
        ]),
      },
    }) as ConvertCtx;
  }

  test("on every instant and format, in every kind of zone", async () => {
    for (const zone of zones) {
      const zoned = await inZone(zone);
      for (const ms of instants) {
        for (const format of formats) {
          const made = dateExpr(zoned, format, jsString(new Date(ms).toISOString()));
          const got = new Function(`return ${made.expr}`)() as string;
          expect(`${zone} ${format} ${ms}: ${got}`).toBe(
            `${zone} ${format} ${ms}: ${formatDate(zoned, format, ms)}`,
          );
        }
      }
    }
  });

  test("the zone abbreviation T is the one the static road prints, and an unknown zone's is its offset", async () => {
    for (const zone of ["America/New_York", "Europe/London", "Asia/Dubai", "+05:30"]) {
      const zoned = await inZone(zone);
      for (const ms of [Date.UTC(2024, 0, 15, 12), Date.UTC(2024, 6, 15, 12)]) {
        const got = new Function(
          `return ${dateExpr(zoned, "T", jsString(new Date(ms).toISOString())).expr}`,
        )() as string;
        expect(got).toBe(formatDate(zoned, "T", ms));
      }
    }
    const ny = await inZone("America/New_York");
    expect(
      new Function(`return ${dateExpr(ny, "T", jsString("2024-07-15T12:00:00Z")).expr}`)(),
    ).toBe("EDT");
  });

  test("a letter that is not a format character is printed as PHP prints it", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    const made = dateExpr(ctx, "Y q K", jsString("2020-01-01T12:00:00Z"));
    expect(new Function(`return ${made.expr}`)()).toBe("2020 q K");
  });

  test("an expression holds no bare brace, so the build can read it", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    const { expr } = dateExpr(ctx, "c r I T", jsString("2020-01-01T00:00:00Z"));
    let depth = 0;
    for (const c of expr) {
      if (c === "{") depth++;
      if (c === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});

// ── The same token, static and entry ─────────────────────────────────────────────────────────────

/** Markup as the text it shows: tags gone, references decoded, whitespace collapsed. */
const shown = (markup: string): string =>
  decodeEntities(markup.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

/**
 * The strings a token resolves to on a static page for `post` and on an entry template rendering it,
 * the second evaluated over the entry data of the same post as the Jx build would.
 */
const pairCtxs = new Map<string, Promise<[ConvertCtx, ConvertCtx]>>();

async function bothWays(
  site: SiteName,
  post: WpPost,
  token: string,
  attrs: Record<string, unknown> = {},
): Promise<{ stat: string; entry: string; source: string }> {
  const key = `${site}:${post.id}`;
  let pair = pairCtxs.get(key);
  if (!pair) {
    const sub: Subject = { kind: "post", id: post.id };
    pair = Promise.all([
      realCtx(site, sub, { mode: "static" }),
      realCtx(site, sub, { mode: "entry", entryType: post.type }),
    ]).then(([a, b]) => [a.ctx, b.ctx]);
    pairCtxs.set(key, pair);
  }
  const [statCtx, entryCtx] = await pair;
  const b = block("cwicly/paragraph", attrs);
  const stat = resolveTokens(token, statCtx, b, { where: "html" });
  const source = resolveTokens(token, entryCtx, b, { where: "html" });
  const state = entryScope(postData(statCtx, post));
  // An entry prints its values as the collection stores them, and `postData` is the entry as the contract
  // writes it: texturized as WordPress prints it. Nothing is applied on top, so the two are compared as they are.
  return { stat, entry: shown(evalTemplate(source, state)), source };
}

/** The template string an entry binds `{title}` to. */
function bothSource(_post: WpPost): string {
  return "${String((state.entry.data.title ?? '') ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]))}";
}

/** The posts of a type that carry the most data, so every field has a post that holds a value. */
async function richest(site: SiteName, type: string, n: number): Promise<WpPost[]> {
  const loaded = await loadSite(site);
  const ctx = (await realCtx(site, { kind: "post", id: 0 })).ctx;
  return [...loaded.model.posts.values()]
    .filter((p) => p.type === type && p.status === "publish")
    .map((p) => ({ p, size: JSON.stringify(postData(ctx, p)).length }))
    .sort((a, b) => b.size - a.size)
    .slice(0, n)
    .map((x) => x.p);
}

describe("every ACF field, static against entry", () => {
  for (const [site, types] of [
    ["fineline", ["project", "service", "post", "page"]],
    ["ap", ["post", "episode", "supporters_update", "page"]],
  ] as const) {
    test(`${site}: {acffield=key} prints the same for a static page and an entry, for every field of every group`, async () => {
      const loaded = await loadSite(site);
      let compared = 0;
      let nonEmpty = 0;
      const kinds = new Set<string>();
      const top = loaded.acf.groups.flatMap((g) =>
        g.fields.map((f) => ({ key: f.key, type: f.type })),
      );
      for (const type of types) {
        for (const post of await richest(site, type, 4)) {
          for (const f of top) {
            const { stat, entry, source } = await bothWays(site, post, `{acffield=${f.key}}`);
            compared++;
            if (stat !== "") {
              nonEmpty++;
              kinds.add(f.type);
            }
            // The expression the build evaluates must be one a build can evaluate.
            expect(source).not.toContain("undefined");
            expect(shown(entry)).toBe(shown(stat));
          }
        }
      }
      expect(compared).toBeGreaterThan(100);
      expect(nonEmpty).toBeGreaterThan(20);
      // The field types that have a value somewhere in the fixtures all went through both paths.
      expect(kinds.size).toBeGreaterThanOrEqual(site === "fineline" ? 5 : 3);
    });
  }

  test("an image field is its file, a link field its address, a gallery its files joined by commas", async () => {
    const loaded = await loadSite("fineline");
    const byType = (type: string): string =>
      loaded.acf.groups.flatMap((g) => g.fields).find((f) => f.type === type)?.key ?? "";
    for (const post of await richest("fineline", "project", 3)) {
      for (const type of ["image", "link", "gallery"]) {
        const { stat } = await bothWays("fineline", post, `{acffield=${byType(type)}}`);
        if (type === "gallery" && stat !== "")
          expect(stat.split(",").every((u) => u.startsWith("/media/"))).toBe(true);
        if (type === "image" && stat !== "") expect(stat).toStartWith("/media/");
        if (type === "link" && stat !== "") expect(stat).toMatch(/^(\/|https?:|tel:|mailto:)/);
      }
    }
  });

  test("a sub-key picks a part of the value, and the fallback fills an empty one", async () => {
    const loaded = await loadSite("fineline");
    const image = loaded.acf.groups.flatMap((g) => g.fields).find((f) => f.type === "image");
    const post = (await richest("fineline", "project", 1))[0] as WpPost;
    const key = image?.key ?? "";
    const a = await bothWays("fineline", post, `{acffield=${key}=false=alt}`);
    expect(shown(a.entry)).toBe(shown(a.stat));
    const w = await bothWays("fineline", post, `{acffield=${key}=false=width}`);
    expect(shown(w.entry)).toBe(shown(w.stat));
    const u = await bothWays("fineline", post, `{acffield=${key}=false=url}`);
    expect(shown(u.entry)).toBe(shown(u.stat));
    const empty = (await richest("fineline", "post", 1))[0] as WpPost;
    const fb = await bothWays(
      "fineline",
      empty,
      `{acffield=${key}=false=false=https://example.com/fallback.png}`,
    );
    expect(shown(fb.entry)).toBe(shown(fb.stat));
  });

  test("an unknown field prints its fallback and is reported once", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 1078 });
    expect(resolveTokens("[{acffield=field_does_not_exist=false=false=Fallback text}]", ctx)).toBe(
      "[Fallback text]",
    );
    expect(resolveTokens("[{acffield=field_does_not_exist}]", ctx)).toBe("[]");
    const entries = ctx.report.entries().filter((e) => e.code === "dynamic.unknown-field");
    expect(entries.map((e) => (e.data as { field: string }).field)).toEqual([
      "field_does_not_exist",
    ]);
  });
});

describe("the tokens of the single templates, static against entry", () => {
  const PAIRS: [SiteName, string, string][] = [
    ["fineline", "single-project", "project"],
    ["fineline", "single-service", "service"],
    ["fineline", "single", "post"],
    ["ap", "single-post", "post"],
    ["ap", "single-episode", "episode"],
  ];
  /** Tokens whose two forms differ on purpose, and why. */
  const DIFFER: Record<string, string> = {};
  for (const [site, template, type] of PAIRS) {
    test(`${site} ${template}: every token of the template, on the richest ${type} posts`, async () => {
      const loaded = await loadSite(site);
      const tokens = new Map<string, Record<string, unknown>>();
      walkBlocks(subjectBlocks(loaded, { kind: "template", slug: template }), (b) => {
        const strings = [b.innerHTML];
        const visit = (v: unknown, key = ""): void => {
          if (typeof v === "string") {
            if (!/htmlRender|serializedInnerBlocks/.test(key)) strings.push(v);
          } else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
          else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
        };
        visit(b.attrs);
        for (const str of strings)
          for (const f of findTokens(str)) if (!tokens.has(f.token)) tokens.set(f.token, b.attrs);
      });
      expect(tokens.size).toBeGreaterThan(3);
      let compared = 0;
      for (const post of await richest(site, type, 3)) {
        for (const [token, attrs] of tokens) {
          if (
            /^\{(class|acl|sacl|gcl|aclv|gclv|cs-index|cccomp|currentpageclass|idadd|loop-id|menu|menuname|postcontent|empty)\b/.test(
              token,
            )
          )
            continue;
          if (!isKnownToken(findTokens(token)[0]?.name ?? "")) continue;
          const { stat, entry, source } = await bothWays(site, post, token, attrs);
          compared++;
          if (token in DIFFER) {
            expect(shown(entry)).toBe(
              shown(texturize(shown(entry)) === shown(stat) ? entry : stat),
            );
            continue;
          }
          // A token with no value in an entry (the author's address when the entry has no authorUrl) prints nothing there.
          if (/^\{(authorurl|id)\b/.test(token)) continue;
          expect(source).not.toContain("undefined");
          expect(`${token} => ${shown(entry)}`).toBe(`${token} => ${shown(stat)}`);
        }
      }
      expect(compared).toBeGreaterThan(20);
    });
  }

  test("a title with quotes is the texturized one in an entry as it is on a static page", async () => {
    const loaded = await loadSite("ap");
    const post = [...loaded.model.posts.values()].find(
      (p) => p.type === "post" && p.status === "publish" && /"/.test(decodeEntities(p.title)),
    ) as WpPost;
    expect(post).toBeDefined();
    const { stat, entry } = await bothWays("ap", post, "{title}");
    const stored = decodeEntities(post.title).replace(/\s+/g, " ").trim();
    const { ctx } = await realCtx("ap", { kind: "post", id: post.id });
    // The entry data holds the title as WordPress prints it (contract request 3), the facts a static page reads hold it as stored.
    const raw = evalTemplate(bothSource(post), entryScope(postData(ctx, post)));
    expect(shown(raw)).toBe(shown(texturize(decodeEntities(post.title))));
    expect(shown(raw)).not.toBe(stored);
    expect(postFacts(ctx, post).title).toBe(decodeEntities(post.title));
    expect(shown(stat)).toBe(shown(texturize(decodeEntities(post.title))));
    expect(shown(entry)).toBe(shown(stat));
  });
});

// ── Entry mode and components, as written ────────────────────────────────────────────────────────

describe("an entry template", () => {
  test("binds the entry's own fields to ctx.entryExpr, and a query item's to $map.item", async () => {
    const { ctx } = await realCtx(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryType: "project" },
    );
    expect(resolveTokens("{title}", ctx)).toBe("${state.entry.data.title ?? ''}");
    expect(resolveTokens("{pageurl}|{authorname}", ctx)).toBe(
      "${state.entry.data.url ?? ''}|${state.entry.data.author ?? ''}",
    );
    expect(resolveTokens("{featuredimage}", ctx)).toBe(
      "${state.entry.data.featuredImage?.src ?? ''}",
    );
    expect(resolveTokens("{featuredimage=true=false=false=true=false}", ctx)).toBe(
      "${state.entry.data.featuredImage?.src ?? ''}",
    );
    expect(resolveTokens("{posttype}", ctx)).toBe("project");
    const item = Object.assign(Object.create(ctx), { entryExpr: "$map.item" }) as ConvertCtx;
    expect(resolveTokens("{title}", item)).toBe("${$map.item.data.title ?? ''}");
    expect(resolveTokens("<h2>{title}</h2>", item, undefined, { where: "html" })).toMatch(
      /^<h2>\$\{String\(\(\$map\.item\.data\.title \?\? ''\) \?\? ''\)\.replace\(/,
    );
  });

  test("a featured image with a fallback binds `||` the fallback, evaluated over an entry with and without one", async () => {
    const { ctx, loaded } = await realCtx(
      "ap",
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryType: "post" },
    );
    const id = [...loaded.model.attachments.keys()].find((k) => loaded.media.mediaFor(k)) as number;
    const want = loaded.media.mediaFor(id)?.src as string;
    const bound = resolveTokens(
      "{featuredimage}",
      ctx,
      block("cwicly/image", { dynamicStaticFallbackID: id }),
    );
    expect(bound).toContain("||");
    expect(evalTemplate(bound, entryScope({ featuredImage: { src: "/media/own.jpg" } }))).toBe(
      "/media/own.jpg",
    );
    expect(evalTemplate(bound, entryScope({}))).toBe(want);
  });

  test("dates, excerpts and terms bind to the contract's keys and print what a static page prints", async () => {
    const { ctx } = await realCtx(
      "ap",
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryType: "post" },
    );
    const state = entryScope({
      title: "T",
      date: "2020-12-20T06:49:00.000Z",
      modified: "2024-03-12T19:10:36.000Z",
      excerpt: "<p>One “two” three four five six seven</p>",
      terms: { category: [{ slug: "a", name: "A & B", url: "/category/a/" }], post_tag: [] },
    });
    const say = (token: string, where: "text" | "html" = "text"): string =>
      evalTemplate(resolveTokens(token, ctx, undefined, { where }), state);
    expect(say("{postdate=published=default}")).toBe("December 20, 2020");
    expect(say("{postdate=modified=3}")).toBe("03/12/2024");
    expect(say("{time=published=2}")).toBe("1:49 AM");
    expect(say("{postexcerpt=20}")).toBe("One “two” three");
    expect(say("{postcategories}")).toBe("A & B");
    expect(say("{postcategories}", "html")).toBe("A &amp; B");
    expect(say("{posttags}")).toBe("");
    expect(say("{postcategory}")).toBe("A & B");
  });

  test("a missing date prints nothing, not Invalid Date", async () => {
    const { ctx } = await realCtx(
      "ap",
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryType: "post" },
    );
    expect(evalTemplate(resolveTokens("{postdate}", ctx), entryScope({}))).toBe("");
  });

  test("an archive reads its term: a term entry in an archive template, a reference in a loop", async () => {
    const { ctx } = await realCtx(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      { mode: "entry", termExpr: "state.term" },
    );
    expect(resolveTokens("{archivetitle}", ctx)).toBe("${state.term.data.name ?? ''}");
    expect(resolveTokens("{archivedescription}", ctx, undefined, { where: "html" })).toBe(
      "${state.term.data.description ?? ''}",
    );
    expect(resolveTokens("{taxterms=name}|{termquery=slug}", ctx)).toBe(
      "${state.term.data.name ?? ''}|${state.term.data.slug ?? ''}",
    );
    const loop = Object.assign(Object.create(ctx), { termExpr: "$map.item" }) as ConvertCtx;
    expect(resolveTokens("{taxterms=name}", loop)).toBe("${$map.item.name ?? ''}");
    expect(resolveTokens('<a href="{taxonomytermsurl}">', loop)).toBe(
      "<a href=\"${$map.item.url ?? ''}\">",
    );
    expect(ctx.report.entries().filter((e) => e.code === "token.unresolved")).toHaveLength(0);
    // A term loop item has a name, a slug and an address; its id and count are not on the converted site.
    expect(resolveTokens("{taxterms=term_id}", loop)).toBe("");
    expect(loop.report.entries().filter((e) => e.code === "token.unresolved")).toHaveLength(1);
  });

  test("a post type archive's title is the type's plural label, and the template says which", async () => {
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "archive-project" },
      { mode: "entry", entryType: "project" },
    );
    expect(resolveTokens("{archivetitle}", ctx)).toBe(
      (loaded.acf.postTypes.get("project")?.labels.name ??
        loaded.acf.postTypes.get("project")?.plural) as string,
    );
  });

  test("an ACF term field on a taxonomy archive reads the term entry", async () => {
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      { mode: "entry", termExpr: "state.term" },
    );
    const field = loaded.acf.groups
      .flatMap((g) => g.fields)
      .find((f) => f.key === "field_655673caeaa9a");
    expect(field?.type).toBe("image");
    expect(
      resolveTokens(
        "{acffield=field_655673caeaa9a=currenttaxonomytermarchive=false=false=large-1-0-image}",
        ctx,
      ),
    ).toBe(`\${state.term.data.${field?.name}?.src ?? ''}`);
  });

  test("a fixed term or post is a value in every mode", async () => {
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryType: "project" },
    );
    const term = [...loaded.model.terms.values()].find(
      (t) => t.taxonomy === "location" && Object.keys(t.meta).length > 0,
    );
    expect(term).toBeDefined();
    const out = resolveTokens(`{acffield=field_655673caeaa9a=term_${term?.termId}}`, ctx);
    expect(out).not.toContain("${");
  });

  test("a read that needs a user or a row of a loop is unresolved and says why, with the block's fallback", async () => {
    const { ctx } = await realCtx(
      "ap",
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryType: "post" },
    );
    const fb = block("cwicly/image", {
      dynamicStaticFallbackURL:
        "https://media.anabaptistperspectives.org/2022/06/2022-06_Conversation1.png",
      dynamicStaticFallbackID: 1098,
    });
    expect(
      resolveTokens("{acffield=field_62d867cf864ee=currentauthor=false=1098=0-1-1-image}", ctx, fb),
    ).toMatch(/^\/media\//);
    const entries = ctx.report.entries().filter((e) => e.code === "dynamic.unsupported");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toContain("currentauthor");
    expect(resolveTokens("{acfrepeater=sub}", ctx)).toBe("");
    const row = Object.assign(Object.create(ctx), { rowExpr: "$map.item" }) as ConvertCtx;
    expect(resolveTokens("{acfrepeater=sub}", row)).toBe("${$map.item?.sub ?? ''}");
  });
});

describe("a component", () => {
  async function component(site: SiteName, ref: string): Promise<ConvertCtx> {
    const { ctx } = await realCtx(site, { kind: "component", ref });
    const info = ctx.components.get(ref);
    expect(info).toBeDefined();
    ctx.props = new Map(info?.props.map((p) => [p.id, p.key]));
    return ctx;
  }

  test("its connected properties become reads of its state", async () => {
    const ctx = await component("fineline", "0a275b695a");
    const keys = Object.fromEntries(
      (ctx.components.get("0a275b695a")?.props ?? []).map((p) => [p.id, p.key]),
    );
    expect(keys["1nsiW"]).toBe("heading");
    expect(
      resolveTokens(
        "<h3>{component=content=1nsiW}</h3>",
        ctx,
        block("cwicly/heading", { componentConnectors: { content: { ref: "1nsiW" } } }),
      ),
    ).toBe("<h3>${state.heading ?? ''}</h3>");
    // A richtext property is markup and is written raw into markup; a text one is escaped there.
    const rich = resolveTokens("{component=content=xdjvI}", ctx, undefined, { where: "html" });
    expect(rich).toBe(`\${state.${keys.xdjvI} ?? ''}`);
    const plain = resolveTokens("{component=content=1nsiW}", ctx, undefined, { where: "html" });
    expect(plain).toContain(".replace(");
    expect(resolveTokens('<a href="{component=link=SKhKx}">', ctx)).toBe(
      `<a href="\${state.${keys.SKhKx}?.href ?? ''}">`,
    );
  });

  test("the parameter forms", async () => {
    const ctx = await component("ap", "425a689f37");
    ctx.props = new Map([
      ...(ctx.props ?? []),
      ["bool1", "open"],
      ["acc", "expanded"],
      ["lst", "iconOn"],
    ]);
    expect(resolveTokens("{component=parameter=VfVjx}", ctx)).toBe(
      `\${state.${ctx.props.get("VfVjx")} ?? ''}`,
    );
    expect(resolveTokens("{component=parameter=bool1=boolean}", ctx)).toBe("${state.open ?? ''}");
    expect(resolveTokens("{component=parameter=acc=accordionopen}", ctx)).toBe(
      "${state.expanded ? 'cc-accordion-active' : 'cc-accordion-hidden'}",
    );
    expect(resolveTokens("{component=parameter=lst=listIconActive}", ctx)).toBe(
      "${state.iconOn ? 'cc-icon-list' : ''}",
    );
    expect(resolveTokens("{component=parameter=zzz}", ctx)).toBe("");
    expect(
      ctx.report.entries().some((e) => e.code === "token.unresolved" && e.message.includes("zzz")),
    ).toBe(true);
  });

  test("a component has no entry: the tokens that read the current post are unresolved there", async () => {
    const ctx = await component("fineline", "0a275b695a");
    expect(resolveTokens("a{title}b{pageurl}c", ctx)).toBe("abc");
    const reasons = ctx.report
      .entries()
      .filter((e) => e.code === "token.unresolved")
      .map((e) => (e.data as { reason: string }).reason);
    expect(reasons).toHaveLength(2);
    expect(reasons.every((r) => r.includes("component"))).toBe(true);
    // The site's own tokens are the same in a component.
    expect(resolveTokens("{sitetitle}", ctx)).toBe("finelinepainting.pro");
  });

  test("every token of every component of both sites is resolved or reported", async () => {
    for (const site of ["fineline", "ap"] as const) {
      const loaded = await loadSite(site);
      for (const sub of allSubjects(loaded)) {
        if (sub.kind !== "component") continue;
        const ctx = await component(site, sub.ref);
        walkBlocks(subjectBlocks(loaded, sub), (b) => {
          if (!b.name) return;
          // The marked form holds bindings as placeholders, so a brace in it is a token that was left.
          const out = resolveTokens(b.innerHTML, ctx, b, { marked: true });
          for (const f of findTokens(out)) {
            expect([
              "class",
              "acl",
              "sacl",
              "gcl",
              "aclv",
              "gclv",
              "cs-index",
              "cccomp",
              "currentpageclass",
            ]).toContain(f.name);
          }
        });
      }
    }
  });
});

// ── The live pages as the oracle ─────────────────────────────────────────────────────────────────

/** The pages saved under tests/fixtures/<site>/html, the post each is, and the template it was rendered by. */
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

const attrsOf = (n: N): Record<string, string> =>
  Object.fromEntries((n.attrs ?? []).map((a) => [a.name, a.value]));

/** Every element of a parsed page by each class it carries. */
function byClass(doc: N): Map<string, N[]> {
  const index = new Map<string, N[]>();
  walkN(doc, (n) => {
    const c = attrsOf(n).class;
    if (c) for (const k of c.split(/\s+/)) index.set(k, [...(index.get(k) ?? []), n]);
  });
  return index;
}

interface Checked {
  where: string;
  classID: string;
  attr: string;
  live: string | undefined;
  mine: string | undefined;
}

/**
 * Resolves the saved markup of every block that has tokens in it, for the post its live page shows, and
 * compares the attributes and the text the token resolution itself produced with the element the live
 * page printed for that block.
 */
async function oracle(
  site: SiteName,
): Promise<{ checked: number; texts: number; diffs: Checked[] }> {
  const loaded = await loadSite(site);
  const t = await toolsFor(site, loaded);
  const known = ["href", "src", "alt", "width", "height", "title", "target", "rel", "aria-label"];
  const diffs: Checked[] = [];
  let checked = 0;
  let texts = 0;
  for (const page of LIVE[site]) {
    const post = page.post ? loaded.model.posts.get(page.post) : undefined;
    // A post that is not in the fixtures (they keep a hundred of each type) cannot be resolved for.
    if (page.post && !post) continue;
    const doc = parse(
      readFileSync(`tests/fixtures/${site}/html/${page.file}.html`, "utf8"),
    ) as unknown as N;
    const index = byClass(doc);
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
    // A class id that two blocks of the page share (a duplicated page keeps its ids) names no one block.
    const counts = new Map<string, number>();
    for (const sub of subjects) {
      walkBlocks(subjectBlocks(loaded, sub), (b) => {
        const c = b.attrs.classID;
        if (typeof c === "string") counts.set(c, (counts.get(c) ?? 0) + 1);
      });
    }
    for (const sub of subjects) {
      const { ctx } = await realCtx(site, sub, {
        mode: "static",
        ...(post ? { subject: { kind: "post", id: String(post.id), post } } : {}),
      });
      Object.assign(ctx, { urlForAuthor: t.urlForAuthor, urlForArchive: t.urlForArchive });
      walkBlocks(subjectBlocks(loaded, sub), (b) => {
        const classID = b.attrs.classID;
        if (!b.name || typeof classID !== "string") return;
        if (b.name === "cwicly/menu" || b.name === "cwicly/content") return;
        const withTokens = b.innerHTML.replace(
          /\{(gcl|class|acl|sacl|cs-index|idadd|cccomp|currentpageclass[^}]*)\}/g,
          "",
        );
        if (!/\{[a-z]/.test(withTokens)) return;
        const lives = index.get(classID) ?? [];
        if (lives.length !== 1 || (counts.get(classID) ?? 0) !== 1) return;
        const live = lives[0] as N;
        const resolved = resolveTokens(b.innerHTML, ctx, b, { where: "html" });
        let mine: N | undefined;
        walkN(parseFragment(resolved) as unknown as N, (n) => {
          if (!mine && n.nodeName === live.nodeName) mine = n;
        });
        if (!mine) return;
        const L = attrsOf(live);
        const M = attrsOf(mine);
        const where = `${page.file} ${sub.kind}`;
        for (const a of known) {
          // Only what the tokens produced: the attributes PHP injects around a token (a featured image's
          // width and height) are the image converter's.
          if (!(a in M)) continue;
          let lv = L[a];
          let mv = M[a];
          if (a === "href" || a === "src") {
            if (lv) lv = loaded.media.mediaForUrl(lv)?.src ?? t.rewriteUrl(lv);
            if (mv) mv = loaded.media.mediaForUrl(mv)?.src ?? t.rewriteUrl(mv);
          }
          checked++;
          if (a === "width" || a === "height") {
            // A sized copy has other dimensions than the one original the site keeps; the shape is the same.
            const other = a === "width" ? "height" : "width";
            if (
              lv &&
              mv &&
              L[other] &&
              M[other] &&
              Math.abs(Number(lv) / Number(L[other]) / (Number(mv) / Number(M[other])) - 1) < 0.01
            )
              continue;
          }
          if (lv !== mv) diffs.push({ where, classID, attr: a, live: lv, mine: mv });
        }
        if (b.innerBlocks.length === 0 && !/<(svg|img)/.test(b.innerHTML)) {
          texts++;
          const lt = text(live);
          const mt = text(mine);
          if (lt !== mt)
            diffs.push({
              where,
              classID,
              attr: "#text",
              live: lt.slice(0, 60),
              mine: mt.slice(0, 60),
            });
        }
      });
    }
  }
  return { checked, texts, diffs };
}

describe("the live pages", () => {
  test("fineline: what the tokens resolve to is what the live page printed", async () => {
    const { checked, texts, diffs } = await oracle("fineline");
    expect(checked).toBeGreaterThanOrEqual(25);
    expect(texts).toBeGreaterThanOrEqual(5);
    expect(diffs).toEqual([]);
  });

  test("anabaptistperspectives: the same, and the differences are the ones this tool cannot carry", async () => {
    const { checked, texts, diffs } = await oracle("ap");
    expect(checked).toBeGreaterThanOrEqual(25);
    expect(texts).toBeGreaterThanOrEqual(5);
    expect([...new Set(diffs.map((d) => `${d.classID} ${d.attr}`))].sort()).toEqual(KNOWN_AP_DIFFS);
    // The SVG logos have no size in the database: WordPress prints 0, the media plan has none and the token is left empty
    // (a `width="0"` on a logo would hide it).
    for (const d of diffs.filter((x) => x.attr === "width" || x.attr === "height"))
      expect(d.live).toBe("0");
  });
});

/** Where the live page of anabaptistperspectives has what no static site has: a login address, an author's own picture, an avatar. */
const KNOWN_AP_DIFFS: string[] = [
  "a-signin href",
  "image-c2b1662 height",
  "image-c2b1662 width",
  "image-c6e1b5e height",
  "image-c6e1b5e width",
  "image-c6f145d height",
  "image-c6f145d width",
  "image-c8732a8 src",
];

// ── The census ───────────────────────────────────────────────────────────────────────────────────

const CLASS_TOKENS = new Set([
  "class",
  "acl",
  "sacl",
  "gcl",
  "aclv",
  "gclv",
  "cs-index",
  "cccomp",
  "currentpageclass",
  "darkmode_force",
]);

interface Census {
  total: number;
  resolved: number;
  stripped: number;
  classTokens: number;
  notTokens: number;
  unresolved: number;
  unknown: number;
  unresolvedBy: Record<string, number>;
  /** Occurrences that came back with a `{…}` of a known, non-class token in them: a token that was not handled. */
  leaked: string[];
  /** Unresolved occurrences with no report entry that says so. */
  unreported: string[];
}

/** Every token occurrence in every block of a site, resolved in the mode its subject is converted in. */
async function census(site: SiteName): Promise<Census> {
  const loaded = await loadSite(site);
  const t = await toolsFor(site, loaded);
  const out: Census = {
    total: 0,
    resolved: 0,
    stripped: 0,
    classTokens: 0,
    notTokens: 0,
    unresolved: 0,
    unknown: 0,
    unresolvedBy: {},
    leaked: [],
    unreported: [],
  };
  for (const sub of allSubjects(loaded)) {
    const slug = "slug" in sub ? sub.slug : "";
    const mode = sub.kind === "post" ? "static" : sub.kind === "component" ? "component" : "entry";
    const over: Partial<ConvertCtx> = { mode, urlFor: t.urlFor, rewriteUrl: t.rewriteUrl };
    if (mode === "entry") {
      const type =
        /^(?:single|archive)-(.+)$/.exec(slug)?.[1] ?? (slug === "single" ? "post" : undefined);
      if (type !== undefined) over.entryType = type;
      if (slug.startsWith("taxonomy-") || slug === "category" || slug === "tag")
        over.termExpr = "state.term";
    }
    const { ctx } = await realCtx(site, sub, over);
    if (sub.kind === "component")
      ctx.props = new Map(ctx.components.get(sub.ref)?.props.map((p) => [p.id, p.key]));
    walkBlocks(subjectBlocks(loaded, sub), (b) => {
      if (!b.name) return;
      const strings = [b.innerHTML];
      const visit = (v: unknown, key = ""): void => {
        if (typeof v === "string") {
          if (!/htmlRender|serializedInnerBlocks/.test(key)) strings.push(v);
        } else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
      };
      visit(b.attrs);
      for (const str of strings) {
        for (const f of findTokens(str)) {
          out.total++;
          ctx.report = createReport();
          const marked = resolveTokens(f.token, ctx, b, { marked: true });
          const entries = ctx.report.entries();
          if (!isKnownToken(f.name)) {
            out.notTokens++;
            if (/^[A-Za-z][\w-]*$/.test(f.name) && !entries.some((e) => e.code === "token.unknown"))
              out.unreported.push(f.token);
            continue;
          }
          if (CLASS_TOKENS.has(f.name)) {
            out.classTokens++;
            if (marked !== f.token) out.leaked.push(`${f.token} changed`);
            continue;
          }
          if (entries.some((e) => e.code === "token.unresolved")) {
            out.unresolved++;
            out.unresolvedBy[f.name] = (out.unresolvedBy[f.name] ?? 0) + 1;
            const entry = entries.find((e) => e.code === "token.unresolved");
            if (
              marked !== "" ||
              !entry?.where ||
              !entry.data ||
              !(entry.data as { reason?: string }).reason
            )
              out.unreported.push(f.token);
            continue;
          }
          if (marked === "") out.stripped++;
          else out.resolved++;
          // A token left in the output is a token that was not resolved.
          for (const left of findTokens(marked))
            if (isKnownToken(left.name) && !CLASS_TOKENS.has(left.name))
              out.leaked.push(`${f.token} -> ${left.token}`);
        }
      }
    });
  }
  return out;
}

describe("the census of every token of both sites", () => {
  test("fineline: every occurrence is resolved, removed on purpose, or reported", async () => {
    const c = await census("fineline");
    expect(c.leaked).toEqual([]);
    expect(c.unreported).toEqual([]);
    expect({
      total: c.total,
      stripped: c.stripped,
      classTokens: c.classTokens,
      notTokens: c.notTokens,
      resolvedOrReported: c.resolved + c.unresolved,
    }).toEqual({
      total: 6323,
      stripped: 2260,
      classTokens: 966,
      notTokens: 3,
      resolvedOrReported: 3094,
    });
    // Which tokens have a value depends on the addresses the routes module gives and the files the media
    // plan keeps, which move without this module changing: how the 3,094 split is a range, and each token
    // those modules own is bounded by what the site holds of it.
    expect(c.unresolved).toBeGreaterThanOrEqual(20);
    expect(c.unresolved).toBeLessThanOrEqual(30);
    const {
      pageobject = 0,
      pageurl = 0,
      imagealt = 0,
      imageheight = 0,
      imagewidth = 0,
    } = c.unresolvedBy;
    expect(pageobject).toBeLessThanOrEqual(15);
    expect(pageurl).toBeLessThanOrEqual(2);
    expect(imagealt).toBeLessThanOrEqual(2);
    expect(imageheight).toBeLessThanOrEqual(2);
    expect(imagewidth).toBeLessThanOrEqual(2);
    // What this module cannot answer at all is exact.
    expect({
      acfgallery: c.unresolvedBy.acfgallery,
      filter: c.unresolvedBy.filter,
      pagination: c.unresolvedBy.pagination,
    }).toEqual({ acfgallery: 1, filter: 1, pagination: 1 });
  });

  test("anabaptistperspectives: the same", async () => {
    const c = await census("ap");
    expect(c.leaked).toEqual([]);
    expect(c.unreported).toEqual([]);
    expect({
      total: c.total,
      resolved: c.resolved,
      stripped: c.stripped,
      classTokens: c.classTokens,
      notTokens: c.notTokens,
      unresolved: c.unresolved,
    }).toEqual({
      total: 884,
      resolved: 140,
      stripped: 326,
      classTokens: 310,
      notTokens: 34,
      unresolved: 74,
    });
    // What cannot be carried over: comments, logins, user queries, shortcodes, pagination, and the author's own profile.
    expect(Object.keys(c.unresolvedBy).sort()).toEqual([
      "acffield",
      "authorinfo",
      "commentquery",
      "commentreplyurl",
      "directlogout",
      "editcommenturl",
      "formcomment",
      "id",
      "loginurl",
      "nextqb",
      "nextquery",
      "pageobject",
      "pagination",
      "prevqb",
      "prevquery",
      "shortcode",
      "taxonomyqueryurl",
      "taxonomytermsurl",
      "taxterms",
      "termquery",
      "userquery",
      "userqueryurl",
    ]);
  });
});

// ── Where the result goes ────────────────────────────────────────────────────────────────────────

describe("the result for the place it is written", () => {
  test("a static value is escaped as markup in markup, and left alone in a plain string", async () => {
    const loaded = await loadSite("fineline");
    const base = loaded.model.posts.get(5246) as WpPost;
    const { ctx } = await realCtx(
      "fineline",
      { kind: "post", id: 5246 },
      { post: { ...base, title: 'Tom & <Jerry> "q"' } },
    );
    expect(resolveTokens("{title}", ctx)).toBe("Tom & <Jerry> “q”");
    expect(resolveTokens("<h1>{title}</h1>", ctx, undefined, { where: "html" })).toBe(
      "<h1>Tom &amp; &lt;Jerry&gt; “q”</h1>",
    );
    expect(resolveTokens("<h1>{title}</h1>", ctx, undefined, { marked: true })).toBe(
      "<h1>Tom &amp; &lt;Jerry&gt; “q”</h1>",
    );
  });

  test("a literal ${ in a value is &#36;{ in markup and split elsewhere, with a report", async () => {
    const loaded = await loadSite("fineline");
    const base = loaded.model.posts.get(5246) as WpPost;
    const { ctx } = await realCtx(
      "fineline",
      { kind: "post", id: 5246 },
      { post: { ...base, title: "Cost ${5}" } },
    );
    expect(resolveTokens("<b>{title}</b>", ctx, undefined, { where: "html" })).toBe(
      "<b>Cost &#36;{5}</b>",
    );
    expect(resolveTokens("{title}", ctx)).toBe("Cost $\u200b{5}");
    expect(
      ctx.report
        .entries()
        .some((e) => e.code === "token.literal-template" && e.severity === "warn"),
    ).toBe(true);
  });

  test("a binding beside a backslash or a backtick doubles them, and a binding alone does not", async () => {
    const { ctx } = await realCtx(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryType: "project" },
    );
    expect(resolveTokens("C:\\dir `x` {title}", ctx)).toBe(
      "C:\\\\dir \\`x\\` ${state.entry.data.title ?? ''}",
    );
    expect(
      evalTemplate(resolveTokens("C:\\dir `x` {title}", ctx), entryScope({ title: "T" })),
    ).toBe("C:\\dir `x` T");
  });

  test("an HTML value in a plain string is its text, and in markup it is raw", async () => {
    const { ctx } = await realCtx(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      { mode: "entry", termExpr: "state.term" },
    );
    const state = { term: { data: { description: "<p>Hi <b>there</b> &amp; you</p>" } } };
    expect(
      evalTemplate(resolveTokens("{archivedescription}", ctx, undefined, { where: "html" }), state),
    ).toBe("<p>Hi <b>there</b> &amp; you</p>");
    expect(evalTemplate(resolveTokens("{archivedescription}", ctx), state)).toBe(
      "Hi there &amp; you",
    );
  });

  test("tokenContent and tokenNodes resolve, convert and finish in one call", async () => {
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryType: "project" },
    );
    const heading = findBlock(
      subjectBlocks(loaded, { kind: "template", slug: "single-project" }),
      (b) => b.attrs.dynamicStaticBefore === "About This ",
    );
    expect(heading?.innerHTML).toContain('<span class="before">About This </span>{title}');
    const content = tokenContent(
      heading?.innerHTML.replace(/^\s*<h2[^>]*>|<\/h2>\s*$/g, "") ?? "",
      ctx,
      heading,
    );
    expect(content).toEqual({
      children: [
        { tagName: "span", className: "before", textContent: "About This " },
        { tagName: "span", textContent: "${state.entry.data.title ?? ''}" },
      ],
    });
    const nodes = tokenNodes('<a class="x" href="{pageurl}" title="{title}">{title}</a>', ctx);
    expect(nodes).toEqual([
      {
        tagName: "a",
        className: "x",
        attributes: {
          href: "${state.entry.data.url ?? ''}",
          title: "${state.entry.data.title ?? ''}",
        },
        textContent: "${state.entry.data.title ?? ''}",
      },
    ]);
  });

  test("on a static page the same call gives plain values", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 3371 });
    expect(tokenNodes('<a href="{pageurl}" title="{title}">{title} &amp; more</a>', ctx)).toEqual([
      {
        tagName: "a",
        attributes: {
          href: "/choosing-the-best-log-home-stain/",
          title: "Choosing the Best Log Home Stain",
        },
        textContent: "Choosing the Best Log Home Stain & more",
      },
    ]);
  });
});

function findBlock(blocks: WpBlock[], pred: (b: WpBlock) => boolean): WpBlock | undefined {
  let found: WpBlock | undefined;
  walkBlocks(blocks, (b) => {
    if (!found && pred(b)) found = b;
  });
  return found;
}

describe("reports", () => {
  test("every report entry of a conversion is located at its subject and carries a stable code", async () => {
    const { ctx } = await realCtx(
      "ap",
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryType: "post" },
    );
    resolveTokens(
      "{loginurl}{brace}{acffield=field_nope}{currentdate}{pageobject=99999999=page=post-type}{postdate=published=5}",
      ctx,
    );
    const codes = ctx.report
      .entries()
      .map((e) => e.code)
      .sort();
    expect(codes).toEqual(
      [
        "dynamic.unknown-field",
        "link.unresolved",
        "token.approximated",
        "token.frozen-date",
        "token.unknown",
        "token.unresolved",
        "token.unresolved",
        "token.unresolved",
      ].sort(),
    );
    for (const e of ctx.report.entries()) {
      expect(e.where).toBe(`template:${ctx.subject.id}`);
      expect(e.code).toMatch(/^[a-z]+\.[a-z-]+$/);
      expect(e.message.length).toBeGreaterThan(10);
    }
  });

  test("the same problem on the same token is reported once per subject", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 819 });
    for (let i = 0; i < 5; i++) resolveTokens("{loginurl}{imagewidth=4009}", ctx);
    expect(ctx.report.entries().filter((e) => e.code === "token.unresolved")).toHaveLength(2);
  });

  test("two subjects each report their own", async () => {
    const a = (await realCtx("ap", { kind: "post", id: 819 })).ctx;
    const b = (await realCtx("ap", { kind: "post", id: 773 })).ctx;
    resolveTokens("{loginurl}", a);
    resolveTokens("{loginurl}", b);
    expect(a.report.entries()).toHaveLength(1);
    expect(b.report.entries()).toHaveLength(1);
    expect(a.report.entries()[0]?.where).toBe("post:819");
    expect(b.report.entries()[0]?.where).toBe("post:773");
  });
});

// ── What the review found ────────────────────────────────────────────────────────────────────────

describe("a post's terms are listed the way WordPress lists them: by name", () => {
  const decodeAttr = (v: string): string => decodeEntities(v);

  test("the live page of the cultural captivity essay lists its tags by name, and the entry data, {posttags} and {tag} follow", async () => {
    const live = [
      ...readFileSync(
        "tests/fixtures/ap/html/essays__the-cultural-captivity-of-the-gospel.html",
        "utf8",
      ).matchAll(/<meta property="article:tag" content="([^"]*)"/g),
    ].map((m) => decodeAttr(m[1] as string));
    expect(live).toEqual([
      "Church Community",
      "Discipleship",
      "Kingdom of God",
      "Ministry",
      "Missions",
    ]);
    const loaded = await loadSite("ap");
    const post = loaded.model.posts.get(8819) as WpPost;
    // The database stores them in the order they were added, which is not the order WordPress prints.
    const stored = (loaded.model.termsByPost.get(8819) ?? [])
      .map((id) => loaded.model.terms.get(id))
      .filter((t) => t?.taxonomy === "post_tag")
      .map((t) => decodeEntities(t?.name ?? ""));
    expect(stored).not.toEqual(live);
    const { ctx } = await realCtx("ap", { kind: "post", id: 8819 });
    const terms = postData(ctx, post).terms as { post_tag: { name: string }[] };
    expect(terms.post_tag.map((t) => t.name)).toEqual(live);
    expect(resolveTokens("{posttags}", ctx)).toBe(live.join(" "));
    expect(resolveTokens("{tag}", ctx, block("cwicly/paragraph", { dynamicTagIndex: 1 }))).toBe(
      "Church Community",
    );
    expect(resolveTokens("{tag}", ctx, block("cwicly/paragraph", { dynamicTagIndex: 2 }))).toBe(
      "Discipleship",
    );
    const entry = (await realCtx("ap", { kind: "post", id: 8819 }, { mode: "entry" })).ctx;
    const state = entryScope(postData(ctx, post));
    expect(evalTemplate(resolveTokens("{posttags}", entry), state)).toBe(live.join(" "));
    expect(evalTemplate(resolveTokens("{tag}", entry, block("cwicly/paragraph", {})), state)).toBe(
      "Church Community",
    );
  });

  test("on every post of both sites each taxonomy's terms are in name order, and some were not stored that way", async () => {
    let reordered = 0;
    let checked = 0;
    for (const site of ["fineline", "ap"] as const) {
      const loaded = await loadSite(site);
      const { ctx } = await realCtx(site, { kind: "post", id: 0 });
      for (const post of loaded.model.posts.values()) {
        const terms = postData(ctx, post).terms as Record<string, { name: string }[]>;
        for (const [taxonomy, list] of Object.entries(terms)) {
          const names = list.map((t) => t.name);
          const sorted = [...names].sort((a, b) =>
            a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
          );
          expect(`${site} ${post.id} ${taxonomy}: ${names.join("|")}`).toBe(
            `${site} ${post.id} ${taxonomy}: ${sorted.join("|")}`,
          );
          if (names.length > 1) {
            checked++;
            const storedOrder = (loaded.model.termsByPost.get(post.id) ?? [])
              .map((id) => loaded.model.terms.get(id))
              .filter((t) => t?.taxonomy === taxonomy)
              .map((t) => decodeEntities(t?.name ?? ""));
            if (storedOrder.join("|") !== names.join("|")) reordered++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(reordered).toBeGreaterThan(10);
  });
});

describe("human_time_diff as WordPress 5.3 and later prints it", () => {
  test("every difference gives what the real function gave", () => {
    // From wp-includes/formatting.php of the live site's WordPress, run under PHP 8.3.
    const real: [number, string][] = [
      [1, "1 second"],
      [30, "30 seconds"],
      [59, "59 seconds"],
      [60, "1 minute"],
      [90, "2 minutes"],
      [300, "5 minutes"],
      [3599, "60 minutes"],
      [3600, "1 hour"],
      [5400, "2 hours"],
      [86399, "24 hours"],
      [86400, "1 day"],
      [129600, "2 days"],
      [604799, "7 days"],
      [604800, "1 week"],
      [2591999, "4 weeks"],
      [2592000, "1 month"],
      [31535999, "12 months"],
      [31536000, "1 year"],
      [63072000, "2 years"],
    ];
    for (const [seconds, want] of real) expect(humanTimeDiff(0, seconds * 1000)).toBe(want);
    expect(humanTimeDiff(0, 0)).toBe("1 second");
    expect(humanTimeDiff(5000, 0)).toBe("5 seconds");
  });
});

describe("a date field in an entry prints the day that was stored, in any zone", () => {
  const field = (type: string, extra: Record<string, unknown> = {}): AcfField => ({
    key: "field_x",
    postId: 0,
    name: "when",
    label: "When",
    type,
    required: false,
    instructions: "",
    menuOrder: 0,
    conditionalLogic: [],
    choices: [],
    multiple: false,
    subFields: [],
    layouts: [],
    settings: { return_format: "d/m/Y", ...extra },
  });

  async function zoned(zone: string): Promise<ConvertCtx> {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    return Object.assign(Object.create(ctx), {
      model: {
        ...ctx.model,
        options: new Map([...ctx.model.options, ["timezone_string", zone]]),
      },
    }) as ConvertCtx;
  }

  test("a date picker, stored as YYYY-MM-DD, is the same in static and entry mode west and east of Greenwich", async () => {
    for (const zone of [
      "America/New_York",
      "America/Los_Angeles",
      "UTC",
      "Asia/Kolkata",
      "Pacific/Auckland",
    ]) {
      const ctx = await zoned(zone);
      for (const day of ["2024-02-15", "2024-12-31", "2024-01-01", "2024-03-10"]) {
        for (const format of ["d/m/Y", "F j, Y", "l jS \\o\\f F"]) {
          const f = field("date_picker", { return_format: format });
          const stat = fieldText(ctx, f, { value: day });
          const entry = fieldText(ctx, f, { expr: "state.entry.data.when" });
          expect(stat && "lit" in stat).toBe(true);
          expect(entry && "expr" in entry).toBe(true);
          const got = evalTemplate(
            `\${${(entry as { expr: string }).expr}}`,
            entryScope({ when: day }),
          );
          expect(`${zone} ${day} ${format}: ${got}`).toBe(
            `${zone} ${day} ${format}: ${(stat as { lit: string }).lit}`,
          );
        }
      }
    }
    const ny = await zoned("America/New_York");
    const entry = fieldText(ny, field("date_picker"), { expr: "state.entry.data.when" });
    expect(
      evalTemplate(`\${${(entry as { expr: string }).expr}}`, entryScope({ when: "2024-02-15" })),
    ).toBe("15/02/2024");
    expect(evalTemplate(`\${${(entry as { expr: string }).expr}}`, entryScope({}))).toBe("");
  });

  test("a date-time picker, stored as the UTC instant, is read in the site's zone in both modes", async () => {
    for (const zone of ["America/New_York", "Asia/Kolkata", "UTC"]) {
      const ctx = await zoned(zone);
      for (const instant of ["2024-02-15T23:30:00Z", "2024-07-04T03:15:00Z"]) {
        const f = field("date_time_picker", { return_format: "d/m/Y g:i a" });
        const stat = fieldText(ctx, f, { value: instant }) as { lit: string };
        const entry = fieldText(ctx, f, { expr: "state.entry.data.when" }) as { expr: string };
        expect(evalTemplate(`\${${entry.expr}}`, entryScope({ when: instant }))).toBe(stat.lit);
      }
    }
  });
});

describe("a brace that starts with a WooCommerce word is code, not a token", () => {
  test("CSS and script keep their braces, and the real tokens are still dropped", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    for (const code of [
      ".a{width:100%}",
      ".a{height:10px;color:red}",
      "{description: x}",
      "if (a) {quantity++}",
      ".b{cart-icon:1}",
      ".c{price-tag:1}",
      "{length: 3}",
      "{variation-x}",
    ]) {
      expect(resolveTokens(code, ctx)).toBe(code);
    }
    expect(ctx.report.entries().filter((e) => e.code === "token.unresolved")).toEqual([]);
    expect(resolveTokens("a{price}b{width=5}c{cartitemname}d", ctx)).toBe("abcd");
    expect(ctx.report.entries().filter((e) => e.code === "token.unresolved")).toHaveLength(3);
    expect(isKnownToken("price")).toBe(true);
    expect(isKnownToken("pricey")).toBe(false);
  });
});

describe("the token scan", () => {
  /** `cc_parser`'s expression, as the plugin writes it. */
  const REGEX = /(?!\{\})\{(?!"|&quot;)(.*?)\}|<ccd>(.*?)<\/ccd>/g;

  test("finds exactly the tokens the plugin's regular expression finds, in every string of both sites", async () => {
    let strings = 0;
    for (const site of ["fineline", "ap"] as const) {
      const loaded = await loadSite(site);
      for (const sub of allSubjects(loaded)) {
        walkBlocks(subjectBlocks(loaded, sub), (b) => {
          const all = [b.innerHTML, JSON.stringify(b.attrs)];
          for (const text of all) {
            strings++;
            const want = [...text.matchAll(REGEX)]
              .filter((m) => (m[1] ?? m[2] ?? "") !== "")
              .map((m) => m[0]);
            expect(findTokens(text).map((t) => t.token)).toEqual(want);
          }
        });
      }
    }
    expect(strings).toBeGreaterThan(1000);
  });

  test("agrees with the expression on awkward text: empty braces, a quote after the brace, lines, an unclosed ccd", () => {
    for (const text of [
      '{}{a}{"b"}{&quot;c&quot;}{d}',
      "a{b\nc}d{e}f",
      "{a{b}c}",
      "<ccd>x</ccd><ccd>y",
      "<ccd></ccd>{x}",
      "{a\r}{b}",
      "{",
      "}",
      "{{}}",
      "x<ccd>a\nb</ccd>{c}",
    ]) {
      const want = [...text.matchAll(REGEX)]
        .filter((m) => (m[1] ?? m[2] ?? "") !== "")
        .map((m) => m[0]);
      expect(findTokens(text).map((t) => t.token)).toEqual(want);
    }
  });

  test("stays linear on braces that never close", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    const started = performance.now();
    for (const text of [
      "{a=".repeat(100_000),
      "{".repeat(300_000),
      "<ccd>".repeat(100_000),
      "{title".repeat(100_000),
      "{a\n".repeat(50_000),
    ]) {
      expect(resolveTokens(text, ctx)).toBe(text);
    }
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("a name that is not an identifier is written so that no brace is left bare", () => {
  test("propPath and optPath escape the key as a string literal", () => {
    for (const key of ["a}b", "a${b}", "a{b", "x y", "it's", "a\\b"]) {
      for (const path of [propPath("state.entry.data", key), optPath("state.entry.data", key)]) {
        expect(path).not.toMatch(/[{}$]/.test(key) ? /[{}$`]/ : /^$/);
        const probe = new Function("state", `return ${path}`)({ entry: { data: { [key]: 7 } } });
        expect(probe).toBe(7);
      }
    }
  });
});

describe("a literal value spliced into a tag's attribute cannot end the attribute", () => {
  test("an attachment's alt text with double quotes is one alt, through the markup road and the attribute road", async () => {
    const loaded = await loadSite("fineline");
    const quoted = [...loaded.model.attachments.values()].filter((a) => a.alt.includes('"'));
    expect(quoted.length).toBeGreaterThanOrEqual(5);
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    for (const att of quoted) {
      const media = ctx.mediaFor(att.id);
      if (!media) continue;
      const [img] = tokenNodes(`<img src="{image=${att.id}}" alt="{imagealt=${att.id}}">`, ctx) as {
        tagName: string;
        attributes?: Record<string, string>;
      }[];
      expect(Object.keys(img?.attributes ?? {}).sort()).toEqual(["alt", "src"]);
      expect(img?.attributes?.alt).toBe(media.alt);
      expect(blockImage(block("cwicly/image", { imageID: att.id }), ctx)?.alt).toBe(media.alt);
    }
  });

  test("a quote in a text value is not an attribute's, so wptexturize still curls it", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 8819 });
    expect(resolveTokens('<p>{sitetitle} says "hi"</p>', ctx, undefined, { where: "html" })).toBe(
      "<p>Anabaptist Perspectives says “hi”</p>",
    );
  });
});

describe("a derived context has the data of its own routes", () => {
  test("two contexts that differ only in urlFor do not share a post's entry data", async () => {
    const { ctx: a } = await realCtx("fineline", { kind: "part", slug: "header" });
    const b = Object.assign(Object.create(a), {
      urlFor: (kind: string, id: number) => `/other/${kind}/${id}/`,
    }) as ConvertCtx;
    const post = [...a.model.posts.values()].find(
      (p) => p.type === "page" && p.status === "publish",
    ) as WpPost;
    expect(a.urlFor("post", post.id)).toBeDefined();
    expect(postData(a, post).url).toBe(a.urlFor("post", post.id));
    expect(postData(b, post).url).toBe(`/other/post/${post.id}/`);
    expect(postFacts(b, post).url).toBe(`/other/post/${post.id}/`);
    // And the first context still has its own.
    expect(postData(a, post).url).toBe(a.urlFor("post", post.id));
  });
});

describe("an ACF field the way the plugin prints it", () => {
  const textField = (loaded: LoadedSite): AcfField =>
    loaded.acf.groups.flatMap((g) => g.fields).find((f) => f.name === "cta_title") as AcfField;

  /** The context of a post whose `cta_title` meta is `value`. */
  async function withMeta(value: unknown): Promise<{ ctx: ConvertCtx; field: AcfField }> {
    const loaded = await loadSite("fineline");
    const meta = new Map(loaded.model.postMeta);
    meta.set(3190, { ...meta.get(3190), cta_title: [value] });
    const { ctx } = await realCtx(
      "fineline",
      { kind: "post", id: 3190 },
      {
        model: { ...loaded.model, postMeta: meta },
      },
    );
    return { ctx, field: textField(loaded) };
  }

  test("a value of 0 is empty to `if ($field)`: the fallback, or nothing", async () => {
    for (const value of ["0", 0]) {
      const { ctx, field } = await withMeta(value);
      expect(resolveTokens(`{acffield=${field.key}=false=false=N/A}`, ctx)).toBe("N/A");
      expect(resolveTokens(`{acffield=${field.key}}`, ctx)).toBe("");
    }
    const { ctx, field } = await withMeta("7");
    expect(resolveTokens(`{acffield=${field.key}=false=false=N/A}`, ctx)).toBe("7");
    const entry = (
      await realCtx(
        "fineline",
        { kind: "template", slug: "single" },
        { mode: "entry", entryType: "post" },
      )
    ).ctx;
    const bound = resolveTokens(`{acffield=${field.key}=false=false=N/A}`, entry);
    for (const [value, want] of [
      ["0", "N/A"],
      [0, "N/A"],
      ["7", "7"],
      ["", "N/A"],
      [undefined, "N/A"],
    ] as const)
      expect(
        evalTemplate(bound, entryScope(value === undefined ? {} : { [field.name]: value })),
      ).toBe(want);
  });

  test("a textarea turns its line breaks the way its new_lines setting says, in both modes", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 3190 });
    const base = { ...(ctx.acf.groups[0]?.fields[0] as AcfField) };
    const mk = (new_lines: string): AcfField => ({
      ...base,
      type: "textarea",
      settings: { new_lines },
    });
    const text = "one\ntwo <b>";
    const br = fieldText(ctx, mk("br"), { value: text }) as { lit: string; html?: boolean };
    expect(br).toEqual({ lit: "one<br />\ntwo &lt;b&gt;", html: true });
    const entry = fieldText(ctx, mk("br"), { expr: "state.entry.data.t" }) as {
      expr: string;
      html?: boolean;
    };
    expect(entry.html).toBe(true);
    expect(evalTemplate(`\${${entry.expr}}`, entryScope({ t: text }))).toBe(br.lit);
    expect(fieldText(ctx, mk("wpautop"), { value: text })).toEqual({
      lit: php.wpautop(text),
      html: true,
    });
    // The pilot's plugin (1.4.7) prints a stored text as it is, markup included.
    expect(fieldText(ctx, mk(""), { value: text })).toEqual({ lit: text, html: true });
    const escaping = { ...ctx, cwicly: { ...ctx.cwicly, version: "1.6.0" } };
    expect(fieldText(escaping, mk(""), { value: text })).toEqual({ lit: text, html: false });
  });
});

describe("a text value the plugin prints raw", () => {
  test("printsAcfRaw: a data format before 1.6.0 is the plugin that did not escape; none or newer is the one that does", () => {
    const at = (version: string | undefined) => printsAcfRaw({ cwicly: { version } as never });
    expect([at("1.4.7"), at("1.5.0"), at("1.5.12"), at("0.9.0")]).toEqual([true, true, true, true]);
    expect([at("1.6.0"), at("1.10.2"), at("2.0.0"), at(undefined), at("")]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  test("a term's text field holding a link keeps the link: straight quotes in the tag, the text turned, and a binding that prints markup", async () => {
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      { mode: "entry", entryType: "project" },
    );
    const term = [...loaded.model.terms.values()].find(
      (t) =>
        t.taxonomy === "location" &&
        Object.values(t.meta).some((v) => typeof v === "string" && /<a href="/.test(v)),
    );
    expect(term).toBeDefined();
    const data = termData(ctx, term!);
    const withLinks = Object.entries(data).filter(
      ([, v]) => typeof v === "string" && v.includes("<a href"),
    );
    expect(withLinks.length).toBeGreaterThan(0);
    for (const [, v] of withLinks) {
      // The tag's attributes are not text: no curly quote may reach them.
      expect(v as string).not.toMatch(/<a href=[\u201c\u201d]/);
      expect(v as string).toMatch(/<a href="https?:\/\/[^"]+">/);
    }
    const escaping = { ...ctx, cwicly: { ...ctx.cwicly, version: "1.6.0" } };
    // The binding of a text field is markup, so that the link is a link.
    const field = Object.keys(data).find(
      (k) => typeof data[k] === "string" && data[k].includes("<a href"),
    )!;
    const group = ctx.acf.groups.flatMap((g) => g.fields).find((f) => f.name === field);
    expect(group).toBeDefined();
    const bound = fieldText(ctx, group!, { expr: `state.term.data.${field}` }) as {
      html?: boolean;
    };
    expect(bound.html).toBe(true);
    expect(
      (fieldText(escaping, group!, { expr: `state.term.data.${field}` }) as { html?: boolean })
        .html,
    ).toBeFalsy();
  });
});

describe("every ACF field type, static against entry", () => {
  const base: AcfField = {
    key: "field_x",
    postId: 0,
    name: "v",
    label: "V",
    type: "text",
    required: false,
    instructions: "",
    menuOrder: 0,
    conditionalLogic: [],
    choices: [],
    multiple: false,
    subFields: [],
    layouts: [],
    settings: {},
  };
  const choices = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo" },
  ];
  /** [field, the value the entry holds, what is printed]. */
  const cases: [Partial<AcfField>, unknown, string][] = [
    [{ type: "text" }, "Hi there", "Hi there"],
    [{ type: "number" }, 19.9, "19.9"],
    [{ type: "range" }, 3, "3"],
    [{ type: "email" }, "a@b.co", "a@b.co"],
    [{ type: "url" }, "https://example.com/a?b=1", "https://example.com/a?b=1"],
    [{ type: "color_picker" }, "#ff0000", "#ff0000"],
    [{ type: "time_picker" }, "09:30:00", "09:30:00"],
    [{ type: "textarea" }, "one\ntwo", "one\ntwo"],
    [{ type: "true_false" }, true, "1"],
    [{ type: "true_false" }, false, ""],
    [{ type: "select", choices, returnFormat: "value" }, "a", "a"],
    [{ type: "select", choices, returnFormat: "label" }, "a", "Alpha"],
    [{ type: "radio", choices, returnFormat: "label" }, "b", "Bravo"],
    [{ type: "button_group", choices, returnFormat: "value" }, "b", "b"],
    [{ type: "select", choices, returnFormat: "label", multiple: true }, ["a", "b"], "Alpha,Bravo"],
    [{ type: "checkbox", choices, returnFormat: "value", multiple: true }, ["a", "b"], "a,b"],
    [{ type: "checkbox", choices, returnFormat: "label", multiple: true }, ["b"], "Bravo"],
    [{ type: "image" }, { src: "/media/a.jpg", width: 1, height: 2, alt: "x" }, "/media/a.jpg"],
    [{ type: "file" }, { src: "/media/a.pdf" }, "/media/a.pdf"],
    [{ type: "link" }, { url: "/about/", title: "About", target: "" }, "/about/"],
    [{ type: "gallery" }, [{ src: "/a.jpg" }, { src: "/b.jpg" }], "/a.jpg,/b.jpg"],
    [{ type: "post_object" }, { id: 4, slug: "s", title: "T", url: "/s/" }, "/s/"],
    [
      { type: "post_object" },
      [
        { id: 4, slug: "s", title: "T", url: "/s/" },
        { id: 5, slug: "t", title: "U", url: "/t/" },
      ],
      "4,5",
    ],
    [
      { type: "relationship" },
      [
        { id: 7, slug: "a", title: "A", url: "/a/" },
        { id: 8, slug: "b", title: "B", url: "/b/" },
      ],
      "7,8",
    ],
    [{ type: "taxonomy" }, [{ id: 3, slug: "c", title: "C", url: "/c/" }], "3"],
    [{ type: "user" }, [{ id: 2, slug: "u", title: "U", url: "" }], "2"],
    [{ type: "page_link" }, { id: 4, slug: "s", title: "T", url: "/s/" }, "/s/"],
    [{ type: "google_map" }, { lat: 1, lng: 2 }, ""],
    [{ type: "icon_picker" }, { type: "dashicons", value: "x" }, ""],
  ];

  test("each type prints the same from a stored value and from the entry binding", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    for (const [extra, value, want] of cases) {
      const f = { ...base, ...extra } as AcfField;
      const stat = fieldText(ctx, f, { value }) as { lit: string; html?: boolean };
      const entry = fieldText(ctx, f, { expr: "state.entry.data.v" }) as Val;
      const printed = (state: unknown): string =>
        "expr" in entry ? evalTemplate(`\${${entry.expr}}`, state) : entry.lit;
      const label = `${f.type} ${JSON.stringify(value)}`;
      expect(`${label} static: ${stat.lit}`).toBe(`${label} static: ${want}`);
      expect(`${label} entry: ${printed(entryScope({ v: value }))}`).toBe(
        `${label} entry: ${want}`,
      );
      expect(!!entry.html).toBe(!!stat.html);
      // An entry that holds nothing prints nothing.
      expect(printed(entryScope({}))).toBe("");
    }
  });

  test("a wysiwyg field is markup: a static page runs it through wpautop, and the entry holds the paragraphs", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    const f = { ...base, type: "wysiwyg" } as AcfField;
    const raw = "One line\n\nTwo <b>lines</b>";
    const stat = fieldText(ctx, f, { value: raw }) as { lit: string; html?: boolean };
    const entry = fieldText(ctx, f, { expr: "state.entry.data.v" }) as {
      expr: string;
      html?: boolean;
    };
    expect(stat).toEqual({ lit: php.wpautop(raw), html: true });
    expect(entry.html).toBe(true);
    expect(evalTemplate(`\${${entry.expr}}`, entryScope({ v: php.wpautop(raw) }))).toBe(stat.lit);
  });
});

describe("the site's clock and name", () => {
  const siteWith = async (
    options: [string, string][],
    site: Record<string, string> = {},
  ): Promise<ConvertCtx> => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    return Object.assign(Object.create(ctx), {
      model: {
        ...ctx.model,
        site: { ...ctx.model.site, ...site },
        options: new Map([
          ...ctx.model.options,
          ["timezone_string", ""],
          ["gmt_offset", "0"],
          ...options,
        ]),
      },
    }) as ConvertCtx;
  };

  test("a zone is a name, else the offset with its sign, else UTC", async () => {
    expect(siteZone(await siteWith([["timezone_string", "Europe/Paris"]]))).toBe("Europe/Paris");
    expect(siteZone(await siteWith([["gmt_offset", "5.5"]]))).toBe("+05:30");
    expect(siteZone(await siteWith([["gmt_offset", "-3.5"]]))).toBe("-03:30");
    expect(siteZone(await siteWith([["gmt_offset", "0"]]))).toBe("UTC");
    expect(
      siteZone(
        await siteWith([
          ["timezone_string", "Not/AZone"],
          ["gmt_offset", "2"],
        ]),
      ),
    ).toBe("+02:00");
    const east = await siteWith([["gmt_offset", "5.5"]]);
    const west = await siteWith([["gmt_offset", "-3.5"]]);
    expect(formatDate(east, "Y-m-d H:i", Date.UTC(2024, 0, 1, 0, 0))).toBe("2024-01-01 05:30");
    expect(formatDate(west, "Y-m-d H:i", Date.UTC(2024, 0, 1, 0, 0))).toBe("2023-12-31 20:30");
    const expr = dateExpr(west, "Y-m-d H:i", jsString("2024-01-01T00:00:00Z")).expr;
    expect(new Function(`return ${expr}`)()).toBe("2023-12-31 20:30");
  });

  test("the site's title and tagline are text, not the entities they are stored as", async () => {
    const ctx = await siteWith([], {
      name: "Fish &amp; Chips &#8211; Lancaster",
      description: "Cod &amp; haddock",
    });
    expect(resolveTokens("{sitetitle}|{sitetagline}", ctx)).toBe(
      "Fish & Chips – Lancaster|Cod & haddock",
    );
  });
});

describe("an entry prints an ACF text field as WordPress prints it", () => {
  test("the cta title and the about text of the real fineline posts, in an entry and on a static page", async () => {
    const loaded = await loadSite("fineline");
    const fields = loaded.acf.groups.flatMap((g) => g.fields);
    const title = fields.find((f) => f.name === "cta_title") as AcfField;
    const about = fields.find((f) => f.name === "about") as AcfField;
    expect([title.type, about.type]).toEqual(["text", "textarea"]);
    const entry = (
      await realCtx(
        "fineline",
        { kind: "template", slug: "single" },
        { mode: "entry", entryType: "post" },
      )
    ).ctx;
    let curled = 0;
    for (const [id, field] of [
      [3190, title],
      [3193, title],
      [6286, about],
    ] as const) {
      const post = loaded.model.posts.get(id) as WpPost;
      const { ctx } = await realCtx("fineline", { kind: "post", id });
      const token = `{acffield=${field.key}}`;
      const stat = resolveTokens(token, ctx, undefined, { where: "html" });
      const bound = resolveTokens(token, entry, undefined, { where: "html" });
      const printed = evalTemplate(bound, entryScope(postData(ctx, post)));
      expect(printed).toBe(stat);
      // What is stored has a straight quote where the live page prints a curly one.
      const stored = String(postFacts(ctx, post)[field.name] ?? "");
      if (/['"]/.test(stored)) {
        expect(printed).not.toBe(escapeHtml(stored));
        curled++;
      }
    }
    expect(curled).toBeGreaterThanOrEqual(2);
  });
});

describe("the small helpers", () => {
  test("a Cwicly date or time format is a number, `default` or a custom PHP format", () => {
    expect(cwiclyFormat("date", "default", "")).toBe("F j, Y");
    expect(cwiclyFormat("date", "4", "")).toBe("d/m/Y");
    expect(cwiclyFormat("date", "custom", "jS M")).toBe("jS M");
    expect(cwiclyFormat("time", "3", "")).toBe("H:i");
    expect(cwiclyFormat("date", "99", "")).toBe("");
  });

  test("a value or a fallback: the first when it is not empty, a binding keeps the fallback beside it, markup wins over text", () => {
    expect(orElse(undefined, litV("b"))).toEqual(litV("b"));
    expect(orElse(litV("a"), undefined)).toEqual(litV("a"));
    expect(orElse(litV("a"), litV("b"))).toEqual(litV("a"));
    expect(orElse(litV(""), litV("b"))).toEqual(litV("b"));
    expect(orElse(exprV("x"), litV("b"))).toEqual({ expr: "(x) || 'b'", html: false });
    const html = orElse(exprV("x", true), litV("<b>"));
    expect(html).toEqual({ expr: "(x) || '&lt;b&gt;'", html: true });
    const mixed = orElse(exprV("x"), litV("a", true));
    expect((mixed as { html: boolean }).html).toBe(true);
    expect((mixed as { expr: string }).expr).toContain("String((x) ?? '')");
  });

  test("the excerpt of a post is its own, else the text blocks of its content, and nothing for a post with neither", () => {
    const post = (excerpt: string, content: string): WpPost =>
      ({ excerpt, content }) as unknown as WpPost;
    expect(
      excerptOf(post("Own words", "<!-- wp:paragraph --><p>Other</p><!-- /wp:paragraph -->")),
    ).toBe("Own words");
    expect(excerptOf(post("", ""))).toBe("");
    const made = excerptOf(
      post(
        "",
        '<!-- wp:cwicly/heading {"content":"Title"} --><h2>Title</h2><!-- /wp:cwicly/heading --><!-- wp:cwicly/paragraph --><p>Body text</p><!-- /wp:cwicly/paragraph -->',
      ),
    );
    expect(made).toContain("Body text");
    expect(made).toContain("Title");
  });
});

// END OF PART 7
