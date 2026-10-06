/**
 * emit/components.ts against the real fixture sites: every `cc_block` of fineline and
 * anabaptistperspectives becomes a Jx component, the components are validated and built with the
 * installed `jx`, their stylesheets are held to the stylesheets Cwicly generated for them
 * (`cc-cm-<reference>.css`), every instance of every post is held to the component it names, and the
 * built markup is held against the rendered live pages (the ground truth). The paths the fixtures do
 * not reach (slots, variant groups, properties that become CSS, cycles, a classID two components share)
 * run on hand-made components over the real site.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHtml } from "hast-util-from-html";
import { convertSubject } from "../../src/convert.ts";
import * as components from "../../src/emit/components.ts";
import { buildCollections } from "../../src/emit/collections.ts";
import {
  ancestorVariantKey,
  buildComponentDocument,
  buildComponents,
  componentFile,
  misplacedBindings,
  relativeRef,
  switchVariants,
  type ComponentsOutput,
} from "../../src/emit/components.ts";
import { walkElements } from "../../src/placeholders.ts";
import { createReport } from "../../src/report.ts";
import { componentInfos, type SiteContext, type Subject } from "../../src/site.ts";
import type { JxDocument, JxElement, JxNode, WpPost } from "../../src/types.ts";
import { walkBlocks } from "../../src/wp/blocks.ts";
import { canonicalCss, canonicalDiff } from "../helpers/css-oracle.ts";
import { allSubjects, loadSite, makeCtx, subjectBlocks, type LoadedSite } from "../helpers/ctx.ts";
import { fixtureDir } from "../helpers/fixture-db.ts";
import { pilotForms } from "../helpers/fluentform-db.ts";
import { readFixtureCss } from "../helpers/fixture-css.ts";
import {
  buildJxProject,
  cleanupJxProjects,
  validateJxProject,
  type BuiltProject,
  type ProjectFile,
} from "../helpers/jx-build.ts";

setDefaultTimeout(180_000);
afterAll(cleanupJxProjects);

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
type SiteName = "fineline" | "ap";
const SITES: SiteName[] = ["fineline", "ap"];

const codes = (report: { entries(): readonly { code: string }[] }): string[] =>
  report.entries().map((e) => e.code);

const docOf = (out: ComponentsOutput, tag: string): Rec =>
  JSON.parse(out.files.find((f) => f.path === componentFile(tag))!.content) as Rec;

/** The project every build below is: the components, a page that instantiates what it is given, the site's breakpoints. */
function projectFiles(
  site: SiteContext,
  out: ComponentsOutput,
  pages: Record<string, JxNode[]>,
  extra: Record<string, ProjectFile> = {},
): Record<string, ProjectFile> {
  const files: Record<string, ProjectFile> = {};
  for (const file of out.files) files[file.path] = file.content;
  files["project.json"] = {
    name: "components-test",
    url: "https://example.com",
    $media: site.options.media,
    defaults: { layout: "./layouts/base.json" },
  };
  files["layouts/base.json"] = { tagName: "div", children: [{ tagName: "slot" }] };
  for (const [name, children] of Object.entries(pages)) {
    files[`pages/${name}.json`] = {
      title: name,
      $elements: out.components.map((c) => ({ $ref: `../${c.file}` })),
      children,
    };
  }
  return { ...files, ...extra };
}

type Hast = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Hast[];
};

function findAll(node: Hast, test: (el: Hast) => boolean, out: Hast[] = []): Hast[] {
  if (node.type === "element" && test(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, test, out);
  return out;
}
const elementKids = (el: Hast): Hast[] => (el.children ?? []).filter((c) => c.type === "element");
const classesOf = (el: Hast): string[] =>
  Array.isArray(el.properties?.className) ? (el.properties.className as unknown[]).map(String) : [];
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
function textOf(el: Hast): string {
  return (el.children ?? [])
    .map((c) => (c.type === "text" ? (c.value ?? "") : c.type === "element" ? textOf(c) : ""))
    .join("");
}

/** What an element compares as: tag, classes, attributes, text. Attributes and classes the two sides legitimately differ in are dropped by the caller. */
function attrsOf(el: Hast, ignore: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.properties ?? {})) {
    if (ignore.has(k)) continue;
    out[k] = Array.isArray(v) ? v.join(" ") : String(v);
  }
  return out;
}

const BUILT_IGNORE = new Set(["className", "dataJxStatic", "loading", "decoding"]);
const LIVE_IGNORE = new Set([
  "className",
  "dataCcComp",
  "loading",
  "decoding",
  "srcSet",
  "sizes",
  "style",
]);

/** What a comparison leaves out: attributes, and the text (where the fixtures' database and live pages are two snapshots). */
interface Loose {
  attrs: ReadonlySet<string>;
  text: boolean;
}

/**
 * One built element against the live one it stands for, as a list of differences. The live element's
 * `cs-<variant>` classes are the host's in the build, so they are not compared here.
 */
function compareElement(
  built: Hast,
  live: Hast,
  path: string,
  site: SiteContext,
  into: string[],
  loose?: Loose,
): void {
  if (built.tagName !== live.tagName) {
    into.push(`${path}: tag ${built.tagName} vs live ${live.tagName}`);
    return;
  }
  const bc = classesOf(built);
  const lc = classesOf(live).filter((c) => !c.startsWith("cs-"));
  if (bc.join(" ") !== lc.join(" "))
    into.push(`${path}: class [${bc.join(" ")}] vs live [${lc.join(" ")}]`);
  const ba = attrsOf(built, BUILT_IGNORE);
  const la = attrsOf(live, LIVE_IGNORE);
  for (const key of new Set([...Object.keys(ba), ...Object.keys(la)])) {
    let lv = la[key];
    const bv = ba[key];
    if (key === "src" && lv !== undefined) lv = site.media.mediaForUrl(lv)?.src ?? lv;
    if (key === "href" && lv !== undefined) {
      for (const origin of [site.model.site.url, site.model.site.home]) {
        if (lv === origin || lv.startsWith(`${origin}/`)) lv = lv.slice(origin.length) || "/";
      }
    }
    if (key === "href" && (lv === "" || lv === undefined) && bv === undefined) continue;
    if (key === "target" && lv === "_self" && bv === undefined) continue;
    if (loose?.attrs.has(key)) continue;
    if (bv !== lv) into.push(`${path}: ${key} ${JSON.stringify(bv)} vs live ${JSON.stringify(lv)}`);
  }
  if (built.tagName === "svg") return;
  const bk = elementKids(built);
  let lk = elementKids(live);
  if (bk.length !== lk.length) {
    into.push(`${path}: ${bk.length} children vs live ${lk.length}`);
    // The one element the build leaves out is an `<img>` that names no file (the image converter drops
    // an image block with no source, where the plugin prints the empty element). Without it the rest is
    // still compared, so a text or attribute difference below an element whose count differs is seen.
    const kept = lk.filter(
      (child) => child.tagName !== "img" || child.properties?.src !== undefined,
    );
    if (kept.length !== bk.length) return;
    lk = kept;
  }
  bk.forEach((child, i) =>
    compareElement(child, lk[i]!, `${path}/${child.tagName}[${i}]`, site, into, loose),
  );
  if (
    loose?.text !== true &&
    bk.length === 0 &&
    collapse(textOf(built)) !== collapse(textOf(live))
  ) {
    into.push(
      `${path}: text ${JSON.stringify(collapse(textOf(built)).slice(0, 60))} vs live ${JSON.stringify(collapse(textOf(live)).slice(0, 60))}`,
    );
  }
}

/** The instances (elements of a component tag) of converted nodes, outermost only, in order. */
function instancesIn(nodes: readonly JxNode[], tags: ReadonlySet<string>): JxElement[] {
  const found: JxElement[] = [];
  const inside = new Set<JxElement>();
  for (const element of walkElements(nodes)) {
    if (inside.has(element)) continue;
    if (tags.has(element.tagName as string)) {
      found.push(element);
      for (const inner of walkElements([element])) inside.add(inner);
    }
  }
  return found;
}

// ── Hand-made components over a real site ────────────────────────────────────────────────────────

interface Synthetic {
  id: number;
  /** `cc_block` unless said (a page to hold instances). */
  type?: string;
  ref: string;
  slug: string;
  title: string;
  content: string;
  meta?: Record<string, unknown>;
  css?: string;
  status?: string;
}

/** The real site with more `cc_block` posts (and their stylesheets) added. */
function extend(site: LoadedSite, comps: Synthetic[]): LoadedSite {
  const posts = new Map(site.model.posts);
  const postMeta = new Map(site.model.postMeta);
  const css: Record<string, string> = {};
  for (const c of comps) {
    const post: WpPost = {
      id: c.id,
      type: c.type ?? "cc_block",
      status: c.status ?? "publish",
      slug: c.slug,
      title: c.title,
      content: c.content,
      excerpt: "",
      date: "2024-01-01T00:00:00Z",
      modified: "2024-01-01T00:00:00Z",
      parent: 0,
      menuOrder: 0,
      authorId: 1,
      guid: "",
      passwordProtected: false,
    };
    posts.set(c.id, post);
    postMeta.set(
      c.id,
      Object.fromEntries(
        Object.entries(
          c.type === undefined || c.type === "cc_block"
            ? { reference: c.ref, ...c.meta }
            : { ...c.meta },
        ).map(([k, v]) => [k, [v]]),
      ) as Record<string, unknown[]>,
    );
    if (c.css !== undefined)
      css[
        c.type === undefined || c.type === "cc_block" ? `cc-cm-${c.ref}.css` : `cc-post-${c.id}.css`
      ] = c.css;
  }
  const model = { ...site.model, posts, postMeta };
  return {
    ...site,
    model,
    components: componentInfos(model, site.componentPrefix),
    cssSource: { get: async (name) => css[name] ?? site.cssSource.get(name) },
  };
}

const json = (v: unknown): string => JSON.stringify(v);

/** A `cwicly/div` of a component: its saved tag prints the classID and `{cs-index}`, as the real ones do. */
const div = (ref: string, classID: string, inner = ""): string =>
  `<!-- wp:cwicly/div ${json({ isComponentChild: ref, isStyling: true, classID, uniqueID: classID })} -->\n<div class="${classID}{cs-index}">${inner}</div>\n<!-- /wp:cwicly/div -->`;

const heading = (ref: string, classID: string, prop: string): string =>
  `<!-- wp:cwicly/heading ${json({ componentConnectors: { content: { ref: prop } }, isComponentChild: ref, isStyling: true, headingTag: "h3", classID, uniqueID: classID })} -->\n<h3 class="${classID}{cs-index}">{component=content=${prop}}</h3>\n<!-- /wp:cwicly/heading -->`;

const instance = (ref: string, attrs: Rec = {}): string =>
  `<!-- wp:cwicly/component ${json({ ref, classID: `component-${ref}`, uniqueID: `component-${ref}`, ...attrs })} /-->`;

const innerblocks = (ref: string, classID: string): string =>
  `<!-- wp:cwicly/innerblocks ${json({ isComponentChild: ref, isStyling: true, classID, uniqueID: classID })} -->\n<div class="${classID}{cs-index}"></div>\n<!-- /wp:cwicly/innerblocks -->`;

/**
 * The seven component roots of the live page https://finelinepainting.pro/project/interior-painting-for-new-construction-in-potter-county/
 * (post 1377), as the server printed them (the srcset and sizes attributes, which the build
 * regenerates, and the SVG paths removed): three Icon Cards, four Image cards.
 */
