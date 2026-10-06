/**
 * The design-system emitter against the two real sites, and against hand-written edge cases.
 *
 * The real-data tests build a Jx project from what `buildDesignSystem` returns with the installed
 * `jx` CLI and read the CSS the BUILD wrote, so what is compared is what a browser would be given:
 * once as canonical rules (nothing lost, nothing invented, every difference named), once as the
 * cascade of real elements from the live pages (which rule wins, at several widths and states).
 * Neither oracle shares code with the emitter.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { parseFragment } from "parse5";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { parseCwiclyCss } from "../../src/cwicly/css.ts";
import type { CwiclyOptionsFull } from "../../src/cwicly/options.ts";
import {
  additionalCssFor,
  buildDesignSystem,
  collectFontImports,
  ADDITIONAL_CSS_PATH,
  CUSTOM_CSS_PATH,
  GLOBAL_CSS_PATH,
  hexToHsl,
  parseHeadHtml,
  rewriteCssUrls,
  type DesignSystem,
  type DesignSystemInput,
  type DesignSystemOptions,
} from "../../src/emit/design-system.ts";
import { buildCompatCss, COMPAT_CSS_PATH, dirPluginSource } from "../../src/emit/compat-css.ts";
import { createReport } from "../../src/report.ts";
import type { Report } from "../../src/types.ts";
import {
  analysedRulesOf,
  canonicalCss,
  canonicalDiff,
  cascadeDiff,
  cascadeOf,
  flattenCanonical,
} from "../helpers/css-oracle.ts";
import { loadSite, type SiteName } from "../helpers/ctx.ts";
import { readFixtureCss } from "../helpers/fixture-css.ts";
import {
  buildJxProject,
  cleanupJxProjects,
  validateJxProject,
  type BuiltProject,
} from "../helpers/jx-build.ts";

afterAll(() => {
  cleanupJxProjects();
});

const SITES = ["fineline", "ap"] as const;
const DEV = resolve(import.meta.dir, "../../..");
const CHECKOUTS = {
  fineline: process.env.WP2JX_PLUGIN_FINELINE ?? join(DEV, "site-finelinepainting"),
  ap: process.env.WP2JX_PLUGIN_AP ?? join(DEV, "site-anabaptistperspectives"),
} as const;
const hasPlugin = (site: SiteName): boolean =>
  existsSync(join(CHECKOUTS[site], "wp-content/plugins/cwicly/build/style-index.css"));

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

interface Designed {
  site: Awaited<ReturnType<typeof loadSite>>;
  input: DesignSystemInput;
  ds: DesignSystem;
  report: Report;
  classesText: string;
  customText: string;
}

/** A real site's design system, with the plugin's compatibility CSS when its checkout is here. */
async function designFor(name: SiteName, opts: DesignSystemOptions = {}): Promise<Designed> {
  const site = await loadSite(name);
  const { options } = site;
  const palette = [...options.globalStyles.colorRefs.values()];
  const classesText = readFixtureCss(name, "cc-global-classes.css");
  const customText = readFixtureCss(name, "cc-global-stylesheets.css");
  const report = createReport();
  const input: DesignSystemInput = {
    options,
    globalCss: parseCwiclyCss(options.compiledCss.global, options.breakpoints, {
      file: "cwicly_global_css",
      palette,
    }),
    classesCss: parseCwiclyCss(classesText, options.breakpoints, {
      file: "cc-global-classes.css",
      palette,
    }),
    classesText,
    stylesheetsCss: customText,
    report,
  };
  const compat = hasPlugin(name)
    ? buildCompatCss(dirPluginSource(CHECKOUTS[name]), { version: options.version })
    : undefined;
  const ds = buildDesignSystem(input, { ...(compat ? { compat } : {}), ...opts });
  return { site, input, ds, report, classesText, customText };
}

/** The project a design system makes: its pieces and its files, one page, nothing else. */
const projectFiles = (ds: DesignSystem, extra: Record<string, unknown> = {}) => ({
  "project.json": {
    name: "ds-test",
    url: "https://example.com",
    $media: ds.media,
    style: ds.style,
    $head: ds.head,
  },
  "pages/index.json": { title: "Home", children: [{ tagName: "p", textContent: "hi" }] },
  ...Object.fromEntries(ds.files.map((file) => [file.path, file.content])),
  ...extra,
});

/** The text of the page's `<style>` (the project style, which the build writes before any element's own). */
function styleOf(built: BuiltProject): string {
  const html = built.html("/");
  const start = html.indexOf("<style>");
  expect(start).toBeGreaterThan(-1);
  return html.slice(start + "<style>".length, html.indexOf("</style>", start));
}

/**
 * The rules of a stylesheet with the `:is(.a)` aliases the emitter writes to keep the file's order
 * spelled as the selector they stand for (`:is(.a):hover` is `.a:hover`, at the same specificity),
 * so a canonical comparison sees one selector where the file had one.
 */
function unalias(css: string): string {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    rule.selector = selectorParser((selectors) => {
      selectors.each((complex) => {
        for (;;) {
          const first = complex.first;
          const inner = first?.type === "pseudo" ? first.nodes : [];
          if (first?.type !== "pseudo" || first.value !== ":is" || inner.length !== 1) break;
          const only = inner[0]!.nodes;
          if (only.length !== 1) break;
          first.replaceWith(only[0]!.clone());
        }
      });
    }).processSync(rule.selector);
  });
  return root.toString();
}

const builds = new Map<string, Promise<BuiltProject>>();
/** One real build per site, shared by the tests that read it. */
function builtFor(name: SiteName): Promise<BuiltProject> {
  let built = builds.get(name);
  if (built === undefined) {
    built = designFor(name).then(({ ds }) =>
      buildJxProject(projectFiles(ds), { name: `ds-${name}` }),
    );
    builds.set(name, built);
  }
  return built;
}

const codes = (report: Report): string[] => report.entries().map((entry) => entry.code);

/** Options of a real site with the pieces a test wants to control replaced. */
function withOptions(base: CwiclyOptionsFull, over: Partial<CwiclyOptionsFull>): CwiclyOptionsFull {
  return { ...base, ...over };
}

// ── The real sites ───────────────────────────────────────────────────────────────────────────────

