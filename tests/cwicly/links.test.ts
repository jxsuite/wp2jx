/**
 * Cwicly's link wrapper: where a block's link goes, what it does besides, and which element carries it.
 *
 * Every link-wrapped block of both sites is read two ways, from its attributes (`blockLink`) and from
 * its saved markup (where the editor wrote the same destination as a token, resolved by tokens.ts), and
 * the two must agree. The live pages stand behind both.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse, parseFragment } from "parse5";
import { allSubjects, loadSite, makeCtx, subjectBlocks } from "../helpers/ctx.ts";
import type { LoadedSite, SiteName, Subject } from "../helpers/ctx.ts";
import { buildRoutes, createUrlTools } from "../../src/routes.ts";
import { walkBlocks } from "../../src/wp/blocks.ts";
import type { ConvertCtx, WpBlock, WpModel, WpPost } from "../../src/types.ts";
import { blockLink } from "../../src/cwicly/links.ts";
import { postData, resolveTokens, termData } from "../../src/cwicly/tokens.ts";

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

function evalTemplate(template: string, state: unknown, map: unknown = undefined): string {
  if (!template.includes("${")) return template;
  const fn = new Function("state", "$map", `return \`${template}\``) as (
    s: unknown,
    m: unknown,
  ) => string;
  return fn(state, map);
}

const walkN = (n: N, f: (n: N) => void): void => {
  f(n);
  for (const c of n.childNodes ?? []) walkN(c, f);
  if (n.content) walkN(n.content, f);
};
const attrsOf = (n: N): Record<string, string> =>
  Object.fromEntries((n.attrs ?? []).map((a) => [a.name, a.value]));

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

const link = (attrs: Record<string, unknown>, name = "cwicly/button"): WpBlock =>
  block(name, { linkWrapperActive: true, ...attrs });

// ── Static links ─────────────────────────────────────────────────────────────────────────────────

describe("a link to an address", () => {
  test("an internal address is a path of the converted site, an external one is kept, a scheme is kept", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    expect(
      blockLink(link({ linkWrapperUrl: "https://finelinepainting.pro/about-us/" }), ctx),
    ).toMatchObject({
      href: ctx.rewriteUrl("https://finelinepainting.pro/about-us/"),
      anchor: "self",
      bound: false,
    });
    expect(blockLink(link({ linkWrapperUrl: "/" }), ctx)?.href).toBe("/");
    expect(blockLink(link({ linkWrapperUrl: "tel:7172286606" }), ctx)?.href).toBe("tel:7172286606");
    expect(blockLink(link({ linkWrapperUrl: "mailto:a@b.co" }), ctx)?.href).toBe("mailto:a@b.co");
    expect(
      blockLink(link({ linkWrapperUrl: "https://www.google.com/maps/place/x?a=1&b=2" }), ctx)?.href,
    ).toBe("https://www.google.com/maps/place/x?a=1&b=2");
    expect(blockLink(link({ linkWrapperUrl: "https://maps.app.goo.gl/abc" }), ctx)?.href).toBe(
      "https://maps.app.goo.gl/abc",
    );
  });

  test("a link with no address and no object has no destination, and says so", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    const spec = blockLink(link({}), ctx);
    expect(spec?.href).toBeUndefined();
    expect(spec?.unresolved).toBe("the link names no address");
    expect(ctx.report.entries().map((e) => e.code)).toEqual(["link.unresolved"]);
  });

  test("a new tab is a target and noopener, added to a rel the block already has", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    const base = { linkWrapperUrl: "https://example.com/", linkWrapperNewTab: true };
    expect(blockLink(link(base), ctx)).toMatchObject({ target: "_blank", rel: "noopener" });
    expect(blockLink(link({ ...base, linkWrapperRel: "nofollow" }), ctx)?.rel).toBe(
      "nofollow noopener",
    );
    expect(blockLink(link({ ...base, linkWrapperRel: "noopener noreferrer" }), ctx)?.rel).toBe(
      "noopener noreferrer",
    );
    expect(
      blockLink(link({ linkWrapperUrl: "https://example.com/", linkWrapperRel: "sponsored" }), ctx),
    ).toMatchObject({ rel: "sponsored" });
    expect(blockLink(link({ linkWrapperUrl: "/x" }), ctx)).not.toHaveProperty("target");
    const labelled = blockLink(
      link({ linkWrapperUrl: "/x", linkWrapperTitle: "Title", linkWrapperAriaLabel: "Label" }),
      ctx,
    );
    expect(labelled).toMatchObject({ title: "Title", ariaLabel: "Label" });
  });

  test("a block that is not a link has none", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    expect(blockLink(block("cwicly/button", { linkWrapperUrl: "/x" }), ctx)).toBeUndefined();
    expect(blockLink(block("cwicly/button", {}), ctx)).toBeUndefined();
  });
});

describe("a link to a post or a term", () => {
  test("the object is the routes module's address for it, and wins over the address stored beside it", async () => {
    const button = await blockOf("fineline", { kind: "post", id: 195 }, "button-c9d3470");
    const { ctx } = await realCtx("fineline", { kind: "post", id: 195 });
    expect(button.attrs.linkWrapperStaticObject).toEqual({
      id: 1013,
      kind: "post-type",
      type: "page",
    });
    expect(blockLink(button, ctx)?.href).toBe(ctx.urlFor("post", 1013));
    expect(ctx.urlFor("post", 1013)).toBe("/quote/");
    const service = await blockOf("fineline", { kind: "post", id: 5246 }, "div-c4fc01f");
    expect(blockLink(service, ctx)?.href).toBe(ctx.urlFor("post", 5282));
  });

  test("a term, by type or by kind", async () => {
    const { ctx, loaded } = await realCtx("fineline", { kind: "post", id: 5246 });
    const term = [...loaded.model.terms.values()].find(
      (t) => t.taxonomy === "location" && ctx.urlFor("term", t.termId),
    ) as NonNullable<ReturnType<typeof loaded.model.terms.get>>;
    const want = ctx.urlFor("term", term.termId);
    expect(
      blockLink(
        link({
          linkWrapperStaticObject: { id: term.termId, type: "taxonomy", kind: "taxonomy" },
          linkWrapperUrl: "https://x/",
        }),
        ctx,
      )?.href,
    ).toBe(want);
    expect(
      blockLink(
        link({
          linkWrapperStaticObject: { id: term.termId, kind: "taxonomy" },
          linkWrapperUrl: "https://x/",
        }),
        ctx,
      )?.href,
    ).toBe(want);
  });

  test("an object that is not on the converted site falls back to the stored address, reported; with no address, it is unresolved", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    const dangling = { linkWrapperStaticObject: { id: 482, kind: "post-type", type: "page" } };
    const repaired = blockLink(
      link({ ...dangling, linkWrapperUrl: "https://finelinepainting.pro/quote/" }),
      ctx,
    );
    expect(repaired?.href).toBe(ctx.rewriteUrl("https://finelinepainting.pro/quote/"));
    expect(repaired?.unresolved).toBeUndefined();
    const lost = blockLink(link(dangling), ctx);
    expect(lost?.href).toBeUndefined();
    expect(lost?.unresolved).toContain("482");
    const entries = ctx.report.entries().filter((e) => e.code === "link.unresolved");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ severity: "warn", where: "post:5246" });
  });
});

describe("a dynamic link", () => {
  test("to the current post: its address on a static page, a binding in an entry", async () => {
    const heading = await blockOf("fineline", { kind: "post", id: 1078 }, "heading-c235f2d");
    const stat = (await realCtx("fineline", { kind: "post", id: 1078 }, { mode: "static" })).ctx;
    expect(blockLink(heading, stat)).toMatchObject({
      href: stat.urlFor("post", 1078),
      anchor: "inner",
      bound: false,
    });
    const entry = (
      await realCtx(
        "fineline",
        { kind: "template", slug: "single-project" },
        { mode: "entry", entryType: "project" },
      )
    ).ctx;
    const bound = blockLink(heading, entry);
    expect(bound).toMatchObject({ href: "${state.entry.data.url ?? ''}", bound: true });
    expect(evalTemplate(bound?.href ?? "", { entry: { data: { url: "/project/x/" } } })).toBe(
      "/project/x/",
    );
  });

  test("the site's addresses, the post type's archive and the featured image", async () => {
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "post", id: 1078 },
      { mode: "static" },
    );
    const dyn = (source: string): string | undefined =>
      blockLink(link({ linkWrapperSourceType: "dynamic", linkWrapperSourceDynamic: source }), ctx)
        ?.href;
    expect(dyn("homeurl")).toBe("/");
    expect(dyn("siteurl")).toBe("/");
    expect(dyn("archiveurl")).toBe("/projects/");
    expect(dyn("postarchiveurl")).toBe("/projects/");
    expect(dyn("featuredimage")).toBe(
      (postData(ctx, loaded.model.posts.get(1078) as WpPost).featuredImage as { src: string }).src,
    );
  });

  test("an author's page is the routes module's", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 773 }, { mode: "static" });
    const href = blockLink(
      link({ linkWrapperSourceType: "dynamic", linkWrapperSourceDynamic: "authorurl" }),
      ctx,
    )?.href;
    expect(href).toMatch(/^\/people\/[a-z-]+\/$/);
    const entry = (
      await realCtx(
        "ap",
        { kind: "template", slug: "single-post" },
        { mode: "entry", entryType: "post" },
      )
    ).ctx;
    expect(
      blockLink(
        link({ linkWrapperSourceType: "dynamic", linkWrapperSourceDynamic: "authorurl" }),
        entry,
      )?.href,
    ).toBe("${state.entry.data.authorUrl ?? ''}");
  });

  test("a term in a loop is the loop item's address", async () => {
    const { ctx } = await realCtx(
      "fineline",
      { kind: "template", slug: "taxonomy-project_type" },
      { mode: "entry", termExpr: "$map.item" },
    );
    expect(
      blockLink(
        link({ linkWrapperSourceType: "dynamic", linkWrapperSourceDynamic: "taxonomytermsurl" }),
        ctx,
      )?.href,
    ).toBe("${$map.item.url ?? ''}");
  });

  test("an ACF field: a link field's address, a url field's text, with the entry binding the field", async () => {
    const button = await blockOf(
      "fineline",
      { kind: "template", slug: "single" },
      "button-c694bd8",
    );
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "single" },
      { mode: "entry", entryType: "post" },
    );
    const field = loaded.acf.groups
      .flatMap((g) => g.fields)
      .find((f) => f.key === button.attrs.linkWrapperAcfFields);
    expect(field).toBeDefined();
    const spec = blockLink(button, ctx);
    expect(spec?.bound).toBe(true);
    expect(spec?.href).toContain(`state.entry.data.${field?.name}`);
    expect(evalTemplate(spec?.href ?? "", { entry: { data: {} } })).toBe("false");
    // On a static page the same field is the page's own value.
    const post = [...loaded.model.posts.values()].find(
      (p) =>
        p.type === "post" &&
        p.status === "publish" &&
        typeof postData(ctx, p)[field?.name as string] === "string" &&
        postData(ctx, p)[field?.name as string] !== "",
    ) as WpPost | undefined;
    if (post) {
      const stat = (await realCtx("fineline", { kind: "post", id: post.id }, { mode: "static" }))
        .ctx;
      expect(blockLink(button, stat)?.href).toBe(
        postData(stat, post)[field?.name as string] as string,
      );
    }
  });

  test("a source with no value on the converted site is unresolved and reported", async () => {
    const { ctx } = await realCtx("ap", { kind: "part", slug: "footer" }, { mode: "static" });
    for (const source of [
      "loginurl",
      "directlogout",
      "previouspost",
      "nextpost",
      "commentreplyurl",
      "editcommenturl",
      "commentcancelreply",
      "userqueryurl",
      "taxonomyqueryurl",
      "shortcode",
      "whatever",
    ]) {
      const spec = blockLink(
        link({ linkWrapperSourceType: "dynamic", linkWrapperSourceDynamic: source }),
        ctx,
      );
      expect(spec?.href).toBeUndefined();
      expect(spec?.unresolved).toBeDefined();
    }
    const codes = new Set(ctx.report.entries().map((e) => e.code));
    expect(codes.has("link.unresolved")).toBe(true);
    for (const e of ctx.report.entries()) expect(e.where).toBe(`template:${ctx.subject.id}`);
  });
});

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────

describe("an action", () => {
  const act = (attrs: Record<string, unknown>, name = "cwicly/button"): WpBlock =>
    link({ linkWrapperType: "action", ...attrs }, name);

  test("a modal opener, closer and toggle become popover triggers, with no address of their own", async () => {
    const { ctx } = await realCtx("ap", { kind: "part", slug: "header" });
    for (const mode of ["open", "close", "toggle"] as const) {
      const spec = blockLink(
        act({
          linkWrapperAction: "modal",
          linkWrapperActionModalBlockId: "modal-topics",
          linkWrapperActionModalType: mode,
        }),
        ctx,
      );
      expect(spec).toEqual({
        action: { kind: "modal", mode, target: "modal-topics" },
        anchor: "self",
        bound: false,
      });
    }
    expect(blockLink(act({ linkWrapperAction: "modal" }), ctx)?.unresolved).toContain(
      "names no modal",
    );
    const reports = ctx.report.entries();
    expect(reports.filter((e) => e.code === "link.approximated")).toHaveLength(1);
    expect(reports.filter((e) => e.code === "link.unsupported")).toHaveLength(1);
  });

  test("the real modal links of anabaptistperspectives", async () => {
    const open = await blockOf("ap", { kind: "post", id: 1417 }, "paragraph-c26c980");
    const close = await blockOf("ap", { kind: "post", id: 1417 }, "div-c6579f0");
    const { ctx } = await realCtx("ap", { kind: "post", id: 1417 });
    expect(blockLink(open, ctx)).toMatchObject({
      action: { kind: "modal", mode: "open", target: "modal-topics" },
      anchor: "self",
    });
    expect(blockLink(close, ctx)).toMatchObject({
      action: { kind: "modal", mode: "close", target: "modal-topics" },
    });
  });

  test("popovers, scrolling to the top, a dark mode switch", async () => {
    const { ctx } = await realCtx("ap", { kind: "part", slug: "header" });
    expect(
      blockLink(act({ linkWrapperAction: "togglePopover", linkWrapperActionPopoverID: "p1" }), ctx)
        ?.action,
    ).toEqual({ kind: "popover", mode: "toggle", target: "p1" });
    expect(
      blockLink(
        act({ linkWrapperAction: "showHidePopover", linkWrapperActionPopoverID: "p1" }),
        ctx,
      )?.action,
    ).toEqual({ kind: "popover", mode: "showHide", target: "p1" });
    expect(blockLink(act({ linkWrapperAction: "scrolltotop" }), ctx)).toMatchObject({
      href: "#",
      action: { kind: "scroll", to: "top" },
    });
    const dark = blockLink(act({ linkWrapperAction: "toggleDarkMode" }), ctx);
    expect(dark).toMatchObject({
      action: { kind: "darkmode" },
      unresolved: expect.stringContaining("dark mode"),
    });
    expect(dark?.href).toBeUndefined();
  });

  test("a menu's toggles belong to the menu converter", async () => {
    const { ctx } = await realCtx("ap", { kind: "part", slug: "header" });
    const spec = blockLink(
      act({ linkWrapperAction: "toggleNav", linkWrapperActionNavID: "nav-1" }),
      ctx,
    );
    expect(spec?.action).toEqual({ kind: "nav", mode: "toggle", target: "nav-1" });
    expect(spec?.unresolved).toContain("menu converter");
  });

  test("a share link carries the page's absolute address, encoded", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 3371 }, { mode: "static" });
    const page = encodeURIComponent(
      "https://finelinepainting.pro/choosing-the-best-log-home-stain/",
    );
    const share = (network: string, extra: Record<string, unknown> = {}): string | undefined =>
      blockLink(
        act({
          linkWrapperAction: "share",
          linkWrapperShare: network,
          linkWrapperShareDescription: "Read this & more",
          ...extra,
        }),
        ctx,
      )?.href;
    expect(share("twitter")).toBe(
      `https://twitter.com/intent/tweet?url=${page}&text=Read%20this%20%26%20more`,
    );
    expect(share("facebook")).toBe(`https://www.facebook.com/sharer.php?u=${page}`);
    expect(share("linkedin")).toBe(
      `https://www.linkedin.com/shareArticle?url=${page}&title=Read%20this%20%26%20more`,
    );
    expect(share("pinterest")).toContain(`url=${page}&media=`);
    expect(share("reddit")).toContain(`submit?url=${page}`);
    expect(share("whatsapp")).toBe(`https://wa.me/?text=${page}`);
    expect(share("email", { linkWrapperActionContactEmailAddress: "a@b.co" })).toBe(
      `mailto:a@b.co?subject=Read%20this%20%26%20more&body=${page}`,
    );
    expect(
      blockLink(act({ linkWrapperAction: "share", linkWrapperShare: "twitter" }), ctx)?.action,
    ).toEqual({ kind: "share", network: "twitter" });
    expect(share("unknown")).toBeUndefined();
  });

  test("a share link in an entry binds the entry's address", async () => {
    const { ctx } = await realCtx(
      "fineline",
      { kind: "template", slug: "single" },
      { mode: "entry", entryType: "post" },
    );
    const href =
      blockLink(act({ linkWrapperAction: "share", linkWrapperShare: "facebook" }), ctx)?.href ?? "";
    expect(evalTemplate(href, { entry: { data: { url: "/post/x/" } } })).toBe(
      `https://www.facebook.com/sharer.php?u=${encodeURIComponent("https://finelinepainting.pro/post/x/")}`,
    );
  });

  test("contact actions: mail, phone, messaging apps", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    const contact = (type: string, extra: Record<string, unknown> = {}): string | undefined =>
      blockLink(
        act({ linkWrapperAction: "contact", linkWrapperActionContactType: type, ...extra }),
        ctx,
      )?.href;
    expect(
      contact("email", {
        linkWrapperActionContactEmailAddress: "a@b.co",
        linkWrapperActionContactEmailSubject: "Hi there",
        linkWrapperActionContactEmailMessage: "Body & text",
      }),
    ).toBe("mailto:a@b.co?subject=Hi%20there&body=Body%20%26%20text");
    expect(contact("tel", { linkWrapperActionContactOneLine: "7172286606" })).toBe(
      "tel:7172286606",
    );
    expect(contact("sms", { linkWrapperActionContactOneLine: "7172286606" })).toBe(
      "sms:7172286606",
    );
    expect(contact("whatsapp", { linkWrapperActionContactOneLine: "1555" })).toBe(
      "https://api.whatsapp.com/send?phone=1555",
    );
    expect(contact("messenger", { linkWrapperActionContactOneLine: "page" })).toBe(
      "https://m.me/page",
    );
    expect(
      contact("skype", {
        linkWrapperActionContactOneLine: "me",
        linkWrapperActionContactSkype: "call",
      }),
    ).toBe("skype:me?call");
    expect(contact("waze", { linkWrapperActionContactOneLine: "1,2" })).toBe(
      "https://www.waze.com/ul?ll=1,2",
    );
    expect(contact("tel")).toBeUndefined();
    expect(contact("carrier-pigeon")).toBeUndefined();
  });

  test("a lightbox is a plain link to its image or video, and says what it was", async () => {
    const { ctx, loaded } = await realCtx("ap", { kind: "post", id: 1417 });
    const video = await blockOf("ap", { kind: "post", id: 1417 }, "paragraph-ceef3d1");
    // The live page prints `target="_blank" rel="noopener"` on it: Rank Math's external-link filter.
    expect(blockLink(video, ctx)).toEqual({
      href: "https://www.youtube.com/watch?v=k9B7LYW_BjI",
      target: "_blank",
      rel: "noopener",
      action: { kind: "lightbox", media: "video", gallery: "about-video" },
      anchor: "self",
      bound: false,
    });
    const url = [...loaded.model.attachments.values()].find((a) => loaded.media.mediaFor(a.id))
      ?.url as string;
    const image = blockLink(
      act({
        linkWrapperAction: "lightbox",
        linkWrapperActionLighboxType: "image",
        linkWrapperActionLighboxSourceType: "static",
        linkWrapperActionLighboxURL: url,
        linkWrapperActionLighboxCaption: "A caption",
      }),
      ctx,
    );
    expect(image?.href).toBe(loaded.media.mediaForUrl(url)?.src);
    expect(image?.action).toEqual({ kind: "lightbox", media: "image", caption: "A caption" });
    expect(
      ctx.report
        .entries()
        .some((e) => e.code === "link.approximated" && e.message.includes("lightbox")),
    ).toBe(true);
  });

  test("a dynamic lightbox reads the featured image or an ACF field", async () => {
    const stat = (await realCtx("fineline", { kind: "post", id: 1078 }, { mode: "static" })).ctx;
    const feat = (
      postData(stat, stat.model.posts.get(1078) as WpPost).featuredImage as { src: string }
    ).src;
    const dyn = (attrs: Record<string, unknown>): string | undefined =>
      blockLink(
        act({
          linkWrapperAction: "lightbox",
          linkWrapperActionLighboxSourceType: "dynamic",
          ...attrs,
        }),
        stat,
      )?.href;
    expect(dyn({ linkWrapperActionLighboxSourceDynamic: "featuredimage" })).toBe(feat);
    expect(dyn({ linkWrapperActionLighboxSourceDynamic: "woocommerce" })).toBeUndefined();
    expect(stat.report.entries().some((e) => e.code === "link.unsupported")).toBe(true);
  });

  test("a query's pagination, a slider, a filter and a shop have no static equivalent", async () => {
    const { ctx } = await realCtx("ap", { kind: "part", slug: "header" });
    const cases: [Record<string, unknown>, unknown][] = [
      [{ linkWrapperAction: "prevQuery" }, { kind: "query", mode: "previous" }],
      [{ linkWrapperAction: "nextQuery" }, { kind: "query", mode: "next" }],
      [{ linkWrapperAction: "infiniteButtonLoad" }, { kind: "query", mode: "load-more" }],
      [
        {
          linkWrapperAction: "slider",
          linkWrapperActionSliderType: "gotoindex",
          linkWrapperActionSliderID: "s",
          linkWrapperActionSliderGoTo: 2,
        },
        { kind: "slider", mode: "gotoindex", target: "s", index: 2 },
      ],
      [{ linkWrapperAction: "filter" }, { kind: "filter" }],
      [{ linkWrapperAction: "wooaddtocart" }, { kind: "shop", action: "wooaddtocart" }],
    ];
    for (const [attrs, action] of cases) {
      const spec = blockLink(act(attrs), ctx);
      expect(spec?.action).toEqual(action as NonNullable<typeof spec>["action"]);
      expect(spec?.href).toBeUndefined();
      expect(spec?.unresolved).toBeDefined();
    }
    expect(blockLink(act({ linkWrapperAction: "mystery" }), ctx)?.unresolved).toContain(
      "not one Cwicly documents",
    );
    expect(ctx.report.entries().filter((e) => e.code === "link.unsupported")).toHaveLength(7);
  });

  test("the real load-more and pagination buttons of anabaptistperspectives", async () => {
    const load = await blockOf("ap", { kind: "template", slug: "search" }, "load-more-button");
    const next = await blockOf("ap", { kind: "component", ref: "e4f8f087a3" }, "button-next");
    const { ctx } = await realCtx("ap", { kind: "template", slug: "search" });
    expect(blockLink(load, ctx)).toMatchObject({
      action: { kind: "query", mode: "load-more" },
      anchor: "self",
    });
    expect(blockLink(next, ctx)).toMatchObject({ action: { kind: "query", mode: "next" } });
  });
});

// ── Which element is the anchor ──────────────────────────────────────────────────────────────────

describe("the anchor element", () => {
  test("the block's own element for most blocks, the content of a heading, the wrapper of an image", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    const anchor = (name: string, extra: Record<string, unknown> = {}): string | undefined =>
      blockLink(link({ linkWrapperUrl: "/x", ...extra }, name), ctx)?.anchor;
    for (const name of [
      "cwicly/button",
      "cwicly/div",
      "cwicly/section",
      "cwicly/container",
      "cwicly/column",
      "cwicly/paragraph",
      "cwicly/icon",
    ])
      expect(anchor(name)).toBe("self");
    expect(anchor("cwicly/heading")).toBe("inner");
    expect(anchor("cwicly/navlink")).toBe("inner");
    expect(anchor("cwicly/navdropdown")).toBe("inner");
    expect(anchor("cwicly/image")).toBe("outer");
    expect(anchor("cwicly/button", { containerLayoutTag: "button" })).toBe("button");
    expect(anchor("cwicly/div", { containerLayoutTag: "a" })).toBe("self");
    expect(blockLink(link({ linkWrapperType: "lightbox" }, "cwicly/gallery"), ctx)).toEqual({
      action: { kind: "lightbox", media: "image" },
      anchor: "images",
      bound: false,
    });
    expect(blockLink(link({ linkWrapperType: "url" }, "cwicly/gallery"), ctx)).toBeUndefined();
  });

  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: the anchor is the element the saved markup makes the link`, async () => {
      const loaded = await loadSite(site);
      const { ctx } = await realCtx(site, { kind: "part", slug: "header" });
      const seen = new Map<string, number>();
      for (const sub of allSubjects(loaded)) {
        walkBlocks(subjectBlocks(loaded, sub), (b) => {
          if (!b.name || !b.attrs.linkWrapperActive) return;
          const spec = blockLink(b, ctx);
          const root = /^\s*<([a-z0-9-]+)/i.exec(b.innerHTML)?.[1];
          const innerA = /^\s*<[a-z0-9-]+[^>]*>\s*<a\b/i.test(b.innerHTML);
          const shape =
            spec?.anchor === "images"
              ? "images"
              : root === "a"
                ? "self"
                : innerA
                  ? "inner"
                  : root === "button"
                    ? "button"
                    : `other:${root}`;
          expect(shape).toBe(spec?.anchor === "images" ? "images" : (spec?.anchor ?? "?"));
          seen.set(`${b.name} ${spec?.anchor}`, (seen.get(`${b.name} ${spec?.anchor}`) ?? 0) + 1);
        });
      }
      expect(Object.fromEntries([...seen].sort())).toEqual(
        site === "fineline"
          ? {
              "cwicly/button button": 2,
              "cwicly/button self": 102,
              "cwicly/div self": 91,
              "cwicly/gallery images": 47,
              "cwicly/heading inner": 39,
              "cwicly/navlink inner": 23,
              "cwicly/paragraph self": 6,
            }
          : {
              "cwicly/button self": 27,
              "cwicly/column self": 5,
              "cwicly/div self": 34,
              "cwicly/heading inner": 4,
              "cwicly/icon self": 7,
              "cwicly/paragraph button": 1,
              "cwicly/paragraph self": 23,
            },
      );
    });
  }
});

// ── Components ───────────────────────────────────────────────────────────────────────────────────

describe("a component's link property", () => {
  test("is a read of the component's state: the address, and the attributes a link property carries", async () => {
    const button = await blockOf("ap", { kind: "component", ref: "425a689f37" }, "button-c3abbfa");
    const { ctx } = await realCtx("ap", { kind: "component", ref: "425a689f37" });
    ctx.props = new Map(ctx.components.get("425a689f37")?.props.map((p) => [p.id, p.key]));
    const key = ctx.props.get("vb1Wz") as string;
    const spec = blockLink(button, ctx);
    expect(spec).toEqual({
      href: `\${state.${key}?.href || false}`,
      target: `\${state.${key}?.target || false}`,
      rel: `\${state.${key}?.rel || false}`,
      title: `\${state.${key}?.title || false}`,
      anchor: "self",
      bound: true,
    });
    const state = { [key]: { href: "/x/", target: "_blank", rel: "noopener" } };
    expect(evalTemplate(spec?.href ?? "", state)).toBe("/x/");
    expect(evalTemplate(spec?.title ?? "", state)).toBe("false");
    ctx.props = new Map();
    expect(blockLink(button, ctx)).toBeUndefined();
    expect(ctx.report.entries().some((e) => e.code === "dynamic.unsupported")).toBe(true);
  });

  test("a gallery's link property still anchors on its images", async () => {
    const button = await blockOf("ap", { kind: "component", ref: "425a689f37" }, "button-c3abbfa");
    const { ctx } = await realCtx("ap", { kind: "component", ref: "425a689f37" });
    ctx.props = new Map(ctx.components.get("425a689f37")?.props.map((p) => [p.id, p.key]));
    expect(blockLink({ ...button, name: "cwicly/gallery" }, ctx)?.anchor).toBe("images");
  });
});

// ── The corpus ───────────────────────────────────────────────────────────────────────────────────

interface Prepared {
  sub: Subject;
  ctx: ConvertCtx;
  state: unknown;
}

const preparedCache = new Map<SiteName, Promise<Prepared[]>>();

function prepared(site: SiteName): Promise<Prepared[]> {
  let p = preparedCache.get(site);
  if (!p) {
    p = (async () => {
      const loaded = await loadSite(site);
      const out: Prepared[] = [];
      for (const sub of allSubjects(loaded)) {
        const slug = "slug" in sub ? sub.slug : "";
        const mode =
          sub.kind === "post" ? "static" : sub.kind === "component" ? "component" : "entry";
        const over: Partial<ConvertCtx> = { mode };
        let type: string | undefined;
        if (mode === "entry") {
          type =
            /^(?:single|archive)-(.+)$/.exec(slug)?.[1] ?? (slug === "single" ? "post" : undefined);
          if (type !== undefined) over.entryType = type;
          if (slug.startsWith("taxonomy-")) over.termExpr = "state.term";
        }
        const { ctx } = await realCtx(site, sub, over);
        let state: unknown = {};
        if (mode === "entry") {
          const richest = [...loaded.model.posts.values()]
            .filter((x) => x.status === "publish" && x.type === (type ?? "post"))
            .map((x) => ({ x, n: JSON.stringify(postData(ctx, x)).length }))
            .sort((a, b) => b.n - a.n)[0]?.x;
          const term = [...loaded.model.terms.values()].find(
            (x) => x.taxonomy === slug.replace(/^taxonomy-/, ""),
          );
          state = {
            entry: { data: richest ? postData(ctx, richest) : {}, $children: [] },
            term: { data: term ? termData(ctx, term) : {} },
          };
        }
        if (mode === "component") {
          ctx.props = new Map(
            ctx.components.get((sub as { ref: string }).ref)?.props.map((x) => [x.id, x.key]),
          );
          state = Object.fromEntries(
            [...(ctx.props?.values() ?? [])].map((k) => [
              k,
              { href: `/h-${k}`, target: "_blank", rel: "noopener", title: `t-${k}` },
            ]),
          );
        }
        out.push({ sub, ctx, state });
      }
      return out;
    })();
    preparedCache.set(site, p);
  }
  return p;
}

describe("every link of both sites", () => {
  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: the link from the attributes is the link the saved markup holds`, async () => {
      const loaded = await loadSite(site);
      const t = toolsFor(site, loaded);
      const norm = (u: string | undefined): string | undefined =>
        u === undefined || u === "" || u === "false"
          ? undefined
          : (loaded.media.mediaForUrl(u)?.src ?? t.rewriteUrl(u));
      const tally = { agree: 0, repaired: 0, component: 0, images: 0, unresolved: 0, newWindow: 0 };
      const repaired: string[] = [];
      for (const { sub, ctx, state } of await prepared(site)) {
        walkBlocks(subjectBlocks(loaded, sub), (b) => {
          if (!b.name) return;
          const connector = (b.attrs.componentConnectors as { link?: { ref?: string } } | undefined)
            ?.link?.ref;
          if (!b.attrs.linkWrapperActive && !connector) return;
          const spec = blockLink(b, ctx);
          expect(spec).toBeDefined();
          if (spec?.anchor === "images") {
            tally.images++;
            return;
          }
          let anchor: N | undefined;
          walkN(parseFragment(resolveTokens(b.innerHTML, ctx, b)) as unknown as N, (n) => {
            if (!anchor && (n.nodeName === "a" || n.nodeName === "button")) anchor = n;
          });
          const saved = attrsOf(anchor as N);
          if (connector) {
            tally.component++;
            expect(evalTemplate(spec?.href ?? "", state)).toBe(
              evalTemplate(saved.href ?? "", state),
            );
            return;
          }
          const mine = spec?.href === undefined ? undefined : evalTemplate(spec.href, state);
          const theirs = saved.href === undefined ? undefined : evalTemplate(saved.href, state);
          if (spec?.unresolved !== undefined) {
            tally.unresolved++;
            expect(norm(mine)).toBeUndefined();
            expect(norm(theirs)).toBeUndefined();
          } else if (norm(mine) !== norm(theirs)) {
            // The object the link names is not on the converted site (or the export): PHP prints no address, and
            // this tool uses the address the block stored beside it.
            expect(b.attrs.linkWrapperStaticObject).toBeDefined();
            expect(norm(theirs)).toBeUndefined();
            expect(norm(mine)).toBe(norm(ctx.rewriteUrl(b.attrs.linkWrapperUrl as string)));
            tally.repaired++;
            repaired.push(
              `${String(b.attrs.classID)} ${(b.attrs.linkWrapperStaticObject as { id: number }).id}`,
            );
          } else {
            tally.agree++;
          }
          // What the link says about itself. Rank Math adds a new window to an external link of a post's
          // content at render time, so the saved markup of such a link has none and `blockLink` does.
          const filtered = spec?.target === "_blank" && b.attrs.linkWrapperNewTab !== true;
          if (filtered) {
            expect(saved.target === undefined || saved.target === "_self").toBe(true);
            expect(["post", "reusable"]).toContain(sub.kind);
            tally.newWindow++;
          } else if (spec?.target !== undefined) expect(saved.target).toBe(spec.target);
          else expect(saved.target === undefined || saved.target === "_self").toBe(true);
          if (spec?.rel !== undefined && !filtered) expect(saved.rel).toBe(spec.rel);
          if (spec?.title !== undefined) expect(saved.title).toBe(spec.title);
          if (spec?.ariaLabel !== undefined) expect(saved["aria-label"]).toBe(spec.ariaLabel);
        });
      }
      if (site === "fineline") {
        // Which links have an address depends on the pages the routes module gives one, which moves without
        // this module changing: what agrees and what is unresolved are held together, and the unresolved to a range.
        const { agree, unresolved, newWindow, ...rest } = tally;
        expect(rest).toEqual({ repaired: 15, component: 1, images: 47 });
        // The external links of the financing and premium-paint pages, which the live pages open in a new window.
        expect(newWindow).toBeGreaterThanOrEqual(6);
        expect(agree + unresolved).toBe(248);
        expect(unresolved).toBeGreaterThanOrEqual(3);
        expect(unresolved).toBeLessThanOrEqual(6);
        // Every one of them names the page 482, which is not in the export (the quote page is 1013 now).
        expect([...new Set(repaired)].sort()).toEqual([
          "button-c06a47e 482",
          "button-c1f8e29 482",
          "button-c263389 482",
          "button-c2666a3 482",
          "button-c84fac7 482",
          "button-c9d3470 482",
          "button-cef07b9 482",
          "navlink-ced2370 482",
        ]);
        expect((await loadSite("fineline")).model.posts.has(482)).toBe(false);
      } else {
        expect({ ...tally, newWindow: undefined }).toEqual({
          agree: 66,
          repaired: 1,
          component: 4,
          images: 0,
          unresolved: 34,
          newWindow: undefined,
        });
        // The social links of the reusable block, and the video lightbox.
        expect(tally.newWindow).toBeGreaterThanOrEqual(7);
        expect(repaired).toEqual(["paragraph-cae26ec 837"]);
      }
    });
  }

  test("what no static site can do is reported, once per kind per subject, with the subject's location", async () => {
    const reasons = new Map<string, number>();
    for (const site of ["fineline", "ap"] as const) {
      const loaded = await loadSite(site);
      for (const { sub, ctx } of await prepared(site)) {
        walkBlocks(subjectBlocks(loaded, sub), (b) => {
          if (b.attrs.linkWrapperActive) blockLink(b, ctx);
        });
        for (const e of ctx.report.entries()) {
          if (e.code.startsWith("link.") || e.code === "token.unresolved") {
            expect(e.where).toMatch(/^(post|template|component):/);
            reasons.set(`${site} ${e.code}`, (reasons.get(`${site} ${e.code}`) ?? 0) + 1);
          }
        }
      }
    }
    expect([...reasons.keys()].sort()).toEqual([
      "ap link.approximated",
      "ap link.unresolved",
      "ap link.unsupported",
      "ap token.unresolved",
      "fineline link.approximated",
      "fineline link.unresolved",
      "fineline link.unsupported",
      "fineline token.unresolved",
    ]);
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

/** The model with one option removed. */
const withoutOption = (model: WpModel, name: string): WpModel => ({
  ...model,
  options: new Map([...model.options].filter(([k]) => k !== name)),
});