const LIVE_PROJECT_1377 = `<div class="div-cf3ac5e cs-bmuh8n" data-cc-comp="component-cc4f676">
<img class="image-cf6348e cs-bmuh8n">
<h3 class="heading-cc0e8b0 cs-bmuh8n">Lovely Appearance</h3>
<p class="paragraph-c5200ff cs-bmuh8n">Sometimes we want to change the appearance of our homes but lack inspiration. With a fresh coat of paint, you can completely change the aesthetic and vibe of your home without spending a fortune. </p>
<a class="button-cb319fb cs-bmuh8n button-default" href=""></a>
</div>
<div class="div-cf3ac5e cs-bmuh8n" data-cc-comp="component-cf156a5">
<img class="image-cf6348e cs-bmuh8n">
<h3 class="heading-cc0e8b0 cs-bmuh8n">Greater Protection</h3>
<p class="paragraph-c5200ff cs-bmuh8n">You can’t deny that many things wear on the quality of your home. From a child’s constant soccer playing to oil messes caused by cooking to the general wear of life, a coat of fresh paint creates a barrier of protection.</p>
<a class="button-cb319fb cs-bmuh8n button-default" href=""></a>
</div>
<div class="div-cf3ac5e cs-bmuh8n" data-cc-comp="component-cfe3fe0">
<img class="image-cf6348e cs-bmuh8n">
<h3 class="heading-cc0e8b0 cs-bmuh8n">Increased Value </h3>
<p class="paragraph-c5200ff cs-bmuh8n">A new layer of paint enhances your home’s market value. It not only elevates its appearance but also indicates to prospective buyers that the property has been well cared for, potentially raising its resale value and drawing greater interest.</p>
<a class="button-cb319fb cs-bmuh8n button-default" href=""></a>
</div>
<div class="div-c241094" data-cc-comp="component-cd27cec">
<img loading="lazy" decoding="async" class="image-c879c93" src="https://finelinepainting.pro/wp-content/uploads/Sherwin-williams-Repaint-and-drywall-in-Lebanon-PA-1.jpeg" width="1725" height="1038" alt="Sherwin williams Repaint and drywall in Lebanon, PA">
<div class="div-c7dbe48">
<h3 class="heading-c051d6f">High Quality</h3>
<p class="paragraph-ceb2fe6">We both have something in common: a desire for high quality. With this in mind, we only use Sherwin Williams premium paint, delivering an effective paint job. </p>
</div>
</div>
<div class="div-c241094" data-cc-comp="component-cb3ae0f">
<img loading="lazy" decoding="async" class="image-c879c93" src="https://finelinepainting.pro/wp-content/uploads/PaintColorVisualizer.png" width="1600" height="1600" alt="">
<div class="div-c7dbe48">
<h3 class="heading-c051d6f">Paint Color Visualizer</h3>
<p class="paragraph-ceb2fe6">Ready for a visual of the final project without going through the work of painting? We have a solution. Through Sherwin William’s website, you can upload a photo of your room to see a sample.  </p>
</div>
</div>
<div class="div-c241094" data-cc-comp="component-c23e105">
<img loading="lazy" decoding="async" class="image-c879c93" src="https://finelinepainting.pro/wp-content/uploads/paint-collection-sherwin-williams.webp" width="750" height="500" alt="paint-collection-sherwin-williams">
<div class="div-c7dbe48">
<h3 class="heading-c051d6f">Paint Samples</h3>
<p class="paragraph-ceb2fe6">Do you dread a visit to Lowes or Home Depot for paint samples? No need! On the Sherwin Williams website, you can order <strong>free </strong>paint samples to your home. </p>
</div>
</div>
<div class="div-c241094" data-cc-comp="component-cc2b6ef">
<img loading="lazy" decoding="async" class="image-c879c93" src="https://finelinepainting.pro/wp-content/uploads/paint-collection-sherwin-williams.jpg" width="1476" height="560" alt="paint-collection-sherwin-williams">
<div class="div-c7dbe48">
<h3 class="heading-c051d6f">1,700+ Options</h3>
<p class="paragraph-ceb2fe6">Because Sherwin Williams offers 1,700 paint color options, there is sure to be a shade that matches the aesthetic of your home.</p>
</div>
</div>
`;

// ── The fixture sites ────────────────────────────────────────────────────────────────────────────

const ERROR_CODES = [
  "component.convert-failed",
  "component.state-missing",
  "component.state-undeclared",
  "component.state-collision",
  "component.binding-misplaced",
  "component.cycle",
  "component.scope-renamed",
  "component.scope-collision",
  "placeholder.unresolved",
];

for (const name of SITES) {
  describe(`${name}: every cc_block`, () => {
    let site: LoadedSite;
    let out: ComponentsOutput;
    beforeAll(async () => {
      site = await loadSite(name);
      out = await buildComponents(site);
    });

    test("is one file, named by its tag, whose document says the same", () => {
      expect(out.skipped).toEqual([]);
      expect(out.files.map((f) => f.path)).toEqual(
        [...site.components.values()].map((i) => componentFile(i.tagName)).sort(),
      );
      expect(out.components.length).toBe(site.components.size);
      for (const file of out.files) {
        expect(file.content.endsWith("}\n")).toBe(true);
        const doc = JSON.parse(file.content) as Rec;
        const info = [...site.components.values()].find(
          (i) => componentFile(i.tagName) === file.path,
        )!;
        expect(doc.tagName).toBe(info.tagName);
        expect(String(doc.tagName)).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/);
        expect(Array.isArray(doc.children)).toBe(true);
        expect(doc.style).toMatchObject({ display: "contents" });
        // the declared inputs are the properties, by the key every instance names them with
        expect(Object.keys((doc.state as Rec | undefined) ?? {})).toEqual(
          info.props.map((p) => p.key),
        );
      }
    });

    test("reports nothing that is an error of the emitter, and every binding finds its state", () => {
      const bad = out.report.entries().filter((e) => ERROR_CODES.includes(e.code));
      expect(bad.map((e) => `${e.code} ${e.where} ${e.message}`)).toEqual([]);
      for (const file of out.files) {
        const doc = JSON.parse(file.content) as JxDocument;
        expect(misplacedBindings(doc)).toEqual([]);
        const state = (doc.state ?? {}) as Rec;
        const text = JSON.stringify(doc.children);
        for (const m of text.matchAll(/state\??\.([A-Za-z_$][\w$]*)/g)) {
          expect(Object.keys(state)).toContain(m[1]!);
        }
      }
      // every report entry is located at its component
      for (const e of out.report.entries()) expect(e.where).toMatch(/^component:[0-9a-f]{10}$/);
    });

    test("is the same bytes twice", async () => {
      const again = await buildComponents(site);
      expect(again.files).toEqual(out.files);
      expect(again.components).toEqual(out.components);
      expect(codes(again.report)).toEqual(codes(out.report));
    });

    test("passes jx validate and builds, and its stylesheet is the one Cwicly generated", async () => {
      const files = projectFiles(site, out, {
        index: out.components.map((c) => ({ tagName: c.tag })),
      });
      const built = await buildJxProject(files, { name: `components-${name}` });
      const verdict = await validateJxProject(built.dir);
      expect(verdict.problems).toEqual([]);
      expect(verdict.ok).toBe(true);
      for (const c of out.components) {
        expect(built.exists(`components/${c.tag}.css`)).toBe(true);
        const source = join(fixtureDir(name), "css", `cc-cm-${c.ref}.css`);
        if (!existsSync(source)) continue;
        // The variant classes sit on the host (`.x:is(.cs-a *)`); the canonical form of the
        // original names them on the element (`.x.cs-a`), and the host's own rule is not Cwicly's.
        const got = built
          .read(`components/${c.tag}.css`)
          .replace(/:is\((\.cs-[\w-]+(?:\.cs-[\w-]+)*) \*\)/g, "$1")
          .replace(new RegExp(`^${c.tag}\\s*\\{[^}]*\\}\\n?`, "m"), "");
        const diff = canonicalDiff(
          canonicalCss(readFixtureCss(name, `cc-cm-${c.ref}.css`), site.options.breakpoints),
          canonicalCss(got, site.options.breakpoints),
          20,
        );
        // The one rule Cwicly's file has and the build does not: the empty image block of fineline's
        // Icon Card, which the image converter leaves out (see the live comparison below).
        expect(diff.filter((line) => !line.includes(".image-cf6348e {}"))).toEqual([]);
      }
    });

    test("every instance in every post names a component and gives it props it declares", async () => {
      const tags = new Set(out.components.map((c) => c.tag));
      const byTag = new Map(out.components.map((c) => [c.tag, c]));
      const subjects = allSubjects(site).filter((subject) => {
        let has = false;
        walkBlocks(subjectBlocks(site, subject), (b) => {
          if (b.name === "cwicly/component") has = true;
        });
        return has;
      });
      let blocks = 0;
      let missing = 0;
      let seen = 0;
      const perTag = new Map<string, number>();
      for (const subject of subjects) {
        walkBlocks(subjectBlocks(site, subject), (b) => {
          if (b.name !== "cwicly/component") return;
          blocks++;
          if (typeof b.attrs.ref !== "string" || !site.components.has(b.attrs.ref)) missing++;
        });
        const converted = await convertSubject(site, subject);
        const own = new Set<JxElement>();
        for (const instanceEl of walkElements(converted.nodes)) {
          const tag = instanceEl.tagName as string;
          if (!tags.has(tag)) continue;
          if (own.has(instanceEl)) continue;
          seen++;
          perTag.set(tag, (perTag.get(tag) ?? 0) + 1);
          const info = byTag.get(tag)!;
          const keys = new Set(info.props.map((p) => p.key));
          const props = (instanceEl.$props ?? {}) as Rec;
          for (const [key, value] of Object.entries(props)) {
            expect(keys.has(key)).toBe(true);
            const declared = info.props.find((p) => p.key === key)!.default;
            // an instance's value has the shape of the default it replaces, or is a binding on the enclosing component's state
            const shape = (v: unknown): string => (Array.isArray(v) ? "array" : typeof v);
            if (!(typeof value === "string" && value.includes("${"))) {
              expect(shape(value)).toBe(shape(declared));
            }
            if (info.props.find((p) => p.key === key)!.type === "link") {
              expect(typeof (value as Rec).href).toBe("string");
            }
            if (info.props.find((p) => p.key === key)!.type === "image") {
              expect(typeof (value as Rec).src).toBe("string");
            }
          }
          const variantIds = new Set(info.variants.map((v) => v.id));
          const classes = String(instanceEl.className ?? "")
            .split(/\s+/)
            .filter((c) => c.startsWith("cs-"));
          for (const c of classes) expect(variantIds.has(c.slice(3))).toBe(true);
          // a component with variants prints one on every instance; one without prints none
          expect(classes.length > 0).toBe(info.variants.length > 0);
          expect(converted.used.components.has(tag)).toBe(true);
          for (const inner of walkElements([instanceEl])) own.add(inner);
        }
        // the converted tree only names components that have a file
        for (const tag of converted.used.components) {
          if (!tags.has(tag)) continue;
          expect(out.files.some((f) => f.path === componentFile(tag))).toBe(true);
        }
      }
      // Counts differ from the live database's: the fixtures cap each type at a hundred rows.
      expect(seen).toBe(blocks - missing);
      expect(perTag.size).toBeGreaterThan(0);
      if (name === "fineline") {
        expect(perTag.get("wp-icon-card")).toBe(161);
        expect(perTag.get("wp-image-card")).toBe(128);
        expect(missing).toBe(1);
      } else {
        expect(missing).toBe(0);
      }
    });
  });
}

// ── Against the live pages ───────────────────────────────────────────────────────────────────────

interface LiveComparison {
  /** How many instances were built. */
  hosts: number;
  /** The differences of each, after the live root it was matched with. */
  diffs: string[];
  /** Hosts whose `cs-` classes differ from the live root's. */
  variantMismatches: number;
  built: BuiltProject;
}

/**
 * Instantiate the components the subject's blocks name, with the props they were given (the real
 * conversion of the subject), build it, and hold each built instance to the live root it stands for:
 * the element, its classes, attributes and text, and the variant classes the live root printed on
 * itself and the build prints on the host. Live roots that are not instances of this subject (a
 * footer's) are skipped, in order.
 */
async function compareToLive(
  site: LoadedSite,
  out: ComponentsOutput,
  subject: Subject,
  liveHtml: string,
  name: string,
  loose?: Loose,
): Promise<LiveComparison> {
  const tags = new Set(out.components.map((c) => c.tag));
  const converted = await convertSubject(site, subject, { mode: "static", target: "page" });
  const built = await buildJxProject(
    projectFiles(site, out, { page: instancesIn(converted.nodes, tags) }),
    { name: `live-${name}` },
  );
  return { ...matchHosts(site, tags, built.html("/page/"), liveHtml, name, loose), built };
}

/** The built hosts of `tags` in a built page, each held to the live root it stands for (greedily, in order). */
function matchHosts(
  site: SiteContext,
  tags: ReadonlySet<string>,
  builtHtml: string,
  liveHtml: string,
  name: string,
  loose?: Loose,
): Omit<LiveComparison, "built"> {
  const hosts = findAll(fromHtml(builtHtml) as Hast, (el) => tags.has(el.tagName ?? ""));
  const roots = findAll(
    fromHtml(liveHtml) as Hast,
    (el) => el.properties?.dataCcComp !== undefined,
  );
  const diffs: string[] = [];
  let variantMismatches = 0;
  let from = 0;
  hosts.forEach((host, i) => {
    const kids = elementKids(host);
    if (kids.length !== 1) {
      diffs.push(`host ${i}: ${kids.length} element children`);
      return;
    }
    let best: { j: number; list: string[]; variant: boolean } | undefined;
    for (let j = from; j < roots.length; j++) {
      const list: string[] = [];
      compareElement(kids[0]!, roots[j]!, `${name}#${i}<${host.tagName}>`, site, list, loose);
      const live = classesOf(roots[j]!)
        .filter((c) => c.startsWith("cs-"))
        .sort()
        .join(" ");
      const mine = classesOf(host)
        .filter((c) => c.startsWith("cs-"))
        .sort()
        .join(" ");
      if (best === undefined || list.length < best.list.length)
        best = { j, list, variant: live === mine };
      if (list.length === 0) break;
    }
    if (best === undefined) {
      diffs.push(`host ${i}: no live root left`);
      return;
    }
    from = best.j + 1;
    diffs.push(...best.list);
    if (!best.variant) variantMismatches++;
  });
  return { hosts: hosts.length, diffs, variantMismatches };
}

