import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseFragment, serialize } from "parse5";
import { convertCoreBlock } from "../../src/core/blocks.ts";
import {
  contentOptions,
  elementsOf,
  htmlContent,
  htmlNodes,
  note,
  rewriteMarkup,
  staticBlock,
  targetOf,
  whereOf,
} from "../../src/core/static.ts";
import { htmlToNodes, nodesToHtml } from "../../src/html.ts";
import type { ConvertCtx, JxElement, JxNode, WpBlock } from "../../src/types.ts";
import { parseBlocks, walkBlocks } from "../../src/wp/blocks.ts";
import { allSubjects, loadSite, makeCtx, subjectBlocks, subjectPost } from "../helpers/ctx.ts";
import type { SiteName, Subject } from "../helpers/ctx.ts";
import { decodeEntities, publicUrl } from "../../src/wp/model.ts";

// The corpus sweeps take seconds each, more on a busy machine.
setDefaultTimeout(120_000);

// Real subjects: a fineline page (JSON page target), a fineline post and an ap post (Markdown entries).
const FL_PAGE: Subject = { kind: "post", id: 3483 };
const FL_POST: Subject = { kind: "post", id: 2602 };
const AP_POST: Subject = { kind: "post", id: 8819 };

/** A converter for the inner blocks of a test: one `p` per block, so a stitched position is visible. */
const stubConvert =
  (text = "inner"): ConvertCtx["convert"] =>
  (blocks) =>
    blocks.map((): JxNode => ({ tagName: "p", textContent: text }));

/** A block built by hand around the positions the parser would give it. */
const block = (
  innerContent: (string | null)[],
  innerBlocks: WpBlock[] = [],
  name: string | null = "core/group",
): WpBlock => ({
  name,
  attrs: {},
  innerBlocks,
  innerHTML: innerContent.filter((part): part is string => part !== null).join(""),
  innerContent,
});

const paragraph = (): WpBlock =>
  parseBlocks(`<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->`)[0]!;

/** A context that records every address it is asked about and moves it somewhere recognisable. */
async function spyCtx(subject: Subject = FL_PAGE, site: SiteName = "fineline") {
  const asked: string[] = [];
  const askedMedia: string[] = [];
  const ctx = await makeCtx(site, subject, {
    rewriteUrl: (url) => {
      asked.push(url);
      return `/r${url.replace(/^(?:https?:)?\/\/[^/]+/, "")}`;
    },
    mediaForUrl: (url) => {
      askedMedia.push(url);
      return url.endsWith("/known.jpg")
        ? { src: "/media/known.jpg", width: 800, height: 600, alt: "a" }
        : undefined;
    },
  });
  return { ctx, asked, askedMedia };
}

const el = (nodes: JxNode[], at = 0): JxElement => {
  const node = nodes[at];
  if (typeof node === "string" || node === undefined) throw new Error(`no element at ${at}`);
  return node;
};

// ── What a conversion is for ─────────────────────────────────────────────────────────────────────

describe("targetOf / whereOf / note", () => {
  test("a page is a JSON page, a post and a custom post type are Markdown entries", async () => {
    expect(targetOf(await makeCtx("fineline", FL_PAGE))).toBe("page");
    expect(targetOf(await makeCtx("fineline", FL_POST))).toBe("markdown");
    expect(targetOf(await makeCtx("fineline", { kind: "post", id: 1613 }))).toBe("markdown"); // project
  });

  test("templates, parts, components and reusable blocks are documents, never entries", async () => {
    const site = await loadSite("ap");
    const part = allSubjects(site).find((s) => s.kind === "part")!;
    const template = allSubjects(site).find((s) => s.kind === "template")!;
    const reusable = allSubjects(site).find((s) => s.kind === "reusable")!;
    for (const subject of [part, template, reusable]) {
      expect(targetOf(await makeCtx("ap", subject))).toBe("page");
    }
  });

  test("an explicit target on the context wins; a subject with no post is a page", async () => {
    const ctx = await makeCtx("fineline", FL_POST);
    expect(targetOf({ ...ctx, target: "page" } as ConvertCtx)).toBe("page");
    expect(
      targetOf({ ...(await makeCtx("fineline", FL_PAGE)), target: "markdown" } as ConvertCtx),
    ).toBe("markdown");
    expect(targetOf({ ...ctx, subject: { kind: "post", id: "1" } })).toBe("page");
  });

  test("whereOf names the subject the way the report locates it", async () => {
    expect(whereOf(await makeCtx("fineline", FL_PAGE))).toBe("post:3483");
    const site = await loadSite("fineline");
    const part = allSubjects(site).find((s) => s.kind === "part")!;
    expect(whereOf(await makeCtx("fineline", part))).toMatch(/^template:cwicly\/\//);
  });

  test("note adds an entry at the subject, with its public URL and data", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    note(ctx, "warn", "block.test", "hello", { block: "core/x" });
    note(ctx, "info", "block.test-bare", "no data");
    const [first, second] = ctx.report.entries();
    expect(first).toMatchObject({
      severity: "warn",
      code: "block.test",
      message: "hello",
      where: "post:3483",
      data: { block: "core/x" },
    });
    expect(first!.url).toBe(publicUrl(ctx.model.site, ctx.subject.post!));
    expect(first!.url).toStartWith("https://finelinepainting.pro/");
    expect(second!.data).toBeUndefined();
  });

  test("a subject without a post reports no URL", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    const { post: _post, ...subject } = ctx.subject;
    note({ ...ctx, subject }, "info", "block.test", "x");
    expect(ctx.report.entries()[0]!.url).toBeUndefined();
  });
});

