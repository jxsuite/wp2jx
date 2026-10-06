import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCwiclyCss } from "../../src/cwicly/css.ts";
import type { OrderedCssIndex } from "../../src/cwicly/css.ts";
import {
  classListOf,
  editorClassNames,
  savedTags,
  styleBlock,
  whereOf,
  type BlockStyling,
} from "../../src/cwicly/style.ts";
import { attrStyleDetailed } from "../../src/cwicly/attr-style.ts";
import { resolveTokens } from "../../src/cwicly/tokens.ts";
import { createReport } from "../../src/report.ts";
import type { ConvertCtx, JxStyle, WpBlock } from "../../src/types.ts";
import { walkBlocks } from "../../src/wp/blocks.ts";
import {
  allSubjects,
  cssNamesFor,
  loadSite,
  makeCtx,
  subjectBlocks,
  type LoadedSite,
  type SiteName,
  type Subject,
} from "../helpers/ctx.ts";
import { buildJxProject, cleanupJxProjects } from "../helpers/jx-build.ts";

setDefaultTimeout(120_000);

const SITES: SiteName[] = ["fineline", "ap"];
const sites = new Map<SiteName, LoadedSite>();
const ctxs = new Map<string, ConvertCtx>();

const subjectKey = (name: SiteName, subject: Subject): string =>
  `${name}:${JSON.stringify(subject)}`;

/** One context per subject, as the converter would have: made once, shared by every test. */
async function ctxOf(name: SiteName, subject: Subject): Promise<ConvertCtx> {
  const key = subjectKey(name, subject);
  let ctx = ctxs.get(key);
  if (!ctx) {
    ctx = await makeCtx(name, subject);
    ctxs.set(key, ctx);
  }
  return ctx;
}

function findBlock(name: SiteName, subject: Subject, classID: string): WpBlock {
  let found: WpBlock | undefined;
  walkBlocks(subjectBlocks(sites.get(name)!, subject), (block) => {
    if (found === undefined && block.attrs.classID === classID) found = block;
  });
  if (!found) throw new Error(`no block ${classID} in ${JSON.stringify(subject)}`);
  return found;
}

/** Style a real block, and say what it reported. */
async function styleReal(
  name: SiteName,
  subject: Subject,
  classID: string,
  opts: Parameters<typeof styleBlock>[2] = {},
): Promise<{ styling: BlockStyling; codes: string[]; ctx: ConvertCtx }> {
  const ctx = await makeCtx(name, subject);
  const styling = styleBlock(findBlock(name, subject, classID), ctx, opts);
  return { styling, codes: ctx.report.entries().map((e) => e.code), ctx };
}

/** A block as the parser makes it, for the cases no fixture has. */
function block(attrs: Record<string, unknown>, innerHTML: string, name = "cwicly/div"): WpBlock {
  return { name, attrs, innerBlocks: [], innerHTML, innerContent: [innerHTML] };
}

let fl: ConvertCtx;
let ap: ConvertCtx;

beforeAll(async () => {
  for (const name of SITES) sites.set(name, await loadSite(name));
  fl = await ctxOf("fineline", { kind: "post", id: 5246 });
  ap = await ctxOf("ap", { kind: "template", slug: "single-episode" });
});

afterAll(() => cleanupJxProjects());

/** A context of the same site with one extra option, and its own report. */
function withOption(ctx: ConvertCtx, key: string, value: string): ConvertCtx {
  return {
    ...ctx,
    report: createReport(),
    model: { ...ctx.model, options: new Map([...ctx.model.options, [key, value]]) },
  };
}

/** A context whose stylesheets are exactly this text. */
function withCss(ctx: ConvertCtx, css: string): ConvertCtx {
  return { ...ctx, report: createReport(), css: parseCwiclyCss(css, ctx.cwicly.breakpoints) };
}

const fresh = (ctx: ConvertCtx): ConvertCtx => ({ ...ctx, report: createReport() });

const GLOBAL_A = "IEqrS6H6sAxHB53"; // section-default
const GLOBAL_B = "0Z5Yo8LKLV4oPI4"; // button-default

describe("the saved markup", () => {
  test("savedTags lists the elements of a block's own markup in document order", () => {
    expect(
      savedTags('<section class="a b" id="x"><div data-n="1"><span>t</span></div></section>').map(
        (t) => [t.tag, t.attrs.map(([n]) => n)],
      ),
    ).toEqual([
      ["section", ["class", "id"]],
      ["div", ["data-n"]],
      ["span", []],
    ]);
  });

  test("whereOf names the subject the way every report entry does", () => {
    expect(whereOf(fl)).toBe("post:5246");
    expect(whereOf(ap)).toBe("template:cwicly//single-episode");
  });
});

describe("class tokens (render.php's cc_get_dyn)", () => {
  test("{gcl} prints the names of the block's global classes, in order", () => {
    const b = block(
      { classID: "div-c1", globalClass: [GLOBAL_A, GLOBAL_B] },
      '<div class="div-c1 {gcl} cc-sct"></div>',
    );
    const ctx = fresh(fl);
    expect(styleBlock(b, ctx).className).toBe("div-c1 section-default button-default cc-sct");
    expect(ctx.report.entries()).toEqual([]);
  });

  test("a global class id that no longer exists prints nothing and is reported (31 real blocks hold one)", () => {
    const b = block(
      { classID: "div-c1", globalClass: ["3yEPq5XEDBJoOaj", GLOBAL_A] },
      '<div class="div-c1 {gcl}"></div>',
    );
    const ctx = fresh(fl);
    expect(styleBlock(b, ctx).className).toBe("div-c1 section-default");
    expect(ctx.report.entries()).toMatchObject([
      {
        severity: "warn",
        code: "class.dangling-global",
        where: "post:5246",
        data: { globalClass: "3yEPq5XEDBJoOaj", classID: "div-c1", block: "cwicly/div" },
      },
    ]);
  });

  test("{class} is the classID, and nothing else about the tag is touched", () => {
    const b = block({ classID: "div-c1" }, '<div class="{class} x"></div>');
    expect(styleBlock(b, fresh(fl)).className).toBe("div-c1 x");
  });

  test("{acl} prints the additional classes, linked ones by name and the rest through cwicly_classes_add; a hidden one is skipped", () => {
    const ctx = withOption(fl, "cwicly_classes_add", JSON.stringify({ uuid1: "mapped-class" }));
    const b = block(
      {
        classID: "div-c1",
        additionalClass: [
          { value: "linked-class", isLinked: true },
          { value: "uuid1", isLinked: false },
          { value: "uuid-unknown", isLinked: false },
          { value: "hidden-one", isLinked: true, visibility: true },
        ],
      },
      '<div class="div-c1 {acl}"></div>',
    );
    expect(styleBlock(b, ctx).className).toBe("div-c1 linked-class mapped-class");
  });

  test("{sacl} prints the same names with -wrapper, for the old section layout's inner element", () => {
    const b = block(
      { classID: "div-c1", additionalClass: [{ value: "a", isLinked: true }] },
      '<div class="div-c1 {sacl}"></div>',
    );
    expect(styleBlock(b, fresh(fl)).className).toBe("div-c1 a-wrapper");
  });

  test("{cs-index} prints the instance's variant classes, and without them says the element needs them", () => {
    const b = block({ classID: "div-c1" }, '<div class="div-c1{cs-index} {gcl}"></div>');
    const bare = styleBlock(b, fresh(fl));
    expect(bare.className).toBe("div-c1");
    expect(bare.variantClasses).toBe(true);
    const given = styleBlock(b, fresh(fl), { variants: ["v1", "v2"] });
    expect(given.className).toBe("div-c1 cs-v1 cs-v2");
    expect(given.variantClasses).toBe(false);
  });

  test("{aclv} and {gclv} print the classes the selected variants add, once each; =true drops the leading space", () => {
    const b = block(
      {
        classID: "div-c1",
        additionalClassesVariantsR: { v1: ["x", "y"], v2: ["y", "z"], v3: ["no"] },
        globalClassVariant: { v1: [GLOBAL_A], v2: [GLOBAL_B, "gone"] },
      },
      '<div class="div-c1{aclv}{gclv}"></div>',
    );
    expect(styleBlock(b, fresh(fl), { variants: ["v1", "v2"] }).className).toBe(
      "div-c1 x y z section-default button-default",
    );
    // the token itself prints each class once, before any de-duplication of the whole list
    expect(classListOf(b, fresh(fl), { variants: ["v1", "v2"] }).className).toEqual([
      "div-c1",
      "x",
      "y",
      "z",
      "section-default",
      "button-default",
    ]);
    const tight = block(
      { classID: "div-c1", additionalClassesVariantsR: { v1: ["x"] } },
      '<div class="{aclv=true}"></div>',
    );
    expect(styleBlock(tight, fresh(fl), { variants: ["v1"] }).className).toBe("x");
    expect(styleBlock(tight, fresh(fl)).className).toBe("");
  });

  test("{darkmode_force=…} prints the site's dark or light classes", () => {
    const b = block({ classID: "div-c1" }, '<div class="div-c1 {darkmode_force=dark}"></div>');
    expect(styleBlock(b, fresh(fl)).className).toBe("div-c1 dark");
    const light = block({ classID: "div-c1" }, '<div class="{darkmode_force=light}"></div>');
    expect(styleBlock(light, fresh(fl)).className).toBe("light");
  });

  test("{cccomp} prints the classIDs of the component instances around the block, joined", () => {
    const b = block({ classID: "div-c1" }, '<div class="div-c1 x-{cccomp}"></div>');
    expect(styleBlock(b, fresh(fl), { componentClasses: ["a", "b"] }).className).toBe(
      "div-c1 x-a-b",
    );
  });

  test("{component=class=…} is a bound class: ${state.<key>} through ctx.props, or what connectedClass says", () => {
    const b = block({ classID: "div-c1" }, '<div class="div-c1 {component=class=ref1}"></div>');
    const ctx = { ...fresh(fl), props: new Map([["ref1", "extraClass"]]) };
    expect(styleBlock(b, ctx).className).toBe("div-c1 ${state.extraClass}");
    expect(styleBlock(b, ctx, { connectedClass: () => "given" }).className).toBe("div-c1 given");
    // a prop nobody knows is a token like any other, and is dropped with a report
    const lost = fresh(fl);
    expect(styleBlock(b, lost).className).toBe("div-c1");
    expect(lost.report.entries().map((e) => e.code)).toEqual(["class.token-dropped"]);
  });

  test("{currentpageclass=…} marks a link to the page being shown, which has no static value: dropped and reported", () => {
    const b = block(
      { classID: "div-c1" },
      '<a class="div-c1 {currentpageclass=195=post-type=page}"></a>',
    );
    const ctx = fresh(fl);
    expect(styleBlock(b, ctx).className).toBe("div-c1");
    expect(ctx.report.entries()).toMatchObject([
      { severity: "info", code: "class.current-page", data: { link: "195=post-type=page" } },
    ]);
  });

  test("a token that belongs to the dynamic-data module goes to resolveTokens; without it, or when it comes back unchanged, it is dropped", () => {
    const b = block({ classID: "div-c1" }, '<div class="div-c1 {imagealt=785}"></div>');
    const ctx = fresh(fl);
    expect(styleBlock(b, ctx, { resolveTokens: () => "resolved" }).className).toBe(
      "div-c1 resolved",
    );
    expect(styleBlock(b, ctx, { resolveTokens: (t) => t }).className).toBe("div-c1");
    expect(styleBlock(b, ctx).className).toBe("div-c1");
    expect(ctx.report.entries().map((e) => e.code)).toEqual([
      "class.token-dropped",
      "class.token-dropped",
    ]);
  });

  test("{idadd} and {loop-id} print nothing (and are not reported), an empty {} is left alone, and JSON braces are not tokens", () => {
    const b = block({ classID: "div-c1" }, '<div class="div-c1{idadd}{loop-id} {}"></div>');
    const ctx = fresh(fl);
    expect(styleBlock(b, ctx).className).toBe("div-c1 {}");
    expect(ctx.report.entries()).toEqual([]);
    const json = block({ classID: "div-c1" }, `<div class='div-c1 {"a":1}'></div>`);
    expect(styleBlock(json, ctx).className).toBe('div-c1 {"a":1}');
    expect(ctx.report.entries()).toEqual([]);
  });
});