for (const name of SITES) {
  describe(`design system, ${name}`, () => {
    test("$media is the site's breakpoints, and style never names a breakpoint it does not declare", async () => {
      const { ds, site } = await designFor(name);
      expect(ds.media).toEqual({
        "--": "1366px",
        "--md": "(max-width: 992px)",
        "--sm": "(max-width: 576px)",
      });
      expect(ds.media).toEqual(site.options.media);
      const used = new Set(Object.keys(ds.style).filter((key) => key.startsWith("@--")));
      expect(used.size).toBeGreaterThan(0);
      for (const key of used) expect(ds.media[key.slice(1)]).toBeDefined();
    });

    test("every palette colour is a custom property at the top of style, with the -hsl twin the plugin declares", async () => {
      const { ds, site } = await designFor(name);
      const colors = site.options.globalStyles.colors;
      expect(colors.length).toBe(name === "fineline" ? 22 : 6);
      for (const color of colors) {
        expect(ds.style[color.variable]).toBe(color.value);
        // the plugin's own twin (`--cc-color-2-hsl: 1deg 67% 51%`) is what hexToHsl must reproduce
        const twin = ds.style[`${color.variable}-hsl`];
        expect(twin).toBe(hexToHsl(color.value));
      }
      // custom properties come first, before the first property or selector
      const keys = Object.keys(ds.style);
      const firstOther = keys.findIndex((key) => !key.startsWith("--"));
      expect(keys.slice(firstOther).some((key) => key.startsWith("--"))).toBe(false);
      // `:root` and `.light` are gone as keys: the first is the top level, the second a folded twin
      expect(ds.style[":root"]).toBeUndefined();
      expect(ds.style[".light"]).toBeUndefined();
      expect(ds.darkRules).toBe(false);
    });

    test("the body's declarations are top-level properties and the tag rules keep their breakpoint blocks", async () => {
      const { ds } = await designFor(name);
      expect(ds.style.body).toBeUndefined();
      expect(ds.style.fontFamily).toBe(name === "fineline" ? '"Source Sans Pro"' : "Poppins");
      expect(ds.style.fontSize).toBe(name === "fineline" ? "20px" : "19px");
      const h1 = ds.style.h1 as Record<string, string>;
      expect(h1.fontSize).toBe(name === "fineline" ? "3.2em" : "2.2em");
      const md = ds.style["@--md"] as Record<string, Record<string, string>>;
      const sm = ds.style["@--sm"] as Record<string, Record<string, string>>;
      expect(md.h1!.fontSize).toBe(name === "fineline" ? "2.8em" : "2.2em");
      expect(sm.h1!.fontSize).toBe(name === "fineline" ? "2em" : "1.6em");
      // breakpoint blocks follow the base rules, widest query first (the cascade order of max-width)
      const keys = Object.keys(ds.style);
      expect(keys.indexOf("@--md")).toBeGreaterThan(keys.indexOf("h1"));
      expect(keys.indexOf("@--sm")).toBeGreaterThan(keys.indexOf("@--md"));
    });

    test("every global class is a rule of the project style, hover and descendant forms included", async () => {
      const { ds, site } = await designFor(name);
      const classes = [...site.options.globalClassNames.values()];
      expect(classes.length).toBeGreaterThan(name === "fineline" ? 30 : 5);
      const selectors = new Set<string>();
      const collect = (block: Record<string, unknown>): void => {
        for (const [key, value] of Object.entries(block)) {
          if (typeof value !== "object" || value === null) continue;
          if (key.startsWith("@")) collect(value as Record<string, unknown>);
          else selectors.add(key);
        }
      };
      collect(ds.style);
      const classesInStyle = new Set<string>();
      for (const selector of selectors) {
        selectorParser((root) => {
          root.walkClasses((node) => {
            classesInStyle.add(node.value);
          });
        }).processSync(selector);
      }
      // a global class with no declaration at all (an empty one) has no rule: the CSS is the judge
      const named = new Set<string>();
      postcss.parse(readFixtureCss(name, "cc-global-classes.css")).walkRules((rule) => {
        selectorParser((root) => {
          root.walkClasses((node) => {
            named.add(node.value);
          });
        }).processSync(rule.selector);
      });
      for (const className of classes) {
        if (named.has(className)) expect(classesInStyle.has(className)).toBe(true);
      }
      if (name === "fineline") {
        // the shapes the task names: a base rule, a :hover rule, a descendant, an @--md override
        expect(selectors.has(".button-default:hover")).toBe(true);
        expect(selectors.has(".button-default a")).toBe(true);
        expect(selectors.has(".section-default .cc-cntr")).toBe(true);
        const md = ds.style["@--md"] as Record<string, Record<string, string>>;
        expect(md[".section-default"]).toBeDefined();
      }
    });

    test("the head holds what the live page loads, in an order the cascade survives", async () => {
      const { ds, site } = await designFor(name);
      const hrefs = ds.head.map((entry) => `${entry.tagName} ${entry.attributes?.href ?? ""}`);
      const fonts = site.options.globalStyles.fonts.filter((font) => font.source === "google");
      expect(fonts).toHaveLength(1);
      const expected: string[] = [];
      if (hasPlugin(name)) expected.push("link /css/cwicly-base.css");
      if (name === "ap") expected.push("link /css/cwicly-custom.css");
      expected.push(`link ${fonts[0]!.url}`);
      if (name === "fineline") expected.push("script ");
      expect(hrefs).toEqual(expected);
      // the plugin's CSS is first: every global rule overrides it, as on the live site
      if (hasPlugin(name)) expect(ds.stylesheets[0]!.role).toBe("compat");
      // fineline prints its one font link seven times; it is kept once
      expect(ds.head.filter((entry) => entry.attributes?.href === fonts[0]!.url)).toHaveLength(1);
    });

    test("files: the owner's stylesheet verbatim, nothing for a site that has none, no verbatim sheet without a face to put in it", async () => {
      const { ds, customText } = await designFor(name);
      const paths = ds.files.map((file) => file.path);
      expect(paths.includes(GLOBAL_CSS_PATH)).toBe(false);
      expect(ds.verbatim).toEqual([]);
      if (name === "ap") {
        const custom = ds.files.find((file) => file.path === CUSTOM_CSS_PATH)!;
        expect(customText.length).toBeGreaterThan(1000);
        expect(custom.content).toContain(customText.trim());
      } else {
        expect(customText).toBe("");
        expect(paths.includes(CUSTOM_CSS_PATH)).toBe(false);
      }
      if (hasPlugin(name)) expect(paths).toContain(COMPAT_CSS_PATH);
      expect(ds.fontDownloads).toEqual([]);
    });

    test("custom code: the head snippet is in $head, the body-open and footer snippets are handed back untouched", async () => {
      const { ds, site } = await designFor(name);
      expect(ds.customCode).toEqual(site.options.customCode);
      if (name === "fineline") {
        const script = ds.head.find((entry) => entry.tagName === "script")!;
        expect(script.attributes).toBeUndefined();
        expect(script.textContent).toContain("GTM-PHFM9WJ");
        expect(script.textContent).toContain("'&l='");
        expect(ds.customCode.bodyOpen).toContain("<noscript><iframe");
        expect(ds.customCode.bodyOpen).toContain("googletagmanager.com/ns.html?id=GTM-PHFM9WJ");
        // the noscript half is not in the head
        expect(JSON.stringify(ds.head)).not.toContain("<iframe");
        expect(ds.customCode.footer).toBe("");
      } else {
        expect(ds.customCode).toEqual({ head: "", bodyOpen: "", footer: "" });
        expect(ds.head.some((entry) => entry.tagName === "script")).toBe(false);
      }
    });

    test("the migration report says what happened to the global look, and only that", async () => {
      const { report } = await designFor(name);
      const seen = new Set(codes(report));
      expect(seen.has("design.light-folded")).toBe(true);
      expect(seen.has("design.cascade-merged")).toBe(true);
      expect(seen.has("design.dark-mode")).toBe(false);
      expect(seen.has("design.palette-mismatch")).toBe(false);
      expect(seen.has("design.palette-added")).toBe(false);
      // CSS artifacts keep the reader's own codes
      expect(seen.has("css.invalid-value")).toBe(true);
      expect(seen.has(name === "fineline" ? "design.head-deduped" : "design.custom-css")).toBe(
        true,
      );
      expect(seen.has("design.palette-repaired")).toBe(name === "ap");
      for (const entry of report.entries()) {
        expect(entry.code).toMatch(/^(design|css)\./);
        expect(entry.severity).not.toBe("error");
        expect(entry.where).toBeDefined();
      }
      // a font link repeated seven times is reported as six duplicates
      if (name === "fineline") {
        expect(
          report.entries().find((entry) => entry.code === "design.head-deduped")!.data,
        ).toEqual({ removed: 6 });
      }
    });

    test("an element with any two global classes gets the declarations the files give it, at two widths and on hover", async () => {
      const { site, customText, classesText } = await designFor(name);
      const emitted = styleOf(await builtFor(name));
      const want = analysedRulesOf(
        `${site.options.compiledCss.global}\n${customText}\n${classesText}`,
      );
      const got = analysedRulesOf(`${customText}\n${emitted}`);
      // the classes the file styles (a global class with no declaration cannot differ)
      const styled = [...site.options.globalClassNames.values()].filter((className) =>
        classesText.includes(`.${className}`),
      );
      expect(styled.length).toBeGreaterThan(name === "fineline" ? 25 : 40);
      const differences: string[] = [];
      let checked = 0;
      for (let i = 0; i < styled.length; i += 1) {
        for (let j = i + 1; j < styled.length; j += 1) {
          for (const width of [1366, 480]) {
            for (const states of [[], [":hover"]] as const) {
              const query = { classes: [styled[i]!, styled[j]!], tag: "div", width, states };
              checked += 1;
              for (const line of cascadeDiff(cascadeOf(want, query), cascadeOf(got, query))) {
                differences.push(
                  `div.${styled[i]}.${styled[j]} @${width}${states.join("")} ${line}`,
                );
              }
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(name === "fineline" ? 1000 : 3000);
      // The one difference there is: the repaired palette reference, on a hovered search form.
      expect(
        differences.filter(
          (line) => !(line.includes(".searchform") && line.includes(".cc-icn svg path|fill:")),
        ),
      ).toEqual([]);
    });

    test("the project passes jx validate and builds, with the head in order and the style after it", async () => {
      const { ds } = await designFor(name);
      const built = await builtFor(name);
      expect(built.code).toBe(0);
      const validated = await validateJxProject(built.dir);
      expect(validated.problems).toEqual([]);
      expect(validated.ok).toBe(true);

      const html = built.html("/");
      const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
      let at = 0;
      for (const entry of ds.head) {
        const needle =
          entry.tagName === "script"
            ? "<script>"
            : (entry.attributes!.href as string).split("&")[0]!;
        const found = head.indexOf(needle, at);
        expect(found).toBeGreaterThan(-1);
        at = found;
      }
      expect(head.indexOf("<style>")).toBeGreaterThan(at);
      if (name === "fineline") {
        // Jx writes a script's text without escaping it
        expect(head).toContain("'https://www.googletagmanager.com/gtm.js?id='+i+dl;");
        expect(head).toContain("l!='dataLayer'?'&l='+l");
      }
    });

    test("round trip: what the build emits is what Cwicly's CSS said, and every difference is explained", async () => {
      const { site, customText, classesText } = await designFor(name);
      const { breakpoints } = site.options;
      const emitted = unalias(styleOf(await builtFor(name)));
      // the live order: global CSS, then the owner's stylesheet, then the global classes
      const original = canonicalCss(
        `${site.options.compiledCss.global}\n${customText}\n${classesText}`,
        breakpoints,
      );
      // the owner's stylesheet is a <link> ahead of the project style here
      const actual = canonicalCss(`${customText}\n${emitted}`, breakpoints);

      const lost = flattenCanonical(original).filter(
        (line) => !flattenCanonical(actual).includes(line),
      );
      const invented = flattenCanonical(actual).filter(
        (line) => !flattenCanonical(original).includes(line),
      );

      // Lost: the light-mode twin of the palette, folded into :root. Each has its :root twin, equal.
      expect(lost.length).toBeGreaterThan(20);
      const have = new Set(flattenCanonical(actual));
      for (const line of lost) {
        expect(line.startsWith(".light ") || line.startsWith(".light{")).toBe(true);
        expect(have.has(line.replace(/^\.light\b/, ":root"))).toBe(true);
      }
      // Invented: only a `!var=<id>!` the generator never resolved, repaired against the palette
      // (the live page drops the declaration; the report says so).
      expect(invented).toEqual(
        name === "ap"
          ? [".searchform:hover .cc-icn svg path {} fill: var(--cc-color-5) !important"]
          : [],
      );
      // The artefacts the oracle found in the original are exactly the ones the reader reported.
      expect(original.artifacts).toEqual(
        name === "ap"
          ? { "css.invalid-value": 2, "css.unresolved-palette-var": 1 }
          : { "css.invalid-value": 1 },
      );
      expect(actual.artifacts).toEqual({});
      expect(
        canonicalDiff(original, actual, 400).filter((line) => !/^- \.light[ {]/.test(line)),
      ).toEqual(invented.map((line) => `+ ${line}`));
    });

    test("the cascade of real elements is the cascade of Cwicly's own files, at five widths and in the hover state", async () => {
      const { site, customText, classesText } = await designFor(name);
      const emitted = styleOf(await builtFor(name));
      const original = `${site.options.compiledCss.global}\n${customText}\n${classesText}`;
      const actual = `${customText}\n${emitted}`;

      // every (tag, classes the CSS names) the live pages carry, plus the bare tags a stylesheet styles
      const named = new Set<string>();
      postcss.parse(original).walkRules((rule) => {
        selectorParser((root) => {
          root.walkClasses((node) => {
            named.add(node.value);
          });
        }).processSync(rule.selector);
      });
      const kinds = new Map<string, { tag: string; classes: string[] }>();
      type P5 = { tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: P5[] };
      const visit = (node: P5): void => {
        if (node.tagName !== undefined) {
          const classes = (node.attrs?.find((attr) => attr.name === "class")?.value ?? "")
            .split(/\s+/)
            .filter((className) => named.has(className))
            .toSorted();
          kinds.set(`${node.tagName}|${classes.join(" ")}`, { tag: node.tagName, classes });
        }
        for (const child of node.childNodes ?? []) visit(child);
      };
      const dir = join(import.meta.dir, "../fixtures", name, "html");
      for (const file of readdirSync(dir))
        visit(parseFragment(readFileSync(join(dir, file), "utf8")) as P5);
      for (const tag of ["body", "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "button", "input"]) {
        kinds.set(`${tag}|`, { tag, classes: [] });
      }
      expect(kinds.size).toBeGreaterThan(50);

      const want = analysedRulesOf(original);
      const got = analysedRulesOf(actual);
      const differences: string[] = [];
      let checked = 0;
      for (const { tag, classes } of kinds.values()) {
        for (const width of [1920, 1366, 992, 800, 576]) {
          for (const states of [[], [":hover"]] as const) {
            const query = { classes, tag, width, states };
            checked += 1;
            for (const line of cascadeDiff(cascadeOf(want, query), cascadeOf(got, query))) {
              differences.push(`${tag}.${classes.join(".")} @${width}${states.join("")} ${line}`);
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(500);
      // The one difference is the repaired palette reference, on a hovered search form.
      const explained = differences.filter(
        (line) =>
          !(line.startsWith("form.searchform @") && line.includes(".cc-icn svg path|fill:")),
      );
      expect(explained).toEqual([]);
      expect(differences.length > 0).toBe(name === "ap");
    });
  });
}

// ── Hand-written cases ───────────────────────────────────────────────────────────────────────────

interface Synthetic {
  /** `cwicly_global_css`. */
  global?: string;
  /** `cc-global-classes.css`. */
  classes?: string;
  /** `cc-global-stylesheets.css`. */
  custom?: string;
  additionalCss?: string;
  options?: Partial<CwiclyOptionsFull>;
  /** Palette colours, as the editor stores them. */
  colors?: { id: string; name: string; value: string; variable: string }[];
  opts?: DesignSystemOptions;
}

/**
 * A design system from CSS written in the test, on top of a real site's breakpoints and media. The
 * options start empty (no fonts, no palette, no custom code) so each case adds exactly what it tests.
 */
async function synth(
  spec: Synthetic,
): Promise<{ ds: DesignSystem; report: Report; input: DesignSystemInput }> {
  const { options: real } = await loadSite("fineline");
  const colors = spec.colors ?? [];
  const options = withOptions(real, {
    compiledCss: { global: spec.global ?? "", classes: "", stylesheets: spec.custom ?? "" },
    globalFontsHtml: "",
    customCode: { head: "", bodyOpen: "", footer: "" },
    customCodeSnippets: [],
    globalStyles: {
      ...real.globalStyles,
      colors,
      colorsById: new Map(colors.map((color) => [color.id, color])),
      colorRefs: new Map(
        colors.map((color) => [
          color.id,
          { id: color.id, variable: color.variable, kind: "color" as const, colorId: color.id },
        ]),
      ),
      fonts: [],
      gradients: [],
    },
    ...spec.options,
  });
  const palette = [...options.globalStyles.colorRefs.values()];
  const report = createReport();
  const input: DesignSystemInput = {
    options,
    globalCss: parseCwiclyCss(options.compiledCss.global, options.breakpoints, { palette }),
    classesCss: parseCwiclyCss(spec.classes ?? "", options.breakpoints, { palette }),
    classesText: spec.classes ?? "",
    stylesheetsCss: spec.custom ?? "",
    additionalCss: spec.additionalCss,
    report,
  };
  return { ds: buildDesignSystem(input, spec.opts), report, input };
}

describe("a site with nothing to carry over", () => {
  test("no CSS, no fonts, no palette, no custom code: an empty design system that still builds", async () => {
    const { ds, report } = await synth({});
    expect(ds.style).toEqual({});
    expect(ds.head).toEqual([]);
    expect(ds.files).toEqual([]);
    expect(ds.fontDownloads).toEqual([]);
    expect(ds.stylesheets).toEqual([]);
    expect(ds.verbatim).toEqual([]);
    expect(ds.fonts).toEqual([]);
    expect(ds.darkRules).toBe(false);
    expect(ds.customCode).toEqual({ head: "", bodyOpen: "", footer: "" });
    expect(ds.media["--"]).toBe("1366px");
    expect(report.entries()).toEqual([]);
    const built = await buildJxProject(projectFiles(ds), { name: "ds-empty" });
    expect(built.code).toBe(0);
  });

  test("a whitespace-only owner stylesheet and an empty Additional CSS ship no file", async () => {
    const { ds } = await synth({ custom: "  \n\t ", additionalCss: "" });
    expect(ds.files).toEqual([]);
    expect(ds.head).toEqual([]);
  });

  test("the compatibility stylesheet alone is linked first and written as given", async () => {
    const compat = { path: COMPAT_CSS_PATH, content: "body{margin:0}" };
    const { ds } = await synth({ opts: { compat } });
    expect(ds.head).toEqual([
      { tagName: "link", attributes: { rel: "stylesheet", href: "/css/cwicly-base.css" } },
    ]);
    expect(ds.files).toEqual([{ path: COMPAT_CSS_PATH, content: "body{margin:0}" }]);
    expect(ds.stylesheets).toEqual([
      { role: "compat", path: COMPAT_CSS_PATH, href: "/css/cwicly-base.css" },
    ]);
  });
});

describe("the palette", () => {
  const colors = [
    { id: "aaa", name: "Red", value: "#d5312d", variable: "--cc-color-1" },
    { id: "bbb", name: "Red", value: "#922a29", variable: "--cc-color-2" },
    { id: "ccc", name: "", value: "#FFF", variable: "--color-ccc" },
  ];

  test("a palette with duplicate names keeps every colour under its own variable", async () => {
    const { ds } = await synth({ colors });
    expect(ds.style["--cc-color-1"]).toBe("#d5312d");
    expect(ds.style["--cc-color-2"]).toBe("#922a29");
    expect(ds.style["--color-ccc"]).toBe("#FFF");
    expect(ds.style["--cc-color-1-hsl"]).toBe("1deg 67% 51%");
    expect(ds.style["--color-ccc-hsl"]).toBe("0deg 0% 100%");
  });

  test("a colour the compiled CSS declares is not added again, and a disagreement keeps the compiled value", async () => {
    const global = ":root, .light {--cc-color-1:#d5312d;--cc-color-2:#111111;--color-ccc:#ffffff;}";
    const { ds, report } = await synth({ colors, global });
    expect(ds.style["--cc-color-2"]).toBe("#111111");
    // `#FFF` and `#ffffff` are one colour
    expect(codes(report)).not.toContain("design.palette-added");
    const mismatches = report.entries().filter((entry) => entry.code === "design.palette-mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.data).toEqual({
      variable: "--cc-color-2",
      compiled: "#111111",
      palette: "#922a29",
    });
    expect(mismatches[0]!.severity).toBe("warn");
  });

  test("a palette colour the compiled CSS lacks is added, with its twin, and reported", async () => {
    const global = ":root, .light {--cc-color-1:#d5312d;}";
    const { ds, report } = await synth({ colors, global });
    expect(ds.style["--cc-color-2"]).toBe("#922a29");
    expect(ds.style["--cc-color-2-hsl"]).toBe("1deg 56% 37%");
    const added = report.entries().find((entry) => entry.code === "design.palette-added")!;
    expect(added.data).toEqual({ variables: ["--cc-color-2", "--color-ccc"] });
  });

  test("a palette variable the owner's stylesheet overrides on :root is not put back from the palette", async () => {
    const global = ":root,.light{--cc-color-1:#d5312d;--cc-color-1-hsl:1deg 67% 51%}";
    const { ds, report } = await synth({
      colors,
      global,
      custom: ":root{--cc-color-1:#ff0000}",
    });
    // the owner's value wins through its own <link>; the project style must not set it again
    expect(ds.style["--cc-color-1"]).toBeUndefined();
    expect(ds.style["--cc-color-1-hsl"]).toBe("1deg 67% 51%");
    // the light class is a different selector: the owner did not touch it
    expect(ds.style[".light"]).toEqual({
      "--cc-color-1": "#d5312d",
      "--cc-color-1-hsl": "1deg 67% 51%",
    });
    const added = report.entries().find((entry) => entry.code === "design.palette-added")!;
    expect(added.data).toEqual({ variables: ["--cc-color-2", "--color-ccc"] });
    expect(report.entries().find((entry) => entry.code === "design.cascade-order")!.data).toEqual({
      dropped: [{ selector: ":root", context: "", property: "--cc-color-1" }],
    });
    const built = await buildJxProject(projectFiles(ds), { name: "ds-palette-owner" });
    expect(styleOf(built)).not.toMatch(/:root \{[^}]*--cc-color-1:/);
  });

  test("a gradient becomes a token with its palette references resolved", async () => {
    const base = (await loadSite("fineline")).options.globalStyles;
    const { ds } = await synth({
      colors,
      options: {
        globalStyles: {
          ...base,
          colors,
          colorsById: new Map(colors.map((color) => [color.id, color])),
          colorRefs: new Map(
            colors.map((c) => [
              c.id,
              { id: c.id, variable: c.variable, kind: "color" as const, colorId: c.id },
            ]),
          ),
          fonts: [],
          gradients: [
            {
              name: "Fade",
              variable: "--cc-gradient-1",
              value: "linear-gradient(90deg,!var=aaa!,!var=bbb! 80%)",
            },
          ],
        },
      },
    });
    expect(ds.style["--cc-gradient-1"]).toBe(
      "linear-gradient(90deg,var(--cc-color-1),var(--cc-color-2) 80%)",
    );
  });

  test("hexToHsl: the plugin's own twins, alpha ignored, anything but a hex literal undefined", () => {
    expect(hexToHsl("#d5312d")).toBe("1deg 67% 51%");
    expect(hexToHsl("#ffffffad")).toBe("0deg 0% 100%");
    expect(hexToHsl("#0000004d")).toBe("0deg 0% 0%");
    expect(hexToHsl("#fff")).toBe("0deg 0% 100%");
    expect(hexToHsl("#f0f")).toBe("300deg 100% 50%");
    expect(hexToHsl("#0f08")).toBe("120deg 100% 50%");
    expect(hexToHsl("rgb(1,2,3)")).toBeUndefined();
    expect(hexToHsl("var(--x)")).toBeUndefined();
    expect(hexToHsl("#12345")).toBeUndefined();
  });

  test("hexToHsl walks the plugin's own path (colord: unrounded HSV, then HSL, then one rounding), so it agrees on the colours a direct RGB-to-HSL conversion rounds the other way", () => {
    // The plugin's `colord(value).toHsl()`, copied from build/index.js: rgbaToHsva, hsvaToHsla, round.
    const reference = (hex: string): string => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [
        number,
        number,
        number,
      ];
      const max = Math.max(r, g, b);
      const delta = max - Math.min(r, g, b);
      const l = delta
        ? max === r
          ? (g - b) / delta
          : max === g
            ? 2 + (b - r) / delta
            : 4 + (r - g) / delta
        : 0;
      const h = 60 * (l < 0 ? l + 6 : l);
      const s = max ? (delta / max) * 100 : 0;
      const v = (max / 255) * 100;
      const w = ((200 - s) * v) / 100;
      const round = (n: number): number => Math.round(n) + 0;
      const sat = w > 0 && w < 200 ? ((s * v) / 100 / (w <= 100 ? w : 200 - w)) * 100 : 0;
      return `${round(h)}deg ${round(sat)}% ${round(w / 2)}%`;
    };
    // the three the review found, and a sweep of the whole cube in a stride that is coprime to it
    expect(hexToHsl("#0b2445")).toBe("214deg 73% 16%");
    expect(hexToHsl("#c7d8b0")).toBe("86deg 34% 77%");
    expect(hexToHsl("#fbc3ec")).toBe(reference("#fbc3ec"));
    let checked = 0;
    for (let rgb = 0; rgb < 0x1000000; rgb += 997) {
      const hex = `#${rgb.toString(16).padStart(6, "0")}`;
      expect(hexToHsl(hex)).toBe(reference(hex));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(16_000);
  });

  test("hexToHsl reproduces every -hsl twin the real compiled CSS of both sites declares", async () => {
    let checked = 0;
    for (const name of SITES) {
      const { options } = await loadSite(name);
      const root =
        parseCwiclyCss(options.compiledCss.global, options.breakpoints).other.get(":root") ?? {};
      for (const color of options.globalStyles.colors) {
        const twin = root[`${color.variable}-hsl`];
        if (typeof twin !== "string") continue;
        expect(hexToHsl(color.value)).toBe(twin);
        checked += 1;
      }
    }
    expect(checked).toBe(28);
  });
});

describe("light and dark mode", () => {
  const palette = ":root, .light {--cc-color-1:#111111;.has-a-color{color:#111111;}}";

  test("with no dark palette the light class is a copy of :root and is folded into it", async () => {
    const { ds, report } = await synth({ global: palette });
    expect(ds.style["--cc-color-1"]).toBe("#111111");
    expect(ds.style[".light"]).toBeUndefined();
    expect(ds.style[".light .has-a-color"]).toBeUndefined();
    expect(ds.style[":root .has-a-color"]).toEqual({ color: "#111111" });
    expect(ds.darkRules).toBe(false);
    expect(report.entries().find((entry) => entry.code === "design.light-folded")!.data).toEqual({
      keys: 2,
    });
  });

  test("a dark palette keeps the light class (it restores the palette inside a dark page) and says nothing applies .dark", async () => {
    const { ds, report } = await synth({
      global: `${palette}.dark{--cc-color-1:#eeeeee;}`,
      classes: ".card{color:var(--cc-color-1)}.dark .card{color:white}",
    });
    expect(ds.darkRules).toBe(true);
    expect(ds.style[".light"]).toEqual({ "--cc-color-1": "#111111" });
    expect(ds.style[".dark"]).toEqual({ "--cc-color-1": "#eeeeee" });
    expect(ds.style[".dark .card"]).toEqual({ color: "white" });
    expect(codes(report)).not.toContain("design.light-folded");
    const dark = report.entries().find((entry) => entry.code === "design.dark-mode")!;
    expect(dark.severity).toBe("warn");
    expect(dark.message).toContain("darkmode");
    // `.dark` before `.card`'s rules: the dark palette still comes after the light one it overrides
    const keys = Object.keys(ds.style);
    expect(keys.indexOf(".dark")).toBeGreaterThan(keys.indexOf(".light"));
  });

  test("the dark selector the site configures is the one searched, and a class that merely starts with it is not dark", async () => {
    const darkMode = {
      darkSelectors: ".night, [data-theme=night]",
      lightSelectors: ".day",
      darkClasses: ["night"],
      lightClasses: ["day"],
    };
    const night = await synth({ global: ".night{--x:1}", options: { darkMode } });
    expect(night.ds.darkRules).toBe(true);
    const darkroom = await synth({
      classes: ".darkroom{color:red}.nightly{color:red}",
      options: { darkMode },
    });
    expect(darkroom.ds.darkRules).toBe(false);
    // the default `.dark` is not special once the site configured another
    const stock = await synth({ classes: ".dark{color:red}", options: { darkMode } });
    expect(stock.ds.darkRules).toBe(false);
  });

  test("a rule on the light class's state or a compound of it is not a twin of anything on :root, so nothing is folded", async () => {
    for (const rule of [
      ".light:hover{color:red}",
      ".light.x{color:red}",
      ".light::after{color:red}",
    ]) {
      const { ds, report } = await synth({ global: `${palette}${rule}` });
      expect(ds.style[".light"]).toEqual({ "--cc-color-1": "#111111" });
      expect(
        Object.keys(ds.style).some((key) => key.startsWith(".light") && key !== ".light"),
      ).toBe(true);
      expect(codes(report)).not.toContain("design.light-folded");
    }
    // a class that only starts with the light class's name is another class, and does not stop the fold
    const darker = await synth({ global: `${palette}.lighthouse{color:red}` });
    expect(darker.ds.style[".light"]).toBeUndefined();
    expect(darker.ds.style[".lighthouse"]).toEqual({ color: "red" });
  });

  test("a light class that differs from :root is not a copy and stays", async () => {
    const { ds } = await synth({
      global: ":root{--a:1;.x{color:red}}.light{--a:2}.light .x{color:blue}",
    });
    expect(ds.style["--a"]).toBe("1");
    expect(ds.style[".light"]).toEqual({ "--a": "2" });
    expect(ds.style[".light .x"]).toEqual({ color: "blue" });
  });
});

describe("rules Jx cannot carry go to the verbatim stylesheet, and the rest stays in the style", () => {
  const faces =
    "@font-face{font-family:Foo;font-weight:400;src:url(https://x.test/wp-content/uploads/a.woff2) format('woff2')}" +
    "@font-face{font-family:Foo;font-weight:700;font-style:italic;src:url(https://x.test/wp-content/uploads/b.woff2) format('woff2')}";

  test("every @font-face is written to public/css/cwicly-global.css, linked before the project style, and reported", async () => {
    const { ds, report } = await synth({ classes: `${faces}.a{font-family:Foo}` });
    const file = ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!;
    expect((file.content as string).match(/@font-face/g)).toHaveLength(2);
    expect(file.content).toContain("font-weight: 700");
    expect(file.content).toContain(
      "src: url(https://x.test/wp-content/uploads/b.woff2) format('woff2')",
    );
    expect(ds.head).toEqual([
      { tagName: "link", attributes: { rel: "stylesheet", href: "/css/cwicly-global.css" } },
    ]);
    expect(ds.style["@font-face"]).toBeUndefined();
    expect(ds.style[".a"]).toEqual({ fontFamily: "Foo" });
    expect(ds.verbatim.map((rule) => rule.rule)).toEqual([
      "@font-face Foo 400",
      "@font-face Foo 700 italic",
    ]);
    expect(report.entries().filter((entry) => entry.code === "design.verbatim")).toHaveLength(2);
  });

  test("@keyframes and @property stay in the style and come out of the build intact", async () => {
    const css =
      "@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}" +
      "@property --angle{syntax:'<angle>';inherits:false;initial-value:0deg}" +
      ".spin{animation:spin 1s linear infinite}";
    const { ds } = await synth({ classes: css });
    expect(ds.style["@keyframes spin"]).toEqual({
      from: { transform: "rotate(0)" },
      to: { transform: "rotate(360deg)" },
    });
    expect(Object.keys(ds.style).some((key) => key.startsWith("@property"))).toBe(true);
    expect(ds.files).toEqual([]);
    const built = await buildJxProject(projectFiles(ds), { name: "ds-keyframes" });
    const emitted = styleOf(built);
    expect(emitted).toContain(
      "@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }",
    );
    expect(emitted).toContain("@property --angle");
    expect(emitted).toContain(".spin { animation: spin 1s linear infinite }");
  });

  test("the array form of @font-face fails jx validate, which is why the faces are not put in the style", async () => {
    const built = await buildJxProject(
      {
        "project.json": {
          name: "x",
          url: "https://example.com",
          style: {
            "@font-face": [
              { fontFamily: "Foo", src: "url(/a.woff2)" },
              { fontFamily: "Foo", src: "url(/b.woff2)" },
            ],
          },
        },
        "pages/index.json": { title: "Home", children: [] },
      },
      { name: "ds-facearray", allowFailure: true },
    );
    const validated = await validateJxProject(built.dir);
    expect(validated.ok).toBe(false);
    expect(validated.problems.join("\n")).toContain("/style/@font-face");
    // and the build that accepts it writes no face at all, silently
    expect(built.html("/")).not.toContain("@font-face");
  });

  test("a url() in the verbatim rules goes through rewriteUrl, a data: url does not", async () => {
    const css =
      "@font-face{font-family:Foo;src:url(https://x.test/wp-content/uploads/a.woff2),url(data:font/woff2;base64,AAAA)}";
    const { ds } = await synth({
      classes: css,
      opts: { rewriteUrl: (url) => url.replace("https://x.test/wp-content/uploads/", "/media/") },
    });
    const file = ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!;
    expect(file.content).toContain("url(/media/a.woff2)");
    expect(file.content).toContain("url(data:font/woff2;base64,AAAA)");
  });

  test("an at-rule the reader has no key for is recovered from the text, written verbatim, and its warning replaced by the report", async () => {
    const css = "@page{margin:1cm}@font-feature-values Foo{@styleset{nice:1}}.a{color:red}";
    const { ds, report } = await synth({ classes: css });
    const file = ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!;
    expect(file.content).toContain("@page{margin:1cm}");
    expect(file.content).toContain("@font-feature-values Foo{@styleset{nice:1}}");
    expect(ds.verbatim.map((rule) => rule.rule)).toEqual(["@page", "@font-feature-values Foo"]);
    expect(ds.style[".a"]).toEqual({ color: "red" });
    expect(codes(report)).not.toContain("css.unclassified");
    // without the text there is nothing to recover from: the reader's own warning stands
    const { options } = await loadSite("fineline");
    const bare = createReport();
    buildDesignSystem({
      options: withOptions(options, { compiledCss: { global: "", classes: "", stylesheets: "" } }),
      globalCss: parseCwiclyCss("", options.breakpoints),
      classesCss: parseCwiclyCss(css, options.breakpoints),
      stylesheetsCss: "",
      report: bare,
    });
    expect(codes(bare).filter((code) => code === "css.unclassified")).toHaveLength(2);
  });

  test("a statement at-rule keeps its semicolon: the rule after it is its own rule, not the statement's body", async () => {
    const css =
      "@layer a,b;\n@page{margin:1cm}\n@font-feature-values Font One{@styleset{nice:1}}\n.a{color:red}";
    const { ds } = await synth({ classes: css });
    const file = ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!.content as string;
    const atRules = postcss
      .parse(file)
      .nodes.filter((node): node is postcss.AtRule => node.type === "atrule");
    expect(atRules.map((rule) => [rule.name, rule.params, rule.nodes !== undefined])).toEqual([
      ["layer", "a,b", false],
      ["page", "", true],
      ["font-feature-values", "Font One", true],
    ]);
    expect(ds.verbatim.map((rule) => rule.rule)).toEqual([
      "@layer a,b",
      "@page",
      "@font-feature-values Font One",
    ]);
    // the same text in either source file, last or first, and a namespace statement
    const last = await synth({
      global: ".b{color:blue}@namespace svg url(http://www.w3.org/2000/svg);",
    });
    expect(last.ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!.content).toContain(
      "@namespace svg url(http://www.w3.org/2000/svg);",
    );
  });

  test("a statement at-rule of a hand-built index is rendered as a statement, a block at-rule with no body as an empty block", async () => {
    const { options } = await loadSite("fineline");
    const ds = buildDesignSystem({
      options: withOptions(options, { compiledCss: { global: "", classes: "", stylesheets: "" } }),
      globalCss: {
        classes: new Map(),
        other: new Map(),
        artifacts: [],
        atRules: [
          { key: "@layer a, b", style: {} },
          { key: "@page", style: {} },
          { key: "@page :first", style: { margin: "0" } },
        ],
      },
      classesCss: parseCwiclyCss("", options.breakpoints),
      stylesheetsCss: "",
      report: createReport(),
    });
    const file = ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!.content as string;
    const nodes = postcss
      .parse(file)
      .nodes.filter((node): node is postcss.AtRule => node.type === "atrule");
    expect(
      nodes.map((rule) => [rule.name, rule.params, rule.nodes?.length ?? "statement"]),
    ).toEqual([
      ["layer", "a, b", "statement"],
      ["page", "", 0],
      ["page", ":first", 1],
    ]);
  });

  test("an at-rule met several times under one head is recovered every time, and each is reported as the rule it replaced", async () => {
    const css = "@page{margin:1cm}.a{color:red}@page{size:A4}@page :first{margin:0}";
    const { ds, report } = await synth({ classes: css });
    const file = ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!.content as string;
    expect(file).toContain("@page{margin:1cm}");
    expect(file).toContain("@page{size:A4}");
    expect(file).toContain("@page :first{margin:0}");
    expect(ds.verbatim.map((rule) => rule.rule)).toEqual(["@page", "@page", "@page :first"]);
    expect(codes(report)).not.toContain("css.unclassified");
    // a rule the text no longer holds keeps the reader's warning: three were read, two can be found
    const { options } = await loadSite("fineline");
    const partial = createReport();
    buildDesignSystem({
      options: withOptions(options, { compiledCss: { global: "", classes: "", stylesheets: "" } }),
      globalCss: parseCwiclyCss("", options.breakpoints),
      classesCss: parseCwiclyCss(css, options.breakpoints),
      classesText: "@page{margin:1cm}@page :first{margin:0}",
      stylesheetsCss: "",
      report: partial,
    });
    expect(
      partial
        .entries()
        .filter((entry) => entry.code === "css.unclassified")
        .map((entry) => entry.data),
    ).toEqual([{ selector: "@page" }]);
  });

  test("an index built by hand with an at-rule Jx has no key for puts it in the verbatim sheet", async () => {
    const { options } = await loadSite("fineline");
    const report = createReport();
    const ds = buildDesignSystem({
      options: withOptions(options, { compiledCss: { global: "", classes: "", stylesheets: "" } }),
      globalCss: {
        classes: new Map(),
        other: new Map(),
        artifacts: [],
        atRules: [{ key: "@page", style: { margin: "1cm" } }],
      },
      classesCss: parseCwiclyCss("", options.breakpoints),
      stylesheetsCss: "",
      report,
    });
    expect(ds.files.find((file) => file.path === GLOBAL_CSS_PATH)!.content).toContain(
      "@page {\n  margin: 1cm;\n}",
    );
    expect(ds.verbatim).toHaveLength(1);
    expect(ds.verbatim[0]!.reason).toContain("verbatim");
  });
});

describe("fonts", () => {
  const google = (family: string, query = "wght@400;700") =>
    `https://fonts.googleapis.com/css2?family=${family}:${query}&display=swap`;

  test("cwicly_global_fonts: a link printed several times is kept once, and preconnect hints keep their attributes", async () => {
    const html =
      '<link rel="preconnect" href="https://fonts.googleapis.com">' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      `<link rel="stylesheet" href="${google("Inter")}">`.repeat(3);
    const { ds, report } = await synth({ options: { globalFontsHtml: html } });
    expect(ds.head).toEqual([
      { tagName: "link", attributes: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
      {
        tagName: "link",
        attributes: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
      },
      { tagName: "link", attributes: { rel: "stylesheet", href: google("Inter") } },
    ]);
    expect(report.entries().find((entry) => entry.code === "design.head-deduped")!.data).toEqual({
      removed: 2,
    });
  });

  test("markup the plugin's own filter strips on the live site is not carried, and is reported", async () => {
    const html = `<link rel="stylesheet" href="${google("Inter")}"><script src="https://evil.test/x.js"></script><style>.a{color:red}</style>`;
    const { ds, report } = await synth({ options: { globalFontsHtml: html } });
    expect(ds.head.map((entry) => entry.tagName)).toEqual(["link", "style"]);
    expect(ds.head[1]!.textContent).toBe(".a{color:red}");
    const stripped = report.entries().filter((entry) => entry.code === "design.font-markup");
    expect(stripped).toHaveLength(1);
    expect(stripped[0]!.message).toContain("<script>");
  });

  test("a Google font in the site's list that no link loads is reported and not added: the live site does not load it either", async () => {
    const base = (await loadSite("fineline")).options.globalStyles;
    const { ds, report } = await synth({
      options: {
        globalStyles: {
          ...base,
          colors: [],
          fonts: [{ family: "Lora", source: "google", url: google("Lora") }],
        },
      },
    });
    expect(ds.head).toEqual([]);
    expect(ds.fonts).toEqual([{ family: "Lora", source: "google" }]);
    expect(report.entries().find((entry) => entry.code === "design.font-unlinked")!.data).toEqual({
      family: "Lora",
      url: google("Lora"),
    });
  });

  test("@import fonts that only per-post CSS carries are collected into links, each address once, in order", () => {
    const report = createReport();
    const index = (...keys: string[]) => ({ atRules: keys.map((key) => ({ key, style: {} })) });
    const inter = `@import url("${google("Inter")}")`;
    const entries = collectFontImports(
      [
        index(inter, `@import url('${google("Lora")}')`),
        index(inter, `@import "${google("Inter")}"`, `@import url(${google("Roboto")}) screen`),
        // not an import, and an at-rule with declarations: neither is a statement
        {
          atRules: [
            { key: "@font-face", style: { fontFamily: "Foo" } },
            { key: "@import url(x.css)", style: { a: "b" } },
          ],
        },
      ],
      { report },
    );
    expect(entries.map((entry) => entry.attributes)).toEqual([
      { rel: "stylesheet", href: google("Inter") },
      { rel: "stylesheet", href: google("Lora") },
      { rel: "stylesheet", href: google("Roboto"), media: "screen" },
    ]);
    expect(report.entries()).toEqual([]);
  });

  test("an @import that is not a font host, or carries layer() or supports(), is still linked and reported", () => {
    const report = createReport();
    const entries = collectFontImports(
      [
        {
          atRules: [
            { key: '@import url("https://cdn.test/reset.css")', style: {} },
            {
              key: '@import url("https://fonts.googleapis.com/css?family=A") layer(base)',
              style: {},
            },
            { key: "@import url(/local.css)", style: {} },
            { key: "@import ;", style: {} },
          ],
        },
      ],
      { report, where: "post:12" },
    );
    expect(entries.map((entry) => entry.attributes?.href)).toEqual([
      "https://cdn.test/reset.css",
      "https://fonts.googleapis.com/css?family=A",
      "/local.css",
    ]);
    const found = report.entries();
    expect(found.map((entry) => `${entry.severity} ${entry.code} ${entry.where}`)).toEqual([
      "info design.import-hoisted post:12",
      "warn design.import-hoisted post:12",
      "info design.import-hoisted post:12",
      "warn design.import-hoisted post:12",
    ]);
    expect(found[1]!.message).toContain("layer()");
    // collecting without a report is allowed
    expect(
      collectFontImports([{ atRules: [{ key: "@import url(/a.css)", style: {} }] }]),
    ).toHaveLength(1);
  });

  test("an @import in the global classes becomes a head link beside the font links, never a style key", async () => {
    const { ds } = await synth({
      classes: `@import url("${google("Inter")}");.a{font-family:Inter}`,
    });
    expect(ds.head.map((entry) => entry.attributes?.href)).toEqual([google("Inter")]);
    expect(Object.keys(ds.style).some((key) => key.startsWith("@import"))).toBe(false);
  });

  describe("local fonts", () => {
    const uploads = "https://example.com/wp-content/uploads";
    const face = (style: string, url: string) =>
      `@font-face  {font-family:'Exo 2';font-display:swap;font-style:${style};font-weight:100 900;src:url(${url}) format('woff2');unicode-range:U+0000-00FF}`;
    const normal = `${uploads}/cwicly/local-fonts/google/Exo%202/latin/Exo%202-100%20900-normal.woff2`;
    const italic = `${uploads}/cwicly/local-fonts/google/Exo%202/latin/Exo%202-100%20900-italic.woff2`;
    const font = (css: string) => ({
      family: "Exo 2",
      source: "local" as const,
      key: "google-exo-2",
      css,
      files: [],
      global: true,
    });
    const withFonts = async (...fonts: CwiclyOptionsFull["globalStyles"]["fonts"]) => {
      const base = (await loadSite("fineline")).options.globalStyles;
      return synth({ options: { globalStyles: { ...base, colors: [], fonts } } });
    };

    test("each face's file is fetched into public/fonts and the face points at /fonts/…", async () => {
      const { ds } = await withFonts(font(`${face("normal", normal)}\n${face("italic", italic)}`));
      expect(ds.fontDownloads).toEqual([
        { url: normal, dest: "public/fonts/google/Exo-2/latin/Exo-2-100-900-normal.woff2" },
        { url: italic, dest: "public/fonts/google/Exo-2/latin/Exo-2-100-900-italic.woff2" },
      ]);
      const file = ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!.content as string;
      expect(file).toContain(
        "src:url(/fonts/google/Exo-2/latin/Exo-2-100-900-normal.woff2) format('woff2')",
      );
      expect(file).toContain("font-style:italic");
      expect(file).not.toContain("example.com");
      expect(file).toContain("/* Exo 2 (google-exo-2) */");
      expect(ds.head).toEqual([
        { tagName: "link", attributes: { rel: "stylesheet", href: "/css/cwicly-global.css" } },
      ]);
      expect(ds.fonts).toEqual([{ family: "Exo 2", source: "local" }]);
    });

    test("one file used by two faces is fetched once; two names that clean to one path get a counter", async () => {
      const a = `${uploads}/cwicly/local-fonts/a b.woff2`;
      const b = `${uploads}/cwicly/local-fonts/a-b.woff2`;
      const { ds } = await withFonts(
        font(`${face("normal", a)}${face("italic", a)}${face("oblique", b)}`),
      );
      expect(ds.fontDownloads.map((entry) => entry.dest)).toEqual([
        "public/fonts/a-b.woff2",
        "public/fonts/a-b-2.woff2",
      ]);
      const file = ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!.content as string;
      expect(file.match(/url\(\/fonts\/a-b\.woff2\)/g)).toHaveLength(2);
      expect(file).toContain("url(/fonts/a-b-2.woff2)");
    });

    test("a file address that climbs out of local-fonts (dot segments, encoded or not) never leaves public/fonts", async () => {
      const { ds } = await withFonts(
        font(
          face("normal", `${uploads}/cwicly/local-fonts/google/../../../etc/%2e%2e/passwd.woff2`) +
            face("italic", `${uploads}/cwicly/local-fonts/./.hidden/..a.woff2`),
        ),
      );
      expect(ds.fontDownloads).toHaveLength(2);
      for (const { dest } of ds.fontDownloads) {
        expect(dest.split("/")).not.toContain("..");
        expect(dest.split("/")).not.toContain(".");
        expect(dest.startsWith("public/fonts/")).toBe(true);
        expect(posix.normalize(dest).startsWith("public/fonts/")).toBe(true);
      }
      const file = ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!.content as string;
      expect(file).not.toContain("..");
    });

    test("a file outside local-fonts keeps its name, a query string is not part of the path, a data: url is left alone", async () => {
      const { ds } = await withFonts(
        font(
          `${face("normal", "https://cdn.example.com/f/Foo.woff2?v=3")}` +
            `${face("italic", "data:font/woff2;base64,AAAA")}`,
        ),
      );
      expect(ds.fontDownloads).toEqual([
        { url: "https://cdn.example.com/f/Foo.woff2?v=3", dest: "public/fonts/Foo.woff2" },
      ]);
      const file = ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!.content as string;
      expect(file).toContain("url(/fonts/Foo.woff2)");
      expect(file).toContain("url(data:font/woff2;base64,AAAA)");
    });

    test("an uploads address nothing could derive is left as written and reported", async () => {
      const { ds, report } = await withFonts(
        font(face("normal", "{{CC_UPLOAD_URL}}/cwicly/local-fonts/x.woff2")),
      );
      expect(ds.fontDownloads).toEqual([]);
      const file = ds.files.find((entry) => entry.path === GLOBAL_CSS_PATH)!.content as string;
      expect(file).toContain("{{CC_UPLOAD_URL}}/cwicly/local-fonts/x.woff2");
      expect(
        report.entries().find((entry) => entry.code === "design.font-unresolved")!.severity,
      ).toBe("warn");
    });

    test("a local font with no CSS declares nothing; the rewriteUrl hook does not touch the fonts' final addresses", async () => {
      const seen: string[] = [];
      const { ds } = await withFonts(
        { family: "Empty", source: "local", key: "k", files: [], global: false },
        font(face("normal", normal)),
      );
      expect(ds.fontDownloads).toHaveLength(1);
      const hooked = await synth({
        classes: ".a{background:url(https://example.com/wp-content/uploads/x.jpg)}",
        opts: { rewriteUrl: (url) => (seen.push(url), "/media/x.jpg") },
      });
      expect(seen).toEqual(["https://example.com/wp-content/uploads/x.jpg"]);
      expect(hooked.ds.style[".a"]).toEqual({ background: "url(/media/x.jpg)" });
    });

    test("the face CSS the build serves is the face CSS written: files land in the project and the page links the stylesheet", async () => {
      const { ds } = await withFonts(font(face("normal", normal)));
      const built = await buildJxProject(projectFiles(ds), { name: "ds-localfont" });
      expect(built.exists("css/cwicly-global.css")).toBe(true);
      expect(built.read("css/cwicly-global.css")).toContain(
        "url(/fonts/google/Exo-2/latin/Exo-2-100-900-normal.woff2)",
      );
      expect(built.html("/")).toContain('<link rel="stylesheet" href="/css/cwicly-global.css">');
    });
  });
});

describe("head markup", () => {
  const ctx = () => ({ report: createReport(), where: "option:test" });

  test("a comment is not carried, an element becomes {tagName, attributes, textContent}, boolean attributes are empty strings", () => {
    const entries = parseHeadHtml(
      '<!-- note --><script async src="https://x.test/a.js"></script><meta name="a" content="b"><noscript><img src="x.gif"></noscript>',
      ctx(),
    );
    expect(entries).toEqual([
      { tagName: "script", attributes: { async: "", src: "https://x.test/a.js" } },
      { tagName: "meta", attributes: { name: "a", content: "b" } },
      { tagName: "noscript", textContent: '<img src="x.gif">' },
    ]);
  });

  test("a script and a style keep their text exactly, entities and all", () => {
    const [script, style] = parseHeadHtml(
      "<script>if(a&&b<c){x='&amp;'}</script><style>a>b{content:'&'}</style>",
      ctx(),
    );
    expect(script!.textContent).toBe("if(a&&b<c){x='&amp;'}");
    expect(style!.textContent).toBe("a>b{content:'&'}");
  });

  test("text outside any element is reported, not silently dropped", () => {
    const c = ctx();
    expect(parseHeadHtml("stray words<meta charset=utf-8>", c)).toEqual([
      { tagName: "meta", attributes: { charset: "utf-8" } },
    ]);
    const found = c.report.entries();
    expect(found).toHaveLength(1);
    expect(found[0]!.code).toBe("design.head-markup");
    expect(found[0]!.message).toContain("stray words");
    // whitespace between elements is nothing
    expect(parseHeadHtml(" \n<meta charset=utf-8>\n ", ctx())).toHaveLength(1);
    expect(parseHeadHtml("", ctx())).toEqual([]);
  });

  test("an inline script with a template marker is written to public/js and linked from the same place", () => {
    const c = ctx();
    const files: { path: string; content: string }[] = [];
    const entries = parseHeadHtml(
      "<script>const a = `${b}`;</script><meta charset=utf-8><script>x(`${y}`)</script>",
      { ...c, files },
    );
    expect(entries).toEqual([
      { tagName: "script", attributes: { src: "/js/cwicly-head-1.js" } },
      { tagName: "meta", attributes: { charset: "utf-8" } },
      { tagName: "script", attributes: { src: "/js/cwicly-head-2.js" } },
    ]);
    expect(files).toEqual([
      { path: "public/js/cwicly-head-1.js", content: "const a = `${b}`;" },
      { path: "public/js/cwicly-head-2.js", content: "x(`${y}`)" },
    ]);
    expect(c.report.entries().map((entry) => entry.code)).toEqual([
      "design.head-externalised",
      "design.head-externalised",
    ]);
  });

  test("a data block with a template marker stays inline: JSON keeps its text with the dollar escaped, any other type is kept and warned about", async () => {
    const c = ctx();
    const files: { path: string; content: string }[] = [];
    const entries = parseHeadHtml(
      '<script type="application/ld+json">{"name":"a ${x}"}</script>' +
        '<script type="importmap">{"imports":{"a":"/${v}.js"}}</script>' +
        '<script type="text/template"><b>${y}</b></script>',
      { ...c, files },
    );
    expect(files).toEqual([]);
    expect(entries).toEqual([
      {
        tagName: "script",
        attributes: { type: "application/ld+json" },
        textContent: '{"name":"a \\u0024{x}"}',
      },
      {
        tagName: "script",
        attributes: { type: "importmap" },
        textContent: '{"imports":{"a":"/\\u0024{v}.js"}}',
      },
      { tagName: "script", attributes: { type: "text/template" }, textContent: "<b>${y}</b>" },
    ]);
    // what the browser reads out of the escaped JSON is the original
    expect(JSON.parse(String(entries[0]!.textContent))).toEqual({ name: "a ${x}" });
    expect(c.report.entries().map((entry) => `${entry.severity} ${entry.code}`)).toEqual([
      "info design.template-literal",
      "info design.template-literal",
      "warn design.template-literal",
    ]);
    // and through a build: the structured data is in the page
    const built = await buildJxProject(
      projectFiles({
        media: {},
        style: {},
        head: [entries[0]!],
        files: [],
      } as unknown as DesignSystem),
      { name: "ds-ldjson" },
    );
    expect(built.html("/")).toContain(
      '<script type="application/ld+json">{"name":"a \\u0024{x}"}</script>',
    );
  });

  test("an externalised classic script loses async and defer, which an inline script ignores and a linked one does not; a module keeps them", () => {
    const files: { path: string; content: string }[] = [];
    const entries = parseHeadHtml(
      "<script defer>a(`${1}`)</script>" +
        '<script async type="text/javascript">b(`${2}`)</script>' +
        '<script type="module" async>c(`${3}`)</script>',
      { ...ctx(), files },
    );
    expect(entries).toEqual([
      { tagName: "script", attributes: { src: "/js/cwicly-head-1.js" } },
      { tagName: "script", attributes: { type: "text/javascript", src: "/js/cwicly-head-2.js" } },
      {
        tagName: "script",
        attributes: { type: "module", async: "", src: "/js/cwicly-head-3.js" },
      },
    ]);
    expect(files).toHaveLength(3);
  });

  test("an inline style with a template marker becomes a linked stylesheet, media kept; any other element only warns", () => {
    const c = ctx();
    const files: { path: string; content: string }[] = [];
    const entries = parseHeadHtml(
      '<style media="print">.a::after{content:"${x}"}</style><noscript>${y}</noscript>',
      { ...c, files },
    );
    expect(entries[0]).toEqual({
      tagName: "link",
      attributes: { rel: "stylesheet", href: "/css/cwicly-head-1.css", media: "print" },
    });
    expect(files[0]!.path).toBe("public/css/cwicly-head-1.css");
    expect(entries[1]!.textContent).toBe("${y}");
    expect(c.report.entries().map((entry) => entry.code)).toEqual([
      "design.head-externalised",
      "design.template-literal",
    ]);
  });

  test("a template marker in an attribute is warned about, wherever the element is", () => {
    const c = ctx();
    const entries = parseHeadHtml('<link rel="stylesheet" href="/a.css?v=${v}">', c);
    expect(entries).toHaveLength(1);
    expect(c.report.entries().map((entry) => entry.code)).toEqual(["design.template-literal"]);
  });

  test("a script that has a src and a marker in its body is not externalised (its body is never run)", () => {
    const c = ctx();
    const files: { path: string; content: string }[] = [];
    const entries = parseHeadHtml('<script src="https://x.test/a.js">${z}</script>', {
      ...c,
      files,
    });
    expect(files).toEqual([]);
    expect(entries[0]!.attributes).toEqual({ src: "https://x.test/a.js" });
    expect(c.report.entries().map((entry) => entry.code)).toEqual(["design.template-literal"]);
  });

  test("custom code with a template marker reaches the design system as a file the head links, through the build", async () => {
    const { ds } = await synth({
      options: {
        customCode: { head: "<script>var t = `${1+1}`;</script>", bodyOpen: "", footer: "" },
      },
    });
    expect(ds.head).toEqual([{ tagName: "script", attributes: { src: "/js/cwicly-head-1.js" } }]);
    expect(ds.files).toEqual([
      { path: "public/js/cwicly-head-1.js", content: "var t = `${1+1}`;" },
    ]);
    const built = await buildJxProject(projectFiles(ds), { name: "ds-headjs" });
    expect(built.read("js/cwicly-head-1.js")).toBe("var t = `${1+1}`;");
    expect(built.html("/")).toContain('<script src="/js/cwicly-head-1.js"></script>');
  });

  test("custom code: a body-open snippet is handed back as is, not parsed, with its comments", async () => {
    const bodyOpen =
      '<!-- Google Tag Manager (noscript) -->\n<noscript><iframe src="https://x.test/ns.html?id=G" height="0"></iframe></noscript>';
    const { ds } = await synth({
      options: { customCode: { head: "", bodyOpen, footer: "<script>window.x=1</script>" } },
    });
    expect(ds.customCode).toEqual({ head: "", bodyOpen, footer: "<script>window.x=1</script>" });
    expect(ds.head).toEqual([]);
  });
});

describe("the owner's stylesheet and the cascade", () => {
  /** What a browser would apply: the live order (global, owner's, classes) against this project's (owner's link, then the style). */
  async function cascades(
    spec: Synthetic,
    queries: { tag: string; classes: string[]; width?: number }[],
  ) {
    const { ds } = await synth(spec);
    const built = await buildJxProject(projectFiles(ds), { name: "ds-cascade" });
    const original = `${spec.global ?? ""}\n${spec.custom ?? ""}\n${spec.classes ?? ""}`;
    const emitted = `${spec.custom ?? ""}\n${ds.style && built.exists("index.html") ? styleOf(built) : ""}`;
    const want = analysedRulesOf(original);
    const got = analysedRulesOf(emitted);
    return queries.flatMap((q) => {
      const query = { ...q, width: q.width ?? 1366 };
      return cascadeDiff(cascadeOf(want, query), cascadeOf(got, query));
    });
  }

  test("the owner's stylesheet is shipped verbatim, linked after the compatibility CSS and before the project style", async () => {
    const custom = ".block-link{text-decoration:none !important}\nbody{overflow-x:clip}";
    const { ds } = await synth({
      custom,
      opts: { compat: { path: COMPAT_CSS_PATH, content: "a{x:y}" } },
    });
    expect(ds.head.map((entry) => entry.attributes!.href)).toEqual([
      "/css/cwicly-base.css",
      "/css/cwicly-custom.css",
    ]);
    const file = ds.files.find((entry) => entry.path === CUSTOM_CSS_PATH)!.content as string;
    expect(file).toContain(custom);
    expect(ds.stylesheets.map((entry) => entry.role)).toEqual(["compat", "custom"]);
  });

  test("a declaration the owner's stylesheet overrides on the live site is taken out of the project style so it still does", async () => {
    const spec = {
      global:
        "h1{color:red;font-size:2em}h2{color:red}@media screen and (max-width: 992px){h1{color:red}}",
      custom: "h1{color:blue}@media screen and (max-width: 992px){h1{color:green}}",
    };
    const { ds, report } = await synth(spec);
    expect(ds.style.h1).toEqual({ fontSize: "2em" });
    expect(ds.style.h2).toEqual({ color: "red" });
    // the emptied media block is gone with it
    expect(ds.style["@--md"]).toBeUndefined();
    const entry = report.entries().find((e) => e.code === "design.cascade-order")!;
    expect(entry.data).toEqual({
      dropped: [
        { selector: "h1", context: "", property: "color" },
        { selector: "h1", context: "@--md", property: "color" },
      ],
    });
    const differences = await cascades(spec, [
      { tag: "h1", classes: [] },
      { tag: "h1", classes: [], width: 800 },
      { tag: "h2", classes: [] },
    ]);
    expect(differences).toEqual([]);
  });

  test("the same override left in place would have lost: the oracle sees the difference the emitter prevents", () => {
    // what a naive emitter writes: the owner's <link> first, then the global rule in the project style
    const naive = analysedRulesOf("h1{color:blue}\nh1{color:red;font-size:2em}");
    const live = analysedRulesOf("h1{color:red;font-size:2em}\nh1{color:blue}");
    const query = { tag: "h1", classes: [], width: 1366 };
    expect(cascadeDiff(cascadeOf(live, query), cascadeOf(naive, query))).toEqual([
      "|color: color: blue  ->  color: red",
    ]);
  });

  test("a declaration at another importance, or one the global classes set again, is not taken out", async () => {
    const spec = {
      global: "h1{color:red}h2{color:red}h3{color:red}",
      custom: "h1{color:blue !important}h2{color:blue}h3{color:blue}",
      classes: "h3{color:purple}",
    };
    const { ds } = await synth(spec);
    // `!important` outranks the project style wherever it sits; `h3` is set again after the owner's sheet, as on the live site
    expect(ds.style.h1).toEqual({ color: "red" });
    expect(ds.style.h2).toBeUndefined();
    expect(ds.style.h3).toEqual({ color: "purple" });
    expect(
      await cascades(
        spec,
        ["h1", "h2", "h3"].map((tag) => ({ tag, classes: [] })),
      ),
    ).toEqual([]);
  });

  test("an owner shorthand overrides a global longhand of the same selector, and is taken out like the same property; the reverse cannot be and is reported", async () => {
    const { ds, report } = await synth({
      global:
        "p{margin-bottom:1rem;color:red}h1{margin:0}h2{border-color:red}h3{border-top-color:red}",
      custom: "p{margin:0}h1{margin-top:5px}h2{border-top-color:blue}h3{border:0}",
    });
    // `p{margin:0}` sets margin-bottom after the global rule did: the global longhand goes, its neighbour stays
    expect(ds.style.p).toEqual({ color: "red" });
    // `h3{border:0}` covers `border-top-color` too
    expect(ds.style.h3).toBeUndefined();
    // `h1{margin-top:5px}` overrides one side of the global `margin:0`, which cannot be taken out
    // without losing the other three; `border-top-color` is one side of the global `border-color`
    expect(ds.style.h1).toEqual({ margin: "0" });
    expect(ds.style.h2).toEqual({ borderColor: "red" });
    const dropped = report.entries().find((entry) => entry.code === "design.cascade-order")!;
    expect(dropped.data).toEqual({
      dropped: [
        { selector: "p", context: "", property: "marginBottom" },
        { selector: "h3", context: "", property: "borderTopColor" },
      ],
    });
    const unresolved = report
      .entries()
      .find((entry) => entry.code === "design.cascade-unresolved")!;
    expect(unresolved.severity).toBe("warn");
    expect(unresolved.data).toEqual({
      pairs: [
        {
          selector: "h1",
          context: "",
          property: "margin",
          owner: { context: "", property: "marginTop" },
        },
        {
          selector: "h2",
          context: "",
          property: "borderColor",
          owner: { context: "", property: "borderTopColor" },
        },
      ],
    });
  });

  test("an owner rule with no at-rule overrides a global rule of the same declaration inside one, at every width", async () => {
    const spec = {
      global:
        "h1{font-size:20px}@media screen and (max-width: 992px){h1{font-size:18px}}h2{color:red}",
      custom: "h1{font-size:10px}",
    };
    const { ds, report } = await synth(spec);
    // live: the owner's sheet comes after both, so 10px at every width; the media rule left in the
    // project style would beat the owner's `<link>` at 992px and below
    expect(ds.style.h1).toBeUndefined();
    expect(ds.style["@--md"]).toBeUndefined();
    expect(report.entries().find((entry) => entry.code === "design.cascade-order")!.data).toEqual({
      dropped: [
        { selector: "h1", context: "", property: "fontSize" },
        { selector: "h1", context: "@--md", property: "fontSize" },
      ],
    });
    expect(codes(report)).not.toContain("design.cascade-unresolved");
    expect(
      await cascades(spec, [
        { tag: "h1", classes: [], width: 1366 },
        { tag: "h1", classes: [], width: 800 },
      ]),
    ).toEqual([]);
  });

  test("an owner rule inside an at-rule over a global one outside it, or inside another, is reported and the global one kept", async () => {
    const { ds, report } = await synth({
      global: "h1{font-size:20px}h2{color:red}@media screen and (max-width: 992px){h2{color:red}}",
      custom:
        "@media screen and (max-width: 992px){h1{font-size:9px}}@media screen and (max-width: 576px){h2{color:blue}}",
    });
    // dropping `h1{font-size:20px}` would leave the page wide without one: only the narrow owner rule beats it
    expect(ds.style.h1).toEqual({ fontSize: "20px" });
    expect(ds.style.h2).toEqual({ color: "red" });
    expect((ds.style["@--md"] as Record<string, unknown>).h2).toEqual({ color: "red" });
    expect(codes(report)).not.toContain("design.cascade-order");
    expect(
      report.entries().find((entry) => entry.code === "design.cascade-unresolved")!.data,
    ).toEqual({
      pairs: [
        {
          selector: "h1",
          context: "",
          property: "fontSize",
          owner: { context: "@--md", property: "fontSize" },
        },
        {
          selector: "h2",
          context: "",
          property: "color",
          owner: { context: "@--sm", property: "color" },
        },
        {
          selector: "h2",
          context: "@--md",
          property: "color",
          owner: { context: "@--sm", property: "color" },
        },
      ],
    });
  });

  test("a global classes rule that applies wherever the global declaration does leaves it alone, whatever its own at-rule", async () => {
    const { ds } = await synth({
      global: "h1{color:red}@media screen and (max-width: 992px){h1{color:red}}",
      custom: "h1{color:blue}",
      classes: "h1{color:purple}",
    });
    // the classes file follows the owner's in both places and covers both global declarations
    expect(ds.style.h1).toEqual({ color: "purple" });
    expect(ds.style["@--md"]).toEqual({ h1: { color: "red" } });
  });

  test("WordPress's Additional CSS is a file of its own, linked after the owner's, and takes part in the same comparison", async () => {
    const { ds, report } = await synth({
      global: "p{margin-top:1rem;color:red}",
      custom: ".a{x:y}",
      additionalCss: "p{margin-top:0}",
    });
    const owner = ds.files.find((entry) => entry.path === CUSTOM_CSS_PATH)!.content as string;
    const additional = ds.files.find((entry) => entry.path === ADDITIONAL_CSS_PATH)!
      .content as string;
    expect(owner).toContain(".a{x:y}");
    expect(owner).not.toContain("margin-top");
    expect(additional).toContain("p{margin-top:0}");
    expect(ds.head.map((entry) => entry.attributes!.href)).toEqual([
      "/css/cwicly-custom.css",
      "/css/cwicly-additional.css",
    ]);
    expect(ds.stylesheets.map((entry) => entry.role)).toEqual(["custom", "additional"]);
    expect(ds.style.p).toEqual({ color: "red" });
    expect(
      report
        .entries()
        .filter((entry) => entry.code === "design.custom-css")
        .map((entry) => entry.where),
    ).toEqual(["file:cc-global-stylesheets.css", "post:custom_css"]);
    const alone = await synth({ additionalCss: "p{margin-top:0}" });
    expect(alone.ds.files.map((entry) => entry.path)).toEqual([ADDITIONAL_CSS_PATH]);
  });

  test("an unterminated block in the owner's sheet cannot swallow the Additional CSS, and an @import that opens it stays first", async () => {
    // the live site prints two sheets: the owner's block closes at the end of its file, not at the next rule
    const { ds } = await synth({
      custom: ".a{color:red",
      additionalCss: '@import url("https://fonts.googleapis.com/css?family=Foo");\n.b{color:blue}',
    });
    const owner = ds.files.find((entry) => entry.path === CUSTOM_CSS_PATH)!.content as string;
    const additional = ds.files.find((entry) => entry.path === ADDITIONAL_CSS_PATH)!
      .content as string;
    expect(owner).not.toContain(".b");
    const nodes = postcss.parse(additional).nodes.filter((node) => node.type !== "comment");
    expect(nodes.map((node) => node.type)).toEqual(["atrule", "rule"]);
    expect((nodes[0] as postcss.AtRule).name).toBe("import");
    expect((nodes[1] as postcss.Rule).selector).toBe(".b");
  });

  test("a url() in the owner's stylesheet goes through rewriteUrl; the report says it is shipped as written", async () => {
    const { ds, report } = await synth({
      custom:
        ".a{background:url('https://example.com/wp-content/uploads/2023/a.jpg')}.b{background:url(data:image/png;base64,AA)}",
      opts: {
        rewriteUrl: (url) => url.replace("https://example.com/wp-content/uploads/", "/media/"),
      },
    });
    const file = ds.files.find((entry) => entry.path === CUSTOM_CSS_PATH)!.content as string;
    expect(file).toContain("url('/media/2023/a.jpg')");
    expect(file).toContain("url(data:image/png;base64,AA)");
    expect(report.entries().find((entry) => entry.code === "design.custom-css")!.where).toBe(
      "file:cc-global-stylesheets.css",
    );
  });
});

describe("the order of the cascade, which one style object has to keep", () => {
  /** What a browser would apply to elements, the files' rules against the project style's. */
  async function orderDiffs(
    spec: Synthetic,
    queries: { tag?: string; classes: string[]; width?: number; states?: string[] }[],
  ) {
    const { ds } = await synth(spec);
    const built = await buildJxProject(projectFiles(ds), { name: "ds-order" });
    const want = analysedRulesOf(`${spec.global ?? ""}\n${spec.classes ?? ""}`);
    const got = analysedRulesOf(styleOf(built));
    return queries.flatMap((q) => {
      const query = { tag: "div", width: 1366, ...q };
      return cascadeDiff(cascadeOf(want, query), cascadeOf(got, query));
    });
  }

  test("a later rule of a class that must beat another class's is written after it, under an equal-specificity alias", async () => {
    // `.bl` pads 1rem last in the file; one object would write that beside `.bl`'s first rule, ahead of `.ns`
    const spec = { classes: ".bl{color:red}.ns{padding:0}.bl{padding:1rem}.bl:hover{color:blue}" };
    const { ds, report } = await synth(spec);
    expect(Object.keys(ds.style)).toEqual([".bl", ".ns", ":is(.bl)", ".bl:hover"]);
    expect(ds.style[".bl"]).toEqual({ color: "red" });
    expect(ds.style[":is(.bl)"]).toEqual({ padding: "1rem" });
    const entry = report.entries().find((e) => e.code === "design.cascade-reordered")!;
    expect(entry.severity).toBe("info");
    expect(entry.data).toEqual({
      aliases: [{ selector: ".bl", alias: ":is(.bl)", context: "" }],
    });
    expect(codes(report)).not.toContain("design.cascade-inverted");
    expect(await orderDiffs(spec, [{ classes: ["bl", "ns"] }, { classes: ["ns", "bl"] }])).toEqual(
      [],
    );
    // the alias is a rule the build and `jx validate` accept
    const built = await buildJxProject(projectFiles(ds), { name: "ds-alias" });
    expect(styleOf(built)).toContain(":is(.bl) { padding: 1rem }");
    expect((await validateJxProject(built.dir)).problems).toEqual([]);
  });

  test("a shorthand and a longhand of the same property are one conflict: the later of them keeps winning", async () => {
    const spec = { classes: ".x{border-width:1px}.y{border:2px solid}.x{border-width:5px}" };
    const { ds } = await synth(spec);
    expect(ds.style).toEqual({ ".y": { border: "2px solid" }, ":is(.x)": { borderWidth: "5px" } });
    expect(await orderDiffs(spec, [{ classes: ["x", "y"] }])).toEqual([]);
  });

  test("a second alias of one selector is another spelling, and a state or a pseudo-element survives the alias", async () => {
    const spec = {
      classes:
        ".a{display:block}.b{color:blue}.c{padding:2px}.d{margin:0}.a{color:green}.a{padding:3px}" +
        ".a::before{content:'x'}.a:hover{color:gold}.d:hover{color:pink}.a:hover{margin:1px}",
    };
    const { ds } = await synth(spec);
    expect(Object.entries(ds.style)).toEqual([
      [".a", { display: "block" }],
      [".b", { color: "blue" }],
      [":is(.a)", { color: "green" }],
      [".c", { padding: "2px" }],
      [":is(:is(.a))", { padding: "3px" }],
      [".d", { margin: "0" }],
      [".a::before", { content: "'x'" }],
      [".a:hover", { color: "gold", margin: "1px" }],
      [".d:hover", { color: "pink" }],
    ]);
    expect(
      await orderDiffs(spec, [
        { classes: ["a", "b"] },
        { classes: ["a", "c"] },
        { classes: ["a", "d"] },
        { classes: ["a", "d"], states: [":hover"] },
      ]),
    ).toEqual([]);
  });

  test("a rule that the files wrote after an at-rule's cannot be written before it, and the pair is reported", async () => {
    const { ds, report } = await synth({
      global: ".a{color:red}@media screen and (max-width: 992px){.a{color:blue}}",
      classes: ".a{color:green}",
    });
    // unchanged: the base rule is always written first
    expect(ds.style).toEqual({ ".a": { color: "green" }, "@--md": { ".a": { color: "blue" } } });
    const warn = report.entries().find((e) => e.code === "design.cascade-inverted")!;
    expect(warn.severity).toBe("warn");
    expect(warn.data).toEqual({
      pairs: [
        {
          property: "color",
          here: { selector: ".a", context: "@--md" },
          inSource: { selector: ".a", context: "" },
        },
      ],
    });
    expect(warn.message).toContain("color of .a in @--md now beats .a");
    // a tag and the class file after its breakpoint rule, as the real sites do
    const tag = await synth({
      global: "h1{color:red}@media screen and (max-width: 992px){h1{color:blue}}",
      classes: "h1{color:pink}",
    });
    expect(tag.report.entries().filter((e) => e.code === "design.cascade-inverted")).toHaveLength(
      1,
    );
  });

  test("components' own classes are not combined with others, so a pair of them is no inversion", async () => {
    // `.cc-nav-wrapper` and `.wp-block-search__button` belong to different components; no author puts both on one element
    const { report } = await synth({
      global:
        "@media screen and (max-width: 992px){.cc-nav .cc-nav-wrapper{width:100%}}" +
        ".wp-block-search .wp-block-search__button{width:2rem}",
      classes: ".wp-block-search{display:flex}",
    });
    expect(codes(report)).not.toContain("design.cascade-inverted");
  });

  test("an at-rule that came before a breakpoint's rule in the file is written before it, and one that came after, after", async () => {
    const before =
      ".a{color:red}@supports (display: grid){.a{color:green}}@media screen and (max-width: 992px){.a{color:blue}}";
    const after =
      ".a{color:red}@media screen and (max-width: 992px){.a{color:blue}}@supports (display: grid){.a{color:green}}";
    const first = await synth({ global: before });
    expect(Object.keys(first.ds.style)).toEqual([".a", "@supports (display: grid)", "@--md"]);
    const second = await synth({ global: after });
    expect(Object.keys(second.ds.style)).toEqual([".a", "@--md", "@supports (display: grid)"]);
    for (const spec of [{ global: before }, { global: after }]) {
      expect(
        await orderDiffs(spec, [
          { classes: ["a"], width: 800 },
          { classes: ["a"], width: 1366 },
        ]),
      ).toEqual([]);
    }
    // and the breakpoints themselves stay in the order of the cascade whatever the file said
    const wrongWay = await synth({
      global:
        ".a{color:red}@media screen and (max-width: 576px){.a{color:blue}}@media screen and (max-width: 992px){.a{color:green}}",
    });
    expect(Object.keys(wrongWay.ds.style)).toEqual([".a", "@--md", "@--sm"]);
  });

  test("a site whose files already are in order gets no alias and no warning", async () => {
    const { ds, report } = await synth({
      global: "h1{color:red}@media screen and (max-width: 992px){h1{color:blue}}",
      classes: ".a{color:red}.b{color:blue}@media screen and (max-width: 992px){.a{color:green}}",
    });
    expect(Object.keys(ds.style)).toEqual(["h1", ".a", ".b", "@--md"]);
    expect(codes(report)).not.toContain("design.cascade-reordered");
    expect(codes(report)).not.toContain("design.cascade-inverted");
    // an at-rule no pair of rules ties to a breakpoint goes after the breakpoints, wherever the file had it
    const loose = await synth({
      global:
        "h1{color:red}@supports (display: grid){h2{color:green}}@media screen and (max-width: 992px){h1{color:blue}}",
    });
    expect(Object.keys(loose.ds.style)).toEqual(["h1", "@--md", "@supports (display: grid)"]);
  });
});

describe("what Jx does with the rules", () => {
  test("a body rule inside a breakpoint stays inside it, and a body colour-scheme is not lifted onto :root", async () => {
    const { ds } = await synth({
      global:
        "body{font-size:20px;color-scheme:dark}@media screen and (max-width: 992px){body{font-size:16px}}",
    });
    expect(ds.style.fontSize).toBe("20px");
    expect(ds.style.body).toEqual({ colorScheme: "dark" });
    expect(ds.style["@--md"]).toEqual({ fontSize: "16px" });
    const built = await buildJxProject(projectFiles(ds), { name: "ds-body" });
    const emitted = styleOf(built);
    expect(emitted).toContain("body { font-size: 20px }");
    expect(emitted).toContain("@media (max-width: 992px) { body { font-size: 16px } }");
    expect(emitted).toContain("body { color-scheme: dark }");
  });

  test("a custom property of the body stays on the body: lifted, it would replace :root's own", async () => {
    const { ds } = await synth({
      global:
        ":root{--c:red}body{--c:blue;color:var(--c)}html{background:var(--c)}" +
        "@media screen and (max-width: 992px){body{--c:green;font-size:1px}}",
    });
    expect(ds.style["--c"]).toBe("red");
    expect(ds.style.color).toBe("var(--c)");
    expect(ds.style.body).toEqual({ "--c": "blue" });
    expect(ds.style["@--md"]).toEqual({ fontSize: "1px", body: { "--c": "green" } });
    const built = await buildJxProject(projectFiles(ds), { name: "ds-bodyvar" });
    const emitted = styleOf(built);
    expect(emitted).toContain(":root { --c: red }");
    expect(emitted).toContain("body { --c: blue }");
    expect(emitted).not.toContain(":root { --c: blue");
  });

  test("a Jx template marker in a CSS value is written as its CSS escape, so the build does not evaluate it", async () => {
    const { ds, report } = await synth({ classes: '.a::before{content:"${1}"}' });
    expect(JSON.stringify(ds.style)).not.toContain("${");
    expect(
      report.entries().find((entry) => entry.code === "design.template-literal")!.severity,
    ).toBe("info");
    const built = await buildJxProject(projectFiles(ds), { name: "ds-dollar" });
    expect(styleOf(built)).toContain('content: "\\24 {1}"');
  });

  test("url() values in the style go through rewriteUrl, in every nesting, and only they", async () => {
    const { ds } = await synth({
      classes:
        ".hero{background-image:url(https://example.com/wp-content/uploads/a.jpg);color:red}" +
        "@media screen and (max-width: 992px){.hero:hover{background-image:url('https://example.com/wp-content/uploads/b.jpg')}}",
      opts: {
        rewriteUrl: (url) => url.replace("https://example.com/wp-content/uploads/", "/media/"),
      },
    });
    expect(ds.style[".hero"]).toEqual({ backgroundImage: "url(/media/a.jpg)", color: "red" });
    expect((ds.style["@--md"] as Record<string, unknown>)[".hero:hover"]).toEqual({
      backgroundImage: "url('/media/b.jpg')",
    });
  });

  test("rewriteCssUrls keeps the quoting and leaves data:, fragments and var() alone", () => {
    const to = (url: string): string => `/m/${url.split("/").pop()}`;
    expect(rewriteCssUrls("a{b:url(https://x/y.png)}", to)).toBe("a{b:url(/m/y.png)}");
    expect(rewriteCssUrls('a{b:url("https://x/y.png")}', to)).toBe('a{b:url("/m/y.png")}');
    expect(rewriteCssUrls("a{b:url( 'https://x/y.png' )}", to)).toBe("a{b:url('/m/y.png')}");
    expect(rewriteCssUrls("a{b:url(data:image/png;base64,AA)}", to)).toBe(
      "a{b:url(data:image/png;base64,AA)}",
    );
    expect(rewriteCssUrls("a{b:url(#grad)}", to)).toBe("a{b:url(#grad)}");
    expect(rewriteCssUrls("a{b:url(var(--x))}", to)).toBe("a{b:url(var(--x))}");
    // a result that needs quotes gets them; an unchanged one is untouched
    expect(rewriteCssUrls("a{b:url(x.png)}", () => "/a b.png")).toBe('a{b:url("/a b.png")}');
    expect(rewriteCssUrls("a{b:url(x.png)}", (url) => url)).toBe("a{b:url(x.png)}");
    expect(rewriteCssUrls("a{b:url('x.png')}", () => "/it's.png")).toBe("a{b:url('/it%27s.png')}");
    expect(rewriteCssUrls('a{b:url("x.png")}', () => '/q"r.png')).toBe('a{b:url("/q%22r.png")}');
    expect(rewriteCssUrls("a{b:url()}", to)).toBe("a{b:url()}");
  });

  test("the custom properties of a palette reach the page on :root, and a selector with an attribute or a state is emitted as written", async () => {
    const { ds } = await synth({
      global:
        ':root{--a:1}.cc-nav[breakpoint="lg"] .w{display:none}@supports (height: 100dvh){.w{min-height:100dvh}}',
    });
    const built = await buildJxProject(projectFiles(ds), { name: "ds-misc" });
    const emitted = styleOf(built);
    expect(emitted).toContain(":root { --a: 1 }");
    expect(emitted).toContain('.cc-nav[breakpoint="lg"] .w { display: none }');
    expect(emitted).toContain("@supports (height: 100dvh) { .w { min-height: 100dvh } }");
  });
});

describe("additionalCssFor", () => {
  const post = (
    id: number,
    slug: string,
    content: string,
    status = "publish",
    type = "custom_css",
  ) => [id, { id, type, status, slug, title: slug, content }] as const;
  const model = (theme: string, ...posts: ReturnType<typeof post>[]) =>
    ({ site: { theme }, posts: new Map(posts) }) as unknown as Parameters<
      typeof additionalCssFor
    >[0];

  test("the active theme's custom_css post, the newest of them, and only a published one", () => {
    expect(
      additionalCssFor(model("cwicly", post(1, "cwicly", "a{}"), post(2, "cwicly", "b{}"))),
    ).toBe("b{}");
    expect(additionalCssFor(model("cwicly", post(1, "blocksy", "a{}")))).toBeUndefined();
    expect(additionalCssFor(model("cwicly", post(1, "cwicly", "a{}", "draft")))).toBeUndefined();
    expect(
      additionalCssFor(model("cwicly", post(1, "cwicly", "a{}", "publish", "page"))),
    ).toBeUndefined();
    expect(additionalCssFor(model("cwicly", post(1, "cwicly", "  \n")))).toBeUndefined();
    expect(additionalCssFor(model("cwicly"))).toBeUndefined();
  });

  test("on the real sites: ap prints the Cwicly theme's, fineline has only a Blocksy one it never loads", async () => {
    expect(additionalCssFor((await loadSite("ap")).model)).toBe(
      "tr#user-1560,tr#user_1560{display:none!important}",
    );
    expect(additionalCssFor((await loadSite("fineline")).model)).toBeUndefined();
    // the live page carries exactly that text, as its last style element
    const html = readFileSync(join(import.meta.dir, "../fixtures/ap/html/essays.html"), "utf8");
    expect(html).toContain(
      '<style id="wp-custom-css">\ntr#user-1560,tr#user_1560{display:none!important}\n</style>',
    );
  });
});