describe("fineline: the built instances against the live page", () => {
  let site: LoadedSite;
  let out: ComponentsOutput;
  beforeAll(async () => {
    site = await loadSite("fineline");
    out = await buildComponents(site);
  });

  test("the seven instances of a project page have the live root's markup, classes and text", async () => {
    const result = await compareToLive(
      site,
      out,
      { kind: "post", id: 1377 },
      LIVE_PROJECT_1377,
      "1377",
    );
    expect(result.hosts).toBe(7);
    expect(result.variantMismatches).toBe(0);
    // Three Icon Cards (30%) and four Image cards. What the build does not reproduce, each a finding of
    // another module and reported in docs, not hidden here: the Icon Card's empty `<img>` is printed
    // with an empty `alt` (the plugin prints no `alt` at all; the empty one keeps it decorative), and
    // the width and height an Image card's image property carries (the image converter takes them
    // from the saved tag, which has none), and the `auto` sizes the plugin prints for it today (the
    // committed live pages are older than WordPress 6.7's auto sizes).
    const known = result.diffs.filter(
      (d) =>
        d.endsWith('img[0]: alt "" vs live undefined') ||
        /img\[0\]: sizes "auto, \(max-width: \d+px\) 100vw, \d+px" vs live undefined$/.test(d) ||
        /img\[0\]: (width|height) undefined vs live "\d+"$/.test(d),
    );
    expect(result.diffs.filter((d) => !known.includes(d))).toEqual([]);
    // The known differences are a ceiling, not a count: fixing the image converter leaves fewer of them.
    expect(known.filter((d) => d.includes("wp-icon-card")).length).toBeLessThanOrEqual(3);
    expect(known.filter((d) => d.includes("width")).length).toBeLessThanOrEqual(4);
    expect(known.filter((d) => d.includes("height")).length).toBeLessThanOrEqual(4);
  });

  test("the variant is a class on the host that the component's rules read from there", async () => {
    const result = await compareToLive(
      site,
      out,
      { kind: "post", id: 1377 },
      LIVE_PROJECT_1377,
      "1377b",
    );
    const html = result.built.html("/page/");
    // all three Icon Cards print the first variant (the plugin does when the instance names none; two name it)
    expect((html.match(/<wp-icon-card class="cs-bmuh8n"/g) ?? []).length).toBe(3);
    expect(html).not.toMatch(/<div class="div-cf3ac5e[^"]*cs-/);
    const css = result.built.read("components/wp-icon-card.css");
    expect(css).toContain(".div-cf3ac5e:is(.cs-bmuh8n *) { flex-basis: calc(33% - 3rem) }");
    expect(css).toContain(
      "@media (max-width: 992px) { .div-cf3ac5e:is(.cs-bmuh8n *) { flex-basis: calc(50% - 2rem) } }",
    );
    expect(css).toContain(".button-cb319fb:is(.cs-bmuh8n *) { display: none }");
    expect(css).not.toMatch(/\.div-cf3ac5e\.cs-/);
  });

  test("the project entry (Markdown, the instances written as directives) builds to the same instances", async () => {
    const collections = await buildCollections(site, {
      include: (post) => post.id === 1377,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(collections.entries.map((e) => e.postId)).toEqual([1377]);
    const pages: Record<string, ProjectFile> = {};
    for (const dp of site.routes.dynamicPages()) {
      if (dp.kind !== "entries" || !collections.collections[dp.source]) continue;
      pages[dp.file] = {
        $paths: dp.paths,
        title: "${state.entry.data.title}",
        state: {
          entry: {
            $prototype: "ContentEntry",
            contentType: dp.source,
            id: { $ref: `#/$params/${dp.param}` },
            $src: "@jxsuite/parser/ContentEntry.class.json",
            timing: "compiler",
          },
        },
        children: [{ tagName: "article", children: "${state.entry.$children ?? []}" }],
      };
    }
    const extra: Record<string, ProjectFile> = {
      "project.json": {
        name: "components-entry",
        url: "https://example.com",
        $media: site.options.media,
        extensions: ["@jxsuite/parser"],
        defaults: { layout: "./layouts/base.json" },
        content: structuredClone(collections.collections),
      },
      ...pages,
    };
    for (const file of collections.files) extra[file.path] = file.content;
    const built = await buildJxProject(projectFiles(site, out, {}, extra), { name: "entry-1377" });
    const tags = new Set(out.components.map((c) => c.tag));
    const html = built.html(collections.entries[0]!.route);
    const result = matchHosts(site, tags, html, LIVE_PROJECT_1377, "entry");
    expect(result.hosts).toBe(7);
    expect(result.variantMismatches).toBe(0);
    const unknown = result.diffs.filter(
      (d) =>
        !d.endsWith('img[0]: alt "" vs live undefined') &&
        !/img\[0\]: sizes "auto, \(max-width: \d+px\) 100vw, \d+px" vs live undefined$/.test(d) &&
        !/img\[0\]: (width|height) undefined vs live "\d+"$/.test(d),
    );
    expect(unknown).toEqual([]);
    // the variant reaches the component's rules from the host a directive wrote
    expect(html).toMatch(/<wp-icon-card[^>]* class="cs-bmuh8n"/);
    expect((await validateJxProject(built.dir)).problems).toEqual([]);
  });

  const LIVE = join(import.meta.dir, "../../.dev/live/fineline");
  const present = existsSync(LIVE);
  test.skipIf(!present)(
    "every live page fetched under .dev/live that has instances agrees the same way",
    async () => {
      // Pages fetched for the investigation, not committed (.dev is ignored): the sweep runs where they are.
      const { readdirSync } = await import("node:fs");
      let total = 0;
      for (const file of readdirSync(LIVE).filter((f) => f.endsWith(".html"))) {
        const html = readFileSync(join(LIVE, file), "utf8");
        if (!html.includes("data-cc-comp")) continue;
        const id = Number(file.replace(".html", ""));
        if (!site.model.posts.has(id)) continue;
        const result = await compareToLive(site, out, { kind: "post", id }, html, `sweep${id}`);
        total += result.hosts;
        expect(result.variantMismatches).toBe(0);
        const unknown = result.diffs.filter(
          (d) =>
            !d.endsWith('img[0]: alt "" vs live undefined') &&
            !/img\[0\]: sizes "auto, \(max-width: \d+px\) 100vw, \d+px" vs live undefined$/.test(
              d,
            ) &&
            !/img\[0\]: (width|height) undefined vs live "\d+"$/.test(d),
        );
        expect(unknown).toEqual([]);
      }
      expect(total).toBeGreaterThan(0);
    },
  );
});

describe("anabaptistperspectives: the built instances against the live page", () => {
  let site: LoadedSite;
  let out: ComponentsOutput;
  beforeAll(async () => {
    site = await loadSite("ap");
    out = await buildComponents(site);
  });

  test("the footer's three Icon/Paragraph Divs have the structure of the committed live page", async () => {
    const live = readFileSync(
      join(fixtureDir("ap"), "html/essays__the-essence-of-anabaptism-dean-taylor.html"),
      "utf8",
    );
    expect((live.match(/data-cc-comp/g) ?? []).length).toBe(3);
    // The footer in the database and the footer on the saved page are two snapshots: the address, the
    // label and the icon of each instance differ, so the structure and the classes are compared.
    const result = await compareToLive(
      site,
      out,
      { kind: "part", slug: "footer" },
      live,
      "footer",
      {
        attrs: new Set(["href", "rel", "target", "viewBox", "d"]),
        text: true,
      },
    );
    expect(result.hosts).toBe(3);
    expect(result.variantMismatches).toBe(0);
    expect(result.diffs).toEqual([]);
    // the element is the live one: a link with the icon, then the text; the title property is not a tooltip on the host
    const html = result.built.html("/page/");
    expect(html).not.toMatch(/<wp-icon-paragraph-div[^>]* title=/);
  });
});

// ── Shapes the real components show ──────────────────────────────────────────────────────────────

describe("the real components' documents", () => {
  test("fineline's Icon Card: the properties' defaults, the variants on the host, the dead properties", async () => {
    const site = await loadSite("fineline");
    const out = await buildComponents(site);
    const doc = docOf(out, "wp-icon-card");
    const state = doc.state as Rec;
    expect(Object.keys(state)).toEqual([
      "icon",
      "heading",
      "paragraph",
      "buttonText",
      "buttonLink",
    ]);
    expect(String(state.icon)).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32"><path /,
    );
    expect(state.heading).toBe("Lorem Ipsum");
    expect(state.paragraph).toBe("");
    expect(state.buttonText).toBe("Learn More");
    expect(state.buttonLink).toEqual({ href: "" });
    expect(doc.style).toEqual({ display: "contents" });
    const root = (doc.children as JxElement[])[0]!;
    expect(root.className).toBe("div-cf3ac5e");
    // the variant rules want their class on the host, with the specificity they had
    const style = root.style as Rec;
    expect(Object.keys(style).filter((k) => k.startsWith("&"))).toEqual([
      "&:is(.cs-bmuh8n *)",
      "&:is(.cs-kxrx4 *)",
    ]);
    expect(style["&:is(.cs-bmuh8n *)"]).toEqual({
      flexBasis: "calc(33% - 3rem)",
      "@--md": { flexBasis: "calc(50% - 2rem)" },
      "@--sm": { flexBasis: "100%" },
    });
    expect(JSON.stringify(doc)).not.toContain('"&.cs-');
    const info = out.components.find((c) => c.tag === "wp-icon-card")!;
    expect(info.variants).toEqual([
      { id: "bmuh8n", name: "30%", groups: [], rules: 2 },
      { id: "kxrx4", name: "50%", groups: [], rules: 1 },
    ]);
    // `icon` and `buttonText` are properties no block reads: 161 instances set the icon and the live page shows none
    expect(info.props.filter((p) => !p.used).map((p) => p.key)).toEqual(["icon", "buttonText"]);
    const dead = out.report
      .entries()
      .filter((e) => e.code === "component.dead-prop" && e.where === "component:0a275b695a");
    expect(dead.map((e) => (e.data as Rec).key)).toEqual(["icon", "buttonText"]);
    expect(info.scopes).toEqual([
      ".button-cb319fb",
      ".div-cf3ac5e",
      ".heading-cc0e8b0",
      ".image-cf6348e",
      ".paragraph-c5200ff",
    ]);
  });

  test("fineline's Image card: the image property is an object with the media plan's file", async () => {
    const site = await loadSite("fineline");
    const out = await buildComponents(site);
    const doc = docOf(out, "wp-image-card");
    expect((doc.state as Rec).image).toEqual({
      src: "/media/swash-light-gray-vertical-horizontal-flip.svg",
      alt: "",
    });
    const img = JSON.stringify(doc.children);
    expect(img).toContain('"src":"${state.image?.src || false}"');
    expect(out.components.find((c) => c.tag === "wp-image-card")!.variants).toEqual([]);
    expect(out.components.find((c) => c.tag === "wp-image-card")!.props.every((p) => p.used)).toBe(
      true,
    );
  });

  test("ap: a nameless property keeps its id as its key, a component of components lists them, an empty one is empty", async () => {
    const site = await loadSite("ap");
    const out = await buildComponents(site);
    expect(Object.keys(docOf(out, "wp-ap-button").state as Rec)).toEqual(["text", "vb1Wz"]);
    const support = docOf(out, "wp-support-the-work");
    expect(support.$elements).toEqual([
      { $ref: "./wp-default-button.json" },
      { $ref: "./wp-icon-paragraph-div.json" },
    ]);
    // the rule that keeps an instance's host out of the box tree is the component's own, not the page's
    expect(support.style).toEqual({
      display: "contents",
      "& wp-icon-paragraph-div": { display: "contents" },
      "& wp-default-button": { display: "contents" },
    });
    expect(out.used.components).toEqual(new Set(["wp-default-button", "wp-icon-paragraph-div"]));
    const empty = docOf(out, "wp-query-pagination");
    expect(empty.children).toEqual([]);
    expect(empty.state).toBeUndefined();
    const where = (code: string): string[] =>
      out.report
        .entries()
        .filter((e) => e.code === code)
        .map((e) => e.where!);
    expect(where("component.empty")).toEqual(["component:e4f8f087a3"]);
    // `title` is also an element property
    expect(where("component.prop-reflected")).toEqual(["component:82c1bb8740"]);
  });
});

// ── Hand-made components ─────────────────────────────────────────────────────────────────────────