describe("the class list", () => {
  test("the classID is first, even when the markup prints it later, and appears once", () => {
    const ctx = withCss(fl, ".div-c1{color:red}");
    const b = block(
      { classID: "div-c1", isStyling: true },
      '<div class="alignfull div-c1 {gcl} div-c1"></div>',
    );
    expect(styleBlock(b, ctx).className).toBe("div-c1 alignfull");
  });

  test("a styled block whose tag prints no classID gets it, first, with a report (a rule on a shared class would leak)", () => {
    const ctx = withCss(fl, ".div-c1{color:red}");
    const b = block(
      { classID: "div-c1", isStyling: true, globalClass: [GLOBAL_A] },
      '<div class="{gcl} cc-sct"></div>',
    );
    const styling = styleBlock(b, ctx);
    expect(styling.className).toBe("div-c1 section-default cc-sct");
    expect(styling.style).toEqual({ color: "red" });
    expect(styling.styledDepth).toBe(-1);
    expect(ctx.report.entries().map((e) => e.code)).toEqual(["style.classid-not-printed"]);
  });

  test("a block with no style keeps what the tag printed, and does not gain a classID", () => {
    const b = block(
      { classID: "div-c1", globalClass: [GLOBAL_A] },
      '<div class="{gcl} cc-sct"></div>',
    );
    const styling = styleBlock(b, fresh(fl));
    expect(styling.className).toBe("section-default cc-sct");
    expect(styling.style).toEqual({});
    expect(styling.source).toBe("none");
  });

  test("a classID that is not a plain class name cannot scope a style: reported", () => {
    const ctx = withCss(fl, ".a{color:red}");
    const b = block({ classID: "weird.class" }, '<div class="weird.class"></div>');
    const styling = styleBlock(b, ctx);
    expect(styling.className).toBe("weird.class");
    expect(ctx.report.entries().map((e) => e.code)).not.toContain("style.no-scope");
    const styled = block(
      { classID: "weird.class", isStyling: true, marginTop: { lg: "1px" } },
      '<div class="weird.class"></div>',
    );
    const loud = fresh(fl);
    styleBlock(styled, loud);
    expect(loud.report.entries().map((e) => e.code)).toContain("style.no-scope");
  });

  test("the element that carries the classID is the styled one: a link-wrapped image is <a><img class=classID>", () => {
    const b = block(
      { classID: "img-c1", globalClass: [GLOBAL_B] },
      '<a class="cc-lightbox" href="/x"><img class="img-c1 {gcl}" src="/y.png"/></a>',
      "cwicly/image",
    );
    const styling = styleBlock(b, fresh(fl));
    expect(styling.styledDepth).toBe(1);
    expect(styling.tag).toBe("img");
    expect(styling.className).toBe("img-c1 button-default");
    expect(styling.wrappers.map((w) => [w.tag, w.className, w.attributes.href])).toEqual([
      ["a", "cc-lightbox", "/x"],
    ]);
    expect(styling.element?.attributes.src).toBe("/y.png");
  });

  test("when two elements carry the classID the first is the styled one", () => {
    const b = block({ classID: "c1" }, '<div class="c1 a"><span class="c1 b"></span></div>');
    const styling = styleBlock(b, fresh(fl));
    expect(styling).toMatchObject({ styledDepth: 0, className: "c1 a", tag: "div" });
    expect(styling.inner.map((e) => e.className)).toEqual(["c1 b"]);
  });

  test("duplicates are dropped whatever they are, and an unstyled block's classID still leads", () => {
    expect(
      styleBlock(block({ classID: "c1" }, '<div class="a a b"></div>'), fresh(fl)).className,
    ).toBe("a b");
    expect(
      styleBlock(block({ classID: "c1" }, '<div class="alignfull c1 b"></div>'), fresh(fl))
        .className,
    ).toBe("c1 alignfull b");
  });

  test("a block with no markup at all has the editor's own list (a code block, a component's slot)", () => {
    const styling = styleBlock(block({ classID: "sec-c1" }, "", "cwicly/section"), fresh(fl));
    expect(styling.tag).toBeUndefined();
    expect(styling.className).toBe("cc-sct");
  });

  test("a core block and a component instance are not styled here", () => {
    expect(styleBlock(block({}, "<p>x</p>", "core/paragraph"), fresh(fl))).toMatchObject({
      className: "",
      style: {},
      source: "none",
      styledDepth: -1,
    });
    const instance = block(
      { classID: "comp-c1", ref: "0a275b695a" },
      "<div></div>",
      "cwicly/component",
    );
    expect(styleBlock(instance, fresh(fl)).className).toBe("");
    expect(styleBlock({ ...instance, name: null }, fresh(fl)).className).toBe("");
  });

  test("classListOf is the class list and depth styleBlock starts from, tokens resolved", () => {
    const b = block(
      { classID: "img-c1", globalClass: [GLOBAL_A] },
      '<a class="cc-lightbox"><img class="img-c1 {gcl}"/></a>',
      "cwicly/image",
    );
    expect(classListOf(b, fresh(fl))).toEqual({
      className: ["img-c1", "section-default"],
      styledDepth: 1,
      tag: "img",
      wrappers: [["cc-lightbox"]],
    });
  });
});

describe("editorClassNames is the editor's own builder, and agrees with every saved tag", () => {
  test("from attributes alone: structural classes, additional classes, dark mode, overlay, hover animation", () => {
    const b = block(
      {
        classID: "section-c1",
        isStyling: true,
        additionalClassesR: "extra one",
        globalClass: [GLOBAL_A],
        hoverAnimation: "cc-pop",
        darkModeForce: "dark",
        backgroundOverlayColor: { lg: "#00000087" },
      },
      "",
      "cwicly/section",
    );
    expect(editorClassNames(b, fresh(fl)).join(" ")).toBe(
      "section-c1 extra one section-default cc-pop cc-sct dark cc-ovrl",
    );
  });

  test("a block with no style prints no classID, unless forced or the site keeps ids on every block", () => {
    const plain = block({ classID: "p-c1" }, "", "cwicly/paragraph");
    expect(editorClassNames(plain, fresh(fl))).toEqual([]);
    expect(
      editorClassNames({ ...plain, attrs: { ...plain.attrs, forceShowClass: true } }, fresh(fl)),
    ).toEqual(["p-c1"]);
    const keepsIds = withOption(fl, "cwicly_optimise", "x");
    keepsIds.cwicly = {
      ...fl.cwicly,
      optimise: { ...fl.cwicly.optimise, removeIDsClasses: false },
    };
    expect(editorClassNames(plain, keepsIds)).toEqual(["p-c1"]);
  });

  test("with the site's built-in defaults off, a button, icon, image and the rest carry their cc-* class", () => {
    for (const [name, cls] of [
      ["button", "cc-btn"],
      ["icon", "cc-icn"],
      ["image", "cc-img"],
      ["accordion", "cc-acd"],
      ["video", "cc-vid"],
      ["column", "cc-clmn"],
    ] as const) {
      expect(
        editorClassNames(block({ classID: "c-c1", isStyling: true }, "", `cwicly/${name}`), ap),
      ).toContain(cls);
      expect(
        editorClassNames(block({ classID: "c-c1", isStyling: true }, "", `cwicly/${name}`), fl),
      ).not.toContain(cls);
    }
  });

  test("galleries default to the grid type, tabs and accordions carry their state token, a modal its own class", () => {
    expect(
      editorClassNames(
        block({ classID: "g-c1", isStyling: true }, "", "cwicly/gallery"),
        fresh(fl),
      ),
    ).toContain("cc-grid");
    expect(
      editorClassNames(
        block({ classID: "g-c1", isStyling: true, galleryType: "masonry" }, "", "cwicly/gallery"),
        fresh(fl),
      ),
    ).toContain("cc-masonry");
    expect(
      editorClassNames(
        block({ classID: "a-c1", isStyling: true, accordionOpen: true }, "", "cwicly/accordion"),
        fresh(fl),
      ),
    ).toContain("cc-accordion-active");
    expect(
      editorClassNames(
        block({ classID: "a-c1", isStyling: true }, "", "cwicly/accordion"),
        fresh(fl),
      ),
    ).toContain("cc-accordion-hidden");
    expect(
      editorClassNames(block({ classID: "m-c1", isStyling: true }, "", "cwicly/modal"), fresh(fl)),
    ).toContain("cc-modaler");
  });

  test("every block of both sites that prints a tag: the editor's list is the saved tag's, resolved (5,929 blocks)", async () => {
    let compared = 0;
    for (const name of SITES) {
      const site = sites.get(name)!;
      for (const subject of allSubjects(site)) {
        const ctx = await ctxOf(name, subject);
        walkBlocks(subjectBlocks(site, subject), (b) => {
          if (!b.name?.startsWith("cwicly/")) return;
          const saved = classListOf(b, ctx);
          if (saved.tag === undefined) return;
          compared++;
          const mine = editorClassNames(b, ctx).join(" ");
          const styled = saved.className.join(" ");
          const root = saved.styledDepth <= 0 ? styled : (saved.wrappers[0] ?? []).join(" ");
          expect([styled, root]).toContain(mine);
        });
      }
    }
    expect(compared).toBe(5929);
  });
});

// ── The live pages ───────────────────────────────────────────────────────────────────────────────

interface LivePage {
  file: string;
  /** The cc-post/tp/cm/rb stylesheets the page links. */
  css: Set<string>;
  /** First class → every class list an element with that first class has. */
  lists: Map<string, Set<string>>;
}

