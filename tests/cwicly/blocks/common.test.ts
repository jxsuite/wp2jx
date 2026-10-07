/**
 * The root every Cwicly block converter builds (src/cwicly/blocks/common.ts): the class list, style,
 * attributes, visibility, link and wrappers of one block, combined from the modules that read them.
 *
 * Real blocks of both fixture sites stand behind every behaviour that has one (a link-wrapped
 * heading, a lightbox image, a page's hero section); the cases the fixtures lack (a device hide, a
 * modal opener, a hook with no element) are hand-made blocks, named as such. What decides how the
 * result behaves in a page is checked by building it with Jx.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseFragment } from "parse5";
import { allSubjects, loadSite, makeCtx, subjectBlocks } from "../../helpers/ctx.ts";
import type { SiteName, Subject } from "../../helpers/ctx.ts";
import { buildJxProject, cleanupJxProjects } from "../../helpers/jx-build.ts";
import { walkBlocks } from "../../../src/wp/blocks.ts";
import { parseBlocks } from "../../../src/wp/blocks.ts";
import type { ConvertCtx, JxElement, JxNode, JxStyle, WpBlock } from "../../../src/types.ts";
import {
  assemble,
  baseName,
  buildBlock,
  contentMarkup,
  dataAttrs,
  hoistRule,
  iconSvg,
  inlineContent,
  linkAttributes,
  markupContent,
  markupNodes,
  paragraphValue,
  placeholder,
  prepare,
  record,
  rewriteAddress,
  savedSvg,
  say,
  shapeElement,
  text,
  triggerOf,
} from "../../../src/cwicly/blocks/common.ts";
import { blockLink } from "../../../src/cwicly/links.ts";

setDefaultTimeout(120_000);
afterAll(cleanupJxProjects);

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const block = (
  name: string,
  attrs: Record<string, unknown> = {},
  innerHTML = "",
  innerBlocks: WpBlock[] = [],
): WpBlock => ({ name, attrs, innerBlocks, innerHTML, innerContent: [innerHTML] });

/** How many entries a context's report had when the test got it: the stylesheet reader reports into it while the context is made. */
const baseline = new WeakMap<object, number>();

async function ctxOf(
  site: SiteName,
  subject: Subject,
  over: Partial<ConvertCtx> = {},
): Promise<ConvertCtx> {
  const ctx = await makeCtx(site, subject, over);
  baseline.set(ctx.report, ctx.report.entries().length);
  return ctx;
}

const reports = (ctx: ConvertCtx) => ctx.report.entries().slice(baseline.get(ctx.report) ?? 0);

/** A real block of a subject by classID. */
async function realBlock(site: SiteName, subject: Subject, classID: string): Promise<WpBlock> {
  const loaded = await loadSite(site);
  let found: WpBlock | undefined;
  walkBlocks(subjectBlocks(loaded, subject), (b) => {
    if (b.attrs.classID === classID) found ??= b;
  });
  if (!found) throw new Error(`no block ${classID} in ${JSON.stringify(subject)}`);
  return found;
}

const el = (node: JxNode | undefined): JxElement => {
  if (typeof node === "string" || node === undefined) throw new Error("expected an element");
  return node;
};

const codes = (ctx: ConvertCtx): string[] => reports(ctx).map((e) => e.code);