// ── Addresses ────────────────────────────────────────────────────────────────────────────────────

describe("rewriteMarkup: addresses", () => {
  test("every attribute that holds an address goes through rewriteUrl, each once", async () => {
    const { ctx, asked } = await spyCtx();
    const html =
      `<a href="https://finelinepainting.pro/a/">a</a>` +
      `<area href="/b/">` +
      `<link href="https://x.test/c.css">` +
      `<video src="https://x.test/v.mp4" poster="https://x.test/p.jpg"></video>` +
      `<audio src="/d.mp3"></audio>` +
      `<video><source src="/e.mp4"><track src="/f.vtt"></video>` +
      `<iframe src="https://www.youtube.com/embed/x"></iframe>` +
      `<embed src="/g.swf"><object data="/h.pdf"></object>` +
      `<form action="/i/"></form><input type="image" src="/j.png"><script src="/k.js"></script>`;
    rewriteMarkup(html, ctx);
    expect(asked.sort()).toEqual(
      [
        "https://finelinepainting.pro/a/",
        "/b/",
        "https://x.test/c.css",
        "https://x.test/v.mp4",
        "https://x.test/p.jpg",
        "/d.mp3",
        "/e.mp4",
        "/f.vtt",
        "https://www.youtube.com/embed/x",
        "/g.swf",
        "/h.pdf",
        "/i/",
        "/j.png",
        "/k.js",
      ].sort(),
    );
  });

  test("the rewritten address is what the markup holds afterwards", async () => {
    const { ctx } = await spyCtx();
    const out = rewriteMarkup(`<a href="https://finelinepainting.pro/about-us/#t">x</a>`, ctx);
    expect(out).toBe(`<a href="/r/about-us/#t">x</a>`);
  });

  test("fragments, mail and phone links, data and script URLs and bare relative paths are not addresses", async () => {
    const { ctx, asked } = await spyCtx();
    rewriteMarkup(
      `<a href="#top">1</a><a href="mailto:a@b.c">2</a><a href="tel:+1555">3</a>` +
        `<a href="javascript:void(0)">4</a><img src="data:image/gif;base64,R0lGOD"><a href="page.html">5</a>` +
        `<a href="  ">6</a><a href="">7</a><a href="sms:1">8</a>`,
      ctx,
    );
    expect(asked).toEqual([]);
  });

  test("a protocol-relative address is asked about; a surrounding space is trimmed first", async () => {
    const { ctx, asked } = await spyCtx();
    const out = rewriteMarkup(`<a href=" //cdn.test/x ">x</a>`, ctx);
    expect(asked).toEqual(["//cdn.test/x"]);
    expect(out).toContain(`href="/r/x"`);
  });

  test("an img src that the media plan knows becomes the plan's path, and gains its size", async () => {
    const { ctx, askedMedia } = await spyCtx();
    const out = rewriteMarkup(`<img src="https://x.test/known.jpg" alt="a">`, ctx);
    expect(askedMedia).toEqual(["https://x.test/known.jpg"]);
    expect(out).toBe(`<img src="/media/known.jpg" alt="a" width="800" height="600">`);
  });

  test("the markup's own width or height says how big the image is shown and wins over the plan's", async () => {
    const { ctx } = await spyCtx();
    expect(rewriteMarkup(`<img src="https://x.test/known.jpg" width="120">`, ctx)).toBe(
      `<img src="/media/known.jpg" width="120">`,
    );
    expect(rewriteMarkup(`<img src="https://x.test/known.jpg" height="90">`, ctx)).toBe(
      `<img src="/media/known.jpg" height="90">`,
    );
  });

  test("an img the plan does not know goes through rewriteUrl like any address", async () => {
    const { ctx, asked } = await spyCtx();
    expect(rewriteMarkup(`<img src="https://x.test/other.jpg">`, ctx)).toBe(
      `<img src="/r/other.jpg">`,
    );
    expect(asked).toEqual(["https://x.test/other.jpg"]);
  });

  test("a plan entry without a size gives the path only", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE, {
      mediaForUrl: () => ({ src: "/media/s.svg" }),
    });
    expect(rewriteMarkup(`<img src="https://x.test/s.svg">`, ctx)).toBe(`<img src="/media/s.svg">`);
  });

  test("an img's srcset and sizes are dropped, because the build writes its own", async () => {
    const { ctx, asked } = await spyCtx();
    const out = rewriteMarkup(
      `<img src="https://x.test/known.jpg" srcset="https://x.test/known-300x200.jpg 300w, https://x.test/known.jpg 800w" sizes="(max-width: 800px) 100vw, 800px">`,
      ctx,
    );
    expect(out).not.toContain("srcset");
    expect(out).not.toContain("sizes");
    expect(asked).toEqual([]);
  });

  test("a source element's srcset keeps its descriptors and has every candidate rewritten", async () => {
    const { ctx } = await spyCtx();
    const out = rewriteMarkup(
      `<picture><source srcset="https://x.test/a.webp 1x, /b.webp 2x,  , https://x.test/c.webp"><img src="/z.jpg"></picture>`,
      ctx,
    );
    expect(out).toContain(`srcset="/r/a.webp 1x, /r/b.webp 2x, , /r/c.webp"`);
  });

  test("a link that opens a new window gets rel=noopener, once, keeping the rel it has", async () => {
    const { ctx } = await spyCtx();
    expect(rewriteMarkup(`<a href="/x" target="_blank">x</a>`, ctx)).toContain(`rel="noopener"`);
    expect(rewriteMarkup(`<a href="/x" target="_BLANK" rel="nofollow">x</a>`, ctx)).toContain(
      `rel="nofollow noopener"`,
    );
    expect(
      rewriteMarkup(`<a href="/x" target="_blank" rel="NoOpener noreferrer">x</a>`, ctx),
    ).toContain(`rel="NoOpener noreferrer"`);
    expect(rewriteMarkup(`<a href="/x" target="_self">x</a>`, ctx)).not.toContain("rel=");
    expect(rewriteMarkup(`<a href="/x">x</a>`, ctx)).not.toContain("rel=");
  });

  test("CSS url() in a style attribute goes through the media plan, then rewriteUrl", async () => {
    const { ctx, asked } = await spyCtx();
    const out = rewriteMarkup(
      `<div style="background-image:url(https://x.test/known.jpg);border-image:url('https://x.test/b.png') 1"></div>`,
      ctx,
    );
    expect(out).toContain("url(/media/known.jpg)");
    expect(out).toContain("/r/b.png");
    expect(asked).toEqual(["https://x.test/b.png"]);
  });

  test("CSS url() inside a style element is rewritten too; a style without url() is untouched", async () => {
    const { ctx } = await spyCtx();
    const out = rewriteMarkup(
      `<style>.a{background:url("https://x.test/known.jpg")}.b{color:red}</style><p style="color:red">x</p>`,
      ctx,
    );
    expect(out).toContain(`url("/media/known.jpg")`);
    expect(out).toContain(`.b{color:red}`);
    expect(out).toContain(`style="color:red"`);
  });

  test("a style with a url() that needs no change is left as written", async () => {
    const { ctx } = await spyCtx();
    const css = `background:url(data:image/png;base64,AAAA) no-repeat`;
    expect(rewriteMarkup(`<div style="${css}"></div>`, ctx)).toContain(css);
  });

  test("addresses inside a template element and inside nested markup are reached", async () => {
    const { ctx, asked } = await spyCtx();
    rewriteMarkup(
      `<template><a href="/in-template/">t</a></template><div><ul><li><a href="/deep/">d</a></li></ul></div>`,
      ctx,
    );
    expect(asked.sort()).toEqual(["/deep/", "/in-template/"]);
  });

  test("an svg's own links are not addresses of the site", async () => {
    const { ctx, asked } = await spyCtx();
    rewriteMarkup(`<svg><a href="/not-html"><path d="M0"/></a></svg>`, ctx);
    expect(asked).toEqual([]);
  });

  test("text with no markup is returned as it is", async () => {
    const { ctx } = await spyCtx();
    expect(rewriteMarkup("plain text & more", ctx)).toBe("plain text & more");
  });

  test("with real data: a fineline uploads URL becomes its /media path at the size of the file it named; the origin of an internal link is dropped", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    const site = await loadSite("fineline");
    const attachment = site.model.attachments.get(2173)!;
    const sized = attachment.sizes.find((s) => s.name === "large")!;
    const dir = attachment.file.replace(/[^/]+$/, "");
    const thumbnail = `https://finelinepainting.pro/wp-content/uploads/${dir}${sized.file}`;
    const out = rewriteMarkup(
      `<img src="${thumbnail}" srcset="${thumbnail} 1024w" sizes="100vw"><a href="https://finelinepainting.pro/about-us/">x</a>`,
      ctx,
    );
    expect(out).toBe(
      `<img src="/media/${attachment.file}" width="${sized.width}" height="${sized.height}"><a href="/about-us/">x</a>`,
    );
  });

  test("with real data: an ap upload on the CDN host resolves, an external link stays", async () => {
    const ctx = await makeCtx("ap", AP_POST);
    const site = await loadSite("ap");
    const attachment = [...site.model.attachments.values()].find(
      (a) => a.mime.startsWith("image/") && a.url.includes("media.anabaptistperspectives.org"),
    )!;
    const out = rewriteMarkup(
      `<img src="${attachment.url}"><a href="https://example.org/x">x</a>`,
      ctx,
    );
    expect(out).toContain(`src="/media/`);
    expect(out).not.toContain("media.anabaptistperspectives.org");
    expect(out).toContain(`href="https://example.org/x"`);
  });
});

