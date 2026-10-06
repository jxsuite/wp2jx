/**
 * The wave-1 foundations wired together: ingest (`wp/`), the Cwicly options reader, the CSS reader
 * and the HTML converter, run over both fixture sites in the order the converter will call them:
 *
 *   fixtureDb → openDb → loadModel → readCwiclyOptions(model.options) → loadCssIndex(every stylesheet)
 *
 * Every module has its own suite. This one checks the places where they meet: an id one module
 * produces and another must find (a block's `classID` in a stylesheet, a global class id in the
 * options), a key one writes and another reads (`@--md` in a style, `--md` in `$media`), a shape one
 * accepts that another produced (the options' breakpoints and palette in the CSS reader, a block's
 * markup in the HTML converter, every module's findings in the report), and what a whole site costs.
 *
 * The figures pinned below are those of the committed fixtures. A change in a foundation module that
 * moves one is a change at a seam: read it, do not just update the number. Each site's tests print a
 * summary (`── <site> ──`), which is where the numbers are reported.
 *
 * The block trees are those of the published subjects: pages, posts and every custom post type,
 * templates, template parts, components and reusable blocks. Drafts and private posts are left out
 * of the counts, except where a test says every post.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { cssPropertyName } from "@jxsuite/runtime/css";
import { validateDocument } from "@jxsuite/schema";
import {
  CSS_ARTIFACT,
  cssRules,
  jxStyleKey,
  loadCssIndex,
  parseCwiclyCss,
  projectStyles,
} from "../../src/cwicly/css.ts";
import type { OrderedCssIndex } from "../../src/cwicly/css.ts";
import { readCwiclyOptions, resolvePaletteRefs } from "../../src/cwicly/options.ts";
import type { CwiclyOptionsFull } from "../../src/cwicly/options.ts";
import { htmlToNodes } from "../../src/html.ts";
import { kebabToCamel } from "../../src/jx-util.ts";
import {
  createReport,
  renderReportJson,
  renderReportMarkdown,
  summarise,
} from "../../src/report.ts";
import type {
  CssIndex,
  JxNode,
  JxStyle,
  Report,
  ReportEntry,
  WpBlock,
  WpModel,
  WpPost,
} from "../../src/types.ts";
import { parseBlocks, walkBlocks } from "../../src/wp/blocks.ts";
import { openDb } from "../../src/wp/db.ts";
import { loadModel, publicUrl } from "../../src/wp/model.ts";
import {
  allSubjects,
  componentsOf,
  cssNamesFor,
  subjectBlocks,
  subjectPost,
} from "../helpers/ctx.ts";
import type { LoadedSite, Subject } from "../helpers/ctx.ts";
import {
  FIXTURE_BREAKPOINTS,
  FIXTURE_SITES,
  fixtureCssNames,
  fixtureCssSource,
} from "../helpers/fixture-css.ts";
import type { FixtureSite } from "../helpers/fixture-css.ts";
import { fixtureDb, fixtureDir } from "../helpers/fixture-db.ts";

// Loading a site and checking every block of it takes seconds, and a loaded machine doubles them.
setDefaultTimeout(60_000);

// ── The pipeline ─────────────────────────────────────────────────────────────────────────────────

/** A published subject's block tree, with the stylesheets its rendered page loads. */
interface Tree {
  subject: Subject;
  /** Where the report says it is: `post:5246`, `template:cwicly//header`, `component:0a275b695a`. */
  where: string;
  blocks: WpBlock[];
  /** Global, own, and those of every part, component and reusable block it embeds (`cssNamesFor`). */
  sheets: string[];
  /** The stylesheet that holds the subject's own blocks. */
  own: string;
}

/** One stylesheet read on its own: what it has rules for, and every class its text mentions. */
interface Sheet {
  index: OrderedCssIndex;
  /** Class names that own a rule: a class tree, or a selector under `other` that starts at the class. */
  ruled: Set<string>;
  /** Class names the raw text mentions, whether or not a rule follows (Cwicly writes empty placeholders). */
  mentioned: Set<string>;
}

interface Foundations {
  site: FixtureSite;
  model: WpModel;
  options: CwiclyOptionsFull;
  modelReport: Report;
  optionsReport: Report;
  loaded: LoadedSite;
  names: string[];
  css: Map<string, string>;
  /** `loadCssIndex` over every stylesheet the site has, with the options' breakpoints and palette. */
  index: OrderedCssIndex;
  merged: Sheet;
  /** The same load with no palette, to see what the palette repairs. */
  bare: OrderedCssIndex;
  sheets: Map<string, Sheet>;
  trees: Tree[];
  /** Milliseconds per phase; the tests add their own. */
  ms: Record<string, number>;
}

const CLASS_TOKEN = /\.(-?[_a-zA-Z][\w-]*)/g;

/** The shape of a class Cwicly names for a block: the block's kind, then `-c` and a short hash. */
const BLOCK_CLASS = /^[a-z][a-z-]*-c[0-9a-f]{6,7}$/;

const isBlock = (value: unknown): value is JxStyle =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every key and value in a style tree, nested blocks and the arrays of blocks `@font-face` needs included. */
function* walkStyle(style: JxStyle): Generator<[key: string, value: unknown]> {
  for (const [key, value] of Object.entries(style)) {
    yield [key, value];
    for (const inner of Array.isArray(value) ? value : [value]) {
      if (isBlock(inner)) yield* walkStyle(inner);
    }
  }
}

const everyStyle = (index: CssIndex): JxStyle[] => [
  ...[...index.classes.values()].map((entry) => entry.style),
  ...index.other.values(),
  ...index.atRules.map((rule) => rule.style),
];

const classTokens = (text: string): Set<string> =>
  new Set(Array.from(text.matchAll(CLASS_TOKEN), (match) => match[1] ?? ""));

const ROOT_CLASS = /^\.(-?[_a-zA-Z][\w-]*)/;

function sheetOf(index: OrderedCssIndex, text: string): Sheet {
  const ruled = new Set(index.classes.keys());
  // A selector the reader keeps under `other` is rooted at a class when it starts with one
  // (`.div-cf3ac5e.cs-bmuh8n`, a component variant): that class owns the rule.
  for (const selector of index.other.keys()) {
    const root = ROOT_CLASS.exec(selector)?.[1];
    if (root !== undefined) ruled.add(root);
  }
  return { index, ruled, mentioned: classTokens(text) };
}