/** What the HTML parser makes of a built page's body. */
function bodyOf(html: string): string {
  return /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Small readers
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("readers", () => {
  test("text keeps non-empty strings and numbers, nothing else", () => {
    expect(text("a")).toBe("a");
    expect(text(5)).toBe("5");
    expect(text(0)).toBe("0");
    expect(text("")).toBeUndefined();
    expect(text(undefined)).toBeUndefined();
    expect(text(null)).toBeUndefined();
    expect(text(true)).toBeUndefined();
    expect(text(["a"])).toBeUndefined();
  });

  test("record accepts plain objects only", () => {
    expect(record({ a: 1 })).toEqual({ a: 1 });
    expect(record([1])).toBeUndefined();
    expect(record(null)).toBeUndefined();
    expect(record("x")).toBeUndefined();
  });

  test("baseName drops the namespace; a freeform block has the name freeform", () => {
    expect(baseName(block("cwicly/heading"))).toBe("heading");
    expect(baseName(block("core/paragraph"))).toBe("core/paragraph");
    expect(baseName({ ...block("x"), name: null })).toBe("freeform");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Reporting
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("say", () => {
  test("a report is located at the subject and carries the block's name, classID and uniqueID", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block("cwicly/hook", { classID: "hook-c1", uniqueID: "u-1" });
    say(ctx, b, "block.unsupported", "warn", "no", { feature: "x" });
    const [entry, ...rest] = reports(ctx);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      code: "block.unsupported",
      severity: "warn",
      where: "post:195",
      data: { block: "cwicly/hook", classID: "hook-c1", uniqueID: "u-1", feature: "x" },
    });
    expect(entry?.url).toBe("https://finelinepainting.pro/?p=195");
  });

  test("the same block says the same thing once, a different block says it again", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const a = block("cwicly/hook", { classID: "hook-a" });
    const b = block("cwicly/hook", { classID: "hook-b" });
    say(ctx, a, "block.unsupported", "warn", "m");
    say(ctx, a, "block.unsupported", "warn", "m");
    say(ctx, b, "block.unsupported", "warn", "m");
    expect(codes(ctx)).toEqual(["block.unsupported", "block.unsupported"]);
  });

  test("two different things about one block are two entries (data.detail tells them apart)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const a = block("cwicly/code", { classID: "code-a" });
    say(ctx, a, "block.code-js", "warn", "m1", { detail: "js" });
    say(ctx, a, "block.code-js", "warn", "m1", { detail: "js2" });
    expect(codes(ctx)).toHaveLength(2);
  });

  test("a block with neither classID nor uniqueID is still reported", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    say(ctx, block("cwicly/hook"), "block.unsupported", "warn", "m");
    expect(reports(ctx)[0]?.data).toMatchObject({ block: "cwicly/hook" });
    expect(reports(ctx)[0]?.data).not.toHaveProperty("classID");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Addresses
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("rewriteAddress", () => {
  test("an upload becomes its media path and a permalink its route", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    expect(rewriteAddress(ctx, "https://finelinepainting.pro/wp-content/uploads/swash.svg")).toBe(
      "/media/swash.svg",
    );
    expect(rewriteAddress(ctx, "https://finelinepainting.pro/residential/")).toBe("/residential/");
  });

  test("an external address, a fragment, mail, a phone number and a binding are left alone", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    for (const same of [
      "https://example.com/a",
      "#top",
      "mailto:a@b.c",
      "tel:7172286606",
      "${state.x}",
      "page.html",
      "${state.entry.data.url}/",
    ]) {
      expect(rewriteAddress(ctx, same)).toBe(same);
    }
  });

  test("a root-relative address is asked about too (an upload the author linked by its path)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    expect(rewriteAddress(ctx, "/wp-content/uploads/swash.svg")).toBe("/media/swash.svg");
    expect(rewriteAddress(ctx, "//finelinepainting.pro/residential/")).toBe("/residential/");
  });

  test("a file of the media plan is already final: the URL tools are not asked, so no `url.unresolved` is reported for it", async () => {
    const asked: string[] = [];
    const ctx = await ctxOf(
      "fineline",
      { kind: "post", id: 195 },
      {
        rewriteUrl: (url) => {
          asked.push(url);
          return url;
        },
      },
    );
    expect(rewriteAddress(ctx, "/media/2023/03/painting-in-pinegrove.jpeg")).toBe(
      "/media/2023/03/painting-in-pinegrove.jpeg",
    );
    expect(rewriteAddress(ctx, "/media/a.pdf?x=1#p2")).toBe("/media/a.pdf?x=1#p2");
    expect(asked).toEqual([]);
    // A path that only starts the same way is a page or a folder: it is still asked about.
    rewriteAddress(ctx, "/media/");
    rewriteAddress(ctx, "/media-kit/logo.png");
    expect(asked).toEqual(["/media/", "/media-kit/logo.png"]);
  });

  test("a saved tag whose image token the style module already resolved to /media/ is not reported (fineline image-c110644)", async () => {
    const subject: Subject = { kind: "post", id: 1382 };
    const asked: string[] = [];
    const base = await ctxOf("fineline", subject);
    const ctx = await ctxOf("fineline", subject, {
      rewriteUrl: (url) => {
        asked.push(url);
        return base.rewriteUrl(url);
      },
    });
    const b = await realBlock("fineline", subject, "image-c110644");
    assemble(prepare(b, ctx)!, { forceTag: "img" });
    expect(asked.filter((u) => u.startsWith("/media/"))).toEqual([]);
    expect(codes(ctx)).not.toContain("url.unresolved");
  });

  test("a saved video's poster is an address and moves like src and href", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/video",
      { classID: "video-p" },
      '<video class="video-p" poster="https://finelinepainting.pro/wp-content/uploads/swash.svg" data-poster="https://finelinepainting.pro/residential/"></video>',
    );
    const node = el(assemble(prepare(b, ctx)!, { tag: "video" }).nodes[0]);
    expect(node.attributes).toMatchObject({ poster: "/media/swash.svg" });
    // Only the attributes that are addresses are rewritten.
    expect(node.attributes?.["data-poster"]).toBe("https://finelinepainting.pro/residential/");
  });

  test("it is idempotent for an address that is already the Jx site's", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    expect(rewriteAddress(ctx, "/media/swash.svg")).toBe("/media/swash.svg");
    expect(rewriteAddress(ctx, rewriteAddress(ctx, "https://finelinepainting.pro/quote/"))).toBe(
      "/quote/",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Triggers and link attributes
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("triggerOf", () => {
  test("a modal opener is a button that targets the modal by id", () => {
    expect(triggerOf({ kind: "modal", mode: "open", target: "modal-topics" })).toEqual({
      tag: "button",
      attributes: {
        type: "button",
        popovertarget: "modal-topics",
        popovertargetaction: "show",
      },
    });
    expect(triggerOf({ kind: "modal", mode: "close", target: "m" })?.attributes).toMatchObject({
      popovertargetaction: "hide",
    });
    expect(triggerOf({ kind: "modal", mode: "toggle", target: "m" })?.attributes).toMatchObject({
      popovertargetaction: "toggle",
    });
  });

  test("popover modes map to show, hide and toggle (showHide toggles)", () => {
    for (const [mode, action] of [
      ["show", "show"],
      ["hide", "hide"],
      ["toggle", "toggle"],
      ["showHide", "toggle"],
    ] as const) {
      expect(
        triggerOf({ kind: "popover", mode, target: "p" })?.attributes.popovertargetaction,
      ).toBe(action);
    }
  });

  test("every other action, and no action, is not a trigger", () => {
    expect(triggerOf(undefined)).toBeUndefined();
    expect(triggerOf({ kind: "scroll", to: "top" })).toBeUndefined();
    expect(triggerOf({ kind: "lightbox", media: "image" })).toBeUndefined();
    expect(triggerOf({ kind: "nav", mode: "toggle", target: "n" })).toBeUndefined();
  });
});

describe("linkAttributes", () => {
  test("only what the link says becomes an attribute", () => {
    expect(
      linkAttributes({
        href: "/a/",
        target: "_blank",
        rel: "noopener",
        title: "T",
        ariaLabel: "L",
        anchor: "self",
        bound: false,
      }),
    ).toEqual({ href: "/a/", target: "_blank", rel: "noopener", title: "T", "aria-label": "L" });
    expect(linkAttributes({ anchor: "self", bound: false })).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Content
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("contentMarkup", () => {
  test("the saved content of a static block", () => {
    expect(contentMarkup(block("cwicly/heading", { content: "Hello <b>x</b>" }))).toEqual({
      markup: "Hello <b>x</b>",
      dynamic: false,
    });
  });

  test("a dynamic block is its token between the static texts, which are escaped as text", () => {
    expect(
      contentMarkup(
        block("cwicly/paragraph", {
          dynamic: "wordpress",
          dynamicWordPressType: "title",
          dynamicStaticBefore: "A & ",
          dynamicStaticAfter: " <z>",
        }),
      ),
    ).toEqual({ markup: "A &amp; {title} &lt;z&gt;", dynamic: true });
  });

  test("a component's content connector is the token of its property", () => {
    expect(
      contentMarkup(
        block("cwicly/heading", { componentConnectors: { content: { ref: "1nsiW" } } }),
      ),
    ).toEqual({ markup: "{component=content=1nsiW}", dynamic: true });
  });

  test("a dynamic source the editor writes no token for is empty markup, not its stale preview", () => {
    expect(
      contentMarkup(block("cwicly/paragraph", { dynamic: "filter", content: "preview" })),
    ).toEqual({ markup: "", dynamic: true });
  });

  test("a block with no text has no markup", () => {
    expect(contentMarkup(block("cwicly/heading", {}))).toBeUndefined();
    expect(contentMarkup(block("cwicly/heading", { content: "" }))).toBeUndefined();
  });
});

describe("markupContent", () => {
  test("plain text is a textContent, texturized as WordPress prints it", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    expect(markupContent("Don't wait - call", ctx, undefined)).toEqual({
      textContent: "Don’t wait – call",
    });
  });

  test("inline markup keeps its structure and its spacing", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const content = markupContent("Hello <b>big</b>. Bye", ctx, undefined);
    // The build would put a space before the full stop of structured children, so the markup stays markup.
    expect(content).toEqual({ innerHTML: "Hello <b>big</b>. Bye" });
  });

  test("the addresses inside it move to where the Jx site has them", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const content = markupContent(
      '<a href="https://finelinepainting.pro/residential/">Residential</a>',
      ctx,
      undefined,
    );
    expect(JSON.stringify(content)).toContain('"/residential/"');
    expect(JSON.stringify(content)).not.toContain("finelinepainting.pro/residential");
  });

  test("a link to another site opens in a new window in a post's content, as Rank Math makes it", async () => {
    const post = await ctxOf("fineline", { kind: "post", id: 195 });
    const content = markupContent('<a href="https://example.com/x">x</a>', post, undefined);
    expect(JSON.stringify(content)).toContain('"target":"_blank"');
    // A template is not content: Rank Math leaves it alone.
    const template = await ctxOf("fineline", { kind: "part", slug: "footer" });
    const plain = markupContent('<a href="https://example.com/x">x</a>', template, undefined);
    expect(JSON.stringify(plain)).not.toContain("_blank");
  });

  test("a token of an entry is a binding, finished: no placeholder is left behind", async () => {
    const ctx = await ctxOf(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryType: "project" },
    );
    const content = markupContent("{title}", ctx, undefined);
    expect(content).toEqual({ textContent: "${state.entry.data.title ?? ''}" });
    expect(JSON.stringify(content)).not.toMatch(/[-]/);
  });

  test("a Markdown entry's content stays structured: the serializer writes no innerHTML", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 }, { target: "markdown" });
    const content = markupContent("Hello <b>big</b>. Bye", ctx, undefined);
    expect(content.innerHTML).toBeUndefined();
    expect(content.children).toBeDefined();
    expect(codes(ctx)).not.toContain("html.innerhtml-unserialisable");
  });

  test("markupNodes is the same conversion as nodes (code, a video's iframe)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const nodes = markupNodes('<div class="a"><p>Hi {title}</p></div>', ctx, undefined);
    expect(nodes).toHaveLength(1);
    expect(el(nodes[0]).className).toBe("a");
  });
});

describe("inlineContent", () => {
  test("the icon goes before the label by default and after it when asked", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block("cwicly/button", { content: "Go" });
    const svg = '<svg viewBox="0 0 1 1"><path d="M0 0"></path></svg>';
    const before = inlineContent(b, ctx, { before: svg });
    const after = inlineContent(b, ctx, { after: svg });
    expect(before?.innerHTML?.startsWith("<svg")).toBe(true);
    expect(before?.innerHTML?.endsWith("Go")).toBe(true);
    expect(after?.innerHTML?.startsWith("Go")).toBe(true);
    expect(after?.innerHTML?.endsWith("</svg>")).toBe(true);
  });

  test("a block with no text and nothing around it has no content", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    expect(inlineContent(block("cwicly/heading"), ctx)).toBeUndefined();
  });

  test("an icon alone is content even when the block has no text", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const content = inlineContent(block("cwicly/button"), ctx, { before: "<svg></svg>" });
    expect(content).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SVG, placeholders
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("svg helpers", () => {
  test("savedSvg finds the SVG the page printed", async () => {
    const icon = await realBlock("fineline", { kind: "post", id: 195 }, "icon-c8bedd9").catch(
      async () => realBlock("fineline", { kind: "part", slug: "footer" }, "icon-c8bedd9"),
    );
    const svg = savedSvg(icon);
    expect(svg?.startsWith("<svg")).toBe(true);
    expect(svg?.endsWith("</svg>")).toBe(true);
    expect(savedSvg(block("cwicly/icon", {}, "<div></div>"))).toBeUndefined();
  });

  test("iconSvg rebuilds an SVG from the editor's icon attribute and escapes what it writes", () => {
    const svg = iconSvg({
      viewBox: "0 0 32 32",
      paths: [null, { d: 'M1 1"<' }, { d: "M2 2", fill: "red" }],
    });
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M1 1&quot;&lt;"></path><path d="M2 2" fill="red"></path></svg>',
    );
  });

  test("iconSvg has nothing to say about an attribute that is not an icon", () => {
    expect(iconSvg(undefined)).toBeUndefined();
    expect(iconSvg("x")).toBeUndefined();
    expect(iconSvg({ viewBox: "0 0 1 1", paths: [] })).toBeUndefined();
    expect(iconSvg({ paths: [null, { d: "M0 0" }] })).toBeUndefined();
    expect(iconSvg({ viewBox: "0 0 1 1", paths: [null, 5, { d: { x: 1 } }] })).toBeUndefined();
  });
});