describe("rewriteMarkup: the root element", () => {
  test("classes are added once, after the ones the markup has", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    expect(
      rewriteMarkup(`<div class="a b"><p class="b">x</p></div>`, ctx, {
        classes: ["b", "c", false, undefined, "d"],
      }),
    ).toBe(`<div class="a b c d"><p class="b">x</p></div>`);
  });

  test("a root with no class gets one", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    expect(rewriteMarkup(`<p>x</p>`, ctx, { classes: ["wp-block-paragraph"] })).toBe(
      `<p class="wp-block-paragraph">x</p>`,
    );
  });

  test("the root is the first ELEMENT: leading text and comments are not it", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    expect(rewriteMarkup(`\n<!-- c -->\n<p>x</p><p>y</p>`, ctx, { classes: ["k"] })).toBe(
      `\n<!-- c -->\n<p class="k">x</p><p>y</p>`,
    );
  });

  test("a declaration the markup already has is not overridden; a new one is added after", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    expect(
      rewriteMarkup(`<div style="color:red;"></div>`, ctx, {
        style: [
          ["color", "blue"],
          ["margin", "0"],
        ],
      }),
    ).toBe(`<div style="color:red;margin:0"></div>`);
    expect(rewriteMarkup(`<div></div>`, ctx, { style: [["margin", "0"]] })).toBe(
      `<div style="margin:0"></div>`,
    );
  });

  test("an attribute the markup already has is not overridden", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    expect(
      rewriteMarkup(`<div id="mine"></div>`, ctx, { attributes: { id: "theirs", role: "x" } }),
    ).toBe(`<div id="mine" role="x"></div>`);
  });

  test("empty changes leave the markup exactly as it was", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    expect(rewriteMarkup(`<div class="a">x</div>`, ctx, { classes: [], style: [] })).toBe(
      `<div class="a">x</div>`,
    );
    expect(rewriteMarkup(`<div>x</div>`, ctx, { classes: [false] })).toBe(`<div>x</div>`);
  });
});