function livePages(name: SiteName): LivePage[] {
  const dir = join(import.meta.dir, "../fixtures", name, "html");
  const pages: LivePage[] = [];
  for (const file of readdirSync(dir)) {
    const html = readFileSync(join(dir, file), "utf8");
    const lists = new Map<string, Set<string>>();
    for (const m of html.matchAll(/<([a-zA-Z][\w:-]*)\s([^>]*?)>/g)) {
      const cm = /\sclass="([^"]*)"/.exec(` ${m[2]!}`);
      if (!cm) continue;
      const names = cm[1]!.split(/\s+/).filter(Boolean);
      const first = names[0]!;
      const set = lists.get(first) ?? new Set<string>();
      set.add(names.join(" "));
      lists.set(first, set);
    }
    const css = new Set(
      [...html.matchAll(/\/css\/(cc-(?:post|tp|cm|rb)-[^"'?\s]+\.css)/g)].map((m) => m[1]!),
    );
    pages.push({ file, css, lists });
  }
  return pages;
}

/** What the page's own scripts add to an element after the server printed it, and a loop's per-item suffixes. */
const RUNTIME =
  /^(?:cc-loading-skeleton.*|current|cc-active|cc-mdl-active|cc-nav-.*active.*|cc-ccloop.*)$/;
const strip = (list: string): string =>
  list
    .split(" ")
    .filter((c) => !RUNTIME.test(c))
    .join(" ")
    .replace(/-q-\d+|-r-\d+|-c-\d+/g, "");

const subjectCss = (site: LoadedSite, subject: Subject): string =>
  subject.kind === "post"
    ? `cc-post-${subject.id}.css`
    : subject.kind === "template" || subject.kind === "part"
      ? `cc-tp-${site.model.site.theme}_${subject.slug}.css`
      : subject.kind === "component"
        ? `cc-cm-${subject.ref}.css`
        : `cc-rb-${subject.id}.css`;

describe("against the live pages (rendered HTML is the ground truth)", () => {
  interface Outcome {
    sets: number;
    equal: number;
    /** `file classID` of every class list that differs. */
    different: string[];
    /** classIDs of the subjects' blocks that the live page does not show at all. */
    absent: number;
  }

  async function compare(name: SiteName): Promise<Outcome> {
    const site = sites.get(name)!;
    const out: Outcome = { sets: 0, equal: 0, different: [], absent: 0 };
    for (const page of livePages(name)) {
      const predicted = new Map<string, Set<string>>();
      for (const subject of allSubjects(site)) {
        if (!page.css.has(subjectCss(site, subject))) continue;
        const ctx = await ctxOf(name, subject);
        walkBlocks(subjectBlocks(site, subject), (b) => {
          const id = b.attrs.classID;
          if (
            !b.name?.startsWith("cwicly/") ||
            b.name === "cwicly/component" ||
            typeof id !== "string" ||
            !id
          )
            return;
          const set = predicted.get(id) ?? new Set<string>();
          set.add(styleBlock(b, ctx).className);
          predicted.set(id, set);
        });
      }
      for (const [id, mine] of predicted) {
        const live = page.lists.get(id);
        if (!live) {
          out.absent++;
          continue;
        }
        out.sets++;
        const a = new Set([...live].map(strip));
        const b = new Set([...mine].map(strip));
        if (a.size === b.size && [...a].every((x) => b.has(x))) out.equal++;
        else out.different.push(`${page.file} ${id}`);
      }
    }
    return out;
  }

  test("ap: the class list of every block that the live pages show is exactly what styleBlock gives (471 of 471)", async () => {
    const out = await compare("ap");
    expect(out.sets).toBe(471);
    expect(out.different).toEqual([]);
    expect(out.equal).toBe(471);
  });

  test("fineline: 596 of 600 equal; the four that differ are rendered later than the database rows were read", async () => {
    const out = await compare("fineline");
    expect(out.sets).toBe(600);
    expect(out.equal).toBe(596);
    // Edited since the rows were taken: a global class gone from a block, an overlay added to a section.
    expect(out.different.toSorted()).toEqual([
      "about-us.html div-caff02e",
      "about-us.html image-c6194e7",
      "about-us.html section-c4b395c",
      "blog.html querytemplate-c2c5b6d",
    ]);
  });

  test("a live element for every classID the pages print: the pages and the rows are the same site", async () => {
    // 40 + 327 blocks of the rows have no element on the six pages (parts a page does not use, loops
    // that rendered fewer items, conditions that hid them).
    const [a, b] = await Promise.all([compare("fineline"), compare("ap")]);
    expect([a.absent, b.absent]).toEqual([40, 327]);
  });

  test("every class the live element prints that styleBlock does not is a runtime one or a known edit", async () => {
    for (const name of SITES) {
      const site = sites.get(name)!;
      for (const page of livePages(name)) {
        for (const subject of allSubjects(site)) {
          if (!page.css.has(subjectCss(site, subject))) continue;
          const ctx = await ctxOf(name, subject);
          walkBlocks(subjectBlocks(site, subject), (b) => {
            const id = b.attrs.classID;
            if (
              !b.name?.startsWith("cwicly/") ||
              b.name === "cwicly/component" ||
              typeof id !== "string"
            )
              return;
            const mine = styleBlock(b, ctx).className.split(" ");
            // the classID is first in both: the property Jx's scoping rests on
            for (const list of page.lists.get(id) ?? []) {
              if (id && mine[0] === id) expect(list.split(" ")[0]).toBe(id);
            }
          });
        }
      }
    }
  });
});

// ── The index, nested keys, custom CSS ───────────────────────────────────────────────────────────

describe("style from the stylesheets", () => {
  test("the block's own rule, cloned: editing the result leaves the index alone", async () => {
    const { styling, ctx } = await styleReal(
      "fineline",
      { kind: "post", id: 5246 },
      "section-c93760b",
    );
    expect(styling.source).toBe("index");
    expect(styling.style).toEqual({
      position: "relative",
      display: "flex",
      flexDirection: "column",
    });
    styling.style.color = "red";
    expect(ctx.css.classes.get("section-c93760b")!.style.color).toBeUndefined();
  });

  test("a component variant rule (.classID.cs-variant) is a nested key that keeps its specificity, the ids listed", async () => {
    const { styling } = await styleReal(
      "fineline",
      { kind: "component", ref: "0a275b695a" },
      "div-cf3ac5e",
    );
    expect(styling.style["&.cs-bmuh8n"]).toEqual({
      flexBasis: "calc(33% - 3rem)",
      "@--md": { flexBasis: "calc(50% - 2rem)" },
      "@--sm": { flexBasis: "100%" },
    });
    expect(styling.style["&.cs-kxrx4"]).toEqual({
      flexBasis: "calc(50% - 2rem)",
      "@--sm": { flexBasis: "100%" },
    });
    expect(styling.variants).toEqual(["bmuh8n", "kxrx4"]);
    expect(styling.variantClasses).toBe(true);
    expect(styling.className).toBe("div-cf3ac5e");
  });

  test("an instance's variant switches the class on, and the rules stay where they are", async () => {
    const { styling } = await styleReal(
      "fineline",
      { kind: "component", ref: "0a275b695a" },
      "div-cf3ac5e",
      {
        variants: ["bmuh8n"],
      },
    );
    expect(styling.className).toBe("div-cf3ac5e cs-bmuh8n");
    expect(styling.variantClasses).toBe(false);
    expect(Object.keys(styling.style)).toContain("&.cs-kxrx4");
  });

  test("a second class beside the classID (.classID.cc-masonry) is a nested key too", async () => {
    const { styling } = await styleReal(
      "ap",
      { kind: "part", slug: "footer" },
      "querytemplate-cf01409",
    );
    expect(styling.className).toBe("querytemplate-cf01409 cc-masonry");
    expect(styling.style["&.cc-masonry"]).toMatchObject({
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      columnGap: "10px",
    });
  });

  test("an ancestor condition (.a.b .classID) becomes :is(), which weighs what the selector weighed; a block with only such a rule is still from the index", async () => {
    const { styling } = await styleReal(
      "ap",
      { kind: "template", slug: "index" },
      "query-episodes",
    );
    expect(styling.style).toEqual({
      "&:is(.query-container.filter-visible *)": {
        "@--sm": {
          position: "absolute",
          top: "0rem",
          left: "0rem",
          zIndex: "1",
          overflow: "hidden",
          marginRight: "0.03rem",
        },
      },
    });
    expect(styling.source).toBe("index");
  });

  test("a rule that names the block inside :where() is hoisted whole (zero specificity cannot be written as a key) and reported", async () => {
    const { styling, codes } = await styleReal(
      "fineline",
      { kind: "part", slug: "header" },
      "nav-c0498d1",
    );
    expect(styling.hoisted).toEqual([
      { selector: ":where(.nav-c0498d1 .cc-nav-toggle)", style: { display: "none" } },
    ]);
    expect(codes).toEqual(["style.hoisted"]);
    expect(styling.style).not.toHaveProperty(":where(.nav-c0498d1 .cc-nav-toggle)");
  });

  test("a selector that names the classID in two compounds cannot be a key: reported, not guessed", () => {
    const ctx = withCss(fl, ".x.c .c{color:red}");
    const b = block({ classID: "c" }, '<div class="c"></div>');
    expect(styleBlock(b, ctx)).toMatchObject({ style: {}, source: "none" });
    expect(ctx.report.entries()).toMatchObject([
      { severity: "warn", code: "style.selector-unsupported", data: { selector: ".x.c .c" } },
    ]);
  });

  test("a tag in front of the class is :is(tag), so the rule keeps its weight; a pseudo-element stays last", () => {
    const ctx = withCss(
      fl,
      'a.c:hover svg{fill:red} .x.p .c::before{content:""} .x.p .c.on:hover::after{x:y}',
    );
    const b = block({ classID: "c" }, '<a class="c"></a>');
    const styling = styleBlock(b, ctx);
    expect(styling.style).toEqual({
      "&:is(a):hover svg": { fill: "red" },
      "&:is(.x.p *)::before": { content: '""' },
      "&:is(.x.p *).on:hover::after": { x: "y" },
    });
  });

  test("a tag on the block's own compound under an ancestor is :is(tag) too", () => {
    const ctx = withCss(fl, ".x.p a.c{color:red}");
    expect(styleBlock(block({ classID: "c" }, '<a class="c"></a>'), ctx).style).toEqual({
      "&:is(.x.p *):is(a)": { color: "red" },
    });
  });

  test("two classes in the first compound with descendants: .classID.cc-icon-list li::before", async () => {
    const { styling } = await styleReal("fineline", { kind: "post", id: 6327 }, "list-cba37af");
    expect(styling.style["&.cc-icon-list li::before"]).toMatchObject({
      position: "relative",
      backgroundColor: "var(--cc-color-1)",
    });
  });

  test("the nested keys are exactly what Jx writes: built, they are the selectors Cwicly's own stylesheet had", async () => {
    const site = await buildJxProject({
      "project.json": {
        name: "t",
        url: "https://example.com",
        $media: { "--": "1366px", "--md": "(max-width: 992px)", "--sm": "(max-width: 576px)" },
      },
      "pages/index.json": {
        title: "t",
        children: [
          {
            tagName: "div",
            className: "div-c1 cs-v1",
            style: {
              position: "relative",
              "&.cs-v1": { flexBasis: "1px", "@--md": { flexBasis: "2px" } },
              "&:is(.a.b *)": { color: "red" },
              "&:is(a) a": { color: "blue" },
              "&:is(.p > *) svg": { fill: "x" },
              "&.cc-icon-list li::before": { content: '""' },
            },
            textContent: "hi",
          },
        ],
      },
    });
    const html = site.html("/");
    for (const rule of [
      ".div-c1 { position: relative }",
      ".div-c1.cs-v1 { flex-basis: 1px }",
      "@media (max-width: 992px) { .div-c1.cs-v1 { flex-basis: 2px } }",
      ".div-c1:is(.a.b *) { color: red }",
      ".div-c1:is(a) a { color: blue }",
      ".div-c1:is(.p > *) svg { fill: x }",
      '.div-c1.cc-icon-list li::before { content: "" }',
    ]) {
      expect(html).toContain(rule);
    }
  });
});

describe("the index's trees and its ordered layers", () => {
  test("a block's own selector is declared in one stylesheet, so the per-class tree and the file-order layers say the same (0 of 4,964 on fineline, 1 of 965 on ap, identical)", async () => {
    const counts: Record<string, { multi: number; differing: number }> = {};
    for (const name of SITES) {
      const site = sites.get(name)!;
      const tally = { multi: 0, differing: 0 };
      for (const subject of allSubjects(site)) {
        const ctx = await ctxOf(name, subject);
        const rules = (ctx.css as OrderedCssIndex).rules;
        walkBlocks(subjectBlocks(site, subject), (b) => {
          const id = b.attrs.classID;
          if (typeof id !== "string" || !b.name?.startsWith("cwicly/")) return;
          const layers = new Map<number, string>();
          for (const r of rules) {
            if (r.selector === `.${id}`) {
              layers.set(
                r.layer,
                `${layers.get(r.layer) ?? ""}|${JSON.stringify([r.context, r.declarations])}`,
              );
            }
          }
          if (layers.size > 1) {
            tally.multi++;
            if (new Set(layers.values()).size > 1) tally.differing++;
          }
        });
      }
      counts[name] = tally;
    }
    expect(counts).toEqual({
      fineline: { multi: 0, differing: 0 },
      ap: { multi: 1, differing: 0 },
    });
  });
});

describe("customCSS and customSCSS", () => {
  test("the attribute the plugin prints, tokens replaced: .blockclass is the classID (live: .image-c914dc4 { aspect-ratio: 16 / 9;})", async () => {
    const { styling } = await styleReal(
      "ap",
      { kind: "template", slug: "single-post" },
      "image-c914dc4",
    );
    expect(styling.style.aspectRatio).toBe("16 / 9");
  });

  test("the compiled text wins when the option is on, and a descendant rule is a nested key (…a:after is ::after)", async () => {
    const { styling } = await styleReal(
      "ap",
      { kind: "template", slug: "single-episode" },
      "taxonomyterms-episodes",
    );
    expect(styling.style["& div:not(:last-child) a::after"]).toEqual({ content: '", "' });
  });

  test("!important survives, and the rule lands on the block's own tree", async () => {
    const { styling } = await styleReal("ap", { kind: "part", slug: "header" }, "menu-ccb55e8");
    expect(styling.style["& a:hover"]).toEqual({ color: "var(--cc-color-2) !important" });
  });

  test("an id selector is an ancestor condition: #query-projects .classID", () => {
    const ctx = fresh(fl);
    const b = block(
      {
        classID: "button-c1",
        id: "button-1",
        customCSS: "#query-projects .blockclass{display:block !important}",
      },
      '<a class="button-c1"></a>',
    );
    expect(styleBlock(b, ctx).style).toEqual({
      "&:is(#query-projects *)": { display: "block !important" },
    });
    expect(ctx.report.entries()).toEqual([]);
  });

  test("a block with only customSCSS has no custom CSS: render.php tests customCSS first, so that text is never printed on the live site", async () => {
    const ctx = await makeCtx("fineline", { kind: "template", slug: "archive-project" });
    const b = findBlock(
      "fineline",
      { kind: "template", slug: "archive-project" },
      "button-c7de396",
    );
    expect(b.attrs.customSCSS).toBe("#query-projects .button-c7de396{display:block !important}\n");
    expect(b.attrs.customCSS).toBeUndefined();
    expect(styleBlock(b, ctx).style).not.toHaveProperty("&:is(#query-projects *)");
  });

  test("@keyframes cannot live in an element's style: hoisted, with the at-rule head as the selector", async () => {
    const { styling } = await styleReal(
      "ap",
      { kind: "template", slug: "wp-custom-template-about-us" },
      "header-about",
    );
    expect(styling.hoisted.map((h) => h.selector)).toEqual([
      "@keyframes fade-in",
      "@keyframes background-blur",
    ]);
    expect(styling.hoisted[0]!.style).toEqual({ "0%": { opacity: "0" }, "100%": { opacity: "1" } });
  });

  test("custom CSS written as SCSS and never compiled is compiled here, with a report; what cannot be compiled is reported and left out", () => {
    const ctx = withOption(fl, "cwicly_scss_compiler", "");
    const b = block(
      {
        classID: "div-c1",
        id: "div-c1",
        customCSS:
          ".blockclass { color: red; // note\n  &:hover { color: blue } .x { margin: $nope * 2; padding: 1px } }",
      },
      '<div class="div-c1"></div>',
    );
    const styling = styleBlock(b, ctx);
    expect(styling.style).toEqual({
      color: "red",
      ":hover": { color: "blue" },
      "& .x": { padding: "1px" },
    });
    expect(ctx.report.entries().map((e) => e.code)).toEqual([
      "style.scss-compiled",
      "style.scss-unsupported",
      "style.scss-unsupported",
    ]);
  });

  test("the SCSS option is read as PHP reads it: any stored value but '' and '0' is on", () => {
    const b = block(
      {
        classID: "c1",
        id: "x",
        customCSS: ".blockclass{color:red}",
        customSCSS: ".blockclass{color:blue}",
      },
      '<div class="c1"></div>',
    );
    for (const [value, color] of [
      ["true", "blue"],
      ["1", "blue"],
      ["false", "blue"],
      ["0", "red"],
      ["", "red"],
    ] as const) {
      expect(styleBlock(b, withOption(fl, "cwicly_scss_compiler", value)).style.color, value).toBe(
        color,
      );
    }
    const options = new Map(fl.model.options);
    options.delete("cwicly_scss_compiler");
    const missing = { ...fl, report: createReport(), model: { ...fl.model, options } };
    expect(styleBlock(b, missing).style.color).toBe("red");
  });

  test("a line break between two tokens glues them, as it does when render.php prints the CSS", () => {
    const b = block(
      { classID: "c1", id: "x", customCSS: ".blockclass\n.x { color: red }" },
      '<div class="c1"></div>',
    );
    expect(styleBlock(b, fresh(fl)).style).toEqual({ "&.x": { color: "red" } });
  });

  test("a variant rule in the stylesheet and one in custom CSS merge under the same key", () => {
    const ctx = withCss(fl, ".c1.cs-v1{flex-basis:1px}");
    const b = block(
      { classID: "c1", id: "x", customCSS: ".blockclass.cs-v1{color:red}" },
      '<div class="c1"></div>',
    );
    expect(styleBlock(b, ctx).style).toEqual({ "&.cs-v1": { flexBasis: "1px", color: "red" } });
  });

  test("breakpoint words in custom CSS become the site's widths, and media queries land on the @--key the site declares", () => {
    const b = block(
      {
        classID: "div-c1",
        id: "div-c1",
        customCSS: "@media screen and (media-breakpoint-md){ .blockclass { color: pink } }",
      },
      '<div class="div-c1"></div>',
    );
    expect(styleBlock(b, fresh(fl)).style).toEqual({ "@--md": { color: "pink" } });
  });

  test("a rule for another class is hoisted, and #blockid in custom CSS is reported when the block prints no id", () => {
    const ctx = fresh(fl);
    const b = block(
      {
        classID: "div-c1",
        id: "div-1c",
        customCSS: "#blockid { color: red } .other { margin: 0 }",
      },
      '<div class="div-c1"></div>',
    );
    const styling = styleBlock(b, ctx);
    expect(styling.hoisted).toEqual([
      { selector: ".other", style: { margin: "0" } },
      { selector: "#div-1c", style: { color: "red" } },
    ]);
    expect(ctx.report.entries().map((e) => e.code)).toEqual(["style.blockid-not-printed"]);
  });

  test("a stylesheet artifact in custom CSS is reported, not emitted", () => {
    const ctx = fresh(fl);
    const b = block(
      {
        classID: "div-c1",
        id: "x",
        customCSS: ".blockclass { width: [object Object]px; color: red }",
      },
      '<div class="div-c1"></div>',
    );
    expect(styleBlock(b, ctx).style).toEqual({ color: "red" });
    expect(ctx.report.entries().map((e) => e.code)).toEqual(["css.artifact"]);
  });
});

// ── The fallback ────────────────────────────────────────────────────────────────────────────────

describe("style from the attributes (a stylesheet the source did not have)", () => {
  test("a styled block with no rule in the index is computed from its attributes and reported", () => {
    const ctx = fresh(fl);
    const b = block(
      { classID: "div-c1", isStyling: true, marginTop: { lg: "3rem", lghover: "1rem" } },
      '<div class="div-c1"></div>',
    );
    const styling = styleBlock(b, ctx);
    expect(styling.source).toBe("attributes");
    expect(styling.style).toEqual({
      marginTop: "3rem",
      position: "relative",
      display: "flex",
      ":hover": { marginTop: "1rem" },
    });
    expect(ctx.report.entries()).toMatchObject([
      { severity: "info", code: "style.fallback", data: { classID: "div-c1" } },
    ]);
  });

  test("a styled block with no classID has nothing to scope to: Cwicly's rules for it are under an empty class name and match nothing", async () => {
    const subject: Subject = { kind: "post", id: 5272 };
    const ctx = fresh(await ctxOf("fineline", subject));
    let heading: WpBlock | undefined;
    walkBlocks(subjectBlocks(sites.get("fineline")!, subject), (b) => {
      if (b.name === "cwicly/heading" && b.attrs.classID === "") heading ??= b;
    });
    expect(heading).toBeDefined();
    expect(heading!.attrs.classID).toBe("");
    const styling = styleBlock(heading!, ctx);
    expect(styling).toMatchObject({ source: "none", style: {} });
    expect(styling.className).toBe("featured-heading");
    expect(ctx.report.entries().map((e) => e.code)).toEqual(["style.no-classid"]);
  });

  test("the fallback prints a relative style's compiled extras exactly when the SCSS option is on (PHP truthiness)", () => {
    const b = block(
      {
        classID: "c1",
        isStyling: true,
        relativeStyles: [
          { id: "R1", rules: [{ selectorType: "class", selector: "x", combinator: " " }] },
        ],
        customCSSExtras: { rslgR1: ".relativestyle{color:red}" },
        customSCSSExtras: { rslgR1: ".relativestyle{color:blue}" },
      },
      '<div class="c1"></div>',
    );
    const colour = (value: string): unknown =>
      (styleBlock(b, withOption(fl, "cwicly_scss_compiler", value)).style["& .x"] as JxStyle).color;
    expect([colour("1"), colour("true"), colour("0"), colour("")]).toEqual([
      "blue",
      "blue",
      "red",
      "red",
    ]);
  });

  test("a block that is not styled has no style, and nothing to report", () => {
    const ctx = fresh(fl);
    const b = block({ classID: "div-c1" }, '<div class="div-c1"></div>');
    expect(styleBlock(b, ctx)).toMatchObject({ source: "none", style: {} });
    expect(ctx.report.entries()).toEqual([]);
  });

  test("the index wins over the attributes whenever it has a rule", () => {
    const ctx = withCss(fl, ".div-c1{color:red}");
    const b = block(
      { classID: "div-c1", isStyling: true, marginTop: { lg: "1px" } },
      '<div class="div-c1"></div>',
    );
    expect(styleBlock(b, ctx)).toMatchObject({ source: "index", style: { color: "red" } });
  });

  test("attributes no family reads are reported by name, a palette id that does not exist too", () => {
    const ctx = fresh(fl);
    const b = block(
      {
        classID: "div-c1",
        isStyling: true,
        menuMainMenuGap: { lg: "30px" },
        fontTextColor: { lg: "!var=nonesuch!" },
        fontSize: { lg: { type: "fluid" } },
      },
      '<div class="div-c1"></div>',
      "cwicly/menu",
    );
    styleBlock(b, ctx);
    expect(ctx.report.entries().map((e) => [e.code, e.severity])).toEqual([
      ["style.fallback", "info"],
      ["style.attr-unsupported", "warn"],
      ["style.palette-unresolved", "warn"],
      ["style.attr-unsupported", "info"],
    ]);
    expect(ctx.report.entries()[1]!.data).toMatchObject({ attributes: ["menuMainMenuGap"] });
    expect(ctx.report.entries()[2]!.data).toMatchObject({ palette: "nonesuch" });
  });

  test("component variants of a component's child are styled from its attributes too", async () => {
    const ctx = fresh(await ctxOf("fineline", { kind: "component", ref: "0a275b695a" }));
    const own = ctx.components.get("0a275b695a")!;
    expect(own.variants.map((v) => v.id)).toEqual(["bmuh8n", "kxrx4"]);
    const b = block(
      {
        classID: "div-c1",
        isStyling: true,
        isComponentChild: "0a275b695a",
        containerSizeWidth: { cslgbmuh8n: "50%" },
      },
      '<div class="div-c1{cs-index}"></div>',
    );
    expect(styleBlock(b, ctx).style["&.cs-bmuh8n"]).toEqual({ width: "50%" });
  });

  test("on a site with the old section layout, the wrapper's rule comes with the block, from the attributes", () => {
    const ctx = fresh(ap);
    const b = block(
      {
        classID: "s-c1",
        isStyling: true,
        paddingTop: { lg: "4rem" },
        backgroundColor: { lg: "#fff" },
      },
      '<section class="s-c1 {gcl} cc-sct"><div class="s-c1-wrapper cc-wrapper"></div></section>',
      "cwicly/section",
    );
    const styling = styleBlock(b, ctx);
    expect(styling.style).toEqual({ backgroundColor: "#fff" });
    expect(styling.inner).toHaveLength(1);
    expect(styling.inner[0]).toMatchObject({
      tag: "div",
      className: "s-c1-wrapper cc-wrapper",
      style: { paddingTop: "4rem" },
    });
  });

  test("an inner element's own class leads its list, wherever the markup printed it", () => {
    const ctx = withCss(fl, ".s-c1-wrapper{padding-top:1px}");
    const b = block(
      { classID: "s-c1" },
      '<section class="s-c1"><div class="cc-wrapper s-c1-wrapper extra"></div></section>',
      "cwicly/section",
    );
    expect(styleBlock(b, ctx).inner[0]).toMatchObject({
      className: "s-c1-wrapper cc-wrapper extra",
      style: { paddingTop: "1px" },
    });
  });

  test("the old section layout from the stylesheet: ap's section-hero keeps its wrapper's rule on the inner element", async () => {
    const { styling } = await styleReal(
      "ap",
      { kind: "template", slug: "single-episode" },
      "section-c9dae5d",
    );
    expect(styling.className).toBe("section-c9dae5d section-default cc-sct");
    expect(styling.inner[0]).toMatchObject({
      className: "section-c9dae5d-wrapper cc-wrapper",
      style: { paddingTop: "4rem", paddingBottom: "4rem" },
    });
  });
});

// ── attributes, inline style, what is dropped ───────────────────────────────────────────────────

describe("attributes and what has no static equivalent", () => {
  test("htmlAttributes are the attributes the author added (the saved tag has them, tokens included)", async () => {
    const { styling } = await styleReal(
      "ap",
      { kind: "part", slug: "header" },
      "searchform-header",
    );
    expect(styling.attributes).toEqual({ role: "search", method: "get", action: "/" });
    expect(styling.tag).toBe("form");
    expect(styling.id).toBe("searchform");
  });

  test("a hidden attribute is not carried, one the tag lacks falls back to its static value, class/style/id are never attributes", () => {
    const b = block(
      {
        classID: "div-c1",
        htmlAttributes: [
          { attributeType: "static", name: "data-a", value: "1" },
          { attributeType: "static", name: "data-b", value: "2", hide: true },
          { attributeType: "static", name: "data-c", value: "3" },
          { attributeType: "static", name: "class", value: "x" },
          { attributeType: "static", name: "id", value: "y" },
          { attributeType: "static", name: "", value: "z" },
        ],
      },
      '<div class="div-c1" data-a="1"></div>',
    );
    expect(styleBlock(b, fresh(fl)).attributes).toEqual({ "data-a": "1", "data-c": "3" });
  });

  test("a tooltip's text survives as the native title, its options are reported as dropped", async () => {
    const ctx = await makeCtx("ap", { kind: "part", slug: "comments" });
    const b = findBlock("ap", { kind: "part", slug: "comments" }, "div-user-picture");
    const styling = styleBlock(b, ctx, { resolveTokens: (t) => t.replace("{username}", "Ann") });
    expect(styling.attributes).toEqual({ title: "Ann" });
    // the real tooltip has no options: only its text is printed
    expect(ctx.report.entries().filter((e) => e.code === "style.dropped")).toEqual([]);
    const withOptions = block(
      { classID: "d-c1", tooltipActive: true },
      '<div class="d-c1" data-tooltip="Hi" data-tooltiparrow="true" data-tooltipanimation="fade"></div>',
    );
    const loud = fresh(fl);
    expect(styleBlock(withOptions, loud).attributes).toEqual({ title: "Hi" });
    expect(loud.report.entries()).toMatchObject([
      { code: "style.dropped", data: { feature: "tooltip" } },
    ]);
  });

  test("animate-on-scroll, interactions, tilt and scroll direction have no static equivalent: reported with the block's location", async () => {
    const subject: Subject = { kind: "post", id: 13675 };
    const ctx = await makeCtx("ap", subject);
    walkBlocks(subjectBlocks(sites.get("ap")!, subject), (b) => {
      if (b.name?.startsWith("cwicly/")) styleBlock(b, ctx);
    });
    const dropped = ctx.report.entries().filter((e) => e.code === "style.dropped");
    expect(
      dropped.map(
        (e) =>
          `${(e.data as { feature: string }).feature}:${(e.data as { classID: string }).classID}`,
      ),
    ).toEqual([
      "animateOnScroll:image-ce50afb",
      "interactions:image-ce50afb",
      "animateOnScroll:image-c7c9c5d",
      "animateOnScroll:image-cd10fd4",
      "animateOnScroll:image-cd0f825",
      "animateOnScroll:image-cdbc4d3",
    ]);
    expect(dropped[0]).toMatchObject({ severity: "info", where: "post:13675" });
    const loud = fresh(fl);
    styleBlock(
      block(
        {
          classID: "d-c1",
          effectsTiltControl: true,
          scrollDirectionActive: true,
          interactions: { click: [{ action: "x" }] },
        },
        '<div class="d-c1" data-aos="fade-up" data-aos-once="true"></div>',
      ),
      loud,
    );
    expect(loud.report.entries().map((e) => (e.data as { feature: string }).feature)).toEqual([
      "animateOnScroll",
      "interactions",
      "tilt",
      "scrollDirection",
    ]);
  });

  test("an empty interactions object drops nothing", () => {
    const loud = fresh(fl);
    styleBlock(
      block(
        { classID: "d-c1", interactions: { click: [], dbclick: [] } },
        '<div class="d-c1"></div>',
      ),
      loud,
    );
    expect(loud.report.entries()).toEqual([]);
  });

  test("the style comes out in the order Jx writes it: declarations, then nested selectors, then media", () => {
    const ctx = withCss(
      fl,
      ".c1{color:red}@media screen and (max-width: 992px){.c1{color:blue}} .c1:hover{color:pink}",
    );
    const b = block({ classID: "c1", isStyling: true }, '<div class="c1" style="margin:0"></div>');
    expect(Object.keys(styleBlock(b, ctx).style)).toEqual(["color", "margin", ":hover", "@--md"]);
  });

  test("the saved inline style wins over the stylesheet's declaration, and a token nothing resolved is dropped with a report", () => {
    const ctx = withCss(fl, ".div-c1{position:relative;color:red}");
    const b = block(
      { classID: "div-c1", isStyling: true },
      '<div class="div-c1" style="color:blue;--background-image:url({bgfeaturedimage});"></div>',
    );
    const styling = styleBlock(b, ctx);
    expect(styling.style).toEqual({ position: "relative", color: "blue" });
    expect(styling.element?.inlineStyle).toEqual({ color: "blue" });
    expect(ctx.report.entries()).toMatchObject([
      { severity: "warn", code: "style.token-unresolved" },
    ]);
  });

  test("with the dynamic-data module's resolver the token is a value, escaped for Jx", () => {
    const ctx = withCss(fl, ".div-c1{position:relative}");
    const b = block(
      { classID: "div-c1", isStyling: true },
      '<div class="div-c1" style="--background-image:url({bgfeaturedimage});"></div>',
    );
    const seen: string[] = [];
    const styling = styleBlock(b, ctx, {
      resolveTokens: (text) => {
        seen.push(text);
        return text.replace("{bgfeaturedimage}", "/media/a.jpg");
      },
    });
    expect(styling.style["--background-image"]).toBe("url(/media/a.jpg)");
    expect(seen).toEqual(["--background-image:url({bgfeaturedimage});"]);
  });

  test("each attribute value and each inline style goes to the resolver once, as saved: literal ${ is the resolver's to handle", () => {
    const b = block(
      { classID: "d-c1" },
      '<div class="d-c1" title="cost ${5}" data-x="{tok}" style="content:\'${x}\'"></div>',
    );
    const seen: string[] = [];
    const styling = styleBlock(b, fresh(fl), {
      resolveTokens: (text) => {
        seen.push(text);
        return text;
      },
    });
    expect(seen).toEqual(["cost ${5}", "{tok}", "content:'${x}'"]);
    expect(styling.element?.attributes).toEqual({ title: "cost ${5}", "data-x": "{tok}" });
  });

  test("the id the tag prints is returned apart: Jx would write the block's rules to #id", async () => {
    const { styling } = await styleReal(
      "ap",
      { kind: "template", slug: "single-episode" },
      "query-guest-names",
    );
    expect(styling.id).toBe("query-guest-names");
    expect(styling.attributes).not.toHaveProperty("id");
    expect(styling.element?.attributes).not.toHaveProperty("id");
  });
});

// ── Bound inline styles ─────────────────────────────────────────────────────────────────────────

describe("an inline style that holds a ${…} binding (entry templates, loops)", () => {
  /** The real block, with the real dynamic-data resolver, in the mode the converter has for entry templates. */
  async function entryStyle(
    site: SiteName,
    subject: Subject,
    classID: string,
    entryType: string,
  ): Promise<{ styling: BlockStyling; ctx: ConvertCtx }> {
    const ctx = await makeCtx(site, subject, { mode: "entry", entryType });
    const found = findBlock(site, subject, classID);
    const styling = styleBlock(found, ctx, {
      resolveTokens: (text) => resolveTokens(text, ctx, found, { where: "attribute" }),
    });
    return { styling, ctx };
  }

  const problems = (ctx: ConvertCtx): string[] =>
    ctx.report
      .entries()
      .filter((e) => e.code === "style.token-unresolved" || e.code === "style.dropped")
      .map((e) => e.code);

  test("ap single-episode: the hero image is a binding, kept whole for the element's style attribute (not in the class rule, not 'unresolved')", async () => {
    const { styling, ctx } = await entryStyle(
      "ap",
      { kind: "template", slug: "single-episode" },
      "div-c4eb023",
      "episode",
    );
    expect(styling.boundStyle).toBe(
      "--background-image:url(${state.entry.data.featuredImage?.src ?? ''})",
    );
    expect(styling.element?.boundStyle).toBe(styling.boundStyle);
    expect(styling.style).not.toHaveProperty("--background-image");
    expect(styling.style.backgroundImage).toBe("var(--background-image)");
    expect(styling.element?.inlineStyle).toBeUndefined();
    expect(problems(ctx)).toEqual([]);
  });

  test("ap single-post: a binding with parentheses and || in it survives (it used to vanish without a report)", async () => {
    const { styling, ctx } = await entryStyle(
      "ap",
      { kind: "template", slug: "single-post" },
      "div-c4eb023",
      "post",
    );
    expect(styling.boundStyle).toMatch(
      /^--background-image:url\(\$\{\(state\.entry\.data\.featuredImage\?\.src \?\? ''\) \|\| '[^']+maxresdefault\.jpg'\}\)$/,
    );
    expect(problems(ctx)).toEqual([]);
  });

  test("ap author: the headshot background is a binding on the author's picture", async () => {
    const { styling, ctx } = await entryStyle(
      "ap",
      { kind: "template", slug: "author" },
      "div-c4eb023",
      "post",
    );
    expect(styling.boundStyle).toContain("${(state.entry.data.picture?.src ?? '')");
    expect(problems(ctx)).toEqual([]);
  });

  test("fineline single-service: the section's background image", async () => {
    const { styling, ctx } = await entryStyle(
      "fineline",
      { kind: "template", slug: "single-service" },
      "section-cad9020",
      "service",
    );
    expect(styling.boundStyle).toBe(
      "--background-image:url(${state.entry.data.featuredImage?.src ?? ''})",
    );
    expect(problems(ctx)).toEqual([]);
  });

  test("static declarations stay in the class rule and the inline style, bound ones are apart, and the order of the rest holds", () => {
    const b = block(
      { classID: "d-c1", isStyling: true },
      `<div class="d-c1" style="color:red;--x:\${a ? 'b' : 'c'};margin:0;--y:\${(s) || 'q'}"></div>`,
    );
    const ctx = withCss(fl, ".d-c1{position:relative}");
    const styling = styleBlock(b, ctx);
    expect(Object.entries(styling.style)).toEqual([
      ["position", "relative"],
      ["color", "red"],
      ["margin", "0"],
    ]);
    expect(styling.element?.inlineStyle).toEqual({ color: "red", margin: "0" });
    expect(styling.boundStyle).toBe("--x:${a ? 'b' : 'c'};--y:${(s) || 'q'}");
    expect(ctx.report.entries()).toEqual([]);
  });

  test("camelCase properties go back to their CSS names in the bound text, !important kept", () => {
    const b = block(
      { classID: "d-c1" },
      '<div class="d-c1" style="background-image:url(${u}) !important"></div>',
    );
    expect(styleBlock(b, fresh(fl)).boundStyle).toBe("background-image:url(${u}) !important");
  });

  test("a token next to a binding is still unresolved: the declaration is dropped with a report", () => {
    const ctx = fresh(fl);
    const b = block(
      { classID: "d-c1" },
      '<div class="d-c1" style="--a:url(${x}{bgfeaturedimage});--b:${y}"></div>',
    );
    const styling = styleBlock(b, ctx);
    expect(styling.boundStyle).toBe("--b:${y}");
    expect(ctx.report.entries().map((e) => e.code)).toEqual(["style.token-unresolved"]);
  });

  test("a declaration that cannot be read is reported, not lost silently", () => {
    const ctx = fresh(fl);
    const b = block(
      { classID: "d-c1" },
      '<div class="d-c1" style="color:red;:nothing;width:10px"></div>',
    );
    const styling = styleBlock(b, ctx);
    expect(styling.element?.inlineStyle).toEqual({ color: "red", width: "10px" });
    expect(ctx.report.entries()).toMatchObject([
      { severity: "warn", code: "style.dropped", data: { feature: "inline-style" } },
    ]);
  });

  test("a ${ that never closes is text, and an escaped literal is not a binding", () => {
    const b = block(
      { classID: "d-c1" },
      '<div class="d-c1" style="content:\'&#36;{x\';color:red"></div>',
    );
    const styling = styleBlock(b, fresh(fl));
    expect(styling.boundStyle).toBeUndefined();
    expect(styling.element?.inlineStyle).toMatchObject({ color: "red" });
  });
});

// ── Ancestors, siblings, the shell of a modal ───────────────────────────────────────────────────

describe("what is above, around and inside the styled element", () => {
  const MODAL =
    '<div class="cc-mdl modal-{class} cc-modal-fade-in"><a class="cc-mdl-close"></a><div class="cc-mdl-container"><div class="{class} cc-modaler"><span class="x"></span></div></div></div>';

  test("a preceding sibling of the container is not an ancestor: wrappers are the shell and the container, the close anchor is beside", () => {
    const b = block(
      { classID: "modal-c1" },
      MODAL.replaceAll("{class}", "modal-c1"),
      "cwicly/modal",
    );
    const styling = styleBlock(b, fresh(fl));
    expect(styling.styledDepth).toBe(2);
    expect(styling.wrappers.map((w) => w.tag + "." + w.className)).toEqual([
      "div.cc-mdl modal-modal-c1 cc-modal-fade-in",
      "div.cc-mdl-container",
    ]);
    expect(styling.beside.map((e) => [e.tag, e.className, e.depth, e.after])).toEqual([
      ["a", "cc-mdl-close", 1, false],
    ]);
    expect(styling.inner.map((e) => e.tag)).toEqual(["span"]);
    expect(classListOf(b, fresh(fl)).styledDepth).toBe(2);
    expect(classListOf(b, fresh(fl)).wrappers).toEqual([
      ["cc-mdl", "modal-modal-c1", "cc-modal-fade-in"],
      ["cc-mdl-container"],
    ]);
  });

  test("siblings after the styled element are beside too, and inner is only what is inside it", () => {
    const b = block(
      { classID: "c1" },
      '<div class="w"><p class="c1"><i></i></p><b></b></div><u></u>',
    );
    const styling = styleBlock(b, fresh(fl));
    expect(styling.wrappers.map((w) => w.tag)).toEqual(["div"]);
    expect(styling.inner.map((e) => e.tag)).toEqual(["i"]);
    expect(styling.beside.map((e) => [e.tag, e.depth, e.after])).toEqual([
      ["b", 1, true],
      ["u", 0, true],
    ]);
  });

  test("every real block with a classID below the root: its wrappers are its true ancestors (parse5's tree)", async () => {
    let deep = 0;
    for (const name of SITES) {
      const site = sites.get(name)!;
      for (const subject of allSubjects(site)) {
        const ctx = await ctxOf(name, subject);
        walkBlocks(subjectBlocks(site, subject), (b) => {
          if (!b.name?.startsWith("cwicly/")) return;
          const styling = styleBlock(b, fresh(ctx));
          if (styling.styledDepth <= 0) return;
          deep++;
          expect(styling.wrappers).toHaveLength(styling.styledDepth);
          const tags = savedTags(b.innerHTML);
          const styled = tags.findIndex((t) =>
            (t.attrs.find(([n]) => n === "class")?.[1] ?? "").includes(b.attrs.classID as string),
          );
          // ancestors: following parents from the styled element reaches the root in exactly that many steps
          let steps = 0;
          for (let up = tags[styled]!.parent; up !== -1; up = tags[up]!.parent) steps++;
          expect(steps).toBe(styling.styledDepth);
        });
      }
    }
    expect(deep).toBe(10);
  });

  test("ap's footer modal: the shell carries modal-<classID>'s rule with its own class first, so Jx scopes it there", async () => {
    const { styling } = await styleReal("ap", { kind: "part", slug: "footer" }, "modal-sign-in");
    expect(styling.styledDepth).toBe(2);
    const shell = styling.wrappers[0]!;
    expect(shell.className).toBe("modal-modal-sign-in cc-mdl cc-modal-fade-in");
    expect(shell.style).toEqual({
      "& .cc-mdl-container": { justifyContent: "center", alignItems: "center" },
    });
    expect(styling.wrappers[1]).toMatchObject({ className: "cc-mdl-container" });
    expect(styling.wrappers[1]).not.toHaveProperty("style");
    expect(styling.beside.map((e) => e.className)).toEqual(["cc-mdl-close"]);
  });

  test("a shell with no rule of its own is left as saved (the mobile menu's modal)", async () => {
    const { styling } = await styleReal(
      "ap",
      { kind: "part", slug: "mobile-menu" },
      "modal-overlay-menu",
    );
    expect(styling.wrappers[0]).toMatchObject({
      className: "cc-mdl modal-modal-overlay-menu cc-modal-fade-in",
    });
    expect(styling.wrappers[0]).not.toHaveProperty("style");
  });

  test("the shell's style is a copy: editing it does not touch the index", async () => {
    const { styling, ctx } = await styleReal(
      "ap",
      { kind: "part", slug: "footer" },
      "modal-sign-in",
    );
    (styling.wrappers[0]!.style!["& .cc-mdl-container"] as JxStyle).justifyContent = "x";
    expect(ctx.css.classes.get("modal-modal-sign-in")!.style["& .cc-mdl-container"]).toMatchObject({
      justifyContent: "center",
    });
  });
});

// ── Relative styles that name another block ─────────────────────────────────────────────────────

describe("relative styles in the attribute fallback", () => {
  const HEADING_RED = "1c1d4c60-d810-4417-a420-84d30ba33f83";

  test("a published page's block (div-c4868da of post 5260, no stylesheet) styles heading-red: the id is in another post of the site", async () => {
    const { styling, codes } = await styleReal(
      "fineline",
      { kind: "post", id: 5260 },
      "div-c4868da",
    );
    expect(styling.source).toBe("attributes");
    expect(Object.keys(styling.style).filter((k) => k.includes("heading-red"))).toEqual([
      "& .heading-red",
      "&:hover .heading-red",
    ]);
    expect(codes).not.toContain("style.selector-unsupported");
  });

  test("the same rules as the stylesheet gives the same block on the page that has one (div-c59edf1: post 4775 against 5246)", async () => {
    const { styling } = await styleReal("fineline", { kind: "post", id: 4775 }, "div-c59edf1");
    const real = fl.css.classes.get("div-c59edf1")!.style;
    expect(styling.style["& .heading-red"]).toEqual(real["& .heading-red"] as JxStyle);
    expect(styling.style["&:hover .heading-red"]).toEqual(real["&:hover .heading-red"] as JxStyle);
  });

  test("the block's own descendants are searched first, and the converter's map before them", () => {
    const attrs = {
      classID: "d-c1",
      isStyling: true,
      fontSize: { rslgR1: "2rem" },
      relativeStyles: [
        { id: "R1", rules: [{ selectorType: "class", selector: HEADING_RED, combinator: " " }] },
      ],
    };
    const child: WpBlock = block(
      { uniqueID: HEADING_RED, classID: "kid" },
      '<h2 class="kid"></h2>',
    );
    const parent: WpBlock = { ...block(attrs, '<div class="d-c1"></div>'), innerBlocks: [child] };
    expect(Object.keys(styleBlock(parent, fresh(fl)).style)).toContain("& .kid");
    expect(
      Object.keys(
        styleBlock(parent, fresh(fl), { blockClasses: new Map([[HEADING_RED, "mapped"]]) }).style,
      ),
    ).toContain("& .mapped");
  });

  test("an id no post has is reported and its rules left out (never an invalid class), the block's own style stays", () => {
    const attrs = {
      classID: "d-c1",
      isStyling: true,
      marginTop: { lg: "4px" },
      fontSize: { rslgR1: "2rem" },
      relativeStyles: [
        {
          id: "R1",
          rules: [
            {
              selectorType: "class",
              selector: "00000000-0000-4000-8000-00000000dead",
              combinator: " ",
            },
          ],
        },
      ],
    };
    const ctx = fresh(fl);
    const styling = styleBlock(block(attrs, '<div class="d-c1"></div>'), ctx);
    expect(styling.style).toMatchObject({ marginTop: "4px" });
    expect(Object.keys(styling.style).filter((k) => k.startsWith("&"))).toEqual([]);
    expect(ctx.report.entries().map((e) => e.code)).toEqual([
      "style.fallback",
      "style.selector-unsupported",
    ]);
  });

  test("a comment that is not JSON, or an id found in no block comment, is not a block", () => {
    const attrs = {
      classID: "d-c1",
      isStyling: true,
      fontSize: { rslgR1: "2rem" },
      relativeStyles: [
        {
          id: "R1",
          rules: [
            {
              selectorType: "class",
              selector: "00000000-0000-4000-8000-0000000000aa",
              combinator: " ",
            },
          ],
        },
      ],
    };
    const post = [...fl.model.posts.values()][0]!;
    const ctx: ConvertCtx = {
      ...fresh(fl),
      model: {
        ...fl.model,
        posts: new Map([
          [
            1,
            {
              ...post,
              content:
                '<!-- wp:cwicly/div {"uniqueID":"00000000-0000-4000-8000-0000000000aa", nope} -->x<!-- wp:cwicly/div {"uniqueID":"00000000-0000-4000-8000-0000000000aa"} -->',
            },
          ],
        ]),
      },
    };
    styleBlock(block(attrs, '<div class="d-c1"></div>'), ctx);
    expect(ctx.report.entries().map((e) => e.code)).toContain("style.selector-unsupported");
  });
});

// ── classIDs that are not plain identifiers ─────────────────────────────────────────────────────

describe("a classID that starts with a digit", () => {
  test("its fallback style is kept and the loss at Jx's unescaped scope selector is reported, not silent", () => {
    const ctx = fresh(fl);
    const styling = styleBlock(
      block(
        {
          classID: "3col",
          isStyling: true,
          marginTop: { lg: "10px" },
          backgroundColor: { lg: "red" },
        },
        '<div class="3col"></div>',
      ),
      ctx,
    );
    expect(styling.source).toBe("attributes");
    expect(styling.style).toMatchObject({ marginTop: "10px", backgroundColor: "red" });
    expect(ctx.report.entries().map((e) => e.code)).toEqual(["style.fallback", "style.no-scope"]);
    for (const id of ["-1a", "-", "a.b", "a:b"]) {
      const loud = fresh(fl);
      styleBlock(
        block(
          { classID: id, isStyling: true, marginTop: { lg: "1px" } },
          `<div class="${id}"></div>`,
        ),
        loud,
      );
      expect(
        loud.report.entries().map((e) => e.code),
        id,
      ).toContain("style.no-scope");
    }
    const quiet = fresh(fl);
    styleBlock(
      block(
        { classID: "_a-1", isStyling: true, marginTop: { lg: "1px" } },
        '<div class="_a-1"></div>',
      ),
      quiet,
    );
    expect(quiet.report.entries().map((e) => e.code)).not.toContain("style.no-scope");
  });
});

// ── Selectors with an ancestor, and the index's objects ────────────────────────────────────────

describe("rules that name the classID after an ancestor", () => {
  const key = (css: string): string[] => {
    const ctx = withCss(fl, css);
    return Object.keys(styleBlock(block({ classID: "c1" }, '<div class="c1"></div>'), ctx).style);
  };

  test("each combinator is kept: a child, a next sibling and a later sibling are not a descendant", () => {
    // (a rule rooted at one class, `.p .c1`, is the reader's own nested key on `.p`; these are the
    // ones whose first compound has two classes, which only a key on the element itself can say)
    expect(key(".p.q > .c1{color:red}")).toEqual(["&:is(.p.q > *)"]);
    expect(key(".p.q + .c1{color:red}")).toEqual(["&:is(.p.q + *)"]);
    expect(key(".p.q ~ .c1{color:red}")).toEqual(["&:is(.p.q ~ *)"]);
    expect(key(".p.q > .r .c1 svg{color:red}")).toEqual(["&:is(.p.q > .r *) svg"]);
    expect(key(".p.q .c1{color:red}")).toEqual(["&:is(.p.q *)"]);
  });

  test("the nested styles are the block's own copies: changing one touches neither the index nor another block", () => {
    const ctx = withCss(fl, ".a.b .c1{color:red} .c1.cs-v{margin:0}");
    const first = styleBlock(block({ classID: "c1" }, '<div class="c1"></div>'), ctx);
    (first.style["&:is(.a.b *)"] as JxStyle).color = "blue";
    (first.style["&.cs-v"] as JxStyle).margin = "9px";
    expect(ctx.css.other.get(".a.b .c1")).toEqual({ color: "red" });
    expect(ctx.css.other.get(".c1.cs-v")).toEqual({ margin: "0" });
    const second = styleBlock(block({ classID: "c1" }, '<div class="c1"></div>'), ctx);
    expect(second.style["&:is(.a.b *)"]).toEqual({ color: "red" });
    expect(second.style["&.cs-v"]).toEqual({ margin: "0" });
  });
});

// ── customCSS that only Sass reads ──────────────────────────────────────────────────────────────

describe("custom CSS the live site reads as plain CSS", () => {
  const withCustom = (customCSS: string): { styling: BlockStyling; codes: string[] } => {
    const ctx = withCss(fl, "");
    const styling = styleBlock(
      block({ classID: "d-c1", customCSS }, '<div class="d-c1"></div>'),
      ctx,
    );
    return { styling, codes: ctx.report.entries().map((e) => e.code) };
  };

  test('a $ in a string is text: content:"$5" is kept and nothing is compiled or reported', () => {
    const { styling, codes } = withCustom('.blockclass::before{content:"$5";display:block}');
    expect(styling.style).toEqual({ "::before": { content: '"$5"', display: "block" } });
    expect(codes).toEqual([]);
  });

  test("a // comment is compiled (the rule after it is not swallowed), with the report that says so", () => {
    const { styling, codes } = withCustom("// make it red\n.blockclass{color:red}");
    expect(styling.style).toEqual({ color: "red" });
    expect(codes).toEqual(["style.scss-compiled"]);
    expect(withCustom(".blockclass{\n  // inner\n  color:red;\n}").styling.style).toEqual({
      color: "red",
    });
  });

  test("a plain @import url() is not SCSS, and the rules after it are read", () => {
    const { styling, codes } = withCustom(
      "@import url(https://fonts.test/a.css);.blockclass{color:red}",
    );
    expect(styling.style).toEqual({ color: "red" });
    expect(codes).not.toContain("style.scss-compiled");
  });
});

// ── The whole corpus ─────────────────────────────────────────────────────────────────────────────

describe("every Cwicly block of both sites", () => {
  interface Sweep {
    blocks: number;
    sources: Record<string, number>;
    codes: Record<string, number>;
    deep: number;
    problems: string[];
  }

  const sweeps = new Map<SiteName, Sweep>();

  beforeAll(async () => {
    for (const name of SITES) {
      const site = sites.get(name)!;
      const sweep: Sweep = { blocks: 0, sources: {}, codes: {}, deep: 0, problems: [] };
      for (const subject of allSubjects(site)) {
        const ctx = fresh(await ctxOf(name, subject));
        walkBlocks(subjectBlocks(site, subject), (b) => {
          if (!b.name?.startsWith("cwicly/")) return;
          sweep.blocks++;
          const styling = styleBlock(b, ctx);
          const bucket = b.name === "cwicly/component" ? "component" : styling.source;
          sweep.sources[bucket] = (sweep.sources[bucket] ?? 0) + 1;
          if (styling.styledDepth > 0) sweep.deep++;
          const where = `${subjectKey(name, subject)} ${String(b.attrs.classID)}`;
          const json = JSON.stringify(styling);
          if (/[{}]/.test(styling.className.replaceAll("${", "")))
            sweep.problems.push(`${where}: token in className`);
          if (styling.className.includes("undefined"))
            sweep.problems.push(`${where}: undefined in className`);
          if (json.includes("!var=")) sweep.problems.push(`${where}: unresolved palette reference`);
          if (/undefined|\[object Object\]/.test(JSON.stringify(styling.style))) {
            sweep.problems.push(`${where}: undefined in style`);
          }
          const classID = styling.classID;
          if (classID && !isEmpty(styling.style) && styling.className.split(" ")[0] !== classID) {
            sweep.problems.push(`${where}: classID is not first`);
          }
          for (const key of Object.keys(styling.attributes)) {
            if (["class", "style", "id"].includes(key))
              sweep.problems.push(`${where}: attribute ${key}`);
          }
          for (const key of nestedKeys(styling.style)) {
            if (
              !/^(?:&|:|\.|\[|@)/.test(key) &&
              !/^[a-zA-Z-]+$/.test(key) &&
              !key.startsWith("--")
            ) {
              sweep.problems.push(`${where}: nested key ${key}`);
            }
            if (/^[a-z>~+*]/.test(key) && key.includes(" ") && !key.startsWith("@")) {
              sweep.problems.push(`${where}: descendant-leading key ${key}`);
            }
          }
        });
        for (const e of ctx.report.entries()) sweep.codes[e.code] = (sweep.codes[e.code] ?? 0) + 1;
        for (const e of ctx.report.entries()) {
          if (e.where !== whereOf(ctx))
            sweep.problems.push(`entry ${e.code} located at ${String(e.where)}`);
        }
      }
      sweeps.set(name, sweep);
    }
  });

  function isEmpty(style: JxStyle): boolean {
    return Object.keys(style).length === 0;
  }

  function* nestedKeys(style: JxStyle, depth = 0): Generator<string> {
    for (const [key, value] of Object.entries(style)) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        yield key;
        yield* nestedKeys(value as JxStyle, depth + 1);
      }
    }
  }

  test("fineline: every block is styled without throwing; 4,152 from the index, 506 from attributes, 16 with none, 290 component instances", () => {
    const s = sweeps.get("fineline")!;
    expect(s.blocks).toBe(4964);
    expect(s.sources).toEqual({ index: 4152, attributes: 506, none: 16, component: 290 });
    expect(s.problems).toEqual([]);
  });

  test("ap: 538 from the index, 65 from attributes, 351 with none, 12 component instances", () => {
    const s = sweeps.get("ap")!;
    expect(s.blocks).toBe(966);
    expect(s.sources).toEqual({ index: 538, attributes: 65, none: 351, component: 12 });
    expect(s.problems).toEqual([]);
  });

  test("the index bucket is a block whose subject's stylesheets have a rule for it, or a compound rule that names it, or custom CSS", async () => {
    let checked = 0;
    for (const name of SITES) {
      const site = sites.get(name)!;
      for (const subject of allSubjects(site)) {
        const ctx = fresh(await ctxOf(name, subject));
        walkBlocks(subjectBlocks(site, subject), (b) => {
          if (!b.name?.startsWith("cwicly/") || b.name === "cwicly/component") return;
          const styling = styleBlock(b, ctx);
          if (styling.source !== "index") return;
          checked++;
          const id = String(b.attrs.classID);
          const own = ctx.css.classes.get(id);
          const named = [...ctx.css.other.keys()].some((s) => s.includes(`.${id}`));
          const custom = typeof b.attrs.customCSS === "string" && b.attrs.customCSS.trim() !== "";
          expect(Boolean(own && Object.keys(own.style).length > 0) || named || custom).toBe(true);
        });
      }
    }
    expect(checked).toBe(4152 + 538);
  });

  test("the attributes bucket: styled blocks no stylesheet rule covers, whether the subject's stylesheet is missing or older than the block", async () => {
    const expected = {
      fineline: { absent: 390, older: 116, subjectsWithoutFile: 10 },
      ap: { absent: 46, older: 19, subjectsWithoutFile: 13 },
    };
    for (const name of SITES) {
      const site = sites.get(name)!;
      let absent = 0;
      let older = 0;
      const without = new Set<string>();
      for (const subject of allSubjects(site)) {
        const ctx = fresh(await ctxOf(name, subject));
        const file = subjectCss(site, subject);
        const hasFile = existsSync(join(import.meta.dir, "../fixtures", name, "css", file));
        walkBlocks(subjectBlocks(site, subject), (b) => {
          if (!b.name?.startsWith("cwicly/") || b.name === "cwicly/component") return;
          const styling = styleBlock(b, ctx);
          if (styling.source !== "attributes") return;
          // never a rule in the index, always a styled block, always something to write
          expect(b.attrs.isStyling).toBe(true);
          expect(ctx.css.classes.get(String(b.attrs.classID))?.style ?? {}).toEqual({});
          expect(Object.keys(styling.style).length + styling.inner.length).toBeGreaterThan(0);
          if (hasFile) older++;
          else {
            absent++;
            without.add(JSON.stringify(subject));
          }
        });
      }
      expect({ absent, older, subjectsWithoutFile: without.size }).toEqual(expected[name]);
    }
    // the stylesheet files the live pages never load, so the fixtures never fetched them
    expect(
      cssNamesFor(sites.get("fineline")!, {
        kind: "template",
        slug: "taxonomy-project_tag",
      }).filter((n) => n.startsWith("cc-tp-cwicly_taxonomy")),
    ).toEqual(["cc-tp-cwicly_taxonomy-project_tag.css"]);
    expect(
      existsSync(
        join(import.meta.dir, "../fixtures/fineline/css/cc-tp-cwicly_taxonomy-project_tag.css"),
      ),
    ).toBe(false);
  });

  test("the none bucket: not styled, or styled with every attribute empty", async () => {
    for (const name of SITES) {
      const site = sites.get(name)!;
      for (const subject of allSubjects(site)) {
        const ctx = fresh(await ctxOf(name, subject));
        walkBlocks(subjectBlocks(site, subject), (b) => {
          if (!b.name?.startsWith("cwicly/") || b.name === "cwicly/component") return;
          const styling = styleBlock(b, ctx);
          if (styling.source !== "none") return;
          const id = typeof b.attrs.classID === "string" ? b.attrs.classID : "";
          const rule = id ? ctx.css.classes.get(id) : undefined;
          expect(rule === undefined || Object.keys(rule.style).length === 0).toBe(true);
          if (b.attrs.isStyling && id) {
            expect(
              Object.keys(attrStyleDetailed(b.attrs, ctx, { blockName: b.name, classID: id }).style)
                .length,
            ).toBe(0);
          }
        });
      }
    }
  });

  test("what the sweep reports, by code, is what was explained above and nothing else", () => {
    expect(sweeps.get("fineline")!.codes).toEqual({
      "class.current-page": 255,
      "style.fallback": 506,
      "style.hoisted": 2,
      "style.attr-unsupported": 3,
      "style.classid-not-printed": 1,
      "style.no-classid": 3,
      "style.token-unresolved": 1,
    });
    expect(sweeps.get("ap")!.codes).toEqual({
      "class.current-page": 53,
      "style.fallback": 65,
      "style.dropped": 14,
      "style.token-unresolved": 6,
    });
  });

  test("the classID sits below the root in 6 + 4 blocks: images inside a link wrapper, and the shells of a modal", () => {
    expect(sweeps.get("fineline")!.deep).toBe(6);
    expect(sweeps.get("ap")!.deep).toBe(4);
  });
});

// ── Through Jx ───────────────────────────────────────────────────────────────────────────────────

describe("a styled element built through Jx keeps its rules on .classID", () => {
  test("a block with a global class: its rules are written to its own class, the global class's rule is untouched", async () => {
    const site = sites.get("fineline")!;
    const subject: Subject = { kind: "post", id: 5246 };
    const ctx = fresh(await ctxOf("fineline", subject));
    let chosen: { b: WpBlock; styling: BlockStyling } | undefined;
    walkBlocks(subjectBlocks(site, subject), (b) => {
      if (chosen || !b.name?.startsWith("cwicly/")) return;
      if (!Array.isArray(b.attrs.globalClass) || b.attrs.globalClass.length === 0) return;
      const styling = styleBlock(b, ctx);
      if (
        styling.source === "index" &&
        /^[a-z]+-c[0-9a-f]+$/.test(styling.classID ?? "") &&
        styling.className.split(" ").length > 1
      ) {
        const decls = Object.entries(styling.style).filter(([, v]) => typeof v === "string");
        if (decls.length >= 3) chosen = { b, styling };
      }
    });
    expect(chosen).toBeDefined();
    const { styling } = chosen!;
    const classID = styling.classID!;
    const globalName = styling.className.split(" ")[1]!;
    expect(styling.className.split(" ")[0]).toBe(classID);
    const built = await buildJxProject({
      "project.json": {
        name: "t",
        url: "https://example.com",
        $media: ctx.cwicly.media,
        style: { [`.${globalName}`]: { outline: "1px solid red", "&:hover": { color: "blue" } } },
      },
      "pages/index.json": {
        title: "t",
        children: [
          { tagName: "div", className: styling.className, style: styling.style, textContent: "x" },
          {
            tagName: "div",
            className: globalName,
            textContent: "plain element that shares the global class",
          },
        ],
      },
    });
    const html = built.html("/");
    const css = html.slice(html.indexOf("<style>") + "<style>".length, html.indexOf("</style>"));
    const rules = [...css.matchAll(/(?:^|\n)([^@\n][^{]*)\{([^}]*)\}/g)].map(
      (m) => [m[1]!.trim(), m[2]!.trim()] as const,
    );
    const own = rules.filter(([sel]) => sel === `.${classID}`);
    expect(own.length).toBe(1);
    for (const [property, value] of Object.entries(styling.style)) {
      if (typeof value !== "string") continue;
      const kebab = property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      expect(own[0]![1]).toContain(`${kebab}: ${value}`);
    }
    // the global class's own rules are exactly what the project gave it: nothing of the block leaked onto it
    expect(rules.filter(([sel]) => sel === `.${globalName}`)).toEqual([
      [`.${globalName}`, "outline: 1px solid red"],
    ]);
    expect(css).not.toMatch(
      new RegExp(
        `\\.${globalName}[^{]*\\{[^}]*${Object.keys(styling.style)
          .find((k) => typeof styling.style[k] === "string")!
          .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      ),
    );
    expect(html).toContain(`<div class="${styling.className}">x</div>`);
  });

  test("the same block with its global class first would have leaked: the scoping rule is what classID-first buys", async () => {
    const built = await buildJxProject({
      "pages/index.json": {
        title: "t",
        children: [
          { tagName: "div", className: "shared div-c1", style: { color: "red" }, textContent: "a" },
          { tagName: "div", className: "shared", textContent: "b" },
        ],
      },
    });
    const html = built.html("/");
    expect(html).toContain(".shared { color: red }");
    const good = await buildJxProject({
      "pages/index.json": {
        title: "t",
        children: [
          { tagName: "div", className: "div-c1 shared", style: { color: "red" }, textContent: "a" },
          { tagName: "div", className: "shared", textContent: "b" },
        ],
      },
    });
    expect(good.html("/")).toContain(".div-c1 { color: red }");
    expect(good.html("/")).not.toContain(".shared { color: red }");
  });

  test("a hoisted at-rule and a nested key from real blocks build to valid CSS", async () => {
    const { styling } = await styleReal(
      "ap",
      { kind: "template", slug: "wp-custom-template-about-us" },
      "header-about",
    );
    const built = await buildJxProject({
      "project.json": {
        name: "t",
        url: "https://example.com",
        $media: { "--": "1366px", "--md": "(max-width: 992px)", "--sm": "(max-width: 576px)" },
        style: Object.fromEntries(styling.hoisted.map((h) => [h.selector, h.style])),
      },
      "pages/index.json": {
        title: "t",
        children: [
          { tagName: "div", className: styling.className, style: styling.style, textContent: "x" },
        ],
      },
    });
    const html = built.html("/");
    expect(html).toContain("@keyframes fade-in");
    expect(html).toContain(".header-about > * {");
    expect(html).toContain(".header-about::before {");
  });
});