describe("placeholders", () => {
  test("a placeholder is a wp2jx- element with the block's name and attributes as data", () => {
    const b = block("cwicly/fragment", { fragment: "globalheader" });
    expect(placeholder(b, "template-part", "wp-block-template-part", { slug: "header" })).toEqual({
      tagName: "wp2jx-template-part",
      className: "wp-block-template-part",
      attributes: {
        "data-block": "cwicly/fragment",
        "data-attrs": '{"fragment":"globalheader"}',
        slug: "header",
      },
    });
  });

  test("a block with no attributes carries no data-attrs, a placeholder with no class no className", () => {
    const p = placeholder(block("cwicly/hook"), "block");
    expect(p).toEqual({ tagName: "wp2jx-block", attributes: { "data-block": "cwicly/hook" } });
  });

  test("a placeholder holds children when it is given any", () => {
    const p = placeholder(block("cwicly/x"), "block", "", {}, [{ tagName: "b" }]);
    expect(p.children).toEqual([{ tagName: "b" }]);
  });

  test("the dollar sign of a literal ${ is never spelled out in the data", () => {
    expect(dataAttrs({ a: "${x}" })).toBe('{"a":"\\u0024{x}"}');
    expect(JSON.parse(dataAttrs({ a: "${x}" }))).toEqual({ a: "${x}" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// prepare: visibility, style options, hoisting
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("prepare", () => {
  test("a block no visitor sees is not prepared (hideGuest: every visitor is a guest)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/div",
      { classID: "div-x", hideGuest: true },
      '<div class="div-x"></div>',
    );
    expect(prepare(b, ctx)).toBeUndefined();
    expect(codes(ctx)).toContain("condition.approximated");
  });

  test("a prepared block carries what the style, visibility and link modules say", async () => {
    const ctx = await ctxOf("fineline", { kind: "part", slug: "header" });
    const b = await realBlock("fineline", { kind: "part", slug: "header" }, "div-c64faab");
    const env = prepare(b, ctx);
    expect(env?.styling.className.startsWith("div-c64faab")).toBe(true);
    expect(env?.styling.tag).toBe("a");
    expect(env?.link).toMatchObject({ anchor: "self", href: "/" });
    expect(env?.visibility).toEqual({ dropped: [] });
  });

  test("tokens in the author's attributes are resolved through the token module", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/div",
      {
        classID: "div-t",
        isStyling: true,
        htmlAttributes: [{ name: "data-site", attributeType: "dynamic", value: "{sitetitle}" }],
      },
      '<div class="div-t" data-site="{sitetitle}"></div>',
    );
    const env = prepare(b, ctx);
    expect(env?.styling.attributes["data-site"]).toBe(
      (await loadSite("fineline")).model.site.name.replaceAll("&amp;", "&"),
    );
  });

  test("a rule that cannot live in an element's style goes to ctx.hoist", async () => {
    const hoisted: { selector: string; style: JxStyle }[] = [];
    const ctx = await ctxOf(
      "fineline",
      { kind: "post", id: 195 },
      { hoist: (r) => hoisted.push(r) },
    );
    const b = block(
      "cwicly/div",
      {
        classID: "div-k",
        isStyling: true,
        customCSS: "@keyframes kf-x{from{opacity:0}to{opacity:1}} .div-k{animation:kf-x 1s}",
      },
      '<div class="div-k"></div>',
    );
    const env = prepare(b, ctx);
    expect(hoisted.map((h) => h.selector)).toEqual(["@keyframes kf-x"]);
    expect(env?.styling.style.animation).toBe("kf-x 1s");
    expect(codes(ctx)).not.toContain("block.hoist-unavailable");
  });

  test("with nowhere to hoist to, the loss is reported", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    delete (ctx as { hoist?: unknown }).hoist;
    const b = block(
      "cwicly/div",
      {
        classID: "div-k2",
        isStyling: true,
        customCSS: "@keyframes kf-y{from{opacity:0}to{opacity:1}}",
      },
      '<div class="div-k2"></div>',
    );
    prepare(b, ctx);
    const lost = reports(ctx).find((e) => e.code === "block.hoist-unavailable");
    expect(lost).toMatchObject({ severity: "warn", data: { selector: "@keyframes kf-y" } });
  });

  test("hoistRule is the same call for a converter that has a rule of its own", async () => {
    const hoisted: { selector: string; style: JxStyle }[] = [];
    const ctx = await ctxOf(
      "fineline",
      { kind: "post", id: 195 },
      { hoist: (r) => hoisted.push(r) },
    );
    hoistRule(ctx, block("cwicly/code", { classID: "code-1" }), {
      selector: ".x",
      style: { color: "red" },
    });
    expect(hoisted).toEqual([{ selector: ".x", style: { color: "red" } }]);
  });

  test("style options reach the style module (the component variants an instance selects)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/div",
      { classID: "div-v", isStyling: true },
      '<div class="div-v{cs-index}"></div>',
    );
    const without = prepare(b, ctx);
    expect(without?.styling.variantClasses).toBe(true);
    const withVariants = prepare(b, ctx, { style: { variants: ["bmuh8n"] } });
    expect(withVariants?.styling.className).toContain("cs-bmuh8n");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// assemble
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("assemble: the element", () => {
  test("a real block: the classID first, the global classes next, the structural class last", async () => {
    const subject: Subject = { kind: "post", id: 195 };
    const ctx = await ctxOf("fineline", subject);
    const b = await realBlock("fineline", subject, "section-c93760b").catch(async () =>
      realBlock("fineline", subject, "section-c312520"),
    );
    const env = prepare(b, ctx)!;
    const built = assemble(env, { tag: "section" });
    expect(built.nodes).toHaveLength(1);
    const classes = (el(built.nodes[0]).className ?? "").split(" ");
    expect(classes[0]).toBe(b.attrs.classID as string);
    expect(classes.at(-1)).toBe("cc-sct");
    expect(built.element).toBe(built.nodes[0] as JxElement);
  });

  test("the tag is the saved one; `tag` is only the fallback and `forceTag` wins", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const a = block("cwicly/div", { classID: "d1" }, '<article class="d1"></article>');
    expect(el(assemble(prepare(a, ctx)!, { tag: "div" }).nodes[0]).tagName).toBe("article");
    expect(el(assemble(prepare(a, ctx)!, { forceTag: "span" }).nodes[0]).tagName).toBe("span");
    const none = block("cwicly/div", { classID: "d2" }, "");
    expect(el(assemble(prepare(none, ctx)!, { tag: "section" }).nodes[0]).tagName).toBe("section");
    expect(el(assemble(prepare(none, ctx)!).nodes[0]).tagName).toBe("div");
  });

  test("children and content: nested nodes, an HtmlContent, neither", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block("cwicly/div", { classID: "d3" }, '<div class="d3"></div>');
    const env = prepare(b, ctx)!;
    expect(el(assemble(env, { children: [{ tagName: "p" }] }).nodes[0]).children).toEqual([
      { tagName: "p" },
    ]);
    expect(el(assemble(env, { content: { textContent: "hi" } }).nodes[0]).textContent).toBe("hi");
    expect(el(assemble(env, { content: { innerHTML: "<i>x</i>" } }).nodes[0]).innerHTML).toBe(
      "<i>x</i>",
    );
    const empty = el(assemble(env, { children: [] }).nodes[0]);
    expect(empty).not.toHaveProperty("children");
    expect(empty).not.toHaveProperty("textContent");
  });

  test("a string of children (the entry's body) is kept as one string", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block("cwicly/content", { classID: "c1" }, '<div class="c1">{postcontent}</div>');
    const node = el(
      assemble(prepare(b, ctx)!, {
        children: "${state.entry.$children ?? []}" as unknown as JxNode[],
      }).nodes[0],
    );
    expect(node.children as unknown).toBe("${state.entry.$children ?? []}");
  });

  test("extra classes and style are added after the block's own", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/div",
      { classID: "d4", isStyling: true, paddingTop: { lg: "1px" } },
      '<div class="d4"></div>',
    );
    const node = el(
      assemble(prepare(b, ctx)!, { classes: ["extra", "d4"], style: { margin: "0" } }).nodes[0],
    );
    expect(node.className).toBe("d4 extra");
    expect(node.style).toMatchObject({ paddingTop: "1px", margin: "0" });
  });
});