describe("properties and variants the fixtures do not have", () => {
  let site: LoadedSite;
  let out: ComponentsOutput;
  const REF = "s1var000001";
  beforeAll(async () => {
    const base = await loadSite("fineline");
    const palette = base.options.globalStyles.colors[0]!.id;
    const global = [...base.options.globalClassNames.keys()][0]!;
    const pageContent = [
      instance(REF, {
        variant: "vb",
        properties: {
          pTxt01: { type: "text", value: { maker: "Hello" } },
          pCol01: { type: "color", value: { maker: "#123456" } },
        },
      }),
      instance(REF, {
        variant: "group-g1",
        properties: { pTxt01: { type: "text", value: { maker: "Group" } } },
      }),
      instance(REF, { properties: { pTxt01: { type: "text", value: { maker: "None" } } } }),
    ].join("\n\n");
    site = extend(base, [
      {
        id: 990001,
        ref: REF,
        slug: "syn-var",
        title: "Syn Var",
        content: div(REF, "div-syn1", heading(REF, "heading-syn2", "pTxt01")),
        meta: {
          properties: {
            pTxt01: { name: "Label", type: "text", default: "Don't stop..." },
            pCol01: { name: "Tint", type: "color", default: `!var=${palette}!` },
            pNum01: { name: "Count", type: "number", default: "3" },
            pOn001: { name: "Visible", type: "toggle", default: "true" },
            pOpt01: {
              name: "Size",
              type: "options",
              default: "o2",
              options: [
                { id: "o1", value: "10px" },
                { id: "o2", value: "20px" },
              ],
            },
            pCls01: {
              name: "Extra",
              type: "class",
              default: { additionalClass: [{ value: "x-extra" }], globalClass: [global] },
            },
            pLnk01: {
              name: "Go",
              type: "link",
              default: {
                maker: {
                  href: "https://finelinepainting.pro/about-us/",
                  target: "_blank",
                  rel: "noopener",
                },
              },
            },
            pGal01: { name: "Pics", type: "gallery", default: {} },
            pLnk02: { name: "Bare", type: "link", default: { link: {} } },
            pDol01: { name: "Dollar", type: "text", default: "cost ${x}" },
            pCss01: { name: "Raw", type: "cssText", default: "a ${b}" },
            pUnk01: { name: "Odd", type: "weird", default: "x" },
            pIco01: {
              name: "Mask",
              type: "icon",
              includeInCSS: true,
              default: {
                icon: {
                  unicode:
                    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 2'><path d='M0 0h2v2z'/></svg>",
                },
              },
            },
            pClk01: { name: "Clock", type: "text", default: "Don't {currentdate}" },
            pCol02: { name: "Edge", type: "color", default: "red ${z}" },
          },
          variants: [
            { id: "va", name: "A" },
            { id: "vb", name: "B" },
          ],
          variantGroups: [{ id: "g1", name: "Both", styles: ["va", "vb"] }],
          styleVariations: [],
        },
        css: ".div-syn1{color:var(--comp-pCol01);mask-image:var(--comp-pIco01);}.div-syn1.cs-va{padding:1px;}.div-syn1.cs-va.cs-vb{margin:2px;}.heading-syn2.cs-vb:hover{color:red;}@media screen and (max-width: 992px){.div-syn1.cs-va{padding:3px;}}",
      },
      {
        id: 990002,
        type: "page",
        ref: "page",
        slug: "syn-page",
        title: "Syn page",
        content: pageContent,
      },
    ]);
    out = await buildComponents(site, { only: [REF] });
  });

  test("every property type has the default an instance's value replaces whole", () => {
    const state = docOf(out, "wp-syn-var").state as Rec;
    expect(state).toEqual({
      label: "Don’t stop…",
      tint: expect.stringMatching(/^var\(--cc-color-\d+\)$/),
      count: 3,
      visible: true,
      size: "20px",
      extra: expect.stringMatching(/^x-extra \S+/),
      go: { href: "/about-us/", target: "_blank", rel: "noopener" },
      bare: { href: "" },
      pics: [],
      dollar: "cost $​{x}",
      raw: "a $​{b}",
      odd: "x",
      edge: "red $\u200b{z}",
      mask: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 2'><path d='M0 0h2v2z'/></svg>",
      clock: expect.stringMatching(/^Don’t \$\{/),
    });
    // nothing in state can be read as a binding but the clock the plugin's own token stands for
    const { clock, ...rest } = state;
    expect(JSON.stringify(rest)).not.toContain("${");
    expect(String(clock)).toContain("new Date(Date.now())");
    const found = codes(out.report);
    expect(found).toContain("component.literal-template");
    expect(found).toContain("component.prop-type-unknown");
  });

  test("the variant keys ask for the class on the host, with the specificity of the compound", () => {
    const root = (docOf(out, "wp-syn-var").children as JxElement[])[0]!;
    const style = root.style as Rec;
    expect(style["&:is(.cs-va *)"]).toEqual({ padding: "1px", "@--md": { padding: "3px" } });
    expect(style["&:is(.cs-va.cs-vb *)"]).toEqual({ margin: "2px" });
    const h = (root.children as JxElement[])[0]!;
    expect((h.style as Rec)["&:is(.cs-vb *):hover"]).toEqual({ color: "red" });
    const info = out.components[0]!;
    expect(info.variants.map((v) => [v.id, v.groups, v.rules])).toEqual([
      ["va", ["g1"], 2],
      ["vb", ["g1"], 2],
    ]);
    expect(info.variantGroups).toEqual([{ id: "g1", name: "Both", styles: ["va", "vb"] }]);
  });

  test("a property that becomes CSS reaches the component's rules, each instance its own value", async () => {
    const doc = docOf(out, "wp-syn-var");
    // the variable is spelled lower-case: a nested instance's host style goes through camelCase-to-kebab
    expect(Object.keys(doc.style as Rec)).toEqual(["display", "--comp-p-col01", "--comp-p-ico01"]);
    expect((doc.style as Rec)["--comp-p-col01"]).toBe("${state.tint || 'initial'}");
    expect(String((doc.style as Rec)["--comp-p-ico01"])).toContain(
      "url('data:image/svg+xml;charset=utf8,",
    );
    expect(out.components[0]!.props.find((p) => p.key === "tint")).toMatchObject({
      used: true,
      cssVariable: "--comp-p-col01",
    });
    // Count, Size and Raw feed a custom property no rule reads: no binding on the host
    expect(JSON.stringify(doc)).not.toContain("--comp-p-num01");
    expect(codes(out.report)).toContain("component.css-variable");

    const nested = {
      tagName: "wp-wrap",
      $elements: [{ $ref: "./wp-syn-var.json" }],
      children: [{ tagName: "wp-syn-var", className: "cs-va", $props: { tint: "#00ff00" } }],
    };
    const files = projectFiles(
      site,
      out,
      {
        index: [
          {
            tagName: "wp-syn-var",
            className: "inst-a cs-va",
            $props: { tint: "#ff0000", label: "A" },
          },
          {
            tagName: "wp-syn-var",
            className: "inst-b cs-va cs-vb",
            $props: { tint: "#0000ff", label: "B" },
          },
          { tagName: "wp-syn-var", $props: { label: "C" } },
          { tagName: "wp-wrap" },
        ],
      },
      { "components/wp-wrap.json": nested },
    );
    const built = await buildJxProject(files, { name: "syn-var" });
    const html = built.html("/");
    // page-level instances: a rule on the instance's first class; the default one on a generated class
    expect(html).toContain(".inst-a { --comp-p-col01: #ff0000;");
    expect(html).toContain(".inst-b { --comp-p-col01: #0000ff;");
    expect(html).toMatch(/\.jx-\d+ \{ --comp-p-col01: var\(--cc-color-\d+\)/);
    // an icon becomes a url() the CSS can mask with, its quotes percent-encoded so the url's own quotes hold
    expect(html).toContain(
      "--comp-p-ico01: url('data:image/svg+xml;charset=utf8,%3Csvg%20xmlns%3D%27http",
    );
    // a nested instance: an inline style, the same name
    expect(html).toContain('<wp-syn-var class="cs-va" style="--comp-p-col01: #00ff00;');
    // the rule that reads it
    const css = built.read("components/wp-syn-var.css");
    expect(css).toContain(
      ".div-syn1 { color: var(--comp-p-col01); mask-image: var(--comp-p-ico01) }",
    );
    expect(css).toContain(".div-syn1:is(.cs-va.cs-vb *) { margin: 2px }");
    expect(css).toContain(".heading-syn2:is(.cs-vb *):hover { color: red }");
    expect((await validateJxProject(built.dir)).problems).toEqual([]);
  });

  test("the instances the converter writes pick their variants, and the built page applies the rules of exactly those", async () => {
    const converted = await convertSubject(
      site,
      { kind: "post", id: 990002 },
      { mode: "static", target: "page" },
    );
    const instances = instancesIn(converted.nodes, new Set(["wp-syn-var"]));
    expect(instances.map((i) => i.className)).toEqual(["cs-vb", "cs-va cs-vb", "cs-va cs-vb"]);
    const built = await buildJxProject(projectFiles(site, out, { index: instances }), {
      name: "syn-var-pick",
    });
    const hosts = findAll(fromHtml(built.html("/")) as Hast, (el) => el.tagName === "wp-syn-var");
    expect(hosts.map((h) => classesOf(h).filter((c) => c.startsWith("cs-")))).toEqual([
      ["cs-vb"],
      ["cs-va", "cs-vb"],
      ["cs-va", "cs-vb"],
    ]);
    expect(hosts.map((h) => collapse(textOf(h)))).toEqual(["Hello", "Group", "None"]);
    // which rules apply to which instance: `.x.cs-a` on the element is `.x:is(.cs-a *)` on its descendants of the host
    const css = built.read("components/wp-syn-var.css");
    const applies = (selector: string, hostClasses: string[]): boolean => {
      const m = /^\.div-syn1:is\(((?:\.cs-\w+)+) \*\)$/.exec(selector)!;
      return [...m[1]!.matchAll(/\.(cs-\w+)/g)].every((c) => hostClasses.includes(c[1]!));
    };
    const rules = [...css.matchAll(/^(\.div-syn1:is\([^)]*\)) \{ ([^}]*) \}$/gm)].map((m) => [
      m[1]!,
      m[2]!,
    ]);
    expect(rules.map(([sel]) => sel)).toEqual([
      ".div-syn1:is(.cs-va *)",
      ".div-syn1:is(.cs-va.cs-vb *)",
    ]);
    const first = hosts.map((h) => classesOf(h));
    expect(rules.map(([sel]) => applies(sel!, first[0]!))).toEqual([false, false]);
    expect(rules.map(([sel]) => applies(sel!, first[1]!))).toEqual([true, true]);
  });
});