// ── htmlNodes / htmlContent ──────────────────────────────────────────────────────────────────────

describe("htmlNodes / htmlContent", () => {
  test("a page keeps an inline style as an object, scoped by a generated first class", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    const node = el(htmlNodes(`<p class="x" style="color:red">a</p>`, ctx));
    expect(node.style).toEqual({ color: "red" });
    expect(node.className).toMatch(/^jx-[0-9a-f]{10} x$/);
  });

  test("inlineStyle: attribute keeps the declaration where the source had it, on a page", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    const node = el(
      htmlNodes(`<p class="x" style="color:red">a</p>`, ctx, { inlineStyle: "attribute" }),
    );
    expect(node.style).toBeUndefined();
    expect(node.attributes?.style).toBe("color:red");
    expect(node.className).toBe("x");
  });

  test("a Markdown entry cannot hold an attribute style: the option does not apply there", async () => {
    const ctx = await makeCtx("fineline", FL_POST);
    const node = el(htmlNodes(`<p style="color:red">a</p>`, ctx, { inlineStyle: "attribute" }));
    expect(node.style).toEqual({ color: "red" });
    expect(node.attributes?.style).toBeUndefined();
  });

  test("scopeStyle: false leaves an element that has a class and a style on that class", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    const node = el(htmlNodes(`<p class="x" style="color:red">a</p>`, ctx, { scopeStyle: false }));
    expect(node.className).toBe("x");
  });

  test("loose inline siblings on a page are carried by one display:contents element, whose build adds no gap", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    const nodes = htmlNodes(`<b>x</b>.`, ctx);
    expect(nodes).toEqual([
      { tagName: "div", style: { display: "contents" }, innerHTML: "<b>x</b>." },
    ]);
  });

  test("the same markup in a Markdown entry stays structured, because the serializer writes no innerHTML", async () => {
    const ctx = await makeCtx("fineline", FL_POST);
    expect(htmlNodes(`<b>x</b>.`, ctx)).toEqual([{ tagName: "b", textContent: "x" }, "."]);
  });

  test("blocks, and a single inline element, need no wrapper", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    expect(htmlNodes(`<p>a</p><p>b</p>`, ctx)).toHaveLength(2);
    expect(htmlNodes(`<b>only</b>`, ctx)).toEqual([{ tagName: "b", textContent: "only" }]);
  });

  test("conversion findings are reported at the subject, once", async () => {
    const ctx = await makeCtx("fineline", FL_POST);
    htmlNodes(`<script>var a = 1;</script>`, ctx);
    const entries = ctx.report.entries().filter((e) => e.code === "html.innerhtml-unserialisable");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.where).toBe("post:2602");
    expect(entries[0]!.url).toBe(publicUrl(ctx.model.site, ctx.subject.post!));
  });

  test("htmlContent is the content half of an element, with addresses rewritten", async () => {
    const { ctx } = await spyCtx();
    expect(htmlContent(`plain`, ctx)).toEqual({ textContent: "plain" });
    const content = htmlContent(`see <a href="https://x.test/a">this</a>`, ctx);
    expect(content.children ?? content.innerHTML).toBeDefined();
    expect(JSON.stringify(content)).toContain("/r/a");
    expect(htmlContent(`<b>x</b>.`, ctx)).toEqual({ innerHTML: "<b>x</b>." });
  });

  test("htmlContent applies the root changes to the first element", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    const content = htmlContent(`<b>x</b>`, ctx, { root: { classes: ["k"] } });
    expect(JSON.stringify(content)).toContain(`"className":"k"`);
  });

  test("elementsOf skips loose text", () => {
    const nodes: JxNode[] = ["a", { tagName: "p" }, " ", { tagName: "b" }];
    expect(elementsOf(nodes).map((n) => n.tagName)).toEqual(["p", "b"]);
  });
});

// ── Inner blocks ─────────────────────────────────────────────────────────────────────────────────