describe("assemble: the style scope", () => {
  /** What the Jx build writes an element's own style to: `.` + its first class. */
  const scopeClass = (node: JxElement): string => (node.className ?? "").split(" ")[0] ?? "";

  const styled = (classID: string): WpBlock =>
    block(
      "cwicly/heading",
      { classID, isStyling: true, marginTop: { lg: "3px" }, content: "x", headingTag: "h2" },
      `<h2 class="${classID}">x</h2>`,
    );

  test("a classID that is not a CSS identifier is not the scope: a generated class goes first (the rule would be invalid and the style lost)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    for (const classID of ["1abc", "a.b", "a{b}c", "-1x", "a b", "a:hover"]) {
      const node = el(assemble(prepare(styled(classID), ctx)!, { tag: "h2" }).nodes[0]);
      expect(scopeClass(node)).toMatch(/^jx-[0-9a-f]{10}$/);
      expect(node.style).toMatchObject({ marginTop: "3px" });
    }
  });

  test("a classID that is an identifier stays the scope", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    for (const classID of ["heading-c34c93b", "_x", "-x", "a1", "A_b-C"]) {
      const node = el(assemble(prepare(styled(classID), ctx)!, { tag: "h2" }).nodes[0]);
      expect(scopeClass(node)).toBe(classID);
    }
  });

  test("a classID that holds a template start never reaches a class list", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const node = el(assemble(prepare(styled("${x}"), ctx)!, { tag: "h2" }).nodes[0]);
    expect(node.className ?? "").not.toContain("${");
    expect(scopeClass(node)).toMatch(/^jx-[0-9a-f]{10}$/);
  });

  test("a block with no style needs no scope, whatever its classID", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const node = el(
      assemble(
        prepare(block("cwicly/heading", { classID: "1abc" }, '<h2 class="1abc">x</h2>'), ctx)!,
        { tag: "h2" },
      ).nodes[0],
    );
    expect(node.className).toBe("1abc");
    expect(node).not.toHaveProperty("style");
  });

  test("the generated scope is what the build writes the rule to: the style of a hostile classID survives a real build (Jx writes `.1abc{…}` otherwise)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const nodes = ["1abc", "a.b", "a{b}c"].map(
      (id) => assemble(prepare(styled(id), ctx)!, { tag: "h2" }).nodes[0]!,
    );
    const site = await buildJxProject({
      "layouts/base.json": { children: [{ tagName: "slot" }] },
      "project.json": {
        name: "t",
        url: "https://example.com",
        defaults: { layout: "./layouts/base.json" },
      },
      "pages/index.json": { children: nodes },
    });
    const html = site.html("/");
    expect(html).not.toMatch(/\.1abc\s*\{/);
    expect(html).not.toMatch(/\.a\.b\s*\{/);
    expect(html).not.toMatch(/\.a\{b\}c/);
    expect(html.match(/\.jx-[0-9a-f]{10}\s*\{[^}]*margin-top: 3px/g)?.length).toBeGreaterThan(0);
  });
});

describe("assemble: attributes", () => {
  test("the saved attributes come along; srcset, sizes and the component runtime's are dropped; the address moves", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/image",
      { classID: "image-a" },
      '<img class="image-a" src="https://finelinepainting.pro/wp-content/uploads/swash.svg" srcset="a 1x" sizes="100vw" data-cc-comp="{cccomp}" data-x="1" alt="A"/>',
    );
    const node = el(assemble(prepare(b, ctx)!, { tag: "img" }).nodes[0]);
    expect(node.attributes).toEqual({ src: "/media/swash.svg", "data-x": "1", alt: "A" });
  });

  test("the spec's attributes win over the saved ones, and undefined removes one", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/image",
      { classID: "image-b" },
      '<img class="image-b" src="/a.png" width="1" height="2" alt="x"/>',
    );
    const node = el(
      assemble(prepare(b, ctx)!, {
        attributes: { src: "/b.png", width: undefined, loading: "eager", n: 3, on: true },
      }).nodes[0],
    );
    expect(node.attributes).toEqual({
      src: "/b.png",
      height: "2",
      alt: "x",
      loading: "eager",
      n: 3,
      on: true,
    });
  });

  test("the author's own attributes are written (htmlAttributes), a tooltip is a title", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/div",
      {
        classID: "d5",
        htmlAttributes: [{ name: "data-role", attributeType: "static", value: "banner" }],
      },
      '<div class="d5" data-role="banner" data-tooltip="Hello"></div>',
    );
    const node = el(assemble(prepare(b, ctx)!).nodes[0]);
    expect(node.attributes).toMatchObject({ "data-role": "banner", title: "Hello" });
  });

  test("the id the saved tag prints is an attribute, and the style stays scoped to the classID", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/video",
      { classID: "video-c1", id: "video-x", isStyling: true, paddingTop: { lg: "3px" } },
      '<div id="video-x{idadd}" class="video-c1 cc-vid"></div>',
    );
    const node = el(assemble(prepare(b, ctx)!, { tag: "div" }).nodes[0]);
    expect(node.attributes).toMatchObject({ id: "video-x" });
    expect(node).not.toHaveProperty("id");
    // The build writes a style to `#id` when the element has an `id`, and to the first class otherwise.
    const site = await buildJxProject({
      "layouts/base.json": { children: [{ tagName: "slot" }] },
      "project.json": {
        name: "t",
        url: "https://example.com",
        defaults: { layout: "./layouts/base.json" },
      },
      "pages/index.json": { children: [node] },
    });
    const html = site.html("/");
    expect(html).toMatch(/\.video-c1 \{[^}]*padding-top: 3px/);
    expect(html).not.toContain("#video-x");
    expect(html).toContain('id="video-x"');
  });

  test("an inline style with a binding is the style attribute, not a class rule", async () => {
    const subject: Subject = { kind: "template", slug: "single-service" };
    const ctx = await ctxOf("fineline", subject, { mode: "entry", entryType: "service" });
    const b = await realBlock("fineline", subject, "section-cad9020");
    const env = prepare(b, ctx)!;
    const node = el(assemble(env, { children: [] }).nodes[0]);
    expect(node.attributes?.style).toBe(
      "--background-image:url(${state.entry.data.featuredImage?.src ?? ''})",
    );
    expect(JSON.stringify(node.style ?? {})).not.toContain("${");
  });
});

describe("assemble: visibility", () => {
  test("a condition the entry decides is `hidden` with the rule that makes it win over `display`", async () => {
    const subject: Subject = { kind: "template", slug: "single-project" };
    const ctx = await ctxOf("fineline", subject, { mode: "entry", entryType: "project" });
    const b = await realBlock("fineline", subject, "section-c7ee2ef");
    const env = prepare(b, ctx)!;
    expect(env.visibility.hidden).toBeDefined();
    const node = el(assemble(env, { children: [] }).nodes[0]);
    expect(String(node.attributes?.hidden)).toStartWith("${!(");
    expect(node.style).toMatchObject({ "&[hidden]": { display: "none !important" } });
  });

  test("a device condition is `display: none` at the breakpoint, over whatever the block sets there", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/div",
      {
        classID: "d-dev",
        isStyling: true,
        containerLayoutDisplay: { lg: "flex", md: "flex" },
        hideConditions: [{ condition: "device", operator: "===", data: "desktop" }],
      },
      '<div class="d-dev"></div>',
    );
    const node = el(assemble(prepare(b, ctx)!).nodes[0]);
    expect(node.style).toMatchObject({ display: "flex", "@--md": { display: "none" } });
  });

  test("a block with no classID of its own gets a scope class when it still has a style to carry", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/section",
      { hideConditions: [{ condition: "device", operator: "===", data: "desktop" }] },
      '<section class="cc-sct"></section>',
    );
    const node = el(assemble(prepare(b, ctx)!).nodes[0]);
    expect(node.className).toMatch(/^jx-[0-9a-f]{10} cc-sct$/);
    // And the rule lands on the scope class, not on every section.
    const site = await buildJxProject({
      "layouts/base.json": { children: [{ tagName: "slot" }] },
      "project.json": {
        name: "t",
        url: "https://example.com",
        defaults: { layout: "./layouts/base.json" },
      },
      "pages/index.json": {
        children: [node, { tagName: "section", className: "cc-sct", textContent: "other" }],
      },
    });
    const html = site.html("/");
    expect(html).not.toMatch(/\.cc-sct\s*\{/);
    expect(html).toMatch(/\.jx-[0-9a-f]{10}\s*\{/);
  });

  test("a hidden binding builds: the attribute is present when the condition says hide, with the rule that wins", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/div",
      { classID: "d-h", isStyling: true, containerLayoutDisplay: { lg: "flex" } },
      '<div class="d-h"></div>',
    );
    const node = el(
      assemble(prepare(b, ctx)!, {
        attributes: { hidden: "${!state.show}" },
        style: { "&[hidden]": { display: "none !important" } },
        children: [{ tagName: "i", textContent: "x" }],
      }).nodes[0],
    );
    const site = await buildJxProject({
      "layouts/base.json": { children: [{ tagName: "slot" }] },
      "project.json": {
        name: "t",
        url: "https://example.com",
        defaults: { layout: "./layouts/base.json" },
      },
      "pages/index.json": { state: { show: false }, children: [node] },
    });
    const html = site.html("/");
    expect(html).toMatch(/<div class="d-h" hidden>/);
    expect(html).toContain(".d-h[hidden] { display: none !important }");
  });
});