/**
 * Whether a sheet has a rule for a class. The reader files a class name that holds a dot (a compound
 * selector Cwicly lets a person type as a class name) under `other`, as `.a.b`, so ask both.
 */
const hasRule = (sheet: Sheet, name: string): boolean =>
  sheet.index.classes.has(name) || sheet.index.other.has(`.${name}`) || sheet.ruled.has(name);

const isMentioned = (sheet: Sheet, name: string): boolean =>
  name.includes(".")
    ? name.split(".").every((part) => sheet.mentioned.has(part))
    : sheet.mentioned.has(name);

function whereOf(subject: Subject, theme: string): string {
  switch (subject.kind) {
    case "post":
    case "reusable":
      return `post:${subject.id}`;
    case "template":
    case "part":
      return `template:${theme}//${subject.slug}`;
    case "component":
      return `component:${subject.ref}`;
  }
}

function ownSheet(subject: Subject, theme: string): string {
  switch (subject.kind) {
    case "post":
      return `cc-post-${subject.id}.css`;
    case "template":
    case "part":
      return `cc-tp-${theme}_${subject.slug}.css`;
    case "component":
      return `cc-cm-${subject.ref}.css`;
    case "reusable":
      return `cc-rb-${subject.id}.css`;
  }
}

async function timed<T>(
  ms: Record<string, number>,
  label: string,
  work: () => Promise<T> | T,
): Promise<T> {
  const start = performance.now();
  try {
    return await work();
  } finally {
    ms[label] = performance.now() - start;
  }
}

async function build(site: FixtureSite): Promise<Foundations> {
  const ms: Record<string, number> = {};
  const { url, prefix } = await fixtureDb(site);
  const modelReport = createReport();
  const db = await timed(ms, "openDb", () => openDb(url, { prefix }));
  let model: WpModel;
  try {
    model = await timed(ms, "loadModel", () => loadModel(db, { report: modelReport }));
    // A second load is the warm figure: the first pays for compiling the query paths.
    await timed(ms, "loadModelWarm", () => loadModel(db));
  } finally {
    await db.close();
  }

  const optionsReport = createReport();
  const options = await timed(ms, "readOptions", () =>
    readCwiclyOptions(model.options, optionsReport),
  );

  const source = fixtureCssSource(site);
  const names = fixtureCssNames(site);
  // The palette the reader wants is every id a `!var=` can name (colours, shades, variants), which is
  // `colorRefs`: the `colors` list src/types.ts hands converters leaves shade and variant ids unresolved.
  const palette = [...options.globalStyles.colorRefs.values()];
  const index = await timed(ms, "css", () =>
    loadCssIndex(source, names, options.breakpoints, { palette }),
  );
  await timed(ms, "cssWarm", () => loadCssIndex(source, names, options.breakpoints, { palette }));
  const bare = await loadCssIndex(source, names, options.breakpoints);

  const css = new Map<string, string>();
  for (const name of names) css.set(name, (await source.get(name)) ?? "");
  const sheets = new Map<string, Sheet>();
  await timed(ms, "cssOneByOne", async () => {
    for (const name of names) {
      const alone = await loadCssIndex(source, [name], options.breakpoints, { palette });
      sheets.set(name, sheetOf(alone, css.get(name) ?? ""));
    }
  });
  ms["cssBytes"] = [...css.values()].reduce((total, text) => total + text.length, 0);

  const { loadSite } = await import("../helpers/ctx.ts");
  const loaded: LoadedSite = {
    ...(await loadSite(site)),
    model,
    options,
    report: optionsReport,
    cssSource: source,
  };
  const theme = model.site.theme;
  const trees = allSubjects(loaded)
    .filter((subject) => subjectPost(loaded, subject)?.status === "publish")
    .map((subject): Tree => ({
      subject,
      where: whereOf(subject, theme),
      blocks: subjectBlocks(loaded, subject),
      sheets: cssNamesFor(loaded, subject),
      own: ownSheet(subject, theme),
    }));
  return {
    site,
    model,
    options,
    modelReport,
    optionsReport,
    loaded,
    names,
    css,
    index,
    merged: sheetOf(index, [...css.values()].join("\n")),
    bare,
    sheets,
    trees,
    ms,
  };
}

const builds = new Map<FixtureSite, Promise<Foundations>>();
const foundations = (site: FixtureSite): Promise<Foundations> => {
  let pending = builds.get(site);
  if (pending === undefined) {
    pending = build(site);
    builds.set(site, pending);
  }
  return pending;
};

const pct = (part: number, whole: number): string =>
  `${((100 * part) / Math.max(whole, 1)).toFixed(2)}%`;
const fixed = (n: number | undefined): string => (n === undefined ? "n/a" : n.toFixed(0));
const sorted = (values: Iterable<string>): string[] => [...values].toSorted();

// ── What the fixtures hold ───────────────────────────────────────────────────────────────────────

type Bucket = "styled" | "placeholder" | "unstyled" | "noSheet" | "stale";

/**
 * Where every block `classID` in the published trees lands, counted per occurrence (a block):
 *
 * - `styled`: a rule with declarations, in some stylesheet of the site.
 * - `placeholder`: Cwicly wrote the class as an empty rule (`.paragraph-c23cc06{}`) and nothing more:
 *   a block with no styles of its own. Accounted for.
 * - `unstyled`: no stylesheet mentions it and the block does not claim styles (`isStyling` is not
 *   true). Accounted for.
 * - `noSheet`: the block claims styles, no stylesheet mentions it, and the subject's own stylesheet
 *   is not among the fixtures (the fixtures keep what the sampled public pages load; the live site
 *   serves more). Accounted for, by the missing file.
 * - `stale`: the block claims styles, its subject's stylesheet exists, and the class is in none. The
 *   database and the stylesheets disagree, and it is the one bucket nothing explains.
 */
const CENSUS: Record<FixtureSite, { blocks: Record<Bucket, number>; onlyElsewhere: number }> = {
  fineline: {
    blocks: { styled: 4664, placeholder: 0, unstyled: 0, noSheet: 79, stale: 21 },
    onlyElsewhere: 226,
  },
  ap: {
    blocks: { styled: 575, placeholder: 292, unstyled: 63, noSheet: 16, stale: 19 },
    onlyElsewhere: 44,
  },
};