async function liveLinks(site: SiteName): Promise<{ checked: number; diffs: string[] }> {
  const loaded = await loadSite(site);
  const t = toolsFor(site, loaded);
  const norm = (u: string | undefined): string | undefined =>
    u === undefined || u === "" ? undefined : (loaded.media.mediaForUrl(u)?.src ?? t.rewriteUrl(u));
  const out = { checked: 0, diffs: [] as string[] };
  for (const page of LIVE[site]) {
    const post = page.post ? loaded.model.posts.get(page.post) : undefined;
    if (page.post && !post) continue;
    const doc = parse(
      readFileSync(`tests/fixtures/${site}/html/${page.file}.html`, "utf8"),
    ) as unknown as N;
    const byClass = new Map<string, N[]>();
    walkN(doc, (n) => {
      const c = attrsOf(n).class;
      if (c) for (const k of c.split(/\s+/)) byClass.set(k, [...(byClass.get(k) ?? []), n]);
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
        // Rank Math filters `the_content`: the blocks of a template or a part are not content, whatever page shows them.
        ...(sub.kind === "post"
          ? {}
          : { model: withoutOption(loaded.model, "rank-math-options-general") }),
      });
      walkBlocks(subjectBlocks(loaded, sub), (b) => {
        const classID = b.attrs.classID;
        if (
          !b.name ||
          typeof classID !== "string" ||
          !b.attrs.linkWrapperActive ||
          b.name === "cwicly/gallery"
        )
          return;
        const lives = byClass.get(classID) ?? [];
        if (lives.length !== 1 || counts.get(classID) !== 1) return;
        const spec = blockLink(b, ctx);
        let anchor: N | undefined;
        walkN(lives[0] as N, (n) => {
          if (!anchor && n.nodeName === "a" && attrsOf(n).href !== undefined) anchor = n;
        });
        if (!anchor) return;
        out.checked++;
        const live = attrsOf(anchor);
        if (norm(spec?.href) !== norm(live.href))
          out.diffs.push(`${page.file} ${classID} href: ${spec?.href} != ${live.href}`);
        if ((spec?.target ?? undefined) !== (live.target === "_self" ? undefined : live.target))
          out.diffs.push(`${page.file} ${classID} target`);
      });
    }
  }
  return out;
}