describe("assemble: links", () => {
  test("a link-wrapped div is the anchor itself, with its destination", async () => {
    const subject: Subject = { kind: "part", slug: "header" };
    const ctx = await ctxOf("fineline", subject);
    const b = await realBlock("fineline", subject, "div-c64faab");
    const node = el(assemble(prepare(b, ctx)!, { tag: "div" }).nodes[0]);
    expect(node.tagName).toBe("a");
    expect(node.attributes).toMatchObject({ href: "/" });
    expect(node.className?.startsWith("div-c64faab")).toBe(true);
  });

  test("a link that opens in a new window carries target and rel", async () => {
    const subject: Subject = { kind: "part", slug: "footer" };
    const ctx = await ctxOf("fineline", subject);
    const b = await realBlock("fineline", subject, "paragraph-cad3963");
    const node = el(assemble(prepare(b, ctx)!, { tag: "p" }).nodes[0]);
    expect(node.tagName).toBe("a");
    expect(node.attributes).toMatchObject({
      href: "https://maps.app.goo.gl/auEPJwMyK8boziqs5",
      target: "_blank",
      rel: "noopener",
    });
  });

  test("a heading's link wraps its content inside the heading", async () => {
    const subject: Subject = { kind: "post", id: 1078 };
    const ctx = await ctxOf("fineline", subject);
    const b = await realBlock("fineline", subject, "heading-c6717e7").catch(() => undefined);
    expect(b).toBeDefined();
    // This heading's saved content is an anchor of its own; a wrapper-linked one is the first of the page.
    const wrapped = await (async () => {
      const loaded = await loadSite("fineline");
      let w: WpBlock | undefined;
      walkBlocks(subjectBlocks(loaded, subject), (x) => {
        if (w === undefined && x.name === "cwicly/heading" && x.attrs.linkWrapperActive === true)
          w = x;
      });
      return w;
    })();
    expect(wrapped).toBeDefined();
    const env = prepare(wrapped!, ctx)!;
    expect(env.link?.anchor).toBe("inner");
    const node = el(assemble(env, { tag: "h3", content: { textContent: "Learn" } }).nodes[0]);
    expect(node.tagName).toBe("h3");
    expect(node).not.toHaveProperty("textContent");
    const anchor = el((node.children as JxNode[])[0]);
    expect(anchor.tagName).toBe("a");
    expect(anchor.textContent).toBe("Learn");
    expect(anchor.attributes).toHaveProperty("href");
    expect(node.attributes).not.toHaveProperty("href");
  });

  test("an empty heading has no anchor to wrap", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/heading",
      { classID: "h-e", linkWrapperActive: true, linkWrapperUrl: "https://example.com/" },
      '<h2 class="h-e"><a href="https://example.com/"></a></h2>',
    );
    const node = el(assemble(prepare(b, ctx)!, { tag: "h2" }).nodes[0]);
    expect(node.children).toBeUndefined();
  });

  test("a lightbox is the link the saved markup wraps around the image", async () => {
    const subject: Subject = { kind: "post", id: 1716 };
    const ctx = await ctxOf("fineline", subject);
    const b = await realBlock("fineline", subject, "image-c6194e7");
    const env = prepare(b, ctx)!;
    expect(env.styling.wrappers).toHaveLength(1);
    const built = assemble(env, { tag: "img", forceTag: "img" });
    const wrapper = el(built.nodes[0]);
    expect(wrapper.tagName).toBe("a");
    expect(wrapper.className).toBe("cc-lightbox");
    expect(String(wrapper.attributes?.href)).toMatch(/^\/media\//);
    expect(el((wrapper.children as JxNode[])[0]).tagName).toBe("img");
    expect(built.element.tagName).toBe("img");
    expect(built.nodes).toHaveLength(1);
  });

  test("a link the saved markup wraps around the image takes the block's destination (hand-made block)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/image",
      {
        classID: "image-aw",
        linkWrapperActive: true,
        linkWrapperUrl: "https://example.com/dest/",
        linkWrapperNewTab: true,
      },
      '<a class="cc-lightbox" href="https://stale.example/old/" data-keep="1"><img class="image-aw" src="/a.png" alt=""/></a>',
    );
    const built = assemble(prepare(b, ctx)!, { forceTag: "img" });
    const wrapper = el(built.nodes[0]);
    expect(wrapper.className).toBe("cc-lightbox");
    expect(wrapper.attributes).toEqual({
      href: "https://example.com/dest/",
      "data-keep": "1",
      target: "_blank",
      rel: "noopener",
    });
  });

  test("a link on an image the saved markup does not wrap is wrapped here (hand-made block)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/image",
      {
        classID: "image-w",
        linkWrapperActive: true,
        linkWrapperUrl: "https://example.com/",
        linkWrapperNewTab: true,
      },
      '<img class="image-w" src="/a.png" alt=""/>',
    );
    const built = assemble(prepare(b, ctx)!, { forceTag: "img" });
    const wrapper = el(built.nodes[0]);
    expect(wrapper.tagName).toBe("a");
    expect(wrapper.attributes).toMatchObject({
      href: "https://example.com/",
      target: "_blank",
      rel: "noopener",
    });
    expect(wrapper).not.toHaveProperty("className");
  });

  test("the hide goes on the image, not on the link around it", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/image",
      {
        classID: "image-wh",
        linkWrapperActive: true,
        linkWrapperUrl: "https://example.com/",
        hideConditions: [{ condition: "device", operator: "===", data: "desktop" }],
      },
      '<img class="image-wh" src="/a.png" alt=""/>',
    );
    const built = assemble(prepare(b, ctx)!, { forceTag: "img" });
    expect(el(built.nodes[0]).style).toBeUndefined();
    expect(el(built.element).style).toMatchObject({ "@--md": { display: "none" } });
  });

  test("a modal opener is a button that targets the modal (the saved anchor cannot open a popover)", async () => {
    const subject: Subject = { kind: "part", slug: "header" };
    const ctx = await ctxOf("ap", subject);
    const b = await realBlock("ap", subject, "icon-toggle");
    const env = prepare(b, ctx)!;
    expect(env.link?.action?.kind).toBe("modal");
    const node = el(assemble(env, { tag: "div" }).nodes[0]);
    expect(node.tagName).toBe("button");
    expect(node.attributes).toMatchObject({
      type: "button",
      popovertarget: "modal-overlay-menu",
      popovertargetaction: "show",
    });
    expect(node.attributes).not.toHaveProperty("href");
    expect(node.attributes).not.toHaveProperty("target");
  });

  test("a modal opener around an image is a button too (hand-made block)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/image",
      {
        classID: "image-m",
        linkWrapperActive: true,
        linkWrapperType: "action",
        linkWrapperAction: "modal",
        linkWrapperActionModalBlockId: "modal-pic",
        linkWrapperActionModalType: "open",
      },
      '<img class="image-m" src="/a.png" alt=""/>',
    );
    const built = assemble(prepare(b, ctx)!, { forceTag: "img" });
    const wrapper = el(built.nodes[0]);
    expect(wrapper.tagName).toBe("button");
    expect(wrapper.attributes).toMatchObject({
      popovertarget: "modal-pic",
      popovertargetaction: "show",
    });
  });

  test("a link that has no destination leaves the anchor without an href", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/button",
      {
        classID: "b-u",
        linkWrapperActive: true,
        linkWrapperType: "action",
        linkWrapperAction: "nextQuery",
      },
      '<a class="b-u" href="">Next</a>',
    );
    const node = el(
      assemble(prepare(b, ctx)!, { tag: "a", content: { textContent: "Next" } }).nodes[0],
    );
    expect(node.tagName).toBe("a");
    expect(node.attributes ?? {}).not.toHaveProperty("href");
    expect(codes(ctx)).toContain("link.unsupported");
  });

  test("a button-tag block has no href and keeps its tag", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/button",
      {
        classID: "b-b",
        containerLayoutTag: "button",
        linkWrapperActive: true,
        linkWrapperType: "action",
        linkWrapperAction: "nextQuery",
      },
      '<button class="b-b">Next</button>',
    );
    const node = el(assemble(prepare(b, ctx)!, { tag: "a" }).nodes[0]);
    expect(node.tagName).toBe("button");
    expect(node.attributes ?? {}).not.toHaveProperty("href");
  });

  test("a button-tag block takes the link's title and label, and still no href", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block(
      "cwicly/button",
      {
        classID: "b-t",
        containerLayoutTag: "button",
        linkWrapperActive: true,
        linkWrapperType: "action",
        linkWrapperAction: "nextQuery",
        linkWrapperTitle: "Next page",
        linkWrapperAriaLabel: "Go to the next page",
      },
      '<button class="b-t">Next</button>',
    );
    const node = el(assemble(prepare(b, ctx)!, { tag: "a" }).nodes[0]);
    expect(node.tagName).toBe("button");
    expect(node.attributes).toEqual({ title: "Next page", "aria-label": "Go to the next page" });
  });

  test("link: none leaves the link to the converter (a gallery's images)", async () => {
    const subject: Subject = { kind: "part", slug: "header" };
    const ctx = await ctxOf("fineline", subject);
    const b = await realBlock("fineline", subject, "div-c64faab");
    const node = el(assemble(prepare(b, ctx)!, { link: "none" }).nodes[0]);
    expect(node.tagName).toBe("a");
    expect(node.attributes ?? {}).not.toHaveProperty("target");
  });

  test("a component's link property is a binding the build leaves out when it is empty", async () => {
    const props = new Map([["A2Qyf", "link"]]);
    const subject: Subject = { kind: "component", ref: "82c1bb8740" };
    const ctx = await ctxOf("ap", subject, { props });
    const loaded = await loadSite("ap");
    const root = subjectBlocks(loaded, subject)[0]!;
    const node = el(assemble(prepare(root, ctx)!, { tag: "div", children: [] }).nodes[0]);
    expect(node.tagName).toBe("a");
    expect(node.attributes).toMatchObject({
      href: "${state.link?.href || false}",
      target: "${state.link?.target || false}",
    });
    const site = await buildJxProject({
      "layouts/base.json": { children: [{ tagName: "slot" }] },
      "project.json": {
        name: "t",
        url: "https://example.com",
        defaults: { layout: "./layouts/base.json" },
      },
      "pages/index.json": { state: { link: { href: "", target: "" } }, children: [node] },
    });
    expect(bodyOf(site.html("/"))).not.toContain("href=");
  });
});