describe("slots, cycles, shared classIDs, placeholders", () => {
  let base: LoadedSite;
  beforeAll(async () => {
    base = await loadSite("fineline");
  });

  test("an innerblocks block is the one default slot, and an instance's children go there", async () => {
    const ref = "s2slot00001";
    const second = "s2slot00002";
    const slotted = `<!-- wp:paragraph -->\n<p>Slotted text</p>\n<!-- /wp:paragraph -->`;
    const site = extend(base, [
      {
        id: 990011,
        ref,
        slug: "syn-slot",
        title: "Syn Slot",
        content: div(
          ref,
          "div-slot1",
          `${heading(ref, "heading-slot2", "pH")}${innerblocks(ref, "innerblocks-slot3")}`,
        ),
        meta: { properties: { pH: { name: "Head", type: "text", default: "H" } } },
      },
      {
        id: 990012,
        ref: second,
        slug: "syn-slot-two",
        title: "Syn Slot Two",
        content: div(
          second,
          "div-slot4",
          `${innerblocks(second, "innerblocks-slot5")}${innerblocks(second, "innerblocks-slot6")}`,
        ),
      },
      {
        id: 990013,
        type: "page",
        ref: "page",
        slug: "syn-slot-page",
        title: "Slot page",
        content: instance(ref, { serializedInnerBlocks: slotted }),
      },
    ]);
    const out = await buildComponents(site, { only: [ref, second] });
    const one = out.components.find((c) => c.tag === "wp-syn-slot")!;
    const two = out.components.find((c) => c.tag === "wp-syn-slot-two")!;
    expect([one.slots, two.slots]).toEqual([1, 2]);
    expect(JSON.stringify(docOf(out, "wp-syn-slot").children)).toContain('{"tagName":"slot"}');
    const multiple = out.report.entries().filter((e) => e.code === "component.slot-multiple");
    expect(multiple.map((e) => e.where)).toEqual([`component:${second}`]);

    const converted = await convertSubject(
      site,
      { kind: "post", id: 990013 },
      { mode: "static", target: "page" },
    );
    const instances = instancesIn(converted.nodes, new Set(["wp-syn-slot"]));
    expect(instances.length).toBe(1);
    const built = await buildJxProject(projectFiles(site, out, { index: instances }), {
      name: "syn-slot",
    });
    const html = built.html("/");
    // the children land inside the component's slot wrapper, after the heading, and no slot element is left
    expect(html).toMatch(
      /<h3 class="heading-slot2">H<\/h3>\s*<div class="innerblocks-slot3">[^]*<p[^>]*>Slotted text<\/p>/,
    );
    expect(html).not.toContain("<slot");
  });

  test("components that contain each other are cut where the cycle closes, and the result builds", async () => {
    const [a, b, c] = ["s3cyca00001", "s3cycb00001", "s3cycc00001"] as const;
    const site = extend(base, [
      {
        id: 990021,
        ref: a,
        slug: "syn-cyc-a",
        title: "A",
        content: div(a, "div-cyca", instance(b)),
      },
      {
        id: 990022,
        ref: b,
        slug: "syn-cyc-b",
        title: "B",
        content: div(b, "div-cycb", instance(a)),
      },
      {
        id: 990023,
        ref: c,
        slug: "syn-cyc-c",
        title: "C",
        content: div(c, "div-cycc", `${instance(c)}${instance(a)}`),
      },
    ]);
    const out = await buildComponents(site, { only: [a, b, c] });
    const cycles = out.report.entries().filter((e) => e.code === "component.cycle");
    expect(cycles.map((e) => (e.data as { chain: string[] }).chain)).toEqual([
      ["wp-syn-cyc-a", "wp-syn-cyc-b", "wp-syn-cyc-a"],
      ["wp-syn-cyc-c", "wp-syn-cyc-c"],
    ]);
    // A keeps B; B lost A; C lost itself and keeps A
    expect(docOf(out, "wp-syn-cyc-a").$elements).toEqual([{ $ref: "./wp-syn-cyc-b.json" }]);
    expect(docOf(out, "wp-syn-cyc-b").$elements).toBeUndefined();
    expect(JSON.stringify(docOf(out, "wp-syn-cyc-b").children)).not.toContain("wp-syn-cyc-a");
    expect(docOf(out, "wp-syn-cyc-c").$elements).toEqual([{ $ref: "./wp-syn-cyc-a.json" }]);
    expect(JSON.stringify(docOf(out, "wp-syn-cyc-c").children)).not.toContain("wp-syn-cyc-c");
    const built = await buildJxProject(
      projectFiles(site, out, { index: out.components.map((x) => ({ tagName: x.tag })) }),
      { name: "syn-cycle" },
    );
    expect((await validateJxProject(built.dir)).problems).toEqual([]);
    expect(built.html("/")).toContain('<div class="div-cycb">');
  });

  test("a classID two components share with different declarations is renamed in the later one, and an identical one is left", async () => {
    const [x, y, z] = ["s4dupa000001", "s4dupb000001", "s4dupc000001"] as const;
    const site = extend(base, [
      {
        id: 990031,
        ref: x,
        slug: "syn-dup-a",
        title: "Dup A",
        content: div(x, "div-dup1"),
        css: ".div-dup1{color:red;}",
      },
      {
        id: 990032,
        ref: y,
        slug: "syn-dup-b",
        title: "Dup B",
        content: div(y, "div-dup1"),
        css: ".div-dup1{color:blue;}",
      },
      {
        id: 990033,
        ref: z,
        slug: "syn-dup-c",
        title: "Dup C",
        content: div(z, "div-dup1"),
        css: ".div-dup1{color:red;}",
      },
    ]);
    const out = await buildComponents(site, { only: [x, y, z] });
    const roots = Object.fromEntries(
      ["wp-syn-dup-a", "wp-syn-dup-b", "wp-syn-dup-c"].map((t) => [
        t,
        (docOf(out, t).children as JxElement[])[0]!,
      ]),
    );
    expect(roots["wp-syn-dup-a"]!.className).toBe("div-dup1");
    expect(roots["wp-syn-dup-b"]!.className).toBe("div-dup1-wp-syn-dup-b");
    expect(roots["wp-syn-dup-c"]!.className).toBe("div-dup1");
    const renamed = out.report.entries().filter((e) => e.code === "component.scope-renamed");
    expect(renamed.map((e) => e.data)).toEqual([
      { from: "div-dup1", to: "div-dup1-wp-syn-dup-b", other: "wp-syn-dup-a" },
    ]);
    expect(out.components.find((c) => c.tag === "wp-syn-dup-b")!.scopes).toEqual([
      ".div-dup1-wp-syn-dup-b",
    ]);
    const built = await buildJxProject(
      projectFiles(site, out, { index: out.components.map((c) => ({ tagName: c.tag })) }),
      { name: "syn-dup" },
    );
    // on one page each element has the colour its component says
    expect(built.read("components/wp-syn-dup-a.css")).toContain(".div-dup1 { color: red }");
    expect(built.read("components/wp-syn-dup-b.css")).toContain(
      ".div-dup1-wp-syn-dup-b { color: blue }",
    );
    expect(built.read("components/wp-syn-dup-b.css")).not.toMatch(/\.div-dup1 \{/);
  });

  test("a shortcode and an unknown block become a visible neutral element; a private or empty component says so", async () => {
    const ref = "s5neut00001";
    const lonely = "s5neut00002";
    const site = extend(base, [
      {
        id: 990041,
        ref,
        slug: "syn-neutral",
        title: "Neutral",
        status: "private",
        content: div(
          ref,
          "div-neut1",
          `<!-- wp:core/shortcode -->\n[contact_form id="3"]\n<!-- /wp:core/shortcode -->`,
        ),
      },
      { id: 990042, ref: lonely, slug: "syn-lonely", title: "Lonely", content: "" },
    ]);
    const out = await buildComponents(site, { only: [ref, lonely] });
    const root = (docOf(out, "wp-syn-neutral").children as JxElement[])[0]!;
    const inner = (root.children as JxElement[])[0]!;
    expect(inner.className).toBe("wp2jx-unconverted wp2jx-shortcode");
    expect(inner.attributes).toEqual({ "data-wp2jx": "shortcode:contact_form" });
    const found = codes(out.report);
    expect(found).toContain("component.placeholder-neutral");
    expect(found).toContain("component.not-published");
    expect(found).toContain("component.empty");
    expect(found).not.toContain("placeholder.unresolved");
    expect(docOf(out, "wp-syn-lonely").children).toEqual([]);
  });

  test("a Fluent Forms shortcode inside a component is the form, when the site holds it", async () => {
    const ref = "s5form00001";
    const synthetic = [
      {
        id: 990051,
        ref,
        slug: "syn-form",
        title: "Form",
        content: div(
          ref,
          "div-form1",
          `<!-- wp:core/shortcode -->\n[fluentform id="6"]\n<!-- /wp:core/shortcode -->`,
        ),
      },
    ];
    const withForm = await buildComponents(
      { ...extend(base, synthetic), forms: await pilotForms() },
      { only: [ref] },
    );
    const root = (docOf(withForm, "wp-syn-form").children as JxElement[])[0]!;
    const inner = (root.children as JxElement[])[0]!;
    expect(inner.className).toBe("fluentform ff-default fluentform_wrapper_6 ffs_custom_wrap");
    expect(String(inner.innerHTML)).toContain('<form data-form_id="6"');
    expect(codes(withForm.report)).toContain("form.not-submittable");
    expect(codes(withForm.report)).not.toContain("component.placeholder-neutral");
    // without the form the shortcode stays a visible stand-in
    const without = await buildComponents(extend(base, synthetic), { only: [ref] });
    const kept = (
      (docOf(without, "wp-syn-form").children as JxElement[])[0]!.children as JxElement[]
    )[0]!;
    expect(kept.className).toBe("wp2jx-unconverted wp2jx-shortcode");
    expect(codes(without.report)).toContain("form.missing");
  });

  test("a template part inside a component is an instance of the part's component, one that does not exist stays and is reported", async () => {
    const ref = "s6part000001";
    const part = (slug: string): string =>
      `<!-- wp:template-part ${json({ slug, theme: base.model.site.theme })} /-->`;
    const site = extend(base, [
      {
        id: 990051,
        ref,
        slug: "syn-parts",
        title: "Parts",
        content: div(ref, "div-parts1", `${part("footer")}${part("nonesuch")}`),
      },
    ]);
    const out = await buildComponents(site, { only: [ref] });
    const doc = docOf(out, "wp-syn-parts");
    const root = (doc.children as JxElement[])[0]!;
    expect((root.children as JxElement[]).map((c) => c.tagName)).toEqual([
      "wp-footer",
      "wp2jx-template-part",
    ]);
    expect(doc.$elements).toEqual([{ $ref: "./wp-footer.json" }]);
    const unresolved = out.report.entries().filter((e) => e.code === "placeholder.unresolved");
    expect(unresolved.length).toBe(1);
    expect(unresolved[0]!.where).toBe(`component:${ref}`);
  });

  test("variants no component defines, ids every instance repeats, and an id two components style differently are reported", async () => {
    const [x, y] = ["s7ids0000001", "s7ids0000002"] as const;
    const site = extend(base, [
      {
        id: 990061,
        ref: x,
        slug: "syn-ids-a",
        title: "Ids A",
        content: "",
        meta: { variants: [{ id: "real", name: "Real" }] },
      },
      {
        id: 990062,
        ref: y,
        slug: "syn-ids-b",
        title: "Ids B",
        content: "",
        meta: { variants: [{ id: "v1", name: "V" }] },
      },
    ]);
    // An element keeps its id only where the block prints one (a nav, a query): the converted nodes are written by hand.
    const nodes: Record<string, JxNode[]> = {
      [x]: [
        { tagName: "div", id: "same-id", style: { color: "red", "&.cs-ghost": { color: "blue" } } },
      ],
      [y]: [{ tagName: "div", id: "same-id", style: { color: "green" } }],
    };
    const out = await buildComponents(site, {
      only: [x, y],
      convert: async (s, subject, opts) => {
        const real = await convertSubject(s, subject, opts);
        return subject.kind === "component" && nodes[subject.ref]
          ? { ...real, nodes: nodes[subject.ref]! }
          : real;
      },
    });
    const found = (code: string): string[] =>
      out.report
        .entries()
        .filter((e) => e.code === code)
        .map((e) => e.where!);
    expect(found("component.id-repeats")).toEqual([`component:${x}`, `component:${y}`]);
    expect(found("component.variant-orphan")).toEqual([`component:${x}`]);
    // both define variants and no rule of either reads one of them
    expect(found("component.variant-no-rules")).toEqual([`component:${x}`, `component:${y}`]);
    expect(found("component.scope-collision")).toEqual([`component:${y}`]);
    expect(out.components.map((c) => c.scopes)).toEqual([["#same-id"], ["#same-id"]]);
  });

  test("a document that reads state it does not declare, points at state nobody registered or collides is told so", async () => {
    const site = await loadSite("ap");
    const built = await buildComponentDocument(
      site,
      { kind: "part", slug: "footer" },
      {
        tagName: "wp-state",
        state: { a: 1 },
        tags: new Set(),
        convert: async (s, subject, opts) => ({
          ...(await convertSubject(s, subject, opts)),
          nodes: [
            { tagName: "p", textContent: "${state.a} ${state.zzz ?? ''} ${state['q-r']}" },
            {
              tagName: "ul",
              children: {
                $prototype: "Array",
                items: { $ref: "#/state/rows" },
                map: { tagName: "li" },
              },
            },
            { tagName: "i", className: "x-${state.a}" },
          ],
          state: { a: 2, b: 3 },
          used: { ...(await convertSubject(s, subject, opts)).used, states: new Set<string>() },
        }),
      },
    );
    const entries = built.prepared.report.entries();
    const by = (code: string): unknown[] =>
      entries
        .filter((e) => e.code === code)
        .map((e) => (e.data as Rec).key ?? (e.data as Rec).position);
    expect(by("component.state-undeclared")).toEqual(["q-r", "zzz"]);
    expect(by("component.state-missing")).toEqual(["rows"]);
    expect(by("component.state-collision")).toEqual(["a"]);
    expect(by("component.binding-misplaced")).toEqual(["className"]);
    // the declared input wins over the conversion's entry, and the entry the conversion made is kept
    expect(built.doc.state).toEqual({ a: 1, b: 3 });
    for (const code of [
      "state-undeclared",
      "state-missing",
      "state-collision",
      "binding-misplaced",
    ]) {
      for (const e of entries.filter((x) => x.code === `component.${code}`))
        expect(e.severity).toBe("error");
    }
  });

  test("a component a conversion cannot finish costs that component only", async () => {
    const out = await buildComponents(base, {
      convert: async (site, subject, opts) => {
        if (subject.kind === "component" && subject.ref === "244868a12d") throw new Error("boom");
        return convertSubject(site, subject, opts);
      },
    });
    expect(out.skipped).toEqual([
      { ref: "244868a12d", code: "component.convert-failed", reason: "boom" },
    ]);
    expect(out.files.map((f) => f.path)).toEqual(["components/wp-icon-card.json"]);
    expect(
      out.report
        .entries()
        .some((e) => e.code === "component.convert-failed" && e.severity === "error"),
    ).toBe(true);
  });
});

describe("one conversion path for parts and reusable blocks", () => {
  test("a template part is a document of its own tag, with the host style the caller chooses", async () => {
    const site = await loadSite("ap");
    const built = await buildComponentDocument(
      site,
      { kind: "part", slug: "footer" },
      {
        tagName: "wp-footer",
        resolvers: { "*": () => null },
        hostStyle: { display: "block" },
        description: "Footer.",
      },
    );
    expect(built.file).toBe("components/wp-footer.json");
    expect(built.doc.tagName).toBe("wp-footer");
    expect(built.doc.description).toBe("Footer.");
    // the host style the caller chose, then the footer's modal rules (hoisted, written under the host) and the instance tag's
    const style = built.doc.style as Rec;
    expect(Object.keys(style)[0]).toBe("display");
    expect(style.display).toBe("block");
    expect(style["& wp-icon-paragraph-div"]).toEqual({ display: "contents" });
    expect(Object.keys(style).filter((k) => k.startsWith("& "))).toContain("& .cc-mdl[popover]");
    // the footer holds Icon/Paragraph Divs and a reusable block (`wp-mobile-menu`) the templates emitter writes
    expect(built.doc.$elements).toEqual([
      { $ref: "./wp-icon-paragraph-div.json" },
      { $ref: "./wp-mobile-menu.json" },
    ]);
    expect([...built.used.components]).toEqual(["wp-icon-paragraph-div", "wp-mobile-menu"]);
    expect(built.content).toBe(`${JSON.stringify(built.doc, null, 2)}\n`);
    expect(misplacedBindings(built.doc)).toEqual([]);
    const report = codes(built.prepared.report);
    expect(report).not.toContain("component.state-missing");
    // it builds beside the components it names
    const comps = await buildComponents(site);
    const files = projectFiles(
      site,
      comps,
      { index: [{ tagName: "wp-footer" }] },
      {
        [built.file]: built.content,
        "components/wp-mobile-menu.json": { tagName: "wp-mobile-menu", children: [] },
      },
    );
    files["pages/index.json"] = {
      title: "t",
      $elements: [{ $ref: "../components/wp-footer.json" }],
      children: [{ tagName: "wp-footer" }],
    };
    const project = await buildJxProject(files, { name: "part-doc" });
    expect((await validateJxProject(project.dir)).problems).toEqual([]);
    expect(project.html("/")).toContain("<wp-footer");
  });
});

describe("a document that names its own tag", () => {
  test("is not a dependency of itself", async () => {
    const site = await loadSite("ap");
    const built = await buildComponentDocument(
      site,
      { kind: "part", slug: "footer" },
      {
        tagName: "wp-self",
        tags: new Set(["wp-self", "wp-icon-paragraph-div"]),
        convert: async (s, subject, opts) => ({
          ...(await convertSubject(s, subject, opts)),
          nodes: [{ tagName: "wp-self" }, { tagName: "wp-icon-paragraph-div" }],
        }),
      },
    );
    expect(built.doc.$elements).toEqual([{ $ref: "./wp-icon-paragraph-div.json" }]);
    expect([...built.used.components]).toEqual(["wp-icon-paragraph-div"]);
  });
});

describe("rules no element's style can hold", () => {
  test("selectors go under the host, at-rules stay at-rules, the document's own rules are handed back", async () => {
    const site = await loadSite("ap");
    const spin = { from: { opacity: "0" }, to: { opacity: "1" } };
    const built = await buildComponentDocument(
      site,
      { kind: "part", slug: "footer" },
      {
        tagName: "wp-rules",
        hostStyle: false,
        tags: new Set(),
        convert: async (s, subject, opts) => ({
          ...(await convertSubject(s, subject, opts)),
          nodes: [],
          hoisted: [
            { selector: "body:has(#m:popover-open)", style: { overflow: "hidden" } },
            { selector: ":root", style: { "--x": "1" } },
            { selector: ".a, :is(.b, .c) .d", style: { color: "red" } },
            { selector: ".a", style: { margin: "0" } },
            { selector: "@keyframes spin", style: spin },
            { selector: "@keyframes spin", style: { from: { opacity: "1" } } },
          ],
        }),
      },
    );
    expect(built.doc.style).toEqual({
      "& .a": { color: "red", margin: "0" },
      "& :is(.b, .c) .d": { color: "red" },
      "@keyframes spin": { from: { opacity: "1" } },
    });
    expect(built.used.documentRules.map((r) => r.selector)).toEqual([
      "body:has(#m:popover-open)",
      ":root",
    ]);
    expect(built.used.hoisted.map((r) => r.selector)).toEqual([
      ".a, :is(.b, .c) .d",
      ".a",
      "@keyframes spin",
      "@keyframes spin",
    ]);
    const found = codes(built.prepared.report);
    expect(found.filter((c) => c === "component.hoisted-unplaced").length).toBe(2);
    expect(found).toContain("component.hoisted-collision");
    // and the result is a component the build takes
    const comps = await buildComponents(site, { only: [] });
    const project = await buildJxProject(
      projectFiles(
        site,
        comps,
        {},
        {
          [built.file]: built.content,
          "pages/index.json": {
            title: "t",
            $elements: [{ $ref: "../components/wp-rules.json" }],
            children: [{ tagName: "wp-rules" }],
          },
        },
      ),
      { name: "rules" },
    );
    expect(project.read("components/wp-rules.css")).toContain("@keyframes spin");
    expect(project.read("components/wp-rules.css")).toContain("wp-rules .a");
  });
});

// ── The pieces ───────────────────────────────────────────────────────────────────────────────────

describe("the helpers", () => {
  test("a variant key moves its classes to an ancestor and keeps whatever follows them", () => {
    expect(ancestorVariantKey("&.cs-abc")).toEqual({ key: "&:is(.cs-abc *)", ids: ["abc"] });
    expect(ancestorVariantKey("&.cs-a.cs-b:hover")).toEqual({
      key: "&:is(.cs-a.cs-b *):hover",
      ids: ["a", "b"],
    });
    expect(ancestorVariantKey("&.cs-a svg")).toEqual({ key: "&:is(.cs-a *) svg", ids: ["a"] });
    expect(ancestorVariantKey("&.cs-a-b_2")?.ids).toEqual(["a-b_2"]);
    expect(ancestorVariantKey("&:is(a)")).toBeUndefined();
    expect(ancestorVariantKey("& .cs-a")).toBeUndefined();
    expect(ancestorVariantKey(".cs-a")).toBeUndefined();
  });

  test("switchVariants works on a copy, at any depth and inside a media block, and counts per variant", () => {
    const input: JxNode[] = [
      {
        tagName: "div",
        style: { color: "red", "&.cs-a": { padding: "1px", "@--md": { padding: "2px" } } },
        children: [
          {
            tagName: "span",
            style: {
              "&.cs-a": { margin: 0 },
              "&.cs-b:hover": { margin: 1 },
              "@--sm": { "&.cs-b": { margin: 2 } },
            },
          },
        ],
      },
    ];
    const before = JSON.stringify(input);
    const { nodes, variants } = switchVariants(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(nodes)).not.toContain('"&.cs-');
    expect(Object.fromEntries(variants)).toEqual({ a: 2, b: 2 });
    const span = ((nodes[0] as JxElement).children as JxElement[])[0]!;
    expect(Object.keys(span.style as Rec)).toEqual([
      "&:is(.cs-a *)",
      "&:is(.cs-b *):hover",
      "@--sm",
    ]);
    expect(((span.style as Rec)["@--sm"] as Rec)["&:is(.cs-b *)"]).toEqual({ margin: 2 });
  });

  test("refs between project files are relative to the file that holds them", () => {
    expect(relativeRef("components/a.json", "components/b.json")).toBe("./b.json");
    expect(relativeRef("pages/x/y.json", "components/b.json")).toBe("../../components/b.json");
    expect(componentFile("wp-a")).toBe("components/wp-a.json");
  });

  test("misplacedBindings finds what the build never evaluates and leaves the host's flat style alone", () => {
    const doc = {
      tagName: "x-y",
      style: { display: "contents", "--comp-x": "${state.a || 'initial'}" },
      children: [
        {
          tagName: "div",
          className: "a ${state.b}",
          id: "i-${state.c}",
          hidden: "${state.d}",
          style: { ":hover": { color: "${state.e}" } },
          children: ["text ${state.f}", { tagName: "p", textContent: "${state.g}" }],
        },
      ],
    } as unknown as JxDocument;
    expect(
      misplacedBindings(doc)
        .map((m) => m.position)
        .sort(),
    ).toEqual(["children", "className", "hidden", "id", "style"]);
    expect(createReport().entries()).toEqual([]);
  });
});

// ── Review findings ──────────────────────────────────────────────────────────────────────────────
//
// Each test below was written failing against the emitter before the fix it holds.

/** A block whose tag prints the component's classes and tokens as the saved markup of a real one does. */
const tokenDiv = (ref: string, classID: string, tokens: string, inner = ""): string =>
  `<!-- wp:cwicly/div ${json({ isComponentChild: ref, isStyling: true, classID, uniqueID: classID })} -->\n<div class="${classID}{cs-index} ${tokens}">${inner}</div>\n<!-- /wp:cwicly/div -->`;

/** The values of one custom property in every rule of a built page. */
const customValues = (html: string, name: string): string[] =>
  [...html.matchAll(new RegExp(`${name}: ([^;}]+?)\\s*[;}]`, "g"))].map((m) => m[1]!);

describe("review: text properties hold markup the plugin prints raw", () => {
  test("fineline post 2449: `Increased <br>Value` builds as a line break, as on the live page", async () => {
    const site = await loadSite("fineline");
    const out = await buildComponents(site);
    const heading = (docOf(out, "wp-icon-card").children as JxElement[])[0]!
      .children as JxElement[];
    const h3 = heading.find((child) => child.tagName === "h3")!;
    expect(h3.innerHTML).toBe("${state.heading ?? ''}");
    expect(h3.textContent).toBeUndefined();
    const converted = await convertSubject(
      site,
      { kind: "post", id: 2449 },
      { mode: "static", target: "page" },
    );
    const tags = new Set(out.components.map((c) => c.tag));
    const built = await buildJxProject(
      projectFiles(site, out, { page: instancesIn(converted.nodes, tags) }),
      { name: "markup-2449" },
    );
    const html = built.html("/page/");
    expect(html).toMatch(/<h3 class="heading-cc0e8b0">Increased <br>Value\s*<\/h3>/);
    expect(html).not.toContain("&lt;br&gt;");
  });

  test("a text property read as the whole text of an element is HTML; the default is too", async () => {
    const base = await loadSite("fineline");
    const ref = "rv0mark0001";
    const site = extend(base, [
      {
        id: 990201,
        ref,
        slug: "rv-mark",
        title: "Rv Mark",
        content: div(ref, "div-mk1", heading(ref, "heading-mk2", "pT")),
        meta: {
          properties: {
            pT: { name: "Title", type: "text", default: "Fresh <b>paint</b> & more" },
          },
        },
      },
    ]);
    const out = await buildComponents(site, { only: [ref] });
    const root = (docOf(out, "wp-rv-mark").children as JxElement[])[0]!;
    const h = (root.children as JxElement[])[0]!;
    expect(h.innerHTML).toBe("${state.title ?? ''}");
    expect(h.textContent).toBeUndefined();
    const built = await buildJxProject(
      projectFiles(site, out, {
        index: [
          { tagName: "wp-rv-mark" },
          { tagName: "wp-rv-mark", $props: { title: "Increased <br>Value" } },
        ],
      }),
      { name: "markup-synthetic" },
    );
    const html = built.html("/");
    expect(html).toContain("Fresh <b>paint</b> &");
    expect(html).toContain("Increased <br>Value");
    expect(html).not.toContain("&lt;");
  });

  test("bindMarkupAsHtml: only text read through a text or list property moves, its literal parts are escaped", () => {
    const nodes: JxNode[] = [
      {
        tagName: "div",
        children: [
          { tagName: "p", textContent: "Tom & <Jerry> ${state.t ?? ''}!" },
          { tagName: "p", textContent: "${state.other ?? ''}" },
          { tagName: "p", textContent: "${state.t ?? ''} ${state.other ?? ''}" },
          { tagName: "p", textContent: "plain" },
          { tagName: "p", innerHTML: "${state.t ?? ''}" },
          { tagName: "p", textContent: "${state['l'] ?? ''}" },
        ],
      },
    ];
    const before = JSON.stringify(nodes);
    const moved = components.bindMarkupAsHtml(nodes, new Set(["t", "l"]));
    expect(JSON.stringify(nodes)).toBe(before);
    const kids = (moved[0] as JxElement).children as JxElement[];
    expect(kids.map((k) => [k.textContent, k.innerHTML])).toEqual([
      [undefined, "Tom &amp; &lt;Jerry&gt; ${state.t ?? ''}!"],
      ["${state.other ?? ''}", undefined],
      ["${state.t ?? ''} ${state.other ?? ''}", undefined],
      ["plain", undefined],
      [undefined, "${state.t ?? ''}"],
      [undefined, "${state['l'] ?? ''}"],
    ]);
  });
});

describe("review: number defaults and the CSS fallback", () => {
  test("a number property whose default is 0 reaches the CSS as 0; one with no default falls back", async () => {
    const base = await loadSite("fineline");
    const ref = "rv0num00001";
    const site = extend(base, [
      {
        id: 990211,
        ref,
        slug: "rv-num",
        title: "Rv Num",
        content: div(ref, "div-numz"),
        meta: {
          properties: {
            pNum01: { name: "Op", type: "number", default: "0" },
            pNum02: { name: "Gap", type: "number", default: "4" },
            pNum03: { name: "Empty", type: "number", default: "" },
          },
        },
        css: ".div-numz{opacity:var(--comp-pNum01,1);gap:var(--comp-pNum02,1px);order:var(--comp-pNum03,2)}",
      },
    ]);
    const out = await buildComponents(site, { only: [ref] });
    const doc = docOf(out, "wp-rv-num");
    expect((doc.state as Rec).op).toBe(0);
    expect(String((doc.style as Rec)["--comp-p-num01"])).not.toContain("|| 'initial'");
    const built = await buildJxProject(
      projectFiles(site, out, {
        index: [
          { tagName: "wp-rv-num" },
          { tagName: "wp-rv-num", $props: { op: "0" } },
          { tagName: "wp-rv-num", $props: { op: "5" } },
        ],
      }),
      { name: "num-zero" },
    );
    const html = built.html("/");
    expect(customValues(html, "--comp-p-num01").sort()).toEqual(["0", "0", "5"]);
    expect(new Set(customValues(html, "--comp-p-num02"))).toEqual(new Set(["4"]));
    expect(new Set(customValues(html, "--comp-p-num03"))).toEqual(new Set(["initial"]));
  });
});

describe("review: defaults the plugin would not print as they are", () => {
  let base: LoadedSite;
  beforeAll(async () => {
    base = await loadSite("fineline");
  });

  test("a global class that no longer exists in a class default is reported, the rest is kept", async () => {
    const ref = "rv0dang0001";
    const global = [...base.options.globalClassNames.keys()][0]!;
    expect(base.options.globalClassNames.has("3yEPq5XEDBJoOaj")).toBe(false);
    const site = extend(base, [
      {
        id: 990221,
        ref,
        slug: "rv-dang",
        title: "Rv Dang",
        content: div(ref, "div-dg1"),
        meta: {
          properties: {
            pCls01: {
              name: "Extra",
              type: "class",
              default: {
                additionalClass: [{ value: "x-extra" }],
                globalClass: [global, "3yEPq5XEDBJoOaj"],
              },
            },
          },
        },
      },
    ]);
    const out = await buildComponents(site, { only: [ref] });
    expect((docOf(out, "wp-rv-dang").state as Rec).extra).toBe(
      `x-extra ${base.options.globalClassNames.get(global)}`,
    );
    const found = out.report.entries().filter((e) => e.code === "class.dangling-global");
    expect(found.map((e) => [e.where, e.severity, (e.data as Rec).globalClass])).toEqual([
      [`component:${ref}`, "warn", "3yEPq5XEDBJoOaj"],
    ]);
  });

  test("an option default that names no option is empty, as the plugin has it; a dynamic one is the raw default", async () => {
    const ref = "rv0opt00001";
    const options = [
      { id: "o1", value: "10px" },
      { id: "o2", value: "20px" },
    ];
    const site = extend(base, [
      {
        id: 990222,
        ref,
        slug: "rv-opt",
        title: "Rv Opt",
        content: div(ref, "div-op1"),
        meta: {
          properties: {
            pOpt01: { name: "Gone", type: "options", default: "deleted-id", options },
            pOpt02: { name: "Dyn", type: "options", default: "o1", options, isDynamic: true },
            pOpt03: { name: "Live", type: "options", default: "o2", options },
            pOpt04: {
              name: "Dyntok",
              type: "options",
              default: "{currentdate}",
              options,
              isDynamic: true,
            },
          },
        },
        css: ".div-op1{padding:var(--comp-pOpt01,3px)}",
      },
    ]);
    const out = await buildComponents(site, { only: [ref] });
    const doc = docOf(out, "wp-rv-opt");
    const state = doc.state as Rec;
    expect(state.gone).toBe("");
    expect(state.dyn).toBe("o1");
    expect(state.live).toBe("20px");
    expect(String(state.dyntok)).not.toContain("{currentdate}");
    const dangling = out.report.entries().filter((e) => e.code === "component.option-unmatched");
    expect(dangling.map((e) => [e.where, e.severity, (e.data as Rec).prop])).toEqual([
      [`component:${ref}`, "info", "pOpt01"],
    ]);
    // the empty default falls back in the CSS rather than setting the property to the deleted id
    const built = await buildJxProject(
      projectFiles(site, out, { index: [{ tagName: "wp-rv-opt" }] }),
      {
        name: "opt-gone",
      },
    );
    expect(new Set(customValues(built.html("/"), "--comp-p-opt01"))).toEqual(new Set(["initial"]));
  });

  test("a richtext default has its addresses moved to the Jx site, as an instance's value does", async () => {
    const ref = "rv0rich0001";
    const site = extend(base, [
      {
        id: 990223,
        ref,
        slug: "rv-rich",
        title: "Rv Rich",
        content: div(ref, "div-rc1"),
        meta: {
          properties: {
            pR: {
              name: "Body",
              type: "richtext",
              default:
                '<p>See <a href="https://finelinepainting.pro/about-us/">about</a> <img src="https://finelinepainting.pro/wp-content/uploads/PaintColorVisualizer.png"> and <a href="https://example.org/x">out</a></p>',
            },
          },
        },
      },
    ]);
    const out = await buildComponents(site, { only: [ref] });
    const body = String((docOf(out, "wp-rv-rich").state as Rec).body);
    expect(body).toContain('href="/about-us/"');
    expect(body).toContain('src="/media/PaintColorVisualizer.png"');
    expect(body).toContain('href="https://example.org/x"');
    expect(body).not.toContain("finelinepainting.pro");
  });

  test("a palette reference no palette has is reported and writes nothing; a real one is the variable it names", async () => {
    const ref = "rv0pal00001";
    const real = base.options.globalStyles.colors[0]!;
    const site = extend(base, [
      {
        id: 990224,
        ref,
        slug: "rv-pal",
        title: "Rv Pal",
        content: div(ref, "div-pl1"),
        meta: {
          properties: {
            pCol01: { name: "Gone", type: "color", default: "!var=nope1!" },
            pCol02: { name: "Mixed", type: "color", default: "1px solid !var=nope2!" },
            pCol03: { name: "Real", type: "color", default: `!var=${real.id}!` },
          },
        },
      },
    ]);
    const out = await buildComponents(site, { only: [ref] });
    const state = docOf(out, "wp-rv-pal").state as Rec;
    expect(state.gone).toBe("");
    expect(state.mixed).toBe("1px solid");
    expect(state.real).toBe(`var(${real.variable})`);
    const found = out.report.entries().filter((e) => e.code === "component.palette-unresolved");
    expect(found.map((e) => [e.where, e.severity, (e.data as Rec).ids])).toEqual([
      [`component:${ref}`, "warn", ["nope1"]],
      [`component:${ref}`, "warn", ["nope2"]],
    ]);
    expect(JSON.stringify(state)).not.toContain("!var=");
  });
});

describe("review: toggles, class properties and what a component body may bind", () => {
  let base: LoadedSite;
  let site: LoadedSite;
  let out: ComponentsOutput;
  const ref = "rv0tog00001";
  beforeAll(async () => {
    base = await loadSite("fineline");
    site = extend(base, [
      {
        id: 990231,
        ref,
        slug: "rv-tog",
        title: "Rv Tog",
        content: tokenDiv(
          ref,
          "div-tg1",
          "{component=class=pCls01} {component=parameter=pTog01=accordionopen}",
        ),
        meta: {
          properties: {
            pCls01: {
              name: "Extra",
              type: "class",
              default: { additionalClass: [{ value: "x-extra" }] },
            },
            pTog01: { name: "Open", type: "toggle", default: "false" },
          },
        },
        css: ".div-tg1{color:red}",
      },
    ]);
    out = await buildComponents(site, { only: [ref] });
  });

  test("a class property is a binding the build resolves per instance, so it is not an error", () => {
    const found = out.report.entries().filter((e) => e.code === "component.binding-misplaced");
    expect(found.map((e) => e.message)).toEqual([]);
    const root = (docOf(out, "wp-rv-tog").children as JxElement[])[0]!;
    expect(String(root.className)).toMatch(/^div-tg1 \$\{state\.extra\}/);
  });

  test("a toggle an instance gives as the string `false` is off, as the default is", async () => {
    const built = await buildJxProject(
      projectFiles(site, out, {
        index: [
          { tagName: "wp-rv-tog", $props: { extra: "foo bar" } },
          { tagName: "wp-rv-tog", $props: { extra: "baz", open: "true" } },
          { tagName: "wp-rv-tog", $props: { open: "false" } },
          { tagName: "wp-rv-tog", $props: { open: true } },
          { tagName: "wp-rv-tog" },
        ],
      }),
      { name: "toggle-shapes" },
    );
    const html = built.html("/");
    const classes = [...html.matchAll(/<div class="(div-tg1[^"]*)"/g)].map((m) => m[1]);
    expect(classes).toEqual([
      "div-tg1 foo bar cc-accordion-hidden",
      "div-tg1 baz cc-accordion-active",
      "div-tg1 x-extra cc-accordion-hidden",
      "div-tg1 x-extra cc-accordion-active",
      "div-tg1 x-extra cc-accordion-hidden",
    ]);
  });

  test("normaliseToggleReads rewrites each read of a toggle key inside a binding and nothing else", () => {
    const nodes: JxNode[] = [
      {
        tagName: "div",
        className: "a ${state.open ? 'on' : 'off'} state.open",
        attributes: {
          hidden: "${!state?.open}",
          title: "${state['open'] ? 1 : 2} ${state.opened}",
        },
        style: { color: "${state.open ? 'red' : 'blue'}" },
        children: [{ tagName: "p", textContent: "${state.n ?? ''}" }],
      },
    ];
    const before = JSON.stringify(nodes);
    const moved = components.normaliseToggleReads(nodes, new Set(["open"])) as JxElement[];
    expect(JSON.stringify(nodes)).toBe(before);
    const is = (read: string): string =>
      `(${read} === true || ${read} === 'true' || ${read} === 1 || ${read} === '1')`;
    const on = is("state.open");
    expect(moved[0]!.className).toBe(`a \${${on} ? 'on' : 'off'} state.open`);
    expect((moved[0]!.attributes as Rec).hidden).toBe(`\${!${is("state?.open")}}`);
    expect((moved[0]!.attributes as Rec).title).toBe(
      `\${${is("state['open']")} ? 1 : 2} \${state.opened}`,
    );
    expect((moved[0]!.style as Rec).color).toBe(`\${${on} ? 'red' : 'blue'}`);
    expect((moved[0]!.children as JxElement[])[0]!.textContent).toBe("${state.n ?? ''}");
  });

  test("misplacedBindings in a component: a first class that is a binding is flagged, a bound later class and an unstyled id are not", () => {
    const doc = {
      tagName: "x-y",
      children: [
        { tagName: "div", className: "a ${state.b}" },
        { tagName: "div", className: "${state.b} a" },
        { tagName: "div", id: "i-${state.c}" },
        { tagName: "div", id: "i-${state.c}", style: { color: "red" } },
      ],
    } as unknown as JxDocument;
    const asPage = components.misplacedBindings(doc).map((m) => `${m.path} ${m.position}`);
    expect(asPage).toEqual([
      "children/0 className",
      "children/1 className",
      "children/2 id",
      "children/3 id",
    ]);
    const inComponent = components
      .misplacedBindings(doc, { perInstance: true })
      .map((m) => `${m.path} ${m.position}`);
    expect(inComponent).toEqual(["children/1 className", "children/3 id"]);
  });
});

describe("review: what the component cannot carry says so", () => {
  let base: LoadedSite;
  beforeAll(async () => {
    base = await loadSite("fineline");
  });

  test("visibility and conditions properties are unsupported, and not called dead", async () => {
    const ref = "rv0vis00001";
    const site = extend(base, [
      {
        id: 990241,
        ref,
        slug: "rv-vis",
        title: "Rv Vis",
        content: div(ref, "div-vs1"),
        meta: {
          properties: {
            pVis01: { name: "Vis", type: "visibility", default: "visible" },
            pCon01: { name: "Cond", type: "conditions", default: [] },
          },
        },
      },
    ]);
    const out = await buildComponents(site, { only: [ref] });
    const entries = out.report.entries();
    const unsupported = entries.filter((e) => e.code === "component.property-unsupported");
    expect(unsupported.map((e) => [e.where, e.severity, (e.data as Rec).prop])).toEqual([
      [`component:${ref}`, "warn", "pVis01"],
      [`component:${ref}`, "warn", "pCon01"],
    ]);
    expect(entries.filter((e) => e.code === "component.dead-prop")).toEqual([]);
    expect(entries.map((e) => e.message).join("\n")).not.toContain("ignores it too");
    expect(codes(out.report)).not.toContain("component.prop-type-unknown");
  });

  test("instances that differ in a custom property are a warning with their count; one value is not", async () => {
    const make = (id: number, ref: string, values: (string | undefined)[]): LoadedSite =>
      extend(base, [
        {
          id,
          ref,
          slug: `rv-css-${id}`,
          title: `Rv Css ${id}`,
          content: div(ref, `div-cv${id}`),
          meta: { properties: { pCol01: { name: "Tint", type: "color", default: "#111111" } } },
          css: `.div-cv${id}{color:var(--comp-pCol01)}`,
        },
        {
          id: id + 1,
          type: "page",
          ref: "page",
          slug: `rv-css-page-${id}`,
          title: "Page",
          content: values
            .map((v) =>
              instance(
                ref,
                v === undefined
                  ? {}
                  : { properties: { pCol01: { type: "color", value: { maker: v } } } },
              ),
            )
            .join("\n\n"),
        },
      ]);
    const find = (out: ComponentsOutput): { severity: string; data: Rec }[] =>
      out.report
        .entries()
        .filter((e) => e.code === "component.css-variable")
        .map((e) => ({ severity: e.severity, data: e.data as Rec }));

    const refA = "rv0cssa0001";
    const differing = await buildComponents(make(990251, refA, ["#ff0000", "#00ff00", undefined]), {
      only: [refA],
    });
    expect(find(differing)).toMatchObject([
      { severity: "warn", data: { props: ["pCol01"], instances: 3 } },
    ]);
    const refB = "rv0cssb0001";
    const same = await buildComponents(make(990261, refB, ["#ff0000", "#ff0000"]), {
      only: [refB],
    });
    expect(find(same).map((f) => f.severity)).toEqual(["info"]);
    const refC = "rv0cssc0001";
    const single = await buildComponents(make(990271, refC, ["#ff0000"]), { only: [refC] });
    expect(find(single).map((f) => f.severity)).toEqual(["info"]);
  });

  test("a private or password-protected component is a warning: its instances print nothing on the live site", async () => {
    const [a, b] = ["rv0priv0001", "rv0priv0002"] as const;
    const site = extend(base, [
      {
        id: 990281,
        ref: a,
        slug: "rv-priv",
        title: "Rv Priv",
        status: "private",
        content: div(a, "div-pv1"),
      },
      { id: 990282, ref: b, slug: "rv-pass", title: "Rv Pass", content: div(b, "div-pv2") },
    ]);
    site.model.posts.get(990282)!.passwordProtected = true;
    const out = await buildComponents(site, { only: [a, b] });
    const found = out.report.entries().filter((e) => e.code === "component.not-published");
    const at = (ref: string) => found.find((e) => e.where === `component:${ref}`)!;
    expect(found.map((e) => e.severity)).toEqual(["warn", "warn"]);
    expect(at(a).message).toContain("converted page");
    expect(at(a).message).toContain("is private");
    expect(at(b).message).toContain("password");
    expect(out.files.length).toBe(2);
  });

  test("a query inside a component is left out and reported, not written as source text into the page", async () => {
    const ref = "rv0qry00001";
    const post = base.model.posts.get(5307)!;
    const site = extend(base, [
      {
        id: 990291,
        ref,
        slug: "rv-qry",
        title: "Rv Qry",
        content: post.content,
        meta: { properties: {} },
      },
    ]);
    const out = await buildComponents(site, { only: [ref] });
    const doc = docOf(out, "wp-rv-qry");
    expect(JSON.stringify(doc)).not.toContain("const has =");
    expect(doc.state).toBeUndefined();
    expect(codes(out.report)).not.toContain("component.binding-misplaced");
    expect(codes(out.report)).not.toContain("component.state-missing");
    const found = out.report.entries().filter((e) => e.code === "component.query-unsupported");
    expect(found.map((e) => [e.where, e.severity, (e.data as Rec).states])).toEqual([
      [`component:${ref}`, "warn", ["project_entries"]],
    ]);
    expect(out.used.states.size).toBe(0);
    const built = await buildJxProject(
      projectFiles(site, out, { index: [{ tagName: "wp-rv-qry" }] }),
      {
        name: "query-left-out",
      },
    );
    const html = built.html("/");
    expect(html).not.toContain("const has");
    expect(html).not.toContain("${");
  });
});

describe("review: the pieces the fixtures reach only through other calls", () => {
  let base: LoadedSite;
  beforeAll(async () => {
    base = await loadSite("fineline");
  });

  test("stateDefault: image, link, text and number defaults, one at a time", async () => {
    const ctx = await makeCtx("fineline", { kind: "component", ref: "0a275b695a" });
    const meta = (type: string, def: unknown): Parameters<typeof components.stateDefault>[1] => ({
      id: "pX",
      key: "x",
      name: "X",
      type,
      raw: { default: def },
    });
    // an attachment's own alt, size and file
    expect(components.stateDefault(ctx, meta("image", { image: { imageID: "29" } }))).toEqual({
      src: "/media/Screen-Shot-2022-10-08-at-12.49.17-PM.png",
      alt: 'Residential house painting project in Lancaster, PA" или "Interior house painting result in Lebanon, PA',
      width: 527,
      height: 252,
    });
    // an uploads address the media plan knows, then an external one, then none
    expect(
      components.stateDefault(
        ctx,
        meta("image", {
          maker: {
            src: "https://finelinepainting.pro/wp-content/uploads/PaintColorVisualizer.png",
          },
        }),
      ),
    ).toMatchObject({ src: "/media/PaintColorVisualizer.png", width: 1600, height: 1600 });
    expect(
      components.stateDefault(ctx, meta("image", { maker: { src: "https://example.org/a.png" } })),
    ).toEqual({ src: "https://example.org/a.png", alt: "" });
    expect(components.stateDefault(ctx, meta("image", {}))).toEqual({ src: "", alt: "" });
    // `_self` is the browser's own default; a rel and a title are kept
    expect(
      components.stateDefault(
        ctx,
        meta("link", {
          maker: { href: "https://example.org/", target: "_self", rel: "nofollow", title: "T" },
        }),
      ),
    ).toEqual({ href: "https://example.org/", rel: "nofollow", title: "T" });
    expect(
      components.stateDefault(
        ctx,
        meta("link", { maker: { href: "https://example.org/", target: "_blank" } }),
      ),
    ).toEqual({ href: "https://example.org/", target: "_blank" });
    // PHP's `if ($value)`: a text of "0" or 0 is nothing
    expect(components.stateDefault(ctx, meta("text", "0"))).toBe("");
    expect(components.stateDefault(ctx, meta("text", 0))).toBe("");
    expect(components.stateDefault(ctx, meta("text", "0.5"))).toBe("0.5");
    expect(components.stateDefault(ctx, meta("richtext", "0"))).toBe("");
    // a number keeps its zero
    expect(components.stateDefault(ctx, meta("number", "0"))).toBe(0);
    expect(components.stateDefault(ctx, meta("number", { maker: " 2.5 " }))).toBe(2.5);
    expect(components.stateDefault(ctx, meta("number", "auto"))).toBe("auto");
    expect(components.stateDefault(ctx, meta("number", " "))).toBe("");
  });

  test("compVariable spells a property id the way a host style resolves it, on word boundaries", async () => {
    expect(components.compVariable("pCol01")).toBe("--comp-p-col01");
    expect(components.compVariable("abc")).toBe("--comp-abc");
    const ref = "rv0wrd00001";
    const site = extend(base, [
      {
        id: 990301,
        ref,
        slug: "rv-word",
        title: "Rv Word",
        content: div(ref, "div-wd1"),
        meta: {
          properties: {
            pColA: { name: "A", type: "color", default: "red" },
            pColAB: { name: "AB", type: "color", default: "blue" },
          },
        },
        css: ".div-wd1{color:var(--comp-pColA);background:var(--comp-pColAB, var(--comp-pColA))}",
      },
    ]);
    const out = await buildComponents(site, { only: [ref] });
    const doc = docOf(out, "wp-rv-word");
    expect(Object.keys(doc.style as Rec)).toEqual([
      "display",
      "--comp-p-col-a",
      "--comp-p-col-a-b",
    ]);
    const root = (doc.children as JxElement[])[0]!;
    expect((root.style as Rec).color).toBe("var(--comp-p-col-a)");
    expect((root.style as Rec).background).toBe("var(--comp-p-col-a-b, var(--comp-p-col-a))");
  });

  test("a component's description does not carry a binding from its title", async () => {
    const ref = "rv0desc0001";
    const site = extend(base, [
      { id: 990311, ref, slug: "rv-desc", title: "Cost ${x}", content: div(ref, "div-ds1") },
    ]);
    const out = await buildComponents(site, { only: [ref] });
    const description = String(docOf(out, "wp-rv-desc").description);
    expect(description).toContain("Cost $​{x}");
    expect(description).not.toContain("${");
  });

  test("the resolvers a caller hands buildComponents reach the conversion, and a template part keeps its class", async () => {
    const ref = "rv0resl0001";
    const part = `<!-- wp:template-part ${json({ slug: "footer", theme: base.model.site.theme, className: "my-part" })} /-->`;
    const site = extend(base, [
      {
        id: 990321,
        ref,
        slug: "rv-resl",
        title: "Rv Resl",
        content: div(
          ref,
          "div-rs1",
          `<!-- wp:core/shortcode -->\n[contact_form id="3"]\n<!-- /wp:core/shortcode -->${part}`,
        ),
      },
    ]);
    const plain = await buildComponents(site, { only: [ref] });
    const root = (docOf(plain, "wp-rv-resl").children as JxElement[])[0]!;
    expect((root.children as JxElement[]).map((c) => [c.tagName, c.className])).toEqual([
      ["div", "wp2jx-unconverted wp2jx-shortcode"],
      ["wp-footer", "wp-block-template-part my-part"],
    ]);
    const custom = await buildComponents(site, {
      only: [ref],
      resolvers: { shortcode: () => ({ tagName: "aside", textContent: "form here" }) },
    });
    const kids = (
      (docOf(custom, "wp-rv-resl").children as JxElement[])[0]!.children as JxElement[]
    ).map((c) => [c.tagName, c.textContent]);
    expect(kids[0]).toEqual(["aside", "form here"]);
    expect(codes(custom.report)).not.toContain("component.placeholder-neutral");
  });

  test("a renamed classID is renamed in element classes, style keys and hoisted rules, and reported where it happened", async () => {
    const [x, y] = ["rv0rena0001", "rv0rena0002"] as const;
    const site = extend(base, [
      {
        id: 990331,
        ref: x,
        slug: "rv-rena",
        title: "Rv Rena",
        content: div(x, "div-rn1"),
        css: ".div-rn1{color:red;}",
      },
      {
        id: 990332,
        ref: y,
        slug: "rv-renb",
        title: "Rv Renb",
        content: div(y, "div-rn0", div(y, "div-rn1")),
        css: ".div-rn0 .div-rn1{margin:1px;}.div-rn1{color:blue;}:where(.div-rn1 span){padding:2px;}",
      },
    ]);
    const out = await buildComponents(site, { only: [x, y] });
    const renamed = out.report.entries().filter((e) => e.code === "component.scope-renamed");
    expect(renamed.map((e) => e.where)).toEqual([`component:${y}`]);
    const doc = docOf(out, "wp-rv-renb");
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/\.div-rn1(?![\w-])/);
    expect(text).toContain(".div-rn1-wp-rv-renb");
    const outer = (doc.children as JxElement[])[0]!;
    expect(Object.keys(outer.style as Rec)).toContain("& .div-rn1-wp-rv-renb");
    expect(
      Object.keys(doc.style as Rec).some((k) => k.includes(":where(.div-rn1-wp-rv-renb span)")),
    ).toBe(true);
    expect((outer.children as JxElement[])[0]!.className).toBe("div-rn1-wp-rv-renb");
  });

  test("misplacedBindings finds a binding in a nested style of the host and a string at the root", () => {
    const doc = {
      tagName: "x-y",
      style: { display: "contents", ":hover": { color: "${state.a}" } },
      children: [
        "root ${state.b}",
        {
          tagName: "div",
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/z" },
            map: { tagName: "li", id: "i-${state.c}" },
          },
        },
      ],
    } as unknown as JxDocument;
    expect(components.misplacedBindings(doc).map((m) => `${m.path} ${m.position}`)).toEqual([
      "children/0 children",
      "children/1/map/0 id",
      "style style",
    ]);
  });

  test("prepareDocument and finishDocument are what buildComponentDocument does, in two steps", async () => {
    const site = await loadSite("fineline");
    const subject: Subject = { kind: "component", ref: "0a275b695a" };
    const opts = { tagName: "wp-icon-card", description: "Icon Card." };
    const prepared = await components.prepareDocument(site, subject, opts);
    expect(prepared.file).toBe("components/wp-icon-card.json");
    expect([...prepared.variants.keys()].sort()).toEqual(["bmuh8n", "kxrx4"]);
    expect(prepared.instantiated).toEqual([]);
    expect(prepared.where).toBe("component:0a275b695a");
    expect(JSON.stringify(prepared.nodes)).not.toContain('"&.cs-');
    const finished = components.finishDocument(prepared, { ...opts, state: { heading: "H" } });
    const direct = await buildComponentDocument(site, subject, {
      ...opts,
      state: { heading: "H" },
    });
    expect(finished.content).toBe(direct.content);
    expect(finished.doc.state).toEqual({ heading: "H" });
    expect(finished.slots).toBe(0);
    expect(finished.used.documentRules).toEqual([]);
    expect(finished.used.wpClasses.size).toBeGreaterThan(0);
  });
});
