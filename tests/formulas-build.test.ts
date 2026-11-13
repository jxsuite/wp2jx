/**
 * The named formulas, built by the real Jx (docs/bindings.md, section 5.1). Two things are measured:
 *
 * 1. What the installed Jx makes of a call when the formula is in `project.json`'s `state`: where it
 *    evaluates the call (a page, a row of a mapped list, the item of a computed list), and whether the
 *    pages stay free of JavaScript. `jxFormulas()` is the converter's answer to that question, asked
 *    of the installed packages without building anything, and it is held to the build here in both
 *    directions: a Jx release that starts (or stops) building a formula into a static page is seen.
 * 2. What a migrated project holds (the calls settled, `settleFormulas`): every binding resolved in
 *    the HTML and no JavaScript on any page, whichever Jx is installed.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "./helpers/jx-build.ts";
import type { BuiltProject, ProjectFile } from "./helpers/jx-build.ts";
import { ALL_FORMULAS, FORMULAS, formulaCall, type FormulaName } from "../src/formulas.ts";
import { jxComponentFormulas, jxFormulas } from "../src/emit/project.ts";

setDefaultTimeout(120_000);
afterAll(cleanupJxProjects);

const FOO = `---
title: Foo Title
slug: foo
date: 2024-02-15T17:30:00Z
n: 42
zero: 0
amp: "Tom & <Jerry> \\"q\\" 'x'"
---

Body.
`;

const BAR = `---
title: Bar Title
slug: bar
date: 2023-12-31T23:30:00Z
n: 7
---

Second body.
`;

const t = (expr: string): string => `\${${expr}}`;
const D = "state.entry.data";
const OPTIONS = { year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" };

const entry = {
  $prototype: "ContentEntry",
  contentType: "items",
  field: "slug",
  id: { $ref: "#/$params/slug" },
  $src: "@jxsuite/parser/ContentEntry.class.json",
  timing: "compiler",
};
const all = {
  $prototype: "ContentCollection",
  contentType: "items",
  $src: "@jxsuite/parser/ContentCollection.class.json",
  timing: "compiler",
};

/** One element per place a call can stand, each named by `data-k`. */
const NODES: Record<FormulaName | "list" | "rows" | "nested" | "component", unknown> = {
  formatDate: {
    tagName: "p",
    attributes: { "data-k": "formatDate" },
    textContent: t(formulaCall("formatDate", `${D}.date`, OPTIONS)),
  },
  notEmpty: [
    {
      tagName: "p",
      attributes: { "data-k": "notEmpty", hidden: t(`!${formulaCall("notEmpty", `${D}.zero`)}`) },
      textContent: "zero",
    },
    {
      tagName: "p",
      attributes: { "data-k": "notEmpty-n", hidden: t(`!${formulaCall("notEmpty", `${D}.n`)}`) },
      textContent: "n",
    },
  ],
  orBlank: [
    {
      tagName: "p",
      attributes: { "data-k": "orBlank" },
      textContent: t(`${formulaCall("orBlank", `${D}.zero`)} || 'none'`),
    },
    {
      tagName: "p",
      attributes: { "data-k": "orBlank-n" },
      textContent: `n=${t(formulaCall("orBlank", `${D}.n`))}`,
    },
  ],
  escapeHtml: {
    tagName: "p",
    attributes: { "data-k": "escapeHtml" },
    innerHTML: t(formulaCall("escapeHtml", `${D}.amp`)),
  },
  nested: {
    tagName: "p",
    attributes: { "data-k": "nested" },
    innerHTML: t(`${formulaCall("escapeHtml", formulaCall("orBlank", `${D}.amp`))} || 'none'`),
  },
  rows: {
    tagName: "ul",
    attributes: { "data-k": "rows" },
    children: {
      $prototype: "Array",
      items: { $ref: "#/state/all" },
      map: {
        tagName: "li",
        textContent: t(formulaCall("formatDate", "$map.item.data.date", OPTIONS)),
      },
    },
  },
  list: {
    tagName: "ul",
    attributes: { "data-k": "list" },
    children: [
      t(
        `(state.all ?? []).map(($i0, $x0) => ({tagName: 'li', textContent: ${formulaCall("formatDate", "$i0.data.date", OPTIONS)}}))`,
      ),
    ],
  },
  component: {
    tagName: "fp-x",
    attributes: { "data-k": "component" },
    $props: { label: t(`${D}.amp`) },
  },
};