describe("assemble: a Markdown entry", () => {
  /**
   * The selector a rule moved off an element is written for: the classID, then `:where(.jx-<hash of the
   * moved rules>)` (no specificity, but unique to the declarations), then what the nested key said.
   */
  const where = (node: JxElement, rest: string): string => {
    const [first, mark] = (node.className ?? "").split(" ");
    expect(mark).toMatch(/^jx-[0-9a-f]{10}$/);
    return `.${first}:where(.${mark})${rest}`;
  };

  /** A styled block whose rules have every kind of nested key. */
  const rich = block(
    "cwicly/div",
    {
      classID: "div-md",
      isStyling: true,
      paddingTop: { lg: "1px" },
      customCSS:
        ".blockclass a{color:red} .blockclass:hover{color:blue} .blockclass > div{margin:0} .blockclass:is(a){x:1} @media (max-width: 992px){.blockclass svg{width:1px} .blockclass:hover{color:green}}",
    },
    '<div class="div-md"></div>',
  );

  test("a key the directive syntax can spell stays on the element; every other one becomes a rule of the project", async () => {
    const hoisted: { selector: string; style: JxStyle }[] = [];
    const ctx = await ctxOf(
      "fineline",
      { kind: "post", id: 195 },
      { target: "markdown", hoist: (r) => hoisted.push(r) },
    );
    const node = el(assemble(prepare(rich, ctx)!, { children: [] }).nodes[0]);
    const keys = Object.keys(node.style ?? {});
    expect(keys.filter((k) => /[&\s()[\]>]/.test(k))).toEqual([]);
    expect(keys).toContain(":hover");
    expect(keys).toContain("@--md");
    expect(Object.keys((node.style?.["@--md"] ?? {}) as object).some((k) => /[&\s]/.test(k))).toBe(
      false,
    );
    expect(hoisted.map((h) => h.selector).sort()).toEqual(
      [where(node, ":is(a)"), where(node, " a"), where(node, " svg"), where(node, " > div")].sort(),
    );
    expect(hoisted.find((h) => h.selector === where(node, " a"))?.style).toEqual({
      color: "red",
    });
    // A rule inside a breakpoint keeps its breakpoint.
    expect(hoisted.find((h) => h.selector === where(node, " svg"))?.style).toEqual({
      "@--md": { width: "1px" },
    });
    // The classID is still the first class, so the element's own rule stays on `.div-md`.
    expect(node.className?.split(" ")[0]).toBe("div-md");
  });

  test("the elements of a page are not touched: a page can write every key", async () => {
    const hoisted: { selector: string; style: JxStyle }[] = [];
    const page = await ctxOf(
      "fineline",
      { kind: "post", id: 195 },
      { target: "page", hoist: (r) => hoisted.push(r) },
    );
    const node = el(assemble(prepare(rich, page)!, { children: [] }).nodes[0]);
    expect(Object.keys(node.style ?? {})).toContain("& a");
    expect(hoisted.map((h) => h.selector)).toEqual([]);
  });

  test("with nowhere to hoist, the rules stay and the loss is said", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 }, { target: "markdown" });
    delete (ctx as { hoist?: unknown }).hoist;
    const node = el(assemble(prepare(rich, ctx)!, { children: [] }).nodes[0]);
    expect(Object.keys(node.style ?? {})).toContain("& a");
    expect(
      reports(ctx)
        .filter((e) => e.code === "block.hoist-unavailable")
        .map((e) => e.data?.detail),
    ).toContain("div-md|markdown-descendants");
  });

  test("an element with several kinds of rule at one selector hoists one merged rule", async () => {
    const hoisted: { selector: string; style: JxStyle }[] = [];
    const ctx = await ctxOf(
      "fineline",
      { kind: "post", id: 195 },
      { target: "markdown", hoist: (r) => hoisted.push(r) },
    );
    const b = block(
      "cwicly/div",
      {
        classID: "div-mg",
        isStyling: true,
        customCSS: ".blockclass a{color:red} .blockclass a{margin:0}",
      },
      '<div class="div-mg"></div>',
    );
    const node = el(assemble(prepare(b, ctx)!, { children: [] }).nodes[0]);
    expect(hoisted.filter((h) => h.selector === where(node, " a"))).toHaveLength(1);
    expect(hoisted.find((h) => h.selector === where(node, " a"))?.style).toEqual({
      color: "red",
      margin: "0",
    });
  });

  test("a rule on the element itself with a compound class (a component variant) is moved too: `&` is not a key a directive can spell", async () => {
    const hoisted: { selector: string; style: JxStyle }[] = [];
    const subject: Subject = { kind: "component", ref: "0a275b695a" };
    const ctx = await ctxOf("fineline", subject, {
      target: "markdown",
      hoist: (r) => hoisted.push(r),
    });
    const b = await realBlock("fineline", subject, "div-cf3ac5e");
    const node = el(assemble(prepare(b, ctx)!, { children: [] }).nodes[0]);
    expect(Object.keys(node.style ?? {}).filter((k) => k.startsWith("&"))).toEqual([]);
    expect(hoisted.map((h) => h.selector).sort()).toEqual([
      where(node, ".cs-bmuh8n"),
      where(node, ".cs-kxrx4"),
    ]);
    expect(hoisted.find((h) => h.selector === where(node, ".cs-kxrx4"))?.style).toMatchObject({
      flexBasis: "calc(50% - 2rem)",
    });
  });

  test("one selector reached from the style and from a breakpoint is one hoisted rule", async () => {
    const hoisted: { selector: string; style: JxStyle }[] = [];
    const ctx = await ctxOf(
      "fineline",
      { kind: "post", id: 195 },
      { target: "markdown", hoist: (r) => hoisted.push(r) },
    );
    const b = block(
      "cwicly/div",
      {
        classID: "div-mb",
        isStyling: true,
        customCSS: ".blockclass a{color:red} @media (max-width: 992px){.blockclass a{color:blue}}",
      },
      '<div class="div-mb"></div>',
    );
    const node = el(assemble(prepare(b, ctx)!, { children: [] }).nodes[0]);
    const rules = hoisted.filter((h) => h.selector === where(node, " a"));
    expect(rules).toHaveLength(1);
    expect(rules[0]?.style).toEqual({ color: "red", "@--md": { color: "blue" } });
  });

  test("the same classID with different declarations in two entries hoists two different selectors, so neither entry's rule is the other's (fineline gallery-c791a5b in posts 1078 and 5305)", async () => {
    const rulesOf = async (id: number) => {
      const subject: Subject = { kind: "post", id };
      const hoisted: { selector: string; style: JxStyle }[] = [];
      const ctx = await ctxOf("fineline", subject, {
        target: "markdown",
        hoist: (r) => hoisted.push(r),
      });
      const b = await realBlock("fineline", subject, "gallery-c791a5b");
      // The gallery's own grid rule is `& .cc-gallery` in its style.
      const node = el(assemble(prepare(b, ctx)!, { children: [], link: "none" }).nodes[0]);
      return { node, hoisted };
    };
    const a = await rulesOf(1078);
    const b = await rulesOf(5305);
    const grid = (r: { node: JxElement }) => where(r.node, " .cc-gallery");
    const styleA = a.hoisted.find((h) => h.selector === grid(a))?.style;
    const styleB = b.hoisted.find((h) => h.selector === grid(b))?.style;
    expect(JSON.stringify(styleA)).not.toBe(JSON.stringify(styleB));
    expect(grid(a)).not.toBe(grid(b));
    // Both are still `.gallery-c791a5b` first.
    expect(a.node.className?.split(" ")[0]).toBe("gallery-c791a5b");
    expect(b.node.className?.split(" ")[0]).toBe("gallery-c791a5b");
  });

  test("the same declarations moved under different selectors are not the same entry: swapping which descendant gets which colour changes the class", async () => {
    const make = async (css: string): Promise<string> => {
      const ctx = await ctxOf(
        "fineline",
        { kind: "post", id: 195 },
        { target: "markdown", hoist: () => undefined },
      );
      const b = block(
        "cwicly/div",
        { classID: "div-swap", isStyling: true, customCSS: css },
        '<div class="div-swap"></div>',
      );
      return el(assemble(prepare(b, ctx)!, { children: [] }).nodes[0]).className ?? "";
    };
    expect(await make(".blockclass a{color:red} .blockclass svg{color:blue}")).not.toBe(
      await make(".blockclass a{color:blue} .blockclass svg{color:red}"),
    );
  });

  test("equal declarations in two entries are one selector (the project writes the rule once), whatever the order of the keys", async () => {
    const make = (css: string): Promise<{ node: JxElement; hoisted: { selector: string }[] }> =>
      (async () => {
        const hoisted: { selector: string; style: JxStyle }[] = [];
        const ctx = await ctxOf(
          "fineline",
          { kind: "post", id: 195 },
          { target: "markdown", hoist: (r) => hoisted.push(r) },
        );
        const b = block(
          "cwicly/div",
          { classID: "div-same", isStyling: true, customCSS: css },
          '<div class="div-same"></div>',
        );
        const node = el(assemble(prepare(b, ctx)!, { children: [] }).nodes[0]);
        return { node, hoisted };
      })();
    const one = await make(".blockclass a{color:red} .blockclass svg{width:1px}");
    const two = await make(".blockclass svg{width:1px} .blockclass a{color:red}");
    const other = await make(".blockclass a{color:blue} .blockclass svg{width:1px}");
    expect(one.node.className).toBe(two.node.className);
    expect(one.hoisted.map((h) => h.selector).sort()).toEqual(
      two.hoisted.map((h) => h.selector).sort(),
    );
    expect(other.node.className).not.toBe(one.node.className);
  });

  test("the entries of one project build with their own rule each: the two classID twins are told apart in the built CSS", async () => {
    const make = async (color: string) => {
      const hoisted: { selector: string; style: JxStyle }[] = [];
      const ctx = await ctxOf(
        "fineline",
        { kind: "post", id: 195 },
        { target: "markdown", hoist: (r) => hoisted.push(r) },
      );
      const b = block(
        "cwicly/div",
        {
          classID: "div-twin",
          isStyling: true,
          customCSS: `.blockclass a{color:${color}}`,
        },
        '<div class="div-twin"></div>',
      );
      const node = el(
        assemble(prepare(b, ctx)!, { children: [{ tagName: "a", textContent: color }] }).nodes[0],
      );
      return { node, hoisted };
    };
    const red = await make("red");
    const blue = await make("blue");
    const style: Record<string, unknown> = {};
    for (const r of [red, blue]) for (const h of r.hoisted) style[h.selector] = h.style;
    expect(Object.keys(style)).toHaveLength(2);
    const site = await buildJxProject({
      "layouts/base.json": { children: [{ tagName: "slot" }] },
      "project.json": {
        name: "t",
        url: "https://example.com",
        defaults: { layout: "./layouts/base.json" },
        style,
      },
      "pages/index.json": { children: [red.node, blue.node] },
    });
    const html = site.html("/");
    const rule = (color: string): string =>
      new RegExp(`(\\.div-twin:where\\(\\.jx-[0-9a-f]{10}\\) a)\\s*\\{[^}]*color: ${color}`).exec(
        html,
      )?.[1] ?? "";
    expect(rule("red")).not.toBe("");
    expect(rule("blue")).not.toBe("");
    expect(rule("red")).not.toBe(rule("blue"));
    expect(html).toContain(`class="${red.node.className}"`);
    expect(html).toContain(`class="${blue.node.className}"`);
  });

  test("an element whose first class is already a generated scope takes no second one: it is unique to its declarations", async () => {
    const hoisted: { selector: string; style: JxStyle }[] = [];
    const ctx = await ctxOf(
      "fineline",
      { kind: "post", id: 195 },
      { target: "markdown", hoist: (r) => hoisted.push(r) },
    );
    const out = shapeElement(
      ctx,
      {
        tag: "a",
        className: "cc-lightbox",
        attributes: {},
        inlineStyle: { position: "relative", "& a": { color: "red" } } as JxStyle,
      },
      { block: block("cwicly/image", { classID: "image-s" }) },
    );
    const scope = (out.className ?? "").split(" ")[0] ?? "";
    expect(scope).toMatch(/^jx-[0-9a-f]{10}$/);
    expect(out.className).toBe(`${scope} cc-lightbox`);
    expect(hoisted.map((h) => h.selector)).toEqual([`.${scope} a`]);
    expect(Object.keys(out.style ?? {})).toEqual(["position"]);
  });

  test("the hidden rule of an element that has a scope class goes on that class", async () => {
    const hoisted: { selector: string; style: JxStyle }[] = [];
    const ctx = await ctxOf(
      "fineline",
      { kind: "post", id: 195 },
      { target: "markdown", hoist: (r) => hoisted.push(r) },
    );
    const b = block(
      "cwicly/section",
      { hideConditions: [{ condition: "device", operator: "===", data: "desktop" }] },
      '<section class="cc-sct"></section>',
    );
    const node = el(assemble(prepare(b, ctx)!).nodes[0]);
    expect(node.style).toEqual({ "@--md": { display: "none" } });
    expect(hoisted).toEqual([]);
  });

  test("a lightbox link keeps working: the wrapper's own rules are moved the same way", async () => {
    const hoisted: { selector: string; style: JxStyle }[] = [];
    const ctx = await ctxOf(
      "fineline",
      { kind: "post", id: 1716 },
      { target: "markdown", hoist: (r) => hoisted.push(r) },
    );
    const b = await realBlock("fineline", { kind: "post", id: 1716 }, "image-c6194e7");
    const built = assemble(prepare(b, ctx)!, { forceTag: "img" });
    const wrapper = el(built.nodes[0]);
    expect(wrapper.tagName).toBe("a");
    expect(JSON.stringify(wrapper.style ?? {})).not.toMatch(/&/);
  });
});

