/**
 * Part 1: the binding capability matrix of docs/bindings.md, measured against the real Jx build. Every
 * rule that document states is a case here, with the id it cites, so a Jx release that changes what
 * the static build evaluates fails this file and not a conversion.
 *
 * Part 2 (below the matrix): the bindings the dynamic modules emit, built into a collection entry
 * page and a component.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parse } from "parse5";
import {
  buildJxProject,
  cleanupJxProjects,
  validateJxProject,
  writeJxProject,
} from "./helpers/jx-build.ts";
import type { BuiltProject, ProjectFile } from "./helpers/jx-build.ts";
import { loadSite, makeCtx, subjectBlocks } from "./helpers/ctx.ts";
import type { LoadedSite, SiteName, Subject } from "./helpers/ctx.ts";
import { buildRoutes, createUrlTools } from "../src/routes.ts";
import { walkBlocks } from "../src/wp/blocks.ts";
import { decodeEntities } from "../src/wp/model.ts";
import type { ConvertCtx, JxNode, WpBlock, WpPost } from "../src/types.ts";
import {
  blockBackground,
  blockContent,
  blockGallery,
  blockImage,
  galleryMarkup,
} from "../src/cwicly/dynamic.ts";
import { blockLink } from "../src/cwicly/links.ts";
import { blockVisibility } from "../src/cwicly/conditions.ts";
import { postData, postFacts, resolveTokens, tokenNodes } from "../src/cwicly/tokens.ts";

setDefaultTimeout(120_000);
afterAll(cleanupJxProjects);

// ── The probe project ────────────────────────────────────────────────────────────────────────────

export const FOO = `---
title: Foo Title
slug: foo
date: 2024-02-15T17:30:00Z
n: 42
zero: 0
off: false
flag: true
empty: ""
color: "#ff0000"
amp: "Tom & <Jerry> \\"q\\" 'x'"
html: "<p>Hi <b>there</b></p>"
url: /items/foo/
tags: [alpha, beta, gamma]
none: []
img: { src: /media/a.jpg, width: 800, height: 600, alt: "An A" }
link: { url: "https://example.com/", title: "Ex", target: _blank }
rows: [{ name: "r1", n: 1 }, { name: "r2", n: 2 }]
terms:
  topic: [{ slug: a, name: "Alpha", url: /topic/a/ }, { slug: b, name: "Beta", url: /topic/b/ }]
---

Body **text** here.
`;

export const BAR = `---
title: Bar Title
slug: bar
date: 2023-12-31T23:30:00Z
n: 7
flag: false
tags: []
---

Second body.
`;

const D = "state.entry.data";
const t = (expr: string): string => `\${${expr}}`;

const entryState = (timing?: "compiler"): Record<string, unknown> => ({
  $prototype: "ContentEntry",
  contentType: "items",
  field: "slug",
  id: { $ref: "#/$params/slug" },
  $src: "@jxsuite/parser/ContentEntry.class.json",
  ...(timing ? { timing } : {}),
});

interface Case {
  node: unknown;
  /** Extra state entries. */
  state?: Record<string, unknown>;
  /** Extra page keys (`$elements`, `$head`). */
  page?: Record<string, unknown>;
}

interface Out {
  /** The case's element, as built, trimmed. */
  html: string;
  /** The page's `<style>` blocks, whitespace collapsed. */
  css: string;
  /** Whether the page loads a module script of its own. */
  js: boolean;
  /** The whole page. */
  page: string;
}

const COMPONENTS: Record<string, ProjectFile> = {
  "components/fp-card.json": {
    tagName: "fp-card",
    state: { label: "Default label", url: "", show: true, count: 3, html: "<i>default</i>" },
    children: [
      { tagName: "h3", textContent: t("state.label") },
      {
        tagName: "a",
        attributes: { href: t("state.url || false"), "data-count": t("state.count") },
        textContent: t("state.label + '!'"),
      },
      { tagName: "div", attributes: { hidden: t("!state.show") }, textContent: "shown-if-show" },
      { tagName: "div", style: { color: t("state.show ? 'red' : 'blue'") }, textContent: "styled" },
      { tagName: "div", className: "cx", innerHTML: t("state.html") },
    ],
  },
  "components/fp-obj.json": {
    tagName: "fp-obj",
    state: { link: { url: "", target: "" }, img: { src: "", alt: "" }, list: [] },
    children: [
      {
        tagName: "a",
        attributes: {
          href: t("state.link?.url || false"),
          target: t("state.link?.target || false"),
        },
        textContent: t("state.link?.url ?? ''"),
      },
      {
        tagName: "img",
        attributes: { src: t("state.img?.src || false"), alt: t("state.img?.alt ?? ''") },
      },
      { tagName: "ul", innerHTML: t("(state.list ?? []).map(x => '<li>' + x + '</li>').join('')") },
    ],
  },
};
const ELEMENTS = [
  { $ref: "../../../components/fp-card.json" },
  { $ref: "../../../components/fp-obj.json" },
];

function projectFiles(
  cases: Record<string, Case>,
  timing?: "compiler",
): Record<string, ProjectFile> {
  const files: Record<string, ProjectFile> = {
    "project.json": {
      name: "probe",
      url: "https://example.com",
      extensions: ["@jxsuite/parser"],
      defaults: { layout: "./layouts/base.json" },
      content: {
        items: {
          source: "content/items",
          format: "Markdown",
          schema: {
            type: "object",
            properties: { title: { type: "string" }, slug: { type: "string" } },
            required: ["title"],
          },
        },
      },
    },
    "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
    "content/items/foo.md": FOO,
    "content/items/bar.md": BAR,
    ...COMPONENTS,
  };
  for (const [name, c] of Object.entries(cases)) {
    files[`pages/c-${name}/[slug].json`] = {
      $paths: { contentType: "items", param: "slug", field: "slug" },
      title: t(`${D}.title`),
      $elements: ELEMENTS,
      state: { entry: entryState(timing), ...c.state },
      ...c.page,
      children: [
        {
          tagName: "section",
          attributes: { "data-case": name },
          children: Array.isArray(c.node) ? c.node : [c.node],
        },
      ],
    };
  }
  return files;
}