// ── Per-site seams ───────────────────────────────────────────────────────────────────────────────

for (const site of FIXTURE_SITES) {
  describe(`foundations: ${site}`, () => {
    let f: Foundations;
    const notes: string[] = [];
    const note = (line: string): void => {
      notes.push(`  ${line}`);
    };

    beforeAll(async () => {
      f = await foundations(site);
    }, 120_000);

    afterAll(() => {
      const ms = f.ms;
      console.log(
        [
          `\n── ${site} ──`,
          ...notes,
          `  timings (ms, load average ${loadavg()[0]?.toFixed(1)}): ` +
            Object.entries(ms)
              .filter(([key]) => key !== "cssBytes")
              .map(([key, value]) => `${key} ${fixed(value)}`)
              .join(", "),
        ].join("\n"),
      );
    });

    test("the pipeline runs and nothing in it reports an error", () => {
      const entries = [...f.modelReport.entries(), ...f.optionsReport.entries()];
      expect(entries.filter((entry) => entry.severity === "error")).toEqual([]);
      const codes = (report: Report): string[] =>
        sorted(new Set(report.entries().map((e) => e.code)));
      note(
        `model report: ${f.modelReport.entries().length} entries ${JSON.stringify(codes(f.modelReport))}`,
      );
      note(
        `options report: ${f.optionsReport.entries().length} entries ${JSON.stringify(codes(f.optionsReport))}`,
      );
      note(
        `corpus: ${f.model.posts.size} posts, ${f.model.attachments.size} attachments, ` +
          `${f.names.length} stylesheets (${f.ms["cssBytes"]} bytes), ${f.index.rules.length} rules, ` +
          `${f.index.classes.size} classes, ${f.index.other.size} other selectors`,
      );
      // The artifacts the generator's own bugs leave (`.undefined{}`, `[object Object]`) are the only ones.
      const artifacts = new Map<string, number>();
      for (const artifact of f.index.artifacts) {
        artifacts.set(artifact.code, (artifacts.get(artifact.code) ?? 0) + 1);
      }
      note(`css artifacts: ${JSON.stringify(Object.fromEntries(artifacts))}`);
      expect(sorted(artifacts.keys())).toEqual(
        [CSS_ARTIFACT.invalidValue, CSS_ARTIFACT.undefinedSelector].toSorted(),
      );
    });

    test("every post's content parses to blocks that line up with their own markup", () => {
      let posts = 0;
      let blocks = 0;
      let freeform = 0;
      const broken: string[] = [];
      const start = performance.now();
      for (const post of f.model.posts.values()) {
        if (post.content === "") continue;
        posts += 1;
        walkBlocks(parseBlocks(post.content), (block) => {
          blocks += 1;
          if (block.name === null) freeform += 1;
          const slots = block.innerContent.filter((part) => part === null).length;
          if (slots !== block.innerBlocks.length) broken.push(`post:${post.id} ${block.name}`);
        });
      }
      f.ms["parseBlocks"] = performance.now() - start;
      expect(broken).toEqual([]);
      note(`blocks: ${blocks} in ${posts} posts with content (${freeform} freeform)`);
    });

    // ── options ↔ css ──

    test("the breakpoints the options module reads are the ones the stylesheets were compiled against", () => {
      expect(
        f.options.breakpoints.map((bp) => ({
          key: bp.key,
          width: bp.width,
          isMain: bp.isMain,
          direction: bp.direction,
        })),
      ).toEqual(FIXTURE_BREAKPOINTS);
      // The `$media` map `project.json` declares: the main width under `--`, one query per other key.
      expect(f.options.media).toEqual({
        "--": "1366px",
        "--md": "(max-width: 992px)",
        "--sm": "(max-width: 576px)",
      });
    });

    test("every `@--` key the CSS reader writes is a key of `$media`, in every shape the reader hands out", () => {
      const media = new Set(Object.keys(f.options.media));
      const found = new Set<string>();
      const literal = new Set<string>();
      const visit = (key: string): void => {
        if (key.startsWith("@--")) found.add(key);
        else if (key.startsWith("@")) literal.add(key);
      };
      for (const style of everyStyle(f.index)) for (const [key] of walkStyle(style)) visit(key);
      for (const rule of cssRules(f.index)) for (const key of rule.context) visit(key);
      const layouts = projectStyles(f.index, f.options.breakpoints);
      for (const layout of layouts) for (const [key] of walkStyle(layout)) visit(key);
      expect(sorted(found).filter((key) => !media.has(key.slice(1)))).toEqual([]);
      expect(sorted(found)).toEqual(["@--md", "@--sm"]);
      // No query the reader could not map to a breakpoint, so none is kept as a literal at-rule key.
      expect(sorted(literal)).toEqual([]);
      expect(f.index.artifacts.map((a) => a.code)).not.toContain(CSS_ARTIFACT.mediaUnmapped);
      // Within one layout object the breakpoint blocks follow the options' cascade order.
      const order = f.options.breakpoints.filter((bp) => !bp.isMain).map((bp) => `@--${bp.key}`);
      for (const layout of layouts) {
        const positions = Object.keys(layout)
          .filter((key) => key.startsWith("@--"))
          .map((key) => order.indexOf(key));
        expect(positions).toEqual(positions.toSorted((a, b) => a - b));
        expect(positions).not.toContain(-1);
      }
      note(
        `projectStyles: ${layouts.length} layout objects, breakpoint keys ${JSON.stringify(sorted(found))}`,
      );
    });

    test("the options' compiled CSS parses with the same breakpoints, and everything in it is understood", () => {
      const media = new Set(Object.keys(f.options.media));
      const palette = [...f.options.globalStyles.colorRefs.values()];
      for (const [which, text] of Object.entries(f.options.compiledCss)) {
        if (text === "") continue;
        const index = parseCwiclyCss(text, f.options.breakpoints, {
          file: `option:${which}`,
          palette,
        });
        const codes = new Set(index.artifacts.map((artifact) => artifact.code));
        for (const code of [
          CSS_ARTIFACT.mediaUnmapped,
          CSS_ARTIFACT.syntaxError,
          CSS_ARTIFACT.unclassified,
          CSS_ARTIFACT.token,
          CSS_ARTIFACT.unresolvedPaletteVar,
        ]) {
          expect({ which, code, present: codes.has(code) }).toEqual({
            which,
            code,
            present: false,
          });
        }
        const keys = new Set<string>();
        for (const style of everyStyle(index)) {
          for (const [key] of walkStyle(style)) if (key.startsWith("@--")) keys.add(key);
        }
        expect(sorted(keys).filter((key) => !media.has(key.slice(1)))).toEqual([]);
      }
      // `cwicly_global_stylesheets_rendered` is exactly the served `cc-global-stylesheets.css`.
      expect(f.options.compiledCss.stylesheets).toBe(f.css.get("cc-global-stylesheets.css") ?? "");
    });

    test("Google fonts reach a site from two places, the options and the stylesheets' `@import`s, and no family is in both", () => {
      // Per-block fonts arrive only as an `@import` in a post's CSS; the site-wide one is in the options.
      const imported = f.index.atRules
        .filter((rule) => rule.key.startsWith("@import"))
        .flatMap((rule) =>
          Array.from(rule.key.matchAll(/family=([^:&"')]+)/g), (match) =>
            decodeURIComponent(match[1] ?? ""),
          ),
        );
      const configured = f.options.globalStyles.fonts.map((font) => font.family);
      expect(sorted(imported)).toEqual(site === "fineline" ? ["Inter", "Reem Kufi"] : []);
      expect(sorted(configured)).toEqual(site === "fineline" ? ["Source Sans Pro"] : ["Poppins"]);
      expect(imported.filter((family) => configured.includes(family))).toEqual([]);
      note(
        `fonts: options ${JSON.stringify(configured)}, @import in the stylesheets ${JSON.stringify(imported)}`,
      );
    });

    test("the palette the options module reads repairs every `!var=<id>!` the generator left in the stylesheets", () => {
      const raw = [...f.css.values()].join("\n");
      const ids = Array.from(raw.matchAll(/!var=([^!\s]*)!/g), (match) => match[1] ?? "");
      const left = f.bare.artifacts.filter((a) => a.code === CSS_ARTIFACT.unresolvedPaletteVar);
      // Without a palette every one is reported; with it, none is, because the palette has every id.
      expect(left).toHaveLength(ids.length);
      for (const id of ids) expect(f.options.globalStyles.colorRefs.has(id)).toBe(true);
      expect(f.index.artifacts.map((a) => a.code)).not.toContain(CSS_ARTIFACT.unresolvedPaletteVar);
      note(
        `palette: ${ids.length} unresolved \`!var=\` ids in the stylesheets, ${f.options.globalStyles.colors.length} colours`,
      );
    });

    test("every custom property a stylesheet reads is declared by the palette, Cwicly's global CSS, a stylesheet or a block's inline style", () => {
      const used = new Map<string, number>();
      for (const style of everyStyle(f.index)) {
        for (const [, value] of walkStyle(style)) {
          if (typeof value !== "string") continue;
          for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
            used.set(match[1] ?? "", (used.get(match[1] ?? "") ?? 0) + 1);
          }
        }
      }
      const declared = new Set<string>([
        ...[...f.options.globalStyles.colorRefs.values()].map((ref) => ref.variable),
        ...f.options.globalStyles.gradients.map((gradient) => gradient.variable),
      ]);
      const declare = (style: JxStyle): void => {
        for (const [key] of walkStyle(style)) if (key.startsWith("--")) declared.add(key);
      };
      for (const text of [f.options.compiledCss.global, f.options.compiledCss.stylesheets]) {
        for (const style of everyStyle(parseCwiclyCss(text, f.options.breakpoints))) declare(style);
      }
      for (const style of everyStyle(f.index)) declare(style);
      // A block can declare one on its own element: `style="--background-image:url(…)"`.
      const walkNode = (node: JxNode): void => {
        if (typeof node === "string") return;
        if (node.style) declare(node.style);
        if (Array.isArray(node.children)) node.children.forEach(walkNode);
      };
      for (const post of f.model.posts.values()) {
        walkBlocks(parseBlocks(post.content), (block) => {
          if (block.innerHTML.includes("--")) htmlToNodes(block.innerHTML).forEach(walkNode);
        });
      }
      const undeclared = sorted(used.keys()).filter((name) => !declared.has(name));
      // ap's `cc-global-classes.css` styles `.query-container .filter-container` with
      // `var(--cc-color-8)`, and the palette it was copied from had eight colours where ap has six.
      expect(undeclared).toEqual(site === "ap" ? ["--cc-color-8"] : []);
      note(`custom properties: ${used.size} read, undeclared ${JSON.stringify(undeclared)}`);
    });

    // ── options ↔ blocks ↔ css: global classes ──

    test("every global class has a rule in the stylesheets, or carries no style of its own", () => {
      const served = f.sheets.get("cc-global-classes.css");
      expect(served).toBeDefined();
      const { globalClassNames: names, globalClassAttrs: attrs } = f.options;
      expect(sorted(names.keys())).toEqual(sorted(attrs.keys()));
      // What a global class carries when nothing is set: the editor's defaults, and a link target.
      const NEUTRAL = new Set([
        "classID",
        "fontGlobalStyle",
        "fontLocation",
        "backgroundType",
        "backgroundImageType",
      ]);
      const emptyList = (value: unknown): boolean => Array.isArray(value) && value.length === 0;
      const unstyled: string[] = [];
      const inOther: string[] = [];
      for (const [id, name] of names) {
        if (served !== undefined && hasRule(served, name)) {
          if (!served.index.classes.has(name)) inOther.push(name);
          continue;
        }
        const own = Object.entries(attrs.get(id) ?? {}).filter(
          ([key, value]) =>
            !NEUTRAL.has(key) &&
            !key.startsWith("linkWrapper") &&
            !((key === "relativeStyles" || key === "htmlAttributes") && emptyList(value)),
        );
        expect({ name, declares: own.map(([key]) => key) }).toEqual({ name, declares: [] });
        unstyled.push(name);
      }
      expect(sorted(unstyled)).toEqual(
        site === "fineline"
          ? [
              "Steps",
              "card-design",
              "roundish-image",
              "roundish-image-column",
              "step-style",
              "steps-div",
            ]
          : ["block-link"],
      );
      expect(inOther).toEqual(
        site === "ap"
          ? ["relevanssi-live-search-results.relevanssi-live-search-results-showing"]
          : [],
      );
      // The other way: the served file has no class rule that no global class names.
      const named = new Set(names.values());
      expect(
        sorted([...(served?.index.classes.keys() ?? [])].filter((name) => !named.has(name))),
      ).toEqual([]);
      note(
        `global classes: ${names.size}, with a rule ${names.size - unstyled.length}, unstyled ${unstyled.length}, filed under other ${inOther.length}`,
      );
    });

    test("every global class id a block names exists, except the one fineline deleted, which the options report knows", () => {
      const dangling = new Map<
        string,
        { blocks: number; posts: Set<number>; statuses: Set<string> }
      >();
      let references = 0;
      for (const post of f.model.posts.values()) {
        walkBlocks(parseBlocks(post.content), (block) => {
          const ids = block.attrs["globalClass"];
          if (!Array.isArray(ids)) return;
          for (const id of ids.map(String)) {
            references += 1;
            if (f.options.globalClassNames.has(id)) continue;
            const entry = dangling.get(id) ?? { blocks: 0, posts: new Set(), statuses: new Set() };
            entry.blocks += 1;
            entry.posts.add(post.id);
            entry.statuses.add(post.status);
            dangling.set(id, entry);
          }
        });
      }
      const summary = Object.fromEntries(
        [...dangling].map(([id, e]) => [
          id,
          { blocks: e.blocks, posts: e.posts.size, statuses: sorted(e.statuses) },
        ]),
      );
      // Every reference is in a draft page: published content never names a deleted class.
      expect(summary).toEqual(
        site === "fineline"
          ? { "3yEPq5XEDBJoOaj": { blocks: 31, posts: 16, statuses: ["draft"] } }
          : {},
      );
      const orphaned = f.optionsReport
        .entries()
        .filter((entry) => entry.code === "option.stale")
        .flatMap((entry) => (entry.data?.["orphaned"] as string[] | undefined) ?? []);
      for (const id of dangling.keys()) expect(orphaned).toContain(id);
      note(`global class references: ${references}, dangling ids ${JSON.stringify(summary)}`);
    });

    // ── blocks ↔ css: the ratio ──

    test("every block classID resolves to a rule or is accounted for; the rest are counted and reported", async () => {
      const counts: Record<Bucket, number> = {
        styled: 0,
        placeholder: 0,
        unstyled: 0,
        noSheet: 0,
        stale: 0,
      };
      const distinct = new Map<string, Bucket>();
      const stale: { classID: string; where: string; block: string; post: WpPost | undefined }[] =
        [];
      const source = fixtureCssSource(site);
      const palette = [...f.options.globalStyles.colorRefs.values()];
      let onlyElsewhere = 0;
      let total = 0;
      let loading = 0;
      for (const tree of f.trees) {
        // The index a converter gets for this subject: the stylesheets its page loads, and no others.
        const begin = performance.now();
        const own = sheetOf(
          await loadCssIndex(source, tree.sheets, f.options.breakpoints, { palette }),
          "",
        );
        loading += performance.now() - begin;
        walkBlocks(tree.blocks, (block) => {
          const classID = block.attrs["classID"];
          if (typeof classID !== "string" || classID === "") return;
          total += 1;
          let bucket: Bucket;
          if (hasRule(f.merged, classID)) {
            bucket = "styled";
            // The rule exists, but not in the subject's own index: only another subject's stylesheet has it.
            if (!hasRule(own, classID)) onlyElsewhere += 1;
          } else if (isMentioned(f.merged, classID)) {
            bucket = "placeholder";
          } else if (block.attrs["isStyling"] !== true) {
            bucket = "unstyled";
          } else if (f.css.has(tree.own)) {
            bucket = "stale";
            stale.push({
              classID,
              where: tree.where,
              block: block.name ?? "",
              post: subjectPost(f.loaded, tree.subject),
            });
          } else {
            bucket = "noSheet";
          }
          counts[bucket] += 1;
          distinct.set(classID, bucket);
        });
      }
      f.ms["cssPerSubject"] = loading;
      expect(total).toBe(Object.values(counts).reduce((a, b) => a + b, 0));
      expect(counts).toEqual(CENSUS[site].blocks);
      expect(onlyElsewhere).toBe(CENSUS[site].onlyElsewhere);

      // The unresolved ones are reported through the report module, one entry per block.
      const report = createReport();
      for (const entry of stale) {
        const url = entry.post === undefined ? undefined : publicUrl(f.model.site, entry.post);
        report.add({
          severity: "warn",
          code: "class.unresolved",
          message: "The block claims styles and no stylesheet has a rule for its class.",
          where: entry.where,
          ...(url === undefined ? {} : { url }),
          data: { classID: entry.classID, block: entry.block },
        });
      }
      expect(report.entries()).toHaveLength(counts.stale);
      expect(renderReportMarkdown(report.entries(), { site: f.model.site.url })).toContain(
        "class.unresolved",
      );

      const resolved = counts.styled + counts.placeholder + counts.unstyled + counts.noSheet;
      const byClass = { styled: 0, placeholder: 0, unstyled: 0, noSheet: 0, stale: 0 };
      for (const bucket of distinct.values()) byClass[bucket] += 1;
      note(
        `classID census: ${total} blocks, ${distinct.size} distinct classIDs; ` +
          `resolved or accounted for ${resolved} (${pct(resolved, total)}), stale ${counts.stale} (${pct(counts.stale, total)})`,
      );
      note(
        `  by block: ${JSON.stringify(counts)}; styled only by another subject's stylesheet: ${onlyElsewhere}`,
      );
      note(`  by distinct classID (last bucket wins): ${JSON.stringify(byClass)}`);
      const where = new Map<string, number>();
      for (const entry of stale) where.set(entry.where, (where.get(entry.where) ?? 0) + 1);
      note(`  stale in: ${[...where].map(([key, n]) => `${key} x${n}`).join(", ")}`);
      note(`  one index per subject: ${f.trees.length} subjects in ${fixed(loading)} ms`);
    }, 60_000);

    test("every block classID a rendered page prints has a rule in the stylesheets that page links, bar the pinned exceptions", () => {
      const ids = new Set<string>();
      for (const tree of f.trees) {
        walkBlocks(tree.blocks, (block) => {
          const classID = block.attrs["classID"];
          if (typeof classID === "string" && classID !== "") ids.add(classID);
        });
      }
      const directory = join(fixtureDir(site), "html");
      const unruled: string[] = [];
      let printed = 0;
      for (const file of readdirSync(directory).toSorted()) {
        const html = readFileSync(join(directory, file), "utf8");
        // What the page loads decides which rules apply to it, so the page's own links are the index.
        const linked = Array.from(
          html.matchAll(/<link[^>]+href=['"][^'"]*\/uploads\/cwicly\/(?:css\/)?(cc-[^?'"]+)[?'"]/g),
          (match) => match[1] ?? "",
        );
        const tokens = new Set<string>();
        for (const match of html.matchAll(/\sclass=["']([^"']*)["']/g)) {
          for (const token of (match[1] ?? "").split(/\s+/)) if (ids.has(token)) tokens.add(token);
        }
        for (const token of sorted(tokens)) {
          printed += 1;
          const ruled = linked.some((name) => {
            const sheet = f.sheets.get(name);
            return sheet !== undefined && hasRule(sheet, token);
          });
          if (!ruled) unruled.push(`${file}: ${token}`);
        }
      }
      expect(printed).toBeGreaterThan(400);
      // The block classIDs a live page prints are styled by that page's own stylesheets, with two
      // exceptions in ap: `section-c3bb97a` (a stale block: no stylesheet anywhere has a rule for it, so
      // the live site prints it unstyled, and there is nothing to carry over but the name) and
      // `query-episodes`, which the posts page styles only through descendant selectors under
      // `.query-container` (its own rule there is an empty placeholder).
      expect(unruled).toEqual(
        site === "ap"
          ? [
              "essays.html: query-episodes",
              "essays__get-in-the-way-of-evil.html: section-c3bb97a",
              "essays__keeshons-story-a-knock-heard-round-the-hood-part-3.html: section-c3bb97a",
              "essays__the-cultural-captivity-of-the-gospel.html: section-c3bb97a",
              "essays__the-essence-of-anabaptism-dean-taylor.html: section-c3bb97a",
              "essays__the-way-we-live-is-the-way-we-educate.html: section-c3bb97a",
            ]
          : [],
      );
      note(
        `rendered pages: ${printed} (page, block classID) pairs printed, ${printed - unruled.length} ruled by the page's own stylesheets`,
      );
    });

    test("one class name carries different declarations in different stylesheets, so a merged index is not a page's index", () => {
      const styles = new Map<string, Set<string>>();
      for (const sheet of f.sheets.values()) {
        for (const [name, entry] of sheet.index.classes) {
          const set = styles.get(name) ?? new Set<string>();
          set.add(JSON.stringify(entry.style));
          styles.set(name, set);
        }
      }
      const conflicting = [...styles].filter(([, set]) => set.size > 1).length;
      // The merge picks the later file's declarations for these, which is why the converter builds one
      // index per subject (`cssNamesFor`) and not one per site.
      expect(conflicting).toBe(site === "fineline" ? 167 : 65);
      note(
        `classes whose declarations differ between stylesheets: ${conflicting} of ${styles.size}`,
      );
    });

    // ── ingest ids ↔ stylesheets ──

    test("every component, part, reusable block and menu a tree embeds exists, and has a stylesheet where it should, bar the pinned gaps", () => {
      const components = componentsOf(f.model);
      const theme = f.model.site.theme;
      const gaps = new Set<string>();
      let references = 0;
      for (const tree of f.trees) {
        walkBlocks(tree.blocks, (block) => {
          const ref = block.attrs["ref"];
          if (block.name === "cwicly/component") {
            references += 1;
            if (typeof ref !== "string") gaps.add("component: no ref");
            else if (!components.has(ref)) gaps.add(`component ${ref}: no cc_block`);
            else if (!f.css.has(`cc-cm-${ref}.css`)) gaps.add(`component ${ref}: no stylesheet`);
          } else if (block.name === "core/block") {
            references += 1;
            if (typeof ref !== "number" || f.model.posts.get(ref)?.type !== "wp_block") {
              gaps.add(`reusable ${String(ref)}: no wp_block`);
            } else if (!f.css.has(`cc-rb-${ref}.css`)) gaps.add(`reusable ${ref}: no stylesheet`);
          } else if (block.name === "cwicly/menu") {
            references += 1;
            const selected = block.attrs["menuSelected"];
            const term = f.model.terms.get(Number(selected));
            if (term?.taxonomy !== "nav_menu") {
              gaps.add(`menu ${String(selected)}: no nav_menu`);
            } else if (!f.model.menuItems.some((item) => item.menuTermId === term.termId)) {
              gaps.add(`menu ${term.slug}: no items`);
            }
          } else if (block.name === "core/template-part") {
            references += 1;
            const slug = String(block.attrs["slug"]);
            const owner = typeof block.attrs["theme"] === "string" ? block.attrs["theme"] : theme;
            const part = [...f.model.posts.values()].find(
              (p) => p.type === "wp_template_part" && p.slug === slug && p.status === "publish",
            );
            if (part === undefined) gaps.add(`part ${slug}: no wp_template_part`);
            else if (!f.css.has(`cc-tp-${owner}_${slug}.css`))
              gaps.add(`part ${slug}: no stylesheet`);
          }
        });
      }
      // Every one is the data's, not the readers': a block with no `ref`, a reusable block deleted from
      // the site, and stylesheets the sampled public pages did not load (the live site serves them).
      expect(sorted(gaps)).toEqual(
        site === "fineline"
          ? ["component: no ref", "part header-updated-menu: no stylesheet"]
          : [
              "component 72e2776ca3: no stylesheet",
              "reusable 1459: no wp_block",
              "reusable 1478: no stylesheet",
            ],
      );
      note(`embedded references: ${references}, gaps ${JSON.stringify(sorted(gaps))}`);
    });

    // ── ingest ↔ html ──

    test("htmlToNodes accepts the innerHTML of every block, and what it returns is valid Jx", async () => {
      const posts: { id: number; blocks: WpBlock[] }[] = [];
      for (const post of f.model.posts.values()) {
        if (post.content !== "") posts.push({ id: post.id, blocks: parseBlocks(post.content) });
      }
      const report = createReport();
      const nodes: JxNode[] = [];
      const threw: string[] = [];
      const wrongTag: string[] = [];
      const alignment = { first: 0, later: 0, absent: 0 };
      const notScopeClasses: string[] = [];
      const globals = { named: 0, unnamed: 0, disagree: [] as string[] };
      // Blocks whose saved markup prints another block-shaped class than the `classID` attribute names.
      const stray = { blocks: 0, ruled: 0 };
      let withMarkup = 0;
      let blocks = 0;
      const start = performance.now();
      for (const { id, blocks: tree } of posts) {
        walkBlocks(tree, (block) => {
          blocks += 1;
          if (block.innerHTML.trim() === "") return;
          withMarkup += 1;
          let out: JxNode[];
          try {
            out = htmlToNodes(block.innerHTML, { report, where: `post:${id}` });
          } catch (error) {
            threw.push(`post:${id} ${block.name}: ${(error as Error).message}`);
            return;
          }
          nodes.push(...out);
          const root = out.find((node) => typeof node !== "string");
          const opening = /^\s*<([A-Za-z][A-Za-z0-9-]*)/.exec(block.innerHTML)?.[1];
          if (opening !== undefined && root !== undefined && typeof root !== "string") {
            if (root.tagName !== opening.toLowerCase()) wrongTag.push(`post:${id} ${block.name}`);
          }
          // Cwicly's `{gcl}` token stands for the names of the block's global classes: it is in the saved
          // markup exactly when the block names some, so the names come from the options, by id.
          if (block.name?.startsWith("cwicly/")) {
            const ids = block.attrs["globalClass"];
            const names = Array.isArray(ids) && ids.length > 0;
            if (block.innerHTML.includes("{gcl}") !== names)
              globals.disagree.push(`post:${id} ${block.name}`);
            else if (names) globals.named += 1;
            else globals.unnamed += 1;
          }
          const classID = block.attrs["classID"];
          if (
            typeof classID === "string" &&
            classID !== "" &&
            root !== undefined &&
            typeof root !== "string"
          ) {
            const words = (root.className ?? "").split(/\s+/).filter((word) => word !== "");
            if (words[0] === classID) {
              alignment.first += 1;
            } else if (words.includes(classID)) {
              alignment.later += 1;
              // What stands in front of it is the first class `scopeStyle` gives an element with an inline style.
              for (const word of words.slice(0, words.indexOf(classID))) {
                if (!/^jx-[0-9a-f]{10}$/.test(word))
                  notScopeClasses.push(`post:${id} ${block.name}: ${word}`);
              }
            } else {
              alignment.absent += 1;
              const other = words.filter((word) => BLOCK_CLASS.test(word));
              if (other.length > 0) {
                stray.blocks += 1;
                if (other.every((word) => hasRule(f.merged, word))) stray.ruled += 1;
              }
            }
          }
        });
      }
      f.ms["htmlToNodes"] = performance.now() - start;
      expect(threw).toEqual([]);
      expect(wrongTag).toEqual([]);
      expect(globals.disagree).toEqual([]);
      expect(notScopeClasses).toEqual([]);
      expect(report.entries().filter((entry) => entry.severity === "error")).toEqual([]);

      const validated = performance.now();
      const verdict = await validateDocument({ tagName: "div", children: nodes });
      f.ms["validate"] = performance.now() - validated;
      expect(verdict.errors ?? []).toEqual([]);
      expect(verdict.valid).toBe(true);

      note(
        `html: ${blocks} blocks, ${withMarkup} with markup, ${nodes.length} nodes, ${report.entries().length} report entries`,
      );
      // The saved opening tag is where the live class list comes from, and a block's `classID` attribute is
      // not always in it (an unstyled block's class is left out; an image in a lightbox carries it on the
      // `<img>` under an `<a>`; a component prints its own markup). The CSS belongs to the class on the
      // element, so a converter reads the class from the markup and the rule from the stylesheet. Where it
      // is not the first class, `scopeStyle` put a generated one in front of it, and the design wants the
      // classID first (a `jx-` class takes the element's own style, which is correct, but the rule for
      // `.classID` then has to be merged into that style rather than emitted under the classID).
      note(
        `  classID as the root's first class ${alignment.first}, after a scope class ${alignment.later}, not in the root's classes ${alignment.absent}`,
      );
      note(
        `  {gcl} in the markup exactly when globalClass names classes: ${globals.named} blocks with, ${globals.unnamed} without`,
      );
      // A few blocks print another block's class (a duplicate that kept the markup of the original): the
      // live page shows that class, so its rule, not the attribute's, is the block's style.
      note(
        `  markup prints another block class than the attribute: ${stray.blocks} blocks, ${stray.ruled} with a rule`,
      );
      expect(stray).toEqual(
        site === "fineline" ? { blocks: 0, ruled: 0 } : { blocks: 33, ruled: 33 },
      );
      expect(alignment).toEqual(
        site === "fineline"
          ? { first: 7142, later: 1, absent: 370 }
          : { first: 624, later: 11, absent: 387 },
      );
    }, 120_000);

    // ── report ↔ everything ──

    test("every module's findings are valid report entries that render, in the design's code format", () => {
      const entries: ReportEntry[] = [
        ...f.modelReport.entries(),
        ...f.optionsReport.entries(),
        // CSS artifacts are not report entries; this is the conversion a driver has to make.
        ...f.index.artifacts.map((artifact): ReportEntry => ({
          severity: "warn",
          code: artifact.code,
          message: artifact.detail,
          ...(artifact.file === undefined ? {} : { where: `css:${artifact.file}` }),
          data: artifact.selector === undefined ? {} : { selector: artifact.selector },
        })),
      ];
      const sink = createReport();
      for (const entry of entries) sink.add(entry);
      for (const entry of entries) {
        expect(entry.code).toMatch(/^[a-z]+\.[a-z0-9]+(?:-[a-z0-9]+)*$/);
        if (entry.where !== undefined) expect(entry.where).toMatch(/^[a-z]+:\S/);
      }
      const markdown = renderReportMarkdown(sink.entries(), { site: f.model.site.url });
      const json = JSON.parse(renderReportJson(sink.entries())) as {
        summary: { total: number };
        entries: unknown[];
      };
      expect(json.summary.total).toBe(entries.length);
      expect(json.entries).toHaveLength(entries.length);
      expect(summarise(entries).total).toBe(entries.length);
      for (const code of new Set(entries.map((entry) => entry.code)))
        expect(markdown).toContain(code);
      note(
        `report: ${entries.length} entries from model, options and css, ${markdown.length} bytes of markdown`,
      );
    });

    // ── cost ──

    test("loading a whole site is fast, and the CSS reader is not quadratic in what it is given", () => {
      const ms = f.ms;
      // Measured at about 100 ms and 250 ms; the budgets are 50 times that, so a machine under load
      // does not fail them and a quadratic reader does.
      expect(ms["loadModel"]).toBeLessThan(5000);
      expect(ms["readOptions"]).toBeLessThan(1000);
      expect(ms["css"]).toBeLessThan(10_000);
      // Reading the files one at a time costs about what reading them together does.
      expect(ms["cssOneByOne"]).toBeLessThan(10_000);
    });
  });
}

// ── Seams the fixtures cannot show ───────────────────────────────────────────────────────────────

describe("foundations: what the fixtures lack", () => {
  test("a breakpoint listed before the main one is a min-width query in `$media`, in the CSS reader and in the layout order", () => {
    const options = readCwiclyOptions(
      new Map([
        [
          "cwicly_breakpoints_list",
          JSON.stringify({
            xl: { width: 1920 },
            lg: { width: 1366, isMain: true },
            md: { width: 992 },
            sm: { width: 576 },
          }),
        ],
      ]),
    );
    expect(options.breakpoints.map((bp) => `${bp.key}:${bp.direction}`)).toEqual([
      "xl:min",
      "lg:none",
      "md:max",
      "sm:max",
    ]);
    expect(options.media).toEqual({
      "--xl": "(min-width: 1920px)",
      "--": "1366px",
      "--md": "(max-width: 992px)",
      "--sm": "(max-width: 576px)",
    });
    const css =
      ".a{color:red}" +
      "@media screen and (min-width: 1920px){.a{color:green}}" +
      "@media screen and (max-width: 992px){.a{color:blue}}" +
      "@media screen and (max-width:576px){.a{color:black}}";
    const index = parseCwiclyCss(css, options.breakpoints);
    expect(index.artifacts).toEqual([]);
    const keys = Object.keys(index.classes.get("a")?.style ?? {}).filter((key) =>
      key.startsWith("@"),
    );
    expect(keys).toEqual(["@--xl", "@--md", "@--sm"]);
    for (const key of keys) expect(options.media).toHaveProperty([key.slice(1)]);
    const [layout] = projectStyles(index, options.breakpoints);
    expect(Object.keys(layout ?? {}).filter((key) => key.startsWith("@"))).toEqual(keys);
  });

  test("the CSS reader resolves a shade or variant `!var=` only when given the palette's colorRefs, not its colors", () => {
    const shades = Array.from({ length: 11 }, (_, step) => ({
      id: `sh${String(step).padStart(3, "0")}`,
    }));
    const options = readCwiclyOptions(
      new Map([
        [
          "cwicly_global_styles",
          JSON.stringify({
            activeStyle: "style1",
            styles: {
              style1: {
                name: "Style 1",
                colors: [
                  {
                    id: "abc12",
                    name: "Blue",
                    color: "#0000ff",
                    variable: "cc-color-1",
                    paletteState: "true",
                    paletteColors: shades,
                    dynamic: { lighten: [{ id: "lt10x", value: "10" }] },
                  },
                ],
              },
            },
          }),
        ],
      ]),
    );
    const css = ".a{color:!var=abc12!;background:!var=sh005!;border-color:!var=lt10x!}";
    // The list src/types.ts offers converters has the colour, and says the shade does not exist.
    const fromColors = parseCwiclyCss(css, options.breakpoints, {
      palette: options.globalStyles.colors,
    });
    expect(fromColors.classes.get("a")?.style).toEqual({ color: "var(--cc-color-1)" });
    expect(fromColors.artifacts.map((artifact) => artifact.code)).toEqual([
      CSS_ARTIFACT.unresolvedPaletteVar,
      CSS_ARTIFACT.unresolvedPaletteVar,
    ]);
    // `colorRefs` is the palette the options module itself resolves with, and the reader agrees with it.
    const palette = [...options.globalStyles.colorRefs.values()];
    const fromRefs = parseCwiclyCss(css, options.breakpoints, { palette });
    expect(fromRefs.artifacts).toEqual([]);
    expect(fromRefs.classes.get("a")?.style).toEqual({
      color: "var(--cc-color-1)",
      background: "var(--cc-color-1-500)",
      borderColor: "var(--cc-color-1-lt-10)",
    });
    const viaOptions = resolvePaletteRefs(css, options.globalStyles.colorRefs);
    expect(viaOptions.unresolved).toEqual([]);
    expect(viaOptions.text).toBe(
      ".a{color:var(--cc-color-1);background:var(--cc-color-1-500);border-color:var(--cc-color-1-lt-10)}",
    );
  });

  test("css.ts and jx-util.ts write the same Jx key for every property the sites use, and the runtime inverts it", async () => {
    const properties = new Set<string>();
    for (const site of FIXTURE_SITES) {
      const { css, trees } = await foundations(site);
      for (const text of css.values()) {
        for (const match of text.matchAll(/[{;]\s*([a-zA-Z-][\w-]*)\s*:/g))
          properties.add(match[1] ?? "");
      }
      for (const tree of trees) {
        walkBlocks(tree.blocks, (block) => {
          for (const match of block.innerHTML.matchAll(/\sstyle=(?:"([^"]*)"|'([^']*)')/g)) {
            for (const declaration of (match[1] ?? match[2] ?? "").split(";")) {
              const name = declaration.split(":")[0]?.trim();
              if (name) properties.add(name);
            }
          }
        });
      }
    }
    expect(properties.size).toBeGreaterThan(100);
    const disagree: string[] = [];
    for (const property of properties) {
      const custom = property.startsWith("--");
      const lower = custom ? property : property.toLowerCase();
      const key = jxStyleKey(property);
      if (key !== kebabToCamel(lower) || key === null || cssPropertyName(key) !== lower)
        disagree.push(property);
    }
    expect(disagree).toEqual([]);
  });
});