describe("assemble: the elements the saved markup puts around the block", () => {
  test("several wrappers nest in the order the saved markup has them, outermost first, the styled element innermost", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const b = block("cwicly/div", { classID: "d-w" }, '<div class="d-w"></div>');
    const env = prepare(b, ctx)!;
    const wrapped = {
      ...env,
      styling: {
        ...env.styling,
        wrappers: [
          { tag: "section", className: "cc-mdl", attributes: {} },
          { tag: "article", className: "cc-mdl-container", attributes: {} },
          { tag: "aside", className: "cc-mdl-inner", attributes: {} },
        ],
      },
    };
    const built = assemble(wrapped, { tag: "div" });
    expect(built.nodes).toHaveLength(1);
    const chain: string[] = [];
    let node: JxNode | undefined = built.nodes[0];
    while (node !== undefined && typeof node !== "string") {
      chain.push(String(node.tagName));
      const next: JxNode | undefined = Array.isArray(node.children) ? node.children[0] : undefined;
      node = next;
    }
    expect(chain).toEqual(["section", "article", "aside", "div"]);
    expect(built.element.className).toBe("d-w");
  });
});

describe("shapeElement", () => {
  test("a saved element with a rule of its own keeps its class first and needs no scope", async () => {
    const ctx = await ctxOf("ap", { kind: "template", slug: "single-episode" });
    const shape = {
      tag: "div",
      className: "section-x-wrapper cc-wrapper",
      attributes: {},
      style: { display: "flex" },
    };
    expect(shapeElement(ctx, shape)).toEqual({
      tagName: "div",
      className: "section-x-wrapper cc-wrapper",
      style: { display: "flex" },
    });
  });

  test("an inline style beats the rule the stylesheets give the element (on the page the inline style won)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const out = shapeElement(ctx, {
      tag: "div",
      className: "image-x-wrapper",
      attributes: {},
      style: { color: "red", margin: "0" },
      inlineStyle: { color: "blue" },
    });
    expect(out.style).toEqual({ color: "blue", margin: "0" });
  });

  test("an inline style on a shared class gets a scope class (the rule would reach every element with it)", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const out = shapeElement(ctx, {
      tag: "div",
      className: "cc-lightbox",
      attributes: {},
      inlineStyle: { position: "relative" },
    });
    expect(out.className).toMatch(/^jx-[0-9a-f]{10} cc-lightbox$/);
  });

  test("addresses move and the extra attributes and children are added", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    const out = shapeElement(
      ctx,
      {
        tag: "a",
        className: "cc-lightbox",
        attributes: { href: "https://finelinepainting.pro/residential/", "data-x": "1" },
      },
      { attributes: { target: "_blank" }, children: [{ tagName: "img" }] },
    );
    expect(out.attributes).toEqual({ href: "/residential/", "data-x": "1", target: "_blank" });
    expect(out.children).toEqual([{ tagName: "img" }]);
  });

  test("an element with nothing to say is only its tag", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    expect(shapeElement(ctx, { tag: "span", className: "", attributes: {} })).toEqual({
      tagName: "span",
    });
  });
});