const COMPONENT = {
  tagName: "fp-x",
  state: { label: "a<b" },
  children: [{ tagName: "i", innerHTML: t(formulaCall("escapeHtml", "state.label")) }],
};

function project(
  nodes: unknown[],
  extra: { state?: Record<string, unknown>; lang?: string; component?: boolean } = {},
): Record<string, ProjectFile> {
  return {
    "project.json": {
      name: "formulas",
      url: "https://example.com",
      extensions: ["@jxsuite/parser"],
      defaults: { layout: "./layouts/base.json", lang: extra.lang ?? "en-US" },
      ...(extra.state === undefined ? {} : { state: extra.state }),
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
    ...(extra.component === true ? { "components/fp-x.json": COMPONENT } : {}),
    "pages/plain.json": { title: "plain", children: [{ tagName: "p", textContent: "plain" }] },
    "pages/c/[slug].json": {
      $paths: { contentType: "items", param: "slug", field: "slug" },
      title: "c",
      ...(extra.component === true ? { $elements: [{ $ref: "../../components/fp-x.json" }] } : {}),
      state: { entry, all },
      children: nodes.flat(),
    },
  };
}

/** The opening tag and the content of the element a case named. */
function pull(html: string, k: string): string {
  const m = new RegExp(`<([a-z-]+) data-k="${k}"[^>]*>[\\s\\S]*?</\\1>`).exec(html);
  return (m?.[0] ?? `(no ${k})`).replace(/\s*\n\s*/g, "");
}

const shipsJs = (site: BuiltProject, route: string): boolean =>
  /<script[^>]*type="module"/.test(
    site.html(route).replace(/<script type="importmap">[\s\S]*?<\/script>/, ""),
  );

/** What each formula's own element reads when the build evaluated the call. */
const RESOLVED: Record<FormulaName, string[]> = {
  formatDate: ['<p data-k="formatDate">February 15, 2024</p>'],
  notEmpty: ['<p data-k="notEmpty" hidden>zero</p>', '<p data-k="notEmpty-n">n</p>'],
  orBlank: ['<p data-k="orBlank">none</p>', '<p data-k="orBlank-n">n=42</p>'],
  escapeHtml: ['<p data-k="escapeHtml">Tom &amp; &lt;Jerry&gt; &quot;q&quot; &#39;x&#39;</p>'],
};

const got = (site: BuiltProject, name: FormulaName): string[] => {
  const html = site.html("/c/foo/");
  return RESOLVED[name].map((want) => pull(html, /data-k="([^"]+)"/.exec(want)![1]!));
};

describe("a call of a formula of project.json's state, as the installed Jx builds it", () => {
  test("[F1] project.json validates with the formulas in its state", async () => {
    const site = await buildJxProject(project([], { state: { ...FORMULAS } }), {
      name: "formulas-valid",
      settle: false,
      build: false,
    });
    const result = await validateJxProject(site.dir);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  for (const name of ALL_FORMULAS) {
    test(`[F1] ${name}: jxFormulas() says whether the call is built into a static page, and the build agrees`, async () => {
      const site = await buildJxProject(
        project([NODES[name]], { state: { [name]: FORMULAS[name] } }),
        { name: `formulas-${name}`, settle: false },
      );
      expect(site.code).toBe(0);
      const resolved =
        JSON.stringify(got(site, name)) === JSON.stringify(RESOLVED[name]) &&
        !site.html("/c/foo/").includes("data-bind");
      const statik = !shipsJs(site, "/c/foo/") && !shipsJs(site, "/plain/");
      expect({ name, trusted: resolved && statik }).toEqual({
        name,
        trusted: jxFormulas().has(name),
      });
    });
  }

  test("[F1] formatDate is evaluated at build in a page, in a row of a mapped list and in the item of a computed list, in the page's locale", async () => {
    const state = { formatDate: FORMULAS.formatDate };
    const nodes = [NODES.formatDate, NODES.rows, NODES.list];
    const site = await buildJxProject(project(nodes, { state }), {
      name: "formulas-date",
      settle: false,
    });
    const html = site.html("/c/foo/");
    expect(pull(html, "formatDate")).toBe('<p data-k="formatDate">February 15, 2024</p>');
    // 23:30 UTC on December 31 is still that day in New York.
    expect(pull(html, "rows")).toBe(
      '<ul data-k="rows"><li>December 31, 2023</li><li>February 15, 2024</li></ul>',
    );
    expect(pull(html, "list")).toBe(
      '<ul data-k="list"><li>December 31, 2023</li><li>February 15, 2024</li></ul>',
    );
    expect(html).not.toContain("data-bind");
    // The formula formats in the page's locale: the same options are another text in en-GB, which
    // is why a date is a formula call only on a site whose language writes the PHP format.
    const british = await buildJxProject(project(nodes, { state, lang: "en-GB" }), {
      name: "formulas-gb",
      settle: false,
    });
    expect(pull(british.html("/c/foo/"), "formatDate")).toBe(
      '<p data-k="formatDate">15 February 2024</p>',
    );
  });
});

describe("a call of a formula of project.json's state in a component, as the installed Jx builds it", () => {
  /** A component that formats the date it is given, and the instance on the entry page that gives it. */
  const DATED = {
    tagName: "fp-x",
    state: { label: "" },
    children: [
      { tagName: "time", textContent: t(formulaCall("formatDate", "state.label", OPTIONS)) },
    ],
  };
  const INSTANCE = {
    tagName: "fp-x",
    attributes: { "data-k": "component" },
    $props: { label: t(`${D}.date`) },
  };
  const dated = (component: unknown, settle = false): Record<string, ProjectFile> => ({
    ...project([INSTANCE], {
      ...(settle ? {} : { state: { formatDate: FORMULAS.formatDate } }),
      component: true,
    }),
    "components/fp-x.json": component as ProjectFile,
  });
  /**
   * No page loads JavaScript: no script on a page and no `app.js`. The component's own module
   * (`components/fp-x.js`, which carries the formula it calls) is written for every component, and
   * nothing on a static page loads it.
   */
  const noJs = (site: BuiltProject): boolean =>
    !site.exists("app.js") &&
    ["/c/foo/", "/c/bar/", "/plain/"].every((route) => !site.html(route).includes("<script"));

  test("[F2] jxComponentFormulas() says whether a component's call is built into static markup, and the build agrees", async () => {
    const site = await buildJxProject(dated(DATED), {
      name: "formulas-in-component",
      settle: false,
      allowFailure: true,
    });
    const html = site.code === 0 ? site.html("/c/foo/") : "";
    const trusted =
      pull(html, "component").includes("<time>February 15, 2024</time>") &&
      !html.includes("data-bind") &&
      noJs(site);
    expect(trusted).toBe(jxComponentFormulas());
    if (!jxComponentFormulas()) return;
    expect(pull(html, "component")).toBe(
      '<fp-x data-k="component" data-jx-static><time>February 15, 2024</time></fp-x>',
    );
  });

  test.skipIf(!jxComponentFormulas())(
    "[F2] a component's own entry of the same name is what its call reaches, not the project's formula",
    async () => {
      const own = {
        ...DATED,
        state: {
          ...DATED.state,
          formatDate: {
            parameters: [{ name: "value" }],
            $expression: { operator: "+", target: "own:", value: { $ref: "$args/value" } },
          },
        },
      };
      const site = await buildJxProject(dated(own), { name: "formulas-own", settle: false });
      expect(pull(site.html("/c/foo/"), "component")).toContain(
        "<time>own:2024-02-15T17:30:00Z</time>",
      );
    },
  );

  test("[F2] settled, a date in a component of a site in en-US stays a call where the Jx builds it, and the page is static", async () => {
    const site = await buildJxProject(dated(DATED, true), {
      name: "formulas-settled-component",
    });
    expect(pull(site.html("/c/foo/"), "component")).toBe(
      '<fp-x data-k="component" data-jx-static><time>February 15, 2024</time></fp-x>',
    );
    expect(noJs(site)).toBe(true);
    const component = readFileSync(join(site.dir, "components/fp-x.json"), "utf8");
    const config = JSON.parse(readFileSync(join(site.dir, "project.json"), "utf8")) as {
      state?: Record<string, unknown>;
    };
    const kept = jxComponentFormulas() && jxFormulas().has("formatDate");
    expect(component.includes("state.formatDate(")).toBe(kept);
    expect(Object.keys(config.state ?? {})).toEqual(kept ? ["formatDate"] : []);
  });
});

describe("a migrated project: the calls settled", () => {
  test("a date in a component of a site in en-GB is written in en-GB, as on its pages", async () => {
    const options = { year: "numeric", month: "long", day: "numeric", timeZone: "Europe/London" };
    const files = project(
      [
        {
          tagName: "p",
          attributes: { "data-k": "formatDate" },
          textContent: t(formulaCall("formatDate", `${D}.date`, options)),
        },
        {
          tagName: "fp-x",
          attributes: { "data-k": "component" },
          $props: { label: t(`${D}.date`) },
        },
      ],
      { component: true, lang: "en-GB" },
    );
    files["components/fp-x.json"] = {
      tagName: "fp-x",
      state: { label: "" },
      children: [
        { tagName: "i", textContent: t(formulaCall("formatDate", "state.label", options)) },
      ],
    };
    const site = await buildJxProject(files, { name: "formulas-gb-component" });
    const html = site.html("/c/foo/");
    expect(pull(html, "formatDate")).toBe('<p data-k="formatDate">15 February 2024</p>');
    expect(pull(html, "component")).toContain("<i>15 February 2024</i>");
    expect(shipsJs(site, "/c/foo/")).toBe(false);
  });

  test("every binding is resolved in the HTML and no page ships JavaScript, in a page, a list and a component", async () => {
    const nodes = [
      NODES.formatDate,
      NODES.notEmpty,
      NODES.orBlank,
      NODES.escapeHtml,
      NODES.nested,
      NODES.rows,
      NODES.list,
      NODES.component,
    ];
    const site = await buildJxProject(project(nodes, { component: true }), {
      name: "formulas-settled",
    });
    expect(site.code).toBe(0);
    const html = site.html("/c/foo/");
    for (const name of ALL_FORMULAS) expect(got(site, name)).toEqual(RESOLVED[name]);
    expect(pull(html, "nested")).toBe(
      '<p data-k="nested">Tom &amp; &lt;Jerry&gt; &quot;q&quot; &#39;x&#39;</p>',
    );
    expect(pull(html, "rows")).toBe(
      '<ul data-k="rows"><li>December 31, 2023</li><li>February 15, 2024</li></ul>',
    );
    expect(pull(html, "list")).toBe(
      '<ul data-k="list"><li>December 31, 2023</li><li>February 15, 2024</li></ul>',
    );
    // A component keeps its call where the Jx gives it the project's formulas, and it renders
    // either way.
    expect(pull(html, "component")).toContain(
      "<i>Tom &amp; &lt;Jerry&gt; &quot;q&quot; &#39;x&#39;</i>",
    );
    const written = (path: string): unknown =>
      JSON.parse(readFileSync(join(site.dir, path), "utf8")) as unknown;
    expect(JSON.stringify(written("components/fp-x.json")).includes("state.escapeHtml(")).toBe(
      jxComponentFormulas() && jxFormulas().has("escapeHtml"),
    );
    expect(html).not.toContain("data-bind");
    for (const route of ["/c/foo/", "/c/bar/", "/plain/"]) {
      expect([route, shipsJs(site, route)]).toEqual([route, false]);
    }
    // project.json holds exactly the formulas the build is trusted with and the pages still call.
    const config = written("project.json") as { state?: Record<string, unknown> };
    expect(Object.keys(config.state ?? {}).sort()).toEqual([...jxFormulas()].sort());
  });
});