describe("staticBlock: inner blocks", () => {
  test("each null of innerContent is replaced by what ctx.convert made of that inner block", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    const seen: WpBlock[][] = [];
    ctx.convert = (blocks) => {
      seen.push(blocks);
      return [{ tagName: "p", textContent: `#${seen.length}` }];
    };
    const nodes = staticBlock(
      block(['<div class="g">', null, "<hr>", null, "</div>"], [paragraph(), paragraph()]),
      ctx,
    );
    expect(nodesToHtml(nodes)).toBe(`<div class="g"><p>#1</p><hr><p>#2</p></div>`);
    expect(seen.map((s) => s.length)).toEqual([1, 1]);
  });

  test("a converter that returns several nodes, or none, is placed as it returned", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    const results: JxNode[][] = [[{ tagName: "i" }, { tagName: "b" }], [], ["text"]];
    let at = 0;
    ctx.convert = () => results[at++]!;
    const nodes = staticBlock(
      block(["<section>", null, null, null, "</section>"], [paragraph(), paragraph(), paragraph()]),
      ctx,
    );
    expect(el(nodes).children).toEqual([{ tagName: "i" }, { tagName: "b" }, "text"]);
  });

  test("the parent's elements nest around the markers as a browser would build them", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    ctx.convert = stubConvert();
    const nodes = staticBlock(
      block(['<div class="a"><div class="b">', null, "</div></div>"], [paragraph()]),
      ctx,
    );
    expect(el(el(nodes).children as JxNode[]).className).toBe("b");
    expect(nodesToHtml(nodes)).toBe(`<div class="a"><div class="b"><p>inner</p></div></div>`);
  });

  test("a marker among list items, in a table or in a definition list keeps its place", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    ctx.convert = () => [{ tagName: "li", textContent: "item" }];
    const nodes = staticBlock(
      block(['<ul class="wp-block-list">', null, null, "</ul>"], [paragraph(), paragraph()]),
      ctx,
    );
    expect(nodesToHtml(nodes)).toBe(`<ul class="wp-block-list"><li>item</li><li>item</li></ul>`);
  });

  test("an inner block with no null for it (a block built without innerContent) goes at the end", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    ctx.convert = stubConvert();
    const bare = { ...block(["<div>x</div>"], [paragraph()]) } as Partial<WpBlock>;
    delete bare.innerContent;
    const nodes = staticBlock(bare as WpBlock, ctx);
    expect(nodesToHtml(nodes)).toBe(`<div>x</div><p>inner</p>`);
    expect(ctx.report.entries()).toHaveLength(0);
  });

  test("more inner blocks than nulls: the extra ones follow the markup, unreported (they are placed)", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    ctx.convert = stubConvert();
    const nodes = staticBlock(block(["<div>", null, "</div>"], [paragraph(), paragraph()]), ctx);
    expect(nodesToHtml(nodes)).toBe(`<div><p>inner</p></div><p>inner</p>`);
    expect(ctx.report.entries()).toHaveLength(0);
  });

  test("an inner block's marker that the parser keeps as text is appended, reported, and leaves no marker behind", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    ctx.convert = stubConvert();
    for (const parts of [
      ["<textarea>", null, "</textarea>"],
      ["<script>", null, "</script>"],
      ["<style>", null, "</style>"],
      ["<svg>", null, "</svg>"],
    ] as const) {
      const nodes = staticBlock(block([...parts], [paragraph()]), ctx);
      expect(JSON.stringify(nodes)).not.toContain("wp2jx-inner");
      expect(nodes.at(-1)).toEqual({ tagName: "p", textContent: "inner" });
    }
    const entries = ctx.report.entries().filter((e) => e.code === "block.inner-misplaced");
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({
      severity: "warn",
      where: "post:3483",
      data: { block: "core/group", lost: 1, total: 1 },
    });
  });

  test("a freeform block that holds inner blocks is reported under that name", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    ctx.convert = stubConvert();
    staticBlock(block(["<textarea>", null, "</textarea>"], [paragraph()], null), ctx);
    expect(ctx.report.entries()[0]!.message).toContain("freeform");
  });

  test("opts.html is converted instead of innerContent, and inner blocks are not stitched into it", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    let converted = 0;
    ctx.convert = () => {
      converted++;
      return [{ tagName: "p" }];
    };
    const nodes = staticBlock(block(["<div>", null, "</div>"], [paragraph()]), ctx, {
      html: `<section>fixed</section>`,
    });
    expect(nodesToHtml(nodes)).toBe(`<section>fixed</section>`);
    expect(converted).toBe(0);
  });

  test("a block with no inner blocks never calls ctx.convert", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    // makeCtx's own convert throws: reaching it would fail this test.
    expect(nodesToHtml(staticBlock(block(["<p>x</p>"]), ctx))).toBe("<p>x</p>");
  });

  test("root changes reach the block's own element, not an inner block's", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    ctx.convert = () => [{ tagName: "p", className: "inner" }];
    const nodes = staticBlock(block(['<div class="own">', null, "</div>"], [paragraph()]), ctx, {
      root: { classes: ["added"] },
    });
    expect(nodesToHtml(nodes)).toBe(`<div class="own added"><p class="inner"></p></div>`);
  });

  test("with real blocks: an ap group around paragraphs is stitched with the real converters", async () => {
    const site = await loadSite("ap");
    const ctx = await makeCtx("ap", AP_POST);
    const driver = (blocks: WpBlock[]): JxNode[] => blocks.flatMap((b) => convertCoreBlock(b, ctx));
    ctx.convert = driver;
    const group = subjectBlocks(site, AP_POST).find((b) => b.name === "core/group")!;
    const nodes = staticBlock(group, ctx);
    const root = el(nodes);
    expect(root.tagName).toBe("div");
    expect(root.className).toContain("wp-block-group");
    const inner = JSON.stringify(nodes);
    expect(inner).not.toContain("wp2jx-inner");
    expect((root.children as JxNode[]).length).toBe(group.innerBlocks.length);
  });
});

