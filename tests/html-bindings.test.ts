/**
 * The seam between a binding and HTML conversion (docs/bindings.md, section 8.4). `htmlToNodes` and
 * `htmlToContent` read every `${` in markup as literal text and escape it, so a binding cannot travel
 * through them as itself: it crosses as an opaque placeholder (`bindingMarker`) and becomes a real
 * binding afterwards (`finishBindings` for one string, `finishNodes` for what the converters return).
 *
 * The unit tests pin each rule down; the build tests at the end run the result through the real Jx
 * build, because "the string looks right" is not the same as "the page comes out right".
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { htmlToContent, htmlToNodes } from "../src/html.ts";
import {
  bindingMarker,
  finishBindings,
  finishNodes,
  hasBindingMarkers,
  htmlEscapeExpr,
} from "../src/jx-util.ts";
import { buildJxProject, cleanupJxProjects } from "./helpers/jx-build.ts";

setDefaultTimeout(120_000);
afterAll(cleanupJxProjects);

const m = (expr: string, kind: "text" | "html" = "text"): string => bindingMarker(expr, kind);
const T = m("state.entry.data.title ?? ''");
const ESC = htmlEscapeExpr("state.entry.data.title ?? ''");

describe("bindingMarker", () => {
  test("is made of characters no HTML, whitespace or class rule touches", () => {
    const marker = m("a.b ?? 'x y'");
    expect(hasBindingMarkers(marker)).toBe(true);
    expect(marker).not.toMatch(/[\s<>&"'$`{}\\]/);
    // Neither the expression's spaces nor its quotes show.
    expect(marker).not.toContain(" ");
  });

  test("two expressions give two markers, and the same one gives the same marker", () => {
    expect(m("a")).not.toBe(m("b"));
    expect(m("a")).toBe(m("a"));
    expect(m("a", "html")).not.toBe(m("a", "text"));
  });

  test("plain text has no marker", () => {
    expect(hasBindingMarkers("a ${b} {c}")).toBe(false);
  });
});

describe("finishBindings", () => {
  test("a text binding in an attribute or text position is the bare expression", () => {
    expect(finishBindings(`pre ${T} post`, "attribute")).toBe(
      "pre ${state.entry.data.title ?? ''} post",
    );
    expect(finishBindings(T, "text")).toBe("${state.entry.data.title ?? ''}");
  });

  test("a text binding in markup is escaped by its expression, an HTML binding is not", () => {
    expect(finishBindings(`<b>${T}</b>`, "html")).toBe(`<b>\${${ESC}}</b>`);
    expect(finishBindings(m("state.entry.data.body ?? ''", "html"), "html")).toBe(
      "${state.entry.data.body ?? ''}",
    );
  });

  test("backslashes and backticks in the literal parts are doubled only when the string holds a binding", () => {
    expect(finishBindings(`a\\b \`c\` ${T}`, "attribute")).toBe(
      "a\\\\b \\`c\\` ${state.entry.data.title ?? ''}",
    );
    // No binding: the build never evaluates the text, so it stays as written.
    expect(finishBindings("a\\b `c`", "attribute")).toBe("a\\b `c`");
  });

  test("a literal ${ is &#36;{ in markup", () => {
    expect(finishBindings(`cost \${5} ${T}`, "html")).toBe(`cost &#36;{5} \${${ESC}}`);
    expect(finishBindings("cost ${5}", "html")).toBe("cost &#36;{5}");
  });

  test("a literal ${ outside markup is split with a zero-width space, and the caller is told", () => {
    let told = 0;
    expect(finishBindings("cost ${5}", "attribute", () => told++)).toBe("cost $​{5}");
    expect(told).toBe(1);
    expect(finishBindings(`cost \${5} ${T}`, "text", () => told++)).toBe(
      "cost $​{5} ${state.entry.data.title ?? ''}",
    );
    expect(told).toBe(2);
    // Inside markup nobody needs telling.
    finishBindings("cost ${5}", "html", () => told++);
    expect(told).toBe(2);
  });

  test("an expression with its own quotes, braces and template literals is carried verbatim", () => {
    const expr = "x ? `a-${y}` : '{}'";
    expect(finishBindings(m(expr), "attribute")).toBe(`\${${expr}}`);
  });
});

describe("finishNodes", () => {
  test("every position takes the form it needs", () => {
    const out = finishNodes({
      tagName: "a",
      attributes: { href: T, "data-x": `p-${T}` },
      style: { color: T },
      textContent: `t ${T}`,
    });
    expect(out).toEqual({
      tagName: "a",
      attributes: {
        href: "${state.entry.data.title ?? ''}",
        "data-x": "p-${state.entry.data.title ?? ''}",
      },
      style: { color: "${state.entry.data.title ?? ''}" },
      textContent: "t ${state.entry.data.title ?? ''}",
    });
  });

  test("innerHTML escapes a text binding", () => {
    expect(finishNodes({ tagName: "p", innerHTML: `a ${T}` })).toEqual({
      tagName: "p",
      innerHTML: `a \${${ESC}}`,
    });
  });

  test("a text child that holds a binding becomes a span with its own textContent", () => {
    expect(
      finishNodes({ tagName: "p", children: [`a ${T} b`, { tagName: "b", textContent: "x" }] }),
    ).toEqual({
      tagName: "p",
      children: [
        { tagName: "span", textContent: "a ${state.entry.data.title ?? ''} b" },
        { tagName: "b", textContent: "x" },
      ],
    });
  });

  test("a text child that holds an HTML binding becomes a span with innerHTML", () => {
    const html = m("state.entry.data.body ?? ''", "html");
    expect(finishNodes<unknown>({ tagName: "div", children: [`<${html}`] })).toEqual({
      tagName: "div",
      children: [{ tagName: "span", innerHTML: "&lt;${state.entry.data.body ?? ''}" }],
    });
  });

  test("a textContent that holds an HTML binding would print the markup as text, so it becomes innerHTML", () => {
    const html = m("state.entry.data.body ?? ''", "html");
    expect(finishNodes<unknown>({ tagName: "div", textContent: `a & ${html}` })).toEqual({
      tagName: "div",
      innerHTML: "a &amp; ${state.entry.data.body ?? ''}",
    });
  });

  test("strings with no marker, and the input itself, are left alone", () => {
    const input = {
      tagName: "p",
      textContent: `x ${T}`,
      children: ["plain", { tagName: "i", textContent: "k" }],
    };
    const copy = structuredClone(input);
    const out = finishNodes({ ...input, textContent: "kept ${literal}" });
    expect(out.textContent).toBe("kept ${literal}");
    finishNodes(input);
    expect(input).toEqual(copy);
  });

  test("a $props object is walked like any other", () => {
    expect(finishNodes({ tagName: "x-c", $props: { label: T, n: 3, flag: true } })).toEqual({
      tagName: "x-c",
      $props: { label: "${state.entry.data.title ?? ''}", n: 3, flag: true },
    });
  });

  test("arrays of nodes (what htmlToNodes returns) are walked", () => {
    expect(finishNodes([{ tagName: "p", textContent: T }, "tail"])).toEqual([
      { tagName: "p", textContent: "${state.entry.data.title ?? ''}" },
      "tail",
    ]);
  });
});

describe("markers through htmlToNodes and htmlToContent", () => {
  test("in an attribute value, whatever the attribute", () => {
    const nodes = htmlToNodes(
      `<a href="/x/${T}" data-k="${T}" aria-label="${T}" title="a ${T}" target="_blank">go</a>`,
    );
    const done = finishNodes(nodes);
    expect(done).toEqual([
      {
        tagName: "a",
        attributes: {
          href: "/x/${state.entry.data.title ?? ''}",
          "data-k": "${state.entry.data.title ?? ''}",
          "aria-label": "${state.entry.data.title ?? ''}",
          title: "a ${state.entry.data.title ?? ''}",
          target: "_blank",
        },
        textContent: "go",
      },
    ]);
  });

  test("in an image's src and alt", () => {
    expect(finishNodes(htmlToNodes(`<img src="${T}" alt="${T}">`))).toEqual([
      {
        tagName: "img",
        attributes: {
          src: "${state.entry.data.title ?? ''}",
          alt: "${state.entry.data.title ?? ''}",
        },
      },
    ]);
  });

  test("in text, with the spaces around it kept", () => {
    expect(finishNodes(htmlToContent(`Hello ${T}, welcome`))).toEqual({
      textContent: "Hello ${state.entry.data.title ?? ''}, welcome",
    });
  });

  test("in an inline style value, as a flat declaration", () => {
    const nodes = finishNodes(
      htmlToNodes(`<div class="x" style="--background-image:url(${T});color:red"></div>`),
    );
    const node = nodes[0] as { style: Record<string, string> };
    expect(node.style["--background-image"]).toBe("url(${state.entry.data.title ?? ''})");
    expect(node.style.color).toBe("red");
  });

  test("beside an element, inline content that would show a gap is kept raw and the binding escapes", () => {
    const out = finishNodes(htmlToContent(`<span class="before">#</span>${T}`));
    expect(out).toEqual({
      innerHTML: `<span class="before">#</span>\${${ESC}}`,
    });
  });

  test("beside an element whose boundary is harmless it is a span child", () => {
    const out = finishNodes(htmlToContent(`<span class="before">About This </span>${T}`));
    expect(out).toEqual({
      children: [
        { tagName: "span", className: "before", textContent: "About This " },
        { tagName: "span", textContent: "${state.entry.data.title ?? ''}" },
      ],
    });
  });

  test("a literal ${ in markup is escaped by the converter and survives finishNodes", () => {
    const out = finishNodes(htmlToContent(`a \${lit} ${T}`));
    expect(out).toEqual({ innerHTML: `a &#36;{lit} \${${ESC}}` });
  });

  test("an HTML binding in a paragraph's content is raw", () => {
    const body = m("state.entry.data.body ?? ''", "html");
    expect(finishNodes(htmlToNodes(`<div class="a">${body}</div>`))).toEqual([
      { tagName: "div", className: "a", innerHTML: "${state.entry.data.body ?? ''}" },
    ]);
  });
});

describe("through the Jx build", () => {
  const ENTRY = `---
title: Tom & Jerry <b>
slug: foo
url: /items/foo/
body: "<p>Hi <b>there</b></p>"
---

Body.
`;

  test("every position of a finished node builds to the HTML it should", async () => {
    const page = (children: unknown[]): object => ({
      $paths: { contentType: "items", param: "slug", field: "slug" },
      title: "${state.entry.data.title}",
      state: {
        entry: {
          $prototype: "ContentEntry",
          contentType: "items",
          field: "slug",
          id: { $ref: "#/$params/slug" },
          $src: "@jxsuite/parser/ContentEntry.class.json",
          timing: "compiler",
        },
      },
      children: [{ tagName: "section", attributes: { "data-case": "x" }, children }],
    });
    const nodes = finishNodes([
      ...htmlToNodes(`<a href="${m("state.entry.data.url ?? ''")}" title="${T}">${T}</a>`),
      ...htmlToNodes(
        `<div class="w">${T} <b>${m("state.entry.data.body ?? ''", "html")}</b></div>`,
      ),
      ...htmlToNodes(`<div class="q" style="--c:url(${m("state.entry.data.url ?? ''")})">k</div>`),
    ]);
    const site = await buildJxProject(
      {
        "project.json": {
          name: "seam",
          url: "https://example.com",
          extensions: ["@jxsuite/parser"],
          defaults: { layout: "./layouts/base.json" },
          content: {
            items: {
              source: "content/items",
              format: "Markdown",
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
          },
        },
        "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
        "content/items/foo.md": ENTRY,
        "pages/c/[slug].json": page(nodes),
      },
      { name: "seam" },
    );
    const html = site.html("/c/foo/");
    const body = /<section data-case="x">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
    expect(body).toContain(
      '<a href="/items/foo/" title="Tom &amp; Jerry &lt;b&gt;">Tom &amp; Jerry &lt;b&gt;</a>',
    );
    // The text child is a span, and the HTML binding inside <b> is raw markup.
    expect(body).toContain("<span>Tom &amp; Jerry &lt;b&gt; </span>");
    expect(body).toContain("<b><p>Hi <b>there</b></p></b>");
    expect(html).toContain("--c: url(/items/foo/)");
    expect(html).not.toContain("data-bind");
  });
});