describe("the live pages", () => {
  test("fineline: every link the page shows leads where blockLink says", async () => {
    const r = await liveLinks("fineline");
    expect(r.checked).toBeGreaterThanOrEqual(25);
    expect(r.diffs).toEqual([]);
  });

  test("anabaptistperspectives: the same, apart from the login the converted site does not have", async () => {
    const r = await liveLinks("ap");
    expect(r.checked).toBeGreaterThanOrEqual(10);
    expect(r.diffs.every((d) => /wp-login|login/.test(d))).toBe(true);
  });
});

// ── Rank Math's external links, and what a hostile value cannot do ───────────────────────────────

describe("Rank Math opens the external links of a post's content in a new window", () => {
  const external = link({ linkWrapperUrl: "https://www.avvance.com/apply" });

  test("a post's content gets target and noopener on an external link, and not on an internal one, a scheme or its own target", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    expect(blockLink(external, ctx)).toMatchObject({ target: "_blank", rel: "noopener" });
    expect(blockLink(link({ ...external.attrs, linkWrapperRel: "nofollow" }), ctx)?.rel).toBe(
      "nofollow noopener",
    );
    expect(
      blockLink(link({ linkWrapperUrl: "https://finelinepainting.pro/about-us/" }), ctx),
    ).not.toHaveProperty("target");
    expect(
      blockLink(link({ linkWrapperUrl: "https://www.finelinepainting.pro/" }), ctx),
    ).not.toHaveProperty("target");
    expect(blockLink(link({ linkWrapperUrl: "/financing/" }), ctx)).not.toHaveProperty("target");
    expect(blockLink(link({ linkWrapperUrl: "tel:7172286606" }), ctx)).not.toHaveProperty("target");
    expect(blockLink(link({ linkWrapperUrl: "mailto:a@b.co" }), ctx)).not.toHaveProperty("target");
  });

  test("a template or a part is not content, and the option off changes nothing", async () => {
    const part = (await realCtx("fineline", { kind: "part", slug: "footer" })).ctx;
    expect(blockLink(external, part)).not.toHaveProperty("target");
    const loaded = await loadSite("fineline");
    const off = (
      await realCtx(
        "fineline",
        { kind: "post", id: 5246 },
        {
          model: {
            ...loaded.model,
            options: new Map(
              [...loaded.model.options].filter(([k]) => k !== "rank-math-options-general"),
            ),
          },
        },
      )
    ).ctx;
    expect(blockLink(external, off)).not.toHaveProperty("target");
  });
});