// ── The corpus ───────────────────────────────────────────────────────────────────────────────────

/** Every block of both sites that is not Cwicly's: the markup this module exists to convert. */
async function* staticBlocks(): AsyncGenerator<{
  site: SiteName;
  subject: Subject;
  block: WpBlock;
}> {
  for (const name of ["fineline", "ap"] as const) {
    const site = await loadSite(name);
    for (const subject of allSubjects(site)) {
      const found: WpBlock[] = [];
      walkBlocks(subjectBlocks(site, subject), (b) => {
        if (!b.name?.startsWith("cwicly/")) found.push(b);
      });
      for (const b of found) yield { site: name, subject, block: b };
    }
  }
}

/** The addresses a context has reported as `url.unresolved` so far. */
const unresolved = (ctx: ConvertCtx): Set<string> =>
  new Set(
    ctx.report
      .entries()
      .filter((e) => e.code === "url.unresolved")
      .map((e) => String(e.data?.url)),
  );

describe("corpus of both sites", () => {
  test("rewriting the markup in the parse tree and writing it back changes nothing htmlToNodes reads", async () => {
    // The module header's claim: writing the tree back out is exact, for every real fragment.
    let fragments = 0;
    const different: string[] = [];
    for await (const { block: b } of staticBlocks()) {
      const html = b.innerContent
        .map((part) => part ?? `<wp2jx-inner style="display:block"></wp2jx-inner>`)
        .join("");
      if (!html.includes("<")) continue;
      fragments++;
      const round = serialize(parseFragment(html, { scriptingEnabled: false }));
      if (JSON.stringify(htmlToNodes(html)) !== JSON.stringify(htmlToNodes(round))) {
        different.push(`${b.name}: ${html.slice(0, 80)}`);
      }
    }
    expect(fragments).toBeGreaterThan(4000);
    expect(different).toEqual([]);
  });

  test("every address that comes out is a Jx address: no site origin unless the report names it, only planned media, no srcset, noopener on new windows", async () => {
    const problems: string[] = [];
    let blocks = 0;
    let images = 0;
    let newWindow = 0;
    const contexts = new Map<string, ConvertCtx>();
    const plannedPaths = new Map<SiteName, Set<string>>();
    for await (const { site, subject, block: b } of staticBlocks()) {
      if (b.name === "core/block") continue; // converts another post's blocks: covered where it is converted
      const key = `${site}:${JSON.stringify(subject)}`;
      let ctx = contexts.get(key);
      if (!ctx) {
        const made = await makeCtx(site, subject);
        const driver = (blocks: WpBlock[]): JxNode[] =>
          blocks.flatMap((x) => convertCoreBlock(x, made));
        made.convert = driver;
        contexts.set(key, made);
        ctx = made;
        if (contexts.size > 40) contexts.delete(contexts.keys().next().value!);
      }
      blocks++;
      const html = nodesToHtml(staticBlock(b, ctx));
      const origin = new URL(ctx.model.site.url).origin;
      const planned =
        plannedPaths.get(site) ??
        new Set((await loadSite(site)).media.files.map((f) => f.publicPath));
      plannedPaths.set(site, planned);
      for (const m of html.matchAll(/\s(?:href|src|poster)="([^"]*)"/g)) {
        // An address on the site that no route or upload accounts for keeps its own address, and the
        // report says so (`url.unresolved`): anything else on the origin is a rewrite that was missed.
        if (m[1]!.startsWith(origin) && !unresolved(ctx).has(decodeEntities(m[1]!)))
          problems.push(`${site} ${key}: ${m[1]}`);
        // A name that still ends in -1024x768 is fine when the family's own original is called that.
        if (m[1]!.startsWith("/media/") && !planned.has(m[1]!))
          problems.push(`${site} ${key}: unplanned ${m[1]}`);
      }
      if (/<img\b[^>]*\s(?:srcset|sizes)=/.test(html))
        problems.push(`${site} ${key}: srcset on an img`);
      images += (html.match(/<img\b/g) ?? []).length;
      for (const m of html.matchAll(/<a\b[^>]*\btarget="_blank"[^>]*>/g)) {
        newWindow++;
        if (!/\brel="[^"]*\bnoopener\b/.test(m[0])) problems.push(`${site} ${key}: ${m[0]}`);
      }
    }
    expect(blocks).toBeGreaterThan(5000);
    expect(images).toBeGreaterThan(50);
    expect(newWindow).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  test("no marker is left in anything staticBlock returns, and no inner block is lost or misplaced", async () => {
    let withInner = 0;
    const problems: string[] = [];
    for (const name of ["fineline", "ap"] as const) {
      const site = await loadSite(name);
      for (const subject of allSubjects(site)) {
        const ctx = await makeCtx(name, subject);
        ctx.convert = (blocks) => blocks.flatMap((x) => convertCoreBlock(x, ctx));
        walkBlocks(subjectBlocks(site, subject), (b) => {
          if (b.name?.startsWith("cwicly/") || b.innerBlocks.length === 0) return;
          if (b.name === "core/navigation") return;
          withInner++;
          const nodes = staticBlock(b, ctx);
          if (JSON.stringify(nodes).includes("wp2jx-inner")) {
            problems.push(`${name} ${JSON.stringify(subject)} ${b.name}: marker left`);
          }
        });
        const misplaced = ctx.report.entries().filter((e) => e.code === "block.inner-misplaced");
        if (misplaced.length > 0)
          problems.push(`${name} ${JSON.stringify(subject)}: inner-misplaced`);
      }
    }
    expect(withInner).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });

  test("a Markdown entry's nodes carry no innerHTML the serializer would drop, unless reported", async () => {
    const problems: string[] = [];
    let entries = 0;
    for (const name of ["fineline", "ap"] as const) {
      const site = await loadSite(name);
      for (const subject of allSubjects(site)) {
        const post = subjectPost(site, subject);
        if (subject.kind !== "post" || !post || ["page"].includes(post.type)) continue;
        entries++;
        const ctx = await makeCtx(name, subject);
        ctx.convert = (blocks) => blocks.flatMap((x) => convertCoreBlock(x, ctx));
        const nodes = ctx.convert(
          subjectBlocks(site, subject).filter((b) => !b.name?.startsWith("cwicly/")),
        );
        const reported = ctx.report
          .entries()
          .some((e) => e.code === "html.innerhtml-unserialisable");
        const holdsInner = JSON.stringify(nodes).includes('"innerHTML"');
        if (holdsInner && !reported) problems.push(`${name} ${post.type}:${post.id}`);
      }
    }
    expect(entries).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });
});