function pull(site: BuiltProject, name: string, slug = "foo"): Out {
  const page = site.html(`/c-${name}/${slug}/`);
  const m = new RegExp(`<section data-case="${name}">([\\s\\S]*?)</section>`).exec(page);
  const head = /<head>([\s\S]*?)<\/head>/.exec(page)?.[1] ?? "";
  const css = [...head.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map((s) => (s[1] ?? "").replace(/\s+/g, " ").trim())
    .join(" ");
  const js =
    site.exists(`c-${name}/${slug}/app.js`) ||
    /<script[^>]*type="module"/.test(
      page.replace(/<script type="importmap">[\s\S]*?<\/script>/, ""),
    );
  return { html: (m?.[1] ?? `(no section)\n${page}`).trim(), css, js, page };
}

/** Builds every case in one project; the result is the case's slice of `/c-<name>/foo/`. */
async function matrix(
  cases: Record<string, Case>,
  timing?: "compiler",
): Promise<{ out: Record<string, Out>; site: BuiltProject }> {
  const site = await buildJxProject(projectFiles(cases, timing), { name: "matrix" });
  const out: Record<string, Out> = {};
  for (const name of Object.keys(cases)) out[name] = pull(site, name);
  return { out, site };
}

// ── The matrix cases ─────────────────────────────────────────────────────────────────────────────

const el = (node: unknown, extra: Partial<Case> = {}): Case => ({ node, ...extra });
const arrayOf = (items: unknown, map: unknown): unknown => ({ $prototype: "Array", items, map });
const ptr = (path: string): { $ref: string } => ({ $ref: `#/state/${path}` });

const CASES: Record<string, Case> = {
  // T: textContent
  T1: el({ tagName: "p", textContent: t(`${D}.title`) }),
  T2: el({ tagName: "p", textContent: `Featured ${t(`${D}.title`)} Projects` }),
  T3a: el({ tagName: "p", textContent: t(`${D}.flag ? 'yes' : 'no'`) }),
  T3b: el({ tagName: "p", textContent: t(`${D}.empty || 'fallback'`) }),
  T3c: el({ tagName: "p", textContent: t(`${D}.title && 'has title'`) }),
  T3d: el({ tagName: "p", textContent: t(`${D}.nope ?? 'fallback'`) }),
  T4a: el({ tagName: "p", textContent: t(`${D}.n`) }),
  T4b: el({ tagName: "p", textContent: t(`${D}.zero`) }),
  T4c: el({ tagName: "p", textContent: t(`${D}.off`) }),
  T4d: el({ tagName: "p", textContent: t(`${D}.img`) }),
  T4e: el({ tagName: "p", textContent: t(`${D}.tags`) }),
  T5a: el({ tagName: "p", textContent: t(`${D}.tags.length`) }),
  T5b: el({ tagName: "p", textContent: t(`${D}.tags.map(x => x.toUpperCase()).join(', ')`) }),
  T6: el({ tagName: "p", textContent: t("`a-${" + `${D}.title` + "}-b`") }),
  T7: el({ tagName: "p", textContent: t(`${D}.amp`) }),
  T8a: el({ tagName: "p", textContent: `a ${t(`${D}.nope`)} b` }),
  T8b: el({ tagName: "p", textContent: `a ${t(`${D}.nope ?? ''`)} b` }),
  T8c: el({ tagName: "p", textContent: t(`${D}.nope?.src ?? ''`) }),
  // A: attributes
  A1: el({
    tagName: "a",
    attributes: {
      href: t(`${D}.url`),
      "data-x": `pre-${t(`${D}.n`)}-post`,
      "aria-label": t(`${D}.title`),
    },
    textContent: "x",
  }),
  A1img: el({
    tagName: "img",
    attributes: {
      src: t(`${D}.img.src`),
      alt: t(`${D}.img.alt`),
      width: t(`${D}.img.width`),
      height: t(`${D}.img.height`),
    },
  }),
  A2true: el({ tagName: "input", attributes: { disabled: t(`${D}.flag`), "data-k": "k" } }),
  A2false: el({ tagName: "input", attributes: { disabled: t(`${D}.off`), "data-k": "k" } }),
  A2aria: el({ tagName: "div", attributes: { "aria-hidden": t(`${D}.flag`) }, textContent: "x" }),
  A2omit: el({
    tagName: "a",
    attributes: { href: t(`${D}.nope?.url || false`), "data-k": "k" },
    textContent: "x",
  }),
  A2empty: el({
    tagName: "a",
    attributes: { href: t(`${D}.nope?.url ?? ''`), "data-k": "k" },
    textContent: "x",
  }),
  A2link: el({
    tagName: "a",
    attributes: {
      href: t(`${D}.link.url`),
      target: t(`${D}.link.target || false`),
      rel: t(`${D}.link.target ? 'noopener' : false`),
    },
    textContent: "x",
  }),
  A4: el({
    tagName: "a",
    attributes: { href: t(`${D}.nope`), "data-k": "k" },
    textContent: "x",
  }),
  A5ok: el({
    tagName: "input",
    attributes: { disabled: t(`${D}.off ? 'x' : false`), "data-k": "k" },
  }),
  A5brace: el({
    tagName: "input",
    attributes: { disabled: t(`${D}.off ? '{' : false`), "data-k": "k" },
  }),
  A5escaped: el({
    tagName: "input",
    attributes: { disabled: t(`${D}.off ? '\\u007b' : false`), "data-k": "k" },
  }),
  // H: innerHTML
  H1: el({ tagName: "div", innerHTML: t(`${D}.html ?? ''`) }),
  H1missing: el({ tagName: "div", innerHTML: t(`${D}.nope ?? ''`) }),
  H2: el({
    tagName: "div",
    innerHTML: `<b>pre</b> ${t(`${D}.title`)} <a href="${t(`${D}.url`)}">link</a>`,
  }),
  H3: el({
    tagName: "div",
    innerHTML: t(
      `String(${D}.amp ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))`,
    ),
  }),
  H4: el({
    tagName: "ul",
    innerHTML: t(
      `(${D}.terms?.topic ?? []).map(x => '<li><a href="' + x.url + '">' + x.name + '</a></li>').join('')`,
    ),
  }),
  H4empty: el({
    tagName: "ul",
    innerHTML: t(
      `(${D}.terms?.nope ?? []).map(x => '<li><a href="' + x.url + '">' + x.name + '</a></li>').join('')`,
    ),
  }),
  // S: style
  S1: el({
    tagName: "div",
    className: "s1",
    style: { color: t(`${D}.color`), padding: "1rem" },
    textContent: "s",
  }),
  S1bg: el({
    tagName: "div",
    className: "s1bg",
    style: { backgroundImage: `url(${t(`${D}.img.src`)})` },
    textContent: "s",
  }),
  S3: el({
    tagName: "div",
    className: "s3",
    style: { "--background-image": `url(${t(`${D}.img.src`)})`, color: "var(--c)" },
    textContent: "s",
  }),
  S4hover: el({
    tagName: "div",
    className: "s4h",
    style: { color: "red", ":hover": { color: t(`${D}.color`) } },
    textContent: "s",
  }),
  S4before: el({
    tagName: "div",
    className: "s4b",
    style: { "::before": { content: `"${t(`${D}.title`)}"`, display: "block" } },
    textContent: "s",
  }),
  S4static: el({
    tagName: "div",
    className: "s4s",
    style: { color: t(`${D}.color`), ":hover": { color: "blue" } },
    textContent: "s",
  }),
  // C: className and id
  C1class: el({
    tagName: "div",
    className: `a ${t(`${D}.flag ? 'on' : 'off'`)}`,
    textContent: "c",
  }),
  C1id: el({ tagName: "div", id: `x-${t(`${D}.slug`)}`, textContent: "c" }),
  C2: el({
    tagName: "div",
    className: `${t(`${D}.slug`)} z`,
    style: { color: "red" },
    textContent: "c",
  }),
  // X: top-level properties
  X1hidden: el({ tagName: "div", hidden: t(`!${D}.flag`), textContent: "c" }),
  X1title: el({ tagName: "div", title: t(`${D}.title`), textContent: "c" }),
  X1attr: el({ tagName: "div", attributes: { title: t(`${D}.title`) }, textContent: "c" }),
  // K: children
  K1: el({
    tagName: "div",
    children: [`a ${t(`${D}.title`)} b`, { tagName: "b", textContent: "bold" }],
  }),
  K2true: el({
    tagName: "div",
    children: [t(`${D}.flag ? [{tagName:'b', textContent:'yes'}] : []`)],
  }),
  K2false: el({
    tagName: "div",
    children: ["x", t(`${D}.off ? [{tagName:'i', textContent:'no'}] : []`), "y"],
  }),
  K3: el({ tagName: "div", children: t("state.entry.$children ?? []") }),
  // P: page level
  P1: el(
    { tagName: "p", textContent: "x" },
    {
      page: {
        $head: [
          {
            tagName: "meta",
            attributes: { name: "description", content: t(`${D}.title + ' desc'`) },
          },
        ],
      },
    },
  ),
  // L: loops
  L1: el({
    tagName: "ul",
    children: arrayOf(ptr("entry/data/rows"), {
      tagName: "li",
      attributes: { "data-n": t("$map.item.n") },
      textContent: `${t("$map.item.name")} #${t("$map.index")}`,
    }),
  }),
  L1nested: el({
    tagName: "ul",
    children: arrayOf(ptr("entry/data/terms/topic"), {
      tagName: "li",
      innerHTML: `<a href="${t("$map.item.url")}">${t("$map.item.name")}</a>`,
    }),
  }),
  L2: el({
    tagName: "div",
    children: arrayOf(ptr("entry/data/rows"), {
      tagName: "p",
      className: "row",
      style: { order: t("$map.item.n") },
      textContent: t("$map.item.name"),
    }),
  }),
  L3: el({
    tagName: "ul",
    children: [
      { tagName: "li", textContent: "head" },
      arrayOf(ptr("entry/data/none"), { tagName: "li", textContent: t("$map.item") }),
    ],
  }),
  L3missing: el({
    tagName: "ul",
    children: [
      { tagName: "li", textContent: "head" },
      arrayOf(ptr("entry/data/nope"), { tagName: "li", textContent: t("$map.item") }),
    ],
  }),
  L4: el(
    {
      tagName: "ul",
      children: arrayOf(ptr("all"), {
        tagName: "li",
        textContent: t("$map.item.data.title + ' / ' + $map.item.id"),
      }),
    },
    {
      state: {
        all: {
          $prototype: "ContentCollection",
          contentType: "items",
          sort: { field: "slug", order: "asc" },
          timing: "compiler",
        },
      },
    },
  ),
  L4filter: el(
    {
      tagName: "ul",
      children: arrayOf(ptr("all"), { tagName: "li", textContent: t("$map.item.data.title") }),
    },
    {
      state: {
        all: {
          $prototype: "ContentCollection",
          contentType: "items",
          filter: { flag: true },
          timing: "compiler",
        },
      },
    },
  ),
  L5: el(
    {
      tagName: "ul",
      children: arrayOf(ptr("rows"), { tagName: "li", textContent: t("$map.item.name") }),
    },
    { state: { rows: t(`${D}.rows ?? []`) } },
  ),
  // Q: conditional rendering
  Q1show: el({
    tagName: "div",
    className: "q1",
    attributes: { hidden: t(`!${D}.flag`) },
    style: { display: "flex", "&[hidden]": { display: "none !important" } },
    textContent: "show-if-flag",
  }),
  Q1hide: el({
    tagName: "div",
    className: "q1h",
    attributes: { hidden: t(`!${D}.off`) },
    style: { display: "flex", "&[hidden]": { display: "none !important" } },
    textContent: "hide-if-off",
  }),
  Q2: el({
    tagName: "div",
    className: "q2",
    style: { display: t(`${D}.off ? 'flex' : 'none'`) },
    textContent: "style-display",
  }),
  Q3: el({
    tagName: "div",
    children: [
      t(
        `${D}.flag ? [{tagName:'b', className:'bx', style:{color:'red'}, textContent:'\${${D}.title}'}] : []`,
      ),
    ],
  }),
  Q4: el({
    tagName: "div",
    children: arrayOf(t(`${D}.flag ? [1] : []`), { tagName: "b", textContent: "arr" }),
  }),
  Q5: el({
    tagName: "div",
    $switch: t(`${D}.flag ? 'a' : 'b'`),
    cases: { a: { tagName: "b", textContent: "sw-a" }, b: { tagName: "i", textContent: "sw-b" } },
  }),
  // E: escaping
  E1plain: el({ tagName: "p", textContent: "C:\\path `tick` {brace} $5 \\n" }),
  E1attr: el({
    tagName: "p",
    attributes: { "data-x": "C:\\path `tick` {brace} $5" },
    textContent: "x",
  }),
  E1inner: el({ tagName: "div", innerHTML: "<b>C:\\path `tick` {brace} $5</b>" }),
  E1bound: el({ tagName: "p", textContent: "a\\`b \\\\ c " + t(`${D}.title`) }),
  E1boundAttr: el({
    tagName: "p",
    attributes: { "data-x": "a\\`b \\\\ c " + t(`${D}.title`) },
    textContent: "x",
  }),
  E1boundInner: el({ tagName: "div", innerHTML: "a\\`b \\\\ c " + t(`${D}.title`) }),
  E1unescaped: el({ tagName: "div", innerHTML: "a`b \\ c " + t(`${D}.title`) }),
  E2inner: el({ tagName: "div", innerHTML: `&#36;{lit} and ${t(`${D}.title`)}` }),
  E2text: el({ tagName: "p", textContent: "&#36;{lit}" }),
  E2zwsp: el({ tagName: "p", textContent: "a $\u200b{lit} b" }),
  // D: dates
  D1type: el({
    tagName: "p",
    textContent: t(`typeof ${D}.date + ' ' + (${D}.date instanceof Date)`),
  }),
  D1us: el({
    tagName: "p",
    textContent: t(
      `new Date(${D}.date).toLocaleDateString('en-US', {year:'numeric', month:'long', day:'numeric', timeZone:'America/New_York'})`,
    ),
  }),
  D1late: el({
    tagName: "p",
    textContent: t(
      `new Date('2023-12-31T23:30:00Z').toLocaleDateString('en-US', {year:'numeric', month:'long', day:'numeric', timeZone:'America/New_York'})`,
    ),
  }),
  D1time: el({
    tagName: "p",
    textContent: t(
      `new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(${D}.date))`,
    ),
  }),
  // M: components
  M1defaults: el({ tagName: "fp-card", $props: {} }),
  M1bound: el({
    tagName: "fp-card",
    $props: {
      label: t(`${D}.title`),
      url: t(`${D}.url`),
      show: t(`${D}.flag`),
      count: t(`${D}.n`),
      html: t(`${D}.html`),
    },
  }),
  M1hidden: el({
    tagName: "fp-card",
    $props: { label: "Lit", url: "/x/", show: false, count: 9 },
  }),
  M2: el({ tagName: "fp-card", $props: { label: t(`${D}.nope`) } }),
  M2coalesced: el({ tagName: "fp-card", $props: { label: t(`${D}.nope ?? 'fb'`) } }),
  M3show: el({ tagName: "fp-obj", attributes: { hidden: t(`!${D}.flag`) }, $props: {} }),
  M3hide: el({ tagName: "fp-obj", attributes: { hidden: t(`!!${D}.flag`) }, $props: {} }),
  M3obj: el({
    tagName: "fp-obj",
    $props: { link: t(`${D}.link`), img: t(`${D}.img`), list: t(`${D}.tags`) },
  }),
  M4: el({
    tagName: "div",
    children: arrayOf(ptr("entry/data/rows"), {
      tagName: "fp-card",
      $props: { label: t("$map.item.name"), count: t("$map.item.n") },
    }),
  }),
};

describe("bindings matrix, timing: compiler (docs/bindings.md)", () => {
  let out: Record<string, Out> = {};
  let site: BuiltProject;
  const get = (id: string): Out => {
    const o = out[id];
    if (!o) throw new Error(`no case ${id}`);
    return o;
  };
  test("builds every case", async () => {
    ({ out, site } = await matrix(CASES, "compiler"));
    expect(site.code).toBe(0);
  });

  describe("T: textContent", () => {
    test("[T1] a single binding", () => expect(get("T1").html).toBe("<p>Foo Title</p>"));
    test("[T2] literal parts around a binding", () =>
      expect(get("T2").html).toBe("<p>Featured Foo Title Projects</p>"));
    test("[T3] ternary, ||, &&, ??", () => {
      expect(get("T3a").html).toBe("<p>yes</p>");
      expect(get("T3b").html).toBe("<p>fallback</p>");
      expect(get("T3c").html).toBe("<p>has title</p>");
      expect(get("T3d").html).toBe("<p>fallback</p>");
    });
    test("[T4] numbers, false, objects, arrays print as JavaScript prints them", () => {
      expect(get("T4a").html).toBe("<p>42</p>");
      expect(get("T4b").html).toBe("<p>0</p>");
      expect(get("T4c").html).toBe("<p>false</p>");
      expect(get("T4d").html).toBe("<p>[object Object]</p>");
      expect(get("T4e").html).toBe("<p>alpha,beta,gamma</p>");
    });
    test("[T5] length and array methods", () => {
      expect(get("T5a").html).toBe("<p>3</p>");
      expect(get("T5b").html).toBe("<p>ALPHA, BETA, GAMMA</p>");
    });
    test("[T6] a template literal nested in the expression", () =>
      expect(get("T6").html).toBe("<p>a-Foo Title-b</p>"));
    test("[T7] the emitter escapes textContent", () =>
      expect(get("T7").html).toBe("<p>Tom &amp; &lt;Jerry&gt; &quot;q&quot; &#39;x&#39;</p>"));
    test("[T8] a missing value: undefined prints in a template, coalesce it", () => {
      expect(get("T8a").html).toBe("<p>a undefined b</p>");
      expect(get("T8b").html).toBe("<p>a  b</p>");
      expect(get("T8c").html).toBe("<p></p>");
    });
  });

  describe("A: attributes", () => {
    test("[A1] href, data-*, aria-*, src, alt, width, height", () => {
      expect(get("A1").html).toBe(
        '<a href="/items/foo/" data-x="pre-42-post" aria-label="Foo Title">x</a>',
      );
      expect(get("A1img").html).toBe(
        '<img src="/media/a.jpg" alt="An A" width="800" height="600" decoding="async" loading="lazy">',
      );
    });
    test("[A2] false omits, true is bare for presence attributes and the word for aria", () => {
      expect(get("A2true").html).toBe('<input disabled data-k="k">');
      expect(get("A2false").html).toBe('<input data-k="k">');
      expect(get("A2aria").html).toBe('<div aria-hidden="true">x</div>');
      expect(get("A2omit").html).toBe('<a data-k="k">x</a>');
      expect(get("A2empty").html).toBe('<a href="" data-k="k">x</a>');
      expect(get("A2link").html).toBe(
        '<a href="https://example.com/" target="_blank" rel="noopener">x</a>',
      );
    });
    test("[A5] the build counts braces without reading strings: a brace in a string literal costs the attribute its type", () => {
      expect(get("A5ok").html).toBe('<input data-k="k">');
      // `${cond ? '{' : false}` is no longer one expression to the build, so `false` is the text "false".
      expect(get("A5brace").html).toBe('<input disabled="false" data-k="k">');
      // Written as an escape, the same literal keeps the type.
      expect(get("A5escaped").html).toBe('<input data-k="k">');
    });
    test("[A4] a nullish single binding is left to the client", () => {
      expect(get("A4").html).toContain("data-bind");
      expect(get("A4").js).toBe(true);
    });
  });

  describe("H: innerHTML", () => {
    test("[H1] raw HTML from a binding", () => {
      expect(get("H1").html).toBe("<div><p>Hi <b>there</b></p></div>");
      expect(get("H1missing").html).toBe("<div></div>");
    });
    test("[H2] literal markup around bindings, a binding inside an attribute of the markup", () =>
      expect(get("H2").html).toBe(
        '<div><b>pre</b> Foo Title <a href="/items/foo/">link</a></div>',
      ));
    test("[H3] the inline escape for plain text in markup", () =>
      expect(get("H3").html).toBe("<div>Tom &amp; &lt;Jerry&gt; &quot;q&quot; &#39;x&#39;</div>"));
    test("[H4] a list built as an innerHTML expression, also when it is empty", () => {
      expect(get("H4").html).toBe(
        '<ul><li><a href="/topic/a/">Alpha</a></li><li><a href="/topic/b/">Beta</a></li></ul>',
      );
      expect(get("H4empty").html).toBe("<ul></ul>");
      expect(get("H4empty").js).toBe(false);
    });
  });

  describe("S: style", () => {
    test("[S1] a flat style value is resolved into the element's rule", () => {
      expect(get("S1").css).toContain(".s1 { color: #ff0000; padding: 1rem }");
      expect(get("S1bg").css).toContain(".s1bg { background-image: url(/media/a.jpg) }");
    });
    test("[S3] a custom property", () =>
      expect(get("S3").css).toContain(
        ".s3 { --background-image: url(/media/a.jpg); color: var(--c) }",
      ));
    test("[S4] a binding inside a nested style block is lost", () => {
      expect(get("S4hover").css).toBe(".s4h { color: red }");
      expect(get("S4before").css).toBe(".s4b::before { display: block }");
      expect(get("S4static").css).toBe(".s4s { color: #ff0000 } .s4s:hover { color: blue }");
    });
  });

  describe("C, X, K: the positions that do not work", () => {
    test("[C1] a templated className or id is lost under timing: compiler", () => {
      expect(get("C1class").html).toBe("<div>c</div>");
      expect(get("C1id").html).toBe("<div>c</div>");
    });
    test("[C2] a templated first class of an element with a style becomes the selector", () => {
      expect(get("C2").css).toContain(".${state.entry.data.slug} { color: red }");
    });
    test("[X1] top-level hidden and title are bound on the client", () => {
      expect(get("X1hidden").html).toContain("data-bind");
      expect(get("X1title").html).toContain("data-bind");
      expect(get("X1attr").html).toBe('<div title="Foo Title">c</div>');
      expect(get("X1attr").js).toBe(false);
    });
    test("[K1] a string child is not evaluated", () =>
      expect(get("K1").html).toBe("<div>a ${state.entry.data.title} b\n  <b>bold</b></div>"));
    test("[K2] a whole-expression child that yields an array is", () => {
      expect(get("K2true").html).toBe("<div><b>yes</b></div>");
      expect(get("K2false").html).toBe("<div>x\n  y</div>");
    });
    test("[K3] the entry body", () => {
      expect(get("K3").html).toContain("<p>Body");
      expect(get("K3").html).toContain("<strong>text</strong>");
    });
  });

  test("[P1] page title and head meta", () => {
    expect(get("P1").page).toContain("<title>Foo Title</title>");
    expect(get("P1").page).toContain('<meta name="description" content="Foo Title desc">');
  });

  describe("L: loops", () => {
    test("[L1] a pointer into the entry, $map.item and $map.index", () => {
      expect(get("L1").html).toBe(
        '<ul><li data-n="1">r1 #0</li>\n  <li data-n="2">r2 #1</li></ul>',
      );
      expect(get("L1nested").html).toBe(
        '<ul><li><a href="/topic/a/">Alpha</a></li>\n  <li><a href="/topic/b/">Beta</a></li></ul>',
      );
      expect(get("L1").js).toBe(false);
    });
    test("[L2] per-item style", () =>
      expect(get("L2").css).toContain(".row { order: 1 } .row { order: 2 }"));
    test("[L3] an empty or missing array makes the parent a client render", () => {
      for (const id of ["L3", "L3missing"]) {
        expect(get(id).html).toBe('<ul data-bind :render="_children0"></ul>');
        expect(get(id).js).toBe(true);
      }
    });
    test("[L4] a ContentCollection", () => {
      expect(get("L4").html).toBe("<ul><li>Bar Title / bar</li>\n  <li>Foo Title / foo</li></ul>");
      expect(get("L4filter").html).toBe("<ul><li>Foo Title</li></ul>");
      expect(get("L4").js).toBe(false);
    });
    test("[L5] a template state entry bakes but ships JS", () => {
      expect(get("L5").html).toBe("<ul><li>r1</li>\n  <li>r2</li></ul>");
      expect(get("L5").js).toBe(true);
    });
  });

  describe("Q: conditional rendering", () => {
    test("[Q1] attributes.hidden plus the [hidden] rule", () => {
      expect(get("Q1show").html).toBe('<div class="q1">show-if-flag</div>');
      expect(get("Q1hide").html).toBe('<div class="q1h" hidden>hide-if-off</div>');
      expect(get("Q1hide").css).toContain(".q1h[hidden] { display: none !important }");
      expect(get("Q1hide").js).toBe(false);
    });
    test("[Q2] a flat display value", () =>
      expect(get("Q2").css).toContain(".q2 { display: none }"));
    test("[Q3] a children expression omits the element, nested styles still apply", () => {
      expect(get("Q3").html).toBe('<div><b class="bx">Foo Title</b></div>');
      expect(get("Q3").css).toContain(".bx { color: red }");
    });
    test("[Q4] a template items is a client render", () => {
      expect(get("Q4").html).toBe('<div data-bind :render="_list0"></div>');
      expect(get("Q4").js).toBe(true);
    });
    test("[Q5] $switch is a client render", () => {
      expect(get("Q5").html).toBe('<div data-bind :render="_sw0"></div>');
      expect(get("Q5").js).toBe(true);
    });
  });

  describe("E: escaping", () => {
    test("[E1] a string with no binding is verbatim", () => {
      expect(get("E1plain").html).toBe("<p>C:\\path `tick` {brace} $5 \\n</p>");
      expect(get("E1attr").html).toBe('<p data-x="C:\\path `tick` {brace} $5">x</p>');
      expect(get("E1inner").html).toBe("<div><b>C:\\path `tick` {brace} $5</b></div>");
    });
    test("[E1] a string with a binding needs its backslashes and backticks doubled", () => {
      expect(get("E1bound").html).toBe("<p>a`b \\ c Foo Title</p>");
      expect(get("E1boundAttr").html).toBe('<p data-x="a`b \\ c Foo Title">x</p>');
      expect(get("E1boundInner").html).toBe("<div>a`b \\ c Foo Title</div>");
      // Written as is, the template is not evaluated at all.
      expect(get("E1unescaped").html).toBe("<div>a`b \\ c ${state.entry.data.title}</div>");
    });
    test("[E2] a literal dollar-brace survives only as &#36;{ in innerHTML", () => {
      expect(get("E2inner").html).toBe("<div>&#36;{lit} and Foo Title</div>");
      expect(get("E2text").html).toBe("<p>&amp;#36;{lit}</p>");
      expect(get("E2zwsp").html).toBe("<p>a $\u200b{lit} b</p>");
    });
  });

  describe("D: dates", () => {
    test("[D1] frontmatter dates are UTC strings; Intl formats them in the site zone", () => {
      expect(get("D1type").html).toBe("<p>string false</p>");
      expect(get("D1us").html).toBe("<p>February 15, 2024</p>");
      expect(get("D1late").html).toBe("<p>December 31, 2023</p>");
      expect(get("D1time").html).toBe("<p>12:30 PM</p>");
    });
  });

  describe("M: components", () => {
    test("[M1] defaults, bound props, literal props", () => {
      const defaults = get("M1defaults").html;
      expect(defaults).toContain("<h3>Default label</h3>");
      expect(defaults).toContain("<div>shown-if-show</div>");
      expect(defaults).toContain('<div class="cx"><i>default</i></div>');
      const bound = get("M1bound").html;
      expect(bound).toContain("<h3>Foo Title</h3>");
      expect(bound).toContain('<a href="/items/foo/" data-count="42">Foo Title!</a>');
      expect(bound).toContain('<div class="cx"><p>Hi <b>there</b></p></div>');
      const lit = get("M1hidden").html;
      expect(lit).toContain("<div hidden>shown-if-show</div>");
      expect(lit).toContain('<a href="/x/" data-count="9">Lit!</a>');
    });
    test("[M2] a nullish prop arrives as null", () => {
      expect(get("M2").html).toContain("<h3></h3>");
      expect(get("M2").html).toContain("null!");
      expect(get("M2coalesced").html).toContain("<h3>fb</h3>");
    });
    test("[M3] attributes.hidden on the instance, object and array props", () => {
      expect(get("M3show").html).not.toContain("hidden");
      expect(get("M3hide").html.startsWith("<fp-obj hidden")).toBe(true);
      const obj = get("M3obj").html;
      expect(obj).toContain(
        '<a href="https://example.com/" target="_blank">https://example.com/</a>',
      );
      expect(obj).toContain('<img src="/media/a.jpg" alt="An A"');
      expect(obj).toContain("<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>");
    });
    test("[M4] props from $map in a loop", () => {
      const html = get("M4").html;
      expect(html).toContain("<h3>r1</h3>");
      expect(html).toContain("<h3>r2</h3>");
      expect(html).toContain('data-count="2"');
    });
  });

  test("[TIM1] under timing: compiler a fully resolved page ships no JavaScript", () => {
    for (const id of ["T1", "A1", "H1", "S1", "L1", "L4", "Q1hide", "M1bound", "D1us"]) {
      expect(get(id).js).toBe(false);
    }
  });

  // `jx validate` rejects three of the constructs the matrix shows the build tolerating: a template
  // for `hidden`, for `$switch` and for `Array.items` (each must be an object or a boolean).
  const REJECTED = ["Q4", "Q5", "X1hidden"];

  test("the matrix project passes jx validate, except the constructs the schema rejects", async () => {
    const accepted = Object.fromEntries(
      Object.entries(CASES).filter(([id]) => !REJECTED.includes(id)),
    );
    const dir = writeJxProject(projectFiles(accepted, "compiler"), { name: "matrix-validate" });
    const result = await validateJxProject(dir);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("[Q4] [Q5] [X1] jx validate rejects a template for items, $switch and a top-level hidden", async () => {
    for (const id of REJECTED) {
      const dir = writeJxProject(projectFiles({ [id]: CASES[id]! }, "compiler"), {
        name: "matrix-reject",
      });
      const result = await validateJxProject(dir);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.includes(`c-${id}`))).toBe(true);
    }
  });
});

describe("bindings matrix, default timing (docs/bindings.md)", () => {
  const subset: Record<string, Case> = {
    T1: CASES.T1!,
    C1class: CASES.C1class!,
    C1id: CASES.C1id!,
    X1hidden: CASES.X1hidden!,
    X1title: CASES.X1title!,
  };
  test("[C1] className and id bindings resolve without timing: compiler", async () => {
    const { out } = await matrix(subset);
    expect(out.C1class?.html).toBe('<div class="a on">c</div>');
    expect(out.C1id?.html).toBe('<div id="x-foo">c</div>');
  });
  test("[X1] a top-level hidden is static and bound", async () => {
    const { out } = await matrix(subset);
    expect(out.X1hidden?.html).toBe('<div data-bind :hidden="_t0">c</div>');
    expect(out.X1title?.html).toBe('<div title="Foo Title" data-bind :title="_t0">c</div>');
  });
  test("[TIM2] a ContentEntry without timing: compiler ships JavaScript even when nothing is unresolved", async () => {
    const { out } = await matrix(subset);
    expect(out.T1?.html).toBe("<p>Foo Title</p>");
    expect(out.T1?.js).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Part 2: what the dynamic modules emit, built.
//
// The same real blocks are turned into nodes twice, with the same functions: once for a static page of a
// real post (every value known) and once for an entry template (every value a binding). Both are built
// into one Jx project, the entry template over the post's own entry (frontmatter written from its entry
// data), and the two pages must say the same thing about every block. That is the proof that the
// bindings the dynamic modules write mean what the values they write for a static page mean.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

type JsonObject = Record<string, unknown>;

const urlTools = new Map<SiteName, ReturnType<typeof createUrlTools>>();

function toolsOf(site: SiteName, loaded: LoadedSite): ReturnType<typeof createUrlTools> {
  let t = urlTools.get(site);
  if (!t) {
    t = createUrlTools(
      loaded.model,
      buildRoutes(loaded.model, loaded.acf, { media: loaded.media }),
      loaded.media,
    );
    urlTools.set(site, t);
  }
  return t;
}

async function realCtx(
  site: SiteName,
  subject: Subject,
  over: Partial<ConvertCtx> = {},
): Promise<ConvertCtx> {
  const loaded = await loadSite(site);
  const t = toolsOf(site, loaded);
  const ctx = await makeCtx(site, subject, { urlFor: t.urlFor, rewriteUrl: t.rewriteUrl, ...over });
  Object.assign(ctx, { urlForAuthor: t.urlForAuthor, urlForArchive: t.urlForArchive });
  return ctx;
}

/** A frontmatter value as YAML: JSON is YAML. */
const yamlOf = (value: unknown): string => JSON.stringify(value);

function markdownEntry(data: JsonObject, body: string): string {
  const lines = Object.entries(data).map(([k, v]) => `${JSON.stringify(k)}: ${yamlOf(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

const TAGS: Record<string, string> = { "cwicly/paragraph": "p", "cwicly/button": "button" };

/** The attributes a link puts on an `a`, with nothing left that would print `undefined`. */
function linkAttributes(link: NonNullable<ReturnType<typeof blockLink>>): JsonObject {
  return {
    href: link.href,
    ...(link.target === undefined ? {} : { target: link.target }),
    ...(link.rel === undefined ? {} : { rel: link.rel }),
    ...(link.title === undefined ? {} : { title: link.title }),
  };
}

/**
 * A block as a Jx node, using only the dynamic modules: its text, its link, its image, its background and
 * its visibility. Blocks with none of these are left out. The node is wrapped by the caller.
 */
function blockNode(b: WpBlock, ctx: ConvertCtx): JxNode | undefined {
  if (!b.name) return undefined;
  const a = b.attrs;
  const vis = blockVisibility(b, ctx);
  if (vis.omit) return undefined;
  const link = blockLink(b, ctx);
  const bg = blockBackground(b, ctx);
  const connected =
    (a.componentConnectors as { content?: unknown } | undefined)?.content !== undefined;
  const dynamicText = typeof a.dynamic === "string" || a.content !== undefined || connected;
  const isText = /^cwicly\/(heading|paragraph|button)$/.test(b.name);
  const isImage = b.name === "cwicly/image";
  if (!bg && !vis.hidden && !link?.href && !(isImage || (isText && dynamicText))) return undefined;
  const base: JsonObject = {};
  const attributes: JsonObject = {};
  let style: JsonObject | undefined;
  if (bg) style = { [bg.property]: bg.value };
  if (vis.hidden) {
    attributes.hidden = vis.hidden;
    style = { display: "block", ...style, ...vis.hiddenStyle };
  }
  if (style) {
    base.className = typeof a.classID === "string" ? a.classID : "blk";
    base.style = style;
  }
  if (isImage) {
    const spec = blockImage(b, ctx);
    if (!spec) return undefined;
    Object.assign(attributes, { src: spec.src, alt: spec.alt });
    if (spec.width !== undefined) attributes.width = spec.width;
    if (spec.height !== undefined) attributes.height = spec.height;
    return { tagName: "img", ...base, attributes } as JxNode;
  }
  const content = (isText ? blockContent(b, ctx) : undefined) ?? {};
  if (link?.href !== undefined && link.anchor === "inner") {
    const tag = typeof a.headingTag === "string" ? a.headingTag : "h2";
    return {
      tagName: tag,
      ...base,
      attributes,
      children: [{ tagName: "a", attributes: linkAttributes(link), ...content }],
    } as JxNode;
  }
  if (link?.href !== undefined) {
    return {
      tagName: "a",
      ...base,
      attributes: { ...attributes, ...linkAttributes(link) },
      ...content,
    } as JxNode;
  }
  const tag =
    b.name === "cwicly/heading"
      ? typeof a.headingTag === "string"
        ? a.headingTag
        : "h2"
      : (TAGS[b.name] ?? "div");
  return { tagName: tag, ...base, attributes, ...content } as JxNode;
}

interface Section {
  /** `b12`: the index of the block among all the blocks of its template, the same in every conversion of it. */
  id: string;
  node: JxNode;
}

/** The nodes of every dynamic block of a template, each with the id of its block. */
function sectionsOf(blocks: WpBlock[], ctx: ConvertCtx): Section[] {
  const out: Section[] = [];
  let n = 0;
  walkBlocks(blocks, (b) => {
    const id = `b${n++}`;
    const node = blockNode(b, ctx);
    if (node) out.push({ id, node });
  });
  return out;
}

/** What one built section says: text, link, image and visibility. */
interface Facts {
  text: string;
  href: string | undefined;
  src: string | undefined;
  alt: string | undefined;
  hidden: boolean;
  background: string | undefined;
}

type P5 = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5[];
};

function factsOf(page: string, id: string): Facts | undefined {
  const m = new RegExp(`<section data-s="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(page);
  if (!m) return undefined;
  const inner = m[1] ?? "";
  const frag = parse(`<body>${inner}</body>`) as unknown as P5;
  let text = "";
  let href: string | undefined;
  let src: string | undefined;
  let alt: string | undefined;
  let hidden = false;
  const walk = (n: P5): void => {
    if (n.nodeName === "#text") text += n.value ?? "";
    const at = Object.fromEntries((n.attrs ?? []).map((x) => [x.name, x.value]));
    if (n.nodeName === "a" && href === undefined && at.href !== undefined) href = at.href;
    if (n.nodeName === "img") {
      src = at.src;
      alt = at.alt;
    }
    if (at.hidden !== undefined) hidden = true;
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(frag);
  const css = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((x) => x[1] ?? "").join(" ");
  const bgm = new RegExp(`\\.${id}\\s*\\{[^}]*--background-image:\\s*([^;}]*)`).exec(css);
  return {
    text: decodeEntities(text).replace(/\s+/g, " ").trim(),
    href,
    src,
    alt,
    hidden,
    background: bgm?.[1]?.trim(),
  };
}

const wrap = (sections: Section[]): JsonObject[] =>
  sections.map((s) => ({
    tagName: "section",
    attributes: { "data-s": s.id },
    children: [renameClass(s.node, s.id)],
  }));

/** Every section's own class is its id, so a page's rules never collide with another section's. */
function renameClass(node: JxNode, id: string): JxNode {
  if (typeof node === "string") return node;
  const out = { ...node } as JsonObject;
  if (out.className !== undefined) out.className = id;
  return out as JxNode;
}

const PROJECT = {
  name: "dyn",
  url: "https://example.com",
  extensions: ["@jxsuite/parser"],
  defaults: { layout: "./layouts/base.json" },
};

const EXPECTED: Record<string, Record<string, number>> = {
  "fineline single-project": {
    kept: 135,
    decidedHidden: 24,
    text: 102,
    href: 27,
    src: 18,
    alt: 0,
    background: 0,
  },
  "fineline single-service": {
    kept: 92,
    decidedHidden: 16,
    text: 76,
    href: 9,
    src: 8,
    alt: 0,
    background: 2,
  },
  "fineline single": {
    kept: 12,
    decidedHidden: 0,
    text: 10,
    href: 4,
    src: 2,
    alt: 2,
    background: 0,
  },
  "ap single-post": {
    kept: 52,
    // (The "More from this series" section of each of the two posts, which have no series: the shortcode condition is decided.)
    decidedHidden: 4,
    text: 30,
    href: 14,
    src: 8,
    alt: 6,
    background: 2,
  },
  "ap single-episode": {
    kept: 60,
    decidedHidden: 20,
    text: 34,
    href: 6,
    src: 8,
    alt: 0,
    background: 2,
  },
};

describe("a collection entry page built from the real blocks of a template", () => {
  const CASES: { site: SiteName; template: string; type: string; posts: number }[] = [
    { site: "fineline", template: "single-project", type: "project", posts: 3 },
    { site: "fineline", template: "single-service", type: "service", posts: 2 },
    { site: "fineline", template: "single", type: "post", posts: 2 },
    { site: "ap", template: "single-post", type: "post", posts: 2 },
    { site: "ap", template: "single-episode", type: "episode", posts: 2 },
  ];

  for (const c of CASES) {
    test(`${c.site} ${c.template}: the entry page says what the static page of each post says`, async () => {
      const loaded = await loadSite(c.site);
      const tools = toolsOf(c.site, loaded);
      const entryCtx = await realCtx(
        c.site,
        { kind: "template", slug: c.template },
        { mode: "entry", entryType: c.type },
      );
      const probe = await realCtx(c.site, { kind: "post", id: 0 });
      const posts = [...loaded.model.posts.values()]
        .filter((p) => p.type === c.type && p.status === "publish")
        .map((p) => ({ p, size: JSON.stringify(postFacts(probe, p)).length }))
        .sort((a, b) => b.size - a.size)
        .slice(0, c.posts)
        .map((x) => x.p);
      const blocks = subjectBlocks(loaded, { kind: "template", slug: c.template });
      const entrySections = sectionsOf(blocks, entryCtx);
      expect(entrySections.length).toBeGreaterThanOrEqual(5);

      const files: Record<string, ProjectFile> = {
        "project.json": {
          ...PROJECT,
          content: {
            items: {
              source: "content/items",
              format: "Markdown",
              schema: {
                type: "object",
                properties: { title: { type: "string" }, slug: { type: "string" } },
                required: ["title"],
              },
            },
          },
        },
        "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
        "pages/e/[slug].json": {
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
          children: wrap(entrySections),
        },
      };
      const staticSections = new Map<number, Section[]>();
      for (const post of posts) {
        const data = { ...postData(probe, post) };
        // The entry data contract has no key for an author's page; the template asks for `authorUrl`.
        const authorUrl = tools.urlForAuthor(post.authorId);
        if (authorUrl !== undefined) data.authorUrl = authorUrl;
        // An entry has the body its post had: a post with no content has none, which `postcontent` conditions read.
        files[`content/items/${post.slug}.md`] = markdownEntry(
          data,
          post.content.trim() === "" ? "" : "Body of the entry.",
        );
        const statCtx = await realCtx(c.site, { kind: "post", id: post.id }, { mode: "static" });
        const sections = sectionsOf(blocks, statCtx);
        staticSections.set(post.id, sections);
        files[`pages/s-${post.id}.json`] = { title: post.title, children: wrap(sections) };
      }
      const site = await buildJxProject(files, { name: "entry" });
      expect(site.code).toBe(0);
      let kept = 0;
      let decidedHidden = 0;
      const seen = { text: 0, href: 0, src: 0, alt: 0, background: 0 };
      for (const post of posts) {
        const entryPage = site.html(`/e/${post.slug}/`);
        const staticPage = site.html(`/s-${post.id}/`);
        // The entry page ships no JavaScript: every binding was evaluated by the build.
        expect(site.exists(`e/${post.slug}/app.js`)).toBe(false);
        expect(entryPage).not.toContain("data-bind");
        const statIds = new Set((staticSections.get(post.id) ?? []).map((x) => x.id));
        for (const sec of entrySections) {
          const e = factsOf(entryPage, sec.id) as Facts;
          expect(e).toBeDefined();
          if (statIds.has(sec.id)) {
            // A block the static page keeps is shown by the entry page, and says the same.
            const st = factsOf(staticPage, sec.id) as Facts;
            expect(e.hidden).toBe(false);
            expect(`${sec.id}: ${compareFacts(e, st)}`).toBe(`${sec.id}: `);
            kept++;
            if (e.text !== "") seen.text++;
            if (e.href !== undefined) seen.href++;
            if (e.src !== undefined) seen.src++;
            if (e.alt) seen.alt++;
            if (e.background !== undefined) seen.background++;
          } else {
            // A block the static page leaves out (its condition is false, or it has no image to show) is hidden or
            // empty on the entry page.
            const empty =
              e.text === "" &&
              e.src === undefined &&
              e.href === undefined &&
              (e.background === undefined || e.background === "none");
            expect(`${sec.id}: ${e.hidden || empty}`).toBe(`${sec.id}: true`);
            decidedHidden++;
          }
        }
      }
      expect(kept).toBeGreaterThan(posts.length * 4);
      if (c.template !== "single" && c.template !== "single-post")
        expect(decidedHidden).toBeGreaterThan(0);
      // The numbers are the real blocks of real posts: what was compared, so a pass cannot be an empty one.
      const got: Record<string, number> = { kept, decidedHidden, ...seen };
      expect(got).toEqual(EXPECTED[`${c.site} ${c.template}`] as Record<string, number>);
    });
  }
});

/**
 * What differs between an entry page's section and the static page's. Nothing is applied to the entry's
 * text: `postData` holds the entry as the contract writes it, with the text as WordPress prints it.
 */
function compareFacts(entry: Facts, stat: Facts): string {
  const diffs: string[] = [];
  if (entry.text !== stat.text) diffs.push(`text: ${entry.text} != ${stat.text}`);
  if (entry.href !== stat.href) diffs.push(`href: ${entry.href} != ${stat.href}`);
  if (entry.src !== stat.src) diffs.push(`src: ${entry.src} != ${stat.src}`);
  if (entry.alt !== stat.alt) diffs.push(`alt: ${entry.alt} != ${stat.alt}`);
  if (entry.background !== stat.background)
    diffs.push(`background: ${entry.background} != ${stat.background}`);
  return diffs.join("; ");
}

// ── A component ─────────────────────────────────────────────────────────────────────────────────

async function componentCtx(site: SiteName, ref: string): Promise<ConvertCtx> {
  const ctx = await realCtx(site, { kind: "component", ref });
  ctx.props = new Map(ctx.components.get(ref)?.props.map((p) => [p.id, p.key]));
  return ctx;
}

describe("a component built from the real blocks of Cwicly components", () => {
  test("the icon card and the image card: props are read from the state, richtext is raw, an absent link or image leaves its attribute out", async () => {
    const loaded = await loadSite("fineline");
    const card = await componentCtx("fineline", "0a275b695a");
    const image = await componentCtx("fineline", "244868a12d");
    const cardInfo = card.components.get("0a275b695a");
    const imageInfo = image.components.get("244868a12d");
    const keyOf = (info: typeof cardInfo, name: string): string =>
      info?.props.find((p) => p.name === name)?.key ?? "";
    const heading = keyOf(cardInfo, "Heading");
    const paragraph = keyOf(cardInfo, "Paragraph");
    const buttonLink = keyOf(cardInfo, "Button Link");
    const buttonText = keyOf(cardInfo, "Button Text");
    expect([heading, paragraph, buttonLink, buttonText].every((k) => k !== "")).toBe(true);

    const nodesOf = (ctx: ConvertCtx, ref: string): JxNode[] => {
      const out: JxNode[] = [];
      walkBlocks(subjectBlocks(loaded, { kind: "component", ref }), (b) => {
        const node = blockNode(b, ctx);
        if (node) out.push(node);
      });
      return out;
    };
    const cardNodes = nodesOf(card, "0a275b695a");
    const imageNodes = nodesOf(image, "244868a12d");
    expect(JSON.stringify(cardNodes)).toContain(`\${state.${heading} ?? ''}`);
    expect(JSON.stringify(cardNodes)).toContain(`state.${buttonLink}?.href`);
    expect(JSON.stringify(imageNodes)).toContain("state.image?.src");

    const files: Record<string, ProjectFile> = {
      "project.json": PROJECT,
      "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
      "components/fp-icon-card.json": {
        tagName: "fp-icon-card",
        state: {
          [heading]: "Lorem Ipsum",
          [paragraph]: "",
          [buttonText]: "Learn More",
          [buttonLink]: { href: "", target: "", rel: "", title: "" },
        },
        children: cardNodes,
      },
      "components/fp-image-card.json": {
        tagName: "fp-image-card",
        state: {
          image: { src: "", alt: "", width: 0, height: 0 },
          [keyOf(imageInfo, "Heading")]: "Lorem Ipsum",
        },
        children: imageNodes,
      },
      "pages/index.json": {
        title: "components",
        $elements: [
          { $ref: "../components/fp-icon-card.json" },
          { $ref: "../components/fp-image-card.json" },
        ],
        children: [
          {
            tagName: "div",
            attributes: { "data-i": "one" },
            children: [
              {
                tagName: "fp-icon-card",
                $props: {
                  [heading]: "Tom & <Jerry>",
                  [paragraph]: "<p>Hi <b>there</b> &amp; you</p>",
                  [buttonLink]: {
                    href: "/quote/",
                    target: "_blank",
                    rel: "noopener",
                    title: "Quote",
                  },
                },
              },
            ],
          },
          {
            tagName: "div",
            attributes: { "data-i": "two" },
            children: [
              {
                tagName: "fp-icon-card",
                $props: { [heading]: "Second", [paragraph]: "<p>Plain</p>" },
              },
            ],
          },
          {
            tagName: "div",
            attributes: { "data-i": "three" },
            children: [
              {
                tagName: "fp-image-card",
                $props: {
                  image: { src: "/media/a.jpg", alt: "An A", width: 800, height: 600 },
                  [keyOf(imageInfo, "Heading")]: "Pic",
                },
              },
            ],
          },
          {
            tagName: "div",
            attributes: { "data-i": "four" },
            children: [
              { tagName: "fp-image-card", $props: { [keyOf(imageInfo, "Heading")]: "No pic" } },
            ],
          },
        ],
      },
    };
    const site = await buildJxProject(files, { name: "components" });
    expect(site.code).toBe(0);
    const html = site.html("/");
    const part = (id: string): string =>
      new RegExp(`<div data-i="${id}">([\\s\\S]*?)</fp-(?:icon|image)-card>`).exec(html)?.[1] ?? "";
    const one = part("one");
    expect(one).toContain("<h3>Tom &amp; &lt;Jerry&gt;</h3>");
    // A richtext property is markup, written raw.
    expect(one).toContain("<p>Hi <b>there</b> &amp; you</p>");
    expect(one).toMatch(/<a [^>]*href="\/quote\/"/);
    expect(one).toMatch(/<a [^>]*target="_blank"/);
    expect(one).toMatch(/<a [^>]*rel="noopener"/);
    expect(one).toMatch(/<a [^>]*title="Quote"/);
    const two = part("two");
    expect(two).toContain("<h3>Second</h3>");
    expect(two).not.toMatch(/href=/);
    expect(two).not.toMatch(/target=/);
    expect(part("three")).toMatch(
      /<img [^>]*src="\/media\/a\.jpg"[^>]*alt="An A"[^>]*width="800"[^>]*height="600"/,
    );
    expect(part("four")).not.toMatch(/src=/);
    expect(part("four")).toContain("No pic");
    // Every binding was evaluated by the build.
    expect(html).not.toContain("data-bind");
    expect(site.exists("app.js")).toBe(false);
  });

  test("the emitted pages and components pass jx validate", async () => {
    const loaded = await loadSite("fineline");
    const card = await componentCtx("fineline", "0a275b695a");
    const nodes: JxNode[] = [];
    walkBlocks(subjectBlocks(loaded, { kind: "component", ref: "0a275b695a" }), (b) => {
      const n = blockNode(b, card);
      if (n) nodes.push(n);
    });
    const entry = await realCtx(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryType: "project" },
    );
    const sections = sectionsOf(
      subjectBlocks(loaded, { kind: "template", slug: "single-project" }),
      entry,
    );
    const dir = writeJxProject(
      {
        "project.json": {
          ...PROJECT,
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
        "components/fp-icon-card.json": { tagName: "fp-icon-card", state: {}, children: nodes },
        "pages/e/[slug].json": {
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
          children: wrap(sections),
        },
      },
      { name: "validate" },
    );
    const result = await validateJxProject(dir);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ── Dates, the seam and galleries, built ─────────────────────────────────────────────────────────

describe("the rest of what the modules emit, built", () => {
  test("[D2] the current date in a plain page is evaluated by the build and ships no JavaScript", async () => {
    const ctx = await realCtx("fineline", { kind: "post", id: 5246 });
    const year = resolveTokens("(c) <ccd>custom_current_date=Y</ccd> {sitetitle}", ctx);
    const long = resolveTokens("{currentdate=4=1}", ctx);
    const site = await buildJxProject(
      {
        "project.json": PROJECT,
        "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
        "pages/index.json": {
          title: "d",
          children: [
            { tagName: "p", attributes: { "data-k": "year" }, textContent: year },
            { tagName: "p", attributes: { "data-k": "long" }, textContent: long },
          ],
        },
      },
      { name: "date" },
    );
    expect(site.code).toBe(0);
    const html = site.html("/");
    const now = new Date();
    const zone = "America/New_York";
    const y = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric" }).format(now);
    expect(html).toContain(`<p data-k="year">(c) ${y} finelinepainting.pro</p>`);
    const monthName = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "long" }).format(
      now,
    );
    expect(html).toMatch(new RegExp(`<p data-k="long">${monthName} \\d{1,2}, ${y} </p>`));
    expect(html).not.toContain("data-bind");
    expect(site.exists("app.js")).toBe(false);
  });

  test("saved markup with tokens, converted and finished, builds for an entry and for a static page", async () => {
    const loaded = await loadSite("fineline");
    const post = (await (async () => {
      const probe = await realCtx("fineline", { kind: "post", id: 0 });
      return [...loaded.model.posts.values()]
        .filter((p) => p.type === "project" && p.status === "publish")
        .map((p) => ({ p, n: JSON.stringify(postFacts(probe, p)).length }))
        .sort((a, b) => b.n - a.n)[0]?.p;
    })()) as WpPost;
    const probe = await realCtx("fineline", { kind: "post", id: post.id }, { mode: "static" });
    const entry = await realCtx(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryType: "project" },
    );
    const html = [
      `<h3 class="heading-c235f2d"><a href="{pageurl}">{title}</a></h3>`,
      `<img class="image-c110644" src="{featuredimage=true=medium_large=false=true=false}" alt=""/>`,
      `<div class="div-x" style="--background-image:url({bgfeaturedimage});"><span class="before">About This </span>{title}</div>`,
      `<p>{postexcerpt=60}<span class="after">... Read More</span> <ccd>custom_current_date=Y</ccd></p>`,
    ].join("\n");
    const data = postData(probe, post);
    const files: Record<string, ProjectFile> = {
      "project.json": {
        ...PROJECT,
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
      [`content/items/${post.slug}.md`]: markdownEntry(data, "Body"),
      "pages/e/[slug].json": {
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
        children: [{ tagName: "main", children: tokenNodes(html, entry) }],
      },
      "pages/s.json": {
        title: "static",
        children: [{ tagName: "main", children: tokenNodes(html, probe) }],
      },
    };
    const site = await buildJxProject(files, { name: "seam" });
    expect(site.code).toBe(0);
    const main = (page: string): string => /<main>([\s\S]*?)<\/main>/.exec(page)?.[1] ?? "";
    const clean = (m: string): string =>
      m
        .replace(/\s+/g, " ")
        .replace(/ class="[^"]*"/g, "")
        .replace(/<style>[\s\S]*?<\/style>/g, "")
        .trim();
    const e = main(site.html(`/e/${post.slug}/`));
    const st = main(site.html("/s/"));
    expect(e).toContain(`<a href="${probe.urlFor("post", post.id)}">`);
    // A static page prints text where an entry's binding is a span of its own: the same to the eye.
    const flat = (m: string): string =>
      clean(m)
        .replace(/<\/?span>/g, "")
        .replace(/&#39;|’/g, "'")
        .replace(/\s+/g, " ");
    expect(flat(e)).toBe(flat(st));
    expect(site.html(`/e/${post.slug}/`)).not.toContain("data-bind");
    expect(site.exists(`e/${post.slug}/app.js`)).toBe(false);
    expect(e).toContain((data.featuredImage as { src: string }).src);
  });

  test("a gallery that belongs to the entry builds to its figures, or to an empty container, with no JavaScript", async () => {
    const loaded = await loadSite("fineline");
    const entry = await realCtx(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryType: "project" },
    );
    const gallery = (() => {
      let g: WpBlock | undefined;
      walkBlocks(subjectBlocks(loaded, { kind: "template", slug: "single-project" }), (b) => {
        if (!g && b.name === "cwicly/gallery") g = b;
      });
      return g as WpBlock;
    })();
    const spec = blockGallery(gallery, entry);
    const markup = galleryMarkup(spec as NonNullable<typeof spec>);
    const name = ((spec as NonNullable<typeof spec>).list as string)
      .replace(/^\(state\.entry\.data\./, "")
      .replace(/ \?\? \[\]\)$/, "");
    const files: Record<string, ProjectFile> = {
      "project.json": {
        ...PROJECT,
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
      "content/items/with.md": markdownEntry(
        {
          title: "With",
          slug: "with",
          [name]: [
            { src: "/media/a.jpg", alt: "A & B", width: 5, height: 6 },
            { src: "/media/b.jpg", alt: "" },
          ],
        },
        "x",
      ),
      "content/items/without.md": markdownEntry({ title: "Without", slug: "without" }, "x"),
      "pages/e/[slug].json": {
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
        children: [{ tagName: "div", attributes: { "data-g": "1" }, innerHTML: markup }],
      },
    };
    const site = await buildJxProject(files, { name: "gallery" });
    expect(site.code).toBe(0);
    const grab = (page: string): string =>
      /<div data-g="1">([\s\S]*?)<\/div>\s*<\/div>|<div data-g="1">([\s\S]*?)<\/div>/.exec(
        page,
      )?.[0] ?? "";
    const withPage = site.html("/e/with/");
    expect(withPage).toContain(
      '<figure class="cc-gallery-card"><a href="/media/a.jpg"><img src="/media/a.jpg" alt="A &amp; B" width="5" height="6"',
    );
    expect(withPage).toContain('<figure class="cc-gallery-card"><a href="/media/b.jpg">');
    expect(grab(site.html("/e/without/"))).toContain('<div data-g="1"></div>');
    expect(site.html("/e/without/")).not.toContain("data-bind");
    expect(site.exists("e/without/app.js")).toBe(false);
    expect(site.exists("e/with/app.js")).toBe(false);
  });

  test("a menu and a post's content are markers the converters replace: they build to empty elements, never to text", async () => {
    const ctx = await realCtx("fineline", { kind: "part", slug: "header" });
    const nodes = tokenNodes(
      '<nav aria-label="{menuname}">{menu}</nav><article>{postcontent}</article>',
      ctx,
      {
        name: "cwicly/menu",
        attrs: { menuSelected: "5" },
        innerBlocks: [],
        innerHTML: "",
        innerContent: [],
      },
    );
    const site = await buildJxProject(
      {
        "project.json": PROJECT,
        "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
        "pages/index.json": { title: "m", children: nodes },
      },
      { name: "markers" },
    );
    expect(site.code).toBe(0);
    const html = site.html("/");
    expect(html).toContain(
      '<nav aria-label="Main Menu"><wp2jx-menu data-menu="5"></wp2jx-menu></nav>',
    );
    expect(html).toContain("<article><wp2jx-post-content></wp2jx-post-content></article>");
  });
});