describe("a value that holds a template cannot run in the build", () => {
  const hostile = "${globalThis.PWNED = 1}";
  /** Every string a spec holds, evaluated as the Jx build evaluates a template: nothing may run. */
  function evaluate(spec: Record<string, unknown> | undefined): string[] {
    const out: string[] = [];
    for (const v of Object.values(spec ?? {})) {
      if (typeof v === "string") out.push(evalTemplate(v, {}));
    }
    return out;
  }

  test("a literal address, title, label, relation, phone, mail address and lightbox address are final-form strings", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    const cases: Record<string, unknown>[] = [
      { linkWrapperUrl: `https://example.com/${hostile}` },
      { linkWrapperUrl: "https://example.com/", linkWrapperTitle: hostile },
      { linkWrapperUrl: "https://example.com/", linkWrapperAriaLabel: hostile },
      { linkWrapperUrl: "https://example.com/", linkWrapperRel: hostile },
      {
        linkWrapperType: "action",
        linkWrapperAction: "contact",
        linkWrapperActionContactType: "tel",
        linkWrapperActionContactOneLine: hostile,
      },
      {
        linkWrapperType: "action",
        linkWrapperAction: "contact",
        linkWrapperActionContactType: "email",
        linkWrapperActionContactEmailAddress: hostile,
      },
      {
        linkWrapperType: "action",
        linkWrapperAction: "lightbox",
        linkWrapperActionLighboxType: "video",
        linkWrapperActionLighboxSourceType: "static",
        linkWrapperActionLighboxVideoURL: `https://youtu.be/${hostile}`,
      },
      {
        linkWrapperType: "action",
        linkWrapperAction: "lightbox",
        linkWrapperActionLighboxType: "image",
        linkWrapperActionLighboxSourceType: "static",
        linkWrapperActionLighboxURL: `https://example.com/${hostile}.jpg`,
      },
    ];
    for (const attrs of cases) {
      Reflect.deleteProperty(globalThis, "PWNED");
      const spec = blockLink(link(attrs), ctx);
      expect(spec).toBeDefined();
      const strings = evaluate(spec as unknown as Record<string, unknown>);
      expect(Reflect.has(globalThis, "PWNED")).toBe(false);
      // The text is still there, with a zero-width space between the dollar and the brace.
      expect(strings.join("\n")).toContain("$\u200b{globalThis.PWNED = 1}");
      expect(spec?.bound).toBe(false);
    }
    expect(ctx.report.entries().some((e) => e.code === "token.literal-template")).toBe(true);
  });
});

// END OF PART 4