// ── What WordPress does to a post's content when it prints it ────────────────────────────────────

describe("the write-back is exact for the first line feed of pre and textarea", () => {
  test("a blank line at the top of a pre or textarea survives the round trip through the parse tree", async () => {
    const { ctx } = await spyCtx();
    const markup = `<pre>\n\nfoo\nbar</pre><textarea>\n\nx</textarea><pre>\nplain</pre><pre>no lead</pre>`;
    const before = htmlToNodes(markup, { target: "page" });
    const after = htmlToNodes(rewriteMarkup(markup, ctx), { target: "page" });
    expect(after).toEqual(before);
  });
});

describe("rewriteMarkup: the size an image is shown at", () => {
  test("the size of the derivative the markup named wins over the original's, which the plan ships (ap post 2935)", async () => {
    const ctx = await makeCtx("ap", { kind: "post", id: 2935 });
    const site = await loadSite("ap");
    const markup = [...site.model.posts.get(2935)!.content.matchAll(/<img[^>]*>/g)].map(
      (m) => m[0],
    );
    const medium = markup.find((m) => m.includes("A47A8253-1-edited-1-300x300.jpg"))!;
    const out = rewriteMarkup(medium, ctx);
    expect(out).toContain(`src="/media/A47A8253-1-edited-1.jpg"`);
    // The original is 1999 x 1999; WordPress printed the medium size, 300 x 300.
    expect(out).toContain(`width="300" height="300"`);
    // The same file named without a size is the original, at the plan's size.
    expect(
      rewriteMarkup(
        `<img src="https://media.anabaptistperspectives.org/A47A8253-1-edited-1.jpg">`,
        ctx,
      ),
    ).toContain(`width="1999" height="1999"`);
  });

  test("a file whose own name ends in digits is the original, not a derivative", async () => {
    const { ctx } = await spyCtx(FL_PAGE, "fineline");
    ctx.mediaForUrl = (url) =>
      url.endsWith("/photo-800x600.jpg")
        ? { src: "/media/photo-800x600.jpg", width: 1600, height: 1200, alt: "" }
        : undefined;
    expect(rewriteMarkup(`<img src="https://x.test/photo-800x600.jpg">`, ctx)).toBe(
      `<img src="/media/photo-800x600.jpg" width="1600" height="1200">`,
    );
  });
});