describe("buildBlock", () => {
  test("make is called with the environment, and only for a block that is shown", async () => {
    const ctx = await ctxOf("fineline", { kind: "post", id: 195 });
    let calls = 0;
    const hidden = block(
      "cwicly/div",
      { classID: "d-no", hideGuest: true },
      '<div class="d-no"></div>',
    );
    expect(buildBlock(hidden, ctx, () => (calls++, {}))).toEqual([]);
    expect(calls).toBe(0);
    const shown = block("cwicly/div", { classID: "d-yes" }, '<div class="d-yes"></div>');
    const nodes = buildBlock(shown, ctx, (env) => {
      calls++;
      expect(env.styling.classID).toBe("d-yes");
      return { children: [{ tagName: "b" }] };
    });
    expect(calls).toBe(1);
    expect(el(nodes[0]).children).toEqual([{ tagName: "b" }]);
  });
});

describe("the whole corpus", () => {
  test("every block of both sites that has an element builds a root whose first class is its classID", async () => {
    let checked = 0;
    for (const site of ["fineline", "ap"] as const) {
      const loaded = await loadSite(site);
      for (const subject of allSubjects(loaded)) {
        const blocks = subjectBlocks(loaded, subject);
        if (blocks.length === 0) continue;
        const ctx = await ctxOf(site, subject);
        walkBlocks(blocks, (b) => {
          if (!b.name?.startsWith("cwicly/") || b.name === "cwicly/component") return;
          const classID = text(b.attrs.classID);
          if (classID === undefined || !b.attrs.isStyling || b.innerHTML.trim() === "") return;
          const env = prepare(b, ctx);
          if (!env) return;
          const built = assemble(env);
          const first = (built.element.className ?? "").split(" ")[0];
          // A saved tag that does not print the classID is the editor's own rule (`isStyling` unset on the live page).
          if (env.styling.className.split(" ").includes(classID)) {
            expect(first).toBe(classID);
            checked++;
          }
        });
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  test("parseBlocks and the helpers agree on what a freeform block is", () => {
    expect(parseBlocks("<p>x</p>").map((b) => baseName(b))).toEqual(["freeform"]);
  });
});

// A parse of the built HTML is how the tests above that build read their pages.
void parseFragment;
void blockLink;

describe("paragraphValue", () => {
  /** What the binding prints for a value, as the build evaluates it. */
  const printed = (binding: string, state: unknown): unknown =>
    new Function("state", `return \`${binding.replace(/^\$\{/, "${").replaceAll("`", "\\`")}\`;`)(
      state,
    );

  test("a paragraph's last closing tag is left to the box that holds it", () => {
    const binding = paragraphValue("${state.entry.data.description ?? ''}");
    const html = (v: string) => printed(binding, { entry: { data: { description: v } } });
    // `<p>` + `<p>a</p>` + `</p>` would open an empty paragraph after the text (the plugin's page has none).
    expect(html("<p>a</p>\n")).toBe("<p>a");
    expect(html("<p>a</p><p>b</p>")).toBe("<p>a</p><p>b");
    expect(html('  <p class="x">a</p>')).toBe('  <p class="x">a');
    expect(html("plain text")).toBe("plain text");
    // Only a value that opens a paragraph of its own closes the box that holds it.
    expect(html("a</p>")).toBe("a</p>");
    expect(html("<strong>bold</strong>")).toBe("<strong>bold</strong>");
    expect(html("")).toBe("");
  });

  test("the browser then reads the same boxes as the plugin's markup", () => {
    const binding = paragraphValue("${state.v}");
    const wrapped = `<p>${printed(binding, { v: "<p>a</p>\n" })}</p>`;
    const paragraphs = (markup: string): string[] =>
      [...parseFragment(markup).childNodes]
        .filter((n) => n.nodeName === "p")
        .map((n) =>
          ("childNodes" in n ? (n.childNodes as { value?: string }[]) : [])
            .map((c) => c.value ?? "")
            .join(""),
        );
    expect(paragraphs(wrapped)).toEqual(paragraphs("<p></p><p>a</p>"));
    // What it replaces printed a third, empty box.
    expect(paragraphs("<p><p>a</p>\n</p>")).toHaveLength(3);
  });

  test("a binding that is not one whole value, and text that is not a binding, are kept", () => {
    expect(paragraphValue("<strong>Tags:</strong> ")).toBe("<strong>Tags:</strong> ");
    expect(paragraphValue("Tags ${state.a} and ${state.b}")).toBe("Tags ${state.a} and ${state.b}");
    expect(paragraphValue("${`x ${state.a}`}")).toBe("${`x ${state.a}`}");
  });

  test("real: the episode's description paragraph gives up its closing tag; a heading that prints the same field does not", async () => {
    const subject: Subject = { kind: "template", slug: "single-episode" };
    const ctx = await ctxOf("ap", subject, { mode: "entry", entryType: "episode" });
    const b = await realBlock("ap", subject, "paragraph-cb35144");
    const p = el(ctx.convert([b])[0]);
    expect(p.tagName).toBe("p");
    expect(p.innerHTML).toBe(paragraphValue("${state.entry.data.description ?? ''}"));
    const same = (tag: string) =>
      el(
        assemble(prepare(b, ctx)!, {
          forceTag: tag,
          content: { innerHTML: "${state.entry.data.description}" },
        }).nodes[0],
      ).innerHTML;
    expect(same("p")).toBe(paragraphValue("${state.entry.data.description}"));
    expect(same("h3")).toBe("${state.entry.data.description}");
  });
});