describe("contentOptions: Rank Math's external links and wptexturize", () => {
  const FL_FRONT = { kind: "post", id: 3483 } as const;
  const on = (ctx: ConvertCtx) => contentOptions(ctx);

  test("with Rank Math's new_window_external_links on, a post's external link opens in a new window and gains rel=noopener; an internal one does not", async () => {
    const ctx = await makeCtx("fineline", FL_FRONT);
    expect(on(ctx).externalLinks).toBe(true);
    const out = rewriteMarkup(
      `<a href="https://www.credo.ch">a</a><a href="https://finelinepainting.pro/about-us/">b</a><a href="https://www.finelinepainting.pro/x">c</a><a href="/y">d</a><a href="mailto:a@b.c">e</a><a href="https://x.org" target="_self">f</a>`,
      ctx,
      undefined,
      on(ctx),
    );
    expect(out).toBe(
      `<a href="https://www.credo.ch" target="_blank" rel="noopener">a</a><a href="/about-us/">b</a><a href="https://www.finelinepainting.pro/x">c</a><a href="/y">d</a><a href="mailto:a@b.c">e</a><a href="https://x.org" target="_self">f</a>`,
    );
  });

  test("a template's blocks are not content: the filter is on the_content, so only a post's own are changed", async () => {
    const site = await loadSite("fineline");
    const part = allSubjects(site).find((s) => s.kind === "part")!;
    expect(contentOptions(await makeCtx("fineline", part)).externalLinks).toBe(false);
  });

  test("a site that has not turned the option on, or has deactivated Rank Math, is left alone", async () => {
    const ctx = await makeCtx("fineline", FL_FRONT);
    const off = new Map(ctx.model.options);
    off.set("rank-math-options-general", `a:1:{s:25:"new_window_external_links";s:3:"off";}`);
    expect(contentOptions({ ...ctx, model: { ...ctx.model, options: off } }).externalLinks).toBe(
      false,
    );
    const inactive = { ...ctx.model.site, activePlugins: [] };
    expect(
      contentOptions({
        ...ctx,
        model: { ...ctx.model, options: new Map(ctx.model.options), site: inactive },
      }).externalLinks,
    ).toBe(false);
  });

  test("real: every external link of a converted fineline post (3371, 7 of them) opens in a new window, as on the live page", async () => {
    const site = await loadSite("fineline");
    const subject: Subject = { kind: "post", id: 3371 };
    const ctx = await makeCtx("fineline", subject);
    ctx.convert = (blocks) => blocks.flatMap((b) => convertCoreBlock(b, ctx));
    const html = nodesToHtml(ctx.convert(subjectBlocks(site, subject)));
    const external = [...html.matchAll(/<a [^>]*href="(https?:\/\/[^"]+)"[^>]*>/g)].filter(
      (m) => !/finelinepainting\.pro/.test(m[1]!),
    );
    expect(external).toHaveLength(7);
    for (const m of external) expect(m[0]).toContain(`target="_blank"`);
  });

  test("text is texturized the way WordPress prints it: outside code and tags, on the markup, where `&nbsp;` is one of the spaces a dash stands between", async () => {
    const { ctx } = await spyCtx();
    const out = rewriteMarkup(
      `<p class="it's">Don't "quote" me - or 1--2... 300x300</p><pre>don't - here</pre><p>a&nbsp;- b</p><code>it's</code>`,
      ctx,
      undefined,
      { texturize: true },
    );
    expect(out).toBe(
      `<p class="it's">Don’t “quote” me – or 1–2… 300×300</p><pre>don't - here</pre><p>a&nbsp;– b</p><code>it's</code>`,
    );
    // Not asked for: a converter's own text goes through as it is.
    expect(rewriteMarkup(`<p>Don't</p>`, ctx)).toBe(`<p>Don't</p>`);
  });

  test("staticBlock texturizes a saved paragraph; a freeform block (classic content) too", async () => {
    const ctx = await makeCtx("fineline", FL_PAGE);
    ctx.convert = (blocks) => blocks.flatMap((b) => convertCoreBlock(b, ctx));
    const nodes = ctx.convert(
      parseBlocks(
        `<!-- wp:paragraph --><p>We're here - really</p><!-- /wp:paragraph -->\n\nClassic isn't "gone"`,
      ),
    );
    expect(nodesToHtml(nodes)).toBe(`<p>We’re here – really</p><p>Classic isn’t “gone”</p>`);
  });
});

describe("RootChanges.within: the element that carries the changes", () => {
  test("the classes go on the first descendant that has the class, not on the root; the root when there is none", async () => {
    const { ctx } = await spyCtx();
    const markup = `<div class="outer"><span></span><div class="inner a"><div class="inner">x</div></div></div>`;
    expect(rewriteMarkup(markup, ctx, { within: "inner", classes: ["added"] })).toBe(
      `<div class="outer"><span></span><div class="inner a added"><div class="inner">x</div></div></div>`,
    );
    expect(rewriteMarkup(markup, ctx, { within: "missing", classes: ["added"] })).toBe(
      `<div class="outer added"><span></span><div class="inner a"><div class="inner">x</div></div></div>`,
    );
  });
});

describe("Markdown entries: what the serializer cannot write", () => {
  test("a trailing break, a lone colon directive and a flattened verse are the same tree whether one block or its parent is converted", async () => {
    // markdownSafe runs again on the stitched tree: every fix must leave a fixed point.
    const ctx = await makeCtx("ap", AP_POST);
    ctx.convert = (blocks) => blocks.flatMap((b) => convertCoreBlock(b, ctx));
    const markup =
      `<!-- wp:group --><div class="wp-block-group"><!-- wp:paragraph --><p>Luke 12:42<br></p><!-- /wp:paragraph -->` +
      `<!-- wp:verse --><pre class="wp-block-verse"><span>one </span>\n<span>two</span></pre><!-- /wp:verse --></div><!-- /wp:group -->`;
    const nodes = ctx.convert(parseBlocks(markup));
    const again = JSON.parse(JSON.stringify(nodes)) as JxNode[];
    const html = nodesToHtml(nodes);
    expect(html).toContain(`<p>Luke 12<span>:</span>42</p>`);
    expect(html).toContain(`<pre class="wp-block-verse">one \ntwo</pre>`);
    expect(again).toEqual(nodes);
    // The colon was counted once, not once per pass over the stitched tree.
    expect(ctx.report.entries().filter((e) => e.code === "block.text-directive")).toHaveLength(1);
  });
});
